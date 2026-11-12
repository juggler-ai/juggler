//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Two-state theme toggle unit test.
 *
 * The header button offers two states over the three modes stored underneath:
 * it flips the theme on screen, and pins one only while it differs from the OS
 * setting — landing on the theme the OS is already showing stores 'system'
 * instead. This pins the properties that makes that safe to ship: every click
 * changes what's on screen, a second click always undoes the first, and no
 * sequence of clicks can strand a window in a fixed theme with the OS ignored.
 *
 * The case worth having a test for is the one a naive "system ↔ override"
 * toggle gets wrong: a theme pinned from Settings that happens to match the OS.
 * Flipping from there must pin the other theme, not silently return to 'system'
 * and repaint the same colour, which would read as a dead button.
 * @module unit-tests/theme-toggle-test
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors list of error messages from failing assertions
 */

/** The device-wide record of the OS setting, written whenever we paint in 'system'. */
const SYSTEM_THEME_KEY = 'juggler-system-theme';

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { toggleTheme, setMode, getMode, getPaintedTheme, MODES, THEME_MODE_EVENT } =
    await import('../../js/utils/theme-manager.js');
  const { scopedKey } = await import('../../js/services/prefs.js');
  /** This window's cache of its mode, which every setMode below writes. */
  const STORED_MODE_KEY = scopedKey('juggler-window-theme');

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  /**
   * @param {any} actual
   * @param {any} expected
   * @param {string} what
   */
  const eq = (actual, expected, what) => {
    if (actual !== expected) throw new Error(`${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  };

  /**
   * Pretend the OS is set to a given theme. theme-manager reads it through
   * matchMedia at call time, so a stub covers every read it makes.
   * @param {string} theme - 'dark' or 'light'.
   */
  const setOS = (theme) => {
    window.matchMedia = /** @type {any} */ ((query) => ({
      matches: theme === 'light',
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
  };

  const originalMatchMedia = window.matchMedia;
  const originalTheme = document.documentElement.getAttribute('data-theme');
  // Painting a theme also writes an inline background on <html>; the lane runs
  // every later suite under whatever is left there.
  const originalBackground = document.documentElement.style.background;
  const originalSystemRecord = localStorage.getItem(SYSTEM_THEME_KEY);
  // The mode is a window preference, cached in this origin's localStorage
  // beside the system record. Both cells outlive the page, so both are saved
  // and put back by hand; the final setMode puts the session's back.
  const originalStoredMode = localStorage.getItem(STORED_MODE_KEY);
  const originalMode = getMode();

  try {
    // --- the ordinary path: system → pinned → system ----------------------

    run('a toggle away from system pins the other theme', () => {
      setOS('dark');
      setMode(MODES.SYSTEM);
      eq(getPaintedTheme(), 'dark', 'system mode paints the OS theme');

      toggleTheme();
      eq(getPaintedTheme(), 'light', 'painted theme after the toggle');
      eq(getMode(), MODES.LIGHT, 'mode after toggling away from the OS theme');
    });

    // The no-lock-in property. A two-state button that stored 'dark' here would
    // leave the OS permanently ignored with no way back from the header.
    run('a toggle back to the OS theme returns to system, not to the other pin', () => {
      setOS('dark');
      setMode(MODES.SYSTEM);
      toggleTheme();
      eq(getMode(), MODES.LIGHT, 'pinned first');

      toggleTheme();
      eq(getMode(), MODES.SYSTEM, 'mode after toggling back onto the OS theme');
      eq(getPaintedTheme(), 'dark', 'painted theme after returning to system');
    });

    run('every toggle flips what is on screen', () => {
      setOS('light');
      setMode(MODES.SYSTEM);
      let previous = getPaintedTheme();
      for (let i = 0; i < 4; i++) {
        toggleTheme();
        const now = getPaintedTheme();
        if (now === previous) {
          throw new Error(`toggle ${i + 1} left the theme on ${now}`);
        }
        previous = now;
      }
    });

    // --- the case a plain system↔override toggle gets wrong ---------------

    // Settings can pin a theme the OS is already showing. The invariant that a
    // pin differs from the OS no longer holds, so the toggle has to compare
    // against the remembered OS setting rather than assume.
    run('a pin that matches the OS still flips visibly', () => {
      setOS('light');
      setMode(MODES.SYSTEM);
      eq(getPaintedTheme(), 'light', 'painted before Settings pins it');

      setMode(MODES.LIGHT); // as if chosen by name in Settings
      toggleTheme();
      eq(getPaintedTheme(), 'dark', 'painted after toggling off a matching pin');
      eq(getMode(), MODES.DARK, 'mode after toggling off a matching pin');
    });

    run('and one more toggle still gets back to system', () => {
      setOS('light');
      setMode(MODES.SYSTEM);
      setMode(MODES.LIGHT);
      toggleTheme();
      toggleTheme();
      eq(getMode(), MODES.SYSTEM, 'mode after flipping back');
      eq(getPaintedTheme(), 'light', 'painted after flipping back');
    });

    // --- a window that has never seen the OS setting ----------------------

    // Nothing can read the OS while a native window is pinned, so a window that
    // starts pinned may have no record at all. Falling back to the invariant
    // keeps the escape hatch: one toggle still reaches 'system'.
    run('a pinned start with no record of the OS still reaches system in one toggle', () => {
      setOS('light');
      setMode(MODES.DARK);
      localStorage.removeItem(SYSTEM_THEME_KEY);

      toggleTheme();
      eq(getMode(), MODES.SYSTEM, 'mode after the first toggle of a cold pinned window');
      eq(getPaintedTheme(), 'light', 'painted after the first toggle');
    });

    // --- the signal the button and Settings both follow -------------------

    run('a theme change announces itself with the painted theme', () => {
      setOS('dark');
      setMode(MODES.SYSTEM);

      /** @type {Array<{mode: string, theme: string}>} */
      const seen = [];
      const listener = (/** @type {Event} */ e) => seen.push(/** @type {any} */ (e).detail);
      document.addEventListener(THEME_MODE_EVENT, listener);
      try {
        toggleTheme();
      } finally {
        document.removeEventListener(THEME_MODE_EVENT, listener);
      }

      if (seen.length === 0) throw new Error('no theme-mode-changed event was dispatched');
      const last = seen[seen.length - 1];
      eq(last.mode, MODES.LIGHT, 'announced mode');
      eq(last.theme, 'light', 'announced theme');
      eq(last.theme, getPaintedTheme(), 'announced theme matches the document');
    });

    // Settings changes the same setting without going through the toggle, and
    // the header button repaints from this event alone.
    run('a mode chosen in Settings announces itself too', () => {
      setOS('dark');
      setMode(MODES.SYSTEM);

      /** @type {string[]} */
      const modes = [];
      const listener = (/** @type {Event} */ e) => modes.push(/** @type {any} */ (e).detail.mode);
      document.addEventListener(THEME_MODE_EVENT, listener);
      try {
        setMode(MODES.LIGHT);
      } finally {
        document.removeEventListener(THEME_MODE_EVENT, listener);
      }

      eq(modes[modes.length - 1], MODES.LIGHT, 'announced mode from Settings');
    });
  } finally {
    window.matchMedia = originalMatchMedia;
    setMode(originalMode);
    if (originalStoredMode === null) localStorage.removeItem(STORED_MODE_KEY);
    else localStorage.setItem(STORED_MODE_KEY, originalStoredMode);
    if (originalTheme) document.documentElement.setAttribute('data-theme', originalTheme);
    document.documentElement.style.background = originalBackground;
    if (originalSystemRecord === null) localStorage.removeItem(SYSTEM_THEME_KEY);
    else localStorage.setItem(SYSTEM_THEME_KEY, originalSystemRecord);
  }

  return { passed, failed, errors };
}
