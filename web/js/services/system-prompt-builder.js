//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shared system-prompt assembly — the single source of truth for how the
 * system prompt is built from a message thread's system-position context items
 * plus the active strategy's guidance.
 *
 * Both the production path (the worker context-request callback in
 * session-worker-callbacks.js) and the tests' context builder
 * (js-tests/utilities/context-builder.js `prepare()`) call this, so the two
 * can't drift.
 * @module services/system-prompt-builder
 */

/**
 * A context item is "system position" when its class manifest declares
 * `contextPosition: 'system'`. Its content lives in the system prompt rather
 * than as a conversation message.
 * @param {any} item - Context item instance
 * @returns {boolean} True if the item's content belongs in the system prompt
 */
export function isSystemPositionItem(item) {
  return contextPositionOf(item) === 'system';
}

/**
 * The declared injection position for a context item — where its rendered
 * content lands in the LLM request. Reads the class manifest's
 * `contextPosition`, defaulting to `'prefix'` (leading, cached, before history)
 * when unset. One of `'system' | 'prefix' | 'none'`; see the ContextItemManifest
 * typedef for what each means. Single source of truth so the worker-callbacks
 * bucketing and the system-prompt filter can't drift.
 * @param {any} item - Context item instance
 * @returns {'system'|'prefix'|'none'} The item's context position
 */
export function contextPositionOf(item) {
  const ctor = /** @type {{MANIFEST?: {contextPosition?: string}}} */ (item.constructor);
  const pos = ctor.MANIFEST?.contextPosition;
  return (pos === 'system' || pos === 'none') ? pos : 'prefix';
}

/**
 * Filter a context-item list to the system-position subset, preserving order.
 * @param {any[]} contextItems - All context items on the thread
 * @returns {any[]} System-position context items
 */
export function systemPositionItems(contextItems) {
  return contextItems.filter(isSystemPositionItem);
}

/**
 * Assemble the full system prompt string.
 *
 * Order (stable — callers depend on it):
 *   1. The `system-prompt` item's `buildPrompt()` (identity + environment).
 *   2. Every other system-position item's rendered content (e.g. rules),
 *      in thread order, separated by a blank line.
 *   3. Enabled extensions' aggregated system-prompt contributions (terse,
 *      durable tool/behavioral guidance — cache-stable, varies only on plugin
 *      toggles). This is where tone, tool-preference, and per-tool guidance
 *      live (extension-owned).
 *
 * Strategies contribute NOTHING to the system prompt: they steer the model
 * through injected system-reminder messages (injectGuidance), tool gating, and
 * loop control. Keeping all strategy influence out of the system prompt is what
 * lets the cached system prefix stay byte-stable across a strategy switch.
 * @param {object} args
 * @param {any[]} args.contextItems - All context items on the thread
 * @param {object} args.contextParams - Params passed to each item's getContextText()
 * @param {string} [args.extensionContributions] - Pre-aggregated enabled-extension contributions (from buildExtensionSystemPromptContributions); empty string when none
 * @returns {Promise<string>} The assembled system prompt (possibly empty string)
 */
export async function assembleSystemPrompt({ contextItems, contextParams, extensionContributions = '' }) {
  const sysItems = systemPositionItems(contextItems);

  let systemPrompt = '';

  // 1. Identity + environment from the system-prompt item.
  const systemPromptItem = sysItems.find(f => f.type === 'system-prompt');
  if (systemPromptItem && typeof systemPromptItem.buildPrompt === 'function') {
    systemPrompt = systemPromptItem.buildPrompt();
  }

  // 2. Other system-position items (rules etc.).
  for (const item of sysItems) {
    if (item.type === 'system-prompt') continue;
    const content = await item.getContextText(contextParams);
    if (content) {
      systemPrompt += '\n\n' + content;
    }
  }

  // 3. Enabled extensions' contributions (the extension's voice on its tools).
  if (extensionContributions && extensionContributions.trim()) {
    systemPrompt += '\n\n' + extensionContributions.trim();
  }

  return systemPrompt;
}
