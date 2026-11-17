//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"bytes"
	"errors"
	"fmt"
	"regexp"
	"strconv"
)

// ErrNothingChosen is a selection with no lines in it.
var ErrNothingChosen = errors.New("no lines were chosen")

// ErrNoSuchLine is a chosen line the diff does not hold as a change: a context
// line, or a line of some other version of the diff.
var ErrNoSuchLine = errors.New("a chosen line is not a change in this diff")

// LineRef names one changed line by its number on the one side it exists on: a
// removed line by Old, an added line by New. Line numbers name a line however
// the diff was cut into hunks, which is why a selection is made of them rather
// than of hunk and line indices — a viewer that shows the diff at a narrower
// context regroups its hunks, and an index into those would point at the wrong
// line of the patch the server reads.
type LineRef struct {
	Old int `json:"old,omitempty"`
	New int `json:"new,omitempty"`
}

// Keep is which side of the diff a partial patch leaves exactly as it is.
type Keep int

const (
	// KeepOld builds a patch whose old side is the diff's old side, to be
	// applied forwards: staging chosen lines of the working tree's changes.
	// A removal not chosen stays as context; an addition not chosen is left
	// out.
	KeepOld Keep = iota

	// KeepNew builds a patch whose new side is the diff's new side, to be
	// applied in reverse: unstaging chosen lines, or discarding them from the
	// working tree. An addition not chosen stays as context; a removal not
	// chosen is left out.
	KeepNew
)

// hunkHeader reads an `@@ -a,b +c,d @@ heading` line. The counts are not
// needed: they are counted again from what is kept.
var hunkHeader = regexp.MustCompile(`^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$`)

// SelectPatch builds, from one file's patch as git wrote it, the patch that
// makes only the chosen lines' changes. It is how a hunk is staged too: a hunk
// is the set of its changed lines.
//
// The file's header is kept but for its index line, whose blob ids describe
// the whole change and not this part of it. A hunk with nothing chosen is
// left out, and every hunk kept is renumbered by what the ones before it now
// add and remove, so a later hunk lands where it belongs. Every byte of a kept
// line is kept, a carriage return included, and so is the "\ No newline at end
// of file" marker of a kept line — the marker goes with the line it follows.
//
// Every chosen line must be a change in raw; one that is not means the
// selection was made on another version of the diff, and nothing is built.
func SelectPatch(raw []byte, picked []LineRef, keep Keep) ([]byte, error) {
	if len(picked) == 0 {
		return nil, ErrNothingChosen
	}
	want := make(map[LineRef]bool, len(picked))
	for _, p := range picked {
		if (p.Old == 0) == (p.New == 0) {
			return nil, ErrNoSuchLine
		}
		want[p] = true
	}

	lines := bytes.Split(raw, []byte("\n"))
	if n := len(lines); n > 0 && len(lines[n-1]) == 0 {
		lines = lines[:n-1]
	}

	var out bytes.Buffer
	i := 0
	for ; i < len(lines) && !bytes.HasPrefix(lines[i], []byte("@@")); i++ {
		if bytes.HasPrefix(lines[i], []byte("index ")) {
			continue
		}
		out.Write(lines[i])
		out.WriteByte('\n')
	}

	found := map[LineRef]bool{}
	delta := 0 // what the hunks kept so far add, less what they remove
	for i < len(lines) {
		m := hunkHeader.FindSubmatch(lines[i])
		if m == nil {
			return nil, fmt.Errorf("not a hunk header: %q", lines[i])
		}
		i++
		oldStart, _ := strconv.Atoi(string(m[1]))
		newStart, _ := strconv.Atoi(string(m[2]))
		heading := m[3]

		var body bytes.Buffer
		oldNo, newNo := oldStart, newStart
		oldCount, newCount := 0, 0
		changed := false
		lastKept := false
		emit := func(prefix byte, text []byte) {
			body.WriteByte(prefix)
			body.Write(text)
			body.WriteByte('\n')
			lastKept = true
		}
		for ; i < len(lines) && !bytes.HasPrefix(lines[i], []byte("@@")); i++ {
			line := lines[i]
			if len(line) == 0 {
				continue
			}
			text := line[1:]
			switch line[0] {
			case ' ':
				emit(' ', text)
				oldCount++
				newCount++
				oldNo++
				newNo++
			case '-':
				ref := LineRef{Old: oldNo}
				oldNo++
				switch {
				case want[ref]:
					found[ref] = true
					changed = true
					emit('-', text)
					oldCount++
				case keep == KeepOld:
					emit(' ', text)
					oldCount++
					newCount++
				default:
					lastKept = false
				}
			case '+':
				ref := LineRef{New: newNo}
				newNo++
				switch {
				case want[ref]:
					found[ref] = true
					changed = true
					emit('+', text)
					newCount++
				case keep == KeepNew:
					emit(' ', text)
					oldCount++
					newCount++
				default:
					lastKept = false
				}
			case '\\':
				if lastKept {
					body.Write(line)
					body.WriteByte('\n')
				}
			}
		}
		if !changed {
			continue
		}

		if keep == KeepOld {
			newStart = startOf(oldStart, oldCount, newCount, delta)
		} else {
			oldStart = startOf(newStart, newCount, oldCount, -delta)
		}
		delta += newCount - oldCount
		fmt.Fprintf(&out, "@@ -%d,%d +%d,%d @@%s\n", oldStart, oldCount, newStart, newCount, heading)
		out.Write(body.Bytes())
	}

	if len(found) != len(want) {
		return nil, ErrNoSuchLine
	}
	return out.Bytes(), nil
}

// startOf is where a hunk begins on the side being renumbered, from where it
// begins on the side kept as it is. shift is how far the earlier kept hunks
// have moved the renumbered side. A side with no lines in the hunk names the
// line before it, as unified diffs do, so an empty side is one short and an
// insertion into an empty base one long.
func startOf(base, baseCount, otherCount, shift int) int {
	switch {
	case baseCount == 0:
		return base + shift + 1
	case otherCount == 0:
		return base + shift - 1
	default:
		return base + shift
	}
}
