//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { validateManifest } from './lib/manifest.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Pinboard-item manifest — static metadata that describes a pinboard-item plugin.
 * Define this as a static MANIFEST property on your item class.
 * @typedef {object} PinboardItemManifest
 * @property {string} id - Unique item-type identifier (kebab-case, e.g. 'file')
 * @property {string} name - Human-readable display name (shown in the catalog and the add picker)
 * @property {string} version - Semantic version (e.g. '1.0.0')
 * @property {string} description - Help text shown in the extensions catalog and the add picker
 * @property {'single'|'multiple'} [instances] - Whether the board may hold more than
 *   one pin of this type. 'single' (the default) makes the type a singleton: the host
 *   reveals the existing pin instead of adding a second.
 * @property {string} [addLabel] - What the add picker calls this type, where that
 *   differs from its name — for one that opens a chooser rather than adding on the
 *   spot, e.g. 'Add a file to view…'. Defaults to `name`.
 * @property {number} [order] - Sort key, ascending, default 0; ties keep registration
 *   order. It orders the add picker and the tabs a new board is furnished with, so
 *   the two agree. Ask for a lower one only where the type earns the top of a list
 *   every user reads.
 * @property {boolean} [addable] - Whether the type appears in the add picker at all.
 *   Defaults to true; set false for a type only ever pinned from a source.
 * @property {boolean} [sourceFallback] - Whether this type is the last resort for a
 *   source rather than a claim on it. Off by default. A type that accepts a whole
 *   `kind` — every file, say — sets it, and the host asks every other type first, so
 *   a narrower type still gets its say however late it registered. Without this the
 *   answer would be decided by load order, and a catch-all shipped in the box would
 *   beat every extension by arriving first.
 * @property {boolean} [defaultPin] - Whether a board opens with this type already on
 *   it. The starting tabs are laid out once, the first time a board is used; after
 *   that the board is the user's, so one they remove stays removed. Only ask for this
 *   where the type is worth a tab before anyone has configured anything — a type that
 *   needs a chooser answered has nothing to show, and there is nobody there to answer.
 * @property {boolean} [retain] - Keep this pin mounted when the user switches to
 *   another tab, instead of tearing it down and building it again on the way back.
 *   Off by default, and the default is the right answer for almost everything: a pin
 *   that re-reads its source on mount is *better* for being rebuilt, because it
 *   cannot then show anything stale.
 *
 *   Ask for it when a rebuild would destroy something config cannot reconstruct — a
 *   live connection, an audio session, an `<iframe>` whose page would reload and
 *   start over. Those are not merely slow to rebuild; they are impossible to rebuild
 *   identically, and a user who switched tabs did not ask for the thing they were
 *   watching to begin again.
 *
 *   A retained pin's body element stays in the document and is hidden rather than
 *   removed — reparenting an `<iframe>` reloads it, so the host never moves one —
 *   and its `signal` stays unaborted, so its subscriptions go on running out of
 *   sight. Its controller gets `hide()` and `show()` to quieten down and pick up
 *   again. `teardown()` then means what it says: the pin is going for good, not
 *   merely off screen.
 * @property {boolean} [needsConversation] - Whether a pin of this type can only be
 *   shown against a conversation — the conversation's plan, its todo list. Off by
 *   default. A popped-out board belongs to the conversation it was opened from,
 *   and when that conversation is deleted the board takes these pins off and goes
 *   on showing the rest; a board left with none closes its window. Leave it off
 *   for a type that merely uses a conversation when there is one.
 * @property {boolean} [toolbar] - Set it `false` and the host draws no item toolbar
 *   above this type's body: no title, no subtitle, no actions. For a pin whose
 *   body opens with a head line of its own that already says what it shows and
 *   carries its own controls, where the toolbar would be a second header saying
 *   less. `describe()` still names the tab; actions belong in that head line,
 *   since the toolbar `getActions()` fills is never shown.
 */

/**
 * A source descriptor — a thing elsewhere in the UI that the user asked to pin,
 * passed to `canPinSource`/`configFromSource` so a properties panel never has to
 * name a concrete pin class.
 * A kind of source an extension defines may carry fields of its own beside
 * these; its pin type declares and reads them.
 * @typedef {object} PinSource
 * @property {string} kind - Source kind, e.g. 'file'
 * @property {string} [path] - Absolute path, for `kind: 'file'`
 * @property {boolean} [isDirectory] - Whether that path names a folder rather than
 *   a file, for a surface that already knows which it is offering
 * @property {'live'|'snapshot'} [presentation] - Whether the pin tracks the source
 *   or freezes what it said at pin time
 * @property {string} [workspace] - A workspace by its id, for `kind: 'workspace'`:
 *   a surface offering to show that workspace's tree
 * @property {string} [branch] - For `kind: 'workspace'`: the branch the workspace
 *   was made to hold, when its provider names one
 * @property {string} [base] - For `kind: 'workspace'`: the branch it was made
 *   from, when its provider names one
 */

/**
 * Who asked the `pin_to_pinboard` tool for a pin.
 * @typedef {object} PinRequestOrigin
 * @property {string} [conversationId] - The conversation whose agent asked.
 */

/**
 * What the agent is told about one pinboard item type, and how it addresses it.
 *
 * A pin type runs in the viewer: it touches the DOM, so it is never loaded in the
 * engine worker, where the `pin_to_pinboard` tool lives. A type that says nothing
 * here is still pinnable — the tool forwards an unrecognised type's parameters
 * untouched — but the model has no way to *find out* it exists, so in practice it
 * is never chosen. The descriptor is how a type gets named in the tool's
 * description, and naming it is the whole of the difference.
 *
 * Declare it as the default export of a module beside the pin, listed under
 * `pinboardItemMeta` in the extension manifest. That module is loaded in the
 * worker, so it must be **free of side effects and of the DOM**: no styles
 * injected at import, no `document`, nothing but the descriptor and the pure
 * functions it needs.
 *
 * ```javascript
 * // pins/clock-pin.meta.js
 * export default {
 *   id: 'clock',
 *   description: 'The current time, ticking.',
 *   parameters: { type: 'object', properties: {}, required: [] },
 * };
 * ```
 * @typedef {object} PinAgentDescriptor
 * @property {string} id - The item-type id, matching the pin's `MANIFEST.id`
 * @property {string} description - One line, written for the model, saying what
 *   this type shows and when to reach for it. Not `MANIFEST.description`, which is
 *   catalog copy for a person: this one is read by something choosing between
 *   types, so say what distinguishes it from the type it would otherwise pick.
 * @property {object} parameters - JSON schema for the `parameters` the tool takes
 *   for this type. A type that needs none still declares an empty object schema,
 *   so the model can see there is nothing to supply.
 * @property {(parameters: Record<string, unknown>, origin?: PinRequestOrigin) => Record<string, unknown>|null} [normalize] -
 *   Collapse the model's parameters to one spelling, or return null to reject
 *   them. Runs before the pin is written, so the type owns what a valid request
 *   is rather than discovering it at mount. Defaults to accepting any plain object.
 *   `origin` says who asked; a type whose pin depends on the asking conversation
 *   records it in what it returns, since the stored pin keeps nothing else.
 * @property {(parameters: Record<string, unknown>) => string} [identity] - What makes
 *   two requests the same pin. The tool hashes it into a stable id, so a repeated
 *   request reveals the existing pin instead of stacking a copy. Defaults to the
 *   whole parameter object.
 * @property {boolean} [fallback] - Whether this type is the general case rather
 *   than a claim on anything in particular — the manifest's `sourceFallback`, said
 *   to the model. It is listed last and named as the answer for what nothing else
 *   claims, so a narrower type is the one that gets picked when it applies.
 */

/**
 * The active context a pin is rendered against. Supplied by the host and treated
 * as immutable — it is a snapshot, not a live view, and a new one arrives through
 * `update()` whenever the active conversation or project changes.
 * @typedef {object} PinActiveContext
 * @property {{path: string, displayName: string, stateDir?: string}} project - The
 *   open project: its root path, and the last segment of that path as a name to
 *   show. Both are empty strings when no project is open. `stateDir` is the folder
 *   the project's local state (memory, env.local.json) is kept in:
 *   `<path>/.juggler`, or a folder outside the project when the user keeps it
 *   there. Absent or empty means `<path>/.juggler`.
 * @property {{id: string, title: string}|null} conversation - Active conversation, if any
 * @property {{id: string|null}|null} thread - The thread the viewer is looking at,
 *   or null when no conversation is open. A conversation's root thread has no id of
 *   its own, so `id` is null there; a sub-thread carries its thread item's id.
 */

/**
 * The host services a pin is handed: the same object an info card and a
 * workspace provider are handed, described in `juggler/services`. The `Pin*`
 * names below are the same types under the names pins have always used.
 * @typedef {import('./services.js').Services} PinServices
 */
/** @typedef {import('./services.js').FileChange} PinFileChange */
/** @typedef {import('./services.js').FilesService} PinFilesService */
/** @typedef {import('./services.js').ContextItemSource} PinContextItemSource */
/** @typedef {import('./services.js').ContextItemSnapshot} PinContextItemSnapshot */
/** @typedef {import('./services.js').ContextItemsService} PinContextItemsService */
/** @typedef {import('./services.js').WorkspacesService} PinWorkspaces */
/** @typedef {import('./services.js').TopicsService} PinTopicsService */
/** @typedef {import('./services.js').Task} PinTask */
/** @typedef {import('./services.js').TasksService} PinTasksService */
/** @typedef {import('./services.js').ReviewComment} PinReviewComment */
/** @typedef {import('./services.js').ReviewDraft} PinReviewDraft */
/** @typedef {import('./services.js').ReviewService} PinReviewService */

/**
 * Whether a mounted pin can be seen, as the host knows it. Out of sight is any
 * of: the board put away, another tab in front of a retained pin, the window in
 * the background, the pin scrolled out of view — the host tracks each, and the
 * pin is in sight only while none holds. What to do about an absence is the
 * pin's choice: a pin that re-reads after a long one decides how long is long.
 * @typedef {object} PinVisibility
 * @property {() => boolean} isVisible - Whether it is in sight now
 * @property {(listener: (visible: boolean) => void) => (() => void)} onChange -
 *   Told each time the answer changes, with the new one. Returns an unsubscribe
 *   function; the host also drops it when the pin is torn down.
 */

/**
 * Everything `mount()` and `update()` receive.
 * @typedef {object} PinContext
 * @property {{id: string, type: string, config: Record<string, unknown>}} pin - This pin instance
 * @property {PinActiveContext} active - Immutable active-context snapshot
 * @property {PinServices} services - Host services
 * @property {AbortSignal} signal - Aborted when the pin is torn down; every fetch must honour it
 * @property {PinVisibility} visibility - Whether anyone can see the pin right now
 * @property {(nextConfig: Record<string, unknown>, options?: PinConfigWriteOptions) => Promise<void>} updateConfig -
 *   Persist new config for this pin. A changed config mounts the pin afresh, which is
 *   what a pin wants when the change is a different thing to show; pass `inPlace`
 *   when it is merely writing down where the reader has got to.
 * @property {unknown} [viewState] - What this pin's controller returned from
 *   `saveViewState()` the last time it was torn down in this viewer, or undefined.
 *   Treat it as a stranger's input: the files it names may have gone since.
 */

/**
 * How `updateConfig` writes.
 * @typedef {object} PinConfigWriteOptions
 * @property {boolean} [inPlace] - The pin is already showing this config — it has
 *   just opened a folder, say, and is recording that — so the store's echo of it
 *   must not rebuild the pin. A change made anywhere else still does.
 */

/**
 * What the host shows in the item toolbar above the provider body. Returned from
 * `describe()`, so the host owns the chrome and the provider owns only the words.
 * @typedef {object} PinDescription
 * @property {string} title - Short tab label and toolbar title, e.g. 'main.go'
 * @property {string} [subtitle] - Secondary line, e.g. the containing directory
 * @property {string} [path] - The absolute path this pin is showing. The toolbar
 *   then names the file rather than the pin: it shows the path in place of the
 *   title, and offers the same open/copy/reveal controls a path gets anywhere
 *   else in the app, so a pin need not supply those actions itself. `title` is
 *   still what the tab says, because a full path across a tab strip is unreadable.
 * @property {string} [badge] - Compact status shown on the tab, e.g. '3/5'. Not a second title.
 */

/**
 * One thing the user can do to the active pin, offered in the item toolbar the
 * host draws above the body. The provider supplies the words and the behaviour;
 * where the control goes, and what it looks like, is the host's business.
 * @typedef {object} PinAction
 * @property {string} id - Stable identifier, for the host to tell actions apart
 * @property {string} label - What the control says, e.g. 'Open'. Literal, not a sentence.
 * @property {boolean} [primary] - Put it in the toolbar as a button of its own.
 *   Everything else goes in the overflow menu, which is where most actions belong:
 *   a toolbar of five buttons is a toolbar nobody reads.
 * @property {string} [icon] - Draw it as a glyph the host knows by this name,
 *   rather than as its label. Currently only `'refresh'`. An icon action is always
 *   a button of its own and never joins the overflow menu, where a picture has
 *   nothing to say; a name the host does not know falls back to the label.
 * @property {boolean} [disabled] - Show it, greyed, rather than hiding it. Prefer
 *   this to omitting an action that is temporarily unavailable — a control that
 *   comes and goes is harder to find than one that is briefly dim.
 * @property {() => void|Promise<void>} run - Do the thing. Anything thrown, or a
 *   rejected promise, is reported in the board's status line with the error text intact.
 */

/**
 * The object `mount()` may return instead of a bare teardown function, letting a
 * pin survive an active-context change rather than being torn down and rebuilt.
 * @typedef {object} PinController
 * @property {(next: PinContext) => void} [update] - Apply a new context snapshot in place
 * @property {() => void} [teardown] - Stop timers and listeners
 * @property {() => void} [focus] - Move focus into the body. Asked when a reader
 *   arrives on this pin deliberately — the board opening on it, a reveal, Return
 *   pressed on it — and never as the arrow keys step past it on the way somewhere
 *   else, so a pin whose entry point is a text field does not swallow the next
 *   press of the key that brought them here.
 * @property {() => void} [hide] - Only for a type with `retain` in its manifest: the
 *   user has switched to another tab and this pin is off screen, still mounted and
 *   still subscribed. Quieten down — pause an animation, stop asking for what nobody
 *   is reading — but do not release what retention exists to protect. Never called
 *   for a pin that is not retained, which is torn down instead.
 * @property {() => void} [show] - The retained pin is on screen again. Pick up
 *   whatever `hide()` put down, and re-read anything that may have moved on while
 *   nobody was looking: the news that arrived meanwhile was delivered, but a pin
 *   that stopped listening in `hide()` will not have heard it.
 * @property {() => unknown} [saveViewState] - Called as the pin is torn down — the
 *   user switched tabs, or the board was rebuilt — for whatever should put it back
 *   where the reader left it: the scroll of a scroller of its own (the board
 *   remembers only its body's), a selection. Handed back as `viewState` on the next
 *   mount. Kept in memory by this viewer, never persisted and never shared, so it
 *   is the place for state that changes on every scroll tick; what should survive
 *   a reload belongs in config. Never called for a retained pin, which keeps its
 *   state by never being torn down.
 * @property {() => PinAction[]} [getActions] - The actions the item toolbar offers for
 *   this pin. The host asks after `mount()` and after every `update()`, and at no
 *   other time — there is no channel for announcing that your actions changed, so
 *   return the same set each call and use `disabled` for one that cannot run yet.
 *   Omit this entirely and the toolbar shows title and subtitle alone.
 */

// ============================================================================
// PinboardItemType Base Class
// ============================================================================

/**
 * PinboardItemType — base class for Juggler "pinboard item" plugins.
 *
 * The pinboard is the tabbed workspace behind the right edge of the window. Each
 * tab is one *pin*: a configured instance of an item type, kept in server-backed
 * session state so every viewer of the project sees the same board. An item type
 * supplies the body of its tab; the host owns the tabs, the toolbar, drag, remove,
 * loading and error shells.
 *
 * Pinboard items are **viewer-only** — they touch the DOM and never run in the
 * engine worker, so like info cards (and unlike strategy/context-item/command)
 * there is no `-worker.js` twin of this base class.
 *
 * ## Item type versus info card versus context item
 *
 * - An **info card** is an ambient tile the sidebar may *drop* when it runs out of
 *   room. A pin is guaranteed workspace the user asked for by name.
 * - A **context item** belongs to a conversation and is visible to the model. A pin
 *   is a view: pinning a file shows it, it does not put it in anyone's context.
 *
 * ## Creating an item type
 *
 * Item types ship inside an **extension** (a directory with a
 * `juggler.extension.json` manifest). Add a file named `*-pin.js` under the
 * extension's `pins/` directory — the manifest's `provides.pinboardItems` glob
 * registers it automatically.
 *
 * 1. Import and extend PinboardItemType: `import PinboardItemType from 'juggler/pinboard-item-type';`
 * 2. Define a static MANIFEST with the required fields (id, name, version, description).
 * 3. Implement `mount(container, pinContext)`; optionally override `describe()`,
 *    `canAdd()`, `normalizeConfig()`, and `configure()`.
 * 4. To let the agent pin one, ship a `PinAgentDescriptor` beside it — see that
 *    typedef. Without one the type is invisible to the model.
 *
 * ```javascript
 * import PinboardItemType from 'juggler/pinboard-item-type';
 *
 * export default class ClockPin extends PinboardItemType {
 *   static MANIFEST = {
 *     id: 'clock',
 *     name: 'Clock',
 *     version: '1.0.0',
 *     description: 'Shows the time, which is rarely what you wanted to know',
 *   };
 *
 *   mount(container, { signal }) {
 *     const tick = () => { container.textContent = new Date().toLocaleTimeString(); };
 *     tick();
 *     const timer = setInterval(tick, 1000);
 *     signal.addEventListener('abort', () => clearInterval(timer));
 *     return () => clearInterval(timer);
 *   }
 * }
 * ```
 *
 * ## State rules
 *
 * Config is the only thing that persists, so keep it small, JSON-serializable, and
 * meaningful without the machine that produced it: a path, not file bytes. The
 * board state is shared and long-lived, and it outlives your class — a pin whose
 * extension has been disabled keeps its config until the user removes it.
 *
 * Hold no authoritative state in the DOM or on the instance: one instance serves
 * every pin of its type, mount and teardown happen for reasons you do not control
 * (a hot reload, the user switching tabs), and the same board is
 * open in windows you cannot see.
 *
 * A type with `retain` in its manifest is spared only the last of those: switching
 * tabs hides it instead of tearing it down. It is not spared any of the others, and
 * it is not spared this rule — a retained pin is still one of several views of a
 * board it does not own, and what it must survive is still written in its config.
 * @class
 * @abstract
 */
class PinboardItemType {
  /**
   * Pinboard-item manifest (static property set by subclasses).
   * @type {PinboardItemManifest}
   * @static
   */
  static MANIFEST;

  constructor() {
    if (new.target === PinboardItemType) {
      throw new Error('PinboardItemType is an abstract class and cannot be instantiated directly');
    }

    // Validate manifest on construction
    validateManifest(this.constructor);
  }

  /** @returns {PinboardItemManifest} This item type's manifest. */
  getManifest() {
    return /** @type {typeof PinboardItemType} */ (this.constructor).MANIFEST;
  }

  /** @returns {string} The item-type id (from MANIFEST). */
  get id() {
    return this.getManifest().id;
  }

  /** @returns {string} The item-type display name (from MANIFEST). */
  get name() {
    return this.getManifest().name;
  }

  /** @returns {boolean} True when the board may hold more than one pin of this type. */
  get allowsMultiple() {
    return this.getManifest().instances === 'multiple';
  }

  /**
   * @returns {boolean} True when this type's pins stay mounted while another tab is
   *   showing, rather than being torn down and rebuilt on the way back.
   */
  get retainsMount() {
    return this.getManifest().retain === true;
  }

  /**
   * @returns {boolean} False when this type's manifest asks for no item toolbar.
   */
  get drawsToolbar() {
    return this.getManifest().toolbar !== false;
  }

  /**
   * Whether a new pin of this type can be added right now. Return a string to say
   * why not — the add picker shows it, which is far better than the entry silently
   * vanishing ('No project', 'No active conversation'). Defaults to always addable.
   * @param {PinActiveContext} active - The current active-context snapshot.
   * @returns {true|string} True to allow, or the reason it is unavailable.
   */
  canAdd(active) {
    void active;
    return true;
  }

  /**
   * Collect the config for a new pin. Override for a type that needs to ask the
   * user something first (File asks which file). Return null to abandon the add —
   * a cancelled picker is not an error. Defaults to an empty config.
   * @param {{active: PinActiveContext, initialConfig?: Record<string, unknown>, signal: AbortSignal}} options - Configuration request.
   * @returns {Promise<Record<string, unknown>|null>} The new config, or null if cancelled.
   */
  async configure(options) {
    return options.initialConfig ?? {};
  }

  /**
   * The user is removing this pin. Release anything this pin created and nothing
   * else.
   *
   * The boundary is the whole of the rule, and it is narrower than it looks.
   * Removing a pin is removing a *view*, so a pin releases what it brought into
   * existence — a server it started, a connection it opened — and never touches
   * what it was merely looking at. A Tasks pin does not stop tasks it only
   * listed; a Memory pin does not edit MEMORY.md; a File pin does not delete a
   * file. Leaving a process running that the user now has no window onto is the
   * problem this exists to solve, and it is the only one.
   *
   * Best-effort and advisory: it is awaited, but throwing does not stop the
   * removal, and neither does taking too long — a couple of seconds in, the
   * removal goes ahead and leaves you to finish on your own. A pin the user has
   * asked to be rid of goes whatever its type thinks about it, so do the release
   * and do not bargain. Not called when an extension is disabled or the app
   * quits — there is no promise here that a resource is ever cleaned up, only
   * that the obvious moment is offered.
   *
   * It runs once, in the window the pin was removed in. A board is shared, so
   * the other windows showing it learn of the removal from the board itself and
   * give their own mount `teardown()` and nothing more: this is where the one
   * thing behind the pin is released, `teardown()` where one view of it is. Be
   * ready to be called about something already gone, since the window doing the
   * removing need not be the window that started it.
   * @param {Record<string, unknown>} config - The pin's normalized config.
   * @param {{active: PinActiveContext|null}} options - The active context, where the host had one.
   * @returns {Promise<void>} Resolves when the release is done.
   */
  async willRemove(config, options) {
    void config;
    void options;
  }

  /**
   * Validate and normalize a config before it is stored or rendered. This runs on
   * config that has been sitting in session state since a previous version of your
   * extension, so treat every field as untrusted and migrate rather than throw.
   * Return null to reject the config outright — the host keeps the pin but shows it
   * as unusable rather than mounting against nonsense.
   * @param {Record<string, unknown>} config - The stored or supplied config.
   * @returns {Record<string, unknown>|null} The normalized config, or null to reject it.
   */
  normalizeConfig(config) {
    return config;
  }

  /**
   * Whether two configs name the same thing, so the host can reveal the existing
   * pin instead of adding a duplicate. Both configs are already normalized.
   * Defaults to a shallow JSON comparison.
   * @param {Record<string, unknown>} a - One config.
   * @param {Record<string, unknown>} b - The other config.
   * @returns {boolean} True when the two configs describe the same pin.
   */
  isSameConfig(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * What an existing pin becomes when it is asked for again. The host reveals
   * the pin it found rather than adding a duplicate; a request that also names
   * something within that pin — a section of it, one of several things it can
   * show — can carry that onto it here. Return the config the pin should have
   * (the host normalizes and stores it when it differs), or null to leave the
   * pin as it is. Defaults to null.
   * @param {Record<string, unknown>} existing - The pin's config, normalized.
   * @param {Record<string, unknown>} requested - The config asked for, as asked:
   *   not normalized, so it may say what normalizing would drop.
   * @returns {Record<string, unknown>|null} The config to store, or null.
   */
  revisit(existing, requested) {
    void existing;
    void requested;
    return null;
  }

  /**
   * Cheap title/subtitle/badge for the tab and item toolbar. Called often, including
   * while the board is being laid out, so it must not do work — read the config, not
   * the filesystem. Defaults to the manifest name.
   * @param {Record<string, unknown>} config - The pin's normalized config.
   * @param {PinActiveContext} active - The current active-context snapshot.
   * @returns {PinDescription} What the host chrome should say.
   */
  describe(config, active) {
    void config;
    void active;
    return { title: this.name };
  }

  /**
   * Whether this type can pin the given source. Static, because the host asks
   * before any instance exists — a properties panel says "pin this file" and the
   * registry finds the type that can, rather than the panel naming a class.
   *
   * Accept only what this type is *for*. The first type to accept wins, so a type
   * that says yes to every file of any kind decides the answer for every other
   * type; if that is genuinely what yours does, mark it `sourceFallback` in the
   * manifest and it will be asked only once nothing narrower has claimed the source.
   * @param {PinSource} source - The source the user asked to pin.
   * @returns {boolean} True if `configFromSource` will accept it.
   */
  static canPinSource(source) {
    void source;
    return false;
  }

  /**
   * What a surface offering this source to this type should call the action —
   * "Show in Git view" — for a host that offers every type that accepts a
   * source rather than only the first (a workspace's own panel does). Worded
   * when asked, in the reader's language. '' lets the host word it.
   * @param {PinSource} source - The source being offered.
   * @returns {string} The action's label, or ''.
   */
  static sourceLabel(source) {
    void source;
    return '';
  }

  /**
   * Turn a source descriptor into a config for a new pin. Only called when
   * `canPinSource` accepted it.
   * @param {PinSource} source - The source the user asked to pin.
   * @returns {Record<string, unknown>|null} The config, or null if it cannot be pinned after all.
   */
  static configFromSource(source) {
    void source;
    return null;
  }

  /**
   * Fill the pin's body. The host has already drawn the tab and toolbar; this owns
   * only the region below them.
   *
   * Return a teardown function, or a controller with `update()` so a change of
   * active conversation re-renders in place instead of rebuilding the pin, and
   * `getActions()` to put controls in the toolbar the host draws above you.
   * Anything thrown here is caught by the host and shown in the pin's place, so let
   * a real failure throw rather than rendering your own apology.
   * @abstract
   * @param {HTMLElement} container - The body region to populate.
   * @param {PinContext} pinContext - The pin, its config, and the active context.
   * @returns {PinController|(() => void)|void} Optional teardown or controller.
   */
  mount(container, pinContext) {
    void container;
    void pinContext;
    throw new Error('mount() must be implemented by subclass');
  }
}

export default PinboardItemType;
