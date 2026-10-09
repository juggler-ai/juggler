//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * User-hook factory — turns a declarative {@link UserHookDef} (parsed from a
 * `~/.juggler/hooks/*.md` file) into a {@link HookType} subclass.
 *
 * A hook file is *data*: when to fire, and the text to add. The class built here
 * is the whole of its behaviour, so a file can do exactly what its frontmatter
 * says and nothing a code hook could do beyond that — in particular it can never
 * `allow` a call.
 * @module plugins/user-hook-factory
 */

import HookType from 'juggler/hook-type';

/**
 * Translate a hook file's frontmatter into the manifest `match` a code hook
 * would declare, so both kinds are matched by the one runtime rule.
 * @param {import('../services/user-hooks.js').UserHookFrontmatter} fm - Parsed frontmatter
 * @returns {import('juggler/hook-type').HookMatch} The equivalent match
 */
export function matchFromFrontmatter(fm) {
  /** @type {import('juggler/hook-type').HookMatch} */
  const match = {};
  const tools = (typeof fm.tool === 'string' ? fm.tool : '').split(',').map(t => t.trim()).filter(Boolean);
  if (tools.length) match.tools = tools;
  if (fm.input) match.input = fm.input;
  if (fm.result) match.result = fm.result;
  if (fm.isError === 'true') match.isError = true;
  if (fm.isError === 'false') match.isError = false;
  return match;
}

/**
 * Build the hook class for one valid hook file.
 * @param {import('../services/user-hooks.js').UserHookDef} def - A definition with no `error`
 * @returns {typeof HookType} The synthesised hook class
 */
export function makeUserHookClass(def) {
  const fm = def.frontmatter || {};
  const event = /** @type {import('juggler/hook-type').HookEvent} */ (fm.event);
  const text = typeof def.body === 'string' ? def.body.trim() : '';

  class UserHook extends HookType {
    static MANIFEST = {
      id: def.name,
      name: def.name,
      version: '1.0.0',
      description: fm.description || def.name,
      events: [event],
      match: matchFromFrontmatter(fm),
      repeat: fm.repeat === 'once-per-thread' ? 'once-per-thread' : 'always',
      // Where it came from, for the catalog and the tool card.
      userHookPath: def.path,
    };
  }

  if (event === 'beforeTool') {
    /** @type {any} */ (UserHook.prototype).beforeTool = function () {
      if (fm.verdict === 'deny' || fm.verdict === 'ask') {
        return { verdict: fm.verdict, reason: text || undefined };
      }
      return { note: text };
    };
  } else {
    /** @type {any} */ (UserHook.prototype).afterTool = function () {
      return { note: text };
    };
  }
  return UserHook;
}
