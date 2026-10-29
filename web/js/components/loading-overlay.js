//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The app has two waits that take the whole window: starting up, and getting
 * the connection back. They look the same to whoever is waiting — clubs in the
 * middle of a dimmed window, and a line of text that only turns up if the wait
 * goes on long enough to be worth explaining — so they are one component here,
 * configured twice.
 *
 * What the configurations differ in is wording and extra lines; what they share
 * is everything with a reason behind it: the scrim, the reveal that reserves its
 * own space so nothing shifts, and above all the rule for what counts as time
 * spent waiting (see {@link LoadingOverlay#_tick}).
 * @module components/loading-overlay
 */

/**
 * How often the wait is advanced.
 * @type {number}
 */
const TICK_MS = 1000;

/**
 * Longest gap between ticks that counts as time spent waiting. The wait is
 * accumulated tick by tick rather than measured against the wall clock because
 * the page can stop running: a suspended laptop drops the link and then freezes
 * for hours. Counting that gap would put the overlay on its last line the
 * instant the machine woke, before a single retry had been given the chance to
 * fail. A gap longer than this is time the page wasn't running, so it doesn't
 * count.
 * @type {number}
 */
const MAX_TICK_MS = 2000;

/**
 * Whether the page is hidden, and so painting nothing anyone can read: a
 * background tab, a minimised or fully occluded window, a locked phone.
 *
 * `data-doc-hidden` is the app's own signal (see App._initDocumentVisibilityPause),
 * and it is the one to trust on macOS, where a Cmd-Tab back to the window fires
 * window `focus` but NOT `visibilitychange` — the app clears the attribute on
 * `focus` for exactly that reason. `document.hidden` is consulted too so this
 * still works in a page where nothing maintains the attribute. Being wrong in
 * the hidden direction only makes the wording escalate slower, which is the
 * side to be wrong on.
 * @returns {boolean} True when nothing on this page is being read.
 */
function pageHidden() {
  return document.documentElement.hasAttribute('data-doc-hidden') || document.hidden;
}

/**
 * LoadingOverlay
 *
 * Full-window overlay for a wait the app cannot proceed through: the clubs
 * spinner, and under it an info block held back until the wait has lasted long
 * enough to be worth a word. The block is always laid out and merely invisible,
 * so revealing it moves nothing that was already on screen.
 *
 * Both the grace period and any escalating wording run off time this page spent
 * waiting IN VIEW — not wall-clock elapsed, and not time it spent hidden. Time
 * the page wasn't running at all is excluded by {@link MAX_TICK_MS}; time it was
 * running but hidden is excluded by {@link pageHidden}. Hidden pages matter as
 * much as suspended ones: a browser clamps a background tab's timers to about
 * once a second, which is the tick period, so an unwatched tab accrues the wait
 * at very nearly full speed. Left to count, a two-minute tab switch meant the
 * overlay revealed itself on its last line, having silently burned through the
 * lines that lead up to it. Nothing escalates until the line before it has been
 * on screen, in front of someone, for its full turn.
 */
class LoadingOverlay {
  /**
   * @param {object} [options] - How this overlay differs from the other one.
   * @param {string} [options.variant] - Which wait this is: `startup` or `disconnected`. Carried as `data-loading-overlay`, not as a class — it is an identity, and the CSS that keys off it is styling the same overlay differently rather than styling a different thing.
   * @param {number} [options.graceMs] - Time in view before the info block is revealed.
   * @param {string} [options.spinnerSize] - `--size` for the spinner, as a CSS length.
   * @param {((waitedMs: number) => string)|null} [options.lineForWait] - Wording for the wait, restated as it grows. Omit when the line is pushed in with {@link LoadingOverlay#setLine} instead.
   * @param {boolean} [options.detailLine] - Reserve a second line below the message.
   * @param {boolean} [options.hostLine] - Show the server this page is talking to.
   */
  constructor({
    variant = '',
    graceMs = 0,
    spinnerSize = '3rem',
    lineForWait = null,
    detailLine = false,
    hostLine = false
  } = {}) {
    /** @type {string} @private */
    this._variant = variant;
    /** @type {number} @private */
    this._graceMs = graceMs;
    /** @type {string} @private */
    this._spinnerSize = spinnerSize;
    /** @type {((waitedMs: number) => string)|null} @private */
    this._lineForWait = lineForWait;
    /** @type {boolean} @private */
    this._detailLine = detailLine;
    /** @type {boolean} @private */
    this._hostLine = hostLine;
    /** @type {string} @private The line to show, whoever decided it. */
    this._line = lineForWait ? lineForWait(0) : '';

    /** @type {HTMLElement|null} @private */
    this._element = null;
    /** @type {HTMLElement|null} @private */
    this._infoElement = null;
    /** @type {HTMLElement|null} @private */
    this._messageElement = null;
    /** @type {HTMLElement|null} @private The second line, below the message. */
    this._detailElement = null;
    /** @type {number|null} @private Drives the reveal and any wording tiers. */
    this._waitTimer = null;
    /** @type {number} @private Time spent waiting while the page was in view. */
    this._waitedMs = 0;
    /** @type {number} @private When the wait was last advanced. */
    this._lastTickAt = 0;
    /** @type {boolean} @private Whether the page went hidden since the last tick. */
    this._hiddenSinceTick = false;
    /** @type {(() => void)|null} @private Watches for the page going hidden. */
    this._visibilityListener = null;
  }

  /**
   * Whether the overlay is on screen.
   * @returns {boolean} True while it is mounted.
   */
  get isShowing() {
    return this._element !== null;
  }

  /**
   * Show the overlay, taking over an element already in the page if there is
   * one. Startup's overlay is written into `index.html` so that the dimmed
   * window is there on the first frame, long before this module is fetched —
   * adopting it means the handover is silent instead of a flicker of the same
   * thing being rebuilt.
   */
  show() {
    if (this._element) {
      return; // Already showing
    }

    this._waitedMs = 0;
    this._lastTickAt = Date.now();
    this._hiddenSinceTick = false;

    // A tick only counts if the page was in view for the WHOLE interval, so a
    // page that hid and came back between two ticks must be caught as it goes.
    // This reads `document.hidden` rather than pageHidden(): the app toggles
    // `data-doc-hidden` from this same event, and listener order between the
    // two is not ours to assume.
    this._visibilityListener = () => {
      if (document.hidden) this._hiddenSinceTick = true;
    };
    document.addEventListener('visibilitychange', this._visibilityListener);

    const adopted = this._variant
      ? /** @type {HTMLElement|null} */ (
        document.querySelector(`.loading-overlay[data-loading-overlay="${this._variant}"]`)
      )
      : null;

    if (adopted) {
      this._element = adopted;
    } else {
      this._element = document.createElement('div');
      // Assigned as a plain literal, and the variant kept out of it. A class
      // built from a variable is a class scripts/css-markup-model cannot
      // resolve, and what it cannot see it has to assume: this element would
      // then be a candidate for carrying any class in the app, and every rule
      // here would be reported as contesting rules it can never meet.
      this._element.className = 'loading-overlay';
      if (this._variant) this._element.dataset.loadingOverlay = this._variant;
      this._element.innerHTML = this._markup();
      // Mount inside <app-container>, NOT <body>. app-container is position:fixed,
      // which forms a stacking context, so anything inside it (the Windows caption
      // min/max/close buttons) can never paint above a sibling of app-container.
      // A body-level overlay therefore covers the only way to close the frameless
      // Windows window. Mounting here puts the overlay in app-container's stacking
      // context, where the caption controls' higher z-index (--z-above-modal vs
      // the overlay's --z-modal) keeps them clickable. Falls back to body if the
      // container isn't present (it always is in the viewer UI that shows this).
      const host = document.querySelector('app-container') || document.body;
      host.appendChild(this._element);
    }

    this._infoElement = this._element.querySelector('.loading-overlay__info');
    if (!this._infoElement) {
      // An adopted element whose markup predates what this class expects. Better
      // to rebuild it than to run on with nowhere to put the wording.
      this._element.innerHTML = this._markup();
      this._infoElement = this._element.querySelector('.loading-overlay__info');
    }
    this._messageElement = this._element.querySelector('.loading-overlay__message');
    this._detailElement = this._element.querySelector('.loading-overlay__detail');
    if (this._messageElement) {
      this._messageElement.textContent = this._line;
    }
    const hostElement = this._element.querySelector('.loading-overlay__host');
    if (hostElement) {
      hostElement.textContent = globalThis.location.host;
    }

    this._waitTimer = window.setInterval(() => this._tick(), TICK_MS);
  }

  /**
   * Take the overlay off screen and stop everything it was running.
   */
  hide() {
    if (this._waitTimer) {
      clearInterval(this._waitTimer);
      this._waitTimer = null;
    }
    if (this._visibilityListener) {
      document.removeEventListener('visibilitychange', this._visibilityListener);
      this._visibilityListener = null;
    }
    if (this._element) {
      this._element.remove();
      this._element = null;
      this._infoElement = null;
      this._messageElement = null;
      this._detailElement = null;
    }
  }

  /**
   * Say what the wait is for. Kept even while the overlay is not mounted, so a
   * line set before it goes up is the line it goes up with.
   * @param {string} text - The line to show.
   */
  setLine(text) {
    this._line = text;
    if (this._messageElement) {
      this._messageElement.textContent = text;
    }
  }

  /**
   * Fill the second line, below the message, or blank it with `''`.
   * @param {string} text - The line to show.
   */
  setDetail(text) {
    if (this._detailElement) {
      this._detailElement.textContent = text;
    }
  }

  /**
   * The overlay's contents. Only the message line is always present; the rest
   * is what the configuration asked for, because a line nothing ever fills
   * still takes up the room that keeps the spinner off centre.
   *
   * Class names are written out in full rather than assembled from a stem, so
   * that a search for one finds it — which is also what keeps the dead-selector
   * check able to see that the CSS for them is in use.
   * @returns {string} Markup for the element's contents.
   * @private
   */
  _markup() {
    const detail = this._detailLine ? '<div class="loading-overlay__detail"></div>' : '';
    const host = this._hostLine ? '<div class="loading-overlay__host"></div>' : '';
    return `
            <div class="loading-overlay__content">
                <juggler-spinner style="--size: ${this._spinnerSize}"></juggler-spinner>
                <div class="loading-overlay__info">
                    <div class="loading-overlay__message"></div>
                    ${detail}
                    ${host}
                </div>
            </div>
        `;
  }

  /**
   * Advance the wait by the part of this interval someone could actually have
   * been reading the overlay, then reveal the info block once the grace period
   * has passed and keep its wording current.
   * @private
   */
  _tick() {
    const now = Date.now();
    const sinceLastTick = Math.min(now - this._lastTickAt, MAX_TICK_MS);
    this._lastTickAt = now;

    // Unseen time isn't waiting: it buys no escalation, and there is nothing to
    // restate on a page nobody is looking at. Anything after this line only
    // happens on a page in view.
    const wasHidden = this._hiddenSinceTick || pageHidden();
    this._hiddenSinceTick = false;
    if (wasHidden) return;

    this._waitedMs += sinceLastTick;

    // The info block is always laid out (reserving its space so nothing
    // shifts); it's only kept invisible during the grace period.
    if (this._waitedMs < this._graceMs || !this._infoElement) return;
    if (this._lineForWait) {
      this.setLine(this._lineForWait(this._waitedMs));
    }
    this._infoElement.classList.add('loading-overlay__info--visible');
  }
}

export default LoadingOverlay;
