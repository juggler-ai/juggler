//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Juggler Extension SDK — version.
 *
 * The single source of truth for the public SDK version. An extension declares
 * the range it is built against via `engineApi` in its `juggler.extension.json`;
 * the host refuses to load an extension whose range excludes this version, with a
 * clear diagnostic instead of a mystery `import` failure.
 *
 * Bump rules (semver):
 * - PATCH: doc/typo, internal change with no surface effect.
 * - MINOR: additive — new exports, new optional fields. Existing extensions keep working.
 * - MAJOR: a removal or breaking change to any `juggler/*` export.
 *
 * ## What the version covers (the compat surface)
 *
 * IN scope — changes here follow the bump rules above:
 * - The named exports of each `juggler/*` facade (`context-item`, `strategy-type`,
 *   `command-type`, `lifecycle`, `ops`, `ui`, `registry`, `version`).
 * - The documented `static MANIFEST` fields for each capability type, and the
 *   `provides` manifest fields (see `docs/extension_guide.md`).
 * - The MessageThread methods marked **`@plugin-api`** in
 *   `web/js/model/message-thread.js`.
 *
 * OUT of scope — NOT covered, may change without a major bump:
 * - Anything reached through `this.session`, `this.conversation`, or the raw
 *   Y.Map objects returned by `messageThread.items` / `CommandType.items` beyond
 *   the documented `@plugin-api` surface.
 * - Members tagged `@internal` / `@deprecated` in the SDK JSDoc (e.g. the
 *   `juggler/registry` default export, core-only MANIFEST fields).
 * Reaching past the documented surface works today but can break at any release.
 */
export const ENGINE_API_VERSION = '1.1.0';

/**
 * Test whether `version` satisfies an `engineApi` range. Supports the small
 * subset of semver we actually use in manifests: an exact version (`1.2.3`),
 * a caret range (`^1.2.3` — compatible-with, same major, >= the floor), or `*`
 * (any). Anything unrecognised returns false so the host can surface a clear error.
 * @param {string} range - the manifest's `engineApi` value
 * @param {string} [version] - the SDK version to test (defaults to current)
 * @returns {boolean} true if `version` falls within `range`
 */
export function satisfiesEngineApi(range, version = ENGINE_API_VERSION) {
  if (typeof range !== 'string' || typeof version !== 'string') return false;
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === '') return true;

  /**
   * @param {string} v - a version-ish string to parse
   * @returns {[number, number, number]|null} [major, minor, patch] or null if unparseable
   */
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const cur = parse(version);
  if (!cur) return false;

  if (trimmed.startsWith('^')) {
    const floor = parse(trimmed.slice(1));
    if (!floor) return false;
    if (cur[0] !== floor[0]) return false; // same major
    // cur >= floor within the major
    if (cur[1] !== floor[1]) return cur[1] > floor[1];
    return cur[2] >= floor[2];
  }

  const exact = parse(trimmed);
  if (!exact) return false;
  return cur[0] === exact[0] && cur[1] === exact[1] && cur[2] === exact[2];
}
