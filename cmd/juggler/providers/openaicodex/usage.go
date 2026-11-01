//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"context"
	"fmt"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
)

type usageResponse struct {
	PlanType            string                `json:"plan_type"`
	RateLimit           usageRateLimit        `json:"rate_limit"`
	AdditionalRateLimit []additionalRateLimit `json:"additional_rate_limits"`
	CodeReviewRateLimit usageRateLimit        `json:"code_review_rate_limit"`
}

type additionalRateLimit struct {
	LimitName string         `json:"limit_name"`
	RateLimit usageRateLimit `json:"rate_limit"`
}

type usageRateLimit struct {
	PrimaryWindow   usageWindow `json:"primary_window"`
	SecondaryWindow usageWindow `json:"secondary_window"`
}

type usageWindow struct {
	UsedPercent        *float64 `json:"used_percent"`
	ResetAt            int64    `json:"reset_at"`
	LimitWindowSeconds int      `json:"limit_window_seconds"`
}

func usageStats(ctx context.Context, bearerToken string, headers map[string]string) (provider.UsageStats, error) {
	base, err := codexBaseURL()
	if err != nil {
		return provider.UsageStats{}, err
	}
	var parsed usageResponse
	if err := utils.GetJSON(ctx, base+"/usage", utils.JSONGetOptions{
		Bearer:  bearerToken,
		Headers: headers,
		Defaults: map[string]string{
			"Accept": "application/json",
			// The ChatGPT backend serves an HTML 403 challenge to Go's default
			// User-Agent on /usage, while the Codex CLI/browser-like clients
			// receive JSON. Keep this endpoint probe browser-shaped.
			"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
		},
		Label: "OpenAI Codex /usage",
	}, &parsed); err != nil {
		return provider.UsageStats{}, hintUnauthorized(err)
	}
	return buildUsageStats(parsed, time.Now()), nil
}

func buildUsageStats(parsed usageResponse, now time.Time) provider.UsageStats {
	stats := provider.UsageStats{
		Provider:  "openaicodex",
		Plan:      parsed.PlanType,
		UpdatedAt: now,
	}
	addWindow := func(name, category string, w usageWindow) {
		if w.UsedPercent == nil {
			return
		}
		stat := provider.UsageStat{
			Name:        name,
			UsedPercent: provider.Pct(*w.UsedPercent),
			WindowSecs:  w.LimitWindowSeconds,
			Category:    category,
		}
		if w.ResetAt > 0 {
			reset := time.Unix(w.ResetAt, 0).UTC()
			stat.ResetsAt = &reset
		}
		stats.Stats = append(stats.Stats, stat)
	}

	addWindow(windowName(parsed.RateLimit.PrimaryWindow, "Session (5h)"), "primary", parsed.RateLimit.PrimaryWindow)
	addWindow(windowName(parsed.RateLimit.SecondaryWindow, "Week (7d)"), "weekly", parsed.RateLimit.SecondaryWindow)
	for _, item := range parsed.AdditionalRateLimit {
		if item.LimitName == "" {
			continue
		}
		addWindow(item.LimitName+windowSuffix(item.RateLimit.PrimaryWindow, "5h"), "model", item.RateLimit.PrimaryWindow)
		addWindow(item.LimitName+windowSuffix(item.RateLimit.SecondaryWindow, "7d"), "model", item.RateLimit.SecondaryWindow)
	}
	addWindow("Code Review", "code_review", parsed.CodeReviewRateLimit.PrimaryWindow)
	return stats
}

func windowName(w usageWindow, fallback string) string {
	switch windowDuration(w) {
	case "":
		return fallback
	case "5h":
		return "Session (5h)"
	case "7d":
		return "Week (7d)"
	default:
		return "Window (" + windowDuration(w) + ")"
	}
}

func windowSuffix(w usageWindow, fallback string) string {
	if duration := windowDuration(w); duration != "" {
		return " (" + duration + ")"
	}
	return " (" + fallback + ")"
}

func windowDuration(w usageWindow) string {
	const (
		hour = 60 * 60
		day  = 24 * hour
	)
	switch {
	case w.LimitWindowSeconds <= 0:
		return ""
	case w.LimitWindowSeconds%day == 0:
		return fmt.Sprintf("%dd", w.LimitWindowSeconds/day)
	case w.LimitWindowSeconds%hour == 0:
		return fmt.Sprintf("%dh", w.LimitWindowSeconds/hour)
	default:
		return fmt.Sprintf("%dm", w.LimitWindowSeconds/60)
	}
}
