//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Single source of truth for a conversation item's badge identity — the
 * circular icon (colour + glyph) and the type-name lozenge label.
 *
 * EVERY site that paints the `.message-icon-badge` resolves it here, so the
 * conversation-list tile and the properties-panel header can never drift:
 *  - conversation tiles (tool-action-message / context-item-message /
 *    thread-message / thinking-message) via `iconOptionsForItem`
 *  - the properties-panel header (services/renderers/item-renderers) via
 *    `badgeForItem` (icon options + lozenge label together)
 *
 * The icon glyph/colour comes from each plugin's static `getBadgeOptions()`;
 * the lozenge label comes from the plugin's own `getStatusUI().typeName`
 * (e.g. "Read", "Grep") with a fallback to its static type label — the exact
 * text the tile shows — never the raw tool name.
 * @module item-badge
 */

import { TYPE_ICONS, TYPE_COLORS } from './icon-message-renderer.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import { yGet } from '../model/item-accessor.js';
import { t, markForTranslation } from '../../sdk/lib/i18n.js';
import { capabilityLabel } from './capability-label.js';

/**
 * The lozenge label every notice wears, in the row and the panel header alike.
 * A notice's own text is a sentence explaining what happened, not a title, so
 * the lozenge names the kind of item and nothing else. English; translated
 * where it is drawn.
 * @type {string}
 */
export const NOTICE_TYPE_NAME = markForTranslation('Warning');

/**
 * One field of a Yjs message item, read through its `get`.
 * @param {unknown} item - A Y.Map, or anything else.
 * @param {string} key - Field name.
 * @returns {unknown} The field value, or undefined for anything with no `get`.
 */
function field(item, key) {
  if (!item || typeof item !== 'object' || !('get' in item) || typeof item.get !== 'function') return undefined;
  return /** @type {unknown} */ (item.get(key));
}

/**
 * A stored value as a plain record, or null when it is not an object.
 * @param {unknown} value - A plain value (already materialised from any Y type).
 * @returns {Record<string, unknown>|null} The record, or null.
 */
function asRecord(value) {
  return value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : null;
}

const USER_AVATAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14" fill="currentColor"><path d="M480-480q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 66-47 113t-113 47ZM160-160v-112q0-34 17.5-62.5T224-378q62-31 126-46.5T480-440q66 0 130 15.5T736-378q29 15 46.5 43.5T800-272v112H160Z"/></svg>';

/**
 * @typedef {import('juggler/context-item').default} ContextItem
 * @typedef {typeof import('juggler/context-item').default} ContextItemClass
 * @typedef {import('../services/action-executor.js').ActionStatus} ActionStatus
 */

/**
 * The arguments a tile hands a plugin's getStatusUI().
 * @typedef {[(ActionStatus|null)?, Record<string, unknown>?, {conversation?: unknown, session?: unknown, toolUseId?: string}?]} StatusArgs
 */

/**
 * @typedef {object} BadgeContext
 * @property {import('../model/conversation.js').default|null} [conversation] - Current Conversation (for plugin instance construction)
 * @property {import('../model/message-thread.js').MessageThread|null} [messageThread] - Current MessageThread (resolves context-item instances by id)
 * @property {string} [fallbackType] - Item type to assume when the item itself can't report one
 *   (used by attribute-driven tiles like thinking-message that hold no Yjs item)
 */

/**
 * @typedef {object} IconOptions
 * @property {string} color - Colour preset name
 * @property {string} [iconClass] - CSS mask-class icon
 * @property {string} [iconSvg] - Inline SVG icon (fallback when no mask class)
 */

/**
 * The registry id of a plugin CLASS — the id the extensions catalog lists its
 * capability under.
 * @param {ContextItemClass|null|undefined} PluginClass - Plugin class, or null/undefined
 * @returns {string|null} The capability id, or null
 */
function classPluginId(PluginClass) {
  return PluginClass?.MANIFEST?.id || null;
}

/**
 * The registry id behind a context-item plugin instance. `type` is seeded from
 * the class's MANIFEST id, so it stands in when the manifest isn't reachable.
 * @param {ContextItem} instance - Context-item plugin instance
 * @returns {string|null} The capability id, or null
 */
function instancePluginId(instance) {
  return instance.getManifest?.()?.id || instance.type || null;
}

/**
 * Icon options for a context-item plugin instance, from its static badge.
 * @param {ContextItem} instance - Context-item plugin instance
 * @returns {IconOptions} Icon options
 */
function contextItemIconOptions(instance) {
  const badge = instance.getBadgeOptions?.() ?? { color: 'slate' };
  const iconSvg = 'iconSvg' in badge && typeof badge.iconSvg === 'string' ? badge.iconSvg : undefined;
  return {
    color: badge.color,
    iconClass: badge.icon || undefined,
    iconSvg: iconSvg || (badge.icon ? undefined : TYPE_ICONS.context),
  };
}

/**
 * Icon options from a plugin CLASS's static getBadgeOptions() — the mask-class
 * icon + colour every plugin-backed item (tool-action, thread) shares. Falls
 * back to an inline SVG only when the plugin declares no mask-class icon.
 * @param {ContextItemClass|null|undefined} PluginClass - Plugin class, or null/undefined
 * @param {string} [fallbackSvg] - Inline SVG used when the plugin has no icon class
 * @returns {IconOptions} Icon options
 */
function classIconOptions(PluginClass, fallbackSvg) {
  const badge = PluginClass?.getBadgeOptions?.() ?? { color: 'slate' };
  return badge.icon
    ? { color: badge.color, iconClass: badge.icon }
    : { color: badge.color, iconSvg: fallbackSvg };
}

/**
 * Whether a value is a context-item plugin instance (vs a Yjs message item).
 * @param {unknown} item - Candidate
 * @returns {item is ContextItem} True if it looks like a context-item instance
 */
function isContextItemInstance(item) {
  return !!item && typeof item === 'object' && 'getTitle' in item && typeof item.getTitle === 'function';
}

/**
 * Resolve the context-item ActionClass a Yjs item's tool name maps to, or null
 * when the item carries no tool name or none is registered. Thread items carry
 * the invocation name in `runToolName`; tool actions and older thread documents
 * use `toolName`.
 * @param {unknown} item - Yjs message item (tool-action or delegated thread).
 * @returns {ContextItemClass|null} The class, or null.
 */
function actionClassFor(item) {
  const toolName = field(item, 'runToolName') || field(item, 'toolName');
  return typeof toolName === 'string' && toolName ? (contextItemRegistry.getByToolName(toolName) ?? null) : null;
}

/**
 * Resolve the circular icon's colour + glyph for a conversation item. Shared by
 * the tiles and the panel so the icon is identical in both.
 * @param {unknown} item - Yjs message item (has `.get('type')`) or a context-item instance
 * @param {BadgeContext} [ctx] - Resolution context
 * @returns {IconOptions} Icon options ready for createIconBox/createIconBadge
 */
export function iconOptionsForItem(item, ctx = {}) {
  if (isContextItemInstance(item)) return contextItemIconOptions(item);

  const type = field(item, 'type') ?? ctx.fallbackType;
  switch (type) {
    case 'error': return { color: /** @type {string} */ (TYPE_COLORS.error), iconSvg: TYPE_ICONS.error };
    // Same warning triangle as an error, in amber: something happened worth
    // reading, but nothing failed. Mirrors notice-message's own render.
    case 'notice': return { color: 'amber', iconSvg: TYPE_ICONS.error };
    case 'user': return { color: 'green', iconSvg: USER_AVATAR_SVG };
    case 'thinking': return { color: /** @type {string} */ (TYPE_COLORS.thinking), iconSvg: TYPE_ICONS.thinking };
    case 'assistant': return { color: 'slate', iconSvg: TYPE_ICONS.assistant };
    case 'thread': {
      // A delegated thread carries its delegating tool's name in the run
      // selector. Badge it as that tool — the same lookup the tool-action case
      // uses — so e.g. an Explore subthread shows the Explore icon rather than
      // the generic thread glyph. Undelegated threads keep the plain thread
      // badge.
      const ActionClass = actionClassFor(item);
      if (ActionClass) return classIconOptions(ActionClass, TYPE_ICONS.action);
      return classIconOptions(contextItemRegistry.get('thread'), TYPE_ICONS.context);
    }
    case 'tool-action': {
      return classIconOptions(actionClassFor(item), TYPE_ICONS.action);
    }
    case 'context-item': {
      const inst = ctx.messageThread?.getContextItem?.(String(field(item, 'itemId') ?? ''));
      return inst ? contextItemIconOptions(inst) : { color: 'blue', iconSvg: TYPE_ICONS.context };
    }
    default:
      return { color: 'slate', iconSvg: TYPE_ICONS.assistant };
  }
}

/**
 * Construct a throwaway plugin instance for a getStatusUI() call, mirroring the
 * args the tile passes so the label resolves identically.
 * @param {ContextItemClass} PluginClass - Plugin class
 * @param {BadgeContext} ctx - Resolution context
 * @returns {ContextItem|null} Instance, or null if construction throws
 */
function makeInstance(PluginClass, ctx) {
  try {
    // A badge may be asked for outside any conversation; a plugin that needs
    // one throws, and the badge falls back to the class's static labels.
    return new PluginClass(/** @type {import('../../sdk/context-item-types.js').ItemContext} */ ({
      id: 'item-badge',
      session: ctx.conversation?.session,
      conversation: ctx.conversation,
      messageThread: ctx.messageThread,
    }));
  } catch {
    return null;
  }
}

/**
 * The type-name lozenge label, pulled from the plugin's own getStatusUI so it
 * reads exactly like the tile (e.g. "Read", not "readFile"/"Read File").
 * getStatusUI is a pure viewer-side config builder; the call is guarded because
 * a plugin may read result fields we can't reconstruct, falling back to its
 * static type label then the supplied fallback. getStatusUI's typeName is
 * already in the user's language; the static label and manifest name are the
 * capability's English, translated here.
 * @param {ContextItem|null} instance - Plugin instance, or null
 * @param {ContextItemClass|null|undefined} PluginClass - Plugin class, or null
 * @param {StatusArgs} statusArgs - Arguments forwarded to getStatusUI
 * @param {string} fallback - Last-resort label, already in the user's language
 * @param {string|null} [pluginId] - Registry id whose extension owns the static labels
 * @returns {string} The lozenge label
 */
function pluginTypeName(instance, PluginClass, statusArgs, fallback, pluginId = classPluginId(PluginClass)) {
  try {
    const cfg = instance?.getStatusUI?.(...statusArgs);
    if (cfg?.typeName) return cfg.typeName;
  } catch { /* plugin needs richer status than we have; use the static label */ }
  const label = PluginClass?.getTypeName?.() || PluginClass?.MANIFEST?.name;
  return label ? capabilityLabel(label, pluginId) : fallback;
}

/**
 * The class a context-item instance was built from.
 * @param {ContextItem} instance - Context-item plugin instance
 * @returns {ContextItemClass} Its class
 */
function classOf(instance) {
  return /** @type {ContextItemClass} */ (instance.constructor);
}

/**
 * The lozenge fallback for a context-item instance: its manifest name, else its
 * type id, else the generic label.
 * @param {ContextItem} inst - Context-item plugin instance
 * @returns {string} The fallback label
 */
function contextItemFallback(inst) {
  const name = inst.getManifest?.()?.name;
  if (name) return capabilityLabel(name, instancePluginId(inst));
  return inst.type || t('Context Item');
}

/**
 * Reconstruct the (actionStatus, input, context) args a tool-action tile passes
 * to getStatusUI: the completed result when present, else the pending/running
 * shape for an in-flight tool.
 * @param {unknown} item - Tool-action Yjs item
 * @param {BadgeContext} ctx - Resolution context
 * @returns {StatusArgs} Args array for getStatusUI
 */
function toolActionStatusArgs(item, ctx) {
  const storedName = field(item, 'toolName');
  const toolName = (typeof storedName === 'string' ? storedName : '').toLowerCase();
  /** @type {unknown} */
  const storedInput = yGet(item, 'toolInput');
  const input = asRecord(storedInput) ?? {};
  /** @type {unknown} */
  const storedResult = yGet(item, 'result');
  const resultPlain = asRecord(storedResult);
  /** @type {unknown} */
  const displayData = yGet(item, 'displayData');
  // The stored result, or the in-flight shape, as the live tile hands it over.
  /** @type {Record<string, unknown>} */
  const status = resultPlain
    ? { content: '', ...resultPlain }
    : { pending: true, actionId: toolName, displayData, state: field(item, 'state') };
  const actionStatus = /** @type {ActionStatus} */ (status);
  const toolUseId = field(item, 'toolUseId');
  const context = {
    conversation: ctx.conversation,
    messageThread: ctx.messageThread,
    session: ctx.conversation?.session,
    toolUseId: typeof toolUseId === 'string' ? toolUseId : undefined,
  };
  return [actionStatus, input, context];
}

/**
 * Resolve the type-name lozenge label for a conversation item.
 * @param {unknown} item - Yjs message item or a context-item instance
 * @param {BadgeContext} [ctx] - Resolution context
 * @returns {string} The lozenge label
 */
export function typeNameForItem(item, ctx = {}) {
  if (isContextItemInstance(item)) {
    return pluginTypeName(item, classOf(item), [], contextItemFallback(item));
  }

  const type = field(item, 'type') ?? ctx.fallbackType;
  switch (type) {
    case 'error': return t('Error');
    // A notice is labelled by kind, not by incident: its summary is the
    // explanation the row prints beside this lozenge, and the panel prints the
    // same pair.
    case 'notice': return t(NOTICE_TYPE_NAME);
    case 'user': return t('User Message');
    case 'thinking': return t('Thinking');
    case 'assistant': return t('Assistant Message');
    case 'thread': {
      // A compaction fold is a thread by construction, but it is not work the
      // user asked for: it stands where the folded history began and is the way
      // in to the folded items, so it says what it is rather than wearing the
      // generic lozenge of an ordinary sub-thread.
      if (field(item, 'boundedCompaction')) return t('Compacted');
      // Delegated threads label as their delegating tool (e.g. "Web Fetch")
      // rather than the generic "Thread"; mirrors the tool-action label path but
      // uses the static type label (no per-call tool result to feed getStatusUI).
      // The tool name itself is an identifier, shown as it is.
      const toolName = String(field(item, 'runToolName') || field(item, 'toolName') || '');
      const ActionClass = actionClassFor(item);
      if (ActionClass) return pluginTypeName(null, ActionClass, [], toolName);
      return pluginTypeName(null, contextItemRegistry.get('thread'), [], t('Thread'));
    }
    case 'tool-action': {
      const toolName = field(item, 'toolName');
      const ActionClass = actionClassFor(item);
      const instance = ActionClass ? makeInstance(ActionClass, ctx) : null;
      return pluginTypeName(instance, ActionClass, toolActionStatusArgs(item, ctx),
        (typeof toolName === 'string' && toolName) || t('Tool Action'));
    }
    case 'context-item': {
      const inst = ctx.messageThread?.getContextItem?.(String(field(item, 'itemId') ?? ''));
      if (inst) return pluginTypeName(inst, classOf(inst), [], contextItemFallback(inst));
      return String(type) || t('Context Item');
    }
    default:
      return t('Message');
  }
}

/**
 * Resolve the registry id of the context-item plugin an item comes from — the
 * id its capability is listed under in the extensions catalog. Null for items
 * no plugin owns (plain user/assistant messages, thinking, errors), which is
 * what the properties panel keys its "open this in Extensions" link off.
 * @param {unknown} item - Yjs message item or a context-item instance
 * @param {BadgeContext} [ctx] - Resolution context
 * @returns {string|null} The capability id, or null when no plugin owns the item
 */
function pluginIdForItem(item, ctx = {}) {
  if (isContextItemInstance(item)) return instancePluginId(item);

  const type = field(item, 'type') ?? ctx.fallbackType;
  switch (type) {
    case 'thread': {
      // Same resolution order as the icon: a delegated thread belongs to its
      // delegating tool's plugin, an undelegated one to the thread plugin.
      return classPluginId(actionClassFor(item)) || classPluginId(contextItemRegistry.get('thread'));
    }
    case 'tool-action':
      return classPluginId(actionClassFor(item));
    case 'context-item': {
      const inst = ctx.messageThread?.getContextItem?.(String(field(item, 'itemId') ?? ''));
      return inst ? instancePluginId(inst) : null;
    }
    default:
      return null;
  }
}

/**
 * Resolve the full badge — icon options plus the lozenge label — for a
 * conversation item. The panel header builds its `.message-icon-badge` from
 * this; tiles that only need the icon use `iconOptionsForItem` directly.
 * `pluginId` rides along so the panel can link the badge to the owning
 * capability; tiles simply ignore it.
 * @param {unknown} item - Yjs message item or a context-item instance
 * @param {BadgeContext} [ctx] - Resolution context
 * @returns {IconOptions & {typeName: string, pluginId: string|null}} Icon options, lozenge label, owning capability id
 */
export function badgeForItem(item, ctx = {}) {
  return {
    ...iconOptionsForItem(item, ctx),
    typeName: typeNameForItem(item, ctx),
    pluginId: pluginIdForItem(item, ctx),
  };
}
