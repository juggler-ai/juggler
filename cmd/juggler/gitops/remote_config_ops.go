//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"slices"
	"strings"

	"juggler/cmd/juggler/msg"
)

// The writes that change which remotes a repository has and where they are.
// None talks to a remote: they edit the repository's config (and, for a
// rename or removal, its remote-tracking refs), so they run on the write lane.

// remoteName refuses a name git would not take for a remote: one whose
// remote-tracking refs would not be valid refs, as git's own check has it.
func (r *runner) remoteName(name string) error {
	if name == "" || strings.HasPrefix(name, "-") {
		return refused(msg.NewError("{name} is not a name git allows for a remote.", "name", name))
	}
	if _, ok, err := r.ask("check-ref-format", "refs/remotes/"+name+"/test"); err != nil || !ok {
		if err != nil {
			return err
		}
		return refused(msg.NewError("{name} is not a name git allows for a remote.", "name", name))
	}
	return nil
}

// remoteURL refuses a URL that is empty or could be read as an option or as
// more than one line of config.
func remoteURL(url string) error {
	if strings.TrimSpace(url) == "" || strings.HasPrefix(url, "-") || strings.ContainsAny(url, "\n\r\x00") {
		return refused(msg.NewError("{url} is not a URL a remote can have.", "url", url))
	}
	return nil
}

// existingRemote refuses a name that is not one of the repository's remotes.
func (r *runner) existingRemote(name string) error {
	all, err := r.remotes()
	if err != nil {
		return err
	}
	if !slices.Contains(all, name) {
		return refused(msg.NewError("{remote} is not a remote of this repository.", "remote", name))
	}
	return nil
}

// newRemote refuses a name that is not a valid one for a remote, or is taken.
func (r *runner) newRemote(name string) error {
	if err := r.remoteName(name); err != nil {
		return err
	}
	all, err := r.remotes()
	if err != nil {
		return err
	}
	if slices.Contains(all, name) {
		return refused(msg.NewError("There is already a remote called {name}.", "name", name))
	}
	return nil
}

func remoteAdd(r *runner, op Op) (Result, error) {
	if err := r.newRemote(op.Name); err != nil {
		return Result{}, err
	}
	if err := remoteURL(op.URL); err != nil {
		return Result{}, err
	}
	_, err := r.git("remote", "add", "--", op.Name, op.URL)
	return Result{}, err
}

// remoteRemove removes a remote. git takes its remote-tracking branches with
// it, and unsets the upstream of every branch that tracked one of them.
func remoteRemove(r *runner, op Op) (Result, error) {
	if err := r.existingRemote(op.Remote); err != nil {
		return Result{}, err
	}
	_, err := r.git("remote", "remove", "--", op.Remote)
	return Result{}, err
}

// remoteRename renames a remote. git moves its remote-tracking branches, and
// the upstreams set to them, along with it.
func remoteRename(r *runner, op Op) (Result, error) {
	if err := r.existingRemote(op.Remote); err != nil {
		return Result{}, err
	}
	if err := r.newRemote(op.Name); err != nil {
		return Result{}, err
	}
	_, err := r.git("remote", "rename", "--", op.Remote, op.Name)
	return Result{}, err
}

func remoteSetURL(r *runner, op Op) (Result, error) {
	if err := r.existingRemote(op.Remote); err != nil {
		return Result{}, err
	}
	if err := remoteURL(op.URL); err != nil {
		return Result{}, err
	}
	_, err := r.git("remote", "set-url", "--", op.Remote, op.URL)
	return Result{}, err
}
