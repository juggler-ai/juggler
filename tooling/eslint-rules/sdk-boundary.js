//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ESLint rule: a relative import may not cross into a forbidden tree unless
 * the crossing is declared.
 *
 * Four boundaries use it (tooling/eslint.config.js). With crossings declared
 * in tooling/sdk-boundary.json:
 * - the Apache-2.0 SDK (`web/sdk/**`) importing the AGPL app (`web/js/**`) —
 *   each crossing is a host binding, listed in LICENSING.md;
 * - a bundled extension (`web/extensions/**`) importing `web/js/**` or
 *   `web/sdk/lib/**` by relative path instead of through a `juggler/*`
 *   specifier — a path no third-party extension can reach.
 * With none:
 * - anything in `web/js/` but the view (`components/`, `app.js`) importing a
 *   component;
 * - `web/js/lib/` importing anything in `web/js/` outside itself.
 *
 * Every kind of module reference counts: `import … from`, a bare `import '…'`,
 * `export … from`, and a dynamic `import('…')` with a literal specifier, which
 * `no-restricted-imports` does not see. JSDoc `import('…')` type references
 * are comments, so they are not imports.
 *
 * A declared crossing the file no longer makes is reported too, so the
 * declarations only ever describe the code as it is.
 *
 * Options: `{ forbidden: string[], within: string, allowed: { [file]: string[] }, hint: string }`
 * — repo-relative directory prefixes (`web/js/`); a prefix inside them that is
 * the importing file's own tree, and so no crossing; the declared crossings by
 * repo-relative file (from tooling/sdk-boundary.json, which a stale one names);
 * and the advice appended to an undeclared one.
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Relative imports across a boundary (SDK/app, extension/app, model/view, leaf) must be declared' },
    schema: [{
      type: 'object',
      properties: {
        forbidden: { type: 'array', items: { type: 'string' } },
        within: { type: 'string' },
        allowed: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
        hint: { type: 'string' },
      },
      required: ['forbidden'],
      additionalProperties: false,
    }],
    messages: {
      undeclared: '{{file}} imports {{target}}, across the {{tree}} boundary. {{hint}}',
      stale: '{{file}} is declared in tooling/sdk-boundary.json as importing {{target}}, and no longer does: remove the entry.',
    },
  },
  create(context) {
    const { forbidden, within, allowed = {}, hint = '' } = context.options[0];
    const file = toPosix(relative(context.cwd, context.filename));
    const declared = new Set(allowed[file] ?? []);
    /** @type {Set<string>} */
    const seen = new Set();

    /**
     * @param {import('estree').ImportDeclaration|import('estree').ExportNamedDeclaration|import('estree').ExportAllDeclaration|import('estree').ImportExpression} node - A module reference
     */
    const check = (node) => {
      const source = /** @type {import('estree').Expression|null|undefined} */ (node.source);
      const spec = source?.type === 'Literal' && typeof source.value === 'string'
        ? source.value
        : source?.type === 'TemplateLiteral' && source.expressions.length === 0
          ? source.quasis[0].value.cooked
          : null;
      if (!spec || !spec.startsWith('.')) return;
      const target = joinPosix(dirnamePosix(file), spec);
      const tree = forbidden.find((prefix) => target.startsWith(prefix));
      if (!tree || (within && target.startsWith(within))) return;
      if (declared.has(target)) {
        seen.add(target);
        return;
      }
      context.report({ node: source, messageId: 'undeclared', data: { file, target, tree, hint } });
    };

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
      'Program:exit'(node) {
        for (const target of declared) {
          if (!seen.has(target)) context.report({ node, messageId: 'stale', data: { file, target } });
        }
      },
    };
  },
};

/**
 * @param {string} p - A path in either separator
 * @returns {string} The path with forward slashes
 */
function toPosix(p) {
  return p.replace(/\\/g, '/');
}

/**
 * `to` relative to `from`, both absolute (either separator).
 * @param {string} from - The directory to be relative to
 * @param {string} to - The path to express
 * @returns {string} `to` relative to `from`, forward-slashed
 */
function relative(from, to) {
  const a = toPosix(from).replace(/\/+$/, '');
  const b = toPosix(to);
  return b.startsWith(a + '/') ? b.slice(a.length + 1) : b;
}

/**
 * @param {string} p - A forward-slashed path
 * @returns {string} Its directory, '' at the top
 */
function dirnamePosix(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/**
 * Resolve a relative specifier against a directory, POSIX-style.
 * @param {string} dir - The importing file's directory
 * @param {string} spec - The relative specifier
 * @returns {string} The resolved path
 */
function joinPosix(dir, spec) {
  const out = dir ? dir.split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}
