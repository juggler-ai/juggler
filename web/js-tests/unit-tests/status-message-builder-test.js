//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Every status line the busy spinner and footer show — built by
 * `StatusMessageBuilder`, with `LLMState`'s fallbacks for frames that carry no
 * label — follows the UI language.
 *
 * A line is clauses joined by the separator ("Receiving · 12 tokens · 3s"). The
 * elapsed clause is `Intl.DurationFormat` output — data, not a message — so it
 * is dropped before the check; every other clause must be pseudo-localised.
 * @module unit-tests/status-message-builder-test
 */

import LLMState from '../../js/services/llm-state.js';
import { StatusMessageBuilder } from '../../js/services/status-message-builder.js';
import { formatDuration, formatTokens } from '../../js/utils/format.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';

/** The clause separator the builder joins with (non-breaking space, bullet, space). */
const SEPARATOR = '\u00A0· ';

/**
 * Run the status-message-builder test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  /** @type {string[]} */
  const errors = [];
  let passed = 0;
  let failed = 0;

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('en-XA: every status line the builder and LLMState draw is translated', async () => {
    await underPseudoLocale('status-message-builder-test', async () => {
      /** @type {Array<[string, string]>} */
      const lines = [];
      /**
       * @param {string} where - The state drawn
       * @param {string} line - The status line it drew
       * @returns {void}
       */
      const see = (where, line) => { lines.push([where, line]); };
      const B = StatusMessageBuilder;

      // The builder, every status with and without its optional data.
      see('preparing', B.buildPreparingStatus());
      see('preparing+elapsed', B.buildPreparingStatus({ elapsedTime: 3000 }));
      see('waiting', B.buildWaitingStatus({ elapsedTime: 3000 }));
      see('waiting quiet', B.buildWaitingStatus({ elapsedTime: 4 * 60 * 1000 }));
      see('waiting long', B.buildWaitingStatus({ elapsedTime: 9 * 60 * 1000 }));
      see('uploading', B.buildUploadingStatus({ payloadSize: 48 * 1024 }));
      see('uploading+elapsed', B.buildUploadingStatus({ payloadSize: 1500 * 1024, elapsedTime: 3000 }));
      see('tools', B.buildProcessingToolsStatus());
      see('tools long', B.buildProcessingToolsStatus({ elapsedTime: 6 * 60 * 1000 }));
      see('executing', B.buildExecutingActionStatus({ elapsedTime: 3000 }));
      see('cancelled', B.buildCancelledStatus());
      see('streaming bare', B.buildStreamingStatus({}));
      see('streaming 1 out', B.buildStreamingStatus({ outputTokens: 1 }));
      see('streaming 5 out', B.buildStreamingStatus({ outputTokens: 5, elapsedTime: 3000 }));
      see('streaming in→out', B.buildStreamingStatus({ inputTokens: 1200, outputTokens: 30 }));
      see('streaming cached', B.buildStreamingStatus({ inputTokens: 1200, cachedTokens: 900, outputTokens: 30, elapsedTime: 3000 }));

      // LLMState's own fallbacks, through the frames that reach them.
      const llm = /** @type {any} */ (new LLMState());
      const convId = 'conv-status-builder-xa';
      llm._conversations.set(convId, {
        showWarning: () => {},
        restorePendingMessage: () => {},
        trySelfHealMissingModel: () => false,
        armSelfHeal: () => {},
      });
      try {
        /**
         * @param {object} frame - A worker processingState frame
         * @returns {void}
         */
        const publish = (frame) => { llm._handleProcessingStateChange(convId, frame); };
        const startedAt = Date.now() - 3000;
        publish({ status: 'preparing', startedAt });
        see('llm preparing', llm.getStatusMessage(convId));
        publish({ status: 'streaming', startedAt, outputTokens: 12 });
        see('llm streaming', llm.getStatusMessage(convId));
        publish({ status: 'retrying', startedAt });
        see('llm retrying fallback', llm.getStatusMessage(convId));
        publish({ status: 'compacting', startedAt });
        see('llm compacting fallback', llm.getStatusMessage(convId));
      } finally {
        llm.stop(convId);
      }

      // Elapsed clauses are Intl output (data): drop them, check the rest.
      const elapsed = new Set();
      for (let s = 0; s <= 1000; s++) elapsed.add(formatDuration(s));
      /** @type {string[]} */
      const raw = [];
      for (const [where, line] of lines) {
        assert(!!line, `${where}: drew an empty status`);
        const clauses = line.split(SEPARATOR).filter((c) => !elapsed.has(c));
        assert(clauses.length > 0, `${where}: nothing but elapsed time in "${line}"`);
        for (const clause of clauses) {
          if (!isPseudoLocalized(clause)) raw.push(`${where}: ${JSON.stringify(clause)}`);
        }
      }
      assert(raw.length === 0, `plain English under en-XA:\n  ${raw.join('\n  ')}`);
    });
  });

  // The streaming line is the running count alone. The call's output limit is
  // not the user's concern while a reply streams (a cut-off reply gets its own
  // notice), so a frame that still carries one — from a worker of an older
  // build — draws no "/ limit" beside the count.
  await run('a frame carrying maxOutputTokens shows the count alone', async () => {
    const llm = /** @type {any} */ (new LLMState());
    const convId = 'conv-status-builder-max-output';
    llm._conversations.set(convId, {
      showWarning: () => {},
      restorePendingMessage: () => {},
      trySelfHealMissingModel: () => false,
      armSelfHeal: () => {},
    });
    try {
      const startedAt = Date.now();
      llm._handleProcessingStateChange(convId, { status: 'streaming', startedAt, outputTokens: 1200, maxOutputTokens: 32768 });
      const line = llm.getStatusMessage(convId);
      const want = `${formatTokens(1200)}\u00A0tokens`;
      assert(line.includes(want), `status line = "${line}", want it to include "${want}"`);
      assert(!line.includes(formatTokens(32768)), `status line = "${line}", want no output limit drawn`);
    } finally {
      llm.stop(convId);
    }
  });

  return { passed, failed, errors };
}
