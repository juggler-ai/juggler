//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/pinboard` — one-way writes to the user's Pinboard.
 *
 * Extensions may request that a configured pin be added and revealed, but this
 * module deliberately exposes no board read or list operation. A Pinboard remains
 * display state, not a source of model context.
 * @module sdk/pinboard
 */

import { applyPinboardOperations } from '../js/services/pinboard-operations-api.js';
import { getExtensionCapabilities, fetchDisabledPluginIds } from '../js/services/extensions.js';
import { resolveAssetUrl, importModuleUrl } from '../js/utils/asset-url.js';

/**
 * Add or restore one pin on the shared main board and ask eligible viewers to
 * reveal it. `id` must be stable for an idempotent retry. The update following
 * the add also restores the expected config if that id was already present.
 * @param {{id: string, type: string, config: Record<string, unknown>, from: string, signal?: AbortSignal}} request - Pin request.
 * @returns {Promise<{board?: string, pins?: import('../js/services/pinboard-store.js').Pin[]}>} Resulting board.
 */
export function pinToPinboard(request) {
  const { id, type, config, from, signal } = request;
  if (!id || !type || !from) throw new Error('id, type and from are required');
  return applyPinboardOperations('main', [
    { op: 'add', id, type, config },
    { op: 'update', id, config },
  ], { pin: id, from }, signal);
}

/**
 * Every enabled pinboard item type that has told the agent it exists, in catalog
 * order with the fallback types last.
 *
 * The item types themselves render DOM and are loaded only in the viewer, so this
 * loads their descriptors instead — separate, side-effect-free modules declared
 * under `pinboardItemMeta`, which import cleanly in the engine worker where the
 * pin tool runs. A type with no descriptor is absent here: it stays pinnable by
 * name, but nothing tells the model it is there.
 *
 * One bad descriptor costs only itself. The rest of the catalog is still worth
 * describing, and a tool that lists six of seven types is far better than one
 * that lists none.
 * @returns {Promise<import('./pinboard-item-type.js').PinAgentDescriptor[]>} The descriptors.
 */
export async function loadPinAgentDescriptors() {
  const [refs, known] = await Promise.all([
    getExtensionCapabilities('pinboard-item-meta'),
    fetchDisabledPluginIds(),
  ]);
  // Unknown reads as "nothing switched off": describing a pin type the user has
  // disabled is a smaller fault than describing none of them.
  const disabled = known || new Set();

  /** @type {import('./pinboard-item-type.js').PinAgentDescriptor[]} */
  const descriptors = [];
  for (const ref of refs) {
    if (ref.extensionId && disabled.has(ref.extensionId)) continue;
    try {
      const module = await importModuleUrl(resolveAssetUrl(ref.path));
      const descriptor = module?.default;
      if (!descriptor?.id || typeof descriptor.description !== 'string' || !descriptor.parameters) {
        console.error(`[Pinboard] "${ref.path}" is not a pin agent descriptor`);
        continue;
      }
      // A capability is disabled by its own id as readily as by its extension's,
      // matching how every registry reads the same flat list.
      if (disabled.has(descriptor.id)) continue;
      descriptors.push(descriptor);
    } catch (err) {
      console.error(`[Pinboard] Couldn't load the pin descriptor at "${ref.path}":`, err);
    }
  }
  return descriptors.sort((a, b) => Number(a.fallback || false) - Number(b.fallback || false));
}
