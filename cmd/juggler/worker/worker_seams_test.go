//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"
)

// These drive each seam bare, with no worker, to pin the rules the move carried
// over from the worker's own fields.

func TestLivenessClockMeasuresOnlyAFreeze(t *testing.T) {
	var c livenessClock
	if c.ticks() != nil {
		t.Fatal("a clock that never started must have no tick channel")
	}
	const t0 = int64(1_000_000)
	if got := c.frozenFor(t0); got != 0 {
		t.Fatalf("first tick reported %dms frozen, want 0", got)
	}
	normal := t0 + livenessInterval.Milliseconds() + 50
	if got := c.frozenFor(normal); got != 0 {
		t.Fatalf("normal cadence reported %dms frozen, want 0", got)
	}
	frozen := normal + livenessInterval.Milliseconds() + 30_000
	if got := c.frozenFor(frozen); got != 30_000 {
		t.Fatalf("a 30s freeze reported %dms, want 30000", got)
	}
	if got := c.frozenFor(frozen - 10_000); got != 0 {
		t.Fatalf("a backward clock step reported %dms frozen, want 0", got)
	}
}

func TestUndoGroupingMarksAreOneShot(t *testing.T) {
	u := newUndoGrouping(nil)
	if _, ok := u.takeCompactionMerge(); ok {
		t.Fatal("a fresh grouping has a compaction in flight")
	}
	if _, ok := u.takeCommandMerge(); ok {
		t.Fatal("a fresh grouping has a command bracket open")
	}
	u.markCompactionStart(undoMark{seq: 3})
	u.openCommand(undoMark{})
	if m, ok := u.takeCompactionMerge(); !ok || m.seq != 3 {
		t.Fatalf("takeCompactionMerge = %+v,%v, want seq 3,true", m, ok)
	}
	if m, ok := u.takeCommandMerge(); !ok || m != (undoMark{}) {
		t.Fatalf("takeCommandMerge = %+v,%v, want the zero mark,true (the zero mark is a real mark)", m, ok)
	}
	if _, ok := u.takeCompactionMerge(); ok {
		t.Fatal("the compaction mark survived being taken")
	}

	now := time.Now()
	u.startNavRecoil(now)
	if !u.inNavRecoil(now.Add(historyNavRecoil / 2)) {
		t.Fatal("inside the recoil window, inNavRecoil = false")
	}
	if u.inNavRecoil(now.Add(historyNavRecoil)) {
		t.Fatal("at the window's end, inNavRecoil = true")
	}
	if u.inNavRecoil(now) {
		t.Fatal("an expired window reopened for an earlier instant; expiry must close it")
	}
	u.startNavRecoil(now)
	u.endNavRecoil()
	if u.inNavRecoil(now) {
		t.Fatal("endNavRecoil left the window open")
	}
}

func TestReconcileBaselinesRecordBeforeTheyCompare(t *testing.T) {
	b := newReconcileBaselines()
	if changed := b.strategySwitches(map[string]string{"": "default", "t1": "yolo"}); len(changed) != 0 {
		t.Fatalf("first observation reported switches %v; it must only record", changed)
	}
	carried := b.recordedStrategies()
	carried[""] = "mutated"
	if b.recordedStrategies()[""] != "default" {
		t.Fatal("recordedStrategies handed out the baseline itself, not a copy")
	}
	changed := b.strategySwitches(map[string]string{"": "yolo", "t1": "yolo", "t2": "default"})
	if len(changed) != 1 || !changed[""] {
		t.Fatalf("switches = %v, want only the root (t2 is new, so baseline only)", changed)
	}

	if b.recordDenials(map[string]bool{"tu-old": true}) {
		t.Fatal("first denial observation reported a prior baseline")
	}
	if b.isFreshDenial("tu-old") {
		t.Fatal("a denial already recorded read as fresh")
	}
	if !b.isFreshDenial("tu-new") {
		t.Fatal("an unrecorded denial did not read as fresh")
	}
	if !b.recordDenials(map[string]bool{"tu-new": true}) {
		t.Fatal("second observation reported no baseline")
	}
	if !b.isFreshDenial("tu-old") {
		t.Fatal("a denial reset out of cancelled was not forgotten")
	}
}

func TestDocSaverCoalescesAndCancels(t *testing.T) {
	s := newDocSaver()
	s.noteChange()
	s.noteChange()
	if !s.isUnsaved() {
		t.Fatal("noteChange did not mark the doc unsaved")
	}
	<-s.rearmRequests()
	select {
	case <-s.rearmRequests():
		t.Fatal("two changes queued two re-arms; a burst must coalesce")
	default:
	}
	s.markSaved()
	if s.isUnsaved() {
		t.Fatal("markSaved left the doc unsaved")
	}

	s.fireQueue <- struct{}{} // a firing already posted when shutdown arrives
	s.rearm()
	s.cancel()
	select {
	case <-s.fired():
		t.Fatal("cancel left a posted firing to be heard")
	default:
	}
}

// A document that keeps changing is still saved: every change restarts the
// debounce, so without a ceiling a change arriving more often than the debounce
// holds the save off for as long as the changes keep coming.
func TestDocSaverSavesADocumentThatNeverGoesQuiet(t *testing.T) {
	s := newDocSaver()
	s.debounce = 100 * time.Millisecond
	s.maxWait = 300 * time.Millisecond
	t.Cleanup(s.cancel)

	// Changes every 20ms — five per debounce — for far longer than the ceiling.
	// The bound is how long the changes keep coming, not how soon the save
	// lands: the assertion is only that it lands while they do.
	changing := time.After(5 * time.Second)
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	s.rearm()
	for {
		select {
		case <-s.fired():
			// A burst begun after the save gets a ceiling of its own, so its
			// first change waits out a whole debounce. Half of one is a bound
			// only a fault can beat: a timer never fires early.
			s.rearm()
			select {
			case <-s.fired():
				t.Fatal("the first change after a save fired at once: the ceiling carried over from the burst before")
			case <-time.After(s.debounce / 2):
			}
			return
		case <-changing:
			t.Fatalf("no save in 5s of a change every 20ms, against a %v debounce capped at %v", s.debounce, s.maxWait)
		case <-tick.C:
			s.rearm()
		}
	}
}
