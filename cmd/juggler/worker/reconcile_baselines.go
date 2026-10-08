//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// reconcileBaselines is what the reconcile tick remembers of the document from
// its previous pass, so the two edge-triggered tool rules can tell a change from
// a standing state:
//
//   - each thread's effective strategy, for reevaluatePendingToolsOnStrategyChange
//     (a strategy switch re-asks approval of the tools parked under the old one);
//   - the cancelled tool-actions, for cascadeBatchDenials (a fresh denial refuses
//     its unstarted siblings).
//
// Each has a baseline flag guarding its first observation, which only records:
// a conversation loaded with a state already in it is not a change. The rules
// themselves, and the document walks, are in tool_commands.go. Every field is
// read and written only by the methods in this file
// (TestWorkerSeamsOwnTheirState). Run goroutine only.
type reconcileBaselines struct {
	// strategyByThread is each thread's effective strategy as of the last tick,
	// keyed by threadItemID ("" = root; an empty strategy normalized to
	// "default").
	strategyByThread  map[string]string
	strategyBaselined bool
	// cancelledTools is the toolUseId of every tool-action observed cancelled as
	// of the last tick. Rebuilt each tick, so it is bounded by the cancelled
	// tools in the doc, and a tool reset back out of cancelled (retry-approval)
	// is forgotten and can trigger again.
	cancelledTools  map[string]bool
	denialBaselined bool
}

// newReconcileBaselines returns baselines that have observed nothing.
func newReconcileBaselines() reconcileBaselines {
	return reconcileBaselines{
		strategyByThread: make(map[string]string),
		cancelledTools:   make(map[string]bool),
	}
}

// recordedStrategies returns a copy of the strategies recorded at the last tick,
// which a new snapshot starts from: a thread the tick does not re-observe keeps
// its old baseline.
func (b *reconcileBaselines) recordedStrategies() map[string]string {
	out := make(map[string]string, len(b.strategyByThread)+1)
	for threadID, strategyID := range b.strategyByThread {
		out[threadID] = strategyID
	}
	return out
}

// strategySwitches records current as the new baseline and returns the threads
// whose strategy differs from the one recorded before. The first observation,
// and a thread seen for the first time, only record.
func (b *reconcileBaselines) strategySwitches(current map[string]string) map[string]bool {
	if !b.strategyBaselined {
		b.strategyByThread = current
		b.strategyBaselined = true
		return nil
	}
	changed := make(map[string]bool)
	for threadID, cur := range current {
		prev, existed := b.strategyByThread[threadID]
		if existed && cur != prev {
			changed[threadID] = true
		}
	}
	b.strategyByThread = current
	return changed
}

// isFreshDenial reports whether the cancelled tool id was not cancelled at the
// last tick.
func (b *reconcileBaselines) isFreshDenial(id string) bool { return !b.cancelledTools[id] }

// recordDenials records current as the cancelled set and reports whether a
// baseline existed before it, i.e. whether this tick's fresh denials are real
// changes rather than the first look at a loaded conversation.
func (b *reconcileBaselines) recordDenials(current map[string]bool) (baselined bool) {
	baselined = b.denialBaselined
	b.cancelledTools = current
	b.denialBaselined = true
	return baselined
}
