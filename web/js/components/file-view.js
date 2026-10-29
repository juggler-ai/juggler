//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import JugglerElement from './juggler-element.js';
import fileViewerRegistry from '../registries/file-viewer-registry.js';
import { toDescriptor } from '../../sdk/file-source.js';
import { formatFileSizeForDisplay, injectFileContentStyles } from '../../sdk/lib/context-item-utils.js';
import { addFilePath } from '../utils/properties-panel-helpers.js';
import { t } from '../../sdk/lib/i18n.js';
import { CODE_REF_PATH_ATTR, CODE_REF_ABSOLUTE_ATTR, isAbsolutePath } from '../utils/code-selection.js';

injectFileContentStyles();

/**
 * `<file-view>` — the host element that turns a
 * {@link import('../../sdk/file-source.js').FileSource} into rendered content.
 *
 * It owns everything the file-shaped context items would otherwise each repeat:
 * the path header with size/line info, the not-found and no-viewer states,
 * viewer resolution, the lazy module import, mounting, and calling the viewer's
 * teardown on disconnect.
 *
 * It is deliberately free of any properties-panel coupling — it is a plain
 * element, so a future full-screen file surface can host the same viewers
 * unchanged.
 * @class
 * @augments JugglerElement
 */
class FileView extends JugglerElement {
  constructor() {
    super();
    /** @type {import('../../sdk/file-source.js').FileSource|null} @private */
    this._source = null;
    /** @type {(() => void)|null} @private */
    this._teardown = null;
    /** @type {AbortController|null} @private */
    this._abort = null;
    /**
     * Incremented on every setSource/render so a slow viewer import that
     * resolves after the element moved on can detect it lost the race and
     * discard its result instead of painting over newer content.
     * @type {number}
     * @private
     */
    this._renderToken = 0;
    /**
     * Whether to render the path header. A host that already shows the path —
     * because it must be there before the source resolves (a live pin's loading
     * state) or because it carries affordances of its own (unpin, live stats) —
     * sets this false rather than letting two headers stack up.
     * @type {boolean}
     */
    this.showPath = true;
    /**
     * The path a reference to a selection in this content should print, when the
     * host knows a better spelling than the source carries. A pin knows the
     * project root and so can name a file relative to it; the source's own path
     * is whatever the server reported, which for a live read is absolute.
     * Empty to use the source's.
     * @type {string}
     */
    this.codeRefPath = '';
    /**
     * Whether {@link codeRefPath} lies outside the project, and so must be
     * printed in full. Ignored when `codeRefPath` is empty.
     * @type {boolean}
     */
    this.codeRefAbsolute = false;
  }

  /**
   * Set the file to display and render it.
   * @param {import('../../sdk/file-source.js').FileSource} source - The file to show
   */
  setSource(source) {
    this._source = source;
    if (this.isConnected) void this.render();
  }

  connectedCallback() {
    if (this._source && !this._teardown) void this.render();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanup();
  }

  /**
   * Tear down the mounted viewer. A viewer that owns a worker, a timer, an
   * observer, or an object URL returns a teardown from render(); failing to run
   * it leaks one of those per panel selection.
   * @private
   */
  _cleanup() {
    this._renderToken++;
    if (this._abort) {
      this._abort.abort();
      this._abort = null;
    }
    if (this._teardown) {
      try {
        this._teardown();
      } catch (err) {
        console.error('[file-view] viewer teardown failed:', err);
      }
      this._teardown = null;
    }
  }

  /**
   * Render the current source: header, then either a terminal state or the
   * resolved viewer's output.
   * @returns {Promise<void>}
   */
  async render() {
    this._cleanup();
    const token = ++this._renderToken;
    const source = this._source;
    this.textContent = '';
    if (!source) return;

    this.className = 'file-content-expanded';

    if (this.showPath) {
      const size = formatFileSizeForDisplay(source.size);
      const info = (source.exists !== false && source.size)
        ? (source.totalLines
          ? t('{size} | {count, plural, one {{count} line} other {{count} lines}}', { size, count: source.totalLines })
          : size)
        : undefined;
      addFilePath(this, source.absPath || source.path || t('No file'), info);
    }

    if (source.exists === false) {
      this._appendState('file-content-not-found', t('File not found: {path}', { path: source.path }));
      return;
    }

    await fileViewerRegistry.ensureInitialized();
    if (token !== this._renderToken) return;

    const ViewerClass = fileViewerRegistry.resolve(toDescriptor(source));
    if (!ViewerClass) {
      // Nothing claimed the file at all, which takes a missing or disabled
      // binary viewer — that one claims everything and describes what it cannot
      // show. Say why the panel is empty rather than leaving it so.
      this._appendState('file-content-warning', source.warning || this._noViewerMessage(source));
      return;
    }

    const host = document.createElement('div');
    host.className = 'file-view-content';
    // Say which file the content below belongs to, so a selection in it can be
    // pasted into the prompt as a reference. Every file surface — pin, read
    // result, write result, dropped file — renders through here, so this is the
    // one place that has to know. Failing a spelling from the host, the source's
    // own path is used, and an absolute one is printed in full because nothing
    // here knows the root it would be relative to.
    const refPath = this.codeRefPath || source.path || source.absPath || '';
    if (refPath) {
      host.setAttribute(CODE_REF_PATH_ATTR, refPath);
      host.toggleAttribute(CODE_REF_ABSOLUTE_ATTR,
        this.codeRefPath ? this.codeRefAbsolute : isAbsolutePath(refPath));
    }
    this.appendChild(host);

    this._abort = new AbortController();
    try {
      const viewer = new (/** @type {any} */ (ViewerClass))();
      const teardown = await viewer.render(source, host, {
        header: this,
        signal: this._abort.signal,
      });
      // A newer setSource (or a disconnect) landed while the viewer was
      // rendering — its teardown is ours to run, but its output is stale.
      if (token !== this._renderToken) {
        if (typeof teardown === 'function') teardown();
        return;
      }
      this._teardown = typeof teardown === 'function' ? teardown : null;
    } catch (err) {
      if (token !== this._renderToken) return;
      console.error('[file-view] viewer render failed:', err);
      host.remove();
      this._appendState('file-content-warning',
        `Could not display this file: ${/** @type {any} */ (err)?.message || err}`);
    }
  }

  /**
   * @param {import('../../sdk/file-source.js').FileSource} source - The unclaimed file
   * @returns {string} Why nothing rendered
   * @private
   */
  _noViewerMessage(source) {
    const kind = source.mime || (source.isBinary ? 'binary' : 'this');
    return `No viewer available for ${kind} content.`;
  }

  /**
   * @param {string} className - State class (warning / not-found)
   * @param {string} message - Message to show
   * @private
   */
  _appendState(className, message) {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = message;
    this.appendChild(el);
  }
}

customElements.define('file-view', FileView);
