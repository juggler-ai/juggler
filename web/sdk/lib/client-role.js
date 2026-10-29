//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Client role utilities.
 * Determines whether this browser instance is an engine (executes tools)
 * or a viewer (shows UI only).
 *
 * **Plugin-accessible** — plugins may import `isEngine()` / `isViewer()` for
 * rare cases where a method needs context-specific behavior. Most plugins
 * should not need this; the framework routes calls to the correct context
 * automatically. See `ContextItem.METHOD_CONTEXT` for the standard approach.
 * @module utils/client-role
 */

/**
 * Returns true if this browser is the engine (headless tool executor).
 * @returns {boolean} True if engine mode
 */
export function isEngine() {
  return /** @type {{JUGGLER_ENGINE?: unknown}} */ (globalThis).JUGGLER_ENGINE === true;
}

/**
 * Returns true if this browser is a viewer (user-facing UI).
 * @returns {boolean} True if viewer mode
 */
export function isViewer() {
  return !isEngine();
}
