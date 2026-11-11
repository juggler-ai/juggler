//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the first-run setup wizard.
 *
 * The wizard exists because "no providers configured" is a true statement that
 * helps nobody. What it says instead depends on which of several facts about the
 * machine disagree, and the interesting cases are all disagreements:
 *
 *   - The Claude desktop app is installed but the `claude` CLI is not. The app
 *     contains Claude Code as a tab, so the user reasonably believes they have
 *     it; Juggler drives the CLI, which is a separate download. Saying "nothing
 *     found" here reads as a denial of something they can see on their dock.
 *   - The ChatGPT app is installed and signed in, with no Codex CLI anywhere.
 *     That machine is ready to work and must not be told to install anything.
 *   - A CLI is installed but signed out. The fix is a login, not an install.
 *
 * The other assertion worth having is the "check again" button: the whole flow
 * sends people away to install something, and a button that reports the machine
 * as it was when the window opened would tell them their install had failed.
 * @module unit-tests/setup-wizard
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { chooseRoute, startSetupWizard } from '../../js/components/onboarding/setup-wizard.js';
import { fetchJson } from '../../js/services/http.js';
import { apiUrl } from '../../js/utils/api-url.js';
import {
  setLocale, registerCatalog, unregisterCatalog, isPseudoLocalized, PSEUDO_LOCALE,
} from '../../sdk/lib/i18n.js';

/**
 * Markup that holds only a product or command name, which no translation
 * changes. Commands in `<code>` are skipped wholesale.
 */
const NAMES = new Set(['Codex', 'claude', 'Codex CLI', 'GitHub Copilot', ':free', 'openrouter.ai/keys']);

/**
 * Every string the open wizard shows, one per block of text — a paragraph's
 * text is one message split around its links and emphasis, so it is judged
 * whole — plus its accessible names and titles. Names and commands are taken
 * out of the blocks first.
 * @returns {string[]} The strings.
 */
function screenStrings() {
  const root = /** @type {HTMLElement} */ (wizardRoot());
  /** @type {string[]} */
  const out = [];
  const blocks = '.onboarding-wizard-title, .onboarding-wizard-body p, .onboarding-wizard-choice-title, .onboarding-wizard-choice-detail, .onboarding-wizard-action, .onboarding-wizard-note, .onboarding-wizard-back';
  for (const el of root.querySelectorAll(blocks)) {
    const copy = /** @type {HTMLElement} */ (el.cloneNode(true));
    copy.querySelectorAll('code, strong, a').forEach((n) => {
      if (n.tagName === 'CODE' || NAMES.has((n.textContent || '').trim())) n.remove();
    });
    const text = (copy.textContent || '').trim();
    if (text) out.push(text);
  }
  for (const el of root.querySelectorAll('[aria-label], [title]')) {
    for (const attr of ['aria-label', 'title']) {
      const v = el.getAttribute(attr);
      if (v) out.push(v);
    }
  }
  return out;
}

/**
 * A detection payload with everything absent, overlaid with the case at hand.
 * @param {object} [overrides] - Fields to set for this case.
 * @returns {object} The full payload the server would send.
 */
function detection(overrides = {}) {
  return {
    claudeDesktopApp: false,
    claudeCLI: false,
    chatgptApp: false,
    codexCLI: false,
    codexSignedIn: false,
    anyProviderAvailable: false,
    providersReady: true,
    ...overrides,
  };
}

/** @returns {HTMLElement|null} The wizard overlay, if one is open. */
function wizardRoot() {
  return document.querySelector('.onboarding-wizard');
}

/** @returns {string} The visible text of the open wizard. */
function wizardText() {
  return wizardRoot()?.textContent || '';
}

/**
 * Click the wizard control whose label contains `label`. Covers both the footer
 * buttons and the choice cards in the body — from the reader's side they are the
 * same gesture, and a test that could only reach one of them would be asserting
 * about the markup rather than about the flow.
 * @param {string} label - Substring of the control's text.
 */
function clickAction(label) {
  const buttons = Array.from(wizardRoot()?.querySelectorAll('.onboarding-wizard-action, .onboarding-wizard-choice') || []);
  const button = buttons.find((b) => (b.textContent || '').includes(label));
  assert(!!button, `no wizard button matching "${label}" (saw: ${buttons.map((b) => b.textContent).join(', ')})`);
  /** @type {HTMLElement} */ (button).click();
}

/** Close any wizard left standing, so one failing case cannot fail the next. */
function clearWizard() {
  const root = wizardRoot();
  if (!root) return;
  // Click the real close button rather than yanking the element: the wizard's
  // promise is settled by the modal closing, and a root removed behind its back
  // leaves that promise pending for ever.
  const close = /** @type {HTMLElement|null} */ (root.querySelector('.onboarding-wizard-close'));
  if (close) close.click();
  else root.remove();
}

/**
 * Run the setup-wizard unit tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Tally.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  const errors = [];

  // --- 1: routing, which is the whole decision ----------------------------
  try {
    const cases = [
      {
        name: 'Claude desktop app without the CLI',
        input: { claudeDesktopApp: true },
        want: 'claudeNeedsCLI',
      },
      {
        name: 'ChatGPT app not signed in',
        input: { chatgptApp: true },
        want: 'chatgptSignIn',
      },
      {
        name: 'Codex CLI installed but signed out',
        input: { codexCLI: true },
        want: 'codexSignIn',
      },
      {
        name: 'Codex signed in but nothing serving',
        input: { chatgptApp: true, codexSignedIn: true },
        want: 'almostThere',
      },
      {
        name: 'Claude CLI present but nothing serving',
        input: { claudeCLI: true, claudeDesktopApp: true },
        want: 'almostThere',
      },
      {
        name: 'bare machine',
        input: {},
        want: 'askAccount',
      },
      {
        name: 'ChatGPT sign-in beats a Claude install',
        input: { chatgptApp: true, claudeDesktopApp: true },
        want: 'chatgptSignIn',
      },
    ];

    for (const c of cases) {
      const got = chooseRoute(detection(c.input));
      assert(got === c.want, `${c.name}: routed to "${got}", want "${c.want}"`);
    }
    passed++;
  } catch (e) {
    failed++;
    errors.push(`setup-wizard routing: ${/** @type {any} */ (e)?.message || e}`);
  }

  // --- 2: the Claude-app-without-CLI screen says the two things that matter -
  try {
    clearWizard();
    const done = startSetupWizard({
      detect: async () => detection({ claudeDesktopApp: true }),
      platform: 'darwin',
    });
    await waitFor(() => !!wizardRoot(), { description: 'the wizard never opened' });
    await waitFor(() => wizardText().includes('Claude Code'), { description: 'the Claude screen never rendered' });

    const text = wizardText();
    assert(
      /separate|command-line|CLI/i.test(text),
      'the screen never says the CLI is a separate thing from the app the user already has'
    );
    assert(
      /Pro|Max|paid/i.test(text) && /free/i.test(text),
      'the screen never says Claude Code needs a paid plan — the one fact that saves the whole evening'
    );
    assert(
      text.includes('claude.ai/install.sh'),
      'the macOS install command is missing from a screen whose only job is to get it installed'
    );
    assert(
      !!wizardRoot()?.querySelector('a[href*="code.claude.com"]'),
      'no link to the setup documentation'
    );
    clearWizard();
    await done;
    passed++;
  } catch (e) {
    failed++;
    errors.push(`setup-wizard claude-app screen: ${/** @type {any} */ (e)?.message || e}`);
  }

  // --- 3: a signed-in ChatGPT app is not told to install anything ----------
  try {
    clearWizard();
    const done = startSetupWizard({
      detect: async () => detection({ chatgptApp: true, codexSignedIn: true }),
      platform: 'darwin',
    });
    await waitFor(() => !!wizardRoot(), { description: 'the wizard never opened' });
    await waitFor(() => wizardText().length > 0, { description: 'the wizard never rendered' });

    const text = wizardText();
    assert(
      !/install\.sh|npm install|install the/i.test(text),
      'a machine that is already signed in was told to install something'
    );
    clearWizard();
    await done;
    passed++;
  } catch (e) {
    failed++;
    errors.push(`setup-wizard signed-in screen: ${/** @type {any} */ (e)?.message || e}`);
  }

  // --- 4: check again re-reads the machine and moves on --------------------
  try {
    clearWizard();
    let installed = false;
    const done = startSetupWizard({
      detect: async () =>
        installed
          ? detection({ claudeDesktopApp: true, claudeCLI: true, anyProviderAvailable: true })
          : detection({ claudeDesktopApp: true }),
      platform: 'darwin',
    });
    await waitFor(() => wizardText().includes('Claude Code'), { description: 'the Claude screen never rendered' });

    // The user goes away, installs the CLI, comes back and presses the button.
    installed = true;
    clickAction('Check again');

    const result = await done;
    assert(
      result === 'ready',
      `check again did not finish the wizard once a provider was serving, got ${JSON.stringify(result)}`
    );
    assert(!wizardRoot(), 'the wizard stayed open after setup completed');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`setup-wizard check-again: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    clearWizard();
  }

  // --- 5: check again that finds nothing keeps the user where they are -----
  try {
    clearWizard();
    const done = startSetupWizard({
      detect: async () => detection({ claudeDesktopApp: true }),
      platform: 'darwin',
    });
    await waitFor(() => wizardText().includes('Claude Code'), { description: 'the Claude screen never rendered' });

    clickAction('Check again');
    await waitFor(() => /still|not found|nothing/i.test(wizardText()), { description: 'a fruitless check said nothing at all, which reads as a button that does not work' });
    assert(!!wizardRoot(), 'a fruitless check closed the wizard');
    clearWizard();
    await done;
    passed++;
  } catch (e) {
    failed++;
    errors.push(`setup-wizard fruitless-check: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    clearWizard();
  }

  // --- 6: with no account at all, the free routes are offered --------------
  try {
    clearWizard();
    const done = startSetupWizard({
      detect: async () => detection(),
      platform: 'darwin',
    });
    await waitFor(() => !!wizardRoot(), { description: 'the wizard never opened' });
    await waitFor(() => /account/i.test(wizardText()), { description: 'the account question never rendered' });

    clickAction('None of these');
    // Waited on by the target screen's own title, not on a word the previous
    // screen also contains: "free" appears on the account question too, so
    // waiting for that passes immediately and asserts against the wrong screen.
    await waitFor(() => wizardText().includes('Free ways to start'), {
      description: 'choosing "no account" never reached anything free to run',
    });
    const text = wizardText();
    assert(
      /OpenRouter/i.test(text),
      'the free-options screen never mentions OpenRouter, which needs no payment method'
    );
    clearWizard();
    await done;
    passed++;
  } catch (e) {
    failed++;
    errors.push(`setup-wizard free-options: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    clearWizard();
  }

  // --- 7: back returns to the screen actually come from -------------------
  try {
    clearWizard();
    const done = startSetupWizard({
      detect: async () => detection(),
      platform: 'darwin',
    });
    await waitFor(() => /What do you have/i.test(wizardText()), {
      description: 'the account question never rendered',
    });
    assert(
      !wizardRoot()?.querySelector('.onboarding-wizard-back'),
      'the first screen offered a back control, with nothing behind it to go back to'
    );

    clickAction('None of these');
    await waitFor(() => wizardText().includes('Free ways to start'), {
      description: 'the free-options screen never opened',
    });

    const back = /** @type {HTMLElement|null} */ (wizardRoot()?.querySelector('.onboarding-wizard-back'));
    assert(!!back, 'no back control on a screen reached from another one');
    /** @type {HTMLElement} */ (back).click();
    await waitFor(() => /What do you have/i.test(wizardText()), {
      description: 'back did not return to the account question',
    });
    clearWizard();
    await done;
    passed++;
  } catch (e) {
    failed++;
    errors.push(`setup-wizard back: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    clearWizard();
  }

  // --- 8: under en-XA every screen is pseudo-localised ---------------------
  // Each machine state's first screen (after a fruitless check, so its note
  // shows too), and every screen the account question and the free routes
  // lead to.
  const NS = 'setup-wizard-test';
  const body = await fetchJson(apiUrl(`/i18n/catalog?locale=${PSEUDO_LOCALE}`));
  registerCatalog(NS, PSEUDO_LOCALE, body?.messages || {});
  const previous = setLocale(PSEUDO_LOCALE);
  try {
    clearWizard();
    /** @type {string[]} */
    const raw = [];
    let screens = 0;
    const title = () => wizardRoot()?.querySelector('.onboarding-wizard-title')?.textContent || '';
    const collect = () => {
      screens++;
      for (const s of screenStrings()) if (!isPseudoLocalized(s)) raw.push(s);
    };
    /**
     * Click something on the open screen.
     * @param {string} selector
     */
    const press = (selector) => {
      const el = /** @type {HTMLElement|null|undefined} */ (wizardRoot()?.querySelector(selector));
      assert(!!el, `nothing matches ${selector} on "${title()}"`);
      /** @type {HTMLElement} */ (el).click();
    };
    /**
     * Click something on the open screen and wait for the next screen.
     * @param {string} selector
     */
    const advance = async (selector) => {
      const before = title();
      press(selector);
      await waitFor(() => title() !== before && title() !== '', { description: `${selector} never changed screen` });
    };

    for (const state of [{ claudeCLI: true }, { codexSignedIn: true }, { chatgptApp: true }, { codexCLI: true }, { claudeDesktopApp: true }]) {
      const done = startSetupWizard({ detect: async () => detection(state), platform: 'darwin' });
      await waitFor(() => title() !== '', { description: `the wizard never opened for ${JSON.stringify(state)}` });
      press('.onboarding-wizard-action.btn-primary');
      await waitFor(() => !!wizardRoot()?.querySelector('.onboarding-wizard-note'), { description: 'a fruitless check left no note' });
      collect();
      clearWizard();
      await done;
    }

    const done = startSetupWizard({ detect: async () => detection(), platform: 'darwin' });
    await waitFor(() => title() !== '', { description: 'the account question never opened' });
    collect();
    for (let i = 0; i < 4; i++) {
      await advance(`[data-wiz-choice="${i}"]`);
      collect();
      if (i === 3) {
        for (let j = 0; j < 3; j++) {
          await advance(`[data-wiz-choice="${j}"]`);
          collect();
          await advance('.onboarding-wizard-back');
        }
      }
      await advance('.onboarding-wizard-back');
    }
    clearWizard();
    await done;

    assert(screens === 13, `visited ${screens} screens, expected 13`);
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify([...new Set(raw)])}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`setup-wizard en-XA: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    clearWizard();
    setLocale(previous);
    unregisterCatalog(NS);
  }

  return { passed, failed, errors };
}
