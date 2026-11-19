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
 * @property {boolean} [needsConversation] - Whether a pin of this type can only be
 *   shown against a conversation — the conversation's plan, its todo list. Off by
 *   default. A popped-out board belongs to the conversation it was opened from,
 *   and when that conversation is deleted the board takes these pins off and goes
 *   on showing the rest; a board left with none closes its window. Leave it off
 *   for a type that merely uses a conversation when there is one.
 * @property {boolean} [toolbar] - Set it `false` and the host draws no item toolbar
 *   above this type's body: no title, no subtitle, no actions. For a pin whose
 *   body opens with a head line of its own that already says what it shows and
 *   carries its own controls, where the toolbar would be a second header saying
 *   less. `describe()` still names the tab; actions belong in that head line,
 *   since the toolbar `getActions()` fills is never shown.
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
 * Who asked the `pin_to_pinboard` tool for a pin.
 * @typedef {object} PinRequestOrigin
 * @property {string} [conversationId] - The conversation whose agent asked.
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
 * @property {(parameters: Record<string, unknown>, origin?: PinRequestOrigin) => Record<string, unknown>|null} [normalize] -
 *   Collapse the model's parameters to one spelling, or return null to reject
 *   them. Runs before the pin is written, so the type owns what a valid request
 *   is rather than discovering it at mount. Defaults to accepting any plain object.
 *   `origin` says who asked; a type whose pin depends on the asking conversation
 *   records it in what it returns, since the stored pin keeps nothing else.
 * @property {(parameters: Record<string, unknown>) => string} [identity] - What makes
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
 * @property {{path: string, displayName: string, stateDir?: string}} project - The
 *   open project: its root path, and the last segment of that path as a name to
 *   show. Both are empty strings when no project is open. `stateDir` is the folder
 *   the project's local state (memory, env.local.json) is kept in:
 *   `<path>/.juggler`, or a folder outside the project when the user keeps it
 *   there. Absent or empty means `<path>/.juggler`.
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
 * @property {Record<string, unknown>} data - A deep copy of its stored data
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
 * case, and a scope naming a branch this repository lacks another. Dropping it
 * would turn "I could not read this" into "there is nothing here", which is the
 * one thing a review may never say.
 *
 * For any scope but the default, `base` is the object id the old side resolved
 * to here, `target` the new side's when that is a commit rather than the working
 * tree or the index, and `baseName` the branch `@branch` settled on. In those
 * scopes `files` lists what the comparison covers, lettered on the side of the
 * two-letter code the comparison changes: the index side for `--cached`, the
 * working-tree side for everything else.
 * @typedef {PinGitRepo & {complete: boolean, error?: string, base?: string, target?: string, baseName?: string}} PinGitReviewRepo
 */

/**
 * What a review compares.
 * @typedef {object} PinGitScope
 * @property {string} input - The scope as asked for: a preset (`@uncommitted`,
 *   `@staged`, `@unstaged`, `@branch`, `@last`) or a small subset of `git diff`'s
 *   own arguments (`main`, `--merge-base main`, `--cached [rev]`, `--worktree`,
 *   `a..b`, `a...b`, `a b`)
 * @property {'worktree'|'index'|'unstaged'|'commits'} kind - Which two states it
 *   compares: the working tree, the index or a commit, against a commit or the index
 * @property {string} label - The comparison in words, in English
 * @property {{key: string, params?: Record<string, unknown>, context?: string}} [labelMessage] -
 *   The label as a server message, for `serverText()`; absent for a commit range,
 *   whose label is git's notation rather than words
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
 * @property {{key: string, params?: Record<string, unknown>, context?: string}[]} [warningMessages] -
 *   The same warnings, in the same order, as server messages for `serverText()`
 * @property {PinGitScope} [scope] - What was compared
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
 * One file's change within the scope asked for — by default its whole
 * working-tree change against `HEAD`, index and worktree folded together. Either
 * way it is the same comparison the file's line counts in the manifest come from,
 * so the two can never disagree.
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
 * Which conversations made what is staged, best first: the `attribution` read.
 * Each lists the staged `files` it made, with the scores it was ranked by.
 * @typedef {object} PinGitAttribution
 * @property {number} staged - Files staged.
 * @property {{conv: string, title: string, strong: number, weak: number, prior: number, files: string[]}[]} conversations -
 *   The conversations, best first
 */

/**
 * What a commit message is written from: the `commit-context` read.
 * @typedef {object} PinGitCommitContext
 * @property {string} repo - The repository, '' for the root.
 * @property {boolean} amend - Whether it describes an amend of HEAD.
 * @property {string} [headMessage] - HEAD's message, when amending.
 * @property {{path: string, oldPath?: string, status: string}[]} files - The staged files.
 * @property {string} stat - `--stat` of the change.
 * @property {string} diff - The staged patch, cut to size, every cut marked.
 * @property {boolean} truncated - Whether anything was cut.
 * @property {string[]} subjects - Recent subjects, newest first.
 * @property {string} rules - What the project's instruction files say about commits.
 * @property {boolean} wrapsBody - Whether the repository's bodies are wrapped.
 */

/**
 * What deleting one ref would leave unreachable: the `stranded` read. Only
 * other refs and each tree's HEAD count as reaching a commit, not the reflogs.
 * @typedef {object} PinGitStranded
 * @property {string} ref - The full ref name asked about.
 * @property {number} count - The commits only it reaches, counted up to a ceiling.
 * @property {boolean} [more] - Whether there are more than `count`.
 */

/**
 * One conversation's account of why files changed: the `digest` read.
 * @typedef {object} PinGitDigest
 * @property {string} conv - The conversation.
 * @property {string} title - Its title.
 * @property {string[]} userMessages - Its user messages, oldest first.
 * @property {{user: string, closing: string, files: string[]}[]} turns - The turns that touched the files.
 * @property {boolean} truncated - Whether anything was cut.
 */

/**
 * The project's git working tree, and the writes that change it.
 *
 * There are three kinds of question here and they are not the same one.
 * `status` is ambient: small, bounded, best-effort, and shared with the info
 * card. `review`, `diff` and `changes` are the deliberate read — what the user
 * works from — and they are asked for, never on a timer. `run` is a write.
 *
 * Nothing here is polled. The server watches a tree's git state — index, refs,
 * HEAD, working files, an operation in progress — while a window asks it to, and
 * pushes a change when any of them moves. The ambient status re-reads itself on
 * those (`onChange` says a fresh answer arrived); a pin reading the deliberate
 * half hears them through `watch` and decides for itself what to read again.
 * Never poll: the push already covers it, and a timer would run git for nothing.
 *
 * A write is a **job**. `run` starts it on the server and settles when it ends;
 * meanwhile `watch` hands you the job at every state change, with what a
 * commit's hooks print as they print it. What the write did to the tree arrives
 * as a change like any other.
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
 * @property {(options?: {signal?: AbortSignal, scope?: string, workspace?: string, conv?: string}) => Promise<PinGitReview>} review -
 *   Read the whole working tree for review: every repository, every changed file,
 *   nothing skipped for being expensive, and whatever could not be reached named
 *   in `warnings` rather than quietly left out. Ask when a review is opened or
 *   refreshed and not on a timer — concurrent callers share one read, so a second
 *   surface costs nothing, but a loop here runs git in a loop. Rejects if the read
 *   failed, if you cancelled it, or if the tree changed while it was out: an
 *   answer about a tree nobody is looking at is not an answer.
 *   `scope` is what to compare (see {@link PinGitScope}); omit it for the working
 *   tree against `HEAD`. A scope the host cannot read rejects, with the reason.
 *   `workspace` names the workspace whose tree to read; omit it for the tree
 *   of the workspace the visible conversation works in, or the project's.
 *   `conv` names the conversation whose turn the `@turn` scope compares against,
 *   and is required with it.
 * @property {(repo: string, path: string, options?: {signal?: AbortSignal, contextLines?: number, scope?: string, workspace?: string, conv?: string}) => Promise<PinGitDiff>} diff -
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
 *   `scope` (and `conv`) must be the ones the manifest was read with, or the file may not be in it.
 * @property {(options?: {repo?: string, workspace?: string, signal?: AbortSignal}) => Promise<PinGitChanges>} changes -
 *   One repository's changes, every file with what is staged and what is not:
 *   what a list to stage, discard and commit from is drawn from. `repo` is the
 *   repository's path within the tree, '' or omitted for the root. Read it when
 *   the pin opens and again when `watch` says so, never on a timer. Rejects on a
 *   refusal or failure with the server's reason, if you cancelled it or the pin
 *   went away, and — when no `workspace` was named — if the tree in view changed
 *   while it was out.
 * @property {(kind: 'refs'|'worktrees'|'log'|'commit'|'submodules'|'blame'|'attribution'|'commit-context'|'stranded', options?: {repo?: string, workspace?: string, signal?: AbortSignal, log?: PinGitLogQuery, commit?: string, blame?: {path: string, rev?: string}, amend?: boolean, conv?: string, ref?: string}) => Promise<PinGitRefs|PinGitWorktrees|PinGitLog|PinGitCommit|PinGitSubmodules|PinGitBlame|PinGitAttribution|PinGitCommitContext|PinGitStranded>} read -
 *   One of the git client's other reads of one repository, read and refused as
 *   `changes` is: `refs` answers a {@link PinGitRefs}, `worktrees` a
 *   {@link PinGitWorktrees}, `log` one page of its history as `log` asks
 *   ({@link PinGitLog}), `commit` the commit `commit` names
 *   ({@link PinGitCommit}), `submodules` its submodules
 *   ({@link PinGitSubmodules}), and `blame` which commit last changed each
 *   line of the file `blame` names ({@link PinGitBlame}). `attribution` answers
 *   which conversations made what is staged, best first
 *   (`{staged, conversations: [{conv, title, strong, weak, prior, files}]}`),
 *   scored for an amend of HEAD when `amend` is set, with `conv` (the visible
 *   conversation) breaking ties; `commit-context` answers what a commit
 *   message is written from — the staged files, stat, diff cut to size,
 *   recent subjects and the project's commit rules — for an amend of HEAD
 *   when `amend` is set; `stranded` answers how many commits only the full
 *   ref `ref` names reaches — what deleting it would leave unreachable
 *   ({@link PinGitStranded}).
 * @property {(conv: string, paths: string[], options?: {repo?: string, workspace?: string, signal?: AbortSignal}) => Promise<PinGitDigest>} digest -
 *   One conversation's account of why files changed, for a commit message: its
 *   user messages, and the turns that touched `paths` with the agent's closing
 *   message of each. Read-only; a conversation the project lacks rejects.
 * @property {(op: PinGitOp, options?: {workspace?: string}) => Promise<PinGitJob>} run -
 *   Start one write and wait for it to end. Resolves with the job once it is
 *   done. Rejects, when it failed or was cancelled, with an Error whose `job` is
 *   the job, whose `kind` is `job.errorKind`, and whose message is the server's
 *   reason, ready to show. A write the server would not start at all rejects
 *   with the request's error, which has no `job`. Without a `workspace` it
 *   writes to the tree in view at the moment of the call; a job already out stays
 *   with its own tree, and runs to its end even if the pin goes away.
 * @property {(id: string, options?: {workspace?: string}) => Promise<PinGitJob>} cancel -
 *   Ask the server to stop a job, by `job.id`, in the tree it runs in. Resolves
 *   with the job as it stood once asked; a `run` waiting on it rejects once it
 *   has stopped.
 * @property {(options?: {workspace?: string}) => Promise<PinGitJob[]>} jobs -
 *   A tree's jobs: every one running and the last hundred finished, newest
 *   first. What a command log starts from before `watch` adds to it.
 * @property {(options?: {repo?: string, workspace?: string}) => Promise<PinGitJob|null>} fetchOnShow -
 *   The fetch a git client makes the first time it shows a repository: one per
 *   repository per server session, whichever of its trees or pins asks first.
 *   Resolves with the fetch once it is done, or null when the repository was
 *   fetched this way before. Rejects as `run` does; the fetch is `auto`, and
 *   never asks for credentials.
 * @property {(id: string, reply: {prompt: string, answer?: string, decline?: boolean}, options?: {workspace?: string}) => Promise<PinGitJob>} answer -
 *   Answer the question job `id` is waiting on — `prompt` is its `prompt.id` —
 *   with `answer` ('yes' for a confirm), or decline it. The first answer from
 *   any window is the one taken; one to a question already answered, or no
 *   longer asked, rejects. Resolves with the job as it then stands. The answer
 *   goes to git and nowhere else: no job, frame or log holds it.
 * @property {(listener: (event: PinGitWatchEvent) => void, options?: {workspace?: string}) => (() => void)} watch -
 *   Hear every git event of one tree: its changes, its jobs, and a resync when
 *   what you read may be stale with no change to say so. Without a `workspace`,
 *   the tree in view, moving with the user. Returns an unsubscribe function;
 *   the host also drops the subscription when the pin is torn down.
 */

/**
 * One side of one file's change, in lines.
 * @typedef {object} PinGitChangeStat
 * @property {number} added - Added lines
 * @property {number} removed - Removed lines
 */

/**
 * One changed file in {@link PinGitChanges}. `index` and `worktree` are git's
 * porcelain letters for each side — '.' for an unchanged side, '?' for an
 * untracked file — and a file staged and then edited again has both.
 * @typedef {object} PinGitChangedFile
 * @property {string} path - File path relative to the repository
 * @property {string} [oldPath] - Former path, for a rename or copy
 * @property {string} index - The staged side's letter
 * @property {string} worktree - The unstaged side's letter
 * @property {boolean} [conflicted] - Whether it is an unresolved merge
 * @property {boolean} [submodule] - Whether the path is a submodule
 * @property {boolean} [binary] - Whether git judged it binary
 * @property {boolean} [lfs] - Whether it is stored in Git LFS
 * @property {PinGitChangeStat} [staged] - The index against HEAD; absent when
 *   that side has no line changes (a binary file never has one)
 * @property {PinGitChangeStat} [unstaged] - The working tree against the index; absent likewise
 */

/**
 * The operation in progress in a tree, as the Operation banner says it.
 * @typedef {object} PinGitStopped
 * @property {'merge'|'rebase'|'cherry-pick'|'revert'} kind - What it is
 * @property {string} [branch] - The branch it changes; for a rebase, the one being rebased
 * @property {string} [other] - The other side by name: the branch merged in or
 *   rebased onto; absent when no branch points there
 * @property {string} [otherSha] - The other side's commit
 * @property {{sha: string, subject: string}} [commit] - The commit being applied
 * @property {number} [step] - How far a rebase has got: the commit it is on
 * @property {number} [steps] - Of how many
 * @property {string} [from] - Where a rebase's branch was before it began, which aborting puts it back to
 * @property {string} [setAside] - The stash the tree's changes wait in until it ends
 * @property {boolean} [between] - A pick or revert of several commits stopped between them:
 *   no `commit` is being applied, and continuing goes on to the rest
 * @property {number} [left] - Commits of a pick or revert sequence still to come after this one
 */

/**
 * One repository's changes, as `changes()` reads them.
 * @typedef {object} PinGitChanges
 * @property {string} repo - The repository, '' for the root
 * @property {string} branch - Current branch, '' on a detached head
 * @property {string} upstream - Tracking branch, '' when there is none
 * @property {number} ahead - Commits this branch has that its upstream does not
 * @property {number} behind - Commits its upstream has that this branch does not
 * @property {boolean} detached - Whether HEAD is detached
 * @property {boolean} initial - Whether the repository has no commits yet
 * @property {{sha: string, message: string, pushed: boolean}} [head] - The commit
 *   HEAD names, absent before the first: what an amend starts from, and whether
 *   it has been pushed (and so is no longer the user's alone to undo)
 * @property {boolean} wrapsBody - Whether this repository's commit bodies are
 *   wrapped, so a commit box can follow suit
 * @property {string} [operation] - A merge, rebase or the like in progress
 * @property {PinGitStopped} [stopped] - That operation in full; absent when there is none
 * @property {number} remotes - How many remotes the repository has: fetching,
 *   pulling and pushing need one
 * @property {PinGitChangedFile[]} files - Every changed file
 * @property {boolean} truncated - Whether there are more files than listed
 */

/**
 * A repository's branches, its remotes' branches, its tags and its stashes —
 * the same for every worktree of it. Stashes are named by `sha`, never by
 * position. `fetchedAt` is when it last fetched (ms, 0 for never).
 * @typedef {object} PinGitRefs
 * @property {string} repo - The repository
 * @property {{name: string, sha: string, subject: string, date: number, upstream?: string, ahead: number, behind: number, gone?: boolean, worktree?: string, head?: boolean}[]} branches -
 *   Local branches; `worktree` is the tree that has one out, anywhere on disk,
 *   and `head` whether that is the tree read
 * @property {{name: string, branches: {name: string, sha: string, subject: string, date: number}[]}[]} remotes -
 *   Each remote, with its branches named without it
 * @property {{name: string, sha: string, target: string, annotated: boolean, subject: string, date: number}[]} tags -
 *   Newest first; `sha` is the tag's object, `target` its commit
 * @property {{sha: string, message: string, date: number}[]} stashes - Newest first
 * @property {number} fetchedAt - When it last fetched
 * @property {boolean} truncated - Whether a section was cut short
 */

/**
 * One read of a repository's history. The server keeps the list a client is
 * reading as a graph session: the first read opens one (leave `graph` out)
 * and names it in its answer; pass that `graph` back for every later page of
 * the same list. One the server has dropped is opened again for the rest of
 * the query, under a new id — so a new id means the rows you hold are gone.
 * @typedef {object} PinGitLogQuery
 * @property {string} [graph] - The session an earlier read named
 * @property {'head'|'all'|'ref'|'reflog'} [scope] - What HEAD reaches (the default), every
 *   branch, remote branch, tag and worktree HEAD, what `ref` reaches, or where the
 *   tree's HEAD has been (its reflog, newest first, each commit once, flat)
 * @property {string} [ref] - The ref, for the `ref` scope
 * @property {string} [message] - Only commits whose message holds this text, any case
 * @property {string} [author] - Only commits whose author holds this text, any case
 * @property {string} [path] - Only commits that changed this path, followed across renames
 * @property {number} [offset] - The first row wanted
 * @property {number} [limit] - How many rows (200 when left out, at most 1000)
 * @property {boolean} [refresh] - Catch up with refs that moved first: new commits
 *   arrive on top, ones nothing reaches leave, and `gen` moves on
 * @property {string} [find] - A full commit id to find in the list (`found`)
 */

/**
 * One commit of a history, and where the graph puts it: `lane` is its dot's
 * column, and `out` the column each of its parents continues in, in parent
 * order.
 * @typedef {object} PinGitLogRow
 * @property {string} sha - The commit
 * @property {string[]} parents - Its parents, first first
 * @property {string} author - Its author's name
 * @property {string} email - Its author's email
 * @property {number} date - Its author time, Unix seconds
 * @property {string} subject - Its message's first paragraph
 * @property {number} lane - Its dot's lane (0 in a flat list)
 * @property {number[]} out - Its parents' lanes (empty in a flat list)
 * @property {string} [reflog] - In the reflog scope, git's words for the entry
 *   ('commit: …', 'reset: moving to …'); `date` is then the entry's time
 */

/**
 * One page of a history. Lanes never move: every lane in `lanes` other than a
 * row's own passes straight through it, and the lanes entering the next row
 * are these without the row's `lane`, with its `out` — so any page can be
 * drawn by itself. A list filtered by message, author or path is flat
 * (`graphed` false).
 * @typedef {object} PinGitLog
 * @property {string} graph - The session to pass back for the next page
 * @property {number} gen - Moves on whenever the rows moved under the session; rows of
 *   another generation are not where they were
 * @property {number} offset - The first row's position
 * @property {PinGitLogRow[]} rows - The rows
 * @property {number[]} lanes - The lanes occupied entering `rows[0]`, in order
 * @property {boolean} more - Whether there are rows past this page
 * @property {number} total - How many rows the list holds, -1 while counting
 * @property {boolean} graphed - Whether the rows carry lanes
 * @property {number} found - Where `find` is in the list, -1 if it is not
 */

/**
 * One commit as a history's detail shows it, and every file it changed
 * against its first parent (the tree of nothing, for a root commit). `scope`
 * is that comparison as a review scope (`<sha>^!`): pass it to `diff` for one
 * file's change. `files` are lettered as a review's are, the change on the
 * `worktree` side.
 * @typedef {object} PinGitCommit
 * @property {string} repo - The repository
 * @property {string} sha - The commit
 * @property {string[]} parents - Its parents, first first
 * @property {{name: string, email: string, date: number}} author - Who wrote it, and when (Unix seconds)
 * @property {{name: string, email: string, date: number}} committer - Who committed it, and when
 * @property {string} subject - Its message's first paragraph
 * @property {string} body - The rest of its message
 * @property {string} scope - The review scope its files compare
 * @property {string} base - The commit (or empty tree) it is compared against
 * @property {string} target - The commit itself
 * @property {PinGitFile[]} files - The files it changed, by path, up to a ceiling
 * @property {number} total - How many files it changed
 * @property {boolean} truncated - Whether `files` stops short of `total`
 */

/**
 * Every working tree of a repository, the main one first. `tree` is the id
 * that views one as a `workspace` option (null when it cannot be viewed: gone,
 * or bare), and `treeRepo` the repository to view within it, by its path there
 * (absent for its root: present when `tree` names the tree a nested
 * repository's checkout is in); `rows` the open workspace rows rooted there.
 * `dirty` is null when the tree's state could not be read.
 * @typedef {object} PinGitWorktrees
 * @property {string} repo - The repository
 * @property {{path: string, head: string, branch?: string, detached?: boolean, bare?: boolean, main?: boolean, current?: boolean, locked?: boolean, lockReason?: string, prunable?: boolean, pruneReason?: string, dirty: number|null, upstream?: string, ahead: number, behind: number, operation?: string, tree: string|null, treeRepo?: string, rows?: string[]}[]} trees -
 *   The trees
 */

/**
 * A repository's submodules: each one `.gitmodules` names and the index records
 * a commit for. `path` is relative to the repository; `recorded` is the commit
 * an update checks out, and `head` and `branch` what is checked out in it now
 * (absent when nothing is). `state` is 'current' (at the recorded commit),
 * 'moved' (at another), 'uninitialized' (not checked out) or 'conflicted' (a
 * merge left its commit in conflict).
 * @typedef {object} PinGitSubmodules
 * @property {string} repo - The repository
 * @property {{name: string, path: string, url: string, recorded: string, head?: string, branch?: string, state: 'current'|'moved'|'uninitialized'|'conflicted'}[]} submodules -
 *   The submodules, by path
 * @property {boolean} truncated - Whether there were more than are listed
 */

/**
 * Which commit last changed each line of a file: `lines[i]` is the index in
 * `commits` of line i+1's. `rev` is the revision blamed — a commit, '' for
 * the working tree, '@staged' for the index — and a commit with `sha` '' holds
 * the lines nobody has committed yet.
 * @typedef {object} PinGitBlame
 * @property {string} repo - The repository
 * @property {string} path - The file
 * @property {string} rev - The revision blamed
 * @property {{sha: string, author: string, date: number, summary: string}[]} commits -
 *   The commits, each once; `date` its author time, Unix seconds
 * @property {number[]} lines - Each line's commit, by index
 */

/**
 * The session's workspaces, as a pin that shows trees needs them. Making,
 * finishing and adopting one are the workspace machinery's: each opens what the
 * rest of the app opens for it, and the user still confirms there.
 * @typedef {object} PinWorkspaces
 * @property {() => {id: string, label: string, root: string, providerId: string, state: string, meta: Record<string, unknown>}[]} list -
 *   Every row, closed ones included
 * @property {() => string} followed - The workspace id the visible conversation works in, '' for the project
 * @property {(listener: () => void) => (() => void)} onChange - Hear the table,
 *   the conversations in it or the followed tree change
 * @property {(id: string) => {id: string, title: string}[]} conversationsOf - The conversations that work in a workspace
 * @property {(conversationId: string) => Promise<boolean>} showConversation - Bring a conversation's tab forward
 * @property {(request: {providerId: string, values?: Record<string, unknown>}) => Promise<{created: boolean, workspaceId?: string}>} create -
 *   Open the create dialog on a provider's form, filled in with `values`
 * @property {(id: string) => {options: {id: string, label: string, description?: string, danger?: boolean}[], unavailableReason?: string}} finishOptions -
 *   A workspace's endings, as its provider offers them
 * @property {(id: string, optionId: string) => Promise<unknown>} finish - Carry out
 *   one, with the confirmation or question the panel would ask; null when it was
 *   called off
 * @property {(tree: {path: string, branch?: string}) => Promise<unknown>} adopt -
 *   Register a tree a provider found and nothing names; null when none offers it
 * @property {(request: {message: string, name?: string, workspace?: string}) => Promise<string>} startConversation -
 *   Open a new visible conversation working in `workspace` ('' for the
 *   project), switch to it and send `message` as its first message; resolves
 *   with its id
 */

/**
 * One write, as `run` takes it. `kind` says what to do, and which other fields
 * matter is the kind's business; every path is relative to the repository.
 *
 * - `stage`, `unstage`, `discard`: `paths`. A discard is recoverable: the job's
 *   `result.discard` is what an `undo-discard` names in `discard`.
 * - `stage-all`, `unstage-all`: nothing more.
 * - `stage-lines`, `unstage-lines`, `discard-lines`: `path`, `lines`, and the
 *   `context` and `revision` of the diff the lines were chosen on — a different
 *   revision refuses the write, since the same numbers would be other lines.
 * - `ignore`: `paths[0]` and `pattern`.
 * - `commit`: `message`, and `amend` or `all`. `result.head` is the new commit.
 * - `undo-commit`: `expectHead`, the commit it undoes.
 *
 * The Refs place's writes name a branch, tag or stash as the client saw it —
 * `expectSha` for a branch or tag, the stash's commit in `stash` — and one that
 * has moved since is refused as 'stale'. `dirty` says what to do with local
 * changes in the way: 'carry' them (refused as 'dirty' if git would overwrite
 * them) or 'stash' them first.
 *
 * - `branch-create`: `name`, `rev` (default HEAD), `switch`.
 * - `switch`: `branch`; with `track`, a new `branch` tracking `rev`; with
 *   `detach`, `rev`. `dirty`; `result.stash` is a stash it made.
 * - `branch-rename`: `branch` to `name`. `branch-upstream`: `branch` and
 *   `upstream` ('' unsets it).
 * - `branch-delete`: `branch`, `expectSha`, `force` for an unmerged one.
 *   `result.sha` is what a `ref-restore` names in `sha`.
 * - `merge`, `rebase`: `rev`, `dirty`.
 * - `fast-forward`: `branch`, `expectSha`, `rev` (default its upstream).
 * - `ref-restore`: `ref` (refs/heads/… or refs/tags/…) and `sha`, only if
 *   the ref does not exist.
 * - `stash-save`: `message`, `untracked`. `stash-apply`, `stash-pop`,
 *   `stash-drop`: `stash`; a drop's `result.stash` and `result.message` are
 *   what `stash-store` takes back. `stash-branch`: `stash`, `name`.
 * - `tag-create`: `name`, `rev`, and `message` for an annotated tag.
 *   `tag-delete`: `name`, `expectSha`; `result.sha` as for a branch.
 * - `worktree-lock` (`reason`), `worktree-unlock`, `worktree-remove`
 *   (`force`; a dirty tree's changes are saved first, in `result.saved`):
 *   `worktree`, a path. `worktree-prune`: nothing more.
 *
 * The History place's writes act on the current branch:
 *
 * - `cherry-pick`, `revert`: `rev` (a merge against its first parent),
 *   `dirty` as for a merge. One that would change nothing is refused.
 * - `reset`: the current branch, at `expectHead`, to `rev`; `mode` 'soft',
 *   'mixed', 'hard', or 'keep' (the files `rev` changes moved, local changes to
 *   the rest kept; refused as 'dirty' when they overlap). `result.sha` is its old tip, which resetting back
 *   names. A hard reset saves the changes it throws away first, in
 *   `result.saved`; a hard reset back naming that save in `discard` writes
 *   them back (not what was staged), refused as 'dirty' if the tree has changed.
 *
 * The rewrites act on the current branch at `expectHead`, on commits it holds.
 * `result.sha` is its old tip, which a `reset` back to undoes. Rewriting a
 * commit a remote-tracking branch has is refused as 'published' unless `force`.
 *
 * - `reword`: `rev`'s message to `message`. `squash`: the run of commits from
 *   `rev` to `sha` (either way round, no merge in it) into one, with their
 *   messages joined. Neither touches the index or the working tree.
 * - `fixup`: what is staged folded into `rev`; `drop`: `rev` taken out. Both
 *   rebase what follows, so `dirty` is as for a merge, they may stop as
 *   'conflicts', and a merge after `rev` is refused.
 *
 * The Operation place's writes act on the merge, rebase, cherry-pick or revert
 * in progress, named in `operation` as the client saw it ('stale' when another
 * is in progress). Each ends with `result.head`; one that ends the operation
 * puts back the changes a write set aside before it stopped, and a
 * `result.stash` is one that did not go back cleanly.
 *
 * - `operation-continue`: refused as 'conflicts' while anything is unmerged;
 *   a merge is committed with git's message, and the others go on, stopping as
 *   'conflicts' on the next commit that conflicts.
 * - `operation-skip`: drops the commit a rebase, pick or revert stopped on.
 * - `operation-abort`: back to where it started.
 * - `operation-quit`: a cherry-pick or revert forgotten, with the rest of its
 *   sequence; HEAD, the index and the working tree are left as they are.
 * - `resolve`: `path`'s conflict, by `mode` — 'ours' or 'theirs' takes that
 *   side's version (no file, for a side that deleted it), 'resolved' stages
 *   the file as it is, refused as 'markers' while it still has conflict
 *   markers unless `force`. The working file is saved first; `result.discard`
 *   names the save.
 * - `unresolve`: undoes a resolve while the operation is in progress — `path`
 *   conflicted again, and the save named in `discard` written back; 'stale'
 *   if the file has changed since.
 *
 * The writes that talk to a remote run one at a time per repository, beside
 * its local writes rather than queued behind them, and report their meter in
 * the job's `progress`.
 *
 * - `fetch`: every remote, pruned.
 * - `pull`: the current branch from its upstream, as a fast-forward; one that
 *   can't be is refused as 'diverged', and `mode` 'merge' or 'rebase' says how
 *   to bring it in instead. `dirty` as for a merge.
 * - `push`: `branch` (default the current one) to its upstream; one with none
 *   is published — pushed to `remote`, or the repository's obvious one, and
 *   tracked. With `force`, only over `expectSha`, the remote sha the user saw.
 * - `push-tag`: tag `name`, to `remote` or the obvious one.
 * - `remote-branch-delete`: `ref`, a remote-tracking branch ('origin/feat'), at
 *   `expectSha`.
 * - `submodule-update`: the submodule at `path` checked out at the commit the
 *   repository records — cloned first if it never was, and that commit fetched
 *   if it lacks it. `result.sha` and `result.branch` are where its HEAD was
 *   ('' for one not checked out): a `switch` of the submodule's own repository
 *   back to them undoes it. Refused as 'dirty' when local changes are in the way.
 * @typedef {object} PinGitOp
 * @property {'stage'|'unstage'|'stage-all'|'unstage-all'|'stage-lines'|'unstage-lines'|'discard'|'discard-lines'|'undo-discard'|'ignore'|'commit'|'undo-commit'|'branch-create'|'switch'|'branch-rename'|'branch-upstream'|'branch-delete'|'merge'|'rebase'|'fast-forward'|'ref-restore'|'stash-save'|'stash-apply'|'stash-pop'|'stash-drop'|'stash-store'|'stash-branch'|'tag-create'|'tag-delete'|'worktree-lock'|'worktree-unlock'|'worktree-remove'|'worktree-prune'|'fetch'|'pull'|'push'|'push-tag'|'remote-branch-delete'|'submodule-update'|'cherry-pick'|'revert'|'reset'|'reword'|'squash'|'fixup'|'drop'|'operation-continue'|'operation-skip'|'operation-abort'|'operation-quit'|'resolve'|'unresolve'} kind - What to do
 * @property {string} repo - The repository, '' for the root
 * @property {string[]} [paths] - The files
 * @property {string} [path] - The file, for the lines kinds
 * @property {{old?: number, new?: number}[]} [lines] - The chosen lines, by their number on each side
 * @property {string} [context] - The context the lines' diff was read at
 * @property {string} [revision] - That diff's revision
 * @property {'file'|'extension'|'folder'} [pattern] - What an ignore covers
 * @property {string} [message] - A commit's message
 * @property {boolean} [amend] - Whether a commit amends HEAD
 * @property {boolean} [all] - Whether a commit takes everything rather than what is staged
 * @property {string} [expectHead] - The HEAD an undo-commit undoes, or a reset moves from
 * @property {string} [discard] - The discard an undo-discard restores, or the save a hard reset back or an unresolve writes back
 * @property {string} [branch] - The branch
 * @property {string} [name] - A new branch's, tag's or name's name
 * @property {string} [rev] - A revision: where to start, what to merge
 * @property {string} [upstream] - An upstream such as 'origin/main'
 * @property {string} [ref] - The ref a ref-restore restores
 * @property {string} [sha] - The object it restores it to; the other end of a squash
 * @property {string} [stash] - A stash, by its commit
 * @property {string} [worktree] - A worktree, by its path
 * @property {string} [reason] - Why a worktree is locked
 * @property {string} [expectSha] - Where the client saw the branch or tag
 * @property {'carry'|'stash'} [dirty] - What to do with local changes in the way
 * @property {boolean} [force] - Delete an unmerged branch; remove a dirty or locked worktree; mark a file with conflict markers resolved; rewrite a published commit
 * @property {boolean} [switch] - Switch to the branch made
 * @property {boolean} [track] - Make the branch track `rev`
 * @property {boolean} [detach] - Switch to `rev` detached
 * @property {boolean} [untracked] - Stash untracked files too
 * @property {string} [remote] - The remote a publish or a tag goes to
 * @property {'merge'|'rebase'|'soft'|'mixed'|'hard'|'keep'|'ours'|'theirs'|'resolved'} [mode] - How a pull brings in what it can't fast-forward to; what a reset keeps; how a conflict is resolved
 * @property {'merge'|'rebase'|'cherry-pick'|'revert'} [operation] - The operation in progress the client saw
 */

/**
 * One write as the server reports it.
 * @typedef {object} PinGitJob
 * @property {string} id - Identifies it, for `cancel`
 * @property {string} workspace - The tree it runs in, '' for the project
 * @property {string} repo - The repository
 * @property {PinGitOp['kind']} kind - What it does
 * @property {string[][]} commands - Every git command run so far, as argv after `git`
 * @property {string} state - 'running', 'done', 'failed' or 'cancelled'
 * @property {string} output - The tail of what hooks printed
 * @property {string} [error] - Why it failed, in English
 * @property {{key: string, params?: Record<string, unknown>, context?: string}} [errorMessage] -
 *   The same, for `serverText()`
 * @property {string} errorKind - Which refusal it was: 'refused' (the write did
 *   not make sense), 'stale' (what it was chosen on has moved), 'locked'
 *   (another git holds the lock), 'dirty' (local changes are in the way),
 *   'unmerged' (a branch delete that needs `force`), 'checked-out' (the branch
 *   is out in `worktree`), 'conflicts' (it stopped on them), 'markers' (a file
 *   marked resolved still has conflict markers), 'diverged' (it
 *   can't fast-forward), 'rejected' (the remote turned a push down), 'remote'
 *   (a publish needs to be told which remote), 'auth' (the remote was not
 *   signed in to: a question declined, a password refused, no key it takes) or
 *   'published' (a rewrite of a commit a remote has, which needs `force`);
 *   '' for any other failure
 * @property {string} [lockPath] - The lock a 'locked' job was stopped by
 * @property {string} [branch] - The branch an 'unmerged' or 'checked-out' refusal is about
 * @property {string} [worktree] - The tree a 'checked-out' branch is out in
 * @property {boolean} [auto] - Started unasked, by `fetchOnShow`: its failure is quiet
 * @property {{phase: string, remote?: boolean, percent: number, done: number, total?: number, rate?: string, finished?: boolean}} [progress] -
 *   A network write's latest meter reading: git's English `phase` ('Receiving
 *   objects'), said by the remote end when `remote` is set, and how far
 *   through it (`percent` -1 when git gives only a count)
 * @property {string} [prefer] - The way into a 'diverged' pull the repository puts first, 'merge' or 'rebase'
 * @property {string[]} [rejected] - The remote refs a 'rejected' push was turned down for
 * @property {string} [reason] - Git's word for why ('fetch first', 'non-fast-forward', a hook's complaint)
 * @property {string[]} [remotes] - The remotes a 'remote' publish could go to
 * @property {{id: string, text: string, kind: string}} [prompt] -
 *   The question a network write is waiting on the user to answer — git's or
 *   ssh's own words in `text`: a username to type in the open ('text'), a
 *   password or passphrase to type masked ('secret'), or a yes or no
 *   ('confirm'). Answer it with `answer`. Gone once answered, from anywhere.
 * @property {{head?: string, discard?: string, sha?: string, stash?: string, message?: string, saved?: string, branch?: string}} result -
 *   What it left to know: the commit HEAD names after a commit or undo, a
 *   discard's recovery point, and what undoing a delete, drop or stash needs
 */

/**
 * What `watch` hands its listener, told apart by `type`:
 *
 * - `git-change`: some of the tree's git state moved. `repos` names each
 *   repository by its path in the tree ('' for the root) and which parts
 *   changed: 'index', 'refs', 'head', 'worktree', 'operation'. It carries no
 *   status; read again what those parts affect.
 * - `git-job`: a job in the tree changed state or printed output; `job` is it as
 *   it now stands.
 * - `git-resync`: anything read before may be stale with no change to say so —
 *   the watch moved to another tree, or the connection was re-established. Read
 *   everything again.
 * @typedef {{type: 'git-change', workspace: string, repos: {path: string, kinds: string[]}[]}
 *   | {type: 'git-job', workspace: string, job: PinGitJob}
 *   | {type: 'git-resync', workspace: string}} PinGitWatchEvent
 */

/**
 * One process a conversation in this project has running: a background task, or
 * a command a tool call is still waiting on.
 * @typedef {object} PinTask
 * @property {string} taskId - The process's id, as `stop` takes it
 * @property {'background'|'foreground'|'python'} kind - How it was started: left
 *   running in the background (`bash` with `run_in_background`, `Monitor`, an
 *   extension's long-lived server), a shell command a tool call is waiting on, or
 *   python code
 * @property {string} conversationId - The conversation that started it; '' when
 *   nothing said (an extension that started a task for no conversation)
 * @property {string} conversationTitle - That conversation's name, for display.
 *   '' when it has none this viewer knows of.
 * @property {string|null} threadId - The thread it was started in, null for the root
 * @property {string} toolUseId - The tool call that started it, '' when none did
 * @property {string} itemId - The tool action that started it, when its
 *   conversation is loaded in this viewer; '' otherwise. `reveal` does not need
 *   it — pass the task — but a pin may use it to tell whether the row is at hand.
 * @property {string} toolName - The tool that started it, as the transcript names
 *   it; '' when the conversation is not loaded here
 * @property {string} command - The command line it is running (for python, its
 *   first line). Unbounded — it is whatever was typed — so give it a bounded
 *   space rather than trusting it to be short.
 * @property {string} label - What it was started for, when the tool was asked to
 *   say and its conversation is loaded here. Empty otherwise.
 * @property {number} at - Unix ms it was started
 */

/**
 * Everything the conversations in this project have running, right now — the
 * session's task manager.
 *
 * **A live inventory, not a history.** A task appears when its process starts
 * and leaves the list the moment it ends, however it ended. That is the whole
 * retention policy, and it is deliberate: the transcript is where a task's
 * history lives, so a task that failed is gone from here and still says so —
 * with its output, its exit code and its approval — on the tool action that
 * started it. Which is what `reveal` is for.
 *
 * The server is the only source. It keeps the inventory and pushes it whenever
 * it changes, so the list is neither polled nor rebuilt from a transcript —
 * which could never say what is still running, because the durable snapshot
 * beside a tool action freezes at whatever it last said. Nothing survives a
 * server restart, and the list says so by being empty.
 *
 * It lists processes Juggler started, not processes on the machine: something a
 * command daemonised, or anything started outside Juggler, is not here.
 * @typedef {object} PinTasksService
 * @property {() => PinTask[]|null} list - The tasks running as of the last word
 *   from the server: the conversation being read first, then newest first. Null
 *   when nothing has come back yet. Null is not an empty list: say you are still
 *   looking rather than claiming nothing is running.
 * @property {() => string} error - The last listing's failure, or ''. The previous
 *   list is kept beside it, because a transient failure should not empty a
 *   working display — show both.
 * @property {(listener: () => void) => (() => void)} onChange - Called when the
 *   list may have changed, including when the conversation being read changes
 *   (which reorders it). Carries nothing: call `list`. Returns an unsubscribe
 *   function; the host also drops the subscription on teardown. The host listens
 *   only while something is watching.
 * @property {(task: PinTask|string) => void} reveal - Go to the tool action that
 *   started a task, switching to its conversation first and opening whatever
 *   columns it takes to reach it. Like every reveal, it happens in the window
 *   that has the columns — a detached board's goes back to the window that opened
 *   it. An item id is still accepted, and selects that item in the conversation
 *   on screen.
 * @property {(taskId: string) => Promise<void>} stop - Stop a running task.
 *   Rejects if it could not be asked to stop, so show what came back. The host
 *   picks how — a `Monitor`'s task, a plain background task and a foreground
 *   command are stopped by different means — and you do not need to know which.
 *   A stopped foreground command's tool action reports "Killed by user".
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
 * Host services, for data the active-context snapshot does not carry. A pin is
 * a view: it never gets a mutable handle on model state, and it asks the host
 * rather than reaching into it. Reads are cancellable. Most of it is read-only;
 * what writes is listed here, and each acts only at the user's request.
 *
 * `tasks.stop` acts on a process rather than on any model state, on a surface
 * the conversation already offers a Stop button for.
 *
 * `git.run` and `git.cancel` write to the user's repository — stage, discard,
 * commit — which is what a git client is for. They write nothing of Juggler's
 * own: each write is one job on the server, run there under the checks every
 * write to that tree passes, and a discard keeps what it discarded.
 *
 * `review.save`, `review.clear` and `review.compose` are narrow in a different
 * way: what they write is the user's own unsent text, at
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
 * @property {PinGitService} git - The project's git working tree, and writes to it
 * @property {PinTasksService} tasks - The background tasks this conversation is running
 * @property {PinReviewService} review - The unsent review comments on the thread being read
 * @property {PinWorkspaces} workspaces - The session's workspaces, and what makes and finishes them
 */

/**
 * Everything `mount()` and `update()` receive.
 * @typedef {object} PinContext
 * @property {{id: string, type: string, config: Record<string, unknown>}} pin - This pin instance
 * @property {PinActiveContext} active - Immutable active-context snapshot
 * @property {PinServices} services - Host services
 * @property {AbortSignal} signal - Aborted when the pin is torn down; every fetch must honour it
 * @property {(nextConfig: Record<string, unknown>, options?: PinConfigWriteOptions) => Promise<void>} updateConfig -
 *   Persist new config for this pin. A changed config mounts the pin afresh, which is
 *   what a pin wants when the change is a different thing to show; pass `inPlace`
 *   when it is merely writing down where the reader has got to.
 * @property {unknown} [viewState] - What this pin's controller returned from
 *   `saveViewState()` the last time it was torn down in this viewer, or undefined.
 *   Treat it as a stranger's input: the files it names may have gone since.
 */

/**
 * How `updateConfig` writes.
 * @typedef {object} PinConfigWriteOptions
 * @property {boolean} [inPlace] - The pin is already showing this config — it has
 *   just opened a folder, say, and is recording that — so the store's echo of it
 *   must not rebuild the pin. A change made anywhere else still does.
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
 * @property {() => unknown} [saveViewState] - Called as the pin is torn down — the
 *   user switched tabs, or the board was rebuilt — for whatever should put it back
 *   where the reader left it: the scroll of a scroller of its own (the board
 *   remembers only its body's), a selection. Handed back as `viewState` on the next
 *   mount. Kept in memory by this viewer, never persisted and never shared, so it
 *   is the place for state that changes on every scroll tick; what should survive
 *   a reload belongs in config. Never called for a retained pin, which keeps its
 *   state by never being torn down.
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
 * (a hot reload, the user switching tabs), and the same board is
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
   * @returns {boolean} False when this type's manifest asks for no item toolbar.
   */
  get drawsToolbar() {
    return this.getManifest().toolbar !== false;
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
   * @param {{active: PinActiveContext, initialConfig?: Record<string, unknown>, signal: AbortSignal}} options - Configuration request.
   * @returns {Promise<Record<string, unknown>|null>} The new config, or null if cancelled.
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
   * @param {Record<string, unknown>} config - The pin's normalized config.
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
   * @param {Record<string, unknown>} config - The stored or supplied config.
   * @returns {Record<string, unknown>|null} The normalized config, or null to reject it.
   */
  normalizeConfig(config) {
    return config;
  }

  /**
   * Whether two configs name the same thing, so the host can reveal the existing
   * pin instead of adding a duplicate. Both configs are already normalized.
   * Defaults to a shallow JSON comparison.
   * @param {Record<string, unknown>} a - One config.
   * @param {Record<string, unknown>} b - The other config.
   * @returns {boolean} True when the two configs describe the same pin.
   */
  isSameConfig(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * Cheap title/subtitle/badge for the tab and item toolbar. Called often, including
   * while the board is being laid out, so it must not do work — read the config, not
   * the filesystem. Defaults to the manifest name.
   * @param {Record<string, unknown>} config - The pin's normalized config.
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
   * @returns {Record<string, unknown>|null} The config, or null if it cannot be pinned after all.
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
