package provider

import (
	"context"
	"errors"
	"fmt"
	"math"
	"testing"
	"time"
)

type admissionTestProvider struct {
	conversation *admissionTestConversation
}

func (p *admissionTestProvider) Name() string { return "admission-test" }
func (p *admissionTestProvider) ListModelsWithInfo(context.Context) ([]ModelInfo, error) {
	return nil, nil
}
func (p *admissionTestProvider) OpenConversation(context.Context, string) (Conversation, error) {
	return p.conversation, nil
}

type admissionTestConversation struct {
	submits   int
	callbacks int
}

func (cv *admissionTestConversation) Submit(_ context.Context, _ MessageRequest, callback StructuredStreamCallback) (*StreamResult, error) {
	cv.submits++
	if callback != nil {
		cv.callbacks++
		_, _ = callback(StreamChunk{Type: ContentBlockTypeText, Content: "called"})
	}
	return &StreamResult{}, nil
}
func (cv *admissionTestConversation) Subscribe(TurnSink)      {}
func (cv *admissionTestConversation) CacheTTL() time.Duration { return 0 }
func (cv *admissionTestConversation) Cancel()                 {}
func (cv *admissionTestConversation) Close() error            { return nil }

func openAdmissionTestConversation(t *testing.T, cfg Config) (*admissionTestConversation, Conversation) {
	t.Helper()
	wrapped := &admissionTestConversation{}
	name := "admission-test-" + t.Name()
	RegisterProvider(ProviderInfo{Name: name}, func(Config) (Provider, error) {
		return &admissionTestProvider{conversation: wrapped}, nil
	})
	initialized, err := InitializeProvider(name, cfg)
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := initialized.OpenConversation(context.Background(), "conversation")
	if err != nil {
		t.Fatal(err)
	}
	return wrapped, conversation
}

func TestInitializeProviderWrapsEveryStatefulConversation(t *testing.T) {
	var opened []*admissionTestConversation
	name := "admission-stateful-" + t.Name()
	RegisterProvider(ProviderInfo{Name: name}, func(Config) (Provider, error) {
		return &statefulAdmissionTestProvider{opened: &opened}, nil
	})
	initialized, err := InitializeProvider(name, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100},
		BudgetContract:    BudgetContract{OutputReserveTokens: 20},
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, convID := range []string{"first", "second"} {
		conversation, openErr := initialized.OpenConversation(context.Background(), convID)
		if openErr != nil {
			t.Fatal(openErr)
		}
		_, submitErr := conversation.Submit(context.Background(), MessageRequest{
			Messages: []Message{{Type: "user", Content: "stateful " + convID + " " + string(make([]byte, 200))}},
		}, nil)
		var exceeded *ContextLimitExceededError
		if !errors.As(submitErr, &exceeded) {
			t.Fatalf("%s error = %T %v, want ContextLimitExceededError", convID, submitErr, submitErr)
		}
	}
	if len(opened) != 2 {
		t.Fatalf("opened conversations = %d, want 2", len(opened))
	}
	for i, conversation := range opened {
		if conversation.submits != 0 {
			t.Fatalf("underlying conversation %d submits = %d, want 0", i, conversation.submits)
		}
	}
}

type statefulAdmissionTestProvider struct {
	opened *[]*admissionTestConversation
}

func (p *statefulAdmissionTestProvider) Name() string { return "stateful-admission-test" }
func (p *statefulAdmissionTestProvider) ListModelsWithInfo(context.Context) ([]ModelInfo, error) {
	return nil, nil
}
func (p *statefulAdmissionTestProvider) OpenConversation(context.Context, string) (Conversation, error) {
	conversation := &admissionTestConversation{}
	*p.opened = append(*p.opened, conversation)
	return conversation, nil
}

func TestAdmissionExactFitAndOneTokenOver(t *testing.T) {
	req := MessageRequest{SystemPrompt: "system", Messages: []Message{{Type: "user", Content: "hello"}}}
	estimated := EstimateMessageRequestTokens(req)
	const reserve int64 = 17

	wrapped, exact := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: estimated + reserve},
		BudgetContract:    BudgetContract{OutputReserveTokens: reserve},
	})
	if _, err := exact.Submit(context.Background(), req, nil); err != nil {
		t.Fatalf("exact fit rejected: %v", err)
	}
	if wrapped.submits != 1 {
		t.Fatalf("wrapped submits = %d, want 1", wrapped.submits)
	}

	wrapped, over := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: estimated + reserve - 1},
		BudgetContract:    BudgetContract{OutputReserveTokens: reserve},
	})
	callbackCalls := 0
	_, err := over.Submit(context.Background(), req, func(StreamChunk) (*ToolResult, error) {
		callbackCalls++
		return nil, nil
	})
	var exceeded *ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
	}
	if exceeded.Retryable() {
		t.Fatal("exceeded error must be non-retryable")
	}
	if wrapped.submits != 0 || wrapped.callbacks != 0 || callbackCalls != 0 {
		t.Fatalf("rejection invoked wrapped path: submits=%d wrapped callbacks=%d callbacks=%d", wrapped.submits, wrapped.callbacks, callbackCalls)
	}
}

func TestAdmissionRejectsLargeResolvedImageDespiteTinyDimensions(t *testing.T) {
	req := MessageRequest{Messages: []Message{{
		Type:  "user",
		Parts: []MediaPart{{Type: "image", Width: 1, Height: 1, Data: make([]byte, 10_000)}},
	}}}
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 9_000},
		BudgetContract:    BudgetContract{OutputReserveTokens: 100},
	})
	_, err := conversation.Submit(context.Background(), req, nil)
	var exceeded *ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
	}
	if exceeded.Breakdown.ImageTokens != 10_000 {
		t.Fatalf("image tokens = %d, want 10000", exceeded.Breakdown.ImageTokens)
	}
	if wrapped.submits != 0 {
		t.Fatalf("wrapped submits = %d, want 0", wrapped.submits)
	}
}

func TestAdmissionUnknownLimitsFailClosedUnlessExplicitlyAllowed(t *testing.T) {
	wrapped, guarded := openAdmissionTestConversation(t, Config{})
	_, err := guarded.Submit(context.Background(), MessageRequest{}, nil)
	var unknown *UnknownContextLimitError
	if !errors.As(err, &unknown) {
		t.Fatalf("error = %T %v, want UnknownContextLimitError", err, err)
	}
	if unknown.Retryable() {
		t.Fatal("unknown-limit error must be non-retryable")
	}
	if wrapped.submits != 0 {
		t.Fatalf("wrapped submits = %d, want 0", wrapped.submits)
	}

	wrapped, allowed := openAdmissionTestConversation(t, Config{
		BudgetContract: BudgetContract{AllowUnknownLimits: true},
	})
	if _, err := allowed.Submit(context.Background(), MessageRequest{}, nil); err != nil {
		t.Fatalf("explicit unknown-limit opt-in rejected: %v", err)
	}
	if wrapped.submits != 1 {
		t.Fatalf("wrapped submits = %d, want 1", wrapped.submits)
	}
}

func TestAdmissionRejectsOutputReserveAtOrAboveContextWindow(t *testing.T) {
	for _, reserve := range []int64{100, 101} {
		t.Run(fmt.Sprintf("reserve_%d", reserve), func(t *testing.T) {
			wrapped, conversation := openAdmissionTestConversation(t, Config{
				ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100},
				BudgetContract:    BudgetContract{OutputReserveTokens: reserve},
			})
			_, err := conversation.Submit(context.Background(), MessageRequest{}, nil)
			var invalid *InvalidOutputReserveError
			if !errors.As(err, &invalid) {
				t.Fatalf("error = %T %v, want InvalidOutputReserveError", err, err)
			}
			if invalid.ContextWindowTokens != 100 || invalid.OutputReserveTokens != reserve {
				t.Fatalf("typed fields = %+v, want window 100 and reserve %d", invalid, reserve)
			}
			if invalid.Retryable() {
				t.Fatal("invalid reserve error must be non-retryable")
			}
			if wrapped.submits != 0 {
				t.Fatalf("wrapped submits = %d, want 0", wrapped.submits)
			}
		})
	}
}

func TestAdmissionUsesCapabilityOutputReserve(t *testing.T) {
	req := MessageRequest{Messages: []Message{{Type: "user", Content: "x"}}}
	estimated := EstimateMessageRequestTokens(req)
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{
			ContextWindowTokens: estimated + 8,
			MaxOutputTokens:     9,
		},
	})
	_, err := conversation.Submit(context.Background(), req, nil)
	var exceeded *ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
	}
	if wrapped.submits != 0 {
		t.Fatalf("wrapped submits = %d, want 0", wrapped.submits)
	}
}

func TestAdmissionDerivesOutputReserveFromKnownContext(t *testing.T) {
	tests := []struct {
		name    string
		window  int64
		reserve int64
	}{
		{name: "small context", window: 100_000, reserve: 20_000},
		{name: "boundary context", window: 200_000, reserve: 40_000},
		{name: "large context", window: 200_001, reserve: 20_000},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := contextSafetyReserve(test.window); got != test.reserve {
				t.Fatalf("contextSafetyReserve(%d) = %d, want %d", test.window, got, test.reserve)
			}
			wrapped, conversation := openAdmissionTestConversation(t, Config{
				ModelCapabilities: ModelCapabilities{ContextWindowTokens: test.window},
			})
			_, err := conversation.Submit(context.Background(), MessageRequest{}, nil)
			if err != nil {
				t.Fatalf("known context with derived reserve rejected: %v", err)
			}
			if wrapped.submits != 1 {
				t.Fatalf("wrapped submits = %d, want 1", wrapped.submits)
			}
		})
	}
}

func TestEstimateMessageRequestTokensConservativeUnicodeAndOpaqueRuns(t *testing.T) {
	tests := []struct {
		name string
		text string
		min  int64
	}{
		{name: "punctuation", text: "{}[],:/\\!@#$%^&*()", min: 18},
		{name: "hash", text: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", min: 48},
		{name: "CJK", text: "漢字仮名交じり文中文測試", min: 12},
		{name: "emoji", text: "😀🧑🏽‍💻", min: 19},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := approximateTokenCount(test.text); got < test.min {
				t.Fatalf("estimate %d below conservative minimum %d", got, test.min)
			}
		})
	}
}

func TestAdmissionIncludesProviderOverheadAndBreakdown(t *testing.T) {
	req := MessageRequest{Messages: []Message{{Type: "user", Content: "hello"}}}
	base := EstimateMessageRequestTokens(req)
	const overhead int64 = 37
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{
			ContextWindowTokens:    base + overhead,
			ProviderOverheadTokens: overhead,
		},
		BudgetContract: BudgetContract{OutputReserveTokens: 1},
	})
	_, err := conversation.Submit(context.Background(), req, nil)
	var exceeded *ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
	}
	if exceeded.Breakdown.ProviderOverheadTokens != overhead || exceeded.Breakdown.Total != base+overhead {
		t.Fatalf("breakdown = %+v, want overhead %d and total %d", exceeded.Breakdown, overhead, base+overhead)
	}
	if wrapped.submits != 0 {
		t.Fatalf("wrapped submits = %d, want 0", wrapped.submits)
	}
}

func TestEstimateMessageRequestTokensCoversCompleteEnvelope(t *testing.T) {
	base := MessageRequest{}
	rich := MessageRequest{
		SystemPrompt:   "system",
		ConversationID: "conversation",
		ThreadID:       "thread",
		ToolChoice:     &ToolChoice{Mode: ToolChoiceTool, Name: "tool"},
		Tools: []ToolDefinition{{
			Name:        "tool",
			Description: "description",
			InputSchema: []byte(`{"type":"object","properties":{"query":{"type":"string"}}}`),
		}},
		Messages: []Message{{
			Type: "tool-use", Content: "content", ProviderData: map[string]any{"signature": "opaque"},
			ToolUseID: "id", ToolName: "tool", ToolInput: map[string]any{"query": "value"},
			IsError: true, ResultType: "action", FullResult: map[string]any{"nested": map[string]any{"value": "full"}},
			ItemID: "item", IsNew: true, IsGlobal: true, Message: "message", Stack: "stack",
			HasRetryButton: true, EventType: "event", Source: "source",
			Parts: []MediaPart{{Type: "image", Mime: "image/png", AssetID: "asset", Width: 1500, Height: 750}},
		}},
	}
	if got, wantMin := EstimateMessageRequestTokens(rich), EstimateMessageRequestTokens(base)+1500; got < wantMin {
		t.Fatalf("rich estimate = %d, want at least %d", got, wantMin)
	}
}

func TestEstimateImageTokensUsesResolvedBytesAndNonzeroFloor(t *testing.T) {
	tests := []struct {
		name string
		part MediaPart
		want int
	}{
		{
			name: "one pixel has floor",
			part: MediaPart{Type: "image", Width: 1, Height: 1},
			want: 1,
		},
		{
			name: "unknown dimensions retain fallback",
			part: MediaPart{Type: "image"},
			want: int(flatImageTokenEstimate),
		},
		{
			name: "large unknown dimensions scale with bytes",
			part: MediaPart{Type: "image", Mime: "image/webp", Data: make([]byte, 32_000)},
			want: 32_000,
		},
		{
			name: "client dimensions cannot lower resolved byte charge",
			part: MediaPart{Type: "image", Width: 1, Height: 1, Data: make([]byte, 8_000)},
			want: 8_000,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := EstimateImageTokens(test.part); got != test.want {
				t.Fatalf("EstimateImageTokens() = %d, want %d", got, test.want)
			}
		})
	}
}

func TestEstimateMessageRequestTokensChargesResolvedImageBytes(t *testing.T) {
	req := MessageRequest{Messages: []Message{{
		Type:  "user",
		Parts: []MediaPart{{Type: "image", Width: 1, Height: 1, Data: make([]byte, 12_000)}},
	}}}
	breakdown := EstimateMessageRequestTokenBreakdown(req, 0)
	if breakdown.ImageTokens != 12_000 {
		t.Fatalf("image tokens = %d, want 12000", breakdown.ImageTokens)
	}
	if breakdown.Total < breakdown.ImageTokens {
		t.Fatalf("total = %d, want at least image charge %d", breakdown.Total, breakdown.ImageTokens)
	}
}

func TestEstimateMessageRequestTokensSaturates(t *testing.T) {
	req := MessageRequest{Messages: []Message{{
		Type:  "user",
		Parts: []MediaPart{{Type: "image", Width: math.MaxInt, Height: math.MaxInt}},
	}}}
	if got := EstimateMessageRequestTokens(req); got != math.MaxInt64 {
		t.Fatalf("estimate = %d, want saturation at %d", got, int64(math.MaxInt64))
	}
}
