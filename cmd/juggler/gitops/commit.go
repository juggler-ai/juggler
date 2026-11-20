//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"os"
	"path"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/msg"
)

// commit commits what is staged, with the message as written — git's
// whitespace cleanup only, so a line that starts with "#" is kept — and the
// repository's hooks, whose output is streamed as they run — unless NoVerify,
// which skips the pre-commit and commit-msg hooks as `--no-verify` does. A hook
// that refuses leaves everything as it was, the index included.
func commit(r *runner, op Op) (Result, error) {
	if strings.TrimSpace(op.Message) == "" {
		return Result{}, refused(msg.NewError("Write a commit message first."))
	}
	if _, onBranch, err := r.ask("symbolic-ref", "-q", "HEAD"); err != nil {
		return Result{}, err
	} else if !onBranch {
		return Result{}, refused(msg.NewError("HEAD is detached. Make a branch to commit to first."))
	}
	head, err := r.hasHead()
	if err != nil {
		return Result{}, err
	}
	if op.Amend && !head {
		return Result{}, refused(msg.NewError("There is no commit to amend yet."))
	}
	staged, err := r.hasStaged(head)
	if err != nil {
		return Result{}, err
	}
	if !staged && !op.Amend {
		return Result{}, refused(msg.NewError("Nothing is staged."))
	}

	args := []string{"commit", "--cleanup=whitespace", "-F", "-"}
	if op.Amend {
		args = append(args, "--amend")
	}
	if op.NoVerify {
		args = append(args, "--no-verify")
	}
	if _, err := r.run(call{args: args, stdin: []byte(op.Message), stream: true}); err != nil {
		return Result{}, err
	}
	id, _, err := r.ask("rev-parse", "HEAD")
	return Result{Head: id}, err
}

// hasStaged reports whether the index differs from HEAD (or holds anything at
// all, before the first commit).
func (r *runner) hasStaged(head bool) (bool, error) {
	if !head {
		out, _, err := r.ask("ls-files")
		return out != "", err
	}
	_, same, err := r.ask("diff-index", "--cached", "--quiet", "HEAD", "--")
	return !same, err
}

// undoCommit takes the last commit back into the index: `reset --soft HEAD~`,
// or, for the first commit, deleting the branch it began. Only the commit the
// client was shown (ExpectHead), and only while no remote-tracking branch has
// it — a pushed commit undone here would come back with the next pull.
func undoCommit(r *runner, op Op) (Result, error) {
	head, ok, err := r.ask("rev-parse", "-q", "--verify", "HEAD")
	if err != nil {
		return Result{}, err
	}
	if !ok || head != op.ExpectHead {
		return Result{}, refused(msg.NewError("HEAD has moved since that commit, so nothing was undone."))
	}
	pushed, _, err := r.ask("for-each-ref", "--contains", head, "--format=%(refname:short)", "refs/remotes")
	if err != nil {
		return Result{}, err
	}
	if pushed != "" {
		first, _, _ := strings.Cut(pushed, "\n")
		return Result{}, refused(msg.NewError("That commit is already on {remote}, so it can't be undone here.", "remote", first))
	}
	if _, hasParent, err := r.ask("rev-parse", "-q", "--verify", head+"^"); err != nil {
		return Result{}, err
	} else if hasParent {
		if _, err := r.git("reset", "--soft", "HEAD~"); err != nil {
			return Result{}, err
		}
	} else if _, err := r.git("update-ref", "-d", "HEAD", head); err != nil {
		return Result{}, err
	}
	now, _, err := r.ask("rev-parse", "-q", "--verify", "HEAD")
	return Result{Head: now}, err
}

// ignore adds one untracked file to the repository's own .gitignore: the file
// itself, every file with its extension, or its folder. Patterns are anchored
// at the repository's root and escaped, so a name with `*` or `[` in it ignores
// that name and nothing else.
func ignore(r *runner, op Op) (Result, error) {
	paths, err := r.files(op.Paths)
	if err != nil {
		return Result{}, err
	}
	rel := paths[0]
	if _, tracked, err := r.ask("ls-files", "--error-unmatch", "--", rel); err != nil {
		return Result{}, err
	} else if tracked {
		return Result{}, refused(msg.NewError("{path} is tracked, and .gitignore only hides untracked files.", "path", rel))
	}

	var pattern string
	switch op.Pattern {
	case IgnoreFile:
		pattern = "/" + escapeIgnore(rel)
	case IgnoreExtension:
		ext := path.Ext(path.Base(rel))
		if ext == "" || ext == path.Base(rel) {
			return Result{}, refused(msg.NewError("{path} has no extension.", "path", rel))
		}
		pattern = "*" + escapeIgnore(ext)
	case IgnoreFolder:
		folder := path.Dir(rel)
		if folder == "." {
			return Result{}, refused(msg.NewError("{path} is not in a folder.", "path", rel))
		}
		pattern = "/" + escapeIgnore(folder) + "/"
	default:
		return Result{}, refused(msg.NewError("Unknown ignore pattern: {pattern}", "pattern", op.Pattern))
	}

	file := filepath.Join(r.dir, ".gitignore")
	existing, err := os.ReadFile(file) //nolint:gosec // the repository's own .gitignore
	if err != nil && !os.IsNotExist(err) {
		return Result{}, err
	}
	line := pattern + "\n"
	if len(existing) > 0 && existing[len(existing)-1] != '\n' {
		line = "\n" + line
	}
	if r.hooks.Command != nil {
		r.hooks.Command([]string{"echo", pattern, ">>", ".gitignore"})
	}
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644) //nolint:gosec // a .gitignore is meant to be read by everyone
	if err != nil {
		return Result{}, err
	}
	if _, err := f.WriteString(line); err != nil {
		_ = f.Close()
		return Result{}, err
	}
	return Result{}, f.Close()
}

// escapeIgnore makes a path a literal .gitignore pattern: the glob characters
// and the backslash escaped, a leading "#" or "!" escaped, and trailing spaces
// escaped, which git would otherwise trim.
func escapeIgnore(p string) string {
	var b strings.Builder
	for i, c := range p {
		switch {
		case strings.ContainsRune(`\*?[]`, c):
			b.WriteByte('\\')
		case i == 0 && (c == '#' || c == '!'):
			b.WriteByte('\\')
		}
		b.WriteRune(c)
	}
	out := b.String()
	trimmed := strings.TrimRight(out, " ")
	return trimmed + strings.Repeat(`\ `, len(out)-len(trimmed))
}
