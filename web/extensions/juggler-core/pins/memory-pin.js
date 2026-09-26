//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
import { readFile, writeFile } from 'juggler/ops';
import { createElement, extractErrorMessage, injectStylesOnce } from 'juggler/ui';
import { parseMemory, removeEntry } from '../lib/memory-format.js';
import { pinEmpty } from '../lib/pin-empty.js';

injectStylesOnce('memory-pin-styles', `
.memory-pin {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  height: 100%;
}
.memory-pin .memory-delete { flex-shrink: 0; opacity: 0.5; transition: opacity 0.15s; }
.memory-pin .memory-delete:hover { opacity: 1; }
.memory-pin__error {
  color: var(--error-color, var(--text-secondary));
  font-size: 0.75rem;
}
`);

/** Where project memory lives, relative to the project root. */
const DEFAULT_PATH = '.juggler/MEMORY.md';

/**
 * How long to let a burst of context-item changes settle before reading the file
 * again. Every read is a round trip to the server, and a turn that remembers
 * three things in a row is one file to show, not three.
 */
const REFRESH_DEBOUNCE_MS = 150;

/**
 * The longest a burst may postpone the read it is settling.
 *
 * A settling timer that every event restarts has no floor: while events keep
 * arriving closer together than the settling period, the read is deferred for
 * ever and the pin shows the previous file indefinitely rather than late. That is
 * not a slow pin, it is a wrong one, and it needs no unusual load to reach — any
 * conversation writing context items in a loop does it.
 *
 * So the first event of a burst starts a clock the rest cannot rewind: later
 * events may delay the read up to this ceiling and no further. Generous, because
 * the coalescing is worth having and a second of staleness is not worth a round
 * trip per event — but finite, which is the whole point.
 */
const REFRESH_MAX_WAIT_MS = 1000;

/**
 * Which file this pin reads. `config.path` overrides the project's own memory,
 * mirroring the memory context item's `data.path` and existing for the same
 * reason: a second pin over a different memory file — a global one, say — is
 * then a registration rather than a rewrite.
 * @param {Record<string, any>} config - The pin's config.
 * @returns {string} The path to read.
 */
function memoryPath(config) {
  const path = typeof config?.path === 'string' ? config.path.trim() : '';
  return path || DEFAULT_PATH;
}

/**
 * MemoryPin — the project's durable facts, on the board.
 *
 * This shows the file as it is on disk now, which is the same thing the memory
 * item's properties panel shows and the same thing the next conversation will be
 * seeded with. It is deliberately not what the *current* conversation can see:
 * each conversation freezes its own copy when it starts, so the model's view is
 * older than this one by design, and reproducing that here would be showing the
 * same facts twice to explain a difference the user cannot act on. The file is
 * the thing to curate; this is a view of the file.
 *
 * Nothing tells it when that file changes. The project watcher never adds
 * `.juggler` — it skips dot-directories before they are ever watched — so no
 * `file-change` is emitted for anything inside it, and `services.files.onChange`
 * would wait forever. Instead the pin re-reads when it is mounted, when the
 * active context moves it to another file or another conversation, and when the
 * conversation's context items change — which is what a `remember` or `forget` in
 * this viewer looks like from here. Those changes arrive in bursts and are mostly
 * about something else entirely, so a read waits for the burst to settle and a
 * file that comes back unchanged redraws nothing. `Refresh` covers the rest — a
 * hand edit, or another window's write — and nothing polls.
 *
 * The entries can be deleted in place. Each deletion reads the file again before
 * writing, so it preserves changes made since the card was drawn.
 * @class
 * @augments PinboardItemType
 */
class MemoryPin extends PinboardItemType {
  /** @type {import('juggler/pinboard-item-type').PinboardItemManifest} */
  static MANIFEST = {
    id: 'memory',
    name: 'Memory',
    version: '1.0.0',
    description: 'Shows the project facts the assistant keeps',
    // Last of the starting tabs: the one that changes least often.
    order: 60,
    defaultPin: true,
  };

  /**
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {true|string} True when there is a project to read memory from.
   */
  canAdd(active) {
    return active?.project?.path ? true : 'No project';
  }

  /**
   * The toolbar is the memory file's path, which the host draws along with the
   * controls that act on it; the tab stays the one word, because a tab strip is
   * no place for a path.
   * @param {Record<string, any>} config - The pin's config.
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {import('juggler/pinboard-item-type').PinDescription} The tab's word and the file.
   */
  describe(config, active) {
    return { title: this.name, path: absoluteMemoryPath(config, active) };
  }

  /**
   * @param {HTMLElement} container - The body to fill.
   * @param {import('juggler/pinboard-item-type').PinContext} pinContext - The pin and its context.
   * @returns {import('juggler/pinboard-item-type').PinController} The controller.
   */
  mount(container, pinContext) {
    let context = pinContext;
    const body = createElement('div', 'memory-pin');
    container.replaceChildren(body);

    // Only the newest read may draw: a refresh can overtake the read it replaced.
    let generation = 0;

    /** @type {ReturnType<typeof setTimeout>|undefined} The settling period before a read. */
    let pending;

    /**
     * When the burst currently settling began, so that later events can delay the
     * read but never postpone it past REFRESH_MAX_WAIT_MS. Zero when no burst is
     * in flight.
     */
    let burstStartedAt = 0;

    /** The file as it was last drawn, so an unchanged file redraws nothing. */
    let drawn = /** @type {string|null} */ (null);

    /** The file this pin is reading, so a context change that does not move it is not news. */
    let target = absoluteMemoryPath(context.pin.config, context.active);

    const render = async () => {
      const mine = ++generation;
      const path = memoryPath(context.pin.config);
      let content = '';
      try {
        const result = await readFile({ path }, context.signal);
        content = typeof result?.content === 'string' ? result.content : '';
      } catch {
        // No memory file yet is the ordinary case, not a failure: the file is
        // created by the first `remember`. Anything else that stops the read
        // leaves the same empty state, which the next refresh corrects.
        content = '';
      }
      if (mine !== generation || context.signal.aborted) return;
      // A `remember` in this conversation is one line added to a file this pin
      // may not even be showing, and most context-item changes are not memory at
      // all. The same bytes on screen are the same entries on screen.
      if (content === drawn) return;
      drawn = content;

      const { entries } = parseMemory(content);
      if (!entries.length) {
        // An empty board is where most people meet memory for the first time, so
        // this says what the feature is rather than what the card would contain.
        body.replaceChildren(pinEmpty(
          'Facts the assistant keeps about this project, in .juggler/MEMORY.md. '
          + 'Ask it to remember something — a build command, a convention, a decision '
          + 'you would rather not explain twice — and every conversation after this one '
          + 'starts with it already read.',
        ));
        return;
      }

      const list = createElement('ul', 'memory-list');
      for (const entry of entries) {
        const li = createElement('li', 'memory-entry');
        if (entry.date) li.appendChild(createElement('span', 'memory-date', entry.date));
        li.appendChild(createElement('span', 'memory-text', entry.text));

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'memory-delete icon-btn';
        del.title = 'Forget this';
        del.setAttribute('aria-label', 'Delete memory item');
        del.innerHTML = '<span class="icon-trashcan"></span>';
        del.addEventListener('click', async (event) => {
          event.stopPropagation();
          del.disabled = true;
          try {
            const latest = await readFile({ path }, context.signal);
            const current = typeof latest?.content === 'string' ? latest.content : '';
            const { content: next, removed } = removeEntry(current, entry);
            if (removed) await writeFile({ path, content: next, outOfRootApproved: true });
            drawn = null;
            await render();
          } catch (error) {
            if (context.signal.aborted) return;
            del.disabled = false;
            body.querySelector('.memory-pin__error')?.remove();
            body.prepend(createElement('div', 'memory-pin__error', `Couldn't delete it. ${extractErrorMessage(error)}`));
          }
        });
        li.appendChild(del);
        list.appendChild(li);
      }
      body.replaceChildren(list);
    };

    /** @returns {void} */
    const refresh = () => {
      const now = Date.now();
      if (pending === undefined) burstStartedAt = now;
      // What is left of the ceiling, so a burst that keeps restarting the timer
      // still reads at REFRESH_MAX_WAIT_MS rather than never.
      const remaining = REFRESH_MAX_WAIT_MS - (now - burstStartedAt);
      const delay = Math.max(0, Math.min(REFRESH_DEBOUNCE_MS, remaining));
      clearTimeout(pending);
      pending = setTimeout(() => {
        // Cleared before the read so the next event begins a new burst, rather
        // than inheriting a ceiling this one has already spent.
        pending = undefined;
        void render();
      }, delay);
    };

    const stopWatching = context.services.contextItems.onChange(refresh);
    void render();

    return {
      update: (next) => {
        const nextTarget = absoluteMemoryPath(next.pin.config, next.active);
        // Another conversation may have written the file since this one was last
        // looked at, so moving between them is a reason to read it again; moving
        // between threads of one conversation is not.
        const conversationChanged = next.active?.conversation?.id !== context.active?.conversation?.id;
        context = next;
        if (nextTarget === target && !conversationChanged) return;
        target = nextTarget;
        void render();
      },
      teardown: () => {
        clearTimeout(pending);
        stopWatching();
      },
      // Opening, copying and revealing the file are the host's, offered for any
      // pin that names a path — so this one is left with the read itself.
      getActions: () => [
        { id: 'refresh', label: 'Refresh', icon: 'refresh', primary: true, run: () => render() },
      ],
    };
  }
}

/**
 * The memory file's absolute path, for showing and for handing to something
 * outside the app.
 * @param {Record<string, any>} config - The pin's config.
 * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
 * @returns {string} An absolute path, or the relative one when no project is open.
 */
function absoluteMemoryPath(config, active) {
  const path = memoryPath(config);
  if (path.startsWith('/')) return path;
  const root = (active?.project?.path || '').replace(/\/+$/, '');
  return root ? `${root}/${path}` : path;
}

export default MemoryPin;
