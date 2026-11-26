//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * How a strategy shapes the conversation's chrome: `MANIFEST.ui`.
 *
 * Every field is read from the **conversation's** strategy — the root
 * thread's — never a sub-thread's: the chrome belongs to the conversation,
 * and its transcript is drawn under one grouping rule. A sub-thread switched
 * to another strategy changes what that thread may do, not how the
 * conversation looks.
 *
 * - `ui.hide` names the controls the strategy has no use for. The composer and
 *   the conversation footer mark themselves with `data-chrome-hide="<ids>"`,
 *   and the core stylesheets hold one rule per id that takes the matching
 *   button out of view; nothing toggles the buttons' own `hidden`, which the
 *   footer already drives for reasons of its own (whether there is anything
 *   to add, anything to duplicate). Only the button goes. Some of what they do
 *   stays reachable another way — a typed `/` or `$`, the undo and redo
 *   shortcuts, the history keys — but the log, add-context, duplicate,
 *   send-later and continue buttons have no other route (continue's nearest
 *   stand-in is typing "continue"), so a strategy that hides them puts them
 *   out of reach for as long as it is the conversation's.
 * - `ui.strategySelector: 'chip'` shrinks the strategy picker to a chip naming
 *   the strategy (`data-strategy-selector="chip"` on the composer). It opens
 *   the same menu, so the user can always switch to a strategy that shows
 *   what this one hides. The picker cannot be hidden outright.
 * - `ui.toolGrouping` is `'always'` or `'never'`: tool runs folded, or not,
 *   whatever the window's grouping toggle says (utils/tool-grouping-pref.js).
 *
 * An unknown id or value is ignored, with one console warning per strategy.
 * @module utils/strategy-chrome
 */

/**
 * Every control a strategy may hide, by the id it names it with in
 * `MANIFEST.ui.hide`.
 *
 * - `commands` — the composer's slash-commands button
 * - `prompt-history` — the composer's prompt-history button
 * - `skills` — the composer's load-a-skill button
 * - `send-later` — the composer's send-later button
 * - `log` — the footer's open-the-conversation-log button
 * - `tokens` — the footer's token count
 * - `add-context` — the footer's add-context-item button
 * - `undo-redo` — the footer's undo and redo buttons
 * - `duplicate` — the footer's duplicate-as-new-conversation button
 * - `continue` — the footer's continue button
 * @type {readonly string[]}
 */
const CHROME_CONTROLS = Object.freeze([
  'commands',
  'prompt-history',
  'skills',
  'send-later',
  'log',
  'tokens',
  'add-context',
  'undo-redo',
  'duplicate',
  'continue',
]);

/**
 * The values `ui.strategySelector` may take.
 * @type {readonly string[]}
 */
const STRATEGY_SELECTOR_FORMS = Object.freeze(['chip']);

/**
 * The values `ui.toolGrouping` may take.
 * @type {readonly string[]}
 */
const TOOL_GROUPING_MODES = Object.freeze(['always', 'never']);

/**
 * What has been warned about, `<strategy id>::<field>`, so the console says it
 * once per strategy and field, not once per render.
 * @type {Set<string>}
 */
const warned = new Set();

/**
 * Warn once about a strategy's `ui` field holding something it cannot.
 * @param {import('juggler/strategy-type').StrategyManifest|null|undefined} manifest - The strategy's manifest
 * @param {string} field - The field, e.g. `ui.hide`
 * @param {string} detail - What was wrong, and what is accepted
 */
function warnOnce(manifest, field, detail) {
  const key = `${manifest?.id ?? ''}::${field}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[strategy-chrome] Strategy "${manifest?.id}" ${field}: ${detail}`);
}

/**
 * The manifest of a conversation's strategy — its root thread's.
 * @param {import('../model/message-thread.js').default|null|undefined} messageThread - Any thread of the conversation
 * @returns {import('juggler/strategy-type').StrategyManifest|undefined} The manifest, if one can be read
 */
function conversationStrategyManifest(messageThread) {
  const root = messageThread?.conversation?.rootMessageThread ?? messageThread;
  try {
    return root?.strategy?.getManifest?.();
  } catch {
    return undefined;
  }
}

/**
 * The controls a strategy manifest hides: its `ui.hide` ids that name a
 * control, in {@link CHROME_CONTROLS} order. An unknown id is dropped, with
 * one warning per strategy.
 * @param {import('juggler/strategy-type').StrategyManifest|null|undefined} manifest - The strategy's manifest
 * @returns {Set<string>} The ids to hide (empty when none)
 */
function hiddenChromeForManifest(manifest) {
  /** @type {unknown} */
  const declared = manifest?.ui?.hide;
  /** @type {Set<string>} */
  const out = new Set();
  if (!Array.isArray(declared)) return out;
  /** @type {string[]} */
  const hide = declared;
  const unknown = hide.filter((id) => !CHROME_CONTROLS.includes(id));
  if (unknown.length > 0) {
    warnOnce(manifest, 'ui.hide', `unknown control(s) ${unknown.join(', ')} ignored. Known: ${CHROME_CONTROLS.join(', ')}.`);
  }
  for (const id of CHROME_CONTROLS) {
    if (hide.includes(id)) out.add(id);
  }
  return out;
}

/**
 * A `ui` field that takes one of a fixed set of strings: its value when it is
 * one of them, else null — with one warning for a value that is not.
 * @param {import('juggler/strategy-type').StrategyManifest|null|undefined} manifest - The strategy's manifest
 * @param {'strategySelector'|'toolGrouping'} field - The field of `ui`
 * @param {readonly string[]} allowed - The values it takes
 * @returns {string|null} The value, or null when absent or unknown
 */
function enumField(manifest, field, allowed) {
  /** @type {unknown} */
  const value = manifest?.ui?.[field];
  if (value === undefined) return null;
  if (typeof value === 'string' && allowed.includes(value)) return value;
  warnOnce(manifest, `ui.${field}`, `${JSON.stringify(value)} ignored. Accepted: ${allowed.map((v) => `'${v}'`).join(', ')}.`);
  return null;
}

/**
 * How a conversation's strategy has its tool runs drawn
 * (`MANIFEST.ui.toolGrouping`).
 * @param {import('../model/message-thread.js').default|null|undefined} messageThread - Any thread of the conversation
 * @returns {'always'|'never'|null} The strategy's rule, or null to follow the window's toggle
 */
export function strategyToolGrouping(messageThread) {
  if (!messageThread) return null;
  return /** @type {'always'|'never'|null} */ (enumField(conversationStrategyManifest(messageThread), 'toolGrouping', TOOL_GROUPING_MODES));
}

/**
 * Mark a host with how its conversation's strategy shapes it — the controls it
 * hides (`data-chrome-hide`) and the picker's form (`data-strategy-selector`)
 * — or clear the marks when it shapes nothing. Written only on a change, so a
 * re-bind on every rebuild costs nothing.
 * @param {HTMLElement} host - The composer or the footer
 * @param {import('../model/message-thread.js').default|null|undefined} messageThread - The bound thread
 */
export function applyChromeHide(host, messageThread) {
  const manifest = messageThread ? conversationStrategyManifest(messageThread) : undefined;
  setMark(host, 'data-chrome-hide', [...hiddenChromeForManifest(manifest)].join(' '));
  setMark(host, 'data-strategy-selector', enumField(manifest, 'strategySelector', STRATEGY_SELECTOR_FORMS) ?? '');
}

/**
 * Set an attribute to a value, or remove it for '', touching it only on a change.
 * @param {HTMLElement} host - The element
 * @param {string} name - The attribute
 * @param {string} value - Its value ('' to remove it)
 */
function setMark(host, name, value) {
  if (value) {
    if (host.getAttribute(name) !== value) host.setAttribute(name, value);
  } else if (host.hasAttribute(name)) {
    host.removeAttribute(name);
  }
}

/**
 * Keep a host's marks in step with its conversation's strategy: apply them
 * now, and again whenever the conversation's `currentStrategyId` — the root
 * thread's strategy — changes (the key permission-controls follows for
 * `showsApprovalControls`). The thread is read through `currentThread` at each
 * change rather than captured, because a sub-thread column hands its host a
 * fresh wrapper on every rebuild.
 * @param {HTMLElement} host - The composer or the footer
 * @param {() => (import('../model/message-thread.js').default|null|undefined)} currentThread - The host's bound thread, as of now
 * @returns {() => void} Stop following
 */
export function followChromeHide(host, currentThread) {
  applyChromeHide(host, currentThread());
  const conversation = currentThread()?.conversation;
  if (!conversation?.observeMetadata) return () => {};
  /** @param {{keysChanged?: Set<string>}} event */
  const observer = (event) => {
    if (event.keysChanged?.has?.('currentStrategyId')) applyChromeHide(host, currentThread());
  };
  conversation.observeMetadata(observer);
  return () => conversation.unobserveMetadata(observer);
}
