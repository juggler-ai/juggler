//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
// The project's tree, by definition: a pin belongs to the project's board and
// has no conversation, hence no workspace, to scope by.
// eslint-disable-next-line no-restricted-imports
import { expandDirectory, openPath } from 'juggler/ops';
import { translator } from 'juggler/i18n';
import { createElement, createFileActions, errorText, injectStylesOnce, pinFile } from 'juggler/ui';
import { debounce } from 'juggler/utils/debounce';
import { reconcileRows, setText } from '../lib/reconcile.js';
import { pinEmpty } from '../lib/pin-empty.js';

const t = translator('@juggler/core');

injectStylesOnce('project-files-pin-styles', `
.project-files-pin {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  height: 100%;
}
.project-files-pin__list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
}
.project-files-pin__row {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.375rem;
  /* The shared file buttons are 1.5rem tall, which is taller than this row's
     line box. Without a floor sized to hold them, the row a reader points at
     grows and shunts every row below it down — so the space is always there and
     the buttons drop into it. */
  min-height: 1.625rem;
  padding-right: 0.25rem;
  border-radius: var(--radius-md);
  line-height: 1.7;
  /* Every row answers a click — a folder opens, a file is selected and pins on a
     second — so every row says so under the pointer. */
  cursor: pointer;
}
.project-files-pin__row:hover {
  background: color-mix(in srgb, var(--text-primary) 5%, transparent);
}
.project-files-pin__row:focus-visible {
  outline-offset: calc(-1 * var(--focus-ring-width));
}
/* Drawn rather than written: a glyph would be at the mercy of whichever font the
   platform has, and this one only ever has to be a triangle that turns. A file
   keeps the space so that names down a level line up with their siblings. */
.project-files-pin__caret {
  flex-shrink: 0;
  width: 0.4375rem;
  height: 0.4375rem;
  background: var(--text-tertiary);
  clip-path: polygon(0 0, 100% 50%, 0 100%);
  transition: transform var(--transition-base, 0.15s ease);
  visibility: hidden;
}
.project-files-pin__row.is-dir .project-files-pin__caret {
  visibility: visible;
}
.project-files-pin__row[aria-expanded="true"] .project-files-pin__caret {
  transform: rotate(90deg);
}
.project-files-pin__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-files-pin__row.is-dir .project-files-pin__name {
  font-weight: 500;
}
/* The resting tree is names and carets. Everything a row can do to its file is
   one hover or one Tab away, and takes no width until then. */
.project-files-pin__actions {
  display: none;
  flex-shrink: 0;
}
.project-files-pin__row:hover .project-files-pin__actions,
.project-files-pin__row:focus-within .project-files-pin__actions {
  display: flex;
}
.project-files-pin__note {
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
  line-height: 1.7;
}
.project-files-pin__status {
  flex-shrink: 0;
  padding: 0.25rem 0.375rem;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}
`);

/**
 * How long to wait for a burst of file changes to finish before re-reading. A
 * save from an editor arrives as several events, and re-reading a directory once
 * per event would be several reads to show one file.
 */
const REFRESH_DEBOUNCE_MS = 150;

/**
 * The longest a burst may hold those reads off. A build or a checkout writing
 * into an open folder reports changes closer together than the settling time
 * for as long as it runs, and the tree should follow it, a second behind.
 */
const REFRESH_MAX_WAIT_MS = 1000;

/**
 * How long a folder may take to open before the tree admits it is reading.
 *
 * A local directory comes back in about a millisecond, so a row saying so
 * appears and is gone inside one frame — read as a flicker rather than as
 * information, and it moves every row beneath it twice on the way. Below this,
 * an opening folder simply has no children yet; above it, the wait is long
 * enough to be worth explaining.
 */
const LOADING_GRACE_MS = 200;

/** How far each level is indented, in rem. */
const INDENT_REM = 0.75;

/**
 * One line of the flattened tree. Directories and files are `item` rows; a
 * directory that is open but has nothing to show contributes a `note` row in
 * their place, so an empty folder and a folder still being read are told apart
 * rather than both reading as a folder with no contents.
 * @typedef {object} TreeRow
 * @property {'item'|'note'} kind - Whether it stands for a path or speaks for one.
 * @property {string} key - Its identity in the list.
 * @property {number} depth - How many levels below the root it sits.
 * @property {string} [path] - The absolute path, for an item row.
 * @property {string} [name] - Its last segment, for an item row.
 * @property {boolean} [isDir] - Whether it is a directory, for an item row.
 * @property {string} [text] - What it says, for a note row.
 */

/**
 * What one directory read came back with.
 * @typedef {object} DirState
 * @property {{name: string, isDir: boolean, path: string}[]|null} items - Its
 *   contents, sorted, or null when the read has not landed or did not succeed.
 * @property {string} error - Why there are no contents, or ''.
 * @property {boolean} loading - Whether a read is in flight.
 * @property {boolean} slow - Whether that read has been going long enough to say so.
 * @property {symbol|null} token - The read whose answer this entry will accept.
 */

/**
 * The separator a path is already spelled with. `expandDirectory` forward-slashes
 * the paths it returns, which would give a Windows child a different spelling
 * from its parent — and these paths are compared against the watcher's and handed
 * to the OS, so one spelling has to win. The root's is the one that does.
 * @param {string} path - Any path.
 * @returns {string} '\\' on a Windows-style path, '/' otherwise.
 */
function separator(path) {
  return path.includes('\\') ? '\\' : '/';
}

/**
 * Write an attribute only when it differs, the counterpart to `setText` for the
 * things a row says about itself rather than shows. Pass null to remove it.
 * @param {HTMLElement} el - The element.
 * @param {string} name - The attribute.
 * @param {string|null} value - What it should be, or null for absent.
 * @returns {void}
 */
function setAttr(el, name, value) {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * @param {string} dir - The parent directory.
 * @param {string} name - A child's name.
 * @returns {string} The child's absolute path, in the parent's spelling.
 */
function childPath(dir, name) {
  const sep = separator(dir);
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/**
 * One remembered folder, as it is written down: relative to the project root and
 * forward-slashed, whatever the platform spells paths with.
 *
 * Relative because the board outlives the path — a project checked out somewhere
 * else, or a repository moved, is the same tree to the person reading it, and a
 * remembered absolute path would name nothing. Forward-slashed because the same
 * session state is read on every platform.
 * @param {any} value - A stored entry, of no trustworthy type.
 * @returns {string} The cleaned relative path, or '' if it is not usable as one.
 */
function cleanRelative(value) {
  if (typeof value !== 'string') return '';
  const parts = value.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  // A remembered folder is somewhere inside the project. One that climbs out of
  // it is not a folder this pin ever offered, so it is dropped rather than
  // resolved into whatever it would point at now.
  if (parts.length === 0 || parts.includes('..')) return '';
  return parts.join('/');
}

/**
 * @param {string} path - Any path.
 * @returns {string} The directory holding it, or '' when it has no parent here.
 */
function parentDir(path) {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at <= 0 ? '' : path.slice(0, at);
}

/**
 * A directory's contents in the order a tree shows them: folders first, then
 * files, each alphabetically. The op returns them in `os.ReadDir` order, which is
 * name-sorted but interleaves the two — and it names each child relative to
 * whatever was passed in, so the absolute path is built here rather than trusted.
 * @param {any[]} items - What `expandDirectory` returned, possibly nothing.
 * @param {string} dir - The absolute directory they are in.
 * @returns {{name: string, isDir: boolean, path: string}[]} The sorted contents.
 */
function sortItems(items, dir) {
  return (items || [])
    .map((item) => ({
      name: String(item?.name ?? ''),
      isDir: item?.isDir === true,
      path: childPath(dir, String(item?.name ?? '')),
    }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1)));
}

/**
 * The open tree, flattened into the lines it draws as.
 *
 * Flat rather than nested on purpose: the list is reconciled against its previous
 * self by key, and stepping through it with the arrow keys is walking an array.
 * Nested containers would make both of those a recursion for no gain, since
 * indentation is a `padding-left` either way.
 * @param {string} root - The project root.
 * @param {Set<string>} expanded - Which directories are open.
 * @param {Map<string, DirState>} entries - What has been read.
 * @returns {TreeRow[]} The visible lines, in order.
 */
function visibleRows(root, expanded, entries) {
  /** @type {TreeRow[]} */
  const rows = [];

  /**
   * @param {string} dir - The directory to lay out.
   * @param {number} depth - Its children's depth.
   * @returns {void}
   */
  const walk = (dir, depth) => {
    const state = entries.get(dir);
    if (!state) return;
    // The key is prefixed with the directory so two folders reading at once do
    // not share one row, and with a NUL so it can never collide with a real path.
    if (state.error) {
      rows.push({ kind: 'note', key: `${dir}\u0000error`, depth, text: state.error });
      return;
    }
    if (!state.items) {
      // A folder that is merely opening contributes nothing. Saying "Reading…"
      // for the millisecond a local directory takes is a flicker, not news.
      if (state.slow) rows.push({ kind: 'note', key: `${dir}\u0000loading`, depth, text: t('Reading…') });
      return;
    }
    if (state.items.length === 0) {
      rows.push({ kind: 'note', key: `${dir}\u0000empty`, depth, text: t('Empty') });
      return;
    }
    for (const item of state.items) {
      rows.push({ kind: 'item', key: item.path, depth, path: item.path, name: item.name, isDir: item.isDir });
      if (item.isDir && expanded.has(item.path)) walk(item.path, depth + 1);
    }
  };

  walk(root, 0);
  return rows;
}

/**
 * ProjectFilesPin — the project's files, as a tree.
 *
 * One directory is read at a time, when it is opened, and never before: a project
 * is a great many files, and a tree that read them all to draw its first ten rows
 * would be paying for the whole repository to show the top of it. A folder nobody
 * opens costs one row and no read.
 *
 * It shows what is on disk, all of it. The op behind it resolves within the
 * project and does no gitignore or dot-file filtering, so `.git` and
 * `node_modules` appear here even though the agent's own view of the tree hides
 * them. That is the honest reading of "the project's files", and unopened they
 * are a row each.
 *
 * Which folders are open is the pin's config, so it survives a switch to another
 * tab and back, a reload, and a restart. It is kept relative to the project root
 * — the tree is of a project, not of a location, and one checked out somewhere
 * else is the same tree to the person reading it.
 *
 * Read-only, like every pin: the rows offer the same open, copy, reveal and pin
 * controls a path is offered anywhere else in the app, and nothing here puts a
 * file into anyone's context.
 * @class
 * @augments PinboardItemType
 */
class ProjectFilesPin extends PinboardItemType {
  /** @type {import('juggler/pinboard-item-type').PinboardItemManifest} */
  static MANIFEST = {
    id: 'project-files',
    name: 'Project files',
    version: '1.0.0',
    description: "The project's files, as a tree",
    // One project, so one tree. A second would be the same tree twice.
    instances: 'single',
    order: 10,
  };

  /**
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {true|string} True when a project is open.
   */
  canAdd(active) {
    return active?.project?.path ? true : t('No project');
  }

  /**
   * Which folders were open, and nothing else.
   *
   * This is the pin's whole state, and it is kept because a tree that forgets
   * where you were is a tree you have to find your way down again every time you
   * look at another tab. Everything here has been sitting in session state since
   * some earlier version of this pin, so it is treated as a stranger's input:
   * anything unusable is dropped and the rest is kept, never thrown for.
   * @param {Record<string, any>} config - The stored or supplied config.
   * @returns {Record<string, any>} The normalized config.
   */
  normalizeConfig(config) {
    const stored = Array.isArray(config?.expanded) ? config.expanded : [];
    // Sorted so that two boards in the same state hold the same config, and a
    // save whose only difference is the order folders were opened in is not a
    // change at all.
    return { expanded: [...new Set(stored.map(cleanRelative).filter(Boolean))].sort() };
  }

  /**
   * There is one project, so there is one tree of it. Two of these pins are the
   * same pin however differently each has been opened up.
   * @returns {boolean} Always true.
   */
  isSameConfig() {
    return true;
  }

  /**
   * The name, and the root the tree is of. Naming the project on the tab would
   * be answering a question the whole board shares — every pin on it reads the
   * same project — but the toolbar showing the root path is worth having, and
   * with it the host draws the controls that act on that folder, so the pin
   * offers none of its own.
   * @param {Record<string, any>} config - The pin's config, which is empty.
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {import('juggler/pinboard-item-type').PinDescription} The tab's words and the root.
   */
  describe(config, active) {
    const root = active?.project?.path || '';
    // The name in English: the host translates a title equal to it, in this
    // extension's catalogue.
    return root ? { title: this.name, path: root } : { title: this.name };
  }

  /**
   * @param {HTMLElement} container - The body to fill.
   * @param {import('juggler/pinboard-item-type').PinContext} pinContext - The pin and its context.
   * @returns {import('juggler/pinboard-item-type').PinController} The controller.
   */
  mount(container, pinContext) {
    let context = pinContext;
    let root = context.active?.project?.path || '';

    const body = createElement('div', 'project-files-pin');
    const list = createElement('div', 'project-files-pin__list');
    list.setAttribute('role', 'tree');
    list.setAttribute('aria-label', t('Project files'));
    const status = createElement('div', 'project-files-pin__status');
    container.replaceChildren(body);

    /**
     * Which directories are open, by absolute path — mirrored into the pin's
     * config, relative, so switching tabs and coming back finds the tree as it
     * was left rather than shut.
     * @type {Set<string>}
     */
    const expanded = new Set();

    /**
     * @param {string} relative - A remembered folder.
     * @returns {string} Where it is now.
     */
    const toAbsolute = (relative) => childPath(root, relative.split('/').join(separator(root)));

    /**
     * @param {string} absolute - A folder on screen.
     * @returns {string} How to write it down, or '' if it is not under the root.
     */
    const toRelative = (absolute) => {
      const sep = separator(root);
      const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
      return absolute.startsWith(prefix) ? cleanRelative(absolute.slice(prefix.length)) : '';
    };

    /** @type {Map<string, DirState>} */
    const entries = new Map();

    /** @type {TreeRow[]} */
    let rows = [];
    /** The row the arrow keys are on, by path. */
    let activePath = '';
    /** The last thing that went wrong where there was no row to say so on. */
    let statusText = '';
    /** Bumped when every read in flight is answering a question nobody is asking. */
    let generation = 0;
    /** @type {Set<string>} */
    const pendingDirs = new Set();

    /**
     * Write down where the reader has got to.
     *
     * Written the moment a folder is opened, and deliberately not debounced.
     * Switching tabs tears this pin down, so any wait at all is a window in
     * which the last thing the reader did is the one thing that does not come
     * back — which is the whole failure this exists to prevent. Never awaited by
     * anything on screen: the tree has already opened, and a save that fails
     * costs a place next time rather than anything visible now.
     * @returns {void}
     */
    const persist = () => {
      void context.updateConfig({ expanded: [...expanded].map(toRelative).filter(Boolean).sort() });
    };

    /**
     * Read one directory, and draw whatever came back.
     *
     * Two ways an answer can arrive too late, and both discard it rather than
     * overwrite what replaced it: the whole tree may have been refreshed since
     * (`generation`), or this same directory may have been asked again
     * (`token`) — which a file change under an open folder does readily.
     * @param {string} dir - The absolute directory to read.
     * @returns {Promise<void>} When it has been drawn, or discarded.
     */
    const readDirectory = async (dir) => {
      const gen = generation;
      const token = Symbol('read');
      const previous = entries.get(dir);
      entries.set(dir, {
        items: previous?.items ?? null,
        error: previous?.error ?? '',
        loading: true,
        slow: false,
        token,
      });

      // Only a read that outlasts the grace period ever says it is reading, and
      // it has to come back and ask to be drawn again to do it.
      const admit = setTimeout(() => {
        const state = entries.get(dir);
        if (gen !== generation || context.signal.aborted) return;
        if (state?.token !== token || !state.loading) return;
        entries.set(dir, { ...state, slow: true });
        render();
      }, LOADING_GRACE_MS);

      /** @param {DirState} next - What the read settled on. */
      const settle = (next) => {
        clearTimeout(admit);
        if (gen !== generation || context.signal.aborted) return;
        if (entries.get(dir)?.token !== token) return;
        entries.set(dir, next);
        render();
      };

      try {
        const result = await expandDirectory({ path: dir });
        settle({ items: sortItems(result?.items, dir), error: '', loading: false, slow: false, token });
      } catch (err) {
        // The op's own words are the only account of which of the many reasons
        // this was — gone, unreadable, outside what the project may see — so the
        // plain-English lead goes above it rather than in place of it.
        settle({
          items: null,
          error: t("Couldn't read this folder. {error}", { error: errorText(err) }),
          loading: false,
          slow: false,
          token,
        });
      }
    };

    /**
     * @param {string} path - The directory to open or close.
     * @returns {void}
     */
    const toggle = (path) => {
      if (!expanded.delete(path)) {
        expanded.add(path);
        if (!entries.has(path)) void readDirectory(path);
      }
      persist();
      render();
    };

    /**
     * @param {string} path - The file to hand to the OS.
     * @returns {Promise<void>} When it opened, or said why not.
     */
    const openFile = async (path) => {
      try {
        await openPath({ path });
        statusText = '';
      } catch (err) {
        statusText = t("Couldn't open that file. {error}", { error: errorText(err) });
      }
      render();
    };

    /**
     * @param {string} path - The row's path.
     * @param {boolean} isDir - Whether it is a directory.
     * @returns {void}
     */
    const activate = (path, isDir) => {
      if (isDir) toggle(path);
      else void openFile(path);
    };

    /**
     * The row standing for a path right now, or null when it is not on screen.
     * @param {string} path - The path.
     * @returns {HTMLElement|null} Its row.
     */
    const rowFor = (path) => {
      for (const child of Array.from(list.children)) {
        const el = /** @type {HTMLElement} */ (child);
        if (el.dataset.rowKey === path) return el;
      }
      return null;
    };

    /**
     * A row's controls, built the first time it is pointed at or tabbed to.
     *
     * Never up front: each group instantiates a `reveal-button` element and asks
     * the board whether the file can be pinned, and a tree of three hundred rows
     * would pay that three hundred times over to serve the one row under the
     * pointer.
     * @param {HTMLElement} row - The row.
     * @param {string} path - Its absolute path.
     * @returns {void}
     */
    const ensureActions = (row, path) => {
      const slot = /** @type {HTMLElement|null} */ (row.querySelector('.project-files-pin__actions'));
      if (!slot || slot.firstChild) return;
      // The shared group, not a local imitation: opening a file, copying its
      // path, revealing it where it lives and pinning it mean the same thing here
      // as on every other surface that shows a path.
      const actions = createFileActions(path, { pin: path });
      if (actions) slot.appendChild(actions);
    };

    /**
     * The fixed half of a row — everything true of it for as long as it stands
     * for that path, which is what the key guarantees.
     * @param {TreeRow} entry - The line to build for.
     * @returns {HTMLElement} The row.
     */
    const build = (entry) => {
      if (entry.kind !== 'item') return createElement('div', 'project-files-pin__note');

      const path = entry.path || '';
      const row = createElement('div', 'project-files-pin__row');
      row.setAttribute('role', 'treeitem');
      row.tabIndex = -1;
      // The app's right-click menu offers Open, Reveal, Copy path and Pin to
      // anything naming a file, so a row is one you can act on however you got
      // to it.
      row.dataset.filePath = path;

      const caret = createElement('span', 'project-files-pin__caret');
      caret.setAttribute('aria-hidden', 'true');
      row.appendChild(caret);
      row.appendChild(createElement('span', 'project-files-pin__name'));
      row.appendChild(createElement('span', 'project-files-pin__actions'));

      row.addEventListener('pointerenter', () => ensureActions(row, path));
      row.addEventListener('focusin', () => ensureActions(row, path));
      row.addEventListener('click', (event) => {
        // A click on this row's own controls is that control's, not the row's.
        if (/** @type {HTMLElement} */ (event.target).closest('.project-files-pin__actions')) return;
        // A click opens a folder and selects a file. It deliberately does not
        // hand the file to the OS: a single click that launches an application
        // is a click nobody meant, and the row's own Open button is right there
        // for the reader who did mean it.
        if (row.dataset.dir === '1') toggle(path);
        moveTo(path);
      });
      row.addEventListener('dblclick', (event) => {
        if (/** @type {HTMLElement} */ (event.target).closest('.project-files-pin__actions')) return;
        // A folder's clicks are its own: each one opens or closes it, and a
        // reader who double-clicks one meant to open it, not to pin it. A file
        // has nothing a second click could mean instead, so it means the thing
        // the row's own Pin button means.
        if (row.dataset.dir === '1') return;
        void pinFile(path);
      });
      return row;
    };

    /**
     * @param {HTMLElement} el - The row for this line.
     * @param {TreeRow} entry - The line.
     * @returns {void}
     */
    const fill = (el, entry) => {
      // Every write here is guarded, for the reason `setText` is: a render can
      // be provoked several times a second, and an assignment that changes
      // nothing still costs the row a style invalidation.
      setAttr(el, 'style', `padding-left: ${0.375 + entry.depth * INDENT_REM}rem`);
      if (entry.kind !== 'item') {
        setText(el, entry.text || '');
        return;
      }
      const isDir = entry.isDir === true;
      const open = isDir && expanded.has(entry.path || '');
      el.classList.toggle('is-dir', isDir);
      if (el.dataset.dir !== (isDir ? '1' : '')) el.dataset.dir = isDir ? '1' : '';
      setAttr(el, 'aria-level', String(entry.depth + 1));
      setAttr(el, 'aria-expanded', isDir ? (open ? 'true' : 'false') : null);
      // One stop on the way in, not one per file: Tab reaches the tree, and the
      // arrows move within it.
      const tab = entry.path === activePath ? 0 : -1;
      if (el.tabIndex !== tab) el.tabIndex = tab;
      setText(/** @type {HTMLElement} */ (el.querySelector('.project-files-pin__name')), entry.name || '');
    };

    const render = () => {
      rows = root ? visibleRows(root, expanded, entries) : [];
      const items = rows.filter((row) => row.kind === 'item');
      // The active row may have been collapsed away or deleted since it was set.
      if (!items.some((row) => row.path === activePath)) activePath = items[0]?.path || '';

      reconcileRows(list, rows, (row) => row.key, build, fill);

      // Keyed on whether there is a project rather than on whether there are
      // rows: a tree part-way through its first read has no rows either, and
      // "The project's files appear here." is a claim about a board with no
      // project, not something to flash at someone who has one.
      const lead = root
        ? list
        : (body.querySelector('.pin-empty') || pinEmpty(t("The project's files appear here.")));
      if (body.firstChild !== lead) body.replaceChildren(lead);

      if (statusText) {
        setText(status, statusText);
        if (status.parentNode !== body) body.appendChild(status);
      } else {
        status.remove();
      }
    };

    /**
     * Put the arrow keys on a row and focus it.
     * @param {string} path - The row to move to.
     * @returns {void}
     */
    const moveTo = (path) => {
      if (!path) return;
      activePath = path;
      for (const child of Array.from(list.children)) {
        const el = /** @type {HTMLElement} */ (child);
        if (el.classList.contains('project-files-pin__row')) el.tabIndex = el.dataset.rowKey === path ? 0 : -1;
      }
      const row = rowFor(path);
      if (!row) return;
      // The board this pin sits in is parked off the right edge of the workspace
      // by a transform until it has slid in, and taking focus the plain way has
      // the browser scroll every ancestor to reveal it — including the workspace
      // itself, which drags the columns left and the sliding board with them.
      // So the row is revealed by scrolling the list and nothing else: a clamped
      // scrollTop on the one box that should move.
      row.focus({ preventScroll: true });
      const box = list.getBoundingClientRect();
      const item = row.getBoundingClientRect();
      if (item.top < box.top) list.scrollTop -= box.top - item.top;
      else if (item.bottom > box.bottom) list.scrollTop += item.bottom - box.bottom;
    };

    /**
     * Walking the tree with the keyboard.
     *
     * ←/→ are claimed rather than left to the board, which otherwise uses them to
     * step between tabs: they are the expand and collapse keys of every tree
     * anyone has used, and Escape still takes a reader back out to the board, so
     * the way out that rule protects is still there. The board's chord for
     * switching tabs is untouched, which is why a modified key is let through
     * here without a second thought.
     * @param {KeyboardEvent} event - The press.
     * @returns {void}
     */
    const onKeydown = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const items = rows.filter((row) => row.kind === 'item');
      if (items.length === 0) return;
      const at = Math.max(0, items.findIndex((row) => row.path === activePath));
      const current = items[at];

      switch (event.key) {
        case 'ArrowDown':
          moveTo(items[Math.min(at + 1, items.length - 1)]?.path || '');
          break;
        case 'ArrowUp':
          moveTo(items[Math.max(at - 1, 0)]?.path || '');
          break;
        case 'Home':
          moveTo(items[0]?.path || '');
          break;
        case 'End':
          moveTo(items[items.length - 1]?.path || '');
          break;
        case 'ArrowRight':
          // Open it, then step into it: two presses to reach the first child,
          // which is the one thing every tree agrees on.
          if (current?.isDir && !expanded.has(current.path || '')) toggle(current.path || '');
          else if (current?.isDir) moveTo(items[at + 1]?.path || '');
          break;
        case 'ArrowLeft':
          // Close it, or leave it and go up to whatever holds it.
          if (current?.isDir && expanded.has(current.path || '')) toggle(current.path || '');
          else moveTo(items.find((row) => row.path === parentDir(current?.path || ''))?.path || '');
          break;
        case 'Enter':
        case ' ':
          if (current) activate(current.path || '', current.isDir === true);
          break;
        default:
          return;
      }
      event.preventDefault();
    };

    list.addEventListener('keydown', onKeydown);

    const rereadPending = debounce(() => {
      const dirs = [...pendingDirs];
      pendingDirs.clear();
      for (const dir of dirs) void readDirectory(dir);
    }, REFRESH_DEBOUNCE_MS, { maxWait: REFRESH_MAX_WAIT_MS });

    // Only the directories on screen, and only when something in them moved: a
    // write to one file is one directory to re-read, not a tree.
    const stopWatching = context.services.files.onChange((changes) => {
      for (const change of changes) {
        const dir = parentDir(change.path);
        if (dir && entries.has(dir)) pendingDirs.add(dir);
      }
      if (pendingDirs.size === 0) return;
      rereadPending();
    });

    /**
     * Read every directory on screen again. The stale rows stay up while it
     * happens, so a refresh is not a flash of nothing.
     * @returns {void}
     */
    const refreshAll = () => {
      generation++;
      for (const dir of [root, ...expanded]) {
        if (entries.has(dir)) void readDirectory(dir);
      }
    };

    /**
     * Open the tree back up to where it was left. Every remembered folder is
     * read at once rather than a level at a time: they are already known to be
     * wanted, and waiting for each to land before asking for the one inside it
     * would make coming back to the tab as slow as its deepest branch.
     * @returns {void}
     */
    const restore = () => {
      for (const relative of context.pin.config?.expanded || []) {
        const absolute = toAbsolute(cleanRelative(relative));
        if (!absolute || absolute === root) continue;
        expanded.add(absolute);
        void readDirectory(absolute);
      }
    };

    // `readDirectory` marks the directory as reading before it awaits anything,
    // so the first render already has a line to draw.
    if (root) {
      void readDirectory(root);
      restore();
    }
    render();

    return {
      update: (next) => {
        const nextRoot = next.active?.project?.path || '';
        context = next;
        if (nextRoot === root) return;
        // A different project is a different tree; nothing about the old one
        // means anything here.
        root = nextRoot;
        generation++;
        expanded.clear();
        entries.clear();
        pendingDirs.clear();
        activePath = '';
        statusText = '';
        // Where the reader was in the last project says nothing about this one,
        // and leaving it written down would reopen those folders here if any
        // happened to share a name.
        persist();
        if (root) void readDirectory(root);
        render();
      },
      teardown: () => {
        rereadPending.cancel();
        stopWatching();
      },
      focus: () => moveTo(activePath),
      // The watcher is rooted at the project and skips dot-files, so a change to
      // one is a change this pin will never hear about. That is what this is for.
      getActions: () => [
        { id: 'refresh', label: t('Refresh'), icon: 'refresh', primary: true, run: () => refreshAll() },
      ],
    };
  }
}

export default ProjectFilesPin;
