//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file StatusMessageBuilder - Centralized status message formatting for busy spinner
 * Provides consistent formatting for all status scenarios during LLM processing
 */

import { formatDuration, formatTokens } from '../utils/format.js';
import { t, formatNumber } from '../../sdk/lib/i18n.js';

/**
 * Non-breaking space. The footer status line wraps freely, so every space that
 * binds a number to its unit ("1,024 tokens", "48 KB", "95% cached") is written
 * with this — a count orphaned from its unit across a line break reads as a
 * different number.
 * @type {string}
 */
const NBSP = '\u00A0';

/**
 * Separator between status clauses ("Receiving · 1,024 tokens · 3s"). The space
 * before the bullet is non-breaking so a wrap happens after it: the bullet
 * stays on the line it divides rather than opening the next one.
 * @type {string}
 */
const CLAUSE_SEPARATOR = `${NBSP}· `;

/**
 * Elapsed thresholds at which a waiting label is restated more plainly.
 *
 * A wait of a few seconds and a wait of ten minutes are different situations,
 * and the second one is better described by saying nothing has arrived than by
 * repeating that we are waiting. The elapsed digit alongside the label already
 * carries the number; these only change the words.
 * @type {{waitingQuiet: number, waitingLong: number, toolsLong: number}}
 */
const RESTATE_AFTER_MS = Object.freeze({
  /** Awaiting the first token: nothing has come back yet. */
  waitingQuiet: 3 * 60 * 1000,
  /** Awaiting the first token, well past the point of being unusual. */
  waitingLong: 8 * 60 * 1000,
  /** Tool calls still executing long after a typical tool would have finished. */
  toolsLong: 5 * 60 * 1000,
});

/**
 * @typedef {object} StreamingStatusData
 * @property {number} [inputTokens] - Tokens sent to LLM
 * @property {number} [outputTokens] - Tokens received from LLM
 * @property {number} [cachedTokens] - Prompt tokens served from cache (OpenAI)
 * @property {number} [elapsedTime] - Elapsed time in milliseconds
 * @property {string} [phase] - Provider-emitted retry, cache, or notice status
 * @property {string} [description] - Current provider activity snapshot
 */

/**
 * @typedef {object} UploadingStatusData
 * @property {number} payloadSize - Payload size in bytes
 * @property {number} [elapsedTime] - Elapsed time in milliseconds
 */

/**
 * Builds consistent status messages for the busy spinner
 */
export class StatusMessageBuilder {
  /**
   * Trailing marker that signals an in-progress action (e.g. "Receiving…").
   *
   * This is the SINGLE control point for the busy ellipsis across every
   * spinner / footer status message. The individual status strings are authored
   * WITHOUT any ellipsis; the marker is added once at the render seam via
   * withBusyMarker(). Set this to '' to render every status with no trailing
   * ellipsis at all.
   * @type {string}
   */
  static busyMarker = '';

  /**
   * Decorate a fully-built status message with the in-progress marker. Status
   * strings bubble up from the builders unadorned; this is applied once at the
   * render seam (see LLMState.getStatusMessage) so the marker is purely
   * presentational and the stored message stays bare. Any ellipsis a message
   * already carries (unicode '…' or three dots) is normalised away first, so
   * this is the single point that decides both the style and whether the marker
   * appears at all. With `busyMarker` set to '' it strips any stray ellipsis and
   * adds none.
   * @param {string} message - A built status message (no trailing ellipsis expected)
   * @returns {string} The message with the single busy marker applied
   */
  static withBusyMarker(message) {
    if (!message) return message;
    const bare = message.replace(/\s*(\u2026|\.\.\.)\s*$/, '');
    return StatusMessageBuilder.busyMarker ? `${bare}${StatusMessageBuilder.busyMarker}` : bare;
  }

  /**
   * Format elapsed time compactly. Millisecond-input adapter over the canonical
   * {@link formatDuration}; examples: "3s", "45s", "3m 14s", "2h 15m".
   * @param {number} milliseconds - Elapsed time in milliseconds
   * @returns {string} Formatted elapsed time
   * @private
   */
  static _formatElapsedTime(milliseconds) {
    return formatDuration(Math.floor(milliseconds / 1000));
  }

  /**
   * Join a status label with the optional elapsed-time suffix. Shared by the
   * builders whose message is just "<label> · <elapsed>".
   * @param {string} label - The status label (authored without ellipsis)
   * @param {{elapsedTime?: number}} [data] - Optional data with elapsed time
   * @returns {string} Formatted status message
   * @private
   */
  static _withElapsed(label, data = {}) {
    const parts = [label];
    if (data.elapsedTime !== undefined) {
      parts.push(this._formatElapsedTime(data.elapsedTime));
    }
    return parts.join(CLAUSE_SEPARATOR);
  }

  /**
   * Reduce a provider-authored activity snapshot to a plain one-line label.
   *
   * Footer status is plain text, but providers write Markdown: a GPT reasoning
   * summary is a bold heading over a paragraph ("**Inspecting the footer**\n\n
   * I am reading…"), re-sent whole as it grows. The first non-empty line is the
   * label — for a summary, its heading — and its Markdown is reduced to the
   * text it marks up. An emphasis opener whose closer has not streamed in yet
   * is dropped too, so a heading arriving a few characters at a time never
   * shows a stray marker.
   * @param {string} description - Provider activity snapshot
   * @returns {string} Plain status label
   * @private
   */
  static _plainActivity(description) {
    const line = description.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
    return line
      // Block prefixes: heading, blockquote, list bullet or number.
      .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
      // Links and images keep their text.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`+([^`]+)`+/g, '$1')
      // Paired emphasis. Single `*`/`_` only at word edges, so snake_case and
      // a*b*c are left as written.
      .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, '$1$2')
      .replace(/(^|[^\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, '$1$2')
      // An opener still waiting for its closer.
      .replace(/^(?:\*\*|__|~~|\*|_|`)(?=\S)/, '')
      .trim();
  }

  /**
   * Builds status message for streaming response
   * @param {StreamingStatusData} data - Streaming status information
   * @returns {string} Formatted status message
   */
  static buildStreamingStatus(data) {
    // A provider activity snapshot is the most specific account of the current
    // work, so it outranks startup phase and the generic fallback even after
    // output begins. Startup phase remains useful only before the first token.
    // Labels stay unadorned here; the busy marker is added at the render seam.
    const hasOutput = data.outputTokens !== undefined && data.outputTokens > 0;
    const description = data.description ? this._plainActivity(data.description) : '';
    const lead = description || ((!hasOutput && data.phase) ? data.phase : t('Receiving'));
    const parts = [lead];

    // Append token counts when available; the lead label stays so the user
    // always sees the activity label, with the running number alongside it.
    // Counts go through formatTokens, the app-wide compact form, so a status
    // line reads the same way as the footer pill and the model selector.
    if (data.outputTokens !== undefined && data.outputTokens > 0) {
      const output = data.outputTokens;
      const input = data.inputTokens;
      const cached = data.cachedTokens;

      if (input !== undefined && input > 0) {
        // The plural follows the total, as the English always has. The arrow
        // binds to the count before it, so a wrap puts the arrow at the end of
        // the line rather than dangling one at the start of the next.
        const total = input + output;
        if (cached !== undefined && cached > 0) {
          const percent = formatNumber(Math.round((cached / input) * 100));
          parts.push(t('{total, plural, one {{input} ({percent}%\u00A0cached)\u00A0→ {output}\u00A0token} other {{input} ({percent}%\u00A0cached)\u00A0→ {output}\u00A0tokens}}',
            { total, input: formatTokens(input), percent, output: formatTokens(output) }));
        } else {
          parts.push(t('{total, plural, one {{input}\u00A0→ {output}\u00A0token} other {{input}\u00A0→ {output}\u00A0tokens}}',
            { total, input: formatTokens(input), output: formatTokens(output) }));
        }
      } else {
        parts.push(t('{total, plural, one {{count}\u00A0token} other {{count}\u00A0tokens}}',
          { total: output, count: formatTokens(output) }));
      }
    }

    // Add elapsed time if available
    if (data.elapsedTime !== undefined) {
      parts.push(this._formatElapsedTime(data.elapsedTime));
    }

    return parts.join(CLAUSE_SEPARATOR);
  }

  /**
   * Builds status message for preparing request
   * @param {StreamingStatusData} [data] - Optional data with elapsed time
   * @returns {string} Formatted status message
   */
  static buildPreparingStatus(data = {}) {
    return this._withElapsed(t('Preparing request'), data);
  }

  /**
   * Builds status message for waiting for LLM response.
   *
   * The label restates itself as the wait grows (see {@link RESTATE_AFTER_MS}):
   * past a few minutes with no first token, the useful fact is that nothing has
   * arrived, not that we are still waiting for it.
   * @param {StreamingStatusData} [data] - Optional data with elapsed time
   * @returns {string} Formatted status message
   */
  static buildWaitingStatus(data = {}) {
    const elapsed = data.elapsedTime ?? 0;
    let label = t('Waiting for response');
    if (elapsed >= RESTATE_AFTER_MS.waitingLong) label = t('Still nothing back');
    else if (elapsed >= RESTATE_AFTER_MS.waitingQuiet) label = t('Nothing back yet');
    return this._withElapsed(label, data);
  }

  /**
   * Builds status message for uploading context
   * @param {UploadingStatusData} data - Upload status data
   * @returns {string} Formatted status message
   */
  static buildUploadingStatus(data) {
    const sizeKB = Math.ceil(data.payloadSize / 1024);
    return this._withElapsed(t('Uploading context {size}\u00A0KB', { size: formatNumber(sizeKB) }), data);
  }

  /**
   * Builds status message for processing tools.
   *
   * Past {@link RESTATE_AFTER_MS.toolsLong} the label drops the expectation
   * that they are about to finish and just reports that they are still going.
   * @param {StreamingStatusData} [data] - Optional data with elapsed time
   * @returns {string} Formatted status message
   */
  static buildProcessingToolsStatus(data = {}) {
    const label = (data.elapsedTime ?? 0) >= RESTATE_AFTER_MS.toolsLong
      ? t('Tools still running')
      : t('Waiting for tools to finish');
    return this._withElapsed(label, data);
  }

  /**
   * Builds status message for executing action (approved action running)
   * @param {StreamingStatusData} [data] - Optional data with elapsed time
   * @returns {string} Formatted status message
   */
  static buildExecutingActionStatus(data = {}) {
    return this._withElapsed(t('Running action'), data);
  }

  /**
   * Builds status message for cancellation
   * @returns {string} Cancellation status message
   */
  static buildCancelledStatus() {
    return t('Operation cancelled');
  }

  /**
   * Builds status message for custom operations (e.g., compacting, retrying).
   * Custom messages are in-progress labels too, so they take the same busy
   * marker as the built-in labels at the render seam — authored without an
   * ellipsis here.
   * @param {string} message - Required custom message to display
   * @param {StreamingStatusData} [data] - Optional data with elapsed time
   * @returns {string} Formatted status message
   */
  static buildCustomStatus(message, data = {}) {
    return this._withElapsed(message, data);
  }

  /**
   * Builds an empty status (for very brief moments before we know what's happening)
   * @returns {string} Empty status string
   */
  static buildEmptyStatus() {
    return '';
  }
}
