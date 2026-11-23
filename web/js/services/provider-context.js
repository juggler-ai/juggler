//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The context a workspace provider's hook is handed, built in one place.
 *
 * A provider is an extension, so it gets what it needs of the session and the
 * conversation as plain values and narrow functions — the project's path and
 * state folder, a workspace's root, a way to send the conversation a message —
 * and never the models themselves. What each hook adds (its operations, its
 * signal, its rollback stack) the caller passes in `fields`.
 * @module services/provider-context
 */

import { servicesFor } from './extension-services.js';

/** @typedef {import('../../sdk/workspace-provider.js').ProviderContext} ProviderContext */
/** @typedef {import('../../sdk/workspace-provider.js').ProviderConversation} ProviderConversation */

/**
 * What a hook's caller supplies. Anything not given gets the do-nothing answer
 * a hook outside provisioning needs: no rollback, no checkpoint, no progress.
 * @typedef {object} ProviderContextFields
 * @property {any} [conversation] - The conversation model the hook acts for, where there is one
 * @property {import('../../sdk/ops.js').BoundOps} ops - Operations, already rooted
 * @property {import('../../sdk/ops.js').BoundOps} [baseOps] - Operations pinned to the base workspace
 * @property {string} [baseWorkspaceId] - The workspace being provisioned relative to
 * @property {object} [values] - For `renderSetup`: what the section last reported
 * @property {object} [input] - For `finish`: what the host collected
 * @property {AbortSignal} [signal] - The hook's signal; a getter is kept as a getter
 * @property {import('juggler/services').Services} [services] - Defaults to the window's
 * @property {import('../../sdk/workspace-provider.js').RollbackStack} [rollback] - The compensation stack
 * @property {(metaPatch: Record<string, unknown>) => Promise<void>} [checkpoint] - Persist progress
 * @property {(step: string, detail?: string) => void} [progress] - One line per step
 * @property {() => void} [setupChanged] - For `renderSetup`: re-read the form
 */

/**
 * The conversation as a provider sees it: who it is, and a way to hand it a
 * message as its user would send one, into its root thread, without touching
 * what the user has typed in the composer.
 * @param {any} conversation - The conversation model, or null.
 * @returns {ProviderConversation|undefined} The narrow view, or undefined for none.
 */
function providerConversation(conversation) {
  if (!conversation || typeof conversation.sendMessage !== 'function') return undefined;
  return {
    id: typeof conversation.id === 'string' ? conversation.id : '',
    send: async (/** @type {string} */ text) => {
      await conversation.sendMessage(text, null, conversation.rootMessageThread, { consumeComposer: false });
    },
  };
}

/**
 * Build a provider hook's context.
 * @param {any} session - The session the workspace belongs to, or null.
 * @param {ProviderContextFields} fields - What this hook adds.
 * @returns {ProviderContext} The context.
 */
export function providerContext(session, fields) {
  // Descriptors rather than values, so a `signal` getter stays a getter; a
  // field passed as undefined leaves the default in place.
  const { conversation, ...given } = /** @type {Record<string, PropertyDescriptor>} */ (Object.getOwnPropertyDescriptors(fields));
  const rest = Object.fromEntries(Object.entries(given)
    .filter(([, descriptor]) => descriptor.get || descriptor.value !== undefined)
    .map(([key, descriptor]) => [key, { ...descriptor, configurable: true }]));
  /** @type {any} */
  const ctx = {
    projectPath: String(session?.projectPath ?? ''),
    stateDir: String(session?.stateDir ?? ''),
    workspaceRoot: (/** @type {string} */ id) => {
      if (!session) return null;
      if (typeof session.workspaceRoot === 'function') return session.workspaceRoot(id ?? '');
      return id ? null : (typeof session.projectPath === 'string' && session.projectPath) || null;
    },
    conversation: providerConversation(conversation?.value),
    rollback: { push: () => {} },
    checkpoint: async () => {},
    progress: () => {},
    setupChanged: () => {},
  };
  Object.defineProperties(ctx, rest);
  if (!('signal' in rest)) {
    Object.defineProperty(ctx, 'signal', { value: new AbortController().signal, enumerable: true, writable: true });
  }
  if (!ctx.services) ctx.services = servicesFor(session, ctx.signal);
  return /** @type {ProviderContext} */ (ctx);
}
