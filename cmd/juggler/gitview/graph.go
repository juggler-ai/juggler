//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import "slices"

// laneLayout places the commits of a history, children before parents, in the
// lanes of a graph, one commit at a time.
//
// A lane is a column waiting for one commit: the parent of a commit already
// placed. A commit goes in the lane waiting for it, or a free one when nothing
// is (a branch tip); its first parent then waits in that same lane, so a line
// of history runs straight down. A parent some lane is already waiting for is
// joined — the edge runs across to that lane — rather than given a second lane
// of its own, which is what `git log --graph` does too and keeps a history of
// long-lived topics half as wide. It also means at most one lane ever waits
// for a commit.
//
// Lanes never move once taken: a lane is freed when the commit it waits for
// is placed, and the lowest free lane is the next one taken. So which lanes are
// occupied entering a row follows from the lanes entering the row above and
// that row's own lane and out-edges alone (advanceLanes), and a reader given
// the lanes entering any one row can draw everything below it.
type laneLayout struct {
	lanes   []string       // the commit each lane waits for; "" for a free lane
	waiting map[string]int // commit → the lane waiting for it
}

func newLaneLayout() *laneLayout {
	return &laneLayout{waiting: map[string]int{}}
}

// place lays out the next commit, returning its lane and the lane each of its
// parents continues in, in parent order.
func (l *laneLayout) place(sha string, parents []string) (lane int, out []int) {
	lane, ok := l.waiting[sha]
	if ok {
		delete(l.waiting, sha)
		l.lanes[lane] = ""
	} else {
		lane = l.free()
	}
	out = make([]int, 0, len(parents))
	for i, p := range parents {
		if j, ok := l.waiting[p]; ok {
			out = append(out, j)
			continue
		}
		j := lane
		if i > 0 || l.lanes[lane] != "" {
			j = l.free()
		}
		l.lanes[j] = p
		l.waiting[p] = j
		out = append(out, j)
	}
	for len(l.lanes) > 0 && l.lanes[len(l.lanes)-1] == "" {
		l.lanes = l.lanes[:len(l.lanes)-1]
	}
	return lane, out
}

// free is the lowest lane waiting for nothing, made if every lane is taken.
func (l *laneLayout) free() int {
	for i, sha := range l.lanes {
		if sha == "" {
			return i
		}
	}
	l.lanes = append(l.lanes, "")
	return len(l.lanes) - 1
}

// occupied is the lanes waiting for a commit, entering the next row, in order.
func (l *laneLayout) occupied() []int {
	occ := []int{}
	for i, sha := range l.lanes {
		if sha != "" {
			occ = append(occ, i)
		}
	}
	return occ
}

// advanceLanes is the lanes occupied entering the row after one placed in lane
// with out-edges out, given those entering it: its own lane ends at its dot,
// and each of its parents' lanes runs on.
func advanceLanes(occ []int, lane int, out []int) []int {
	next := make([]int, 0, len(occ)+len(out))
	for _, i := range occ {
		if i != lane {
			next = append(next, i)
		}
	}
	for _, j := range out {
		if !slices.Contains(next, j) {
			next = append(next, j)
		}
	}
	slices.Sort(next)
	return next
}
