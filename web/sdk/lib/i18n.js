//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * UI translation core behind the `juggler/i18n` SDK specifier.
 *
 * **English source text is the key and the fallback.** `t('Close')` looks
 * `Close` up in the catalogues registered for the active locale and returns the
 * English when nothing matches — no catalogue, no key, or a translation that
 * will not parse. Wrapping a string is therefore invisible until a catalogue
 * exists for it, which is what lets UI files be converted one at a time.
 *
 * **Messages** use `{name}` placeholders and a small, hand-written subset of ICU
 * MessageFormat: `{count, plural, =0 {…} one {# item} other {# items}}` (plural
 * categories from `Intl.PluralRules`, `#` = the count in the active number
 * format) and `{kind, select, file {…} other {…}}`. Placeholders nest inside
 * branches. A `{name}` value is inserted with `String()` — wrap a number in
 * {@link formatNumber} first when it should be grouped. An apostrophe quotes
 * syntax characters, as in ICU: `'{'` is a literal brace and `''` a literal
 * apostrophe; an apostrophe before anything else is plain text, so English
 * contractions need no escaping.
 *
 * **Translate at render time.** A `t()` evaluated when a module loads (a label in
 * a module-level table) is fixed in whatever locale was active then. Keep
 * English in such tables, wrapped in {@link markForTranslation} so it is
 * extracted, and call `t()` where they are rendered; the
 * `juggler/no-raw-ui-string` lint rule flags module-scope calls.
 *
 * **Model-facing text stays English** — tool descriptions, prompts, presets.
 * {@link markUntranslated} marks such a string so the UI/model boundary is
 * visible in the code and the lint rule treats it as handled.
 *
 * **Catalogues are scoped.** Each is registered under a namespace — `core`, or
 * an extension id. An extension's text is looked up in its own namespace, then
 * core's, never another extension's ({@link translator}); unscoped text in
 * core's first, so no extension can re-word the core UI.
 *
 * Two locales are tracked. The *UI locale* chooses catalogues; while none has
 * been chosen it reads as `en`. The *formatting locale* drives the `Intl`
 * formatters and stays `undefined` — the runtime's own default — until a UI
 * locale is chosen, so dates and numbers look exactly as the platform would
 * format them. The pseudo-locale `en-XA` formats as `en`.
 *
 * In a document, the locale and its catalogue are read once at load from
 * `<html data-ui-locale>` and an inline
 * `<script type="application/json" id="juggler-ui-catalog">`, both written by the
 * server before the page paints, so every module that imports `t` sees them
 * before it renders anything. Off the main thread nothing is read; the host sets
 * the locale with {@link setLocale}.
 *
 * Pure and DOM-free apart from that one guarded read, so the browser facade and
 * the worker twin export the same functions.
 * @module sdk/lib/i18n
 */

/** The language every message is written in, and the fallback for all of them. */
export const SOURCE_LOCALE = 'en';

/** The generated pseudo-locale: accented, padded English for spotting raw strings. */
export const PSEUDO_LOCALE = 'en-XA';

/** The namespace the core UI's catalogue is registered under. */
export const CORE_NAMESPACE = 'core';

/** Separates context from source in a catalogue key (gettext's convention). */
const CONTEXT_SEPARATOR = '\u0004';

/** The UI locale as chosen; '' when nothing has been chosen. */
let uiLocale = '';

/**
 * Registered catalogues: namespace → locale → messages. A Map so that, among
 * extensions, lookup order is registration order: an unscoped key two
 * extensions both translate resolves the same way every time — to the first
 * one registered. Core always comes first (see {@link lookup}).
 * @type {Map<string, Map<string, Record<string, string>>>}
 */
const catalogs = new Map();

/** Parsed messages, by message text. Parsing is the expensive part of `t()`. */
const parsedCache = /** @type {Map<string, MessageNode[]|null>} */ (new Map());

/** Intl formatter instances, by kind + locale + options. */
const formatterCache = /** @type {Map<string, unknown>} */ (new Map());

/**
 * @typedef {string
 *   | {type: 'arg', name: string}
 *   | {type: 'pound'}
 *   | {type: 'plural'|'select', name: string, options: Record<string, MessageNode[]>}} MessageNode
 */

// ---------------------------------------------------------------------------
// Locale state
// ---------------------------------------------------------------------------

/**
 * Set the UI locale. '' (or any falsy value) means "not chosen": English
 * messages and the runtime's default formatting.
 *
 * The tag is stored in `Intl`'s canonical form (`zh-hant-tw` → `zh-Hant-TW`),
 * so catalogue lookups match the canonical file names. A tag `Intl` rejects is
 * treated as "not chosen" — every formatter would otherwise throw a RangeError
 * on it, taking whatever was rendering down with it.
 * @param {string|null|undefined} locale - A BCP 47 tag, or '' for none.
 * @returns {string} The previous value, as stored, for restoring.
 */
export function setLocale(locale) {
  const previous = uiLocale;
  uiLocale = canonicalLocale(typeof locale === 'string' ? locale.trim() : '');
  return previous;
}

/**
 * `Intl`'s canonical form of a tag, or '' for one it rejects.
 * @param {string} tag
 * @returns {string} The canonical tag, or ''.
 */
function canonicalLocale(tag) {
  if (!tag) return '';
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * The active UI locale — `en` when none has been chosen.
 * @returns {string} A BCP 47 tag.
 */
export function getLocale() {
  return uiLocale || SOURCE_LOCALE;
}

/**
 * The locale the `Intl` formatters use: `undefined` (the runtime default) while
 * no UI locale is chosen, `en` for the pseudo-locale, otherwise the UI locale.
 * @returns {string|undefined} A BCP 47 tag, or undefined for the runtime default.
 */
export function formattingLocale() {
  if (!uiLocale) return undefined;
  if (uiLocale === PSEUDO_LOCALE) return SOURCE_LOCALE;
  return uiLocale;
}

/**
 * The locales to search for a message, most specific first, stopping short of
 * the source language: `zh-Hant-TW` → `zh-Hant-TW`, `zh-Hant`, `zh`.
 * @param {string} locale
 * @returns {string[]} The lookup chain.
 */
function lookupChain(locale) {
  const chain = [];
  const parts = locale.split('-');
  for (let n = parts.length; n > 0; n--) chain.push(parts.slice(0, n).join('-'));
  return chain;
}

// ---------------------------------------------------------------------------
// Catalogues
// ---------------------------------------------------------------------------

/**
 * Register translations for one locale. Calling it again for the same namespace
 * and locale replaces that catalogue. Keys are the English source, or
 * {@link messageKey}(source, context) for a message with a context.
 * @param {string} namespace - Who owns the catalogue (`core`, or an extension id).
 * @param {string} locale - The BCP 47 tag the messages are in.
 * @param {Record<string, string>} messages - English key → translated message.
 * @returns {void}
 */
export function registerCatalog(namespace, locale, messages) {
  // Stored under the canonical tag, as setLocale stores the active one.
  const tag = canonicalLocale(typeof locale === 'string' ? locale.trim() : '');
  if (!namespace || !tag || !messages || typeof messages !== 'object') return;
  let byLocale = catalogs.get(namespace);
  if (!byLocale) {
    byLocale = new Map();
    catalogs.set(namespace, byLocale);
  }
  byLocale.set(tag, { ...messages });
}

/**
 * Drop every catalogue a namespace registered.
 * @param {string} namespace
 * @returns {void}
 */
export function unregisterCatalog(namespace) {
  catalogs.delete(namespace);
}

/**
 * The catalogue key for a message: the English source, prefixed by its context
 * when it has one, so `Open` the verb and `Open` the state translate separately.
 * @param {string} source - The English message.
 * @param {string} [context] - Disambiguates identical English with different meanings.
 * @returns {string} The key.
 */
export function messageKey(source, context) {
  return context ? `${context}${CONTEXT_SEPARATOR}${source}` : source;
}

/**
 * The namespaces a message is looked up in, in order. Scoped to a namespace:
 * that one, then core — its own text, then the shared vocabulary, never another
 * extension's. Unscoped: core, then every extension in registration order. Core
 * leads either way but the scoped one, so no extension catalogue can re-word
 * the core UI.
 * @param {string|undefined} namespace
 * @returns {string[]} Namespace names.
 */
function lookupNamespaces(namespace) {
  if (namespace && namespace !== CORE_NAMESPACE) return [namespace, CORE_NAMESPACE];
  if (namespace === CORE_NAMESPACE) return [CORE_NAMESPACE];
  return [CORE_NAMESPACE, ...[...catalogs.keys()].filter((ns) => ns !== CORE_NAMESPACE)];
}

/**
 * Find a translation for `key`: each namespace in turn (see
 * {@link lookupNamespaces}), each along the active locale's whole chain before
 * the next is tried — so core's `fr` outranks an extension's `fr-CA`.
 * @param {string} key
 * @param {string} [namespace] - Whose text this is; omitted for unscoped text.
 * @returns {{message: string, locale: string}|null} The message and the locale it is written in.
 */
function lookup(key, namespace) {
  if (!uiLocale || catalogs.size === 0) return null;
  const chain = lookupChain(uiLocale);
  for (const ns of lookupNamespaces(namespace)) {
    const byLocale = catalogs.get(ns);
    if (!byLocale) continue;
    for (const locale of chain) {
      const messages = byLocale.get(locale);
      if (messages && Object.hasOwn(messages, key)) {
        const message = messages[key];
        if (typeof message === 'string' && message !== '') return { message, locale };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Translate a UI message.
 *
 * Call it where the text is rendered, never at module scope.
 * @param {string} source - The English message: the key and the fallback.
 * @param {Record<string, unknown>} [params] - Values for `{name}` placeholders and plural/select arguments.
 * @param {{context?: string, namespace?: string}} [options] - `context` separates
 *   homographs. `namespace` names whose text this is — an extension id — so its
 *   own catalogue is searched first and no other extension's at all; an
 *   extension gets that from {@link translator} rather than passing it.
 * @returns {string} The message in the active locale, or the English source.
 */
export function t(source, params, options) {
  const text = String(source ?? '');
  const found = lookup(messageKey(text, options?.context), options?.namespace);
  if (found) {
    const out = render(found.message, params, pluralLocale(found.locale));
    if (out !== null) return out;
  }
  const out = render(text, params, SOURCE_LOCALE);
  return out === null ? text : out;
}

/**
 * A `t()` for one extension's text: its own catalogue first, then core's, and
 * never another extension's. The way an extension translates —
 * `const t = translator('@me/my-extension')` — so a word it shares with the
 * core UI or another extension still gets its own translation.
 * @param {string} namespace - The extension id its catalogues are registered under.
 * @returns {(source: string, params?: Record<string, unknown>, options?: {context?: string}) => string}
 *   `t` with the namespace bound.
 */
export function translator(namespace) {
  return (source, params, options) => t(source, params, { ...options, namespace });
}

/**
 * Translate a message the server sent: the wire form of a Go `msg.Message`,
 * `{key, params?, context?}`, whose key is its English template. The server
 * sends the English it rendered alongside, as `fallback`, which is returned
 * whenever `message` is not a message — absent, null, or without a non-empty
 * string key — so an older server, or a field the server leaves as plain
 * text, still shows. Params that are not an object are dropped, and a context
 * that is not a string is ignored. Its argument is data, not a literal, so
 * `scripts/i18n extract` finds the template in the Go source instead.
 * @param {{key?: unknown, params?: unknown, context?: unknown}|null|undefined} message - The wire message.
 * @param {string} [fallback] - The English the server rendered for it.
 * @returns {string} The message in the active locale, or the fallback.
 */
export function serverText(message, fallback = '') {
  if (!message || typeof message !== 'object' || typeof message.key !== 'string' || message.key === '') {
    return fallback;
  }
  const params = message.params && typeof message.params === 'object'
    ? /** @type {Record<string, unknown>} */ (message.params) : undefined;
  const context = typeof message.context === 'string' && message.context !== '' ? message.context : undefined;
  return t(message.key, params, context ? { context } : undefined);
}

/**
 * Mark English source text that is translated later, where it is rendered —
 * the entries of a module-level table, say, whose labels are passed to `t()`
 * when the menu is built. Returns its argument unchanged; its job is to let
 * `scripts/i18n extract` find the message, since `t(opt.label)` names none.
 * Unlike `t()` it is safe at module scope.
 * @template {string} S
 * @param {S} source
 * @returns {S} The same string.
 */
export function markForTranslation(source) {
  return source;
}

/**
 * Mark a string that is deliberately left in English — text the model reads
 * (tool descriptions, prompts), identifiers, or anything else that must not
 * follow the UI language. Returns its argument unchanged.
 * @template {string} S
 * @param {S} text
 * @returns {S} The same string.
 */
export function markUntranslated(text) {
  return text;
}

// ---------------------------------------------------------------------------
// Markup inside a message
// ---------------------------------------------------------------------------

/** Brackets a slot name in a message rendered by htmlSlots(); private-use characters, so no text collides. */
const SLOT_OPEN = '\uE000';
const SLOT_CLOSE = '\uE001';

/** @type {Record<string, string>} */
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };

/**
 * Params for a `t()` whose result goes into HTML with markup in some of its
 * placeholders: each markup name gets a stand-in that {@link withHtml} later
 * replaces. A message never holds tags itself — a translator would have to
 * reproduce them, and the pseudo-locale would accent them — so a link or a
 * `<strong>` is a `{placeholder}`, and its own text is a message of its own.
 *
 *     const markup = { guide: `<a href="…">${escapeHtml(t('the setup guide'))}</a>` };
 *     el.innerHTML = withHtml(t('Read {guide} first.', htmlSlots(markup)), markup);
 * @param {Record<string, string>} markup - Placeholder name → HTML.
 * @param {Record<string, unknown>} [params] - Ordinary params, for the other placeholders.
 * @returns {Record<string, unknown>} Params to pass to `t()`.
 */
export function htmlSlots(markup, params) {
  /** @type {Record<string, unknown>} */
  const out = { ...params };
  for (const name of Object.keys(markup)) out[name] = `${SLOT_OPEN}${name}${SLOT_CLOSE}`;
  return out;
}

/**
 * HTML for a message translated with {@link htmlSlots} params: the text is
 * escaped, then each slot is replaced by its markup. Plain text params are
 * escaped with the rest of the message.
 * @param {string} message - The result of `t(source, htmlSlots(markup, …))`.
 * @param {Record<string, string>} markup - The same markup.
 * @returns {string} HTML safe to assign to `innerHTML`.
 */
export function withHtml(message, markup) {
  const escaped = String(message).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
  return escaped.replace(/\uE000([^\uE000\uE001]*)\uE001/g,
    (_whole, name) => (Object.hasOwn(markup, name) ? markup[name] ?? '' : ''));
}

/**
 * The locale whose plural rules apply to a message written in `locale`.
 * @param {string} locale
 * @returns {string} A tag `Intl.PluralRules` accepts.
 */
function pluralLocale(locale) {
  return locale === PSEUDO_LOCALE ? SOURCE_LOCALE : locale;
}

/**
 * Format a message, or null when it does not parse.
 * @param {string} message
 * @param {Record<string, unknown>|undefined} params
 * @param {string} locale - The locale the message is written in (for plural rules).
 * @returns {string|null} The formatted text.
 */
function render(message, params, locale) {
  // The common case — no placeholders, no quoting — skips the parser entirely.
  if (!message.includes('{') && !message.includes("'")) return message;
  const nodes = parse(message);
  if (!nodes) return null;
  return format(nodes, params || {}, locale, null);
}

/**
 * @param {MessageNode[]} nodes
 * @param {Record<string, unknown>} params
 * @param {string} locale
 * @param {number|null} count - The enclosing plural's value, for `#`.
 * @returns {string} The text.
 */
function format(nodes, params, locale, count) {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') {
      out += node;
    } else if (node.type === 'arg') {
      out += Object.prototype.hasOwnProperty.call(params, node.name)
        ? String(params[node.name])
        : `{${node.name}}`;
    } else if (node.type === 'pound') {
      out += count === null ? '#' : formatNumber(count);
    } else if (node.type === 'plural') {
      const value = Number(params[node.name]);
      const branch = branchFor(node, `=${value}`)
        || branchFor(node, selectPlural(locale, value))
        || branchFor(node, 'other')
        || [];
      out += format(branch, params, locale, Number.isFinite(value) ? value : null);
    } else {
      const raw = params[node.name];
      const value = raw === undefined || raw === null ? '' : `${raw}`;
      const branch = branchFor(node, value) || branchFor(node, 'other') || [];
      out += format(branch, params, locale, count);
    }
  }
  return out;
}

/**
 * A plural/select node's branch for `key`, or undefined. Own keys only: a select
 * value is data, and `constructor` or `toString` must not find a member every
 * object inherits.
 * @param {{options: Record<string, MessageNode[]>}} node
 * @param {string} key
 * @returns {MessageNode[]|undefined} The branch.
 */
function branchFor(node, key) {
  return Object.hasOwn(node.options, key) ? node.options[key] : undefined;
}

/**
 * The CLDR plural category for `value` in `locale`.
 * @param {string} locale
 * @param {number} value
 * @returns {string} `zero`, `one`, `two`, `few`, `many` or `other`.
 */
function selectPlural(locale, value) {
  if (!Number.isFinite(value)) return 'other';
  try {
    return cachedFormatter('plural', locale, undefined, () => new Intl.PluralRules(locale)).select(value);
  } catch {
    return 'other';
  }
}

// ---------------------------------------------------------------------------
// Parser — the ICU subset described at the top of the file
// ---------------------------------------------------------------------------

/**
 * Parse a message into nodes, or null when it is malformed.
 * @param {string} message
 * @returns {MessageNode[]|null} The parsed message.
 */
function parse(message) {
  if (parsedCache.has(message)) return /** @type {MessageNode[]|null} */ (parsedCache.get(message));
  let nodes = null;
  try {
    nodes = parseMessage(message);
  } catch {
    nodes = null;
  }
  parsedCache.set(message, nodes);
  return nodes;
}

/**
 * Parse a message into nodes, for tooling that checks one (scripts/i18n holds
 * every translation to its English source with it). Uncached, and not part of
 * `juggler/i18n`.
 * @param {string} message
 * @returns {MessageNode[]} The parsed message.
 * @throws {Error} When the message is malformed. A plural or select with no
 *   `other` branch throws an error whose `missingOther` is `{kind, name}`.
 */
export function parseMessage(message) {
  const parser = new Parser(message);
  const nodes = parser.parseNodes(false);
  if (parser.pos !== message.length) throw new Error('unmatched }');
  return nodes;
}

/** A recursive-descent parser over one message. Throws on malformed input. */
class Parser {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    this.pos = 0;
  }

  /**
   * Parse text and placeholders up to an unmatched `}` or the end.
   * @param {boolean} inPlural - Whether `#` stands for the plural's count here.
   * @returns {MessageNode[]} The nodes.
   */
  parseNodes(inPlural) {
    /** @type {MessageNode[]} */
    const nodes = [];
    let literal = '';
    const flush = () => {
      if (literal) nodes.push(literal);
      literal = '';
    };
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === "'") {
        literal += this.parseQuote(inPlural);
      } else if (ch === '{') {
        flush();
        nodes.push(this.parsePlaceholder(inPlural));
      } else if (ch === '}') {
        break;
      } else if (ch === '#' && inPlural) {
        flush();
        nodes.push({ type: 'pound' });
        this.pos++;
      } else {
        literal += ch;
        this.pos++;
      }
    }
    flush();
    return nodes;
  }

  /**
   * Consume an apostrophe and whatever it quotes, returning the literal text.
   * @param {boolean} inPlural
   * @returns {string} The literal text.
   */
  parseQuote(inPlural) {
    const next = this.text[this.pos + 1];
    if (next === "'") {
      this.pos += 2;
      return "'";
    }
    if (next === '{' || next === '}' || (inPlural && next === '#')) {
      this.pos++; // opening quote
      let quoted = '';
      while (this.pos < this.text.length) {
        const ch = this.text[this.pos++];
        if (ch !== "'") {
          quoted += ch;
        } else if (this.text[this.pos] === "'") {
          quoted += "'";
          this.pos++;
        } else {
          return quoted;
        }
      }
      throw new Error('unterminated quote');
    }
    this.pos++;
    return "'";
  }

  /**
   * Parse `{name}`, `{name, plural, …}` or `{name, select, …}` starting at `{`.
   * @param {boolean} inPlural - Whether a surrounding plural supplies `#` in select branches.
   * @returns {MessageNode} The node.
   */
  parsePlaceholder(inPlural) {
    this.pos++; // {
    const name = this.parseWord();
    if (!name) throw new Error('empty placeholder');
    this.skipSpace();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return { type: 'arg', name };
    }
    this.expect(',');
    this.skipSpace();
    const kind = this.parseWord();
    if (kind !== 'plural' && kind !== 'select') throw new Error(`unsupported type ${kind}`);
    this.skipSpace();
    this.expect(',');
    // No prototype, so a selector named `__proto__` is just another branch.
    /** @type {Record<string, MessageNode[]>} */
    const options = Object.create(null);
    for (;;) {
      this.skipSpace();
      if (this.text[this.pos] === '}') {
        this.pos++;
        break;
      }
      const key = this.parseSelector();
      if (!key) throw new Error('missing selector');
      this.skipSpace();
      this.expect('{');
      options[key] = this.parseNodes(inPlural || kind === 'plural');
      this.expect('}');
    }
    if (!options.other) throw Object.assign(new Error(`${kind} without other`), { missingOther: { kind, name } });
    return { type: kind, name, options };
  }

  /** @returns {string} An identifier (letters, digits, `_`). */
  parseWord() {
    const m = /^[A-Za-z0-9_]+/.exec(this.text.slice(this.pos));
    if (!m) return '';
    this.pos += m[0].length;
    return m[0];
  }

  /** @returns {string} A plural/select key: a word or `=N`. */
  parseSelector() {
    const m = /^(=\d+|[A-Za-z0-9_-]+)/.exec(this.text.slice(this.pos));
    if (!m) return '';
    this.pos += m[0].length;
    return m[0];
  }

  skipSpace() {
    while (/\s/.test(this.text[this.pos] || '')) this.pos++;
  }

  /** @param {string} ch */
  expect(ch) {
    if (this.text[this.pos] !== ch) throw new Error(`expected ${ch}`);
    this.pos++;
  }
}

// ---------------------------------------------------------------------------
// Pseudo-locale
// ---------------------------------------------------------------------------

/** Accented stand-ins for ASCII letters, chosen to stay readable. */
const PSEUDO_LETTERS = /** @type {Record<string, string>} */ (Object.fromEntries(
  [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ']
    .map((c, i) => [c, [...'åƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ'][i]])
));

/** Padding character, added to show where longer translations will clip. */
const PSEUDO_PAD = '·';

/** How much longer a pseudo-localised message is than its English. */
const PSEUDO_EXPANSION = 0.35;

/**
 * Pseudo-localise a message: every letter accented, the whole wrapped in
 * `[…]` and padded by about a third. Placeholders, plural/select syntax and
 * quoting survive, so the result is itself a valid message.
 * @param {string} message - English source.
 * @returns {string} The pseudo message; the input unchanged if it does not parse.
 */
export function pseudoLocalize(message) {
  const nodes = parse(message);
  if (!nodes) return message;
  const letters = countLetters(nodes);
  const pad = PSEUDO_PAD.repeat(Math.max(1, Math.round(letters * PSEUDO_EXPANSION)));
  return `[${serialize(nodes, false, true)} ${pad}]`;
}

/**
 * Whether a string looks pseudo-localised: bracketed, padded, no plain ASCII
 * letters outside placeholders. For tests that check a screen has no raw English.
 * @param {string} text
 * @returns {boolean} True for pseudo-localised text.
 */
export function isPseudoLocalized(text) {
  const s = String(text ?? '').trim();
  if (!s.startsWith('[') || !s.endsWith(']') || !s.includes(PSEUDO_PAD)) return false;
  return !/[A-Za-z]/.test(s.replace(/\{[A-Za-z0-9_]+\}/g, ''));
}

/**
 * @param {MessageNode[]} nodes
 * @returns {number} Letters in the message's literal text (all branches).
 */
function countLetters(nodes) {
  let n = 0;
  for (const node of nodes) {
    if (typeof node === 'string') n += (node.match(/\p{L}/gu) || []).length;
    else if ('options' in node) {
      // The longest branch is the one that has to fit.
      n += Math.max(0, ...Object.values(node.options).map(countLetters));
    }
  }
  return n;
}

/**
 * Write nodes back out as message text, optionally accenting the literals.
 * @param {MessageNode[]} nodes
 * @param {boolean} inPlural
 * @param {boolean} accent
 * @returns {string} Message text that parses back to the same structure.
 */
function serialize(nodes, inPlural, accent) {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') {
      const text = accent ? [...node].map((c) => PSEUDO_LETTERS[c] || c).join('') : node;
      // Quote from the first syntax character through the end in one section.
      // Adjacent quoted sections look like an escaped apostrophe to the parser.
      const syntax = text.search(inPlural ? /[{}#]/ : /[{}]/);
      const escaped = text.replace(/'/g, "''");
      out += syntax < 0 ? escaped
        : text.slice(0, syntax).replace(/'/g, "''") + "'" + text.slice(syntax).replace(/'/g, "''") + "'";
    } else if (node.type === 'arg') {
      out += `{${node.name}}`;
    } else if (node.type === 'pound') {
      out += '#';
    } else {
      const branches = Object.entries(node.options)
        .map(([key, branch]) => `${key} {${serialize(branch, inPlural || node.type === 'plural', accent)}}`)
        .join(' ');
      out += `{${node.name}, ${node.type}, ${branches}}`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * One cached `Intl` object per kind, locale and options.
 * @template T
 * @param {string} kind
 * @param {string|undefined} locale
 * @param {object|undefined} options
 * @param {() => T} make
 * @returns {T} The formatter.
 */
function cachedFormatter(kind, locale, options, make) {
  const key = `${kind}|${locale ?? ''}|${options ? JSON.stringify(options) : ''}`;
  // Every entry under a key was made by the `make` of that same kind, locale and options.
  let f = /** @type {T|undefined} */ (formatterCache.get(key));
  if (!f) {
    f = make();
    formatterCache.set(key, f);
  }
  return f;
}

/**
 * Format a number for the active locale (`Intl.NumberFormat`).
 * @param {number|bigint} value
 * @param {Intl.NumberFormatOptions} [options]
 * @returns {string} The formatted number.
 */
export function formatNumber(value, options) {
  const locale = formattingLocale();
  return cachedFormatter('number', locale, options, () => new Intl.NumberFormat(locale, options)).format(value);
}

/**
 * Format a date and/or time for the active locale (`Intl.DateTimeFormat`).
 * An invalid date (a missing or garbled timestamp) formats as '' rather than
 * throwing the RangeError `Intl` raises for it.
 * @param {Date|number} value
 * @param {Intl.DateTimeFormatOptions} [options]
 * @returns {string} The formatted date.
 */
export function formatDate(value, options) {
  if (value !== undefined && !Number.isFinite(Number(value))) return '';
  const locale = formattingLocale();
  return pseudoAccented(cachedFormatter('date', locale, options, () => new Intl.DateTimeFormat(locale, options)).format(value));
}

/**
 * Words `Intl` supplied — a month name, a day period, "in 2 hours", a list's
 * "or" — accented under the pseudo-locale like a translated message's, so a
 * screen of translated text has no English left in it; as they are otherwise.
 * @param {string} text - Formatter output
 * @returns {string} The text, accented under the pseudo-locale
 */
function pseudoAccented(text) {
  if (uiLocale !== PSEUDO_LOCALE) return text;
  return [...text].map((c) => PSEUDO_LETTERS[c] || c).join('');
}

/**
 * Format a relative time ("3 days ago", "in 2 hours") for the active locale
 * (`Intl.RelativeTimeFormat`).
 * @param {number} value - Negative for the past.
 * @param {Intl.RelativeTimeFormatUnit} unit
 * @param {Intl.RelativeTimeFormatOptions} [options]
 * @returns {string} The formatted phrase.
 */
export function formatRelativeTime(value, unit, options) {
  const locale = formattingLocale();
  return pseudoAccented(cachedFormatter('relative', locale, options, () => new Intl.RelativeTimeFormat(locale, options)).format(value, unit));
}

/**
 * Join items into a list for the active locale (`Intl.ListFormat`). The
 * default `unit` type is a plain list — `a, b, c` in English — for names
 * shown side by side; `conjunction` reads "a, b, and c" and `disjunction`
 * "a, b, or c". The items are inserted as given, so an item that is markup
 * stays markup. Where the runtime has no `Intl.ListFormat` the items are
 * joined with `, `. Under the pseudo-locale the separators' letters are
 * accented like a translated message's, so "or" and "and" read as translated.
 * @param {Iterable<string>} items
 * @param {{type?: 'unit'|'conjunction'|'disjunction'}} [options]
 * @returns {string} The list.
 */
export function formatList(items, options = {}) {
  const list = [...items].map(String);
  const type = options.type || 'unit';
  /** @type {{ListFormat?: new (locale: string|undefined, options: object) => {format: (list: string[]) => string, formatToParts: (list: string[]) => Array<{type: string, value: string}>}}} */
  const intl = Intl;
  const ListFormat = intl.ListFormat;
  if (typeof ListFormat !== 'function') return list.join(', ');
  const locale = formattingLocale();
  const opts = { type, style: type === 'unit' ? 'short' : 'long' };
  const formatter = cachedFormatter('list', locale, opts, () => new ListFormat(locale, opts));
  if (uiLocale !== PSEUDO_LOCALE) return formatter.format(list);
  return formatter.formatToParts(list)
    .map((/** @type {{type: string, value: string}} */ part) => (part.type === 'literal'
      ? pseudoAccented(part.value)
      : part.value))
    .join('');
}

// ---------------------------------------------------------------------------
// Page bootstrap
// ---------------------------------------------------------------------------

/**
 * Adopt the locale and catalogue the server wrote into the page, if any.
 * Runs once, when this module is first evaluated in a document.
 * @returns {void}
 */
function adoptPageLocale() {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const locale = document.documentElement.getAttribute('data-ui-locale') || '';
  if (!locale) return;
  setLocale(locale);
  const el = document.getElementById('juggler-ui-catalog');
  if (!el?.textContent) return;
  try {
    registerCatalog(CORE_NAMESPACE, locale, JSON.parse(el.textContent));
  } catch (err) {
    // An unreadable catalogue costs the translations, not the page: every
    // message falls back to English.
    console.error('[i18n] the page catalogue did not parse:', err);
  }
}

adoptPageLocale();
