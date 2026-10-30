//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { runInSandbox } from 'juggler/sandbox';
import { MAX_EXEC_TIMEOUT_MS, saveProgramSnapshot, loadProgramSnapshot, deleteProgramSnapshot } from 'juggler/ops';
import { itemClassForTool } from 'juggler/registry';
import QueryCodeContextItem, { summaryWithImages } from './query-code-context-item.js';
import { beginProgramReads } from './read-history.js';
import { renderProgramSdk, describeProgramTool, toolOwnName } from './code/render-sdk.js';
import { journalCapabilities } from './code/program-journal.js';
import { pointImageReadsAtImage } from './code/program-images.js';
import { translator, markUntranslated } from 'juggler/i18n';
import { extractErrorMessage } from 'juggler/ui';
import { toolActionDisplayData } from '../lib/tool-action-result.js';

const t = translator('@juggler/core');

/**
 * What a program keeps each time one of its calls waits on the user, to resume
 * from should its engine be lost meanwhile: the call it holds and that call's
 * journal step, its journal as it stood (program-journal.js snapshot), the
 * call record of what it had done,
 * whose calls a replay never makes again, and the images it had been given
 * (code/program-images.js), whose handles its journal replays.
 * @typedef {{held: HeldCall, heldStep: number, journal: Array<import('./code/program-journal.js').JournalEntry|undefined>, record: {calls: Array<Record<string, unknown>>, omitted: number, omittedEffects: number}, images: Map<string, any>}} SavedProgram
 */

/** @typedef {{name: string, input: Record<string, unknown>}} HeldCall */

/** @typedef {{toolUseId?: string|null, id: string, conversation?: any}} ProgramRef */

/** How long keeping a snapshot may take before the hold goes ahead without one. */
const SNAPSHOT_SAVE_TIMEOUT_MS = 30000;

/**
 * Where a program is kept: its conversation and tool-use id, or null for an
 * item with neither, which has nowhere to be kept.
 * @param {ProgramRef} item - A run_code item
 * @returns {{convId: string, toolUseId: string}|null} The key
 */
function keptAt(item) {
  const convId = item.conversation?.id;
  return convId && item.toolUseId ? { convId, toolUseId: item.toolUseId } : null;
}

/**
 * A value as JSON with every object's keys sorted, so two spellings of the
 * same call compare equal: a call that went through the document comes back
 * with its keys in whatever order the document keeps them.
 * @param {unknown} value - A value
 * @returns {string} Its canonical JSON
 */
function canonical(value) {
  /** @type {(v: unknown) => unknown} */
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v === null || typeof v !== 'object') return v;
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(/** @type {any} */ (v)[k])]));
  };
  return JSON.stringify(sorted(value ?? {})) ?? '';
}

/**
 * A program's snapshot, if one is kept for the call the item holds. One kept
 * for another call is from an earlier hold, whose later snapshot could not be
 * kept: replaying it would make again what the program did since, so it is
 * not a snapshot to resume from. Snapshots are kept beside the conversation,
 * out of the document (cmd/juggler/worker/program_store.go), so one outlives
 * the engine whose loss it is for; the worker drops it once the item settles.
 * @param {ProgramRef} item - The program
 * @param {HeldCall} held - The call its item holds
 * @returns {Promise<SavedProgram|undefined>} The snapshot, if one is kept for that call
 */
async function loadSnapshot(item, held) {
  const at = keptAt(item);
  if (!at) return undefined;
  const kept = /** @type {any} */ (await loadProgramSnapshot(at.convId, at.toolUseId).catch(() => null));
  if (!kept || !Array.isArray(kept.journal) || !kept.record || typeof kept.heldStep !== 'number') return undefined;
  if (kept.held?.name !== held.name || canonical(kept.held?.input) !== canonical(held.input)) return undefined;
  return {
    held: kept.held,
    heldStep: kept.heldStep,
    // JSON keeps an unanswered step as null; the journal reads it as a gap.
    journal: kept.journal.map((/** @type {any} */ e) => e ?? undefined),
    record: kept.record,
    images: new Map(Array.isArray(kept.images) ? kept.images : [])
  };
}

/**
 * Keep a program's snapshot, replacing any before it, written as JSON, which
 * a program's answers already are, having crossed the sandbox boundary.
 * Throws if it is not kept within SNAPSHOT_SAVE_TIMEOUT_MS, or `signal` aborts.
 * @param {ProgramRef} item - The program
 * @param {SavedProgram} saved - Its snapshot
 * @param {AbortSignal} signal - Ends the attempt (the program has ended)
 * @returns {Promise<void>}
 */
export async function saveSnapshot(item, saved, signal) {
  const at = keptAt(item);
  if (!at) return;
  const attempt = new AbortController();
  const giveUp = () => attempt.abort();
  const timer = setTimeout(giveUp, SNAPSHOT_SAVE_TIMEOUT_MS);
  signal.addEventListener('abort', giveUp, { once: true });
  try {
    await saveProgramSnapshot(at.convId, at.toolUseId, { ...saved, images: [...saved.images] }, attempt.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', giveUp);
  }
}

/**
 * Drop a program's snapshot. Best effort: the worker drops it anyway once the
 * item settles.
 * @param {ProgramRef} item - The program
 * @returns {Promise<void>}
 */
export async function dropSnapshot(item) {
  const at = keptAt(item);
  if (at) await deleteProgramSnapshot(at.convId, at.toolUseId).catch(() => {});
}

/** How often the live call rows are written while a program runs. */
const ROWS_WRITE_INTERVAL_MS = 250;

/**
 * The longest a program may live, waiting on the user included. Its own clock
 * stops while a call waits on the user, but the rest of the program does not
 * stop with it; this is the limit on a program that goes on working, or
 * spinning, beside a card nobody answers.
 */
const MAX_PROGRAM_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * RunCodeContextItem - Run a JavaScript program that calls tools.
 *
 * query_code's sandbox and read-only surface (`fs`, `grep`, `glob`, `path`,
 * `projectRoot`, `import()`), plus `tools.*`: the conversation's own tools,
 * each call admitted against what the thread was offered and put to the same
 * approval decision as the model's own call (ContextItem#createToolInvoker).
 * Only what the program returns enters context, followed by the list of changes
 * its calls made — reads are never listed, changes always are. That list is not
 * this item's to write: the worker's projection builds it from the call record
 * kept on the item (`displayData.nestedCalls`), so it reaches the model however
 * the program ended, a cancel included.
 *
 * A call the decision would park is held: this item goes back to the user
 * with that call's own approval while the program waits on the call, alive,
 * its clock stopped (services/held-calls.js). Their answer runs the call and
 * the program goes on; a denial cancels the item as any denial does. Each hold
 * keeps a snapshot of the program's journal (`saveSnapshot`), so a program
 * whose engine is lost while it waits can resume once the user answers: run
 * again from the top, every earlier call answered from the snapshot and the
 * held call made with the user's answer.
 * @class
 * @augments QueryCodeContextItem
 */
class RunCodeContextItem extends QueryCodeContextItem {
  static MANIFEST = {
    // Persisted in users' plugin lists, and the key the system-prompt section
    // gates on. Never change it.
    id: 'run-code',
    name: 'Run Code',
    version: '1.0.0',
    description: 'Run a JavaScript program that calls tools, so only its result enters context',
    author: 'Juggler Team',
    requiresApproval: false,
    // No program calls a program.
    composable: false
  };

  /**
   * A program's time includes its tool calls, so it may run as long as one
   * bash call may: no shorter, or it would cut short a command it was allowed
   * to run.
   */
  static MAX_TIMEOUT_MS = MAX_EXEC_TIMEOUT_MS;

  /**
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema, programSdk: boolean}>} Tool definitions
   */
  static getToolDefinitions() {
    return [{
      name: 'run_code',
      category: 'write',
      // Followed by the rule for calling the thread's tools from a program
      // (render-sdk.js, attached by thread-tool-inventory.js). Every request
      // carries this text: what the model's tool list already says, and what
      // the code parameter says, is not said again.
      programSdk: true,
      description: markUntranslated('Run a JavaScript program that calls tools; only what it returns enters the conversation, ')
        + 'plus a list of what it changed. Use it for work that loops, branches or aggregates over many tool calls. '
        + 'Each call is approved as if you made it directly, and a denial ends the program. One that waits for the '
        + 'user\'s approval pauses the program until they answer.',
      input_schema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: markUntranslated('JavaScript (async/await OK; return a value). Browser realm, not Node. In scope: ')
              + '`fs` (read-only fs.promises subset), `path` (POSIX), `grep(pattern, {cwd?, glob?, maxResults?, ignoreCase?})`, '
              + '`glob(pattern, {cwd?})`, `projectRoot`, `tools`, `describeTool`, `image(handleOrPath)`; `import()` modules under projectRoot. '
              + 'A call that produced images returns `{text, images}`; `await image(images[0])` attaches one to your result.'
          },
          description: {
            type: 'string',
            description: markUntranslated('Short user-facing description of what this program does.')
          },
          timeout: {
            type: 'number',
            description: markUntranslated(`Optional execution timeout in milliseconds (1000–${MAX_EXEC_TIMEOUT_MS}, default 120000). It includes time spent in tool calls, not time waiting for approval.`)
          }
        },
        required: ['code']
      }
    }];
  }

  /**
   * The SDK text appended to run_code's description for the tools a program
   * may call in this thread (thread-tool-inventory.js).
   * @param {Array<Record<string, any>>} callable - The callable offered tools
   * @param {Array<Record<string, any>>} [excluded] - The offered tools a program may not call
   * @returns {string} The SDK text
   */
  static renderProgramSdk(callable, excluded = []) {
    return renderProgramSdk(/** @type {any} */ (callable), /** @type {any} */ (excluded));
  }

  /**
   * Run the program.
   *
   * Returns the program's value with its console output and the files it read
   * (`filesRead`, for read credit). A program that throws, times out, or is
   * refused a call returns a structured failure carrying the same. A cancel
   * stays a bare AbortError, like query_code's. What the program changed is in
   * the call record on the item, whichever way it ended.
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<Record<string, unknown>>} Program result
   */
  async execute(params) {
    const code = /** @type {string} */ (params.code);
    const timeoutMs = params.timeout ? Number(params.timeout) : QueryCodeContextItem.DEFAULT_TIMEOUT_MS;

    const workspaceRoot = this.getWorkspaceRoot();
    if (workspaceRoot === null) {
      throw new Error(
        'Couldn\'t run: this conversation\'s workspace is unavailable — it is still being '
        + 'created, was closed, or its directory has gone.');
    }

    const resume = await this._takeResume();
    if (resume && !resume.saved) {
      // No snapshot was kept for the call it held, or it went with the engine
      // that kept it. Running it again would redo what it did before the
      // stop; the worker still reports those changes from the rows on the item.
      // A snapshot kept for another call goes too.
      await dropSnapshot(this);
      this._holdAssets([]);
      return {
        success: false,
        errorCode: 'program-failed',
        error: `Couldn't resume the program: it was waiting for approval to run ${resume.held.name} when Juggler `
          + 'restarted, and what it had done so far was lost. Nothing ran again.'
      };
    }
    const saved = resume?.saved;

    const fs = this.ops.readOnlyFileSystem();
    // A program that writes through `fs` means to change a file, and here there
    // is a way to: say so, or the model retries the write and gives up on
    // run_code. The refusal itself is ReadOnlyFileSystem's.
    const refuseWrite = async () => {
      throw new Error('EROFS: read-only filesystem. In run_code, fs only reads: change files with tools.write or tools.edit.');
    };
    Object.assign(fs, { writeFile: refuseWrite, mkdir: refuseWrite });
    pointImageReadsAtImage(fs);
    const { grep, glob } = this._createSearchHelpers();

    // The program stops on a cancel (this item's signal), a refused call, a
    // replay that diverges, or its time running out. One controller covers
    // them all, so the sandbox and every running call end the same way
    // whichever it was; the first reason given is the one reported.
    const controller = new AbortController();
    /** @type {Error|null} */
    let refusal = null;
    const stop = (/** @type {Error|null} */ why) => {
      if (why && !refusal) refusal = why;
      controller.abort();
    };
    const onCancel = () => stop(null);
    this.signal?.addEventListener('abort', onCancel, { once: true });
    // The program's own clock, in place of the sandbox's: it stops while the
    // program waits on the user, whose time is not the program's. Its
    // lifetime never stops.
    const clock = pausableTimer(timeoutMs, () => stop(new Error(`Script timed out after ${timeoutMs}ms`)));
    const lifetime = setTimeout(() => stop(new Error(
      `The program was stopped after ${MAX_PROGRAM_LIFETIME_MS / 3600000} hours, still waiting for approval.`)),
    MAX_PROGRAM_LIFETIME_MS);

    // What a snapshot is taken of, each part filled in as it is made below.
    /** @type {{record: any, journalled: any, images: any}} */
    const run = { record: null, journalled: null, images: null };
    const snapshots = this._snapshotKeeper(run, controller.signal);
    // The hooks below run only once the program holds a call, by when every
    // name they use (rows, below) is made.
    const invoker = this.createToolInvoker({
      signal: controller.signal,
      onRefused: stop,
      waitForUser: true,
      // Each call held for the user: the clock stops, the rows show it, and a
      // snapshot is kept to resume from should the engine be lost meanwhile —
      // before the user is asked, so any card they see has one.
      beforeHold: async (request, step) => {
        clock.pause();
        rows.now();
        await snapshots.keep(/** @type {any} */ (request), /** @type {number} */ (step));
      },
      afterHold: () => {
        clock.resume();
        rows.touch();
      }
    });
    run.record = invoker.record;
    const rows = this._liveRows(invoker.record);

    // A program resuming after its engine was lost replays what it did before:
    // its calls are answered from the snapshot, and their rows come first. The
    // held call, made again at its step, is made with the user's answer.
    if (saved) {
      invoker.record.calls.unshift(...saved.record.calls);
      invoker.record.omitted += saved.record.omitted;
      invoker.record.omittedEffects += saved.record.omittedEffects;
    }

    // A namespace: any `tools.<name>` reaches the invoker, which refuses a name
    // the thread does not offer in the worker's own words.
    const tools = new Proxy({}, {
      get: (_target, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined;
        return async (/** @type {Record<string, unknown>} */ args) => {
          // Tagged with its journal step, so a hold snapshots the journal
          // with this call marked as the one held.
          const step = journalled.stepNow();
          const call = invoker.invoke(name, args, {
            withAttachments: true,
            tag: step,
            answer: saved && step === saved.heldStep ? resume?.answer : undefined
          });
          rows.touch();
          try {
            // A call that produced images hands the program their handles
            // beside its text; the pixels stay in the asset store.
            const { content, attachments } = await call;
            if (!attachments.length) return content;
            const label = typeof args?.file_path === 'string' ? args.file_path
              : typeof args?.path === 'string' ? args.path : name;
            return { text: content, images: images.receive(attachments, label) };
          } finally {
            rows.touch();
          }
        };
      }
    });

    // Every capability call is journalled; one that diverges from the journal
    // ends the program as a refusal does, uncatchable. `image` here is only
    // image(path)'s read of the file, journalled like any read so a replay
    // attaches what the program saw; the attaching is done on every run.
    const journalled = journalCapabilities({ fs, grep, glob, tools, image: this._imagePathLoader() }, {
      journal: saved?.journal ?? [],
      ledger: fs.filesRead,
      onDiverge: stop
    });
    const { image: loadImage, ...capabilities } = journalled;
    const images = this._programImages(saved?.images, loadImage);
    run.journalled = journalled;
    run.images = images;

    const endReads = beginProgramReads(this.conversation, this.toolUseId || this.id, fs.filesRead);
    /** @type {string[]} */
    const consoleLines = [];
    let value;
    /** @type {unknown} */
    let failure = null;
    try {
      value = await runInSandbox(code, {
        capabilities: { ...capabilities, describeTool: this._describeTool(invoker), image: images.show },
        // No deadline of the sandbox's own: the clock above is the program's.
        timeoutMs: 0,
        projectRoot: workspaceRoot,
        signal: controller.signal,
        onConsole: (line) => { consoleLines.push(line); },
      });
    } catch (err) {
      failure = err;
    } finally {
      clock.stop();
      clearTimeout(lifetime);
      this.signal?.removeEventListener('abort', onCancel);
      endReads();
      // Over, other than by this item's cancel (whose state is the
      // canceller's): nothing it left waiting on the user is answered now,
      // and its item is running again for its result to land on.
      if (!this.signal?.aborted) {
        invoker.end();
        await snapshots.drop(!!resume);
      }
      rows.flush();
    }

    if (failure && this.signal?.aborted) {
      this._holdAssets([]);
      throw failure;
    }

    /** @type {Record<string, unknown>} */
    const out = failure
      ? {
        success: false,
        errorCode: 'program-failed',
        error: /** @type {Error|null} */ (refusal)?.message
          ?? extractErrorMessage(failure)
      }
      : { result: value === undefined ? null : value };
    if (consoleLines.length > 0) out.console = consoleLines;
    if (failure) this._holdAssets([]);
    else this._attachShown(out, images);
    if (fs.filesRead.size > 0) {
      /** @type {Record<string, string|null>} */
      const filesRead = {};
      for (const [p, hash] of fs.filesRead) filesRead[p] = hash;
      out.filesRead = filesRead;
    }
    return out;
  }

  /**
   * This program's tool-action, if it is in the thread.
   * @returns {any} The tool-action's map, or undefined
   * @private
   */
  _toolAction() {
    return this.toolUseId ? this.messageThread?.getToolAction?.(this.toolUseId) : undefined;
  }

  /**
   * What a program needs to resume, when its item is executed while it still
   * names a held call: its engine was lost while it waited on the user. The
   * call; its snapshot, if one was kept for that call; and the user's answer,
   * if it was given on that call's own card — a strategy switch clears the
   * card, and the item may then be approved on its own account, in which case
   * the replay puts the call to the decision again. The call and its card are
   * cleared here: an item running again with them still on it would be
   * resumed from a snapshot it has already used.
   * @returns {Promise<{held: HeldCall, saved: SavedProgram|undefined, answer: string|undefined}|null>}
   *   The resume, or null for a program that was not waiting
   * @private
   */
  async _takeResume() {
    const toolAction = this._toolAction();
    /** @type {HeldCall|undefined} */
    const held = plainOf(toolAction?.get('heldCall')) || undefined;
    if (!held) return null;
    const response = toolAction.get('approvalResponse');
    const answer = plainOf(toolAction.get('approvalOptions'))?.held && typeof response === 'string'
      ? response : undefined;
    this.messageThread?.transact(() => {
      toolAction.delete('heldCall');
      toolAction.delete('approvalOptions');
    });
    return { held, saved: await loadSnapshot(this, held), answer };
  }

  /**
   * Keeps a run's snapshots: one per hold, replacing the last, and drops the
   * last once the program ends. A snapshot that cannot be kept (too large, or
   * the write failed or took too long) takes the one before it with it, so
   * the program waits with none: a restart then fails cleanly, rather than
   * resuming from an earlier hold and making again what it did since.
   * @param {{record: any, journalled: any, images: any}} run - The run's call record, journal and images
   * @param {AbortSignal} signal - The program's signal: ends a save under way
   * @returns {{keep: (request: {name: unknown, input: unknown}, step: number) => Promise<void>, drop: (resumed: boolean) => Promise<void>}} The keeper
   * @private
   */
  _snapshotKeeper(run, signal) {
    let kept = false;
    /** @type {Promise<void>} */
    let saving = Promise.resolve();
    return {
      keep: (request, step) => {
        saving = (async () => {
          // A call is written to the journal a few microtasks after it
          // answers, and until then a snapshot has it as pending, which a
          // replay makes again. A turn of the event loop lets the last of them
          // land, so the snapshot has every call that has happened as done.
          await new Promise((resolve) => setTimeout(resolve, 0));
          /** @type {SavedProgram} */
          const snapshot = {
            held: { name: String(request.name), input: /** @type {Record<string, unknown>} */ (request.input) },
            heldStep: step,
            journal: run.journalled.snapshot(),
            record: {
              calls: run.record.calls.filter((/** @type {any} */ c) => c.status === 'ok' || c.status === 'error')
                .map((/** @type {any} */ c) => ({ ...c })),
              omitted: run.record.omitted,
              omittedEffects: run.record.omittedEffects
            },
            images: new Map(run.images.received)
          };
          try {
            await saveSnapshot(this, snapshot, signal);
            kept = true;
          } catch {
            if (kept) await dropSnapshot(this);
            kept = false;
          }
        })();
        return saving;
      },
      // A save still under way when the program ends lands first, so the drop
      // has the last word. A resumed program's snapshot goes too.
      drop: async (resumed) => {
        await saving;
        if (kept || resumed) await dropSnapshot(this);
      }
    };
  }

  /**
   * The program's describeTool: the SDK in run_code's description is an
   * index, and this is the rest of it. Over the invoker's own admitted set, so
   * it describes exactly the tools a call would be admitted to, and no other.
   * @param {{offered: () => Promise<Map<string, Record<string, any>>>}} invoker - The program's invoker
   * @returns {(name: unknown) => Promise<unknown>} describeTool
   * @private
   */
  _describeTool(invoker) {
    return async (name) => {
      const offered = await invoker.offered();
      if (name === undefined) return [...offered.keys()];
      const def = offered.get(String(name)) ?? offered.get(toolOwnName(String(name)));
      if (!def) {
        throw new Error(`Couldn't describe ${String(name)}: it can't be called from a program in this thread. `
          + 'describeTool() lists the ones that can.');
      }
      return describeProgramTool(/** @type {any} */ (def));
    };
  }

  /**
   * Keep the program's call record on its item as `displayData` —
   * `{nestedCalls, omitted, omittedEffects}` — so the user watches the calls
   * happen, and so the worker can tell the model what the program changed
   * however it ended (a cancel leaves no result of the engine's to carry it).
   * Writes are throttled; `now` writes at once, for a call about to be put to
   * the user. `flush` writes the final state and closes the writer: a call
   * still unwinding after the program has ended must not rewrite a record the
   * worker may already have sent.
   * @param {{calls: Array<Record<string, unknown>>, omitted: number, omittedEffects: number}} record - The invoker's record
   * @returns {{touch: () => void, now: () => void, flush: () => void}} The writer
   * @private
   */
  _liveRows(record) {
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    let closed = false;
    const write = () => {
      timer = null;
      const thread = this.messageThread;
      if (!thread || !this.toolUseId) return;
      const items = thread.items;
      for (let i = 0; i < items.length; i++) {
        if (items[i].get('toolUseId') === this.toolUseId) {
          thread.updateDerivedItemField(i, 'displayData', {
            nestedCalls: record.calls.map((c) => ({ ...c })),
            omitted: record.omitted,
            omittedEffects: record.omittedEffects
          });
          return;
        }
      }
    };
    return {
      touch: () => {
        if (!closed && !timer) timer = setTimeout(write, ROWS_WRITE_INTERVAL_MS);
      },
      now: () => {
        if (closed) return;
        if (timer) clearTimeout(timer);
        write();
      },
      flush: () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        write();
      }
    };
  }

  /**
   * Format the result for the LLM: the program's value (or its error), then its
   * console output. The changes the program made follow it on the wire, added
   * by the worker from the call record, so they are never truncated away with
   * the value and are there even when the program never got this far.
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    const result = /** @type {Record<string, any>} */ (outcome.result || {});
    const consoleLines = Array.isArray(result.console) ? result.console : [];

    if (!outcome.success) {
      return this.failureSummary(withConsole(outcome.error || 'run_code failed', consoleLines));
    }

    let content;
    if (result.result !== null && result.result !== undefined) {
      content = typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2);
    } else {
      content = '(no return value)';
    }
    return summaryWithImages(this, this.truncateForLLM(withConsole(content, consoleLines)), result);
  }

  /**
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Status
   * @param {Record<string, unknown>} toolInput - Original tool input
   * @param {{conversation?: any, messageThread?: any, session?: any, toolUseId?: string}} [context] - UI context
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status config
   */
  getStatusUI(actionStatus, toolInput, context) {
    // Held: the card asks about the held call, so it is drawn as that
    // call's own tool draws it — bash's command, an edit's file, a question's
    // form, which answers this item.
    const held = actionStatus?.pending ? this._heldCall(context) : null;
    if (held) {
      const ui = held.sub.getStatusUI(
        { ...actionStatus, actionId: held.sub.id, displayData: held.call.displayData },
        held.call.input,
        context
      );
      if (ui) return { ...ui, typeName: `Program · ${ui.typeName || held.call.name}` };
    }
    const ui = super.getStatusUI(actionStatus, toolInput);
    return ui ? { ...ui, typeName: 'Program' } : ui;
  }

  /**
   * The call this program holds for the user, with an instance of its tool's
   * class to draw it, while the item waits on the user for it.
   * @param {{toolAction?: any, messageThread?: any, conversation?: any, session?: any, toolUseId?: string}} [context] - UI context
   * @returns {{sub: any, call: {name: string, input: Record<string, unknown>, displayData?: unknown}}|null} The held call, or null
   * @private
   */
  _heldCall(context) {
    const thread = context?.messageThread ?? this.messageThread;
    const toolAction = context?.toolAction
      ?? (context?.toolUseId ? thread?.getToolAction?.(context.toolUseId) : undefined);
    if (!toolAction || toolAction.get('state') !== 'pending') return null;
    const options = plainOf(toolAction.get('approvalOptions'));
    const call = plainOf(toolAction.get('heldCall'));
    if (!options?.held || typeof call?.name !== 'string') return null;
    const SubClass = /** @type {any} */ (itemClassForTool(call.name));
    if (!SubClass) return null;
    const conversation = context?.conversation ?? this.conversation;
    const sub = new SubClass({
      id: SubClass.MANIFEST?.id || call.name,
      session: context?.session ?? conversation?.session ?? this.session,
      conversation,
      messageThread: thread,
      toolName: call.name
    });
    return { sub, call: { ...call, input: call.input || {} } };
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result
   */
  renderToolActionDetails(wrapper, ctx) {
    const held = this._heldCall(ctx);
    if (held) {
      // The held call first, as its own tool shows it (an edit's diff, bash's
      // command), read from the call rather than from this item.
      const { call } = held;
      const fields = /** @type {Record<string, unknown>} */ ({
        toolName: call.name, toolInput: call.input, displayData: call.displayData, result: undefined
      });
      const toolAction = {
        get: (/** @type {string} */ key) => (key in fields ? fields[key] : ctx.toolAction?.get?.(key)),
        has: (/** @type {string} */ key) => (key in fields ? fields[key] !== undefined : !!ctx.toolAction?.has?.(key)),
      };
      held.sub.renderToolActionDetails(wrapper, {
        ...ctx, toolAction, toolName: call.name.toLowerCase(), input: call.input
      });
      this._renderProgram(wrapper, ctx);
      return { skipResultSection: true };
    }
    this._renderProgram(wrapper, ctx);
  }

  /**
   * The program itself in the panel: its code and description, and a row per
   * call it has made.
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @private
   */
  _renderProgram(wrapper, ctx) {
    super.renderToolActionDetails(wrapper, ctx);
    const data = toolActionDisplayData(ctx.toolAction);
    const calls = Array.isArray(data.nestedCalls) ? data.nestedCalls : [];
    if (calls.length === 0) return;
    const lines = calls.map(callRow);
    if (data.omitted) lines.push(t('…{count} more not shown', { count: data.omitted }));
    ctx.helpers.addSubsection(wrapper, t('Tool calls'), lines.join('\n'), 'properties-panel-text');
  }
}

/**
 * One row of the call list a user sees.
 * @param {Record<string, any>} c - A recorded call
 * @returns {string} The row
 */
function callRow(c) {
  const mark = { ok: '✓', error: '✗', refused: '⊘', cancelled: '◼', running: '…', queued: '·', held: '⏸' }[/** @type {string} */ (c.status)] || '?';
  const args = c.effect ? String(c.effect).replace(/^[^:]*:\s*/, '') : briefArgs(c.args);
  const time = typeof c.durationMs === 'number' ? ` — ${c.durationMs}ms` : '';
  const error = c.error ? ` — ${c.error}` : '';
  return `${mark} ${c.name} ${args}${time}${error}`.replace(/\s+/g, ' ').trim();
}

/**
 * A call's arguments, in brief.
 * @param {unknown} args - Recorded arguments
 * @returns {string} One short line
 */
function briefArgs(args) {
  const text = JSON.stringify(args ?? {});
  return text.length > 120 ? text.slice(0, 119) + '…' : text;
}

/**
 * A timer that can be stopped and started again, counting only the time it
 * runs: a program's clock, which stops while the program waits on the user.
 * Holds take turns, so a pause never nests in another.
 * @param {number} ms - How long it runs before it fires
 * @param {() => void} onExpire - Called once, when it fires
 * @returns {{pause: () => void, resume: () => void, stop: () => void}} The timer
 */
export function pausableTimer(ms, onExpire) {
  let remaining = ms;
  let startedAt = Date.now();
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = setTimeout(onExpire, remaining);
  let paused = false;
  let stopped = false;
  return {
    pause: () => {
      if (stopped || paused) return;
      paused = true;
      if (timer) clearTimeout(timer);
      timer = null;
      remaining -= Date.now() - startedAt;
    },
    resume: () => {
      if (stopped || !paused) return;
      paused = false;
      startedAt = Date.now();
      timer = setTimeout(onExpire, Math.max(0, remaining));
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

/**
 * A Yjs value as a plain one.
 * @param {any} v - A Yjs value or a plain one
 * @returns {any} It, plain
 */
function plainOf(v) {
  return v?.toJSON ? v.toJSON() : v;
}

/**
 * Append a program's console output to the text the model reads.
 * @param {string} text - The result or error text
 * @param {string[]} lines - Console lines, already capped by the sandbox
 * @returns {string} text, followed by the output when there is any
 */
function withConsole(text, lines) {
  return lines.length > 0 ? `${text}\n\nConsole output:\n${lines.join('\n')}` : text;
}

export default RunCodeContextItem;
