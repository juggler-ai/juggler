//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"math"
	"testing"
)

// FuzzApproximateTokenCount drives the estimator with arbitrary bytes. The
// safety properties: it never panics, never returns a negative count, and is
// monotonic under appending — adding content must never make a request look
// smaller, or admission could be gamed by padding.
func FuzzApproximateTokenCount(f *testing.F) {
	f.Add("Hello, world!")
	f.Add("翻译中文 — mixed 内容 with emoji 🚀")
	f.Add("QWxhZGRpbjpvcGVuIHNlc2FtZQ==")
	f.Add("\xff\xfe invalid utf-8 \xed\xa0\x80")
	f.Add(" \t\n ")
	f.Fuzz(func(t *testing.T, text string) {
		est := approximateTokenCount(text)
		if est < 0 {
			t.Fatalf("estimate %d < 0 for %q", est, text)
		}
		if longer := approximateTokenCount(text + "x"); longer < est {
			t.Fatalf("estimate not monotonic: %q -> %d, appended x -> %d", text, est, longer)
		}
	})
}

// FuzzEstimateMessageRequestTokenBreakdown checks the accounting invariant:
// the total covers every component, and a saturated component saturates the
// total — partial charges can never exceed the whole.
func FuzzEstimateMessageRequestTokenBreakdown(f *testing.F) {
	f.Add("system prompt", "user message", "tool name", int64(50))
	f.Add("", "", "", int64(0))
	f.Add("系统提示", "消息内容 🚀", "bash", int64(math.MaxInt64-1))
	f.Fuzz(func(t *testing.T, system, message, toolName string, overhead int64) {
		req := MessageRequest{
			SystemPrompt: system,
			Messages:     []Message{{Type: "user", Content: message}},
			Tools:        []ToolDefinition{{Name: toolName, Description: message, InputSchema: []byte(message)}},
		}
		breakdown := EstimateMessageRequestTokenBreakdown(req, overhead)
		if breakdown.Total < 0 {
			t.Fatalf("total %d < 0", breakdown.Total)
		}
		for name, component := range map[string]int64{
			"system":   breakdown.SystemPromptTokens,
			"messages": breakdown.MessageTokens,
			"tools":    breakdown.ToolTokens,
			"metadata": breakdown.MetadataTokens,
			"images":   breakdown.ImageTokens,
			"framing":  breakdown.FramingTokens,
			"overhead": breakdown.ProviderOverheadTokens,
		} {
			if component < 0 || component > breakdown.Total {
				t.Fatalf("%s component %d outside [0, total %d]", name, component, breakdown.Total)
			}
		}
	})
}
