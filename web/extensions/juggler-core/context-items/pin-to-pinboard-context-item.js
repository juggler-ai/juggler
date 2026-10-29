//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { pinToPinboard, loadPinAgentDescriptors } from 'juggler/pinboard';
import { createShowPinControl, injectStylesOnce, showPin } from 'juggler/ui';
import { translator, markUntranslated } from 'juggler/i18n';
import { toolActionResultData } from '../lib/tool-action-result.js';

const t = translator('@juggler/core');

// The card's label is a link to the pin: it reads as the summary text it
// replaces until the pointer is over it.
injectStylesOnce('pin-to-pinboard-styles', `
.pinned-summary-link {
  all: unset;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.pinned-summary-link:hover {
  text-decoration: underline;
}
`);

/**
 * The installed pinboard item types that describe themselves to the agent, by id.
 * Refreshed by prepareToolDefinitions() before each tool list is built, because
 * the set changes when the user installs, enables or disables an extension.
 * @type {Map<string, import('juggler/pinboard-item-type').PinAgentDescriptor>}
 */
let catalog = new Map();

/**
 * Stable JSON for a parameter object: same keys in the same order whatever order
 * the model wrote them in, so a repeat of the same request hashes to the same pin.
 * @param {Record<string, unknown>} parameters - The parameters to spell.
 * @returns {string} A stable spelling.
 */
function stableStringify(parameters) {
  return JSON.stringify(parameters, Object.keys(parameters).sort());
}

/**
 * Fold one type's parameters to the spelling that will be persisted, or null to
 * reject them. A type with a descriptor normalizes its own; anything else gets
 * only the check this tool can make without knowing the type — that there is an
 * object there at all — and is judged properly by its `normalizeConfig` when the
 * pin mounts.
 * @param {import('juggler/pinboard-item-type').PinAgentDescriptor|null} descriptor - The type's descriptor, if it has one.
 * @param {unknown} parameters - Raw parameters from the model.
 * @returns {Record<string, unknown>|null} Normalized parameters, or null.
 */
function normalizeParameters(descriptor, parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return null;
  // JSON from the model: a non-array object is a record of named values.
  const record = /** @type {Record<string, unknown>} */ (parameters);
  return descriptor?.normalize ? descriptor.normalize(record) : record;
}

/**
 * What makes two requests the same pin.
 * @param {import('juggler/pinboard-item-type').PinAgentDescriptor|null} descriptor - The type's descriptor, if it has one.
 * @param {Record<string, unknown>} parameters - Normalized parameters.
 * @returns {string} The type-owned identity.
 */
function identityOf(descriptor, parameters) {
  return descriptor?.identity ? descriptor.identity(parameters) : stableStringify(parameters);
}

/**
 * What to call this pin in the UI and in the summary the model reads back. A type
 * that knows what identifies one of its pins says so; the rest are known by type.
 * @param {string} type - The pin type.
 * @param {Record<string, unknown>} [parameters] - Normalized parameters.
 * @returns {string} A short label.
 */
function pinLabel(type, parameters) {
  const descriptor = catalog.get(type);
  return (parameters && descriptor?.identity?.(parameters)) || type;
}

/**
 * Spell one type's parameter schema as a phrase, rather than making the model
 * read JSON schema inside a description.
 * @param {any} schema - The descriptor's `parameters` schema.
 * @returns {string} A phrase describing the parameters.
 */
function describeParameters(schema) {
  const properties = schema?.properties || {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const names = Object.keys(properties);
  if (!names.length) return 'No parameters.';
  const parts = names.map((name) => {
    const property = properties[name] || {};
    const kind = [property.type, required.has(name) ? 'required' : null].filter(Boolean).join(', ');
    return `\`${name}\`${kind ? ` (${kind})` : ''}${property.description ? ` — ${property.description}` : ''}`;
  });
  return `Parameters: ${parts.join(' ')}`;
}

/**
 * The config a pin is stored with: the type's own parameters, marked as having
 * come from the agent rather than from a user gesture.
 * @param {Record<string, unknown>} parameters - Normalized parameters.
 * @returns {Record<string, unknown>} The pin's config.
 */
function pinConfig(parameters) {
  return { ...parameters, agentRequested: true };
}

/**
 * The pin a completed call made, from its recorded result, or null when the
 * result does not name one.
 * @param {unknown} result - The call's result (`{pin, type, parameters}`).
 * @returns {import('../../../js/utils/properties-panel-helpers.js').PinRef|null} The pin, or null.
 */
function pinRefOf(result) {
  if (!result || typeof result !== 'object') return null;
  const { pin, type, parameters } = /** @type {{pin?: unknown, type?: unknown, parameters?: unknown}} */ (result);
  if (typeof pin !== 'string' || typeof type !== 'string') return null;
  const config = parameters && typeof parameters === 'object' ? /** @type {Record<string, unknown>} */ (parameters) : {};
  return { pin, type, config: pinConfig(config) };
}

/**
 * Mint the stable id for an agent-requested pin. A repeated call with the same
 * normalized request is the same id, so the server's idempotent add cannot stack
 * copies if a response was lost or the model asks twice.
 * @param {string} type - Public request type.
 * @param {string} identity - Type-owned stable identity.
 * @returns {Promise<string>} A pinboard-safe id.
 */
async function pinIdFor(type, identity) {
  const bytes = new TextEncoder().encode(`${type}\n${identity}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `agent_${hex}`;
}

/** The `pin_to_pinboard` tool: a one-way request to show something to the user. */
class PinToPinboardContextItem extends ContextItem {
  static MANIFEST = {
    id: 'pin-to-pinboard',
    name: 'Pin to Pinboard',
    version: '1.0.0',
    description: 'Show something on the user’s pinboard',
    author: 'Juggler',
    requiresApproval: false,
  };

  static getBadgeOptions() {
    return { color: 'meta', icon: 'icon-document' };
  }

  static getTypeName() {
    return t('Pin to Pinboard');
  }

  /**
   * Re-running would ask for the pin the call already made — same id, same
   * config — so there is nothing new to see. What the user wants from a past
   * call is the pin itself, which the panel's Show on Pinboard control opens.
   * @returns {boolean} False — re-running this item type is a no-op.
   */
  static isRerunnable() {
    return false;
  }

  /**
   * Read the installed pin types before the tool list is built. The tool's whole
   * job is to name them, and a type the model is never told about is one it never
   * picks — which is how a `.cmajorpatch` ends up pinned as raw text.
   * @returns {Promise<void>} Resolves once the catalog is current.
   */
  static async prepareToolDefinitions() {
    try {
      catalog = new Map((await loadPinAgentDescriptors()).map((d) => [d.id, d]));
    } catch (err) {
      // Keep whatever we had. An empty catalog would silently take every type
      // away from the model, which is worse than describing a stale one.
      console.error('[PinToPinboard] Couldn’t read the pinboard item types:', err);
    }
  }

  /**
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definition.
   */
  static getToolDefinitions() {
    const listed = [...catalog.values()]
      .map((d) => `- \`${d.id}\` — ${d.description} ${describeParameters(d.parameters)}`)
      .join('\n');
    const description = [
      'Attach something to the user’s Pinboard and bring it into view. This is a one-way display action: you cannot list or read the user’s existing pins, and repeating a request reveals the existing pin instead of adding another.',
      'Choose the type that is *for* the thing you are showing, not the one that will accept it — several types accept a path, and the specific one knows how to run, render or summarize what is at the end of it.',
      'It is also how to show the user something you have made rather than describe it: write it to a file in the project and pin that file. An HTML file is shown as the rendered page, scripts running, with its source a click away — so a report, chart or mock-up can be looked at, not just read.',
      listed ? `Installed types:\n${listed}` : '',
      'A type installed after this list was built is accepted too: use its id and give it whatever parameters it expects, and it will validate its own config.',
    ].filter(Boolean).map(markUntranslated).join('\n\n');

    return [{
      name: 'pin_to_pinboard',
      category: 'write',
      description,
      input_schema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: markUntranslated('Which kind of Pinboard item to add — the id of one of the installed types listed above.'),
          },
          parameters: {
            type: 'object',
            description: markUntranslated('Parameters for the requested type, as listed above. Pass an empty object for a type that takes none.'),
          },
        },
        required: ['type', 'parameters'],
      },
    }];
  }

  /**
   * Validate and normalize one type-specific request.
   * @param {Record<string, unknown>} toolInput - Raw model parameters.
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result.
   */
  async validate(toolInput) {
    const type = typeof toolInput?.type === 'string' ? toolInput.type.trim() : '';
    if (!type) {
      return { valid: false, error: markUntranslated('Which pin type? Name one of the installed types.') };
    }
    const parameters = normalizeParameters(catalog.get(type) || null, toolInput.parameters);
    if (!parameters) {
      return { valid: false, error: markUntranslated(`${type} parameters are invalid`) };
    }
    return { valid: true, params: { type, parameters } };
  }

  /**
   * Add the pin to the shared main board and ask eligible viewers to reveal it.
   * @param {{type: string, parameters: Record<string, unknown>}} params - Validated request.
   * @returns {Promise<Record<string, unknown>>} Added pin descriptor.
   */
  async execute(params) {
    const descriptor = catalog.get(params.type) || null;
    const parameters = normalizeParameters(descriptor, params.parameters);
    if (!parameters) throw new Error(markUntranslated(`${params.type} parameters are invalid`));

    const config = pinConfig(parameters);
    const pin = await pinIdFor(params.type, identityOf(descriptor, parameters));
    const from = this.conversation?.id || '';
    if (!from) throw new Error(markUntranslated('No conversation available to attribute the Pinboard request'));
    const data = await pinToPinboard({
      id: pin,
      type: params.type,
      config,
      from,
      signal: this.signal,
    });
    const kept = Array.isArray(data?.pins)
      ? data.pins.find((candidate) => candidate?.id === pin)
      : null;
    if (!kept || kept.type !== params.type || JSON.stringify(kept.config) !== JSON.stringify(config)) {
      throw new Error(markUntranslated('The pinboard did not keep the requested pin'));
    }
    return { pin, type: params.type, parameters };
  }

  /**
   * @param {import('juggler/context-item').Outcome} outcome - Tool outcome.
   * @returns {import('juggler/context-item').ItemSummary} Model-facing summary.
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || markUntranslated('Could not pin that'));
    }
    const result = /** @type {{type?: string, parameters?: Record<string, unknown>}} */ (outcome.result) || {};
    const label = result.type ? pinLabel(result.type, result.parameters) : '';
    return this.successSummary(markUntranslated(`Pinned ${label || 'the item'} and asked the user’s Pinboard to show it.`));
  }

  /**
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Execution state.
   * @returns {import('juggler/context-item').ResultStatusMessage} Status row.
   */
  getStatusUI(actionStatus) {
    const typeName = t('pinned');
    if (!actionStatus || actionStatus.pending) {
      return { typeName, summary: actionStatus ? t('Pinning…') : t('Pin to Pinboard'), status: actionStatus ? 'running' : undefined };
    }
    if (actionStatus.success) {
      const result = /** @type {{type?: string, parameters?: Record<string, unknown>}} */ (actionStatus.result || {});
      const label = (result.type ? pinLabel(result.type, result.parameters) : '') || t('item');
      const ref = pinRefOf(result);
      if (!ref) return { typeName, summary: label, status: 'success' };
      const link = this.createPinLink(label, ref);
      if (!catalog.has(ref.type)) relabelOnceCatalogIsRead(link, ref.type, result.parameters);
      return { typeName, summary: link, status: 'success' };
    }
    // The prefix is ours; the error after it is the model's English, shown as it was.
    const terminal = this.resolveTerminalStatus(actionStatus, t('Could not pin that'));
    return { typeName, summary: terminal.summary, status: terminal.status };
  }

  /**
   * The card's label, as a link that opens the Pinboard on the pin. A button
   * rather than a span with a handler, so the conversation treats a click on it
   * as a control rather than as nothing more than selecting the card.
   * @param {string} label - What the pin is called.
   * @param {import('../../../js/utils/properties-panel-helpers.js').PinRef} ref - The pin to show.
   * @returns {HTMLElement} The link.
   */
  createPinLink(label, ref) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'pinned-summary-link';
    link.textContent = label;
    link.title = t('Show on Pinboard');
    link.addEventListener('click', () => { void showPin(ref); });
    return link;
  }

  /**
   * Properties panel for a `pin_to_pinboard` action. Show the pin type and one
   * labeled row per argument the type was given, rather than the raw tool-call
   * JSON. Owns its whole display, so the generic Result section is suppressed.
   * A pin that was made gets a control to open the Pinboard on it.
   * @override
   * @param {HTMLElement} wrapper - Section wrapper to append details into
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx - Render context
   * @returns {{skipResultSection: boolean, controls: HTMLElement[]}} Suppress the generic result dump; add Show on Pinboard
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers, toolAction } = ctx;
    const data = toolActionResultData(toolAction);

    const type = String(data.type || input.type || '').trim();
    helpers.addSubsection(wrapper, t('Type'), type || t('unknown'), 'properties-panel-code');

    // Prefer the normalized parameters the pin was actually created with.
    const parameters = (data.parameters && typeof data.parameters === 'object' ? data.parameters : input.parameters) || {};
    const entries = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
      ? Object.entries(parameters)
      : [];
    if (!entries.length) {
      helpers.addSubsection(wrapper, t('Parameters'), t('None.'), 'properties-panel-text');
    }
    for (const [name, value] of entries) {
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      if (value !== null && typeof value === 'object') {
        helpers.addSubsection(wrapper, label, JSON.stringify(value, null, 2), 'properties-panel-code', { language: 'json' });
      } else {
        helpers.addSubsection(wrapper, label, String(value), 'properties-panel-code');
      }
    }

    const show = createShowPinControl(pinRefOf(data));
    return { skipResultSection: true, controls: show ? [show] : [] };
  }
}

/**
 * The catalog read a card asked for, shared by every card that finds the catalog
 * unable to name its pin. Made once per realm: a type with no descriptor stays
 * unnamed after it, and asking again for each card would not change that.
 * @type {Promise<void>|null}
 */
let cardCatalogRead = null;

/**
 * Put a pin's own name on a card that was drawn before the catalog could supply
 * it. The catalog is otherwise read only when a tool list is built, which a page
 * that has just loaded has not done yet, so every card in the transcript would
 * read as its bare type until something redrew it. The card is a live element,
 * so it is corrected in place rather than waiting for a redraw nothing asks for.
 * @param {HTMLElement} link - The card's label.
 * @param {string} type - The pin type.
 * @param {Record<string, unknown>} [parameters] - Normalized parameters.
 * @returns {void}
 */
function relabelOnceCatalogIsRead(link, type, parameters) {
  cardCatalogRead ??= PinToPinboardContextItem.prepareToolDefinitions();
  void cardCatalogRead.then(() => {
    if (catalog.has(type)) link.textContent = pinLabel(type, parameters);
  });
}

export default PinToPinboardContextItem;
