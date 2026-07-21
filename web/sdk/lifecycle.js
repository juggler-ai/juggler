//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/lifecycle` — the contract for an extension **lifecycle module**.
 *
 * A lifecycle module is the lightweight, non-class alternative to a capability
 * class (the same "plain module the host loads and calls" shape as a
 * `systemPrompt` contribution). An extension declares one via manifest
 * `provides.lifecycle: "lifecycle.js"`; its default export is a
 * {@link LifecycleModule} — an object of async hooks the host invokes on
 * conversation lifecycle events.
 *
 * It exists for project-scoped setup/teardown that the capability types cannot
 * express — notably, moving each of a project's git repositories into a
 * per-conversation git worktree (via `juggler/ops` → `bindWorkspace`). Because it
 * fires for every conversation in the project, opt-in is **per project** (enable
 * the extension); it is orthogonal to Strategies (loop autonomy), so it composes
 * with any strategy.
 *
 * This module exports only JSDoc typedefs — annotate your default export with
 * the `LifecycleModule` type (from this module) for editor checking. The hooks
 * themselves call `bindWorkspace`/`unbindWorkspace`/`shell` from `juggler/ops`
 * directly.
 * @module juggler/lifecycle
 */

/**
 * Context passed to every lifecycle hook.
 * @typedef {object} LifecycleContext
 * @property {string} conversationId - The conversation this event is about.
 * @property {string} projectRoot - Absolute path of the current project root.
 */

/**
 * Context passed to `onConversationDeleted`.
 * @typedef {LifecycleContext & {permanent: boolean}} LifecycleDeleteContext
 */

/**
 * The default export of a lifecycle module: async hooks the host invokes. Every
 * hook is optional. A hook that throws is logged and skipped — it never breaks
 * conversation handling.
 * @typedef {object} LifecycleModule
 * @property {(ctx: LifecycleContext) => (void | Promise<void>)} [onConversationActivated]
 *   Called when a conversation first becomes active in this project. Prepare and
 *   bind execution roots here (e.g. create a worktree per repo, then
 *   `bindWorkspace`).
 * @property {(ctx: LifecycleDeleteContext) => (void | Promise<void>)} [onConversationDeleted]
 *   Called when a conversation is deleted. Tear down and `unbindWorkspace`.
 *   `permanent` is false for a bin (soft) delete.
 */

export {};
