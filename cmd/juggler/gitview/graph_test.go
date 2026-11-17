//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"fmt"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
)

// placed is one row of a layout as a test spells it.
type placed struct {
	lane int
	out  []int
}

// history is "sha:parent,parent sha:… …", children before parents.
func history(spec string) (shas []string, parents [][]string) {
	for _, row := range strings.Fields(spec) {
		sha, ps, _ := strings.Cut(row, ":")
		shas = append(shas, sha)
		if ps == "" {
			parents = append(parents, nil)
		} else {
			parents = append(parents, strings.Split(ps, ","))
		}
	}
	return shas, parents
}

// Each commit goes in the lane that was waiting for it, its first parent
// carries on down that lane, and a parent some lane already waits for is
// joined rather than given a second lane.
func TestGraphLayout(t *testing.T) {
	for _, tc := range []struct {
		name string
		spec string
		want []placed
	}{
		{"a line", "c:b b:a a:", []placed{{0, []int{0}}, {0, []int{0}}, {0, []int{}}}},
		// Two tips on one parent: the second joins the lane already waiting
		// and gives its own back.
		{"two tips", "x:b y:b b:a a:", []placed{{0, []int{0}}, {1, []int{0}}, {0, []int{0}}, {0, []int{}}}},
		{"a merge", "m:a,b a:c b:c c:", []placed{{0, []int{0, 1}}, {0, []int{0}}, {1, []int{0}}, {0, []int{}}}},
		{"an octopus", "m:a,b,c a:r b:r c:r r:", []placed{
			{0, []int{0, 1, 2}}, {0, []int{0}}, {1, []int{0}}, {2, []int{0}}, {0, []int{}},
		}},
		// A merge whose first parent is already waiting in lane 0 joins it,
		// and its second parent goes straight down the merge's own lane.
		{"a merge joining", "t:p m:p,q q:p p:", []placed{{0, []int{0}}, {1, []int{0, 1}}, {1, []int{0}}, {0, []int{}}}},
		// Two unrelated histories, the second a root of its own.
		{"two roots", "a:b x: b:", []placed{{0, []int{0}}, {1, []int{}}, {0, []int{}}}},
		// A freed lane is reused by the next tip, the lowest first.
		{"lane reuse", "a:c b:d c: d: e:", []placed{{0, []int{0}}, {1, []int{1}}, {0, []int{}}, {1, []int{}}, {0, []int{}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			shas, parents := history(tc.spec)
			l := newLaneLayout()
			for i, sha := range shas {
				lane, out := l.place(sha, parents[i])
				got := placed{lane, out}
				if got.lane != tc.want[i].lane || !slices.Equal(got.out, tc.want[i].out) {
					t.Errorf("row %d (%s): lane %d out %v, want lane %d out %v", i, sha, got.lane, got.out, tc.want[i].lane, tc.want[i].out)
				}
			}
		})
	}
}

// The lanes entering any row follow from the lanes entering the one before
// and that row's lane and out-edges alone, which is what lets a page carry
// one list of lanes and the client draw every row of it.
func TestGraphOccupancyFollowsFromTheRows(t *testing.T) {
	shas, parents := randomHistory(rand.New(rand.NewPCG(7, 11)), 3000) //nolint:gosec // a reproducible shape, not a secret
	l := newLaneLayout()
	occ := []int{}
	for i, sha := range shas {
		if want := l.occupied(); !slices.Equal(occ, want) {
			t.Fatalf("row %d: occupancy %v from the rows, %v from the layout", i, occ, want)
		}
		lane, out := l.place(sha, parents[i])
		occ = advanceLanes(occ, lane, out)
	}
}

// randomHistory is n commits in a topological order, each with up to three
// parents chosen among the commits after it, and a sprinkling of roots.
func randomHistory(r *rand.Rand, n int) (shas []string, parents [][]string) {
	for i := range n {
		shas = append(shas, fmt.Sprintf("c%d", i))
	}
	for i := range n {
		var ps []string
		if i < n-1 && r.IntN(40) != 0 {
			count := 1
			if r.IntN(6) == 0 {
				count += 1 + r.IntN(2)
			}
			for range count {
				span := min(n-1-i, 60)
				ps = append(ps, shas[i+1+r.IntN(span)])
			}
		}
		parents = append(parents, slices.Compact(ps))
	}
	return shas, parents
}

// BenchmarkGraphLayout lays out a long synthetic history: the pass every
// refresh repeats over everything a session has read.
func BenchmarkGraphLayout(b *testing.B) {
	shas, parents := randomHistory(rand.New(rand.NewPCG(1, 2)), 100_000) //nolint:gosec // a reproducible shape, not a secret
	b.ResetTimer()
	for range b.N {
		l := newLaneLayout()
		for i, sha := range shas {
			l.place(sha, parents[i])
		}
	}
}
