//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const header = "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n"

// a b c d → a B c D, one hunk.
const twoChanges = header + "@@ -1,4 +1,4 @@ head\n a\n-b\n+B\n c\n-d\n+D\n"

// headerOut is header without its index line, which a partial patch's blob
// ids no longer describe.
const headerOut = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n"

func TestSelectPatch(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		raw    string
		picked []LineRef
		keep   Keep
		want   string
	}{
		{
			name:   "stage one change of two",
			raw:    twoChanges,
			picked: []LineRef{{Old: 2}, {New: 2}},
			keep:   KeepOld,
			want:   headerOut + "@@ -1,4 +1,4 @@ head\n a\n-b\n+B\n c\n d\n",
		},
		{
			name:   "stage an addition without its removal",
			raw:    twoChanges,
			picked: []LineRef{{New: 4}},
			keep:   KeepOld,
			want:   headerOut + "@@ -1,4 +1,5 @@ head\n a\n b\n c\n d\n+D\n",
		},
		{
			name:   "unstage a removal: the new side is kept whole",
			raw:    twoChanges,
			picked: []LineRef{{Old: 2}},
			keep:   KeepNew,
			want:   headerOut + "@@ -1,5 +1,4 @@ head\n a\n-b\n B\n c\n D\n",
		},
		{
			name: "a hunk with nothing chosen is dropped and the next is renumbered",
			raw: header +
				"@@ -1,3 +1,4 @@\n a\n+x\n b\n c\n" +
				"@@ -10,3 +11,3 @@\n j\n-k\n+K\n l\n",
			picked: []LineRef{{Old: 11}, {New: 12}},
			keep:   KeepOld,
			want:   headerOut + "@@ -10,3 +10,3 @@\n j\n-k\n+K\n l\n",
		},
		{
			name: "a later hunk follows the delta of an earlier chosen one",
			raw: header +
				"@@ -1,3 +1,4 @@\n a\n+x\n b\n c\n" +
				"@@ -10,3 +11,3 @@\n j\n-k\n+K\n l\n",
			picked: []LineRef{{New: 2}, {Old: 11}, {New: 12}},
			keep:   KeepOld,
			want: headerOut +
				"@@ -1,3 +1,4 @@\n a\n+x\n b\n c\n" +
				"@@ -10,3 +11,3 @@\n j\n-k\n+K\n l\n",
		},
		{
			name:   "part of a new file",
			raw:    "diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..de98044\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n",
			picked: []LineRef{{New: 1}, {New: 3}},
			keep:   KeepOld,
			want:   "diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+c\n",
		},
		{
			name:   "a removed last line keeps its no-newline marker",
			raw:    header + "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n",
			picked: []LineRef{{Old: 2}},
			keep:   KeepOld,
			want:   headerOut + "@@ -1,2 +1,1 @@\n a\n-b\n\\ No newline at end of file\n",
		},
		{
			name:   "a dropped line takes its marker with it",
			raw:    header + "@@ -1,2 +1,2 @@\n a\n-b\n+B\n\\ No newline at end of file\n",
			picked: []LineRef{{Old: 2}},
			keep:   KeepOld,
			want:   headerOut + "@@ -1,2 +1,1 @@\n a\n-b\n",
		},
		{
			name:   "carriage returns are content",
			raw:    header + "@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r\n",
			picked: []LineRef{{Old: 2}, {New: 2}},
			keep:   KeepOld,
			want:   headerOut + "@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r\n",
		},
		{
			name: "a rename's header is kept",
			raw: "diff --git a/old.txt b/new.txt\nsimilarity index 80%\nrename from old.txt\nrename to new.txt\nindex 1111111..2222222 100644\n--- a/old.txt\n+++ b/new.txt\n" +
				"@@ -1,2 +1,2 @@\n a\n-b\n+B\n",
			picked: []LineRef{{Old: 2}, {New: 2}},
			keep:   KeepOld,
			want: "diff --git a/old.txt b/new.txt\nsimilarity index 80%\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n" +
				"@@ -1,2 +1,2 @@\n a\n-b\n+B\n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := SelectPatch([]byte(tc.raw), tc.picked, tc.keep)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.want {
				t.Errorf("got\n%s\nwant\n%s", got, tc.want)
			}
		})
	}
}

func TestSelectPatchRefuses(t *testing.T) {
	t.Parallel()
	if _, err := SelectPatch([]byte(twoChanges), nil, KeepOld); !errors.Is(err, ErrNothingChosen) {
		t.Errorf("nothing chosen: %v", err)
	}
	// Line 1 is context on both sides: there is nothing to stage in it.
	if _, err := SelectPatch([]byte(twoChanges), []LineRef{{Old: 1, New: 1}}, KeepOld); !errors.Is(err, ErrNoSuchLine) {
		t.Errorf("a context line: %v", err)
	}
	if _, err := SelectPatch([]byte(twoChanges), []LineRef{{New: 2}, {New: 40}}, KeepOld); !errors.Is(err, ErrNoSuchLine) {
		t.Errorf("a line the diff does not hold: %v", err)
	}
}

// What SelectPatch builds is what git applies: stage a line, unstage it, and
// discard one from the working tree, each on a real repository.
func TestSelectPatchApplies(t *testing.T) {
	t.Parallel()
	r := newRepo(t)
	r.write("f.txt", "a\nb\nc\nd\n")
	r.commit("init")
	r.write("f.txt", "a\nB\nc\nD\n")

	apply := func(patch []byte, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"apply"}, args...)...)
		cmd.Dir = r.dir
		cmd.Stdin = strings.NewReader(string(patch))
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git apply %v: %v\n%s\n%s", args, err, out, patch)
		}
	}
	build := func(raw string, keep Keep, picked ...LineRef) []byte {
		t.Helper()
		patch, err := SelectPatch([]byte(raw), picked, keep)
		if err != nil {
			t.Fatal(err)
		}
		return patch
	}

	// Stage b → B alone.
	apply(build(r.git("diff"), KeepOld, LineRef{Old: 2}, LineRef{New: 2}), "--cached")
	if staged := r.git("show", ":f.txt"); staged != "a\nB\nc\nd\n" {
		t.Fatalf("index after staging one line = %q", staged)
	}

	// Unstage it again.
	apply(build(r.git("diff", "--cached"), KeepNew, LineRef{Old: 2}, LineRef{New: 2}), "--cached", "-R")
	if staged := r.git("show", ":f.txt"); staged != "a\nb\nc\nd\n" {
		t.Fatalf("index after unstaging = %q", staged)
	}

	// Discard d → D from the working tree, keeping b → B.
	apply(build(r.git("diff"), KeepNew, LineRef{Old: 4}, LineRef{New: 4}), "-R")
	got, err := os.ReadFile(filepath.Join(r.dir, "f.txt")) //nolint:gosec // the test's own repository
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "a\nB\nc\nd\n" {
		t.Errorf("working tree after discarding one change = %q", got)
	}
}
