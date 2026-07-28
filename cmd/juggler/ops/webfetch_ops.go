//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"juggler/internal/httpx"
)

// WebFetchOperations handles web content fetching
type WebFetchOperations struct {
	scope PathScope
}

// NewWebFetchOperations creates a new web fetch operations handler
func NewWebFetchOperations(scope PathScope) *WebFetchOperations {
	return &WebFetchOperations{
		scope: scope,
	}
}

// cacheEntry holds a cached fetch result
type cacheEntry struct {
	content   string
	fetchedAt time.Time
}

const cacheTTL = 15 * time.Minute

const (
	cacheGet     = iota // retrieve an entry by URL
	cacheSet            // store an entry for a URL
	cacheCleanup        // remove expired entries
)

// cacheOp represents an operation on the fetch cache
type cacheOp struct {
	opType int
	url    string
	entry  cacheEntry
	result chan cacheResult
}

// cacheResult is returned from a get operation
type cacheResult struct {
	entry cacheEntry
	found bool
}

var cacheOps = make(chan cacheOp)

// cacheManager owns the cache map and processes all operations sequentially
func cacheManager() {
	entries := make(map[string]cacheEntry)
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case op := <-cacheOps:
			switch op.opType {
			case cacheGet:
				e, ok := entries[op.url]
				op.result <- cacheResult{entry: e, found: ok}
			case cacheSet:
				entries[op.url] = op.entry
			case cacheCleanup:
				for u, e := range entries {
					if time.Since(e.fetchedAt) > cacheTTL {
						delete(entries, u)
					}
				}
			}
		case <-ticker.C:
			for u, e := range entries {
				if time.Since(e.fetchedAt) > cacheTTL {
					delete(entries, u)
				}
			}
		}
	}
}

const maxContentLength = 100000 // ~100KB max content

// Execute executes a web fetch operation
func (ops *WebFetchOperations) Execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	switch operation {
	case "fetch":
		return ops.fetch(ctx, params)
	default:
		return nil, fmt.Errorf("unknown operation: %s", operation)
	}
}

// fetch retrieves content from a URL and converts HTML to readable text
func (ops *WebFetchOperations) fetch(ctx context.Context, params map[string]any) (any, error) {
	urlStr, ok := params["url"].(string)
	if !ok || urlStr == "" {
		return nil, fmt.Errorf("missing url parameter")
	}

	prompt, _ := params["prompt"].(string)

	// Validate URL
	parsedURL, err := url.Parse(urlStr)
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %w", err)
	}

	// Upgrade HTTP to HTTPS
	if parsedURL.Scheme == "http" {
		parsedURL.Scheme = "https"
		urlStr = parsedURL.String()
	}

	// Only allow http/https schemes
	if parsedURL.Scheme != "https" {
		return nil, fmt.Errorf("only https URLs are supported")
	}

	// Check cache
	result := make(chan cacheResult, 1)
	cacheOps <- cacheOp{opType: cacheGet, url: urlStr, result: result}
	cr := <-result

	if cr.found && time.Since(cr.entry.fetchedAt) < cacheTTL {
		return map[string]any{
			"url":     urlStr,
			"content": cr.entry.content,
			"prompt":  prompt,
			"cached":  true,
		}, nil
	}

	// Fetch the URL
	client := &http.Client{
		Timeout:   30 * time.Second,
		Transport: httpx.Transport(),
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// Allow up to 10 redirects
			if len(via) >= 10 {
				return fmt.Errorf("too many redirects")
			}
			// Check if redirect goes to a different host
			if len(via) > 0 && req.URL.Host != via[0].URL.Host {
				return fmt.Errorf("redirect to different host: %s", req.URL.String())
			}
			return nil
		},
	}

	req, err := http.NewRequestWithContext(ctx, "GET", urlStr, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Set a reasonable User-Agent
	req.Header.Set("User-Agent", "Juggler/1.0 (AI Coding Assistant)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7")

	resp, err := client.Do(req)
	if err != nil {
		// Check if it's a redirect to different host
		if strings.Contains(err.Error(), "redirect to different host") {
			// Extract the redirect URL from the error
			return map[string]any{
				"url":          urlStr,
				"redirect":     true,
				"redirect_url": extractRedirectURL(err.Error()),
				"error":        "URL redirects to a different host. Please fetch the redirect URL directly.",
			}, nil
		}
		return nil, fmt.Errorf("failed to fetch URL: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP error: %d %s", resp.StatusCode, resp.Status)
	}

	// Read body with size limit
	limitedReader := io.LimitReader(resp.Body, maxContentLength+1)
	body, err := io.ReadAll(limitedReader)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	truncated := len(body) > maxContentLength
	if truncated {
		body = body[:maxContentLength]
	}

	// Convert HTML to readable text/markdown
	content := htmlToText(string(body))

	// Cache the result
	cacheOps <- cacheOp{
		opType: cacheSet,
		url:    urlStr,
		entry: cacheEntry{
			content:   content,
			fetchedAt: time.Now(),
		},
	}

	return map[string]any{
		"url":       urlStr,
		"content":   content,
		"prompt":    prompt,
		"cached":    false,
		"truncated": truncated,
	}, nil
}

// extractRedirectURL extracts the redirect URL from the error message
func extractRedirectURL(errMsg string) string {
	// Error format: "redirect to different host: https://..."
	if _, after, ok := strings.Cut(errMsg, ": "); ok {
		return strings.TrimSpace(after)
	}
	return ""
}

// htmlToText converts HTML to readable plain text with basic markdown formatting
func htmlToText(htmlStr string) string {
	// Limit input size to prevent regex catastrophic backtracking (DoS protection)
	const maxHTMLSize = 500000 // 500KB max for regex processing
	if len(htmlStr) > maxHTMLSize {
		htmlStr = htmlStr[:maxHTMLSize]
	}

	// Remove script and style tags with their content
	scriptRe := regexp.MustCompile(`(?is)<script[^>]*>.*?</script>`)
	htmlStr = scriptRe.ReplaceAllString(htmlStr, "")

	styleRe := regexp.MustCompile(`(?is)<style[^>]*>.*?</style>`)
	htmlStr = styleRe.ReplaceAllString(htmlStr, "")

	// Remove HTML comments
	commentRe := regexp.MustCompile(`<!--[\s\S]*?-->`)
	htmlStr = commentRe.ReplaceAllString(htmlStr, "")

	// Convert headers to markdown
	for i := 6; i >= 1; i-- {
		headerRe := regexp.MustCompile(fmt.Sprintf(`(?is)<h%d[^>]*>(.*?)</h%d>`, i, i))
		prefix := strings.Repeat("#", i)
		htmlStr = headerRe.ReplaceAllString(htmlStr, "\n"+prefix+" $1\n")
	}

	// Convert paragraphs
	pRe := regexp.MustCompile(`(?is)<p[^>]*>(.*?)</p>`)
	htmlStr = pRe.ReplaceAllString(htmlStr, "\n$1\n")

	// Convert line breaks
	brRe := regexp.MustCompile(`(?i)<br\s*/?>`)
	htmlStr = brRe.ReplaceAllString(htmlStr, "\n")

	// Convert links to markdown format
	linkRe := regexp.MustCompile(`(?is)<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)</a>`)
	htmlStr = linkRe.ReplaceAllString(htmlStr, "[$2]($1)")

	// Convert bold (strong and b tags separately since Go regex doesn't support backreferences)
	strongRe := regexp.MustCompile(`(?is)<strong[^>]*>(.*?)</strong>`)
	htmlStr = strongRe.ReplaceAllString(htmlStr, "**$1**")
	bRe := regexp.MustCompile(`(?is)<b[^>]*>(.*?)</b>`)
	htmlStr = bRe.ReplaceAllString(htmlStr, "**$1**")

	// Convert italic (em and i tags separately)
	emRe := regexp.MustCompile(`(?is)<em[^>]*>(.*?)</em>`)
	htmlStr = emRe.ReplaceAllString(htmlStr, "*$1*")
	iRe := regexp.MustCompile(`(?is)<i[^>]*>(.*?)</i>`)
	htmlStr = iRe.ReplaceAllString(htmlStr, "*$1*")

	// Convert code blocks
	preRe := regexp.MustCompile(`(?is)<pre[^>]*>(.*?)</pre>`)
	htmlStr = preRe.ReplaceAllString(htmlStr, "\n```\n$1\n```\n")

	// Convert inline code
	codeRe := regexp.MustCompile(`(?is)<code[^>]*>(.*?)</code>`)
	htmlStr = codeRe.ReplaceAllString(htmlStr, "`$1`")

	// Convert list items
	liRe := regexp.MustCompile(`(?is)<li[^>]*>(.*?)</li>`)
	htmlStr = liRe.ReplaceAllString(htmlStr, "\n- $1")

	// Remove remaining HTML tags
	tagRe := regexp.MustCompile(`<[^>]+>`)
	htmlStr = tagRe.ReplaceAllString(htmlStr, "")

	// Decode all HTML entities (handles &nbsp;, &amp;, numeric entities, etc.)
	htmlStr = html.UnescapeString(htmlStr)

	// Clean up whitespace
	// Replace multiple spaces with single space
	spaceRe := regexp.MustCompile(`[ \t]+`)
	htmlStr = spaceRe.ReplaceAllString(htmlStr, " ")

	// Replace multiple newlines with double newline
	newlineRe := regexp.MustCompile(`\n{3,}`)
	htmlStr = newlineRe.ReplaceAllString(htmlStr, "\n\n")

	// Trim each line
	lines := strings.Split(htmlStr, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSpace(line)
	}
	htmlStr = strings.Join(lines, "\n")

	// Final trim
	return strings.TrimSpace(htmlStr)
}
