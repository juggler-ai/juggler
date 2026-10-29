//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Global type declarations for Juggler
 */

interface Window {
	/**
	 * Show an alert dialog
	 */
	showAlert(message: string, title?: string): Promise<void>;

	/**
	 * Show a confirm dialog
	 */
	showConfirm(
		message: string,
		title?: string,
		options?: { confirmText?: string; cancelText?: string; danger?: boolean }
	): Promise<boolean>;

	/**
	 * Show a prompt dialog
	 */
	showPrompt(message: string, defaultValue?: string, title?: string): Promise<string | null>;

	/**
	 * Marked markdown parser (loaded from vendor)
	 */
	marked?: {
		parse(markdown: string): string;
	};

	/**
	 * Reference to main application instance (debugging)
	 */
	jugglerApp?: unknown;

	/**
	 * Show choice dialog
	 */
	showChoice?(message: string, choices: string[], title?: string, allowCustom?: boolean): Promise<string | null>;

	/**
	 * Open settings panel
	 * @param tab - Optional tab to switch to ('providers', 'shortcuts', 'facts')
	 * @param options - Optional target to reveal inside that tab (a capability in the Extensions catalog)
	 */
	openSettings?(tab?: string, options?: { capability?: { itemType: string; id: string } }): void;

	/**
	 * The machine's UI zoom (root font-size %) from settings.json, injected
	 * pre-paint by the server. 0/absent when it has none (see zoom-manager.js).
	 */
	__machineZoom?: number;

	/**
	 * The machine's UI theme mode (system|light|dark) from settings.json,
	 * injected pre-paint by the server. Empty/absent when it has none (see
	 * theme-manager.js).
	 */
	__machineThemeMode?: string;

	/**
	 * The UI zoom this project's session stored, injected pre-paint so the
	 * server's own window can adopt it for a machine that has none. 0/absent
	 * when the session has none.
	 */
	__projectZoom?: number;

	/**
	 * The UI theme mode this project's session stored, injected pre-paint so
	 * the server's own window can adopt it for a machine that has none.
	 * Empty/absent when the session has none.
	 */
	__projectThemeMode?: string;

	/**
	 * Opaque per-project key injected pre-paint by the server, namespacing this
	 * device's stored preferences so they belong to the project they were set
	 * in (see services/prefs.js). Empty/absent for a no-project window.
	 */
	__projectKey?: string;

}

/**
 * Custom element type extensions
 */
interface HTMLElementTagNameMap {
	// These elements are their real classes, so createElement,
	// querySelector and closest hand back a type the checker holds to the
	// class's own public surface, `@private` included.
	'conversation-area': import('../components/conversation-area.js').default;
	'properties-panel': import('../components/properties-panel.js').default;
	'composer-box': import('../components/composer.js').default;
	'action-confirmation': import('../components/action-confirmation.js').default;
	'model-selector': HTMLElement & {
		refresh(): void;
		setSession(session: unknown): void;
	};
	'plugin-catalog': HTMLElement & {
		show(scope: 'global' | 'local'): void;
	};
}

