//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ESLint rule: no absolute `/api/` URL written out in client code.
 *
 * A server may be mounted under a path prefix (the machine server serves each
 * session at its project's link, /p/<key>/), so a literal '/api/…' addresses the wrong server. Every
 * /api URL is built by web/js/utils/api-url.js (`apiUrl('/config')`), which
 * prepends the page's base path. This flags a string literal, or any
 * template-literal segment, that begins with '/api/' (or is exactly '/api').
 *
 * A standalone rule rather than a `no-restricted-syntax` selector: that rule is
 * switched off wholesale for several files by overrides in eslint.config.js,
 * and would silently stop covering them.
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Build /api URLs with apiUrl() from web/js/utils/api-url.js' },
    schema: [],
    messages: {
      absolute: "Absolute /api URL '{{text}}': build it with apiUrl('{{rest}}') from web/js/utils/api-url.js, "
        + 'so it follows the base path the page was served under.',
    },
  },
  create(context) {
    /**
     * @param {import('estree').Node} node - The literal or template segment to report on.
     * @param {string} text - Its string content.
     */
    const check = (node, text) => {
      if (text === '/api' || text.startsWith('/api/') || text.startsWith('/api?')) {
        context.report({
          node,
          messageId: 'absolute',
          data: { text: text.length > 60 ? `${text.slice(0, 57)}...` : text, rest: text.slice(4) || '/' },
        });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
    };
  },
};
