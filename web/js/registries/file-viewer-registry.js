//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseRegistry from './base-registry.js';
import { getExtensionCapabilities } from '../services/extensions.js';
import { extensionOf } from '../../sdk/file-source.js';

/**
 * FileViewerRegistry — loads the "file viewer" plugins that decide how a file
 * looks in the UI and what the model sees of it.
 *
 * Unlike the other registries, lookup is not by id: callers hand it a file
 * descriptor and ask which viewer claims it ({@link resolve}). Resolution reads
 * only static MANIFEST data, so picking a viewer never imports a viewer module —
 * a viewer's (possibly heavy) dependencies load only once it has won.
 *
 * Viewers run in both realms: `render()` in the viewer, `extract()` in the
 * engine worker. So — unlike the viewer-only info-card registry — this one is
 * initialised in both.
 * @augments {BaseRegistry<typeof import('juggler/file-viewer').default>}
 */
class FileViewerRegistry extends BaseRegistry {
  constructor() {
    super('FileViewerRegistry', ['id', 'name', 'version', 'description']);
  }

  /**
   * Load the viewers if they are not loaded yet.
   *
   * Unlike the other registries, this one is consulted by *work* (a read tool
   * extracting a file) rather than only by UI built after boot — so a caller
   * can legitimately arrive before `initAllRegistries()` has run, or in a realm
   * that never runs it at all (a test harness). Without this, resolution would
   * quietly find nothing and every file would report "no viewer available",
   * which looks like a verdict rather than a missing registry.
   *
   * Deliberately not `async`: it hands back `init()`'s own promise rather than
   * wrapping it in a second one. A warm registry then settles a caller in one
   * microtask instead of three, and `<file-view>` paints on the tick its mount
   * already assumed.
   * @returns {Promise<void>} Resolves once viewers are loaded
   */
  ensureInitialized() {
    return this.init();
  }

  /**
   * Get file-viewer capability descriptors (implements abstract method).
   * @returns {Promise<import('../services/extensions.js').CapabilityRef[]>} Capability descriptors
   * @protected
   */
  async getModulePaths() {
    return getExtensionCapabilities('file-viewer');
  }

  /**
   * Pick the viewer that should handle a file.
   *
   * Resolution is fully deterministic:
   * 1. Candidates are viewers whose `mimeTypes` or `extensions` match — or that
   *    set `matchAll` — and whose `maxBytes` the file does not exceed.
   * 2. `claims()` returning `false` drops a viewer; returning `true` forces it
   *    in even without a declarative match.
   * 3. Sort by `priority` descending, ties broken by registry precedence
   *    (extension load order, as established by the base registry).
   * 4. First wins. No candidate means the caller renders its "no viewer"
   *    fallback.
   * @param {import('juggler/file-viewer').FileDescriptor} descriptor - File metadata
   * @returns {typeof import('juggler/file-viewer').default|undefined} The winning viewer class, if any
   */
  resolve(descriptor) {
    if (!descriptor) return undefined;
    const mime = (descriptor.mime || '').toLowerCase();
    const ext = extensionOf(descriptor.path || '');

    /** @type {{ViewerClass: typeof import('juggler/file-viewer').default, priority: number, order: number}[]} */
    const candidates = [];
    let order = 0;
    for (const { id, class: ViewerClass } of this.getAll()) {
      const index = order++;
      /** @type {Partial<import('juggler/file-viewer').FileViewerManifest>} */
      const manifest = ViewerClass.MANIFEST || {};

      const declarative =
        !!manifest.matchAll ||
        (Array.isArray(manifest.mimeTypes) && !!mime &&
          manifest.mimeTypes.some((/** @type {string} */ m) => m.toLowerCase() === mime)) ||
        (Array.isArray(manifest.extensions) && !!ext &&
          manifest.extensions.some((/** @type {string} */ e) => e.toLowerCase().replace(/^\./, '') === ext));

      // maxBytes is a hard decline: a viewer that would choke on the file is not
      // a candidate no matter what claims() says, so an oversized file falls
      // through to a lighter viewer or the fallback.
      const withinSize = typeof manifest.maxBytes !== 'number' ||
        (descriptor.size ?? 0) <= manifest.maxBytes;

      let verdict;
      try {
        verdict = typeof ViewerClass.claims === 'function'
          ? ViewerClass.claims(descriptor)
          : undefined;
      } catch (err) {
        // A viewer that throws while deciding must not break resolution for
        // every other viewer — treat it as "no opinion" and surface the bug.
        console.error(`[FileViewerRegistry] claims() threw in viewer "${id}":`, err);
        verdict = undefined;
      }

      if (verdict === false) continue;
      if (!withinSize) continue;
      if (verdict !== true && !declarative) continue;

      candidates.push({
        ViewerClass,
        priority: typeof manifest.priority === 'number' ? manifest.priority : 0,
        order: index,
      });
    }

    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
    return candidates[0]?.ViewerClass;
  }
}

// Create and export singleton registry instance
const fileViewerRegistry = new FileViewerRegistry();

export default fileViewerRegistry;
