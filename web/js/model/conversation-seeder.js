//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a conversation is given before anyone has written in it.
 *
 * Two kinds of seed, applied at two different moments, and both live here:
 *
 * - **Creation defaults** ({@link seedCreationDefaults}) copy the session's
 *   preferences for new tasks (system prompt preset, file-editing permission,
 *   strategy) into the conversation once, at creation, so a later change to a
 *   default never retargets an existing conversation. They depend on nothing
 *   but the session's settings.
 * - **Auto items** ({@link seedConversationAutoItems}) put the always-present
 *   context items on a thread: the assistant files (CLAUDE.md, AGENTS.md, …)
 *   of the tree the conversation works in, and every `autoInstantiate`
 *   context-item type (e.g. project memory). These are root-relative, so they
 *   are run when a conversation is bound to its tree
 *   (`Session.initialiseConversation`), when it moves to another
 *   (`workspace-rebinding.js`) and when `/clear` empties it — all through the
 *   same function, so a freshly created and a just-cleared thread never drift.
 *
 * Every seed is best-effort: a failure is logged or skipped and never blocks
 * the conversation it was for. The functions take the session as an argument
 * rather than living on it, because they read its preferences and workspaces
 * and own none of its state.
 * @module model/conversation-seeder
 */

import contextItemRegistry from '../registries/context-item-registry.js';
import { createBoundOps } from '../../sdk/ops.js';
import { ensureUserPresetsLoaded, getDefaultPresetSeed } from '../services/system-prompt-presets.js';
import { isDefaultFileEditingOn, setFileEditingAllowed } from '../services/file-editing-permission.js';
import { resolveDefaultStrategyId, BUILTIN_DEFAULT_STRATEGY_ID } from '../services/default-strategy.js';
import { workspaceInstructionRoots } from '../services/workspace-provisioning.js';
import { BUILTIN_DEFAULT_ID } from '../../sdk/lib/system-prompt-registry.js';

/**
 * Copy the session's new-task preferences into a freshly created conversation.
 * Run once, at creation, while the conversation is nobody's yet and there is
 * nothing of the user's to write over.
 * @param {import('./session.js').default} session - The session whose preferences apply
 * @param {import('./conversation.js').default} conversation - The new conversation
 * @returns {Promise<void>}
 */
export async function seedCreationDefaults(session, conversation) {
  await seedDefaultSystemPrompt(conversation);
  seedDefaultFileEditing(session, conversation);
  seedDefaultStrategy(session, conversation);
}

/**
 * Seed a freshly created conversation's system prompt from the user's chosen
 * default preset. Like the model seed, the resolved body is copied into the
 * conversation's system-prompt item at creation time, so a later change to the
 * default never retargets an existing conversation. When no preset content
 * resolves (e.g. offline), the item's own built-in default fallback applies at
 * build time, so nothing is written.
 * @param {import('./conversation.js').default} conversation
 */
async function seedDefaultSystemPrompt(conversation) {
  try {
    await ensureUserPresetsLoaded();
    const { id, content } = getDefaultPresetSeed();
    // The built-in default is exactly what the system-prompt item already
    // falls back to when its stored text is empty, so writing it would only
    // add doc churn. Write only when the chosen default is a different preset
    // (a user preset or another built-in) whose body must travel in the doc —
    // user presets aren't in the engine's registry, so the content can't be
    // resolved there from the id alone.
    if (!content || id === BUILTIN_DEFAULT_ID) return;
    const targetPromptItem = conversation.rootMessageThread.contextItems.find(f => f.type === 'system-prompt');
    if (targetPromptItem) {
      conversation.rootMessageThread.updateContextItem(targetPromptItem.id, {
        data: { ...targetPromptItem.data, text: content, selectedPresetId: id, isModified: false }
      });
    }
  } catch (err) {
    console.warn('[ConversationSeeder] Could not seed default system prompt:', err);
  }
}

/**
 * Seed file-editing permission on a freshly created conversation when the
 * session's "start new tasks with edits allowed" preference is on. The
 * write-file rule is conversation-scoped, so each task still toggles
 * independently and a later change to the default never retargets an existing
 * conversation. When the preference is off (the default) nothing is written and
 * the task starts in the usual ask-before-editing state.
 * @param {import('./session.js').default} session - The session whose preferences and workspaces apply
 * @param {import('./conversation.js').default} conversation
 */
function seedDefaultFileEditing(session, conversation) {
  try {
    if (!isDefaultFileEditingOn(session)) return;
    const mt = conversation.rootMessageThread;
    if (mt) setFileEditingAllowed(mt, true);
  } catch (err) {
    console.warn('[ConversationSeeder] Could not seed default file-editing permission:', err);
  }
}

/**
 * Seed the strategy of a freshly created conversation from the session's
 * "default strategy for new tasks" preference. The resolved id honours what is
 * actually registered (configured pin → built-in `default` → first available),
 * so disabling the built-in Default strategy seeds a real enabled strategy
 * instead of silently landing on the inert fallback. The built-in `default`
 * needs no write — a conversation with no `currentStrategyId` already resolves
 * to it — so we only pin the root thread when the resolved strategy differs,
 * mirroring how the model/system-prompt seeds avoid needless doc churn.
 * @param {import('./session.js').default} session - The session whose preferences and workspaces apply
 * @param {import('./conversation.js').default} conversation
 */
function seedDefaultStrategy(session, conversation) {
  try {
    const strategyId = resolveDefaultStrategyId(session);
    if (!strategyId || strategyId === BUILTIN_DEFAULT_STRATEGY_ID) return;
    const mt = conversation.rootMessageThread;
    if (mt) mt.setStrategy(strategyId);
  } catch (err) {
    console.warn('[ConversationSeeder] Could not seed default strategy:', err);
  }
}

/**
 * AI assistant files to auto-detect
 * @type {string[]}
 */
export const AI_ASSISTANT_FILES = [
  'CLAUDE.md',
  '.claude.md',
  '.cursorrules',
  'AGENTS.md',
  '.instructions'
];

/**
 * Add AI assistant files that exist in the probed tree, and in whatever wider
 * places its provider says also hold instructions for work done there.
 * Checks each file exists before adding, prevents duplicates via FileContentContextItem.mergeOrReplace
 * @param {import('./session.js').default} session - The session whose preferences and workspaces apply
 * @param {import('./conversation.js').default} conversation - Conversation to add files to
 * @param {import('./message-thread.js').default|null} [messageThread] - Target thread; null means root thread
 * @param {{workspaceId?: string}} [options] - Which tree to probe; defaults to the conversation's own binding
 * @returns {Promise<number>} Number of files added
 */
export async function addAIAssistantFiles(session, conversation, messageThread = null, options = {}) {
  // This is a best-effort optional operation - log and continue if prerequisites aren't met
  if (!conversation) {
    console.debug('[ConversationSeeder] Skipping AI assistant file detection: conversation not ready');
    return 0;
  }

  const mt = messageThread || conversation.rootMessageThread;

  // Which tree to look in is the caller's to say, because a conversation is
  // offered its assistant files before it is bound to anything: the tree on
  // offer in a place list is a workspace this conversation does not work in
  // yet, and may never. A bound conversation asks about its own tree by
  // passing nothing.
  //
  // What is seeded below survives that gap without knowing about it. A seeded
  // file-content item persists a path and no bytes, and takes its snapshot at
  // the first transaction through its own scoped ops — by then the
  // conversation is bound, so the file that is READ is the one in the tree it
  // ended up working in. The probe here decides only WHICH names exist, which
  // is why it is worth doing against the tree currently on offer.
  const where = options.workspaceId ?? conversation.workspaceId;
  const ops = createBoundOps(() => ({ workspaceId: where }));

  // The root is not always the only place whose instructions apply: a folder
  // of the project, and a worktree of one of the project's subrepos, both sit
  // under instructions written above them. Which other place counts is the
  // provider's to say — no path walk can tell those two from a worktree of
  // the project itself, whose parent is the user's home directory — while the
  // list of names, the dedup and the skip below stay here.
  //
  // Widest first, so a tree's own files are probed last and read closest. The
  // paths are absolute, which the scope allows: reads from a workspace are
  // widened by the project (handlers.ResolveWorkspaceScope), and a
  // workspace-relative `../` would read as a file of the workspace's own,
  // both to the model and in the properties panel.
  const above = where ? workspaceInstructionRoots(session, session.getWorkspace(where)) : [];
  const probes = [
    ...above.flatMap(root => AI_ASSISTANT_FILES.map(
      // In the separator the root arrived in: a Windows root joined with '/'
      // is a path the user never sees written that way anywhere else.
      name => `${root}${root.includes('\\') && !root.includes('/') ? '\\' : '/'}${name}`)),
    ...AI_ASSISTANT_FILES
  ];

  // Check all candidate files in parallel — sequential awaits on disk-read
  // RTT (one HTTP round trip per filename) were a noticeable bottleneck
  // under iframe-pool load, with N tests racing createConversation and
  // each blocking ~K * RTT before the test could continue.
  const candidates = await Promise.all(
    probes.map(async (filename) => {
      try {
        const result = await ops.readFile({ path: filename });
        return result && result.content
          ? { filename, contentHash: result.contentHash }
          : null;
      } catch {
        return null;
      }
    })
  );

  // Add discovered files sequentially so each executeContextItem sees a
  // stable thread state (avoids racing duplicate inserts of the same
  // file-content item; the dedup is checked at insert time).
  //
  // Dedup by content hash: a common setup symlinks CLAUDE.md → AGENTS.md (or
  // keeps identical copies), and the insert-time dedup keys on path, so both
  // paths would otherwise seed the same content twice. The SHA-256 the read
  // op returns collapses symlinks, hardlinks, and identical copies to one.
  let addedCount = 0;
  const seenHashes = new Set();

  // A candidate the thread already holds claims its hash before the pass adds
  // anything, so the bytes the user pinned for themselves are not seeded a
  // second time under the other name they answer to. Path is how the
  // insert-time dedup matches, so it is how a candidate is recognised here.
  const pinned = new Set(
    (mt.contextItems || [])
      .filter((/** @type {any} */ item) => item.type === 'file-content')
      .map((/** @type {any} */ item) => (item.data?.path || '').replace(/^\/+/, ''))
  );
  for (const candidate of candidates) {
    if (candidate?.contentHash && pinned.has(candidate.filename.replace(/^\/+/, ''))) {
      seenHashes.add(candidate.contentHash);
    }
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    const { filename, contentHash } = candidate;
    if (contentHash && seenHashes.has(contentHash)) continue;
    try {
      // `seeded` marks this as something the session added to itself rather
      // than something the user pinned, which is what makes it freeze at the
      // first transaction instead of re-reading every turn. These files ride
      // the cached prefix, and the agent editing its own AGENTS.md is routine,
      // so a live re-read would cold-start the conversation as a matter of
      // course. A user who wants one kept current can pin it themselves.
      await mt.executeContextItem('file-content', { path: filename, seeded: true });
      if (contentHash) seenHashes.add(contentHash);
      addedCount++;
    } catch {
      // Skip on failure — best-effort optional operation.
    }
  }

  return addedCount;
}

/**
 * Seed every registered context-item type whose manifest declares
 * `autoInstantiate` onto a thread, so it is "always present" without the user
 * adding it (e.g. project memory). Idempotent: each type's `mergeOrReplace`
 * dedups, so re-running reuses the existing instance. A class may gate seeding
 * with a static `shouldAutoInstantiate()` (default: seed unconditionally) —
 * memory uses this to seed only when its file already exists.
 *
 * This is the generic counterpart to {@link addAIAssistantFiles}'s
 * file-existence-gated CLAUDE.md path (which could later migrate onto this
 * capability). Best-effort: a failed seed never blocks conversation creation.
 * @param {import('./conversation.js').default} conversation - Conversation to seed
 * @param {import('./message-thread.js').default|null} [messageThread] - Target thread; null = root
 * @returns {Promise<number>} Number of auto-instantiate types seeded
 */
export async function seedAutoContextItems(conversation, messageThread = null) {
  if (!conversation) return 0;
  const mt = messageThread || conversation.rootMessageThread;
  let count = 0;
  for (const { id, class: ItemClass } of contextItemRegistry.getAll()) {
    const manifest = /** @type {any} */ (ItemClass).MANIFEST;
    if (!manifest?.autoInstantiate) continue;
    try {
      const gate = /** @type {any} */ (ItemClass).shouldAutoInstantiate;
      if (typeof gate === 'function' && !(await gate.call(ItemClass))) {
        continue;
      }
      await mt.executeContextItem(id, {});
      count++;
    } catch {
      // Best-effort: a failed seed must never block conversation creation.
    }
  }
  return count;
}

/**
 * Seed a thread's always-present auto items: the AI assistant files
 * (CLAUDE.md etc.) and every `autoInstantiate` context-item type (e.g.
 * project memory). This is the single source of truth for the seeding that
 * both conversation creation and `/clear` perform — they call this same
 * method so the freshly-created and the just-cleared state never drift.
 * Both halves are idempotent (`mergeOrReplace` dedup), so re-seeding a thread
 * that still holds some of the items reuses them.
 *
 * Only the first half has a tree to be wrong about. Memory reads through
 * deliberately unscoped ops because it is the project's rather than the
 * workspace's, and the skills catalog is served by an endpoint that takes no
 * workspace at all — so `workspaceId` reaches {@link addAIAssistantFiles} and
 * stops there.
 * @param {import('./session.js').default} session - The session whose preferences and workspaces apply
 * @param {import('./conversation.js').default} conversation - Conversation to seed
 * @param {import('./message-thread.js').default|null} [messageThread] - Target thread; null = root
 * @param {{workspaceId?: string}} [options] - Which tree to probe; defaults to the conversation's own binding
 * @returns {Promise<{assistantFiles: number, autoItems: number}>} How many of each half were added
 */
export async function seedConversationAutoItems(session, conversation, messageThread = null, options = {}) {
  const assistantFiles = await addAIAssistantFiles(session, conversation, messageThread, options);
  const autoItems = await seedAutoContextItems(conversation, messageThread);
  return { assistantFiles, autoItems };
}
