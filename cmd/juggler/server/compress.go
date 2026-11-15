//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"juggler/cmd/juggler/webui"
)

// HTTP compression, for remote peers only.
//
// A remote peer (isRemotePeer) — a LAN browser, or anything the machine
// server's proxy or a tunnel forwards — sits behind a real link, where a cold
// page load of several megabytes of JavaScript and CSS is worth gzipping. The
// desktop app's webview and the engine ride loopback, where compression is
// pure CPU cost, so they are always answered uncompressed. Every response of a
// compressible type carries Vary: Accept-Encoding either way, so a shared
// cache never hands a gzipped body to a client that did not ask for one.
//
// Two layers do it:
//   - gzipCachedAssets serves the immutable /v<version>/ embedded assets from
//     an in-memory cache of their gzipped bytes, compressed once at
//     gzip.BestCompression.
//   - compressMiddleware gzips everything else as it streams (the index and
//     engine pages, /api/ JSON), at the default level.

// compressMinSize is the smallest body worth compressing: below it the gzip
// framing and the CPU outweigh the bytes saved.
const compressMinSize = 1024

// acceptsGzip reports whether the request's Accept-Encoding admits gzip: it
// names gzip, or "*", with a non-zero q.
func acceptsGzip(r *http.Request) bool {
	gzipQ, starQ := -1.0, -1.0
	for _, v := range r.Header.Values("Accept-Encoding") {
		for _, part := range strings.Split(v, ",") {
			name, params, _ := strings.Cut(part, ";")
			q := 1.0
			if k, val, ok := strings.Cut(strings.TrimSpace(params), "="); ok && strings.EqualFold(strings.TrimSpace(k), "q") {
				if f, err := strconv.ParseFloat(strings.TrimSpace(val), 64); err == nil {
					q = f
				}
			}
			switch strings.ToLower(strings.TrimSpace(name)) {
			case "gzip", "x-gzip":
				gzipQ = q
			case "*":
				starQ = q
			}
		}
	}
	if gzipQ >= 0 {
		return gzipQ > 0
	}
	return starQ > 0
}

// offersGzip reports whether r may be answered gzipped: a remote peer that
// accepts it, asking for a whole representation (a range names bytes of the
// uncompressed one).
func offersGzip(r *http.Request) bool {
	return isRemotePeer(r) && acceptsGzip(r) && r.Header.Get("Range") == ""
}

// compressibleType reports whether a Content-Type is text-like enough to be
// worth gzipping. An event stream is text, but is never compressed: each event
// must reach the client the moment it is written.
func compressibleType(contentType string) bool {
	mt, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	switch {
	case mt == "text/event-stream":
		return false
	case strings.HasPrefix(mt, "text/"):
		return true
	case strings.HasSuffix(mt, "+json"), strings.HasSuffix(mt, "+xml"):
		return true
	}
	switch mt {
	case "application/javascript", "application/x-javascript", "application/ecmascript",
		"application/json", "application/xml", "application/wasm":
		return true
	}
	return false
}

// addVaryAcceptEncoding adds Accept-Encoding to h's Vary unless it is there.
func addVaryAcceptEncoding(h http.Header) {
	for _, v := range h.Values("Vary") {
		for _, f := range strings.Split(v, ",") {
			if f = strings.TrimSpace(f); f == "*" || strings.EqualFold(f, "Accept-Encoding") {
				return
			}
		}
	}
	h.Add("Vary", "Accept-Encoding")
}

// isUpgradeRequest reports whether r asks to switch protocols (a WebSocket).
func isUpgradeRequest(r *http.Request) bool {
	return r.Header.Get("Upgrade") != ""
}

var gzipWriterPool = sync.Pool{New: func() any { return gzip.NewWriter(io.Discard) }}

// compressMiddleware gzips, as it streams, a response of a compressible type
// to a request offersGzip admits, and marks every response of such a type
// Vary: Accept-Encoding.
//
// A protocol upgrade and a request for an event stream get the writer they
// came with, untouched. Otherwise the decision is taken when the handler
// commits its headers, and passes the response through unchanged when it
// already has a Content-Encoding or Content-Range, a status without a full
// body (204, 206, 304), a type compressibleType rejects, or fewer than
// compressMinSize bytes — by its Content-Length, or, without one, by what it
// writes before it finishes or flushes.
func (s *Server) compressMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isUpgradeRequest(r) || strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
			next.ServeHTTP(w, r)
			return
		}
		cw := &compressWriter{w: w, allowGzip: offersGzip(r), head: r.Method == http.MethodHead}
		defer cw.finish()
		next.ServeHTTP(cw, r)
	})
}

// compressWriter is the ResponseWriter compressMiddleware hands a handler.
// Until it decides, it holds the status and up to compressMinSize bytes of
// body; once decided it either passes writes through or feeds them to gz.
type compressWriter struct {
	w         http.ResponseWriter
	allowGzip bool
	head      bool

	status      int
	wroteHeader bool
	decided     bool
	gzipped     bool
	hijacked    bool
	buf         []byte
	gz          *gzip.Writer
}

// Unwrap exposes the wrapped writer to http.ResponseController.
func (c *compressWriter) Unwrap() http.ResponseWriter { return c.w }

func (c *compressWriter) Header() http.Header { return c.w.Header() }

func (c *compressWriter) WriteHeader(code int) {
	if c.wroteHeader || c.hijacked {
		return
	}
	if code >= 100 && code < 200 {
		// Informational (103 Early Hints) goes ahead; the final status follows.
		c.w.WriteHeader(code)
		return
	}
	c.wroteHeader = true
	c.status = code
	_ = c.decide(nil, 0, false)
}

func (c *compressWriter) Write(p []byte) (int, error) {
	if c.hijacked {
		return 0, http.ErrHijacked
	}
	if !c.wroteHeader {
		c.WriteHeader(http.StatusOK)
	}
	if !c.decided {
		total := len(c.buf) + len(p)
		if total < compressMinSize {
			c.buf = append(c.buf, p...)
			if err := c.decide(c.buf, total, false); err != nil {
				return 0, err
			}
			return len(p), nil
		}
		sniff := c.buf
		if len(sniff) < 512 {
			sniff = append(bytes.Clone(c.buf), p[:min(len(p), 512-len(c.buf))]...)
		}
		if err := c.decide(sniff, total, false); err != nil {
			return 0, err
		}
	}
	return c.writeBody(p)
}

// writeBody writes p once the decision is taken.
func (c *compressWriter) writeBody(p []byte) (int, error) {
	switch {
	case c.gz != nil:
		return c.gz.Write(p)
	case c.gzipped: // HEAD: headers only
		return len(p), nil
	default:
		return c.w.Write(p)
	}
}

// decide commits the response's headers once it can tell whether to gzip.
// sniff is the start of the body (for a type the handler did not set), total
// how many bytes the handler has written, and final says no more are coming
// before the headers must go out.
func (c *compressWriter) decide(sniff []byte, total int, final bool) error {
	if c.decided {
		return nil
	}
	h := c.w.Header()
	switch c.status {
	case http.StatusNoContent, http.StatusPartialContent, http.StatusNotModified:
		return c.commit(false)
	}
	if h.Get("Content-Encoding") != "" || h.Get("Content-Range") != "" {
		return c.commit(false)
	}
	ct := h.Get("Content-Type")
	if ct == "" {
		if len(sniff) == 0 {
			if final {
				return c.commit(false)
			}
			return nil
		}
		// What net/http would sniff for itself, set here so the decision has a type.
		ct = http.DetectContentType(sniff)
		h.Set("Content-Type", ct)
	}
	if !compressibleType(ct) {
		return c.commit(false)
	}
	addVaryAcceptEncoding(h)
	if !c.allowGzip {
		return c.commit(false)
	}
	if cl := h.Get("Content-Length"); cl != "" {
		n, err := strconv.ParseInt(cl, 10, 64)
		return c.commit(err == nil && n >= compressMinSize)
	}
	if total >= compressMinSize {
		return c.commit(true)
	}
	if final {
		return c.commit(false)
	}
	return nil
}

// commit sends the headers, gzipped or not, and then whatever body is held.
func (c *compressWriter) commit(gzipped bool) error {
	c.decided = true
	h := c.w.Header()
	if gzipped {
		c.gzipped = true
		h.Del("Content-Length")
		h.Set("Content-Encoding", "gzip")
		// The gzipped bytes are not the identity bytes, so a strong validator
		// for one cannot name the other; weakened, it still matches on GET.
		if etag := h.Get("ETag"); etag != "" && !strings.HasPrefix(etag, "W/") {
			h.Set("ETag", "W/"+etag)
		}
		if !c.head {
			c.gz = gzipWriterPool.Get().(*gzip.Writer)
			c.gz.Reset(c.w)
		}
	}
	if c.wroteHeader {
		c.w.WriteHeader(c.status)
	}
	buf := c.buf
	c.buf = nil
	if len(buf) == 0 {
		return nil
	}
	_, err := c.writeBody(buf)
	return err
}

// Flush sends what is held — deciding first if need be, as the headers go out
// with it — and flushes the connection.
func (c *compressWriter) Flush() {
	_ = c.FlushError()
}

// FlushError is Flush, for http.ResponseController, reporting the failure.
func (c *compressWriter) FlushError() error {
	if c.hijacked {
		return http.ErrHijacked
	}
	if !c.wroteHeader {
		c.WriteHeader(http.StatusOK)
	}
	if err := c.decide(c.buf, len(c.buf), true); err != nil {
		return err
	}
	if c.gz != nil {
		if err := c.gz.Flush(); err != nil {
			return err
		}
	}
	return http.NewResponseController(c.w).Flush()
}

// Hijack hands the connection over; the middleware writes nothing after it.
func (c *compressWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(c.w).Hijack()
	if err == nil {
		c.hijacked = true
	}
	return conn, rw, err
}

// ReadFrom lets an uncompressed body reach the connection by the wrapped
// writer's ReadFrom (sendfile, for a file); anything else goes through Write.
func (c *compressWriter) ReadFrom(src io.Reader) (int64, error) {
	if c.decided && !c.gzipped && !c.hijacked {
		if rf, ok := c.w.(io.ReaderFrom); ok {
			return rf.ReadFrom(src)
		}
	}
	return io.Copy(struct{ io.Writer }{c}, src)
}

// finish ends the response: it decides if the handler never forced it, then
// closes the gzip stream.
func (c *compressWriter) finish() {
	if c.hijacked {
		return
	}
	if c.wroteHeader {
		_ = c.decide(c.buf, len(c.buf), true)
	}
	if c.gz != nil {
		_ = c.gz.Close()
		c.gz.Reset(io.Discard)
		gzipWriterPool.Put(c.gz)
		c.gz = nil
	}
}

// gzipCachedAssets serves, to a request offersGzip admits, the gzipped bytes
// of a regular file of fsys of a compressible type, compressing each once and
// keeping the result. Anything else — a directory, an index.html (the file
// server redirects those), a file too small to gain, a missing path — goes to
// next. Only for the immutable embedded trees: assets served from disk change
// under a running server, so there it is next alone.
//
// The cache holds an entry only for a path that names a regular file of fsys,
// so it is bounded by the embedded tree itself — at most one gzipped copy of
// each of its files, typically a quarter of its size — however many distinct
// paths are requested.
func (s *Server) gzipCachedAssets(fsys fs.FS, next http.Handler) http.Handler {
	if s.assetsFromDisk {
		return next
	}
	var cache sync.Map // file name → *gzippedAsset
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.Method != http.MethodGet && r.Method != http.MethodHead) || !offersGzip(r) {
			next.ServeHTTP(w, r)
			return
		}
		ct := webui.ContentType(r.URL.Path)
		name := strings.TrimPrefix(r.URL.Path, "/")
		if ct == "" || !compressibleType(ct) || !fs.ValidPath(name) || name == "." ||
			name == "index.html" || strings.HasSuffix(name, "/index.html") {
			next.ServeHTTP(w, r)
			return
		}
		v, ok := cache.Load(name)
		if !ok {
			if info, err := fs.Stat(fsys, name); err != nil || !info.Mode().IsRegular() {
				next.ServeHTTP(w, r)
				return
			}
			v, _ = cache.LoadOrStore(name, &gzippedAsset{})
		}
		asset := v.(*gzippedAsset)
		asset.once.Do(func() { asset.data = gzipFile(fsys, name) })
		if asset.data == nil {
			next.ServeHTTP(w, r)
			return
		}
		h := w.Header()
		h.Set("Content-Type", ct)
		h.Set("Content-Encoding", "gzip")
		h.Set("Content-Length", strconv.Itoa(len(asset.data)))
		addVaryAcceptEncoding(h)
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = w.Write(asset.data)
		}
	})
}

// gzippedAsset is one cached file: data is its gzipped bytes, or nil when it
// is not worth serving compressed.
type gzippedAsset struct {
	once sync.Once
	data []byte
}

// gzipFile returns name's content gzipped at gzip.BestCompression, or nil when
// it cannot be read, is smaller than compressMinSize, or does not shrink.
func gzipFile(fsys fs.FS, name string) []byte {
	raw, err := fs.ReadFile(fsys, name)
	if err != nil || len(raw) < compressMinSize {
		return nil
	}
	var out bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&out, gzip.BestCompression)
	if _, err := zw.Write(raw); err != nil {
		return nil
	}
	if err := zw.Close(); err != nil || out.Len() >= len(raw) {
		return nil
	}
	return out.Bytes()
}
