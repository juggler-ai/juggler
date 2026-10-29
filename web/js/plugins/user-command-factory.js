//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * User-command factory — turns a declarative {@link UserCommandDef} (parsed from
 * a `.juggler/commands/*.md` file) into a runnable {@link CommandType} subclass.
 *
 * A user command is *data*: a prompt template plus a few execution options,
 * interpreted by one generic command class synthesised here. This keeps the
 * whole feature a single built-in behaviour rather than a per-command plugin.
 * @module plugins/user-command-factory
 */

import CommandType from 'juggler/command-type';
import providersCache from '../services/providers-cache.js';
import { buildModelConfig } from '../model/model-config.js';
import { t } from '../../sdk/lib/i18n.js';

const DEFAULT_ICON = 'icon-slash';

/**
 * Expand a prompt template's placeholders against invocation args.
 *
 * - `$1`..`$9` — positional args (1-based); unfilled expand to empty string.
 * - `$ARGUMENTS` — the argument text exactly as typed.
 * - `$$` — a literal `$` (escape); so `$$1` yields the literal text `$1`.
 * - `$10` is `$1` followed by a literal `0` (placeholders are single-digit).
 *
 * The two argument forms are the same text read two ways: `args` are its
 * whitespace-delimited tokens, `rest` is the text itself. `$ARGUMENTS` takes the
 * text, so a multi-line invocation — markdown headings, lists, fenced code —
 * reaches the prompt with its line breaks intact. A caller holding only the
 * tokens may omit `rest`, and `$ARGUMENTS` then joins them with single spaces.
 *
 * Pure function — no IO, no `this`. This is the one place the placeholder syntax
 * is defined; it is unit-tested exhaustively.
 * @param {string} body - The template body
 * @param {string[]} [args] - Invocation arguments (positional)
 * @param {string} [rest] - The argument text as typed
 * @returns {string} The expanded prompt
 */
export function expandTemplate(body, args = [], rest) {
  const argList = Array.isArray(args) ? args : [];
  const all = typeof rest === 'string' ? rest : argList.join(' ');
  return String(body).replace(/\$(\$|ARGUMENTS|[1-9])/g, (_match, token) => {
    if (token === '$') return '$';
    if (token === 'ARGUMENTS') return all;
    return argList[Number(token) - 1] ?? '';
  });
}

/**
 * Humanise a kebab-case command name into a display label
 * ("review-pr" → "Review Pr").
 * @param {string} name - Command name
 * @returns {string} Display label
 */
function humanize(name) {
  return name
    .split('-')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * The provider that serves a model id: the one named in frontmatter when it
 * still advertises that model, else the first provider that advertises it at
 * all. Returns '' when no provider offers it.
 *
 * The scan is the path for a file with `model:` and no `provider:` — what a
 * hand-written command and the `define_command` tool produce — and the fallback
 * for a stored provider that has since been removed or lost the model.
 * @param {string} providerName - Provider from frontmatter (may be '')
 * @param {string} modelId - Model id from frontmatter
 * @returns {string} A provider name, or ''
 */
function providerFor(providerName, modelId) {
  const advertises = (/** @type {import('../services/providers-cache.js').Provider} */ p) => (p.modelsWithContext || []).some((m) => m.id === modelId);
  const providers = providersCache.getChat();
  const named = providerName ? providers.find((p) => p.name === providerName) : null;
  if (named && advertises(named)) return named.name;
  return providers.find(advertises)?.name || '';
}

/**
 * Resolve a command's model override to a concrete config, carrying the thinking
 * level and serving tier the user picked. Returns null when no provider offers
 * the model (the subthread then inherits the parent's model rather than failing)
 * — the same lenience the rest of the app applies to a model that has gone away.
 *
 * Exported so the editor dialog seeds its model chip from the same resolution
 * the command will actually run with: a file whose provider has to be inferred
 * must show the provider it would infer, not a blank.
 * @param {import('../services/user-commands.js').UserCommandFrontmatter} fm - Command frontmatter
 * @returns {import('../model/model-config.js').ConcreteModelConfig|null} Concrete config or null
 */
export function resolveModelConfig(fm) {
  const modelId = fm.model || '';
  if (!modelId) return null;
  const provider = providerFor(fm.provider || '', modelId);
  if (!provider) return null;
  return buildModelConfig(provider, modelId, fm.thinking, fm.serviceTier);
}

/**
 * Build a {@link CommandType} subclass from a user-command definition. The
 * returned class carries a synthesised MANIFEST (id = the command name) and an
 * `execute` that interprets the definition's run mode.
 * @param {import('../services/user-commands.js').UserCommandDef} def - The definition
 * @returns {typeof CommandType} A command class ready to register
 */
export function makeUserCommandClass(def) {
  const fm = def.frontmatter || {};
  const runMode = fm.run || 'send';

  class UserCommand extends CommandType {
    static MANIFEST = {
      id: def.name,
      name: humanize(def.name),
      version: '1.0.0',
      description: fm.description || '',
      icon: fm.icon || DEFAULT_ICON,
      // Sending a message / opening a thread does not itself race a live turn
      // by snapshotting conversation items, so no cancel-and-settle gate.
      mutatesConversation: false,
      // Markers the slash menu / manager key off for provenance and behaviour.
      userDefined: true,
      scope: def.scope,
      argsHint: fm.argsHint || '',
      runMode,
    };

    /**
     * The prompt this command produces for an invocation. A scheduled send of a
     * `send`-mode command holds this text, since sending it is all the command
     * would do (SlashCommandHandler.resolveScheduled).
     * @param {string[]} args - Invocation arguments
     * @param {string} [rest] - The argument text as typed
     * @returns {string} The expanded prompt
     */
    static expand(args, rest) {
      return expandTemplate(def.body || '', args, rest);
    }

    /**
     * @param {string[]} args - Invocation arguments
     * @param {string} [rest] - The argument text as typed
     * @returns {Promise<import('juggler/command-type').CommandResult>} Result
     */
    async execute(args, rest) {
      const text = UserCommand.expand(args, rest);
      const thread = this.messageThread;
      if (!thread) return { handled: true, error: true, message: t('No conversation is open.') };

      switch (runMode) {
        case 'draft':
          // Splice the expanded template into the composer for editing before
          // send — declared as a side effect so the command never touches DOM.
          return { handled: true, sideEffects: [{ type: 'setDraft', data: { text } }] };

        case 'subthread': {
          // Fire-and-forget: create the sub-thread, open its column so the user
          // can watch, and return immediately. The result lands in the parent
          // per runInThread semantics. Strategy/model overrides apply to the
          // new thread only.
          const goal = fm.goal || humanize(def.name);
          const modelConfig = resolveModelConfig(fm);
          const promise = thread.runInThread({
            goal,
            prompt: text,
            strategyId: fm.strategy || '',
            modelConfig,
          });
          // Swallow cancellation/teardown — the parent surfaces the result.
          promise.catch((/** @type {unknown} */ err) => {
            const name = typeof err === 'object' && err !== null && 'name' in err ? err.name : undefined;
            if (name !== 'AbortError') console.error('[UserCommand] subthread failed:', err);
          });
          return { handled: true };
        }

        case 'send':
        default:
          // Expand → send as a normal user turn on this thread.
          await thread.conversation.sendMessage(text, thread.threadItemId ?? null, thread);
          return { handled: true };
      }
    }
  }

  return UserCommand;
}
