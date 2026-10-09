//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { validateManifest } from './lib/manifest.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Pinboard-item manifest — static metadata that describes a pinboard-item plugin.
 * Define this as a static MANIFEST property on your item class.
 * @typedef {object} PinboardItemManifest
 * @property {string} id - Unique item-type identifier (kebab-case, e.g. 'file')
 * @property {string} name - Human-readable display name (shown in the catalog and the add picker)
 * @property {string} version - Semantic version (e.g. '1.0.0')
 * @property {string} description - Help text shown in the extensions catalog and the add picker
 * @property {'single'|'multiple'} [instances] - Whether the board may hold more than
 *   one pin of this type. 'single' (the default) makes the type a singleton: the host
 *   reveals the existing pin instead of adding a second.
 * @property {string} [addLabel] - What the add picker calls this type, where that
 *   differs from its name — for one that opens a chooser rather than adding on the
 *   spot, e.g. 'Add a file to view…'. Defaults to `name`.
 * @property {number} [order] - Sort key, ascending, default 0; ties keep registration
 *   order. It orders the add picker and the tabs a new board is furnished with, so
 *   the two agree. Ask for a lower one only where the type earns the top of a list
 *   every user reads.
 * @property {boolean} [addable] - Whether the type appears in the add picker at all.
 *   Defaults to true; set false for a type only ever pinned from a source.
 * @property {boolean} [sourceFallback] - Whether this type is the last resort for a
 *   source rather than a claim on it. Off by default. A type that accepts a whole
 *   `kind` — every file, say — sets it, and the host asks every other type first, so
 *   a narrower type still gets its say however late it registered. Without this the
 *   answer would be decided by load order, and a catch-all shipped in the box would
 *   beat every extension by arriving first.
 * @property {boolean} [defaultPin] - Whether a board opens with this type already on
 *   it. The starting tabs are laid out once, the first time a board is used; after
 *   that the board is the user's, so one they remove stays removed. Only ask for this
 *   where the type is worth a tab before anyone has configured anything — a type that
 *   needs a chooser answered has nothing to show, and there is nobody there to answer.
 * @property {boolean} [retain] - Keep this pin mounted when the user switches to
 *   another tab, instead of tearing it down and building it again on the way back.
 *   Off by default, and the default is the right answer for almost everything: a pin
 *   that re-reads its source on mount is *better* for being rebuilt, because it
 *   cannot then show anything stale.
 *
 *   Ask for it when a rebuild would destroy something config cannot reconstruct — a
 *   live connection, an audio session, an `<iframe>` whose page would reload and
 *   start over. Those are not merely slow to rebuild; they are impossible to rebuild
 *   identically, and a user who switched tabs did not ask for the thing they were
 *   watching to begin again.
 *
 *   A retained pin's body element stays in the document and is hidden rather than
 *   removed — reparenting an `<iframe>` reloads it, so the host never moves one —
 *   and its `signal` stays unaborted, so its subscriptions go on running out of
 *   sight. Its controller gets `hide()` and `show()` to quieten down and pick up
 *   again. `teardown()` then means what it says: the pin is going for good, not
 *   merely off screen.
 */

/**
 * A source descriptor — a thing elsewhere in the UI that the user asked to pin,
 * passed to `canPinSource`/`configFromSource` so a properties panel never has to
 * name a concrete pin class.
 * @typedef {object} PinSource
 * @property {string} kind - Source kind, e.g. 'file'
 * @property {string} [path] - Absolute path, for `kind: 'file'`
 * @property {boolean} [isDirectory] - Whether that path names a folder rather than
 *   a file, for a surface that already knows which it is offering
 * @property {'live'|'snapshot'} [presentation] - Whether the pin tracks the source
 *   or freezes what it said at pin time
 */

/**
 * What the agent is told about one pinboard item type, and how it addresses it.
 *
 * A pin type runs in the viewer: it touches the DOM, so it is never loaded in the
 * engine worker, where the `pin_to_pinboard` tool lives. A type that says nothing
 * here is still pinnable — the tool forwards an unrecognised type's parameters
 * untouched — but the model has no way to *find out* it exists, so in practice it
 * is never chosen. The descriptor is how a type gets named in the tool's
 * description, and naming it is the whole of the difference.
 *
 * Declare it as the default export of a module beside the pin, listed under
 * `pinboardItemMeta` in the extension manifest. That module is loaded in the
 * worker, so it must be **free of side effects and of the DOM**: no styles
 * injected at import, no `document`, nothing but the descriptor and the pure
 * functions it needs.
 *
 * ```javascript
 * // pins/clock-pin.meta.js
 * export default {
 *   id: 'clock',
 *   description: 'The current time, ticking.',
 *   parameters: { type: 'object', properties: {}, required: [] },
 * };
 * ```
 * @typedef {object} PinAgentDescriptor
 * @property {string} id - The item-type id, matching the pin's `MANIFEST.id`
 * @property {string} description - One line, written for the model, saying what
 *   this type shows and when to reach for it. Not `MANIFEST.description`, which is
 *   catalog copy for a person: this one is read by something choosing between
 *   types, so say what distinguishes it from the type it would otherwise pick.
 * @property {object} parameters - JSON schema for the `parameters` the tool takes
 *   for this type. A type that needs none still declares an empty object schema,
 *   so the model can see there is nothing to supply.
 * @property {(parameters: Record<string, any>) => Record<string, any>|null} [normalize] -
 *   Collapse the model's parameters to one spelling, or return null to reject
 *   them. Runs before the pin is written, so the type owns what a valid request
 *   is rather than discovering it at mount. Defaults to accepting any plain object.
 * @property {(parameters: Record<string, any>) => string} [identity] - What makes
 *   two requests the same pin. The tool hashes it into a stable id, so a repeated
 *   request reveals the existing pin instead of stacking a copy. Defaults to the
 *   whole parameter object.
 * @property {boolean} [fallback] - Whether this type is the general case rather
 *   than a claim on anything in particular — the manifest's `sourceFallback`, said
 *   to the model. It is listed last and named as the answer for what nothing else
 *   claims, so a narrower type is the one that gets picked when it applies.
 */

/**
 * The active context a pin is rendered against. Supplied by the host and treated
 * as immutable — it is a snapshot, not a live view, and a new one arrives through
 * `update()` whenever the active conversation or project changes.
 * @typedef {object} PinActiveContext
 * @property {{path: string, displayName: string}} project - The open project: its
 *   root path, and the last segment of that path as a name to show. Both are empty
 *   strings when no project is open.
 * @property {{id: string, title: string}|null} conversation - Active conversation, if any
 * @property {{id: string|null}|null} thread - The thread the viewer is looking at,
 *   or null when no conversation is open. A conversation's root thread has no id of
 *   its own, so `id` is null there; a sub-thread carries its thread item's id.
 */

/**
 * One file the host was told about while a pin was watching.
 * @typedef {object} PinFileChange
 * @property {string} path - Absolute path of the file that changed
 * @property {'write'|'create'|'remove'|'rename'} event - What happened to it
 */

/**
 * Notification that files on disk changed, for a pin showing one of them. Only
 * files inside the open project are reported, and hidden files are not: the
 * watcher is rooted at the project and skips dot-files. A pin on anything else
 * will hear nothing, so offer the user a way to re-read rather than trusting this
 * to be complete. Do not poll for changes it does not report. The one exception
 * is a pin whose path does not exist yet: it may stat that path, backing off,
 * while the pin is visible and until something appears. Changes to an existing
 * file still come only from this service or from the user.
 * @typedef {object} PinFilesService
 * @property {(listener: (changes: PinFileChange[]) => void) => (() => void)} onChange -
 *   Watch for file changes. Returns an unsubscribe function; the host also drops
 *   the subscription when the pin is torn down, so forgetting it leaks nothing.
 */

/**
 * Which thread a context item was found on.
 * @typedef {object} PinContextItemSource
 * @property {string|null} threadId - The thread that owns the item. Null for the
 *   conversation's root thread, which has no thread item of its own.
 * @property {string} label - That thread's name, the same one its column header
 *   shows. Empty when the thread was never given a goal.
 * @property {boolean} inherited - True when the item came from an ancestor of the
 *   focused thread rather than the focused thread itself. Say so if you show it:
 *   a plan belonging to a thread the user is not in is not the same claim as one
 *   belonging to the thread they are.
 * @property {string|null} itemId - The transcript row that stands for the item,
 *   to hand to `reveal`. An item that draws no tile of its own — a plan, a todo
 *   list — is represented in the column by the tool-action row that wrote it, and
 *   this is that row. Null when the item has no row, in which case `reveal` can
 *   only point at the thread.
 */

/**
 * A context item as the board sees it: a copy of what it holds, and where it was
 * found. It is a snapshot, not a handle — mutating `data` changes nothing, and
 * the next call returns fresh values.
 * @typedef {object} PinContextItemSnapshot
 * @property {string} id - The context item's id
 * @property {string} type - Its item-type id, e.g. 'plan'
 * @property {Record<string, any>} data - A deep copy of its stored data
 * @property {PinContextItemSource} source - The thread it came from
 */

/**
 * The context items of the conversation being read. A pin is a view of a
 * conversation it does not own, so this hands out copies and never the model.
 *
 * `find` resolves like the columns do: the thread the user is looking at first,
 * then its ancestors, nearest first, ending at the root. That is why the result
 * carries its source — a Plan pin showing a parent thread's plan is telling the
 * truth only if it says whose plan it is.
 * @typedef {object} PinContextItemsService
 * @property {(type: string, from?: string|null) => PinContextItemSnapshot|null} find -
 *   The nearest context item of that type, or null when neither the starting
 *   thread nor any ancestor has one. The walk starts at the thread being read;
 *   pass `from` to start it somewhere else instead — a thread id, or null for
 *   the conversation root — which is how a pin watches one thread rather than
 *   following the reader. Same resolution either way, so the source it reports
 *   is still whichever thread in that chain actually owns the item.
 * @property {(listener: () => void) => (() => void)} onChange - Called when the
 *   items may have changed, or when the focused thread moved. Carries nothing:
 *   call `find` again. Returns an unsubscribe function; the host also drops the
 *   subscription when the pin is torn down.
 * @property {(threadId: string|null, itemId?: string|null) => void} reveal - Point
 *   the conversation at what the pin is showing. Pass the source's `itemId` and
 *   the row itself is selected, wherever in the chain it lives; pass only a
 *   thread id — null meaning the root — and its column is brought into view
 *   instead. Prefer the row: making the root column active is no movement at all
 *   for a reader who is already there, which is most of them. The reveal happens
 *   wherever the columns are: from a board detached into its own window it is
 *   carried out in the window that opened it, which then brings itself forward.
 *   Best-effort and one-way — there is no window to point at once the one that
 *   owns the board has gone.
 */

/**
 * One file in a repository's working tree. `index` and `worktree` are git's own
 * status letters — 'M', 'A', 'D', 'R', '?' — where '.' means that side is
 * unmodified, so a file staged and then edited again reads 'M'/'M'.
 * @typedef {object} PinGitFile
 * @property {string} path - Path relative to its repository, forward-slashed
 * @property {string} [oldPath] - Former path for a rename or copy
 * @property {string} index - Staged status letter, '.' when unmodified
 * @property {string} worktree - Working-tree status letter, '?' for untracked
 * @property {boolean} [conflicted] - Whether this is an unmerged entry
 * @property {number} [added] - Added tracked text lines; absent for untracked/binary files
 * @property {number} [removed] - Removed tracked text lines; absent for untracked/binary files
 */

/**
 * One repository under the open project.
 * @typedef {object} PinGitRepo
 * @property {string} path - Location relative to the project root, '' for the root repo
 * @property {number} changed - Files with working-tree changes, untracked included
 * @property {number} staged - Files with staged changes
 * @property {number} conflicted - Files with unresolved merges
 * @property {number} total - Files git reported, listed in `files` or not. Not
 *   `changed + staged`: a file staged and then edited again is one file on both sides.
 * @property {number} added - Added tracked text lines relative to HEAD
 * @property {number} removed - Removed tracked text lines relative to HEAD
 * @property {string} branch - Current branch, '' on a detached head
 * @property {string} upstream - Tracking branch, '' when it has none
 * @property {string} head - Full HEAD object id, '' before the first commit
 * @property {boolean} initial - Whether the repository has no commits yet
 * @property {number} ahead - Commits this branch has that its upstream does not
 * @property {number} behind - Commits its upstream has that this branch does not
 * @property {number} stashes - Entries in the stash
 * @property {boolean} detached - Whether HEAD is on a commit rather than a branch
 * @property {PinGitFile[]} files - The changed files, bounded by the host
 * @property {boolean} truncated - True when the tree holds more files than `files` lists.
 *   The counts still describe the whole tree, so say "200 of 4000" rather than "200".
 */

/**
 * The working-tree state of every repository under the project — the root repo
 * and any nested repos or submodules, in a stable order.
 * @typedef {object} PinGitStatus
 * @property {string} root - Absolute path of the tree that was read: the project,
 *   or the workspace the visible conversation works in
 * @property {string} [workspace] - That workspace's name when the tree is not the
 *   project (a worktree, a copy, a subfolder). Absent for the project. Show it:
 *   counts from a worktree read exactly like counts from the project otherwise
 * @property {PinGitRepo[]} repos - Every repo found, empty when the project has no git
 */

/**
 * One repository in a review manifest: everything the card reports about it,
 * plus whether that is the whole story.
 *
 * A repository git could not read is listed all the same, with `error` carrying
 * git's own first line of complaint — an uninitialised submodule is the everyday
 * case. Dropping it would turn "I could not read this" into "there is nothing
 * here", which is the one thing a review may never say.
 * @typedef {PinGitRepo & {complete: boolean, error?: string}} PinGitReviewRepo
 */

/**
 * The working tree as a review reads it: every repository under the project and
 * every changed file in each of them, asked for rather than polled.
 *
 * `complete` is the field this whole answer turns on, and the one a surface must
 * not paper over. Ceilings and failures are unavoidable; presenting what they
 * left behind as the whole working tree is not. Partial results are worth showing
 * — they are just not everything, and each gap names itself in `warnings`, in
 * sentences meant for the user rather than for a log.
 * @typedef {object} PinGitReview
 * @property {string} root - Absolute path of the tree that was read, as for
 *   {@link PinGitStatus}
 * @property {string} [workspace] - That tree's workspace name, as for {@link PinGitStatus}
 * @property {boolean} complete - Whether every repository and file was reached
 * @property {string[]} warnings - What could not be reviewed, one sentence each.
 *   Always an array; empty when nothing was missed.
 * @property {PinGitReviewRepo[]} repos - Every repository found, root repo first
 */

/**
 * One line of a hunk. `oldLine` and `newLine` are its number on each side, and
 * the side a line does not exist on has neither — an added line has no number in
 * the old file. `text` carries no leading +/-/space: which side a line is on is
 * `kind`'s job, not the text's.
 * @typedef {object} PinGitDiffLine
 * @property {string} kind - 'context', 'add' or 'remove'
 * @property {number} [oldLine] - Line number on the old side
 * @property {number} [newLine] - Line number on the new side
 * @property {string} text - The line itself
 */

/**
 * One run of changed lines and the context around it.
 * @typedef {object} PinGitDiffHunk
 * @property {number} oldStart - First line covered on the old side
 * @property {number} oldLines - Lines covered there
 * @property {number} newStart - First line covered on the new side
 * @property {number} newLines - Lines covered there
 * @property {string} [heading] - The section git names in the `@@` line, usually
 *   the enclosing function. Often absent.
 * @property {PinGitDiffLine[]} lines - The hunk's lines, in file order
 */

/**
 * One file's whole working-tree change against `HEAD` — index and worktree folded
 * together, which is the same comparison the file's line counts in the manifest
 * come from, so the two can never disagree.
 *
 * `revision` fingerprints every byte the answer describes, including any past a
 * ceiling that were never sent. It is what an anchor asks about: a comment left
 * on a line wants to know whether this is still the same file it was left on, and
 * `HEAD` cannot answer that, because almost every edit under review happens
 * without `HEAD` moving at all.
 * @typedef {object} PinGitDiff
 * @property {string} repo - Repository this file belongs to, '' for the root repo
 * @property {string} path - File path relative to that repository
 * @property {string} [oldPath] - Former path, for a rename or copy
 * @property {string} status - modified, added, deleted, renamed, copied,
 *   typechange, conflicted, untracked or unchanged
 * @property {boolean} binary - Whether git judged it binary. No patch text is
 *   invented for one: say that it changed and offer what a reader can do with it.
 * @property {boolean} [conflicted] - Whether the index holds unmerged stages for it
 * @property {boolean} truncated - Whether the patch was cut short. The counts
 *   still describe all of it, so say "the rest is not shown" rather than nothing.
 * @property {number} added - Added lines
 * @property {number} removed - Removed lines
 * @property {string} revision - Fingerprint of the change this describes
 * @property {number} context - Unchanged lines carried around each change, as the
 *   request asked for or the default. You can show less of the file than this from
 *   the patch alone; showing more takes another `diff()`.
 * @property {string} [oldMode] - Git's six-digit mode on the old side, when it moved
 * @property {string} [newMode] - Git's six-digit mode on the new side, when it moved
 * @property {PinGitDiffHunk[]} hunks - The patch, hunk by hunk. Empty for a pure
 *   rename, a mode change, or a binary file — all of which are still changes.
 */

/**
 * The project's git working tree.
 *
 * There are two questions here and they are not the same one. `status` is
 * ambient: small, bounded, best-effort, and shared with the info card. `review`
 * and `diff` are the deliberate read — what the user works from before telling
 * the agent what to fix — and they are asked for, never polled.
 *
 * The ambient half is a **poll, not a watch**. Nothing under `.git` is ever reported by the
 * file watcher — it skips dot-directories before it starts watching — so there is
 * no event to subscribe to and the host asks git on a timer, and only while the
 * window is focused. `onChange` therefore tells you a fresh answer arrived, not
 * that the repository changed at the moment it did. Offer the user a way to ask
 * again rather than implying the display is live, and never poll yourself: every
 * surface shares one poll, and a second one would run git twice.
 * @typedef {object} PinGitService
 * @property {() => PinGitStatus|null} status - The latest status, or null when
 *   nothing has been read yet. Null is not "no repositories": say you are still
 *   looking rather than claiming the project has no git.
 * @property {() => string} error - The last read's failure, or ''. The previous
 *   status is kept beside it, because a transient failure should not blank a
 *   working display — show both.
 * @property {(listener: () => void) => (() => void)} onChange - Called when a new
 *   status has arrived. Carries nothing: call `status()`. Returns an unsubscribe
 *   function; the host also drops the subscription when the pin is torn down.
 * @property {() => Promise<void>} refresh - Ask git now. Never rejects: a failure
 *   shows up on `error()`.
 * @property {(options?: {signal?: AbortSignal}) => Promise<PinGitReview>} review -
 *   Read the whole working tree for review: every repository, every changed file,
 *   nothing skipped for being expensive, and whatever could not be reached named
 *   in `warnings` rather than quietly left out. Ask when a review is opened or
 *   refreshed and not on a timer — concurrent callers share one read, so a second
 *   surface costs nothing, but a loop here runs git in a loop. Rejects if the read
 *   failed, if you cancelled it, or if the project changed while it was out: an
 *   answer about a project nobody is looking at is not an answer.
 * @property {(repo: string, path: string, options?: {signal?: AbortSignal, contextLines?: number}) => Promise<PinGitDiff>} diff -
 *   One file's change, named the way the manifest names it: `repo` is the
 *   repository's path within the project ('' for the root repo) and `path` is the
 *   file's path within that repository. Asked for one file at a time, when
 *   something is about to show it — never in a loop over a manifest. Pass a signal
 *   and cancelling actually cancels the read, which is what keeps a user clicking
 *   down a file list from leaving a queue of patches behind them. The host also
 *   cancels everything this pin has out when the pin goes away.
 *   `contextLines` is how many unchanged lines to carry around each change, -1 for
 *   the whole file; omit it for the default. The patch reports the width it came
 *   back at, because you can draw less of it than that but not more.
 */

/**
 * One background task this conversation started and that is still running.
 * @typedef {object} PinTask
 * @property {string} taskId - The task's id, as `stop` takes it
 * @property {string} itemId - The tool action that started it, for `reveal`
 * @property {string|null} threadId - The thread it was started in, null for the root
 * @property {string} toolName - The tool that started it, as the transcript names it
 * @property {string} command - The command line it is running. Unbounded — it is
 *   whatever was typed — so give it a bounded space rather than trusting it to be short.
 * @property {string} label - What it was started for, when the tool was asked to
 *   say. Empty otherwise.
 * @property {number} at - Unix ms it was started, `Infinity` for one so new the
 *   worker has not echoed it back yet
 */

/**
 * The background tasks this conversation has running: `bash` with
 * `run_in_background`, and `Monitor`.
 *
 * **A live inventory, not a history.** A task leaves the list the moment it ends,
 * however it ended. That is the whole retention policy, and it is deliberate: the
 * transcript is where a task's history lives, so a task that failed is gone from
 * here and still says so — with its output, its exit code and its approval — on
 * the tool action that started it. Which is what `reveal` is for.
 *
 * It is built from two halves because neither is enough alone. The transcript
 * says which tasks were started and can never say which are still running: the
 * durable snapshot beside a tool action freezes at whatever it last said, so
 * after a restart it claims `running` forever. The server knows what is running
 * and is asked only about ids the transcript already named. One consequence is
 * worth relying on: nothing survives a server restart, and the list says so by
 * being empty rather than by explaining itself.
 *
 * It is also the narrowest thing that could work, on purpose. There is no way to
 * ask what tasks exist — not in this conversation, not in another one, not in the
 * process — so a surface built on this can only ever show tasks the conversation
 * in front of the user started.
 * @typedef {object} PinTasksService
 * @property {() => PinTask[]|null} list - The tasks running as of the last check,
 *   newest first, or null when none has come back yet. Null is not an empty list:
 *   say you are still looking rather than claiming nothing is running.
 * @property {() => string} error - The last check's failure, or ''. The previous
 *   list is kept beside it, because a transient failure should not empty a
 *   working display — show both.
 * @property {(listener: () => void) => (() => void)} onChange - Called when the
 *   list may have changed. Carries nothing: call `list`. Returns an unsubscribe
 *   function; the host also drops the subscription on teardown. The check runs
 *   only while something is watching, so a board nobody has open asks nothing.
 * @property {(itemId: string) => void} reveal - Select the tool action that
 *   started the task, opening whatever columns it takes to reach it. Like every
 *   reveal, it happens in the window that has the columns — a detached board's
 *   goes back to the window that opened it.
 * @property {(taskId: string) => Promise<void>} stop - Stop a running task.
 *   Rejects if it could not be asked to stop, so show what came back. The host
 *   picks how — a `Monitor`'s task and a plain one are stopped by different means
 *   — and you do not need to know which.
 */

/**
 * One comment written against a diff, on its way to the conversation. A superset
 * of what the diff renderer draws: it also carries where the comment came from
 * and when, which is what it takes to find it again and to send it.
 * @typedef {object} PinReviewComment
 * @property {string} id - Identifies the comment for edit and delete
 * @property {string} repo - The repository it belongs to, '' for the project's own
 * @property {string} path - The file, relative to that repository
 * @property {string} [oldPath] - Where the file was, for a rename
 * @property {'old'|'new'|'file'} side - Which side of the diff it hangs on, or
 *   'file' for one about the file rather than any line in it
 * @property {number} [startLine] - First line it covers, absent for a file comment
 * @property {number} [endLine] - Last line it covers, absent for a file comment
 * @property {string[]} lineText - The source it quoted when it was written, kept
 *   because it is all there is left to show once the file has moved on from it
 * @property {string} body - What the reader wrote
 * @property {string} revision - The fingerprint of the patch it was written
 *   against, as `diff()` reported it
 * @property {number} createdAt - Unix ms it was written
 * @property {number} updatedAt - Unix ms it was last edited
 */

/**
 * A thread's unsent review.
 * @typedef {object} PinReviewDraft
 * @property {number} version - The record's shape. Always 1.
 * @property {'head'} base - What the review compares against. One scope exists.
 * @property {PinReviewComment[]} comments - The comments, in the order to show them
 */

/**
 * The comments written against a review and not yet sent, kept where the message
 * they will become would go: on the thread the reader is in, in that
 * conversation's own document.
 *
 * **The draft belongs to a thread, not to the project or the board.** Moving to
 * another thread or another conversation reveals that one's comments; it never
 * retargets the ones already written, because a comment is addressed to whoever
 * is going to read it. The same follows for a detached board, which keeps the
 * conversation it was opened with and so goes on reading and writing the same
 * durable draft as the window it left.
 *
 * It survives what a review has to survive — a tab switch, a detached board, a
 * restart — because it is in the conversation document rather than in pin config
 * or in the DOM. Pin config would be the wrong home twice over: it is capped, and
 * it is copied when a board is detached, so two boards would drift apart.
 * @typedef {object} PinReviewService
 * @property {() => PinReviewDraft|null} draft - The comments on the thread being
 *   read, as a copy. Null means there is no conversation to hold one — a board
 *   opened on a project with nothing active — which is not the same as a review
 *   with no comments yet, and a surface that treats it as such offers somewhere
 *   to write that quietly discards.
 * @property {(listener: () => void) => (() => void)} onChange - Called when the
 *   draft being read may have changed — saved here, saved in another window, or
 *   a different one now because the reader moved thread. Carries nothing: call
 *   `draft`. Returns an unsubscribe function; the host also drops the
 *   subscription on teardown.
 * @property {(draft: {comments: PinReviewComment[]}) => Promise<void>} save -
 *   Replace the draft on the thread being read. Rejects if there is nowhere to
 *   put it or the draft is over a limit, and writes nothing in either case — so
 *   keep the text on screen and show what came back rather than clearing it.
 * @property {() => Promise<void>} clear - Discard every comment on that thread.
 * @property {() => Promise<void>} compose - Hand the saved draft to the user as
 *   one ordinary message for them to send: into the composer for the thread it
 *   belongs to, or — from a detached board, which has no composer — to the window
 *   that board was opened from. With neither, it sends the message itself, so a
 *   board outliving its owner can still hand the feedback over. What it hands
 *   over is what `draft` reports, so save an edit first. The comments are NOT
 *   cleared: text in a box has not been said yet, and only `clear` discards
 *   them. Rejects when there is nowhere to put it and when there is nothing to
 *   say.
 */

/**
 * Host services, for data the active-context snapshot does not carry. Each is
 * read-only and cancellable: a pin is a view, so it never gets a mutable handle
 * on model state, and it asks the host rather than reaching into it.
 *
 * `tasks.stop` is the one exception to read-only, and a narrow one: it acts on a
 * process rather than on any model state, at the user's request, on a surface the
 * conversation already offers a Stop button for. It is not a precedent for a
 * service that writes.
 *
 * `review.save`, `review.clear` and `review.compose` are the second, and are
 * narrow in a different way: what they write is the user's own unsent text, at
 * the moment the user saves, discards or hands it over, into a record that exists
 * for no other purpose. `compose` writes that text into the composer — which a
 * service may do only because the text is the user's own and they asked for it
 * there, and because it is an insert at the caret: a message already in the box
 * survives it, and one undo takes the review back out. It cannot read the box,
 * clear it, send what is in it, edit the transcript, or reach another thread's
 * draft.
 *
 * Services are added one at a time, as the provider that needs one lands. Write
 * against what is here rather than what you expect to be.
 * @typedef {object} PinServices
 * @property {PinFilesService} files - Files changing on disk
 * @property {PinContextItemsService} contextItems - The conversation's context items
 * @property {PinGitService} git - The project's git working tree
 * @property {PinTasksService} tasks - The background tasks this conversation is running
 * @property {PinReviewService} review - The unsent review comments on the thread being read
 */

/**
 * Everything `mount()` and `update()` receive.
 * @typedef {object} PinContext
 * @property {{id: string, type: string, config: Record<string, any>}} pin - This pin instance
 * @property {PinActiveContext} active - Immutable active-context snapshot
 * @property {PinServices} services - Read-only host services
 * @property {AbortSignal} signal - Aborted when the pin is torn down; every fetch must honour it
 * @property {(nextConfig: Record<string, any>) => Promise<void>} updateConfig - Persist new config for this pin
 */

/**
 * What the host shows in the item toolbar above the provider body. Returned from
 * `describe()`, so the host owns the chrome and the provider owns only the words.
 * @typedef {object} PinDescription
 * @property {string} title - Short tab label and toolbar title, e.g. 'main.go'
 * @property {string} [subtitle] - Secondary line, e.g. the containing directory
 * @property {string} [path] - The absolute path this pin is showing. The toolbar
 *   then names the file rather than the pin: it shows the path in place of the
 *   title, and offers the same open/copy/reveal controls a path gets anywhere
 *   else in the app, so a pin need not supply those actions itself. `title` is
 *   still what the tab says, because a full path across a tab strip is unreadable.
 * @property {string} [badge] - Compact status shown on the tab, e.g. '3/5'. Not a second title.
 */

/**
 * One thing the user can do to the active pin, offered in the item toolbar the
 * host draws above the body. The provider supplies the words and the behaviour;
 * where the control goes, and what it looks like, is the host's business.
 * @typedef {object} PinAction
 * @property {string} id - Stable identifier, for the host to tell actions apart
 * @property {string} label - What the control says, e.g. 'Open'. Literal, not a sentence.
 * @property {boolean} [primary] - Put it in the toolbar as a button of its own.
 *   Everything else goes in the overflow menu, which is where most actions belong:
 *   a toolbar of five buttons is a toolbar nobody reads.
 * @property {string} [icon] - Draw it as a glyph the host knows by this name,
 *   rather than as its label. Currently only `'refresh'`. An icon action is always
 *   a button of its own and never joins the overflow menu, where a picture has
 *   nothing to say; a name the host does not know falls back to the label.
 * @property {boolean} [disabled] - Show it, greyed, rather than hiding it. Prefer
 *   this to omitting an action that is temporarily unavailable — a control that
 *   comes and goes is harder to find than one that is briefly dim.
 * @property {() => void|Promise<void>} run - Do the thing. Anything thrown, or a
 *   rejected promise, is reported in the board's status line with the error text intact.
 */

/**
 * The object `mount()` may return instead of a bare teardown function, letting a
 * pin survive an active-context change rather than being torn down and rebuilt.
 * @typedef {object} PinController
 * @property {(next: PinContext) => void} [update] - Apply a new context snapshot in place
 * @property {() => void} [teardown] - Stop timers and listeners
 * @property {() => void} [focus] - Move focus into the body. Asked when a reader
 *   arrives on this pin deliberately — the board opening on it, a reveal, Return
 *   pressed on it — and never as the arrow keys step past it on the way somewhere
 *   else, so a pin whose entry point is a text field does not swallow the next
 *   press of the key that brought them here.
 * @property {() => void} [hide] - Only for a type with `retain` in its manifest: the
 *   user has switched to another tab and this pin is off screen, still mounted and
 *   still subscribed. Quieten down — pause an animation, stop asking for what nobody
 *   is reading — but do not release what retention exists to protect. Never called
 *   for a pin that is not retained, which is torn down instead.
 * @property {() => void} [show] - The retained pin is on screen again. Pick up
 *   whatever `hide()` put down, and re-read anything that may have moved on while
 *   nobody was looking: the news that arrived meanwhile was delivered, but a pin
 *   that stopped listening in `hide()` will not have heard it.
 * @property {() => PinAction[]} [getActions] - The actions the item toolbar offers for
 *   this pin. The host asks after `mount()` and after every `update()`, and at no
 *   other time — there is no channel for announcing that your actions changed, so
 *   return the same set each call and use `disabled` for one that cannot run yet.
 *   Omit this entirely and the toolbar shows title and subtitle alone.
 */

// ============================================================================
// PinboardItemType Base Class
// ============================================================================

/**
 * PinboardItemType — base class for Juggler "pinboard item" plugins.
 *
 * The pinboard is the tabbed workspace behind the right edge of the window. Each
 * tab is one *pin*: a configured instance of an item type, kept in server-backed
 * session state so every viewer of the project sees the same board. An item type
 * supplies the body of its tab; the host owns the tabs, the toolbar, drag, remove,
 * loading and error shells.
 *
 * Pinboard items are **viewer-only** — they touch the DOM and never run in the
 * engine worker, so like info cards (and unlike strategy/context-item/command)
 * there is no `-worker.js` twin of this base class.
 *
 * ## Item type versus info card versus context item
 *
 * - An **info card** is an ambient tile the sidebar may *drop* when it runs out of
 *   room. A pin is guaranteed workspace the user asked for by name.
 * - A **context item** belongs to a conversation and is visible to the model. A pin
 *   is a view: pinning a file shows it, it does not put it in anyone's context.
 *
 * ## Creating an item type
 *
 * Item types ship inside an **extension** (a directory with a
 * `juggler.extension.json` manifest). Add a file named `*-pin.js` under the
 * extension's `pins/` directory — the manifest's `provides.pinboardItems` glob
 * registers it automatically.
 *
 * 1. Import and extend PinboardItemType: `import PinboardItemType from 'juggler/pinboard-item-type';`
 * 2. Define a static MANIFEST with the required fields (id, name, version, description).
 * 3. Implement `mount(container, pinContext)`; optionally override `describe()`,
 *    `canAdd()`, `normalizeConfig()`, and `configure()`.
 * 4. To let the agent pin one, ship a `PinAgentDescriptor` beside it — see that
 *    typedef. Without one the type is invisible to the model.
 *
 * ```javascript
 * import PinboardItemType from 'juggler/pinboard-item-type';
 *
 * export default class ClockPin extends PinboardItemType {
 *   static MANIFEST = {
 *     id: 'clock',
 *     name: 'Clock',
 *     version: '1.0.0',
 *     description: 'Shows the time, which is rarely what you wanted to know',
 *   };
 *
 *   mount(container, { signal }) {
 *     const tick = () => { container.textContent = new Date().toLocaleTimeString(); };
 *     tick();
 *     const timer = setInterval(tick, 1000);
 *     signal.addEventListener('abort', () => clearInterval(timer));
 *     return () => clearInterval(timer);
 *   }
 * }
 * ```
 *
 * ## State rules
 *
 * Config is the only thing that persists, so keep it small, JSON-serializable, and
 * meaningful without the machine that produced it: a path, not file bytes. The
 * board state is shared and long-lived, and it outlives your class — a pin whose
 * extension has been disabled keeps its config until the user removes it.
 *
 * Hold no authoritative state in the DOM or on the instance: one instance serves
 * every pin of its type, mount and teardown happen for reasons you do not control
 * (a project switch, a hot reload, the user switching tabs), and the same board is
 * open in windows you cannot see.
 *
 * A type with `retain` in its manifest is spared only the last of those: switching
 * tabs hides it instead of tearing it down. It is not spared any of the others, and
 * it is not spared this rule — a retained pin is still one of several views of a
 * board it does not own, and what it must survive is still written in its config.
 * @class
 * @abstract
 */
class PinboardItemType {
  /**
   * Pinboard-item manifest (static property set by subclasses).
   * @type {PinboardItemManifest}
   * @static
   */
  static MANIFEST;

  constructor() {
    if (new.target === PinboardItemType) {
      throw new Error('PinboardItemType is an abstract class and cannot be instantiated directly');
    }

    // Validate manifest on construction
    validateManifest(this.constructor);
  }

  /** @returns {PinboardItemManifest} This item type's manifest. */
  getManifest() {
    return /** @type {typeof PinboardItemType} */ (this.constructor).MANIFEST;
  }

  /** @returns {string} The item-type id (from MANIFEST). */
  get id() {
    return this.getManifest().id;
  }

  /** @returns {string} The item-type display name (from MANIFEST). */
  get name() {
    return this.getManifest().name;
  }

  /** @returns {boolean} True when the board may hold more than one pin of this type. */
  get allowsMultiple() {
    return this.getManifest().instances === 'multiple';
  }

  /**
   * @returns {boolean} True when this type's pins stay mounted while another tab is
   *   showing, rather than being torn down and rebuilt on the way back.
   */
  get retainsMount() {
    return this.getManifest().retain === true;
  }

  /**
   * Whether a new pin of this type can be added right now. Return a string to say
   * why not — the add picker shows it, which is far better than the entry silently
   * vanishing ('No project', 'No active conversation'). Defaults to always addable.
   * @param {PinActiveContext} active - The current active-context snapshot.
   * @returns {true|string} True to allow, or the reason it is unavailable.
   */
  canAdd(active) {
    void active;
    return true;
  }

  /**
   * Collect the config for a new pin. Override for a type that needs to ask the
   * user something first (File asks which file). Return null to abandon the add —
   * a cancelled picker is not an error. Defaults to an empty config.
   * @param {{active: PinActiveContext, initialConfig?: Record<string, any>, signal: AbortSignal}} options - Configuration request.
   * @returns {Promise<Record<string, any>|null>} The new config, or null if cancelled.
   */
  async configure(options) {
    return options.initialConfig ?? {};
  }

  /**
   * The user is removing this pin. Release anything this pin created and nothing
   * else.
   *
   * The boundary is the whole of the rule, and it is narrower than it looks.
   * Removing a pin is removing a *view*, so a pin releases what it brought into
   * existence — a server it started, a connection it opened — and never touches
   * what it was merely looking at. A Tasks pin does not stop tasks it only
   * listed; a Memory pin does not edit MEMORY.md; a File pin does not delete a
   * file. Leaving a process running that the user now has no window onto is the
   * problem this exists to solve, and it is the only one.
   *
   * Best-effort and advisory: it is awaited, but throwing does not stop the
   * removal, and neither does taking too long — a couple of seconds in, the
   * removal goes ahead and leaves you to finish on your own. A pin the user has
   * asked to be rid of goes whatever its type thinks about it, so do the release
   * and do not bargain. Not called when an extension is disabled or the app
   * quits — there is no promise here that a resource is ever cleaned up, only
   * that the obvious moment is offered.
   *
   * It runs once, in the window the pin was removed in. A board is shared, so
   * the other windows showing it learn of the removal from the board itself and
   * give their own mount `teardown()` and nothing more: this is where the one
   * thing behind the pin is released, `teardown()` where one view of it is. Be
   * ready to be called about something already gone, since the window doing the
   * removing need not be the window that started it.
   * @param {Record<string, any>} config - The pin's normalized config.
   * @param {{active: PinActiveContext|null}} options - The active context, where the host had one.
   * @returns {Promise<void>} Resolves when the release is done.
   */
  async willRemove(config, options) {
    void config;
    void options;
  }

  /**
   * Validate and normalize a config before it is stored or rendered. This runs on
   * config that has been sitting in session state since a previous version of your
   * extension, so treat every field as untrusted and migrate rather than throw.
   * Return null to reject the config outright — the host keeps the pin but shows it
   * as unusable rather than mounting against nonsense.
   * @param {Record<string, any>} config - The stored or supplied config.
   * @returns {Record<string, any>|null} The normalized config, or null to reject it.
   */
  normalizeConfig(config) {
    return config;
  }

  /**
   * Whether two configs name the same thing, so the host can reveal the existing
   * pin instead of adding a duplicate. Both configs are already normalized.
   * Defaults to a shallow JSON comparison.
   * @param {Record<string, any>} a - One config.
   * @param {Record<string, any>} b - The other config.
   * @returns {boolean} True when the two configs describe the same pin.
   */
  isSameConfig(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * Cheap title/subtitle/badge for the tab and item toolbar. Called often, including
   * while the board is being laid out, so it must not do work — read the config, not
   * the filesystem. Defaults to the manifest name.
   * @param {Record<string, any>} config - The pin's normalized config.
   * @param {PinActiveContext} active - The current active-context snapshot.
   * @returns {PinDescription} What the host chrome should say.
   */
  describe(config, active) {
    void config;
    void active;
    return { title: this.name };
  }

  /**
   * Whether this type can pin the given source. Static, because the host asks
   * before any instance exists — a properties panel says "pin this file" and the
   * registry finds the type that can, rather than the panel naming a class.
   *
   * Accept only what this type is *for*. The first type to accept wins, so a type
   * that says yes to every file of any kind decides the answer for every other
   * type; if that is genuinely what yours does, mark it `sourceFallback` in the
   * manifest and it will be asked only once nothing narrower has claimed the source.
   * @param {PinSource} source - The source the user asked to pin.
   * @returns {boolean} True if `configFromSource` will accept it.
   */
  static canPinSource(source) {
    void source;
    return false;
  }

  /**
   * Turn a source descriptor into a config for a new pin. Only called when
   * `canPinSource` accepted it.
   * @param {PinSource} source - The source the user asked to pin.
   * @returns {Record<string, any>|null} The config, or null if it cannot be pinned after all.
   */
  static configFromSource(source) {
    void source;
    return null;
  }

  /**
   * Fill the pin's body. The host has already drawn the tab and toolbar; this owns
   * only the region below them.
   *
   * Return a teardown function, or a controller with `update()` so a change of
   * active conversation re-renders in place instead of rebuilding the pin, and
   * `getActions()` to put controls in the toolbar the host draws above you.
   * Anything thrown here is caught by the host and shown in the pin's place, so let
   * a real failure throw rather than rendering your own apology.
   * @abstract
   * @param {HTMLElement} container - The body region to populate.
   * @param {PinContext} pinContext - The pin, its config, and the active context.
   * @returns {PinController|(() => void)|void} Optional teardown or controller.
   */
  mount(container, pinContext) {
    void container;
    void pinContext;
    throw new Error('mount() must be implemented by subclass');
  }
}

export default PinboardItemType;
