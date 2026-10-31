/**
 * Opening the settings panel, as a module function rather than a global.
 *
 * The panel itself is a component and this is a service, so the dependency runs
 * one way only: `settings-panel.js` registers the opener as it defines the
 * element, and everything that wants to open settings — components, the app
 * shell, the model layer — imports `openSettings` from here without importing
 * the panel. That is also why the call is a no-op until registration: it is
 * the same guard a caller of the `window.openSettings` global needs
 * (`typeof … === 'function'` before calling it), written once.
 *
 * `window.openSettings` survives as an alias for extensions.
 */

/**
 * @typedef {object} OpenSettingsOptions
 * @property {{itemType: string, id: string}} [capability] - Reveal this extension capability
 * @property {{name?: string}} [newCommand] - Open a new command's draft in the Slash commands tab, the name pre-filled
 * @property {any} [mcpServer] - Reveal this MCP server
 * @property {string} [conversationLog] - Reveal this conversation's log in the Logs tab
 * @property {{provider: string, id: string}} [model] - Reveal this model's Context window field in the Providers tab
 */

/** @type {((tab?: string, options?: OpenSettingsOptions) => void) | null} */
let opener = null;

/**
 * Register the function that actually presents the settings panel.
 *
 * Called once by `settings-panel.js`; the returned function puts the previous
 * opener back, which is how a test stands in for it for the length of one case.
 * @param {(tab?: string, options?: OpenSettingsOptions) => void} fn - The presenter
 * @returns {() => void} Restores the opener that was registered before this call
 */
export function registerSettingsOpener(fn) {
  const previous = opener;
  opener = fn;
  return () => { opener = previous; };
}

/**
 * Open the settings panel, optionally on a named tab.
 *
 * A no-op if the settings panel module has not loaded yet — the page is still
 * assembling and there is nothing to show.
 * @param {string} [tab] - Tab id (e.g. `providers`, `shortcuts`)
 * @param {OpenSettingsOptions} [options] - What to reveal once open
 * @returns {void}
 */
export function openSettings(tab, options) {
  if (opener) opener(tab, options);
}
