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
 *   but the session's settings. The identity is the one exception, and only
 *   until the conversation starts: switching strategy before the first
 *   message re-seeds it from the new strategy ({@link reseedIdentityForStrategy}).
 * - **Auto items** ({@link seedConversationAutoItems}) put the always-present
 *   context items on a thread: the assistant files (AGENTS.md, CLAUDE.md, …)
 *   of the user's global folders and of the tree the conversation works in
 *   (`services/instruction-files.js` names them), and every `autoInstantiate`
 *   context-item type (e.g. project memory). A strategy declaring
 *   `MANIFEST.projectInstructions: false` is seeded the global files only, and
 *   a switch before the first message adds or removes the tree's to match
 *   ({@link reseedInstructionsForStrategy}). These are root-relative, so they
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
import strategyRegistry from '../registries/strategy-registry.js';
import { createBoundOps } from '../../sdk/ops.js';
import { ensureUserPresetsLoaded, extensionPresetsLoaded, getDefaultPresetSeed } from '../services/system-prompt-presets.js';
import { isDefaultFileEditingOn, setFileEditingAllowed } from '../services/file-editing-permission.js';
import { resolveDefaultStrategyId, BUILTIN_DEFAULT_STRATEGY_ID } from '../services/default-strategy.js';
import { workspaceInstructionRoots } from '../services/workspace-provisioning.js';
import { BUILTIN_DEFAULT_ID } from '../../sdk/lib/system-prompt-registry.js';
import { reportFact } from '../services/guidance/facts.js';
import { INSTRUCTION_FILE_NAMES, joinInstructionPath } from '../services/instruction-files.js';
import { itemField, isConversationalItemType } from '../../sdk/lib/message.js';

/**
 * Copy the session's new-task preferences into a freshly created conversation.
 * Run once, at creation, while the conversation is nobody's yet and there is
 * nothing of the user's to write over.
 * @param {import('./session.js').default} session - The session whose preferences apply
 * @param {import('./conversation.js').default} conversation - The new conversation
 * @param {{strategyId?: string}} [opts] - The strategy the conversation starts
 *   on, when its creator already knows (an agent run's own); otherwise the
 *   user's default strategy
 * @returns {Promise<void>}
 */
export async function seedCreationDefaults(session, conversation, opts = {}) {
  let strategyId = opts.strategyId || null;
  if (!strategyId) {
    try {
      strategyId = resolveDefaultStrategyId(session);
    } catch (err) {
      console.warn('[ConversationSeeder] Could not resolve the default strategy:', err);
    }
  }
  await seedDefaultSystemPrompt(conversation, strategyId);
  seedDefaultFileEditing(session, conversation);
  seedDefaultStrategy(conversation, strategyId);
}

/**
 * Strategies already warned about for naming a `defaultPreset` that is not
 * registered, so the console says it once per strategy.
 * @type {Set<string>}
 */
const warnedPresets = new Set();

/**
 * The preset id a strategy's `MANIFEST.defaultPreset` names, resolved: a
 * `./<stem>` names a preset of the strategy's own extension
 * (`<extensionId>/<stem>`); anything else is a preset id as it stands.
 * @param {string} strategyId - The strategy
 * @returns {string} The id ('' when the strategy names none)
 */
function strategyPresetId(strategyId) {
  const declared = strategyRegistry.get(strategyId)?.MANIFEST?.defaultPreset;
  if (typeof declared !== 'string' || !declared) return '';
  if (!declared.startsWith('./')) return declared;
  const extensionId = strategyRegistry.getExtensionId(strategyId);
  return extensionId ? `${extensionId}/${declared.slice(2)}` : '';
}

/**
 * The preset a conversation on a strategy is seeded with: the strategy's
 * `MANIFEST.defaultPreset` when it names a registered preset, else the user's
 * default. A `defaultPreset` that names nothing registered, once the
 * extensions' presets have been read, earns one console warning per strategy.
 * Read at creation, and again by {@link reseedIdentityForStrategy} when a
 * conversation that has not started switches strategy.
 * @param {string|null} strategyId - The strategy the conversation starts on
 * @returns {{id: string, content: string}} The chosen preset id and its content
 */
export function presetSeedForStrategy(strategyId) {
  const preferred = strategyId ? strategyPresetId(strategyId) : '';
  const seed = getDefaultPresetSeed(preferred);
  if (preferred && seed.id !== preferred && strategyId && extensionPresetsLoaded() && !warnedPresets.has(strategyId)) {
    warnedPresets.add(strategyId);
    console.warn(`[ConversationSeeder] Strategy "${strategyId}" names defaultPreset "${preferred}", which no enabled extension provides; seeding the user's default instead`);
  }
  return seed;
}

/**
 * Whether a system-prompt item's identity is still one a seed put there —
 * the item as created (empty text on the built-in default) or a seeder's
 * write (`data.seeded`) — and so is the conversation's to re-seed rather than
 * the user's. Picking a preset by hand or editing the text clears it.
 * @param {Record<string, any>|undefined} data - The item's data
 * @returns {boolean} True when nothing the user did is in it
 */
function isSeededIdentity(data) {
  if (!data || data.isModified) return false;
  if (data.seeded === true) return true;
  const id = data.selectedPresetId;
  return !data.text && (!id || id === BUILTIN_DEFAULT_ID);
}

/**
 * Give a conversation that has not started the identity of the strategy it
 * has just been switched to, as if it had been created on it. A new
 * conversation is created on the user's default strategy and seeded from
 * that, so a user who opens one and picks another strategy (Chat, say) would
 * otherwise keep the identity of the first.
 *
 * It writes only while nothing the user did would be overwritten: the root
 * thread holds no conversational item yet, and the identity is still a seeded
 * one ({@link isSeededIdentity}) — not a preset picked by hand, whichever it
 * is, and not edited. The strategy read is the thread's current one, so a
 * burst of switches settles on the last.
 * @param {import('./conversation.js').default} conversation - The conversation whose root strategy changed
 * @returns {Promise<boolean>} Whether the identity was rewritten
 */
export async function reseedIdentityForStrategy(conversation) {
  try {
    await ensureUserPresetsLoaded();
    const mt = conversation?.rootMessageThread;
    if (!mt || hasStarted(mt)) return false;
    const promptItem = (mt.contextItems || []).find(f => f.type === 'system-prompt');
    if (!promptItem || !isSeededIdentity(promptItem.data)) return false;
    const stored = promptItem.data?.selectedPresetId;
    const currentId = typeof stored === 'string' && stored ? stored : BUILTIN_DEFAULT_ID;
    const { id, content } = presetSeedForStrategy(mt.getEffectiveStrategyId?.() || BUILTIN_DEFAULT_STRATEGY_ID);
    if (id === currentId) return false;
    // The built-in default is written as the pristine item holds it, empty
    // text, which the item resolves to that preset's body at build time.
    const text = id === BUILTIN_DEFAULT_ID ? '' : content;
    mt.updateContextItem(promptItem.id, {
      data: { ...promptItem.data, text, selectedPresetId: id, isModified: false, seeded: true }
    });
    return true;
  } catch (err) {
    console.warn('[ConversationSeeder] Could not re-seed the identity for a strategy switch:', err);
    return false;
  }
}

/**
 * Whether a thread holds any conversational item — a message, a tool call —
 * and so has started, past the point a strategy switch re-seeds it.
 * @param {import('./message-thread.js').default} mt - The thread
 * @returns {boolean} True once it has history
 */
function hasStarted(mt) {
  for (const item of mt.items || []) {
    if (isConversationalItemType(String(itemField(item, 'type') ?? ''))) return true;
  }
  return false;
}

/**
 * Whether a conversation on a strategy is seeded the project's instruction
 * files — the tree's and the places above it — as well as the user's global
 * ones (`MANIFEST.projectInstructions`, true unless declared false).
 * @param {string|null|undefined} strategyId - The strategy
 * @returns {boolean} False only for a strategy that declares it
 */
export function strategySeedsProjectInstructions(strategyId) {
  if (!strategyId) return true;
  return strategyRegistry.get(strategyId)?.MANIFEST?.projectInstructions !== false;
}

/**
 * Bring a conversation that has not started into line with the
 * `MANIFEST.projectInstructions` of the strategy it has just been switched to:
 * switched on to one that leaves the project's instruction files out, the
 * seeded ones go; switched back to one that takes them, they are seeded again.
 * The user's global files stay either way, and so does any file the user
 * added themselves — only a `seeded` file-content item is removed.
 *
 * It acts only when the two strategies disagree, so a switch between two that
 * both take the files never brings back one the user deleted, and only while
 * the root thread holds no conversational item.
 * @param {import('./conversation.js').default} conversation - The conversation whose root strategy changed
 * @param {string} fromStrategyId - The strategy it was on before the switch
 * @returns {Promise<boolean>} Whether its context items changed
 */
export async function reseedInstructionsForStrategy(conversation, fromStrategyId) {
  try {
    const mt = conversation?.rootMessageThread;
    const session = conversation?.session;
    if (!mt || !session || hasStarted(mt)) return false;
    const before = strategySeedsProjectInstructions(fromStrategyId);
    const after = strategySeedsProjectInstructions(mt.getEffectiveStrategyId?.() || BUILTIN_DEFAULT_STRATEGY_ID);
    if (before === after) return false;
    if (after) return (await addAIAssistantFiles(session, conversation, mt)) > 0;
    const global = new Set(globalInstructionPaths(session));
    const project = (mt.contextItems || []).filter((item) => item.type === 'file-content'
      && itemField(item.data, 'seeded') === true && !global.has(String(itemField(item.data, 'path') ?? '')));
    for (const item of project) mt.removeContextItem(item.id);
    return project.length > 0;
  } catch (err) {
    console.warn('[ConversationSeeder] Could not re-seed the instruction files for a strategy switch:', err);
    return false;
  }
}

/**
 * Seed a freshly created conversation's system prompt from the preset its
 * initial strategy names, or the user's chosen default preset. Like the model
 * seed, the resolved body is copied into the conversation's system-prompt item
 * at creation time, so a later change to the default never retargets an
 * existing conversation. When no preset content resolves (e.g. offline), the
 * item's own built-in default fallback applies at build time, so nothing is
 * written. A write is marked `seeded`, so a strategy switch before the first
 * message may still replace it.
 * @param {import('./conversation.js').default} conversation
 * @param {string|null} strategyId - The strategy the conversation starts on
 */
async function seedDefaultSystemPrompt(conversation, strategyId) {
  try {
    await ensureUserPresetsLoaded();
    const { id, content } = presetSeedForStrategy(strategyId);
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
        data: { ...targetPromptItem.data, text: content, selectedPresetId: id, isModified: false, seeded: true }
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
 * @param {import('./conversation.js').default} conversation
 * @param {string|null} strategyId - The resolved default strategy id
 */
function seedDefaultStrategy(conversation, strategyId) {
  try {
    if (!strategyId || strategyId === BUILTIN_DEFAULT_STRATEGY_ID) return;
    const mt = conversation.rootMessageThread;
    if (mt) mt.setStrategy(strategyId);
  } catch (err) {
    console.warn('[ConversationSeeder] Could not seed default strategy:', err);
  }
}

/**
 * How a seeding pass is run.
 * @typedef {object} SeedOptions
 * @property {string} [workspaceId] - Which tree to probe; defaults to the conversation's own binding
 * @property {boolean} [allInstructions] - Seed the project's instruction files even on a strategy
 *   that declares `MANIFEST.projectInstructions: false`: the user asked for them
 */

/**
 * Conversations whose instruction-file fact this page has reported.
 * @type {Set<string>}
 */
const instructionFilesReported = new Set();

/**
 * The paths probed for the user's global instruction files: every
 * instruction file name in each of the session's global instruction folders.
 * @param {import('./session.js').default} session - The session
 * @returns {string[]} Absolute paths, in probe order
 */
function globalInstructionPaths(session) {
  const dirs = Array.isArray(session?.instructionDirs) ? session.instructionDirs : [];
  return dirs.flatMap((dir) => INSTRUCTION_FILE_NAMES.map((name) => joinInstructionPath(dir, name)));
}

/**
 * Look for AI assistant files: the user's global folders, the places above the
 * tree, then the tree itself.
 * @param {import('./session.js').default} session
 * @param {import('./conversation.js').default} conversation
 * @param {string} [workspaceId] - Which tree to probe; defaults to the conversation's own binding
 * @returns {Promise<{candidates: ({filename: string, contentHash: string|undefined}|null)[], globalCount: number}>}
 *   One entry per probed path (null where none), and how many leading entries are global.
 */
async function probeAssistantFiles(session, conversation, workspaceId) {
  // Which tree to look in is the caller's to say, because a conversation is
  // offered its assistant files before it is bound to anything: the tree on
  // offer in a place list is a workspace this conversation does not work in
  // yet, and may never. A bound conversation asks about its own tree by
  // passing nothing.
  //
  // What is seeded from this survives that gap without knowing about it. A seeded
  // file-content item persists a path and no bytes, and takes its snapshot at
  // the first transaction through its own scoped ops — by then the
  // conversation is bound, so the file that is READ is the one in the tree it
  // ended up working in. The probe here decides only WHICH names exist, which
  // is why it is worth doing against the tree currently on offer.
  const where = workspaceId ?? conversation.workspaceId;
  const ops = createBoundOps(() => ({ workspaceId: where }));

  // The root is not always the only place whose instructions apply: a folder
  // of the project, and a worktree of one of the project's subrepos, both sit
  // under instructions written above them. Which other place counts is the
  // provider's to say — no path walk can tell those two from a worktree of
  // the project itself, whose parent is the user's home directory — while the
  // list of names stays here, and the dedup and the skip with the seeder.
  //
  // Widest first, so a tree's own files are probed last and read closest: the
  // user's global folders, then the places above the tree, then the tree. The
  // paths are absolute, which the scope allows: reads from a workspace are
  // widened by the project (scope, in cmd/juggler/workspace/local.go), the
  // global instruction files are admitted by name (ops/validation.go), and a
  // workspace-relative `../` would read as a file of the workspace's own,
  // both to the model and in the properties panel.
  const above = where ? workspaceInstructionRoots(session, session.getWorkspace(where)) : [];
  const atDir = (/** @type {string} */ dir) => INSTRUCTION_FILE_NAMES.map(name => joinInstructionPath(dir, name));
  const globalProbes = globalInstructionPaths(session);
  const probes = [
    ...globalProbes,
    ...above.flatMap(atDir),
    ...INSTRUCTION_FILE_NAMES
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

  return { candidates, globalCount: globalProbes.length };
}

/**
 * Report whether a conversation's project has instruction files of its own,
 * for a conversation this page has not seeded (one created before a reload):
 * the same probe and the same fact as seeding, adding nothing. Once per
 * conversation per page; a later call is free.
 * @param {import('./session.js').default} session
 * @param {import('./conversation.js').default} conversation
 * @returns {Promise<void>} Never rejects.
 */
export async function reportInstructionFiles(session, conversation) {
  if (!session || !conversation?.id || instructionFilesReported.has(conversation.id)) return;
  instructionFilesReported.add(conversation.id);
  try {
    const { candidates, globalCount } = await probeAssistantFiles(session, conversation);
    reportFact('instruction-files', conversation.id, candidates.slice(globalCount).filter(Boolean).length);
  } catch (err) {
    instructionFilesReported.delete(conversation.id);
    console.warn('[ConversationSeeder] Could not check for instruction files:', err);
  }
}

/**
 * Add AI assistant files that exist in the user's global instruction folders,
 * in the probed tree, and in whatever wider places its provider says also hold
 * instructions for work done there. Folders below the tree's root are not
 * probed here: their files load when the agent first works in them
 * (`services/instruction-files.js`). A thread whose strategy declares
 * `MANIFEST.projectInstructions: false` is given the global files only,
 * unless the caller asks for every file (`allInstructions`: the user picked
 * them from the Add Context Item menu).
 * Checks each file exists before adding, prevents duplicates via FileContentContextItem.mergeOrReplace
 * @param {import('./session.js').default} session - The session whose preferences and workspaces apply
 * @param {import('./conversation.js').default} conversation - Conversation to add files to
 * @param {import('./message-thread.js').default|null} [messageThread] - Target thread; null means root thread
 * @param {SeedOptions} [options] - Which tree to probe, and whether the strategy decides which files
 * @returns {Promise<number>} Number of files added
 */
async function addAIAssistantFiles(session, conversation, messageThread = null, options = {}) {
  // This is a best-effort optional operation - log and continue if prerequisites aren't met
  if (!conversation) {
    console.debug('[ConversationSeeder] Skipping AI assistant file detection: conversation not ready');
    return 0;
  }

  const mt = messageThread || conversation.rootMessageThread;
  const { candidates, globalCount } = await probeAssistantFiles(session, conversation, options.workspaceId);

  // What was found is a fact guidance may act on (a project with no
  // instruction file at all is offered help writing one); nothing else here
  // knows or decides anything about that. The user's global files are not the
  // project's, so they do not count.
  reportFact('instruction-files', conversation.id, candidates.slice(globalCount).filter(Boolean).length);
  instructionFilesReported.add(conversation.id);

  // A strategy with no use for the project's instructions (a chat, which
  // cannot read or change the project) is given only the user's own files,
  // which are about the person rather than the code.
  const projectToo = options.allInstructions === true
    || strategySeedsProjectInstructions(mt.getEffectiveStrategyId?.() || BUILTIN_DEFAULT_STRATEGY_ID);
  const toSeed = projectToo ? candidates : candidates.slice(0, globalCount);

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
      .filter(item => item.type === 'file-content')
      .map(item => {
        const path = itemField(item.data, 'path');
        return (typeof path === 'string' ? path : '').replace(/^\/+/, '');
      })
  );
  for (const candidate of candidates) {
    if (candidate?.contentHash && pinned.has(candidate.filename.replace(/^\/+/, ''))) {
      seenHashes.add(candidate.contentHash);
    }
  }

  for (const candidate of toSeed) {
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
 * with a static `shouldAutoInstantiate({session})` (default: seed
 * unconditionally) — memory uses this to seed only when its file already exists.
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
    if (!ItemClass.MANIFEST?.autoInstantiate) continue;
    try {
      const gate = 'shouldAutoInstantiate' in ItemClass ? ItemClass.shouldAutoInstantiate : undefined;
      if (typeof gate === 'function' && !(await gate.call(ItemClass, { session: conversation.session }))) {
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
 * @param {SeedOptions} [options] - Which tree to probe, and whether the strategy decides which files
 * @returns {Promise<{assistantFiles: number, autoItems: number}>} How many of each half were added
 */
export async function seedConversationAutoItems(session, conversation, messageThread = null, options = {}) {
  const assistantFiles = await addAIAssistantFiles(session, conversation, messageThread, options);
  const autoItems = await seedAutoContextItems(conversation, messageThread);
  return { assistantFiles, autoItems };
}
