//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// How much of the recent conversation a fold keeps verbatim. The automatic
// fold (compactToFit) and /compact (foldConversationForCompaction) share one
// rule, chooseTail:
//
//	target = min(p · C, h · B)
//
// C is the estimated size of the foldable conversation, p the user's
// keep-recent setting, B the usable budget (window − envelope − output reserve
// − summary floor) and h compactionHeadroomFraction. The share is what a user
// can predict; the headroom bound keeps a fold of a full conversation from
// freeing too little to matter. The walk keeps whole units (a tool batch never
// splits) and always keeps the newest unit if it fits B at all.
//
// A tail that opens partway through a turn also keeps the user message the
// turn began with, within h · B: the cut moves back to it when nothing else
// lies between, so at 0% the tail is the latest user turn. Otherwise the request
// alone stays verbatim, ahead of the summary, and the turn's work before the
// cut folds with the history before it — a single long turn is most of a long
// conversation, and keeping it whole would leave a fold almost nothing to take.
// The automatic fold folds nothing when the whole conversation already fits
// h · B (keepAllWithinHeadroom).

const (
	// compactionHeadroomFraction is h above: the share of the usable budget a
	// tail may occupy, so the conversation after a fold has real room to grow
	// before the next one.
	compactionHeadroomFraction = 0.5

	// minManualFoldTokens is the least /compact will summarize while keeping a
	// tail. Below it the summary would be about as large as what it replaces;
	// /compact all still folds it.
	minManualFoldTokens int64 = 4000
)

// tailRole is how the tail walk treats a unit.
type tailRole int

const (
	// tailFoldable may fold or stay in the tail, and counts toward C.
	tailFoldable tailRole = iota
	// tailStanding stays wherever the cut falls and is walked past uncharged.
	tailStanding
	// tailPinned can never fold, and the fold range cannot cross it: the walk
	// stops there.
	tailPinned
)

// tailBounds are the limits one caller gives chooseTail.
type tailBounds struct {
	// keepFraction is p, the share of the foldable conversation to keep.
	keepFraction float64
	// headroom is h · B. The share is clamped to it, and the snap to a user
	// message may not pass it.
	headroom int64
	// newestBudget is what the newest unit alone may occupy and still be kept.
	newestBudget int64
	// keepAllWithinHeadroom keeps everything when the whole foldable
	// conversation already fits the headroom. The automatic fold sets it: once
	// an oversized trailing result has been shrunk in place there may be nothing
	// left that needs folding, and folding anyway would summarize history for no
	// reason. /compact leaves it off, since pressing it is the request.
	keepAllWithinHeadroom bool
}

// tailCut is where chooseTail cut: units[k:] stay verbatim.
type tailCut struct {
	k          int
	tailTokens int64
	// keptNewest is false when not even the newest unit could be kept (it is
	// pinned, or larger than newestBudget); k is then len(units).
	keptNewest bool
	// request is the unit holding the user message the tail's turn began with,
	// when it lies inside the fold range (below k) and stays verbatim ahead of
	// the summary; -1 when there is none. tailTokens counts it.
	request int
}

// chooseTail applies the tail rule over units[lo:], walking back from the
// newest. items is the array the units were cut from.
func chooseTail(items []ConversationItem, units []recoveryUnit, lo int, role func(recoveryUnit) tailRole, b tailBounds) tailCut {
	var total int64
	for _, u := range units[lo:] {
		if role(u) == tailFoldable {
			total += u.est
		}
	}
	target := min(int64(b.keepFraction*float64(total)), b.headroom)
	if b.keepAllWithinHeadroom && total <= b.headroom {
		target = total
	}

	cut := tailCut{k: len(units), request: -1}
	for cut.k > lo {
		u := units[cut.k-1]
		r := role(u)
		if r == tailStanding {
			cut.k--
			continue
		}
		if r == tailPinned {
			break
		}
		budget := target
		if !cut.keptNewest {
			budget = b.newestBudget
		}
		if cut.tailTokens+u.est > budget {
			break
		}
		cut.tailTokens += u.est
		cut.keptNewest = true
		cut.k--
	}
	if !cut.keptNewest {
		return cut
	}

	// If the tail opens partway through a turn, keep the user message that turn
	// began with: by moving the cut back to it when only standing units lie
	// between, or else on its own as cut.request.
	first := cut.k
	for first < len(units) && role(units[first]) == tailStanding {
		first++
	}
	if first < len(units) && items[units[first].start].Type == ItemTypeUser {
		return cut
	}
	adjacent := true
	for j := cut.k; j > lo; j-- {
		u := units[j-1]
		switch role(u) {
		case tailStanding:
			continue
		case tailPinned:
			return cut
		}
		if items[u.start].Type != ItemTypeUser {
			adjacent = false
			continue
		}
		if cut.tailTokens+u.est > b.headroom {
			return cut
		}
		cut.tailTokens += u.est
		if adjacent {
			cut.k = j - 1
		} else {
			cut.request = j - 1
		}
		return cut
	}
	return cut
}

const (
	// DefaultCompactKeepRecentPercent is the share of the foldable conversation a
	// fold keeps verbatim when the user has not set one.
	DefaultCompactKeepRecentPercent = 30

	// MaxCompactKeepRecentPercent caps the setting. Above it a fold of a full
	// conversation runs into the headroom bound and frees too little to matter.
	MaxCompactKeepRecentPercent = 60
)

// KeepRecentFunc reports the user's "keep recent conversation" setting as a
// whole percentage. Any value outside 0..MaxCompactKeepRecentPercent is clamped
// into it. Nil ⇒ DefaultCompactKeepRecentPercent.
type KeepRecentFunc func() int

// keepRecentFraction is the setting as a fraction, clamped to its range.
func (w *ConversationWorker) keepRecentFraction() float64 {
	p := DefaultCompactKeepRecentPercent
	if fn := w.deps().keepRecent; fn != nil {
		p = fn()
	}
	p = max(0, min(p, MaxCompactKeepRecentPercent))
	return float64(p) / 100
}
