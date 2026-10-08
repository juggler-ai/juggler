//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
import { basename } from 'juggler/item-utils';
import { buildPickerPanel, createElement, injectStylesOnce } from 'juggler/ui';
import { stat } from 'juggler/ops';
import { fetchLiveFile, renderLiveFileBody } from '../lib/live-file.js';
import { absoluteFilePinPath, normalizeFilePinParameters } from '../lib/file-pin-config.js';
import { pathPinController } from '../lib/path-pin.js';

injectStylesOnce('file-pin-styles', `
.file-pin {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  height: 100%;
}
.file-pin__note {
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
}
`);

/**
 * How long to wait for a burst of file changes to finish before re-reading. A
 * save from an editor arrives as several events, and re-reading each of them
 * would be several reads to show one file.
 */
const REFRESH_DEBOUNCE_MS = 150;

/**
 * How long a pin showing a missing path waits between checks for it to appear,
 * one entry per check and the last repeated. Front-loaded because the usual
 * reason for the missing state is a race rather than a typo: the agent writes a
 * file and pins it in one turn, the two run in parallel, and the pin reads first.
 */
const ARRIVAL_CHECK_MS = [250, 500, 1000, 2000, 5000];

/**
 * FilePin — a file kept where it can be seen.
 *
 * The board holds the path and nothing else. Every render reads what is on disk
 * now, so the pin is never stale and never carries a copy of anyone's file
 * around in session state. Pinning a file shows it; it does not put it in a
 * conversation's context. The agent may request that a file be shown, but the
 * board remains a one-way display surface rather than agent-readable context.
 *
 * Pin reads are treated as display-initiated rather than model context reads. That
 * remains true when the agent requested the pin: the bytes go only to the viewer,
 * and the agent has no board-reading path. A pin may therefore point outside the
 * project root, the same way a user-picked file or an `@`-mention may.
 * @class
 * @augments PinboardItemType
 */
class FilePin extends PinboardItemType {
  /** @type {import('juggler/pinboard-item-type').PinboardItemManifest} */
  static MANIFEST = {
    id: 'file',
    name: 'File',
    version: '1.0.0',
    description: 'Keeps a live file within reach',
    instances: 'multiple',
    // The one type that shows whatever the user names rather than something the
    // conversation already has, so it leads the add picker and says in the row
    // that choosing it asks a question. "View" is the load-bearing word: a pin is
    // somewhere to watch a file, and naming one here does not put it in front of
    // the agent.
    addLabel: 'Add a file to view…',
    order: -1,
    // This pin takes any file at all, so it is the answer only where nothing more
    // specific wants the path — a patch, a notebook, a diagram. Being asked last
    // is what lets a type built for one suffix have its say despite loading after
    // everything in the box.
    sourceFallback: true,
  };

  /**
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {true|string} True when a project is open.
   */
  canAdd(active) {
    return active?.project?.path ? true : 'No project';
  }

  /**
   * Ask which file. The same picker the file-content item uses, so "add a file"
   * means one thing wherever it is asked.
   * @param {{active: import('juggler/pinboard-item-type').PinActiveContext, initialConfig?: Record<string, any>, signal: AbortSignal}} options - The request.
   * @returns {Promise<Record<string, any>|null>} The config, or null if cancelled.
   */
  async configure(options) {
    const overlay = document.createElement('div');
    overlay.className = 'pp-overlay';
    document.body.appendChild(overlay);

    const { element, promise, cancel } = buildPickerPanel({
      title: 'Add a file to view',
      // A folder is as pinnable as a file — a trailing slash names one, and the
      // pin shows its tree — so the prompt says both rather than only the common
      // half.
      placeholder: 'File or folder path…',
      dirsOnly: false,
      confirmLabel: 'Add',
      showCancel: true,
      // Almost every file worth watching is in the open project, and without
      // this the native chooser opens wherever the app last was.
      startDir: options.active?.project?.path || '',
    });
    overlay.appendChild(element);

    /** @param {KeyboardEvent} e - The keydown. */
    const onKeydown = (e) => { if (e.key === 'Escape') cancel(); };
    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
    options.signal?.addEventListener('abort', () => cancel(), { once: true });

    const chosen = await promise;
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
    if (!chosen) return null;

    // Stored absolute, so the same file pinned from the picker and from a
    // properties panel is one pin rather than two spellings of one.
    return normalizeFilePinParameters({
      path: absoluteFilePinPath({ path: chosen }, options.active),
      isDirectory: chosen.endsWith('/'),
    });
  }

  /**
   * @param {Record<string, any>} config - The stored or supplied config.
   * @returns {Record<string, any>|null} The normalized config, or null to reject it.
   */
  normalizeConfig(config) {
    return normalizeFilePinParameters(config);
  }

  /**
   * Two pins name the same file when their paths do. Both configs are already
   * normalized, so this is a string comparison and deliberately nothing cleverer:
   * resolving symlinks or case-folding would need the filesystem, and
   * `isSameConfig` is asked before anything is read. A path a source arrived with
   * relative is kept that way and resolved at read time, so the same file pinned
   * from a relative link and from an absolute path is two pins — two spellings
   * are told apart, never the wrong file shown.
   * @param {Record<string, any>} a - One config.
   * @param {Record<string, any>} b - The other.
   * @returns {boolean} True when they name the same path.
   */
  isSameConfig(a, b) {
    return (a?.path || '') === (b?.path || '');
  }

  /**
   * The tab is named for the file; the toolbar is the path itself, which the
   * host draws along with the controls that act on it. The name above the path
   * said the same thing twice, and the tab was already saying the short half.
   * @param {Record<string, any>} config - The pin's config.
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {import('juggler/pinboard-item-type').PinDescription} The tab's word and the file.
   */
  describe(config, active) {
    const path = config?.path || '';
    if (!path) return { title: this.name };
    const name = basename(path) || path;
    return {
      title: config.isDirectory ? `${name}/` : name,
      path: absoluteFilePinPath(config, active),
    };
  }

  /**
   * @param {import('juggler/pinboard-item-type').PinSource} source - The source to pin.
   * @returns {boolean} True for a live file.
   */
  static canPinSource(source) {
    if (source?.kind !== 'file') return false;
    // A snapshot is a different promise from the one this pin makes, and making
    // it quietly would be worse than declining it.
    if (source.presentation && source.presentation !== 'live') return false;
    return typeof source.path === 'string' && source.path.trim() !== '';
  }

  /**
   * @param {import('juggler/pinboard-item-type').PinSource} source - The source to pin.
   * @returns {Record<string, any>|null} The config, or null if the path was unusable.
   */
  static configFromSource(source) {
    return normalizeFilePinParameters(/** @type {Record<string, any>} */ (source));
  }

  /**
   * Show the file, and keep showing it: a change to it on disk re-reads, and so
   * does `Refresh` for the changes the watcher cannot see. A path with nothing at
   * it is checked again until something arrives, because the watcher cannot see
   * every path.
   * @param {HTMLElement} container - The body to fill.
   * @param {import('juggler/pinboard-item-type').PinContext} pinContext - The pin and its context.
   * @returns {import('juggler/pinboard-item-type').PinController} The controller.
   */
  mount(container, pinContext) {
    let context = pinContext;

    const body = createElement('div', 'file-pin');
    container.replaceChildren(body);

    // Only the newest read may draw: a refresh can overtake the read it replaced.
    let generation = 0;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let pending;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let arrivalCheck;

    /**
     * Keep checking for a path that was not there. The watcher reports a file
     * appearing only inside the project, outside dot-directories and gitignored
     * ones, so for a pin in the missing state this check is how the file showing
     * up gets noticed. It checks only while the pin can be seen, uses a stat
     * rather than a read, and stops at the first render, change of path or
     * teardown.
     *
     * A failed read did not necessarily find nothing there; it may have been
     * refused. In that case the check is only kept up once a stat agrees the path
     * is missing, so a file that exists but cannot be read is not re-read
     * forever.
     * @param {number} mine - The render generation that found the path missing.
     * @param {boolean} knownMissing - Whether that render established the path is missing.
     */
    const awaitArrival = (mine, knownMissing) => {
      let step = 0;
      let missing = knownMissing;
      const next = () => {
        arrivalCheck = setTimeout(async () => {
          if (mine !== generation || context.signal.aborted) return;
          if (!container.isConnected || !container.checkVisibility()) {
            next();
            return;
          }
          /** @type {boolean|null} */
          let present = null;
          try {
            const metadata = await stat({
              path: absoluteFilePinPath(context.pin.config, context.active),
              userInitiated: true,
            });
            present = metadata.exists !== false;
          } catch {
            // Not a missing path: whatever refused the stat will refuse the read.
          }
          if (mine !== generation || context.signal.aborted || present === null) return;
          if (!present) {
            missing = true;
            next();
          } else if (missing) {
            void render();
          }
        }, ARRIVAL_CHECK_MS[Math.min(step++, ARRIVAL_CHECK_MS.length - 1)]);
      };
      next();
    };

    const render = async () => {
      clearTimeout(arrivalCheck);
      const mine = ++generation;
      const path = absoluteFilePinPath(context.pin.config, context.active);
      // Say which file the body below belongs to, so selecting part of it can be
      // pasted into the prompt as a reference rather than as loose text. A pin
      // may point anywhere, so a file outside the project says so and is named
      // in full.
      //
      // Rendered file content carries its own, nearer, mark from `<file-view>`,
      // which wins the `closest()` walk up from the selection. This one is what
      // covers the bodies that never reach a viewer: a directory listing and the
      // not-found state.
      const relative = projectRelative(path, context.active?.project?.path || '');
      body.setAttribute('data-code-ref-path', relative || path);
      body.toggleAttribute('data-code-ref-absolute', !relative);
      body.replaceChildren(createElement('div', 'file-content-loading', 'Loading…'));

      const result = await fetchLiveFile(path, {
        signal: context.signal,
        whole: true,
      });
      if (mine !== generation || context.signal.aborted) return;

      renderLiveFileBody(body, result, {
        absolutePath: path,
        conversationId: context.active?.conversation?.id,
        codeRefPath: relative || path,
        codeRefAbsolute: !relative,
      });
      if (!result.exists) awaitArrival(mine, !result.error);

      // The pin asks for the whole file, so this only speaks up when the read
      // op cut the file short anyway — over the size a read will return at all.
      const shown = result.lineCount || 0;
      const total = result.totalLines || 0;
      if (!result.isDirectory && shown && total > shown) {
        body.appendChild(createElement('div', 'file-pin__note',
          `First ${shown} lines of ${total}.`));
      }
    };

    const refresh = () => {
      clearTimeout(pending);
      pending = setTimeout(() => { void render(); }, REFRESH_DEBOUNCE_MS);
    };

    const stopWatching = context.services.files.onChange((changes) => {
      const target = absoluteFilePinPath(context.pin.config, context.active);
      if (changes.some((change) => touches(change.path, target, context.pin.config.isDirectory === true))) {
        refresh();
      }
    });

    void render();

    return pathPinController({
      getContext: () => context,
      setContext: (next) => { context = next; },
      targetOf: (c) => absoluteFilePinPath(c.pin.config, c.active),
      render,
      teardown: () => {
        clearTimeout(pending);
        clearTimeout(arrivalCheck);
        stopWatching();
      },
    });
  }
}

/**
 * A path rewritten relative to the project root, or '' when it lies outside it.
 * Either separator is accepted and the result is spelled with forward slashes,
 * because the backend reports native paths and a reference is read by a model
 * that was told the project in one spelling.
 * @param {string} path - The absolute path.
 * @param {string} project - The project root.
 * @returns {string} The relative path, or '' when the file is not under it.
 */
function projectRelative(path, project) {
  if (!path || !project || !path.startsWith(project)) return '';
  const rest = path.slice(project.length);
  if (!/^[/\\]/.test(rest)) return '';
  return rest.replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

/**
 * Whether a changed path is one this pin is showing: the file itself, or anything
 * under it when the pin is a directory listing.
 * @param {string} changed - The absolute path that changed.
 * @param {string} target - The pin's absolute path.
 * @param {boolean} isDirectory - Whether the pin shows a directory.
 * @returns {boolean} True when the pin should re-read.
 */
function touches(changed, target, isDirectory) {
  if (!changed || !target) return false;
  if (changed === target) return true;
  return isDirectory && changed.startsWith(`${target}/`);
}

export default FilePin;
