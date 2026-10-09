//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// The calls one model turn emits are executed in emission order, in waves:
// consecutive calls that only read run together, and any other call is a
// barrier — it waits for every call before it and holds back every call after
// it. A turn that writes a script and runs it in the next call therefore never
// runs it first, while a turn that reads ten files still reads them at once.
//
// What a call does is its tool's `category`, stamped onto the tool-action by the
// engine when it evaluates the call. "read" and "meta" calls are not barriers;
// "write" is, and so is a call with no category yet (not yet evaluated, or a
// tool that declares none), since nothing says it is safe to overlap.
//
// A call parked for the user (pending) holds nothing back. It is not running and
// may never run, and approvals can be given in any order: a call the user
// approves runs, whatever is still awaiting a decision above it. Once approved,
// the parked call takes its place in the order like any other.
//
// A held call stays approved and is simply not commanded: driveToolActions picks
// it up on the tick after the call it waits for settles. Holding is not a failed
// delivery, so it is decided before the command tracker sees the call.

// turnCall is one tool-action as the ordering rule needs it.
type turnCall struct {
	id, state, category string
}

// callRunsAlongside reports whether a call of this category may overlap the
// calls around it.
func callRunsAlongside(category string) bool {
	return category == "read" || category == "meta"
}

// heldByTurnOrder returns the approved calls of one turn, given in emission
// order, that must not be commanded yet.
func heldByTurnOrder(calls []turnCall) map[string]bool {
	var held map[string]bool
	unsettled := false        // some earlier call is unfinished
	unsettledBarrier := false // some earlier non-overlapping call is unfinished
	for _, c := range calls {
		alongside := callRunsAlongside(c.category)
		if c.state == StateApproved && (unsettledBarrier || (!alongside && unsettled)) {
			if held == nil {
				held = map[string]bool{}
			}
			held[c.id] = true
		}
		if isTerminalToolState(c.state) || c.state == StatePending {
			continue
		}
		unsettled = true
		if !alongside {
			unsettledBarrier = true
		}
	}
	return held
}
