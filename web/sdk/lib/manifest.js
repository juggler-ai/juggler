//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Capability manifest validation.
 *
 * Every plugin capability — context item, strategy, command, pinboard item,
 * info card, file viewer — declares itself with a `static MANIFEST`. This is the
 * one check that manifest passes, wherever it is reached from: the SDK base
 * classes call it from their constructors, and `BaseRegistry.validateClass`
 * calls it when a class is loaded or registered.
 *
 * It lives in one place because the two callers see different classes. The
 * registry sees everything a viewer loads from disk; the constructors also see
 * classes that reach the app another way — a strategy the app falls back to
 * without registering, a class a test builds by hand. A rule written twice is a
 * rule that holds in one of those places and not the other.
 *
 * Errors name the **class**, because that is what identifies the plugin at
 * fault. Which of six loaders was running when it was noticed is not something
 * the author can act on.
 * @module sdk/lib/manifest
 */

/**
 * The fields every capability manifest must carry. A type that needs more (the
 * info card needs `eyebrow`) passes its own list.
 * @type {string[]}
 */
export const REQUIRED_MANIFEST_FIELDS = ['id', 'name', 'version', 'description'];

/**
 * Validate a capability class's `static MANIFEST`.
 *
 * A field that is present but empty counts as missing: a capability with
 * `id: ''` cannot be addressed, enabled or collided with, so accepting it only
 * defers the failure to somewhere less obvious.
 * @param {{name?: string, MANIFEST?: object}|null|undefined} ctor - The capability class (not an instance).
 * @param {string[]} [requiredFields] - Fields to require, defaulting to {@link REQUIRED_MANIFEST_FIELDS}.
 * @throws {Error} If the manifest is absent or any required field is missing or empty.
 */
export function validateManifest(ctor, requiredFields = REQUIRED_MANIFEST_FIELDS) {
  const className = ctor?.name || 'Capability';
  const manifest = ctor?.MANIFEST;

  if (!manifest) {
    throw new Error(`${className} must define a static MANIFEST`);
  }

  const fields = /** @type {Record<string, unknown>} */ (manifest);
  const missingFields = requiredFields.filter(field => !fields[field]);

  if (missingFields.length > 0) {
    throw new Error(
      `${className}.MANIFEST is missing required fields: ${missingFields.join(', ')}`
    );
  }
}
