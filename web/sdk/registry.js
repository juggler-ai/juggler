//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/registry` — instantiate registered context-item types by id.
 *
 * The one registry capability a capability legitimately needs is to materialise
 * another registered context-item type by id — e.g. a plan strategy creating a
 * plan item. That is the narrow **`createItem`** named export below;
 * **`itemClassForTool`** answers which class provides a tool, and
 * **`hasStrategy`** whether a strategy id is registered.
 */

import contextItemRegistry from '../js/registries/context-item-registry.js';
import fileViewerRegistry from '../js/registries/file-viewer-registry.js';
import strategyRegistry from '../js/registries/strategy-registry.js';
import { toDescriptor } from './file-source.js';

/**
 * Instantiate a registered context-item type from plain JSON. This is the
 * sanctioned, narrow entry point into the registry for capabilities.
 * @param {import('juggler/context-item').ItemJSON} json - Item data ({ id, type, data })
 * @param {import('../js/model/session.js').default} session - Owning session
 * @param {import('../js/model/conversation.js').default} conversation - Owning conversation
 * @param {import('../js/model/message-thread.js').default} messageThread - Owning thread
 * @returns {import('juggler/context-item').default} The instantiated context item
 * @throws {Error} If the item type is not registered or the JSON is malformed
 */
export function createItem(json, session, conversation, messageThread) {
  return contextItemRegistry.createItem(json, session, conversation, messageThread);
}

/**
 * The registered context-item class that provides a tool, by the tool's name
 * (aliases resolved). For an item that presents another tool's call as that
 * tool would — a program tool showing the call it holds.
 * @param {string} toolName - The tool's name, as the model calls it
 * @returns {typeof import('juggler/context-item').default|undefined} The class, if one is registered
 */
export function itemClassForTool(toolName) {
  return contextItemRegistry.getByToolName(toolName);
}

/**
 * Whether a strategy with this id is registered — for an item that asks a
 * sub-thread to run under a named strategy and must say so when it cannot.
 * @param {string} strategyId - The strategy's `MANIFEST.id`
 * @returns {boolean} True if a strategy with that id is registered
 */
export function hasStrategy(strategyId) {
  return strategyRegistry.has(strategyId);
}

/**
 * Produce the model-facing representation of a file by resolving its viewer and
 * running that viewer's `extract()`.
 *
 * This is the single place "what does the model see of this file?" is answered,
 * so every file-shaped context item (a tool read, a pin, a drop) gets the same
 * answer — including the fallback when no viewer claims the file, which is what
 * supplies the binary-file warning.
 *
 * Runs in the engine realm (extract's context); a viewer's heavy dependencies
 * load lazily inside its own `extract()`, so resolving costs nothing here.
 * @param {import('./file-source.js').FileSource} source - The file to extract
 * @param {import('./file-viewer.js').ExtractContext} [ctx] - Budget and abort signal
 * @returns {Promise<import('./file-viewer.js').ExtractResult>} What the model should see
 */
export async function extractFileSource(source, ctx = {}) {
  await fileViewerRegistry.ensureInitialized();
  const ViewerClass = fileViewerRegistry.resolve(toDescriptor(source));
  if (!ViewerClass) {
    const kind = source.mime || (source.isBinary ? 'binary' : 'this');
    return { warning: `No viewer is available for ${kind} content, so it cannot be read as text.` };
  }
  const viewer = new ViewerClass();
  return viewer.extract(source, ctx);
}

/**
 * Resolve which viewer would handle a file, without running it. Exposed for
 * callers that need to branch on viewer availability (or identity) before
 * committing to a render or an extraction.
 * @param {import('./file-viewer.js').FileDescriptor} descriptor - File metadata
 * @returns {typeof import('juggler/file-viewer').default|undefined} The winning viewer class, if any
 */
export function resolveFileViewer(descriptor) {
  return fileViewerRegistry.resolve(descriptor);
}
