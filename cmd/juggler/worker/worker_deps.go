//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// workerDeps is what the worker is handed from outside: the callbacks into the
// server that resolve paths and names, persist the doc, call the model, and
// answer the settings the worker reads live.
//
// They are set by whoever owns the worker — the Manager, at creation and again
// on a live worker when the server replaces one, or a test — while the run loop
// and every turn goroutine read them. So they are never fields written in
// place: the set is an immutable snapshot behind an atomic pointer, replaced
// whole by setDeps, and a reader takes one snapshot (deps) that no later set can
// tear. Each field is nil until set; what nil means is said beside it.
type workerDeps struct {
	// pathProvider resolves convID → on-disk folder path. Called on every load
	// so a rename mid-life is naturally seen on the next I/O. Nil ⇒ every
	// conversation is unknown.
	pathProvider PathProviderFunc

	// nameProvider resolves convID → the conversation's human-readable name,
	// called on every use so a rename mid-life is seen immediately. Nil ⇒ the
	// worker treats the name as "not known" rather than guessing at one.
	nameProvider NameProviderFunc

	// saveBinary persists the Yjs doc. The implementation creates the
	// conversation folder if it doesn't exist (e.g. brand-new convs and
	// duplicates) and writes atomically. Nil ⇒ nothing is saved.
	saveBinary SaveBinaryFunc

	// llmCallFunc calls the LLM provider directly. Nil ⇒ "LLM caller not
	// configured".
	llmCallFunc LLMCallFunc

	// windowResolver maps the conversation's effective model to its context
	// window and output reserve. Nil (tests / not wired) ⇒ unknown window. See
	// WindowResolverFunc.
	windowResolver WindowResolverFunc

	// autoCompactGate reports whether automatic compaction is enabled. Nil
	// (tests / not wired) ⇒ enabled, preserving the default-on behavior. Note
	// the polarity is the inverse of windowResolver (nil there means unknown).
	// See AutoCompactGateFunc.
	autoCompactGate AutoCompactGateFunc

	// keepRecent resolves how much recent conversation a fold keeps verbatim.
	// Nil ⇒ the default applies. See KeepRecentFunc.
	keepRecent KeepRecentFunc

	// autoNameFunc is the injected server callback fired once, on the first user
	// message of the root conversation, to auto-name the tab out-of-band. Nil
	// (tests / not wired) ⇒ no auto-naming. See AutoNameFunc.
	autoNameFunc AutoNameFunc

	// engineReadyFunc brings the on-demand engine WebView up and waits until it
	// is connected, returning false if it could not. Used by the worker to
	// guarantee the engine is present before dispatching a strategy hook to it
	// at turn-start (the LLM-call gate runs too late for onActivate, whose
	// guidance must be in the doc before the turn's messages are built). Nil in
	// tests / the test-pool, where the engine is an always-on iframe — treated
	// as always-ready.
	engineReadyFunc func() bool

	// cancelLLMSession releases provider-side LLM session state for this
	// conversation, preserving the resume token + prompt-cache anchor so the
	// next turn stays warm. Today only the claudecode provider has anything to
	// do here (kill its parked CLI subprocess; the warm session survives). Nil ⇒
	// nothing to release.
	cancelLLMSession CancelLLMSessionFunc

	// spendLimit resolves the ceiling that stops delegated work past it. Nil ⇒
	// the default applies. See spend.go.
	spendLimit SpendLimitFunc

	// runBudgetFn resolves the per-run budget for delegated children. Nil ⇒ the
	// default applies. See run_budget.go.
	runBudgetFn RunBudgetFunc
}

// deps returns the current snapshot. Never nil, and never changed in place.
func (w *ConversationWorker) deps() *workerDeps { return w.injected.Load() }

// setDeps replaces the snapshot with a copy that change has edited. Safe from
// any goroutine, and against a concurrent setDeps: the swap retries on a
// snapshot that moved underneath it.
func (w *ConversationWorker) setDeps(change func(*workerDeps)) {
	for {
		cur := w.injected.Load()
		next := *cur
		change(&next)
		if w.injected.CompareAndSwap(cur, &next) {
			return
		}
	}
}

// resolveConvDir resolves a conversation's folder through the current path
// provider. The stores hold this rather than a provider of their own, so a
// provider replaced on a live worker reaches them too.
func (w *ConversationWorker) resolveConvDir(convID string) (string, bool) {
	if fn := w.deps().pathProvider; fn != nil {
		return fn(convID)
	}
	return "", false
}

// SetPathProvider injects the per-conversation path resolver. Called by the
// Manager when the worker is created and again if the provider is replaced.
func (w *ConversationWorker) SetPathProvider(fn PathProviderFunc) {
	w.setDeps(func(d *workerDeps) { d.pathProvider = fn })
}

// SetNameProvider injects the per-conversation name resolver. Called by the
// Manager when the worker is created and again if the provider is replaced.
func (w *ConversationWorker) SetNameProvider(fn NameProviderFunc) {
	w.setDeps(func(d *workerDeps) { d.nameProvider = fn })
}

// SetSaveBinary injects the doc-persistence callback.
func (w *ConversationWorker) SetSaveBinary(fn SaveBinaryFunc) {
	w.setDeps(func(d *workerDeps) { d.saveBinary = fn })
}

// SetLLMCaller sets the function used to call the LLM provider directly.
func (w *ConversationWorker) SetLLMCaller(fn LLMCallFunc) {
	w.setDeps(func(d *workerDeps) { d.llmCallFunc = fn })
}

// SetWindowResolver injects the read-only context-window resolver. See
// WindowResolverFunc.
func (w *ConversationWorker) SetWindowResolver(fn WindowResolverFunc) {
	w.setDeps(func(d *workerDeps) { d.windowResolver = fn })
}

// SetAutoCompactGate injects the gate that governs whether automatic proactive
// and reactive compaction runs. See AutoCompactGateFunc.
func (w *ConversationWorker) SetAutoCompactGate(fn AutoCompactGateFunc) {
	w.setDeps(func(d *workerDeps) { d.autoCompactGate = fn })
}

// SetKeepRecent installs the keep-recent resolver. See KeepRecentFunc.
func (w *ConversationWorker) SetKeepRecent(fn KeepRecentFunc) {
	w.setDeps(func(d *workerDeps) { d.keepRecent = fn })
}

// SetAutoNamer registers the out-of-band tab auto-naming callback. See
// AutoNameFunc.
func (w *ConversationWorker) SetAutoNamer(fn AutoNameFunc) {
	w.setDeps(func(d *workerDeps) { d.autoNameFunc = fn })
}

// SetEngineReadyFunc registers the gate that brings the on-demand engine up and
// waits for it to connect. The worker calls it before dispatching a strategy
// hook to the engine at turn-start.
func (w *ConversationWorker) SetEngineReadyFunc(fn func() bool) {
	w.setDeps(func(d *workerDeps) { d.engineReadyFunc = fn })
}

// SetCancelLLMSession registers the provider-side cancellation hook used by
// handleCancel when the worker is waiting for a tool result and there is no
// in-flight LLM ctx to cancel.
func (w *ConversationWorker) SetCancelLLMSession(fn CancelLLMSessionFunc) {
	w.setDeps(func(d *workerDeps) { d.cancelLLMSession = fn })
}

// SetSpendLimit installs the ceiling resolver. See SpendLimitFunc.
func (w *ConversationWorker) SetSpendLimit(fn SpendLimitFunc) {
	w.setDeps(func(d *workerDeps) { d.spendLimit = fn })
}

// SetRunBudget installs the run budget resolver. See RunBudgetFunc.
func (w *ConversationWorker) SetRunBudget(fn RunBudgetFunc) {
	w.setDeps(func(d *workerDeps) { d.runBudgetFn = fn })
}
