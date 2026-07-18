//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"strings"
	"testing"
)

// goldenCorpus pins the estimator against an independent oracle. Expected
// counts were generated offline with tiktoken cl100k_base (the GPT-4 family
// BPE), 2026-07-18; regenerate by encoding each sample with any cl100k_base
// implementation. The oracle is independent: changing the estimator cannot
// silently change the expected values with it.
var goldenCorpus = []struct {
	name         string
	text         string
	cl100kTokens int64
}{
	{"single word", "text", 1},
	{"short sentence", "Hello, world!", 4},
	{"CJK common", "翻译中文", 7},
	{"CJK rare glyphs", "龘驫麤鱻", 10},
	{"CJK paragraph", "人工智能正在改变软件开发的方式，但上下文窗口仍然是有限的资源。", 31},
	{"mixed CJK/EN", "上下文 window 是 finite 的", 7},
	{"katakana", "コンテキストウィンドウ", 10},
	{"korean", "컨텍스트 창이 유한합니다", 13},
	{"go one-liner", `func main() { fmt.Println("hello") }`, 10},
	{"go code block", `func handleRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	fmt.Fprintf(w, "ok: %s", req.ID)
}`, 92},
	{"small json", `{"path":"internal/agent/agent.go","line":698}`, 14},
	{"tool call json", `{"tool":"replace_text","input":{"path":"web/js/model/document.js","old":"function render(items){return items.map(renderItem)}","new":"function render(items){return items.filter(Boolean).map(renderItem)}"},"options":{"createBackup":true,"validateSyntax":true}}`, 57},
	{"url", "https://github.com/charmbracelet/crush/pull/3280", 15},
	{"snake_case", "snake_case_identifier_with_many_parts", 6},
	{"formatted number", "1,234,567.89", 7},
	{"punctuation run", strings.Repeat("!", 32), 4},
	{"emoji", "😀🧪🚀🫠", 11},
	{"emoji zwj sequence", "👨‍👩‍👧‍👦🏳️‍🌈", 27},
	{"combining mark", "café", 3},
	{"accented words", "naïve façade résumé", 8},
	{"hex blob", strings.Repeat("deadbeef", 125), 375},
	{"base64 blob", strings.Repeat("QWxhZGRpbjpvcGVuIHNlc2FtZQ==", 36), 720},
	{"single char run", strings.Repeat("a", 5000), 625},
	{"adversarial alnum pairs", strings.Repeat("x9", 2000), 4000},
	{"adversarial alnum soup", strings.Repeat("qZ7wK2pX9mR4vB8nJ3hF6dS1gT5yL0cM", 50), 1600},
	{"prose", strings.Repeat("the quick brown fox jumps over the lazy dog. ", 40), 401},
	{"mixed whitespace", strings.Repeat(" \t\n", 100), 100},
	{"space run", strings.Repeat("    ", 25), 2},
	{"markdown", "# Context Windows\n\nEvery model has a **finite** context window. Juggler keeps requests inside it:\n\n- provider-reported limits are definitive\n- conservative local estimation before each call\n- automatic recovery by summarizing the oldest history\n\n> The output reserve is charged against the window before sending.\n\n`estimate + reserve <= window` must hold, or the call is not made.", 76},
	{"technical prose", "The bounded reducer splits the canonical transcript into chunks that\neach fit the reduced window, summarizes every chunk with a hidden map call,\nthen reduces the partial summaries across passes until one final call fits.\nPasses, calls, and estimated spend are bounded; partial accounting survives\nfailure and cancellation so the operation always leaves diagnostics.", 64},
}

// TestApproximateTokenCountNeverUndercountsGoldenCorpus is the admission
// safety property: the local estimate must never be lower than a real BPE
// tokenizer's count. Under-counting over-admits — the provider then rejects
// the request or, worse (Ollama), silently truncates history.
func TestApproximateTokenCountNeverUndercountsGoldenCorpus(t *testing.T) {
	for _, sample := range goldenCorpus {
		if est := approximateTokenCount(sample.text); est < sample.cl100kTokens {
			t.Errorf("%s: estimate %d under-counts cl100k %d for %.40q", sample.name, est, sample.cl100kTokens, sample.text)
		}
	}
}

// TestApproximateTokenCountOvercountStaysBounded is a regression tripwire,
// not a calibration target: some sample classes (space runs, single-char
// repeats, punctuation) are deliberately charged well above any real
// tokenizer, so the bound is loose — it exists to catch accidental
// blow-ups (double counting, marshaling surprises), not to tighten rates.
func TestApproximateTokenCountOvercountStaysBounded(t *testing.T) {
	for _, sample := range goldenCorpus {
		if est := approximateTokenCount(sample.text); est > sample.cl100kTokens*10+32 {
			t.Errorf("%s: estimate %d exceeds tripwire for cl100k %d", sample.name, est, sample.cl100kTokens)
		}
	}
}
