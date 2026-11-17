//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"strconv"
	"strings"
	"testing"
)

func TestParseProgress(t *testing.T) {
	t.Parallel()
	cases := []struct {
		line string
		want Progress
		ok   bool
	}{
		{"Counting objects:  45% (136/302)", Progress{Phase: "Counting objects", Percent: 45, Done: 136, Total: 302}, true},
		{"Counting objects: 100% (302/302), done.", Progress{Phase: "Counting objects", Percent: 100, Done: 302, Total: 302, Finished: true}, true},
		{"Receiving objects:  45% (450/1000), 1.20 MiB | 2.00 MiB/s", Progress{Phase: "Receiving objects", Percent: 45, Done: 450, Total: 1000, Rate: "2.00 MiB/s"}, true},
		{"Writing objects: 100% (302/302), 607.10 KiB | 23.35 MiB/s, done.", Progress{Phase: "Writing objects", Percent: 100, Done: 302, Total: 302, Rate: "23.35 MiB/s", Finished: true}, true},
		{"remote: Enumerating objects: 5, done.", Progress{Phase: "Enumerating objects", Remote: true, Percent: -1, Done: 5, Finished: true}, true},
		{"remote: Compressing objects:  50% (1/2)", Progress{Phase: "Compressing objects", Remote: true, Percent: 50, Done: 1, Total: 2}, true},
		{"Enumerating objects: 302, done.", Progress{Phase: "Enumerating objects", Percent: -1, Done: 302, Finished: true}, true},
		{"Delta compression using up to 10 threads", Progress{}, false},
		{"Total 302 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)", Progress{}, false},
		{"!\tHEAD:refs/heads/main\t[rejected] (non-fast-forward)", Progress{}, false},
		{"error: failed to push some refs to '/tmp/o.git'", Progress{}, false},
	}
	for _, c := range cases {
		got, ok := ParseProgress(c.line)
		if ok != c.ok || got != c.want {
			t.Errorf("ParseProgress(%q) = %+v, %v; want %+v, %v", c.line, got, ok, c.want, c.ok)
		}
	}
}

// A push's stderr, as git wrote it: frames ended by a carriage return redraw
// one line in a terminal, and only the line a newline ends is what stays on
// screen. Whatever the chunking, every frame is reported as progress, and only
// newline-ended lines reach the output.
func TestProgressSplitterKeepsFramesOutOfOutput(t *testing.T) {
	t.Parallel()
	stderr := "Enumerating objects: 302, done.\n" +
		"Counting objects:   0% (1/302)\rCounting objects:  50% (151/302)\rCounting objects: 100% (302/302)\rCounting objects: 100% (302/302), done.\n" +
		"Delta compression using up to 10 threads\n" +
		"Writing objects:  10% (31/302)\rWriting objects: 100% (302/302), 607.10 KiB | 23.35 MiB/s, done.\n" +
		"Total 302 (delta 0), reused 0 (delta 0)\n" +
		"remote: Resolving deltas:  50% (1/2)\rremote: Resolving deltas: 100% (2/2), done.\n" +
		"no newline at the end"
	wantOutput := "Enumerating objects: 302, done.\n" +
		"Counting objects: 100% (302/302), done.\n" +
		"Delta compression using up to 10 threads\n" +
		"Writing objects: 100% (302/302), 607.10 KiB | 23.35 MiB/s, done.\n" +
		"Total 302 (delta 0), reused 0 (delta 0)\n" +
		"remote: Resolving deltas: 100% (2/2), done.\n" +
		"no newline at the end"
	wantPhases := "Enumerating objects -1,Counting objects 0,Counting objects 50,Counting objects 100,Counting objects 100," +
		"Writing objects 10,Writing objects 100,Resolving deltas 50,Resolving deltas 100"

	for _, size := range []int{1, 3, 7, 64, len(stderr)} {
		var output strings.Builder
		var phases []string
		s := newProgressSplitter(func(b []byte) { output.Write(b) }, func(p Progress) {
			phases = append(phases, p.Phase+" "+strconv.Itoa(p.Percent))
		})
		for i := 0; i < len(stderr); i += size {
			s.write([]byte(stderr[i:min(i+size, len(stderr))]))
		}
		s.flush()
		if output.String() != wantOutput {
			t.Errorf("chunks of %d: output =\n%q\nwant\n%q", size, output.String(), wantOutput)
		}
		if got := strings.Join(phases, ","); got != wantPhases {
			t.Errorf("chunks of %d: progress = %s\nwant %s", size, got, wantPhases)
		}
	}
}
