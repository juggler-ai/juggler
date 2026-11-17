//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"juggler/cmd/juggler/gitcmd"
	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/msg"
)

// OpKind is one thing the git client can do to a working tree.
type OpKind string

// The writes of the Changes place.
const (
	OpStage        OpKind = "stage"         // Paths, whole files
	OpUnstage      OpKind = "unstage"       // Paths, whole files
	OpStageAll     OpKind = "stage-all"     // every tracked change
	OpUnstageAll   OpKind = "unstage-all"   // everything staged
	OpStageLines   OpKind = "stage-lines"   // Lines of Path's unstaged diff
	OpUnstageLines OpKind = "unstage-lines" // Lines of Path's staged diff
	OpDiscard      OpKind = "discard"       // Paths' unstaged changes, recoverably
	OpDiscardLines OpKind = "discard-lines" // Lines of Path's unstaged diff, recoverably
	OpUndoDiscard  OpKind = "undo-discard"  // the discard named by Discard
	OpIgnore       OpKind = "ignore"        // Paths[0], by Pattern, into .gitignore
	OpCommit       OpKind = "commit"        // what is staged, or everything with All
	OpUndoCommit   OpKind = "undo-commit"   // HEAD, which must be ExpectHead
)

// The writes of the Refs place. A branch, tag or stash the client saw is named
// with ExpectSha (or, for a stash, by its sha in Stash), and one that has
// moved since is a StaleError.
const (
	OpBranchCreate   OpKind = "branch-create"   // Name at Rev (default HEAD); Switch to it
	OpSwitch         OpKind = "switch"          // to Branch; with Track, a new Branch tracking Rev; with Detach, to Rev. Dirty says what to do with changes in the way
	OpBranchRename   OpKind = "branch-rename"   // Branch to Name
	OpBranchUpstream OpKind = "branch-upstream" // Branch's upstream to Upstream, or none when it is ""
	OpBranchDelete   OpKind = "branch-delete"   // Branch, at ExpectSha; Force for an unmerged one. Result.Sha is its tip
	OpMerge          OpKind = "merge"           // Rev into the current branch; Dirty as for switch
	OpRebase         OpKind = "rebase"          // the current branch onto Rev; Dirty as for switch
	OpFastForward    OpKind = "fast-forward"    // Branch, at ExpectSha, to Rev (default its upstream) without checking it out
	OpRefRestore     OpKind = "ref-restore"     // Ref (a branch or tag) to Sha, only if it does not exist: undoes a delete
	OpStashSave      OpKind = "stash-save"      // the changes, with Message; Untracked too. Result.Stash
	OpStashApply     OpKind = "stash-apply"     // Stash, kept
	OpStashPop       OpKind = "stash-pop"       // Stash, dropped once applied
	OpStashDrop      OpKind = "stash-drop"      // Stash; Result.Stash and Result.Message undo it
	OpStashStore     OpKind = "stash-store"     // Stash back on the list with Message: undoes a drop
	OpStashBranch    OpKind = "stash-branch"    // a new branch Name where Stash was made, with it applied and dropped
	OpTagCreate      OpKind = "tag-create"      // Name at Rev (default HEAD); annotated when Message is set
	OpTagDelete      OpKind = "tag-delete"      // Name, at ExpectSha. Result.Sha is the tag's object
	OpWorktreeLock   OpKind = "worktree-lock"   // Worktree, with Reason
	OpWorktreeUnlock OpKind = "worktree-unlock" // Worktree
	OpWorktreeRemove OpKind = "worktree-remove" // Worktree; Force for a dirty or locked one, whose changes are saved first (Result.Saved)
	OpWorktreePrune  OpKind = "worktree-prune"  // every tree whose directory is gone
)

// The writes of the History place (see history_ops.go): a commit applied to,
// undone on, or made the tip of the current branch.
const (
	OpCherryPick OpKind = "cherry-pick" // Rev onto the current branch (a merge against its first parent); Dirty as for switch
	OpRevert     OpKind = "revert"      // Rev, undone by a new commit (a merge against its first parent); Dirty as for switch
	OpReset      OpKind = "reset"       // the current branch, at ExpectHead, to Rev by Mode. Result.Sha is its old tip; a hard reset saves the changes it throws away first (Result.Saved), and Discard names such a save to put back
)

// The History place's rewrites of the current branch, at ExpectHead (see
// rewrite_ops.go). Result.Sha is its old tip, which a reset back to undoes;
// rewriting a commit a remote has is a PublishedError unless Force.
const (
	OpReword OpKind = "reword" // Rev's message to Message, the commits after it made again unchanged
	OpSquash OpKind = "squash" // the run of commits from Rev to Sha (either way round) into one, with their messages joined
	OpFixup  OpKind = "fixup"  // what is staged into Rev, rebasing what follows; Dirty as for switch
	OpDrop   OpKind = "drop"   // Rev out of the branch, rebasing what follows; Dirty as for switch
)

// The writes of the Operation place (see operation_ops.go): the merge, rebase,
// cherry-pick or revert in progress in the tree, which must be the one the
// client saw (Operation), finished or abandoned.
const (
	OpContinue  OpKind = "operation-continue" // once nothing is unmerged: commit the resolution and go on. Result.Head; Result.Stash names changes set aside that did not go back
	OpSkip      OpKind = "operation-skip"     // drop the commit a rebase, pick or revert stopped on, and go on
	OpAbort     OpKind = "operation-abort"    // back to where it started. Result.Head
	OpQuit      OpKind = "operation-quit"     // a pick or revert forgotten, HEAD, the index and the working tree left as they are. Result.Head
	OpResolve   OpKind = "resolve"            // Path's conflict, by Mode (ResolveOurs, ResolveTheirs, ResolveMarked); Force past conflict markers. Result.Discard is the save of the file, which unresolving names
	OpUnresolve OpKind = "unresolve"          // Path back to conflicted, with the file the resolve named in Discard saved
)

// How OpResolve resolves a conflicted file: with one side's version, or as the
// working tree has it.
const (
	ResolveOurs   = "ours"
	ResolveTheirs = "theirs"
	ResolveMarked = "resolved"
)

// The writes that talk to a remote (see remote_ops.go). Each waits on the
// repository's network lane rather than its write lane, so a slow remote never
// holds up a local write.
const (
	OpFetch              OpKind = "fetch"                // every remote, pruned; Auto for the fetch the client makes unasked
	OpPull               OpKind = "pull"                 // the current branch from its upstream: a fast-forward, or by Mode
	OpPush               OpKind = "push"                 // Branch (default the current one) to its upstream, publishing it to Remote if it has none; Force with a lease on ExpectSha
	OpPushTag            OpKind = "push-tag"             // tag Name to Remote
	OpRemoteBranchDelete OpKind = "remote-branch-delete" // remote-tracking Ref ("origin/feat") from its remote, at ExpectSha. Result.Sha is its tip
	OpSubmoduleUpdate    OpKind = "submodule-update"     // the submodule at Path checked out at the commit Repo records, cloned or fetched as it needs (see submodule_ops.go). Result.Sha and Result.Branch are where its HEAD was
)

// How a pull brings in an upstream it cannot fast-forward to.
const (
	PullMerge  = "merge"
	PullRebase = "rebase"
)

// What a reset keeps: the changes since the target staged (soft), in the
// working tree only (mixed), or nothing (hard); or, moving the files the
// target changes, the local changes to every other (keep).
const (
	ResetSoft  = "soft"
	ResetMixed = "mixed"
	ResetHard  = "hard"
	ResetKeep  = "keep"
)

// What a write does with local changes in its way.
const (
	DirtyCarry = "carry" // leave them; git refuses if it would overwrite them (DirtyError)
	DirtyStash = "stash" // stash them first and, for a merge or rebase, put them back after
)

// How OpIgnore names what it ignores.
const (
	IgnoreFile      = "file"      // the one file
	IgnoreExtension = "extension" // every file with its extension
	IgnoreFolder    = "folder"    // its folder
)

// Op is one write, as the client asks for it. Repo is the repository's path
// within the tree ("" for the tree's own); every path is relative to the
// repository. Which other fields matter is the kind's business.
//
// A lines op names the diff its lines were chosen on: Context and Revision as
// the diff answered them. The diff is read again at that context and a
// different revision refuses the write (StaleError), because the same line
// numbers in another version of the diff are other lines.
type Op struct {
	Kind       OpKind    `json:"kind"`
	Repo       string    `json:"repo"`
	Paths      []string  `json:"paths,omitempty"`
	Path       string    `json:"path,omitempty"`
	Lines      []LineRef `json:"lines,omitempty"`
	Context    string    `json:"context,omitempty"`
	Revision   string    `json:"revision,omitempty"`
	Pattern    string    `json:"pattern,omitempty"`
	Message    string    `json:"message,omitempty"`
	Amend      bool      `json:"amend,omitempty"`
	All        bool      `json:"all,omitempty"`
	ExpectHead string    `json:"expectHead,omitempty"`
	Discard    string    `json:"discard,omitempty"`

	Branch    string `json:"branch,omitempty"`
	Name      string `json:"name,omitempty"`
	Rev       string `json:"rev,omitempty"`
	Upstream  string `json:"upstream,omitempty"`
	Ref       string `json:"ref,omitempty"`
	Sha       string `json:"sha,omitempty"`
	Stash     string `json:"stash,omitempty"`
	Worktree  string `json:"worktree,omitempty"`
	Reason    string `json:"reason,omitempty"`
	ExpectSha string `json:"expectSha,omitempty"`
	Dirty     string `json:"dirty,omitempty"`
	Force     bool   `json:"force,omitempty"`
	Switch    bool   `json:"switch,omitempty"`
	Track     bool   `json:"track,omitempty"`
	Detach    bool   `json:"detach,omitempty"`
	Untracked bool   `json:"untracked,omitempty"`

	Remote string `json:"remote,omitempty"`
	// Mode is how a pull brings in what it can't fast-forward to (PullMerge,
	// PullRebase), what a reset keeps (ResetSoft, ResetMixed, ResetHard,
	// ResetKeep), or how
	// a conflict is resolved (ResolveOurs, ResolveTheirs, ResolveMarked).
	Mode string `json:"mode,omitempty"`
	Auto bool   `json:"auto,omitempty"`

	// Operation is the operation the client saw in progress ("merge",
	// "rebase", "cherry-pick", "revert"); another one in progress is a
	// StaleError.
	Operation string `json:"operation,omitempty"`
}

// Result is what a write leaves the client to know: the commit HEAD names
// after a commit or an undo, and the recovery point a discard made, which is
// what undoing it names. Sha, Stash and Message are what undoing a delete, a
// drop, a stash or a reset needs. Saved is the recovery point a forced worktree
// removal or a hard reset left: what undoing the reset names in Discard, and
// for a removal, which nothing undoes, what the user can still reach. Branch,
// with Sha, is where a submodule update found the submodule's HEAD, which
// switching it back to undoes the update.
type Result struct {
	Head    string `json:"head,omitempty"`
	Discard string `json:"discard,omitempty"`
	Sha     string `json:"sha,omitempty"`
	Stash   string `json:"stash,omitempty"`
	Message string `json:"message,omitempty"`
	Saved   string `json:"saved,omitempty"`
	Branch  string `json:"branch,omitempty"`
}

// Hooks watch a write as it runs. Command is told each git command before it
// runs, for the command log; Output is given what a commit's hooks print as
// they print it; Progress is each reading of a network write's meter, whose
// frames are kept out of Output. Any may be nil.
//
// Env is added to the environment of every command that talks to a remote, and
// of no other: the askpass variables through which its questions reach the
// user (gitaskpass).
type Hooks struct {
	Command  func(args []string)
	Output   func([]byte)
	Progress func(Progress)
	Env      []string
}

// opFuncs is what each kind does, once its repository is held.
var opFuncs = map[OpKind]func(*runner, Op) (Result, error){
	OpStage:        stage,
	OpUnstage:      unstage,
	OpStageAll:     stageAll,
	OpUnstageAll:   unstageAll,
	OpStageLines:   stageLines,
	OpUnstageLines: unstageLines,
	OpDiscard:      discard,
	OpDiscardLines: discardLines,
	OpUndoDiscard:  undoDiscard,
	OpIgnore:       ignore,
	OpCommit:       commit,
	OpUndoCommit:   undoCommit,

	OpBranchCreate:   branchCreate,
	OpSwitch:         switchTo,
	OpBranchRename:   branchRename,
	OpBranchUpstream: branchUpstream,
	OpBranchDelete:   branchDelete,
	OpMerge:          mergeInto,
	OpRebase:         rebaseOnto,
	OpFastForward:    fastForward,
	OpRefRestore:     refRestore,
	OpStashSave:      stashSave,
	OpStashApply:     stashApply,
	OpStashPop:       stashPop,
	OpStashDrop:      stashDrop,
	OpStashStore:     stashStore,
	OpStashBranch:    stashBranch,
	OpTagCreate:      tagCreate,
	OpTagDelete:      tagDelete,
	OpWorktreeLock:   worktreeLock,
	OpWorktreeUnlock: worktreeUnlock,
	OpWorktreeRemove: worktreeRemove,
	OpWorktreePrune:  worktreePrune,

	OpCherryPick: cherryPick,
	OpRevert:     revert,
	OpReset:      reset,

	OpReword: reword,
	OpSquash: squash,
	OpFixup:  fixup,
	OpDrop:   drop,

	OpContinue:  operationContinue,
	OpSkip:      operationSkip,
	OpAbort:     operationAbort,
	OpQuit:      operationQuit,
	OpResolve:   resolve,
	OpUnresolve: unresolve,

	OpFetch:              fetch,
	OpPull:               pull,
	OpPush:               push,
	OpPushTag:            pushTag,
	OpRemoteBranchDelete: remoteBranchDelete,
	OpSubmoduleUpdate:    submoduleUpdate,
}

// netLane is added to a repository's key for the lane its network writes wait
// on (see Run).
const netLane = "\x00net"

// IsNetwork reports whether a kind talks to a remote.
func IsNetwork(kind OpKind) bool {
	switch kind {
	case OpFetch, OpPull, OpPush, OpPushTag, OpRemoteBranchDelete, OpSubmoduleUpdate:
		return true
	}
	return false
}

// Run makes one write to a repository under root, once every write queued
// before it on the same repository has finished (see Queue).
//
// A write that talks to a remote waits on a lane of its own instead — the
// repository's key with netLane added — so one network write runs at a time
// per repository, and none of them holds up a local write for as long as the
// remote takes. Git's own ref locks keep a fetch's ref updates and a local
// write's apart. A pull joins the write lane too, for its merge or rebase.
//
// The repository and every path are validated as a diff's are: a repository
// root does not contain, or a path that leaves it, is a RefusedError. Root may
// be any tree — a linked worktree anywhere on disk included — because this is
// the git client acting for the user; nothing here is reachable by the agent's
// tools.
func Run(ctx context.Context, q *Queue, root string, op Op, hooks Hooks) (Result, error) {
	do, ok := opFuncs[op.Kind]
	if !ok {
		return Result{}, refused(msg.NewError("Unknown git operation: {kind}", "kind", string(op.Kind)))
	}
	dir, err := gitview.ResolveRepo(ctx, root, op.Repo)
	if err != nil {
		return Result{}, refusal(err)
	}
	gitDir, common, err := gitview.GitDirs(ctx, dir)
	if err != nil {
		return Result{}, err
	}
	key := common
	if IsNetwork(op.Kind) {
		key += netLane
	}
	turn, err := q.Wait(ctx, key)
	if err != nil {
		return Result{}, err
	}
	defer turn.Done()
	r := &runner{ctx: ctx, q: q, root: root, dir: dir, gitDir: gitDir, common: common, hooks: hooks}
	return do(r, op)
}

// refusal turns gitview's refusal of a request into this package's.
func refusal(err error) error {
	var request *gitview.RequestError
	var m *msg.Error
	if errors.As(err, &request) && errors.As(request, &m) {
		return &RefusedError{Err: m}
	}
	return err
}

// runner is one write's repository and the way its git commands are run.
type runner struct {
	ctx    context.Context
	q      *Queue
	root   string
	dir    string
	gitDir string
	common string
	hooks  Hooks
}

// call is one git command of a write.
type call struct {
	args   []string
	stdin  []byte
	env    []string
	stream bool // hand its output to Hooks.Output as it comes
	quiet  bool // a question rather than a step: kept out of the command log
	net    bool // talks to a remote: its meter goes to Hooks.Progress (see networkGit)

	noPathspecs bool // see gitcmd.Request.NoPathspecs
}

// run runs one git command. A failure that left the working tree's index.lock
// in place is somebody else's git holding it, and is reported as that.
func (r *runner) run(c call) ([]byte, error) {
	if !c.quiet && r.hooks.Command != nil {
		r.hooks.Command(c.args)
	}
	req := gitcmd.Request{Dir: r.dir, Args: c.args, Stdin: c.stdin, Env: c.env, NoPathspecs: c.noPathspecs}
	var meter *progressSplitter
	switch {
	case c.net:
		meter = newProgressSplitter(r.hooks.Output, r.hooks.Progress)
		req.OnOutput = meter.write
	case c.stream:
		req.OnOutput = r.hooks.Output
	}
	res, err := gitcmd.Exec(r.ctx, req)
	if meter != nil {
		meter.flush()
	}
	if err != nil {
		return res.Stdout, r.explain(err)
	}
	return res.Stdout, nil
}

func (r *runner) git(args ...string) ([]byte, error) { return r.run(call{args: args}) }

// ask runs a question of git and reports whether it said yes (exit status 0)
// and what it printed. Only a git that could not answer is an error.
func (r *runner) ask(args ...string) (string, bool, error) {
	out, err := r.run(call{args: args, quiet: true})
	var failed *gitcmd.Error
	if errors.As(err, &failed) && !failed.Cancelled {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return strings.TrimSpace(string(out)), true, nil
}

func (r *runner) explain(err error) error {
	var failed *gitcmd.Error
	if !errors.As(err, &failed) || failed.Cancelled {
		return err
	}
	lock := filepath.Join(r.gitDir, "index.lock")
	info, statErr := os.Stat(lock)
	if statErr != nil {
		return err
	}
	age := time.Since(info.ModTime()).Round(time.Second)
	return &LockedError{Path: lock, Age: age, Err: msg.NewError(
		"Another git process is using this repository: {lock} exists. If no git is running, delete it and try again.",
		"lock", lock)}
}

// hasHead reports whether the repository has a first commit.
func (r *runner) hasHead() (bool, error) {
	_, ok, err := r.ask("rev-parse", "-q", "--verify", "HEAD")
	return ok, err
}

// files validates the client's paths and returns them repository-relative and
// forward-slashed, as git takes them.
func (r *runner) files(paths []string) ([]string, error) {
	if len(paths) == 0 {
		return nil, refused(msg.NewError("No files were named."))
	}
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		abs, err := gitview.FileInRepo(r.dir, p)
		if err != nil {
			return nil, refusal(err)
		}
		rel, err := filepath.Rel(r.dir, abs)
		if err != nil {
			return nil, err
		}
		out = append(out, filepath.ToSlash(rel))
	}
	return out, nil
}

func stage(r *runner, op Op) (Result, error) {
	paths, err := r.files(op.Paths)
	if err != nil {
		return Result{}, err
	}
	_, err = r.git(append([]string{"add", "-A", "--"}, paths...)...)
	return Result{}, err
}

func unstage(r *runner, op Op) (Result, error) {
	paths, err := r.files(op.Paths)
	if err != nil {
		return Result{}, err
	}
	head, err := r.hasHead()
	if err != nil {
		return Result{}, err
	}
	if head {
		_, err = r.git(append([]string{"restore", "--staged", "--"}, paths...)...)
	} else {
		// Before the first commit there is nothing to restore from: unstaging a
		// file is forgetting it.
		_, err = r.git(append([]string{"rm", "--cached", "-q", "-r", "--"}, paths...)...)
	}
	return Result{}, err
}

func stageAll(r *runner, _ Op) (Result, error) {
	_, err := r.git("add", "-u")
	return Result{}, err
}

func unstageAll(r *runner, _ Op) (Result, error) {
	return Result{}, r.unstageEverything()
}

// unstageEverything empties the index of changes: back to HEAD, or to nothing
// before the first commit.
func (r *runner) unstageEverything() error {
	head, err := r.hasHead()
	if err != nil {
		return err
	}
	if head {
		_, err = r.git("reset", "-q")
	} else {
		_, err = r.git("rm", "--cached", "-q", "-r", "--ignore-unmatch", "--", ".")
	}
	return err
}

func stageLines(r *runner, op Op) (Result, error) {
	return r.applyLines(op, "@unstaged", KeepOld, "--cached")
}

func unstageLines(r *runner, op Op) (Result, error) {
	return r.applyLines(op, "@staged", KeepNew, "--cached", "-R")
}

func discardLines(r *runner, op Op) (Result, error) {
	return r.applyLines(op, "@unstaged", KeepNew, "-R")
}

// applyLines applies the chosen lines of one file's diff in scope, after
// checking the diff is the one they were chosen on. A discard (applied to the
// working tree) first saves the file to the discard ref.
//
// An untracked file has no diff git can apply to until the index knows of it,
// so it is first added with intent to add — an empty entry — and that entry is
// taken out again if the apply fails, leaving the file untracked as it was.
func (r *runner) applyLines(op Op, scope string, keep Keep, applyArgs ...string) (Result, error) {
	paths, err := r.files([]string{op.Path})
	if err != nil {
		return Result{}, err
	}
	path := paths[0]
	discarding := !strings.Contains(strings.Join(applyArgs, " "), "--cached")

	req := gitview.DiffRequest{Repo: op.Repo, Path: path, Context: op.Context, Scope: scope}
	p, err := gitview.ReadPatch(r.ctx, r.root, req)
	if err != nil {
		return Result{}, refusal(err)
	}
	switch {
	case p.Revision != op.Revision || p.Status == "unchanged":
		return Result{}, stale()
	case p.Binary || p.Conflicted:
		return Result{}, refused(msg.NewError("{path} can only be staged or discarded as a whole file.", "path", path))
	case p.Truncated:
		return Result{}, refused(msg.NewError("{path} is too large a change to stage by line.", "path", path))
	}

	raw := p.Raw
	intentToAdd := false
	if p.Status == "untracked" {
		if discarding {
			return Result{}, refused(msg.NewError("{path} is untracked: discard the whole file.", "path", path))
		}
		if _, err := r.git("add", "-N", "--", path); err != nil {
			return Result{}, err
		}
		intentToAdd = true
		added, err := gitview.ReadPatch(r.ctx, r.root, req)
		if err != nil {
			r.forget(path)
			return Result{}, err
		}
		raw = added.Raw
	}

	patch, err := SelectPatch(raw, op.Lines, keep)
	if err != nil {
		if intentToAdd {
			r.forget(path)
		}
		if errors.Is(err, ErrNothingChosen) {
			return Result{}, refused(msg.NewError("No lines were chosen."))
		}
		return Result{}, stale()
	}

	var saved *discardSave
	if discarding {
		if saved, err = r.saveDiscard([]string{path}); err != nil {
			return Result{}, err
		}
	}
	if _, err := r.run(call{args: append(append([]string{"apply"}, applyArgs...), "-"), stdin: patch}); err != nil {
		if intentToAdd {
			r.forget(path)
		}
		return Result{}, err
	}
	if saved == nil {
		return Result{}, nil
	}
	id, err := saved.finish()
	return Result{Discard: id}, err
}

// forget takes an intent-to-add entry back out of the index. It is cleanup
// after a failure already being reported, so its own failure is not.
func (r *runner) forget(path string) {
	_, _ = r.git("rm", "--cached", "-q", "--", path)
}
