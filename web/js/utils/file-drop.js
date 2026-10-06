//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shared plumbing for dropping files into the app: the two questions every drop
 * zone asks of a drag, and the document-level guard that stands behind all of
 * them.
 *
 * A zone is any element that cancels `dragover` for a file drag. There is no
 * registry — the guard reads `defaultPrevented` instead, so it stays correct
 * for zones it has never heard of.
 * @module utils/file-drop
 */

/**
 * Whether a drag is carrying files (as opposed to dragged text, a selection, or
 * an internal drag). `types` is the only thing readable during a drag: the
 * `files` list itself is empty until the drop.
 * @param {DataTransfer|null|undefined} dataTransfer - The drag's payload.
 * @returns {boolean} True when the drag carries files.
 */
export function isFileDrag(dataTransfer) {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types || []).includes('Files');
}

/**
 * Split files by how they are staged: images upload to the asset store as
 * bytes, and everything else is inlined as a text snapshot. A mixed set —
 * dropped or picked — therefore has to be routed one kind at a time.
 * @param {FileList|File[]|null|undefined} fileList - The files to stage.
 * @returns {{images: File[], texts: File[]}} The files, split by kind.
 */
export function splitFiles(fileList) {
  const files = Array.from(fileList || []);
  return {
    images: files.filter((f) => f.type.startsWith('image/')),
    texts: files.filter((f) => !f.type.startsWith('image/')),
  };
}

/**
 * Elements whose own drop handling must be left alone. A file input accepts a
 * drop through the browser's default action, which the guard below otherwise
 * cancels.
 */
const NATIVE_DROP_TARGETS = 'input[type="file"]';

/**
 * The mark a zone leaves on a `dragover` it has accepted.
 *
 * `defaultPrevented` cannot answer this: Wails' `<html>` handler cancels every
 * file drag of its own accord (see {@link installFileDropGuard}), so in the
 * desktop app the flag is already set by the time any of this runs.
 */
const ACCEPTED = Symbol('file-drop-accepted');

/**
 * Declare that this zone will take the drag — call it alongside
 * `preventDefault()` in a `dragover` handler.
 * @param {Event} event - The `dragover` event being accepted.
 * @returns {void}
 */
export function markFileDropAccepted(event) {
  /** @type {any} */ (event)[ACCEPTED] = true;
}

/**
 * @param {Event} event - A `dragover` event.
 * @returns {boolean} True when a zone has accepted this drag.
 */
function isFileDropAccepted(event) {
  return /** @type {any} */ (event)[ACCEPTED] === true;
}

/** Whether {@link installFileDropGuard} has already run for this document. */
let guardInstalled = false;

/**
 * Install the document-level guard behind every file drop zone. Idempotent, so
 * each zone can call it on mount.
 *
 * It does two jobs, both of which have to happen after every other handler in
 * the page — hence `document`, which bubbles last:
 *
 * 1. **Re-assert `copy` over a zone.** Wails' injected runtime installs a
 *    `dragover` handler on `<html>` that cancels every file drag and force-sets
 *    `dropEffect = 'none'` whenever the window's `enableFileDrop` flag is off —
 *    which Juggler deliberately leaves off so WebKit delivers real `File`
 *    objects to the page rather than routing drops through the native bridge
 *    (see `cmd/juggler-app/app_state.go`). `<html>` is above every zone in the
 *    bubble path, so without this the drop is cancelled after the fact: the
 *    `drop` event never fires and the file is silently swallowed. Zones name
 *    themselves with {@link markFileDropAccepted}, since that runtime handler
 *    leaves `defaultPrevented` set on drags nobody wants.
 * 2. **Never navigate away.** A file dropped anywhere the app doesn't handle is
 *    a navigation: the browser opens it, replacing the running app. Cancelling
 *    the drag everywhere else costs a "no drop" cursor and saves the session.
 * @returns {void}
 */
export function installFileDropGuard() {
  if (guardInstalled) return;
  guardInstalled = true;

  document.addEventListener('dragover', (e) => {
    const dt = /** @type {DragEvent} */ (e).dataTransfer;
    if (!isFileDrag(dt) || !dt) return;
    if (e.target instanceof HTMLElement && e.target.closest(NATIVE_DROP_TARGETS)) return;
    if (isFileDropAccepted(e)) {
      dt.dropEffect = 'copy';
      return;
    }
    e.preventDefault();
    dt.dropEffect = 'none';
  });

  document.addEventListener('drop', (e) => {
    const dt = /** @type {DragEvent} */ (e).dataTransfer;
    if (!isFileDrag(dt)) return;
    // A zone that took the files cancelled the event itself. (In the desktop
    // app Wails has cancelled it either way, and has already stopped the
    // navigation this guards against.)
    if (e.defaultPrevented) return;
    if (e.target instanceof HTMLElement && e.target.closest(NATIVE_DROP_TARGETS)) return;
    e.preventDefault();
  });
}
