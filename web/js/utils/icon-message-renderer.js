//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shared icon rendering utilities for conversation items.
 * Used by message components (assistant-message, thinking-message, etc.) and tool-action-message.
 * @module icon-message-renderer
 */

/**
 * SVG icons for each message type
 * @type {Record<string, string>}
 */
export const TYPE_ICONS = {
  context: '<svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14" fill="white"><path d="M479.92-689.74q-27.18 0-46.11-19.02-18.94-19.01-18.94-46.19 0-27.18 19.02-46.11Q452.9-820 480.08-820q27.18 0 46.11 19.02 18.94 19.01 18.94 46.19 0 27.18-19.02 46.11-19.01 18.94-46.19 18.94ZM434.87-140v-444.61h90.26V-140h-90.26Z"/></svg>',
  action: '<svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14" fill="white"><path d="M720-142 452-410q-23 11-47 17.5t-51 6.5q-89 0-151.5-62.5T140-600q0-23 4.5-44.5T158-686l140 138 108-108-136-138q20-9 40.5-14.5T354-814q89 0 151.5 62.5T568-600q0 29-6 53t-18 45l268 268q8 8 8 20t-8 20l-54 54q-8 8-19 7t-19-9Z"/></svg>',
  error: '<svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14" fill="white"><path d="m40-120 440-760 440 760H40Zm138-80h604L480-720 178-200Zm330.5-51.5Q520-263 520-280t-11.5-28.5Q497-320 480-320t-28.5 11.5Q440-297 440-280t11.5 28.5Q463-240 480-240t28.5-11.5ZM440-360h80v-200h-80v200Zm40-100Z"/></svg>',
  assistant: '<svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14" fill="white"><path d="M367-527q-47-47-47-113t47-113q47-47 113-47t113 47q47 47 47 113t-47 113q-47 47-113 47t-113-47ZM160-160v-112q0-34 17.5-62.5T224-378q62-31 126-46.5T480-440q66 0 130 15.5T736-378q29 15 46.5 43.5T800-272v112H160Z"/></svg>',
  thinking: '<svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14" fill="white"><path d="M480-80q-26 0-47-12.5T400-126q-33 0-56.5-23.5T320-206v-142q-59-39-94.5-103T190-590q0-121 84.5-205.5T480-880q121 0 205.5 84.5T770-590q0 77-35.5 140T640-348v142q0 33-23.5 56.5T560-126q-12 21-33 33.5T480-80Zm-80-126h160v-36H400v36Zm0-76h160v-38H400v38Zm-8-118h48v-100l-70-70 34-34 76 76 76-76 34 34-70 70v100h48q42-29 67-71.5t25-97.5q0-97-66.5-163.5T480-800q-97 0-163.5 66.5T250-570q0 55 25 97.5t67 71.5Z"/></svg>',
};

/**
 * Default color presets for each message type
 * @type {Record<string, string>}
 */
export const TYPE_COLORS = {
  context: 'blue',
  action: 'blue',
  error: 'red',
  assistant: 'indigo',
  thinking: 'yellow',
};

/**
 * @typedef {object} IconBoxOptions
 * @property {string} color - Color preset or semantic family name (applied as color-{name} CSS class)
 * @property {string} [iconClass] - CSS class for custom icon (from plugin MANIFEST)
 * @property {string} [iconSvg] - SVG markup (fallback if no iconClass)
 * @property {string} [badge] - Type-label text rendered as a lozenge beside the
 *   icon. Use this when the badge isn't already present in the wrapped content
 *   (e.g. thread tiles). When the content was built by renderResultStatusMessage
 *   the badge it rendered is hoisted automatically, so this is not needed there.
 */

/**
 * Create icon box element
 * @param {IconBoxOptions} options - Icon box configuration
 * @returns {HTMLDivElement} The icon box element
 */
export function createIconBox(options) {
  const iconBox = document.createElement('div');
  iconBox.className = `message-icon-box color-${options.color}`;

  if (options.iconClass) {
    const iconSpan = document.createElement('span');
    iconSpan.className = options.iconClass;
    iconBox.appendChild(iconSpan);
  } else if (options.iconSvg) {
    iconBox.innerHTML = options.iconSvg;
  }

  return iconBox;
}

/**
 * Create a type-name lozenge — the small uppercase badge shown beside an icon
 * (e.g. "Read", "Thread", "Error").
 * @param {string} text - Type label to display
 * @returns {HTMLSpanElement} The lozenge element
 */
export function createTypeBadge(text) {
  const badge = document.createElement('span');
  badge.className = 'context-item-type-badge';
  badge.textContent = text;
  return badge;
}

/**
 * Build the circular icon + type-name lozenge as one `.message-icon-badge`
 * group. The icon and lozenge share this parent so they keep a fixed layout
 * relative to each other regardless of what else sits alongside. Shared by the
 * conversation-row layout (wrapWithIcon) and the properties-panel header so
 * both render an identical badge. The color preset is applied to the group
 * itself so the lozenge background resolves even when no ancestor carries the
 * color class (as in the panel header).
 * @param {IconBoxOptions} options - Icon box configuration
 * @param {HTMLElement|null} [badgeEl] - Pre-built lozenge to place beside the icon
 * @returns {HTMLDivElement} The `.message-icon-badge` group
 */
export function createIconBadge(options, badgeEl = null) {
  const iconBadge = document.createElement('div');
  iconBadge.className = `message-icon-badge color-${options.color}`;
  iconBadge.appendChild(createIconBox(options));
  if (badgeEl) iconBadge.appendChild(badgeEl);
  return iconBadge;
}

/**
 * Wrap content element with icon layout
 * @param {HTMLElement} content - Content element to wrap
 * @param {IconBoxOptions} iconOptions - Options for createIconBox
 * @returns {HTMLDivElement} Wrapper with icon and content
 */
export function wrapWithIcon(content, iconOptions) {
  const wrapper = document.createElement('div');
  wrapper.className = `message-with-icon color-${iconOptions.color}`;

  // The badge lozenge is either passed explicitly (iconOptions.badge) or already
  // rendered inside `content` by renderResultStatusMessage — in which case we
  // hoist it out (createIconBadge's append moves the node) so it sits beside the
  // icon, not buried at a different depth in the content box.
  /** @type {HTMLElement|null} */
  let badge = null;
  if (iconOptions.badge) {
    badge = createTypeBadge(iconOptions.badge);
  } else {
    badge = /** @type {HTMLElement|null} */ (content.querySelector?.('.context-item-type-badge') ?? null);
  }

  if (badge) {
    wrapper.appendChild(createIconBadge(iconOptions, badge));
  } else {
    wrapper.appendChild(createIconBox(iconOptions));
  }

  const contentBox = document.createElement('div');
  contentBox.className = 'message-content-box';
  contentBox.appendChild(content);
  wrapper.appendChild(contentBox);

  return wrapper;
}

/**
 * Create a standard error article element (red icon + message text).
 * Used by error-message and tool-action-message for consistent error rendering.
 * @param {string} message - Error message text
 * @returns {HTMLElement} An <article class="error"> with icon-wrapped message
 */
export function createErrorArticle(message) {
  const article = document.createElement('article');
  article.className = 'error';

  const textSpan = document.createElement('span');
  textSpan.className = 'message-text';
  textSpan.textContent = message;

  article.appendChild(wrapWithIcon(textSpan, {
    color: /** @type {string} */ (TYPE_COLORS.error),
    iconSvg: TYPE_ICONS.error
  }));

  return article;
}
