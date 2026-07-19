//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
)

// Per-conversation, per-repository git worktree isolation (t3code-style).
//
// A single Juggler process opens one project, but hosts many conversations
// (side-tabs), and the engine is a single, engine-wide tool executor shared by
// all of them. Left alone, two tabs each running an agent edit the same working
// tree and clobber each other. ConvWorktrees gives every conversation its own
// dedicated git worktree — and, because one conversation may touch more than one
// repository (a folder of service repos, a repo with nested submodules), it
// keys worktrees by (conversation, repository): each repo a conversation touches
// gets its own worktree.
//
// The mechanism is a path remap. Callers validate a path in real-project space
// (the security boundary is unchanged) and then ask Remap to translate it: the
// repository the path belongs to is resolved, its (conversation, repo) worktree
// is created on first use, and the path is rewritten into that worktree. Paths
// outside any repo under the project (loose files) are returned unchanged, so
// non-git content stays shared and existing behaviour is preserved.
//
// ConvWorktrees is a channel-based actor (the repo lint forbids sync.Mutex): all
// map access and the "does a worktree exist? if not, create it" check-then-act
// run on one goroutine, so concurrent ops for one (conversation, repo) never
// trigger two `git worktree add`s.
type ConvWorktrees struct {
	reqCh      chan cwReq
	quitCh     chan struct{}
	base       string // real project root (absolute)
	home       string // worktrees home (…/worktrees)
	enabled    bool
	primaryTop string // gitToplevel(base) or "" — the project's own repo (may sit above base)
}

type cwReqKind int

const (
	cwRemap    cwReqKind = iota // translate a real path into its (conv,repo) worktree
	cwRepoRoot                  // worktree path for an explicit (conv, repoTop) — for git status
	cwRelease                   // conversation deleted — prune all its worktrees
	cwList                      // snapshot of a conversation's repoTop → worktree
)

type cwReq struct {
	kind      cwReqKind
	convID    string
	path      string // cwRemap: the real absolute path; cwRepoRoot: the repo toplevel
	permanent bool
	resp      chan cwResp
}

type cwResp struct {
	path string
	list map[string]string
}

// NewConvWorktrees builds the registry for a base project. When enabled is false
// every Remap is the identity, so callers need no special-casing. The actor
// goroutine runs until Close.
func NewConvWorktrees(base, worktreesHome string, enabled bool) *ConvWorktrees {
	c := &ConvWorktrees{
		reqCh:   make(chan cwReq),
		quitCh:  make(chan struct{}),
		base:    filepath.Clean(base),
		home:    worktreesHome,
		enabled: enabled,
	}
	if enabled && base != "" {
		if top, err := gitToplevel(base); err == nil {
			if abs, aerr := filepath.Abs(top); aerr == nil {
				top = abs
			}
			// Never nest a worktree inside a worktree.
			if linked, _ := isLinkedWorktree(top); !linked {
				c.primaryTop = filepath.Clean(top)
			}
		}
	}
	go c.run()
	return c
}

// Remap translates a real, already-validated absolute path into the working
// path the op should touch: the conversation's dedicated worktree of whichever
// repository the path belongs to, or the path unchanged when isolation does not
// apply (disabled, empty convID, or the path is in no eligible repo under the
// project). Creates the worktree on first use.
func (c *ConvWorktrees) Remap(convID, absPath string) string {
	if !c.enabled || convID == "" || absPath == "" {
		return absPath
	}
	r := c.ask(cwReq{kind: cwRemap, convID: convID, path: absPath})
	if r.path == "" {
		return absPath
	}
	return r.path
}

// WorktreeForRepo returns the conversation's worktree for an explicit repository
// toplevel (used by the git-status card to scan each discovered repo in the
// conversation's checkout), or "" when isolation doesn't apply to it.
func (c *ConvWorktrees) WorktreeForRepo(convID, repoTop string) string {
	if !c.enabled || convID == "" || repoTop == "" {
		return ""
	}
	return c.ask(cwReq{kind: cwRepoRoot, convID: convID, path: filepath.Clean(repoTop)}).path
}

// Release prunes all of a deleted conversation's worktrees. On a permanent
// delete each is removed only if pristine (no uncommitted changes, no unmerged
// commits); a bin (soft delete) keeps them so a restore can reuse them.
func (c *ConvWorktrees) Release(convID string, permanent bool) {
	if !c.enabled || convID == "" {
		return
	}
	c.ask(cwReq{kind: cwRelease, convID: convID, permanent: permanent})
}

// Tracked returns a snapshot of repoTop → worktree for a conversation
// (diagnostics / tests).
func (c *ConvWorktrees) Tracked(convID string) map[string]string {
	if !c.enabled {
		return map[string]string{}
	}
	return c.ask(cwReq{kind: cwList, convID: convID}).list
}

// Close stops the actor goroutine. Worktrees are left on disk (never auto-deleted
// on shutdown); each is re-adopted by (conversation, repo) on the next launch.
func (c *ConvWorktrees) Close() {
	select {
	case <-c.quitCh:
	default:
		close(c.quitCh)
	}
}

func (c *ConvWorktrees) ask(r cwReq) cwResp {
	r.resp = make(chan cwResp, 1)
	select {
	case c.reqCh <- r:
		return <-r.resp
	case <-c.quitCh:
		return cwResp{list: map[string]string{}}
	}
}

func (c *ConvWorktrees) run() {
	plans := map[string]*WorktreePlan{} // key: convID\x00repoTop → worktree
	ineligible := map[string]bool{}     // repoTop → known not a usable repo
	repoCache := map[string]string{}    // dir → repoTop ("" = none), memoises detection
	for {
		select {
		case <-c.quitCh:
			return
		case r := <-c.reqCh:
			switch r.kind {
			case cwRemap:
				r.resp <- cwResp{path: c.remap(plans, ineligible, repoCache, r.convID, r.path)}
			case cwRepoRoot:
				plan := c.ensure(plans, ineligible, r.convID, r.path)
				if plan == nil {
					r.resp <- cwResp{}
				} else {
					r.resp <- cwResp{path: plan.Path}
				}
			case cwRelease:
				c.release(plans, r.convID, r.permanent)
				r.resp <- cwResp{}
			case cwList:
				out := map[string]string{}
				prefix := r.convID + "\x00"
				for key, p := range plans {
					if strings.HasPrefix(key, prefix) {
						out[strings.TrimPrefix(key, prefix)] = p.Path
					}
				}
				r.resp <- cwResp{list: out}
			}
		}
	}
}

// remap resolves absPath's repository and rewrites the path into that
// conversation's worktree of it. Falls back to absPath unchanged on any miss.
func (c *ConvWorktrees) remap(plans map[string]*WorktreePlan, ineligible map[string]bool, repoCache map[string]string, convID, absPath string) string {
	absPath = filepath.Clean(absPath)
	dir := absPath // memoise by directory; a dir's repo is stable
	repoTop, ok := repoCache[dir]
	if !ok {
		repoTop = repoRootWithin(absPath, c.base, c.primaryTop)
		repoCache[dir] = repoTop
	}
	if repoTop == "" {
		return absPath
	}
	plan := c.ensure(plans, ineligible, convID, repoTop)
	if plan == nil {
		return absPath
	}
	rel, err := filepath.Rel(repoTop, absPath)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return absPath
	}
	if rel == "." {
		return plan.Path
	}
	return filepath.Join(plan.Path, rel)
}

// ensure returns the conversation's worktree for repoTop, creating (or adopting)
// it on first use. Returns nil when repoTop is not a usable git repo (no commit,
// or a linked worktree) or creation fails; the result is memoised either way.
func (c *ConvWorktrees) ensure(plans map[string]*WorktreePlan, ineligible map[string]bool, convID, repoTop string) *WorktreePlan {
	key := convID + "\x00" + repoTop
	if p, ok := plans[key]; ok {
		return p
	}
	if ineligible[repoTop] {
		return nil
	}
	// A worktree must branch from an existing commit, and we never nest.
	if _, err := runGit(repoTop, "rev-parse", "--verify", "-q", "HEAD"); err != nil {
		ineligible[repoTop] = true
		return nil
	}
	if linked, err := isLinkedWorktree(repoTop); err != nil || linked {
		ineligible[repoTop] = true
		return nil
	}
	baseBranch, _ := runGit(repoTop, "rev-parse", "--abbrev-ref", "HEAD")

	group := filepath.Join(c.home, worktreeGroupName(repoTop))
	name := convSlot(convID)
	dir := filepath.Join(group, name)
	branch := "juggler/" + name

	var plan *WorktreePlan
	if isRegisteredWorktree(repoTop, dir) {
		b, _ := runGit(dir, "rev-parse", "--abbrev-ref", "HEAD")
		plan = &WorktreePlan{Path: dir, Branch: b, BaseRepo: repoTop, BaseBranch: baseBranch, Adopted: true}
	} else if err := createWorktree(repoTop, dir, branch); err != nil {
		return nil // transient failure — not memoised as ineligible, so we retry
	} else {
		plan = &WorktreePlan{Path: dir, Branch: branch, BaseRepo: repoTop, BaseBranch: baseBranch, Adopted: false}
	}
	plans[key] = plan
	return plan
}

func (c *ConvWorktrees) release(plans map[string]*WorktreePlan, convID string, permanent bool) {
	if !permanent {
		return // a soft delete (bin) keeps every worktree for a possible restore
	}
	prefix := convID + "\x00"
	for key, p := range plans {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		if pruned, _ := PruneWorktreeIfPristine(p); pruned {
			delete(plans, key)
		}
	}
}

// convSlot is the deterministic, filesystem-/ref-safe worktree name a
// conversation maps to within each repository group. Stable across restarts (so
// worktrees are adopted, not duplicated) and unique per conversation id.
func convSlot(convID string) string {
	sum := sha256.Sum256([]byte(convID))
	h := hex.EncodeToString(sum[:])[:12]
	slug := sanitizeName(convID)
	if len(slug) > 24 {
		slug = slug[:24]
	}
	return fmt.Sprintf("conv-%s-%s", slug, h)
}
