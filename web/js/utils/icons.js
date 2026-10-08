//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Material Symbols "arrow_split" — used everywhere we visualise a thread.
export const THREAD_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14" fill="white"><path d="m296-80-56-56 240-240 240 240-56 56-184-184L296-80Zm184-504L240-824l56-56 184 184 184-184 56 56-240 240Z"/></svg>';

// Material Symbols "u_turn_right" — branch-off arrow shown on the New Thread button.
export const THREAD_ARROW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14" fill="currentColor"><path d="m600-200-56-57 143-143H300q-75 0-127.5-52.5T120-580q0-75 52.5-127.5T300-760h20v80h-20q-42 0-71 29t-29 71q0 42 29 71t71 29h387L544-624l56-56 240 240-240 240Z"/></svg>';

// Material Symbols "arrow_drop_down" — the dropdown chevron for combo-box controls
// (project-path chip, strategy selector). One shape everywhere for consistency.
export const DROPDOWN_ARROW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M480-360 280-560h400L480-360Z"/></svg>';

// Material Symbols "keyboard_double_arrow_up" / "keyboard_double_arrow_down" —
// the jump-to-top and jump-to-bottom controls on the thread message list.
export const SCROLL_TOP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="m296-224-56-56 240-240 240 240-56 56-184-183-184 183Zm0-240-56-56 240-240 240 240-56 56-184-183-184 183Z"/></svg>';
export const SCROLL_BOTTOM_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M480-200 240-440l56-56 184 183 184-183 56 56-240 240Zm0-240L240-680l56-56 184 183 184-183 56 56-240 240Z"/></svg>';

// Material Symbols "attach_file" — the composer's attach-files button.
export const PAPERCLIP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M720-330q0 104-73 177T470-80q-104 0-177-73t-73-177v-370q0-75 52.5-127.5T400-880q75 0 127.5 52.5T580-700v350q0 46-32 78t-78 32q-46 0-78-32t-32-78v-370h80v370q0 13 8.5 21.5T470-320q13 0 21.5-8.5T500-350v-350q-1-42-29.5-71T400-800q-42 0-71 29t-29 71v370q-1 71 49 120.5T470-160q70 0 119-49.5T640-330v-390h80v390Z"/></svg>';

// Material Symbols "arrow_upward" — the touch-only Send button on the composer.
export const SEND_ARROW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M440-160v-487L216-423l-56-57 320-320 320 320-56 57-224-224v487h-80Z"/></svg>';

// Material Symbols "more_vert" — the touch-only overflow-actions (kebab) button on the composer.
export const KEBAB_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M480-160q-33 0-56.5-23.5T400-240q0-33 23.5-56.5T480-320q33 0 56.5 23.5T560-240q0 33-23.5 56.5T480-160Zm0-240q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm0-240q-33 0-56.5-23.5T400-720q0-33 23.5-56.5T480-800q33 0 56.5 23.5T560-720q0 33-23.5 56.5T480-640Z"/></svg>';

// Material Symbols "expand_more" / "expand_less" — the Show more / Show less
// toggle on oversized collapsible items (long user messages, thread summaries).
export const EXPAND_MORE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M480-344 240-584l56-56 184 184 184-184 56 56-240 240Z"/></svg>';
export const EXPAND_LESS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M480-528 296-344l-56-56 240-240 240 240-56 56-184-184Z"/></svg>';

// Material Symbols "schedule" — the send-after-delay affordance on the composer.
export const CLOCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M339.5-108.5q-65.5-28.5-114-77t-77-114Q120-365 120-440t28.5-140.5q28.5-65.5 77-114t114-77Q405-800 480-800t140.5 28.5q65.5 28.5 114 77t77 114Q840-515 840-440t-28.5 140.5q-28.5 65.5-77 114t-114 77Q555-80 480-80t-140.5-28.5ZM480-440Zm112 168 56-56-128-128v-184h-80v216l152 152ZM224-866l56 56-170 170-56-56 170-170Zm512 0 170 170-56 56-170-170 56-56ZM480-160q117 0 198.5-81.5T760-440q0-117-81.5-198.5T480-720q-117 0-198.5 81.5T200-440q0 117 81.5 198.5T480-160Z"/></svg>';

// Material Symbols "refresh" (autorenew) — the Skills tab's refresh-active control:
// re-fetch registries over the network on Discover, rescan local folders on Installed.
export const REFRESH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M482-160q-134 0-228-93t-94-227v-7l-64 64-56-56 160-160 160 160-56 56-64-64v7q0 100 70.5 170T482-240q26 0 51-6t49-18l60 60q-38 22-78 33t-82 11Zm278-161L600-481l56-56 64 64v-7q0-100-70.5-170T478-720q-26 0-51 6t-49 18l-60-60q38-22 78-33t82-11q134 0 228 93t94 227v7l64-64 56 56-160 160Z"/></svg>';

// Material Symbols "info" — opens details for an item without selecting it.
export const INFO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24" fill="currentColor" aria-hidden="true"><path d="M440-280h80v-240h-80v240Zm68.5-331.5Q520-623 520-640t-11.5-28.5Q497-680 480-680t-28.5 11.5Q440-657 440-640t11.5 28.5Q463-600 480-600t28.5-11.5ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/></svg>';

// Material Symbols "open_in_new" — opens the file a properties-panel path row
// names in whatever the host OS considers its application.
export const OPEN_IN_NEW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h560v-280h80v280q0 33-23.5 56.5T760-120H200Zm188-212-56-56 372-372H560v-80h280v280h-80v-144L388-332Z"/></svg>';

// Material Symbols "push_pin" — pins the file a properties-panel path row names
// to the Pinboard.
export const PIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="m640-480 80 80v80H520v240l-40 40-40-40v-240H240v-80l80-80v-280h-40v-80h400v80h-40v280Zm-286 80h252l-46-46v-314H400v314l-46 46Zm126 0Z"/></svg>';

// Material Symbols "undo" — puts back what was just removed: the bin toast, the
// column-footer undo offer, and rewind / re-run in the properties panel.
export const UNDO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M280-200v-80h284q63 0 109.5-40T720-420q0-60-46.5-100T564-560H312l104 104-56 56-200-200 200-200 56 56-104 104h252q97 0 166.5 63T800-420q0 94-69.5 157T564-200H280Z"/></svg>';

// Material Symbols "call_split" — starts a new conversation from an existing one.
export const FORK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M448-160v-305.33L226.67-686.67V-570H160v-230h230v66.67H274l240.67 240.66V-160H448Zm126.67-368-47.34-47.33 158.67-158H570V-800h230v230h-66.67v-116.67L574.67-528Z"/></svg>';

// Material Symbols "refresh" — try that again: a failed turn's Retry, the
// properties panel's Refresh. A single circular arrow, unlike REFRESH_SVG's pair.
export const RETRY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z"/></svg>';

// Material Symbols "add" — a plus: new conversation / workspace rows, zoom in.
export const ADD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z"/></svg>';

// Material Symbols "delete" — a trash can: moving a conversation to the bin.
export const BIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/></svg>';

/**
 * One of the icons in this module with attributes set on its `<svg>`, for a site
 * that draws it at another size or in a fixed colour. An attribute the icon
 * already carries is replaced; any other is added. Values are not escaped.
 * @param {string} svg - An icon string from this module.
 * @param {Record<string, string>} attrs - Attribute name → value.
 * @returns {string} The same icon with those attributes on its root element.
 */
export function withAttrs(svg, attrs) {
  const end = svg.indexOf('>');
  let tag = svg.slice(0, end);
  for (const [name, value] of Object.entries(attrs)) {
    const existing = new RegExp(`\\s${name}="[^"]*"`);
    const attr = ` ${name}="${value}"`;
    tag = existing.test(tag) ? tag.replace(existing, attr) : tag + attr;
  }
  return tag + svg.slice(end);
}

/**
 * One of the icons in this module with a class on its `<svg>`, for a site whose
 * CSS sizes or colours the icon through that class.
 * @param {string} svg - An icon string from this module.
 * @param {string} className - Class (or space-separated classes) to add.
 * @returns {string} The same markup with `class` on its root element.
 */
export function withClass(svg, className) {
  return withAttrs(svg, { class: className });
}

// Material Symbols "check" — a done/active tick: installed skills, the model
// picker's selected row, a provider's active key, the edits-on permission label.
export const CHECK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg>';

// Material Symbols "priority_high" — a bare "!", a tab's last-turn-failed glyph.
export const ALERT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M400-400v-400h160v400H400Zm80 280q-33 0-56.5-23.5T400-200q0-33 23.5-56.5T480-280q33 0 56.5 23.5T560-200q0 33-23.5 56.5T480-120Z"/></svg>';

// GitHub mark — used on "View on GitHub" links (e.g. the skills preview).
export const GITHUB_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';
