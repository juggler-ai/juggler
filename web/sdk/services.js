//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The host services every extension surface is handed: a pin's
 * `context.services`, an info card's `mount(contentEl, session, {services})`
 * and a workspace provider's `ctx.services`. One object for all three; what is
 * a pin's alone — its config, view state and active-context snapshot — stays on
 * the pin's context. Where a service says "the thread being read", a pin means
 * its board's, and a card or provider the window's visible conversation and the
 * thread focused in it. Typedefs only.
 * @module sdk/services
 */

/**
 * One file the host was told about while an extension was watching.
 * @typedef {object} FileChange
 * @property {string} path - Absolute path of the file that changed
 * @property {'write'|'create'|'remove'|'rename'} event - What happened to it
 */

/**
 * Notification that files on disk changed, for a surface showing one of them. Only
 * files inside the open project are reported, and hidden files are not: the
 * watcher is rooted at the project and skips dot-files. A surface on anything else
 * will hear nothing, so offer the user a way to re-read rather than trusting this
 * to be complete. Do not poll for changes it does not report. The one exception
 * is a surface whose path does not exist yet: it may stat that path, backing off,
 * while it is visible and until something appears. Changes to an existing
 * file still come only from this service or from the user.
 * @typedef {object} FilesService
 * @property {(listener: (changes: FileChange[]) => void) => (() => void)} onChange -
 *   Watch for file changes. Returns an unsubscribe function; the host also drops
 *   the subscription when what it was handed for ends, so forgetting it leaks nothing.
 */

/**
 * Which thread a context item was found on.
 * @typedef {object} ContextItemSource
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
 * A context item as the host hands it out: a copy of what it holds, and where it was
 * found. It is a snapshot, not a handle — mutating `data` changes nothing, and
 * the next call returns fresh values.
 * @typedef {object} ContextItemSnapshot
 * @property {string} id - The context item's id
 * @property {string} type - Its item-type id, e.g. 'plan'
 * @property {Record<string, unknown>} data - A deep copy of its stored data
 * @property {ContextItemSource} source - The thread it came from
 */

/**
 * The context items of the conversation being read. An extension is a view of a
 * conversation it does not own, so this hands out copies and never the model.
 *
 * `find` resolves like the columns do: the thread the user is looking at first,
 * then its ancestors, nearest first, ending at the root. That is why the result
 * carries its source — a Plan pin showing a parent thread's plan is telling the
 * truth only if it says whose plan it is.
 * @typedef {object} ContextItemsService
 * @property {(type: string, from?: string|null) => ContextItemSnapshot|null} find -
 *   The nearest context item of that type, or null when neither the starting
 *   thread nor any ancestor has one. The walk starts at the thread being read;
 *   pass `from` to start it somewhere else instead — a thread id, or null for
 *   the conversation root — which is how a surface watches one thread rather than
 *   following the reader. Same resolution either way, so the source it reports
 *   is still whichever thread in that chain actually owns the item.
 * @property {(listener: () => void) => (() => void)} onChange - Called when the
 *   items may have changed, or when the focused thread moved. Carries nothing:
 *   call `find` again. Returns an unsubscribe function; the host also drops the
 *   subscription when what it was handed for ends.
 * @property {(threadId: string|null, itemId?: string|null) => void} reveal - Point
 *   the conversation at what the surface is showing. Pass the source's `itemId` and
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
 * The session's workspaces, as a surface that shows trees needs them. Making,
 * finishing and adopting one are the workspace machinery's: each opens what the
 * rest of the app opens for it, and the user still confirms there.
 * @typedef {object} WorkspacesService
 * @property {() => {id: string, label: string, root: string, providerId: string, state: string, meta: Record<string, unknown>}[]} list -
 *   Every row, closed ones included
 * @property {() => string} followed - The workspace id the visible conversation works in, '' for the project
 * @property {(listener: () => void) => (() => void)} onChange - Hear the table,
 *   the conversations in it or the followed tree change
 * @property {(tree: {path: string, branch?: string, rows?: string[]}) => string} forTree -
 *   The open workspace that IS this tree — whose endings are the tree's — or ''
 *   when none is: a tree with no workspace, or one only a group or folder sits
 *   at. Each candidate's provider decides, so a surface never reads another
 *   provider's record. `rows` names the candidates when the caller already
 *   knows which rows are rooted there (a worktree listing says so); without it
 *   the rows rooted at `path` are asked.
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
 * Events the server pushes to the clients that asked, by topic and key — `git`
 * is a tree's git state, keyed by workspace id. A key is asked of the server
 * while anything subscribes to it, and every subscription ends with what it was handed for.
 * @typedef {object} TopicsService
 * @property {(topic: string, key: string, listener: (event: unknown) => void, options?: {onResync?: () => void}) => (() => void)} subscribe -
 *   Hear each event of one key, as a copy. `onResync` is called on every new
 *   connection, since events sent while cut off were lost: read again. Returns
 *   an unsubscribe function; the host also drops it on teardown.
 */

/**
 * The question a running job is waiting on the user to answer: `text` in its
 * own words, to be typed in the open ('text'), typed masked ('secret'), or
 * answered yes or no ('confirm'). Gone once answered, from anywhere.
 * @typedef {object} JobQuestion
 * @property {string} id - Identifies it, for `answer`
 * @property {string} text - What is asked
 * @property {string} kind - 'text', 'secret' or 'confirm'
 */

/**
 * One reading of a job's meter: the phase it is in, said by the far end it
 * talks to when `source` is 'remote', and how far through it.
 * @typedef {object} JobProgress
 * @property {string} phase - The phase, in English
 * @property {string} [source] - 'remote' when the far end said it
 * @property {number} percent - How far through, -1 when only a count is known
 * @property {number} done - Units so far
 * @property {number} [total] - Of how many, when known
 * @property {string} [rate] - How fast, when known ('2.00 MiB/s')
 * @property {boolean} [finished] - The phase is over
 */

/**
 * Why a failed job failed.
 * @typedef {object} JobError
 * @property {string} kind - Which of its kind's refusals it was; '' for any other failure
 * @property {string} message - Why, in English
 * @property {{key: string, params?: Record<string, unknown>, context?: string}} [text] -
 *   The same, for `serverText()`
 */

/**
 * Work a feature's route started that the server runs on its own time, to its
 * end, whoever is watching. What it does is its `kind`'s to say, in `detail`
 * while it runs and `result` once it has ended.
 * @typedef {object} Job
 * @property {string} id - Identifies it
 * @property {string} kind - Whose job it is ('git')
 * @property {string} workspace - The workspace it runs in, '' for the project
 * @property {'running'|'done'|'failed'|'cancelled'} state - Where it is; every state but 'running' is final
 * @property {string} output - The tail of what it printed
 * @property {JobProgress} [progress] - Its meter's latest reading
 * @property {JobQuestion} [prompt] - The question it is waiting on, while it waits
 * @property {JobError} [error] - Why it failed, when it did
 * @property {unknown} [detail] - What its kind says of it
 * @property {unknown} [result] - What it left, once ended
 * @property {number} startedAt - When it started, in Unix milliseconds
 * @property {number} [endedAt] - When it ended
 */

/**
 * The server's jobs in one workspace, of every kind. A job is started by its
 * own feature's service (`git.run`); this is everything after.
 * @typedef {object} JobsService
 * @property {(options?: {workspace?: string}) => Promise<Job[]>} list - A
 *   workspace's jobs: every one running and the last hundred ended, newest first
 * @property {(id: string, options?: {workspace?: string}) => Promise<Job|null>} wait -
 *   Resolves with the job once it has ended, in whatever final state, or null
 *   when the server has no such job
 * @property {(id: string, options?: {workspace?: string}) => Promise<Job>} cancel -
 *   Ask the server to stop a job; resolves with it as it stood once asked
 * @property {(id: string, reply: {prompt: string, answer?: string, decline?: boolean}, options?: {workspace?: string}) => Promise<Job>} answer -
 *   Answer the question a job waits on — `prompt` is its `prompt.id` — or
 *   decline it. The first answer from any window is taken; a later one
 *   rejects. The answer goes to the job's work and is kept nowhere.
 * @property {(listener: (job: Job) => void, options?: {workspace?: string}) => (() => void)} watch -
 *   Hear every change of every job of one workspace, the one in view when none
 *   is named. Returns an unsubscribe function; the host also drops it on teardown.
 */

/**
 * One process a conversation in this project has running: a background task, or
 * a command a tool call is still waiting on.
 * @typedef {object} Task
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
 *   it — pass the task — but a surface may use it to tell whether the row is at hand.
 * @property {string} toolName - The tool that started it, as the transcript names
 *   it; '' when the conversation is not loaded here
 * @property {string} command - The command line it is running (for python, its
 *   first line). Unbounded — it is whatever was typed — so give it a bounded
 *   space rather than trusting it to be short.
 * @property {string} label - What it was started for: the tool call's
 *   description when its conversation is loaded here, else the `label` it was
 *   started with. Empty when neither says.
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
 * @typedef {object} TasksService
 * @property {() => Task[]|null} list - The tasks running as of the last word
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
 * @property {(task: Task|string) => Promise<void>|void} reveal - Go to the tool action that
 *   started a task, switching to its conversation first and opening whatever
 *   columns it takes to reach it. Like every reveal, it happens in the window
 *   that has the columns — a detached board's goes back to the window that opened
 *   it. An item id is still accepted, and selects that item in the conversation
 *   on screen. Given a task, it resolves once the reveal has landed.
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
 * @typedef {object} ReviewComment
 * @property {string} id - Identifies the comment for edit and delete
 * @property {string} group - The group of files it belongs to — for Git, the
 *   repository by its path in the tree — '' for the first or only one
 * @property {string} path - The file, relative to that group
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
 * @typedef {object} ReviewDraft
 * @property {number} version - The record's shape. Always 1.
 * @property {'head'} base - What the review compares against. One scope exists.
 * @property {ReviewComment[]} comments - The comments, in the order to show them
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
 * @typedef {object} ReviewService
 * @property {() => ReviewDraft|null} draft - The comments on the thread being
 *   read, as a copy. Null means there is no conversation to hold one — a board
 *   opened on a project with nothing active — which is not the same as a review
 *   with no comments yet, and a surface that treats it as such offers somewhere
 *   to write that quietly discards.
 * @property {(listener: () => void) => (() => void)} onChange - Called when the
 *   draft being read may have changed — saved here, saved in another window, or
 *   a different one now because the reader moved thread. Carries nothing: call
 *   `draft`. Returns an unsubscribe function; the host also drops the
 *   subscription on teardown.
 * @property {(draft: {comments: ReviewComment[]}) => Promise<void>} save -
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
 * A surface's way to call a registered tool's operations as the user's client.
 *
 * It reaches what the agent's tool calls cannot: a tool registered for the
 * client alone (the git tool), and the trees only such a tool may run in, such
 * as another worktree of a repository the user is looking at. That is why it
 * is a service, handed only to what is mounted in a window — pins, info cards,
 * workspace providers — and not part of `juggler/ops`, which a context item
 * running the agent's tool call imports.
 * @typedef {object} OpsService
 * @property {(toolId: string, operation: string, params?: Record<string, unknown>, options?: {workspace?: string, signal?: AbortSignal}) => Promise<unknown>} client -
 *   Run one operation in a workspace ('' or omitted for the project) and
 *   resolve with its answer. It is cancelled by `signal` and by the surface
 *   going away, either of which reaches the server's work. A failure rejects
 *   with the server's message, its translatable form as `serverMessage` and
 *   its code, if any, as `code` ('NO_PROJECT' when no project is open).
 */

/**
 * Host services, the same object for a pin, an info card and a workspace
 * provider. An extension
 * surface is a view: it never gets a mutable handle on model state, and it asks the host
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
 * @typedef {object} Services
 * @property {FilesService} files - Files changing on disk
 * @property {ContextItemsService} contextItems - The conversation's context items
 * @property {JobsService} jobs - The server's jobs, of every kind
 * @property {TasksService} tasks - The background tasks this conversation is running
 * @property {ReviewService} review - The unsent review comments on the thread being read
 * @property {TopicsService} topics - Events the server pushes, by topic and key
 * @property {OpsService} ops - Registered tools' operations, called as the user's client
 * @property {WorkspacesService} workspaces - The session's workspaces, and what makes and finishes them
 */
export {};
