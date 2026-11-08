//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
import { translator } from 'juggler/i18n';
import { createElement } from 'juggler/ui';
import { createFileBrowser, normalizeBrowserConfig } from '../lib/file-browser.js';
import { pinEmpty } from '../lib/pin-empty.js';

const t = translator('@juggler/core');

/**
 * ProjectFilesPin — the project's files, in a file browser rooted at the
 * project (see `lib/file-browser.js` for everything the browser does).
 *
 * It shows what is on disk, all of it: `.git` and `node_modules` appear, dimmed,
 * even though the agent's own view of the tree hides them. That is the honest
 * reading of "the project's files", and unopened they are a row each.
 *
 * How the browser is arranged — which folders are open, the sort, the preview —
 * is the pin's config, kept relative to the project root, so it survives a tab
 * switch, a reload and a restart, and a project checked out somewhere else is
 * the same tree to the person reading it. Where the reader was in it comes back
 * through the board's view state.
 *
 * Read-only, like every pin: nothing here puts a file into anyone's context.
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
   * How the browser was arranged, and nothing else. Everything here has been
   * sitting in session state since some earlier version of this pin, so it is
   * treated as a stranger's input: anything unusable is dropped and the rest is
   * kept, never thrown for.
   * @param {Record<string, unknown>} config - The stored or supplied config.
   * @returns {Record<string, unknown>} The normalized config.
   */
  normalizeConfig(config) {
    return { ...normalizeBrowserConfig(config) };
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
   * be answering a question the whole board shares, but the toolbar showing the
   * root path is worth having, and with it the host draws the controls that act
   * on that folder.
   * @param {Record<string, unknown>} config - The pin's config.
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
    body.style.height = '100%';
    container.replaceChildren(body);

    /** @type {import('../lib/file-browser.js').FileBrowser|null} */
    let browser = null;

    /** Draw the browser for the root there is, or say there is no project. */
    const show = () => {
      if (!root) {
        body.replaceChildren(pinEmpty(t("The project's files appear here.")));
        return;
      }
      browser = createFileBrowser({
        root,
        config: context.pin.config,
        viewState: context.viewState,
        context: () => context,
        label: t('Project files'),
        // In place: the browser already shows what it is writing down, and the
        // board rebuilding it on the echo would lose the reader's place.
        persist: (config) => { void context.updateConfig({ ...config }, { inPlace: true }); },
      });
      body.replaceChildren(browser.element);
    };
    show();

    return {
      update: (next) => {
        const nextRoot = next.active?.project?.path || '';
        context = next;
        if (nextRoot === root) return;
        root = nextRoot;
        if (browser && root) {
          browser.setRoot(root);
          return;
        }
        browser?.teardown();
        browser = null;
        show();
      },
      teardown: () => browser?.teardown(),
      focus: () => browser?.focus(),
      saveViewState: () => browser?.saveViewState(),
      // The watcher is rooted at the project and skips dot-files, so a change to
      // one is a change this pin will never hear about. That is what this is for.
      getActions: () => [
        { id: 'refresh', label: t('Refresh'), icon: 'refresh', primary: true, run: () => browser?.refresh() },
      ],
    };
  }
}

export default ProjectFilesPin;
