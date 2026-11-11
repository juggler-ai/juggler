//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * First-run setup — what to do when Juggler has no provider to talk to.
 *
 * "No providers configured" is true and useless. What actually helps depends on
 * which facts about the machine disagree with each other, and the disagreements
 * are the whole point:
 *
 *   - The Claude desktop app is installed, the `claude` CLI is not. The app has
 *     a Code tab of its own, so the user believes they have Claude Code; Juggler
 *     drives the CLI, a separate download. Reporting "nothing found" here denies
 *     something they can see on their dock.
 *   - The ChatGPT app is installed and signed in, with no Codex CLI anywhere.
 *     Nothing needs installing: the app writes the same login the CLI would.
 *   - A CLI is installed but signed out. The fix is a login, not an install.
 *
 * Every screen that sends someone away ends in "Check again", which re-reads the
 * machine rather than repeating what was true at launch.
 * @module components/onboarding/setup-wizard
 */

import { fetchJson } from '../../services/http.js';
import { presentWizard } from './step-modal.js';
import { apiUrl } from '../../utils/api-url.js';
import { escapeHtml } from '../../../sdk/lib/html.js';
import { t, markForTranslation, htmlSlots, withHtml } from '../../../sdk/lib/i18n.js';

/** Where to read the current state of the machine. */
const DETECT_URL = apiUrl('/onboarding/detect');

/**
 * The preference that stops this asking again. A user preference rather than a
 * device or project one: it records a decision about the person's setup, which
 * does not change because they opened a different folder.
 */
export const ONBOARDING_DISMISSED_PREF = 'onboardingDismissed';

/** Anthropic's own setup page — the install methods, kept current by them. */
const CLAUDE_SETUP_URL = 'https://code.claude.com/docs/en/setup';
/** Where the ChatGPT desktop app comes from. Codex is a mode inside it. */
const CHATGPT_DOWNLOAD_URL = 'https://chatgpt.com/download/';
/** The Codex CLI's own page, for anyone who would rather have the terminal. */
const CODEX_CLI_URL = 'https://learn.chatgpt.com/docs/codex/cli';
/** OpenRouter's key page, which is what their docs hand a new user. */
const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';

/**
 * The routes offered to someone with no AI account at all, in the order shown.
 * Ordering is a judgement about which is likeliest to leave them working, so it
 * lives in one list rather than being spelled out in the markup. Titles and
 * details are English source text, translated where the cards are drawn.
 */
const FREE_ROUTES = [
  {
    title: markForTranslation('A free ChatGPT account'),
    detail: markForTranslation('Codex is included in every ChatGPT plan, the free one included. Install the app, sign in, done.'),
    step: 'chatgptAccount',
  },
  {
    title: markForTranslation('A GitHub account'),
    detail: markForTranslation(
      'GitHub Copilot has a free plan, and it is the only one Juggler can sign you into without leaving this window. Model choice is limited on it.'),
    step: 'copilotAccount',
  },
  {
    title: markForTranslation('Neither, and no card'),
    detail: markForTranslation(
      'OpenRouter serves some models free — no payment method, around 50 requests a day. You paste an API key.'),
    step: 'openrouterAccount',
  },
];

/**
 * An external link for a step body.
 * @param {string} href - A constant URL.
 * @param {string} html - The link's content, already escaped.
 * @returns {string} The markup.
 */
function externalLink(href, html) {
  return `<a href="${href}" target="_blank" rel="noreferrer">${html}</a>`;
}

/**
 * Decide which screen a machine should land on.
 *
 * Exported because it is the entire decision this module makes, and it is worth
 * testing on its own — every screen below is just prose attached to one of these
 * names. Ordered by how little the user has left to do: a login beats an
 * install, and an install of something they already pay for beats shopping.
 * @param {any} detection - The `/api/onboarding/detect` payload.
 * @returns {string} The name of the step to show first.
 */
export function chooseRoute(detection) {
  // Something is already installed and signed in, yet nothing is serving a
  // model: the provider is switched off, or its login has lapsed. Either way
  // there is nothing to install and the settings panel is where the answer is.
  if (detection.claudeCLI || detection.codexSignedIn) return 'almostThere';
  // A sign-in inside an app that is already open, with nothing to download.
  if (detection.chatgptApp) return 'chatgptSignIn';
  // Same login, but it has to be made from a terminal.
  if (detection.codexCLI) return 'codexSignIn';
  // They have Claude, but not the part Juggler can drive.
  if (detection.claudeDesktopApp) return 'claudeNeedsCLI';
  return 'askAccount';
}

/**
 * Read the machine.
 * @param {boolean} refresh - Discard memoised detection first. Used by "check
 *   again", where the machine has changed since the last answer.
 * @returns {Promise<any>} The detection payload.
 */
async function fetchDetection(refresh) {
  return fetchJson(refresh ? `${DETECT_URL}?refresh=1` : DETECT_URL);
}

/**
 * Show the first-run setup flow.
 * @param {object} [opts]
 * @param {(refresh: boolean) => Promise<any>} [opts.detect] - Machine reader.
 * @param {string} [opts.platform] - `darwin`, `windows` or `linux`. Defaults to
 *   what the window chrome was told, so the install command matches the machine.
 * @param {(tab: string) => void} [opts.openProviderSettings] - Escape hatch to
 *   the settings panel, for the routes this flow deliberately does not automate.
 * @returns {Promise<any>} `'ready'` once a provider is serving, `'settings'` if
 *   the user left for the settings panel, `undefined` if they dismissed it.
 */
export async function startSetupWizard({
  detect = fetchDetection,
  platform = document.documentElement.dataset.windowPlatform || 'darwin',
  openProviderSettings,
} = {}) {
  const first = await detect(false);
  // Nothing to say: something already works.
  if (first?.anyProviderAvailable) return 'ready';

  const state = {
    detection: first,
    route: chooseRoute(first),
    /** Set once a "check again" has come back empty, so the screen can say so. */
    checkedInVain: false,
  };

  const isWindows = platform === 'windows';
  const claudeInstall = isWindows
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash';
  const codexInstall = isWindows
    ? 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'
    : 'curl -fsSL https://chatgpt.com/codex/install.sh | sh';

  /**
   * The markup a step's prose refers to by `{name}`. Each paragraph is one
   * message; a product or command name, or a link, sits in it as a placeholder
   * so that no message carries a tag (see htmlSlots). Names stay as written; a
   * link's text is a message of its own.
   * @type {Record<string, string>}
   */
  const markup = {
    codex: '<strong>Codex</strong>',
    claude: '<strong>claude</strong>',
    copilot: '<strong>GitHub Copilot</strong>',
    free: '<strong>:free</strong>',
    paidPlan: `<strong>${escapeHtml(t('Claude Code needs a paid Claude plan'))}</strong>`,
    setupGuide: externalLink(CLAUDE_SETUP_URL, escapeHtml(t('Anthropic\'s setup guide'))),
    chatgptApp: externalLink(CHATGPT_DOWNLOAD_URL, escapeHtml(t('ChatGPT desktop app'))),
    codexCLI: externalLink(CODEX_CLI_URL, 'Codex CLI'),
    openrouterKeys: externalLink(OPENROUTER_KEYS_URL, 'openrouter.ai/keys'),
  };
  const slots = htmlSlots(markup);

  /**
   * One paragraph of a step body.
   * @param {string} message - Translated with `slots` (or `htmlSlots(markup, …)`) as its params.
   * @returns {string} The markup.
   */
  const para = (message) => `<p>${withHtml(message, markup)}</p>`;

  /** @returns {string|undefined} The small print for a check that found nothing. */
  const vainNote = () =>
    state.checkedInVain ? t('Still nothing. The change may need a new terminal, or a moment.') : undefined;

  /**
   * The action every "go and do something" screen ends with.
   * @returns {import('./step-modal.js').StepAction} The check-again button.
   */
  const checkAgainAction = () => ({
    label: t('Check again'),
    kind: 'primary',
    busyLabel: t('Checking…'),
    onSelect: async (ctx) => {
      const next = await detect(true);
      state.detection = next;
      if (next?.anyProviderAvailable) {
        ctx.finish('ready');
        return;
      }
      state.checkedInVain = true;
      const route = chooseRoute(next);
      if (route !== state.route) {
        state.route = route;
        ctx.go(route);
      } else {
        ctx.rerender();
      }
    },
  });

  /**
   * Leave for the settings panel, which owns every provider this flow does not
   * walk through by hand.
   * @returns {import('./step-modal.js').StepAction} The settings button.
   */
  const settingsAction = () => ({
    label: t('Open provider settings'),
    onSelect: (ctx) => {
      ctx.finish('settings');
      openProviderSettings?.('providers');
    },
  });

  /**
   * The way out for someone who has decided not to connect anything yet. Offered
   * only on the screens where that is a real answer — being asked this while
   * halfway through installing a CLI would be noise.
   * @returns {import('./step-modal.js').StepAction} The dismissal button.
   */
  const dismissForeverAction = () => ({
    label: t('Don\'t ask again'),
    onSelect: (ctx) => ctx.finish('dismissForever'),
  });

  /**
   * Render a list of routes as cards.
   * @param {{title: string, detail: string, step: string}[]} routes - The choices, in English source text.
   * @returns {string} The markup.
   */
  const choiceList = (routes) =>
    `<div class="onboarding-wizard-choices">${routes
      .map(
        (route, index) =>
          `<button type="button" class="onboarding-wizard-choice" data-wiz-choice="${index}">
             <span class="onboarding-wizard-choice-title">${escapeHtml(t(route.title))}</span>
             <span class="onboarding-wizard-choice-detail">${escapeHtml(t(route.detail))}</span>
           </button>`
      )
      .join('')}</div>`;

  /**
   * Wire a choice list's cards. They sit in the body rather than the footer, so
   * they are not `onboarding-wizard-action` buttons and the modal does not know about them.
   * @param {import('./step-modal.js').StepContext} ctx - Navigation.
   * @param {{step: string}[]} routes - The same list that was rendered.
   * @returns {(root: HTMLElement) => void} A mount handler for the step view.
   */
  const choiceMount = (ctx, routes) => (root) => {
    root.querySelectorAll('[data-wiz-choice]').forEach((el) => {
      el.addEventListener('click', () => {
        const route = routes[Number(/** @type {HTMLElement} */ (el).dataset.wizChoice)];
        if (route) ctx.go(route.step);
      });
    });
  };

  /** @type {Record<string, (ctx: any) => import('./step-modal.js').StepView>} */
  const steps = {
    almostThere: () => {
      const product = state.detection?.claudeCLI ? 'claude' : 'codex';
      return {
        title: t('Nearly there'),
        body: `
          ${para(t('{product, select, claude {Claude Code} other {Codex}} is installed and signed in, but nothing is serving a model yet. Usually that means the provider is switched off, or the login has lapsed.', htmlSlots(markup, { product })))}
          ${para(t('Provider settings will say which.', slots))}`,
        actions: [settingsAction(), checkAgainAction()],
        note: vainNote(),
      };
    },

    chatgptSignIn: () => ({
      title: t('Sign in to Codex'),
      body: `
        ${para(t('The ChatGPT app is on this machine but not signed in to Codex. Open it, switch to {codex}, and sign in.', slots))}
        ${para(t('Nothing else to install — Juggler reads that login directly. Codex is included in every ChatGPT plan, the free one included.', slots))}`,
      actions: [checkAgainAction(), { label: t('Use a different provider'), onSelect: (ctx) => ctx.go('askAccount') }],
      note: vainNote(),
    }),

    codexSignIn: () => ({
      title: t('Sign in to Codex'),
      body: `
        ${para(t('The Codex CLI is installed but signed out. In a terminal:', slots))}
        <code class="onboarding-wizard-command">codex login</code>
        ${para(t('Codex is included in every ChatGPT plan, the free one included.', slots))}`,
      actions: [checkAgainAction(), { label: t('Use a different provider'), onSelect: (ctx) => ctx.go('askAccount') }],
      note: vainNote(),
    }),

    claudeNeedsCLI: () => ({
      title: t('Claude Code needs its CLI'),
      body: `
        ${para(t('The Claude desktop app is installed. It has a Code tab of its own, but Juggler drives the {claude} command-line tool, which is a separate install:', slots))}
        <code class="onboarding-wizard-command">${claudeInstall}</code>
        ${para(t('{paidPlan} — Pro, Max, Team or Enterprise. The free claude.ai plan does not include it, and no amount of installing will change that.', slots))}
        ${para(t('{setupGuide} covers the other install methods.', slots))}`,
      actions: [checkAgainAction(), { label: t('Use a different provider'), onSelect: (ctx) => ctx.go('askAccount') }],
      note: vainNote(),
    }),

    askAccount: (ctx) => {
      const routes = [
        {
          title: markForTranslation('A ChatGPT account'),
          detail: markForTranslation('Any plan, including free. Codex is included with all of them.'),
          step: 'chatgptAccount',
        },
        {
          title: markForTranslation('A paid Claude plan'),
          detail: markForTranslation('Pro, Max, Team or Enterprise. Claude Code is not part of the free plan.'),
          step: 'claudeAccount',
        },
        {
          title: markForTranslation('An API key for something else'),
          detail: markForTranslation('Anthropic, OpenAI, Gemini, Mistral, a local model — settings takes keys for all of them.'),
          step: 'otherProvider',
        },
        {
          title: markForTranslation('None of these'),
          detail: markForTranslation('There are a few ways to get running for nothing.'),
          step: 'freeOptions',
        },
      ];
      return {
        title: t('What do you have?'),
        body: `${para(t('Juggler needs one model provider before it can do anything.', slots))}${choiceList(routes)}`,
        actions: [dismissForeverAction()],
        onMount: choiceMount(ctx, routes),
      };
    },

    chatgptAccount: () => ({
      title: t('Use your ChatGPT account'),
      body: `
        ${para(t('Install the {chatgptApp}, sign in, and switch to {codex}. Juggler picks that login up on its own.', slots))}
        ${para(t('If you would rather work from a terminal, the {codexCLI} shares the same login:', slots))}
        <code class="onboarding-wizard-command">${codexInstall}</code>`,
      actions: [checkAgainAction()],
      note: vainNote(),
    }),

    claudeAccount: () => ({
      title: t('Use your Claude plan'),
      body: `
        ${para(t('Juggler drives the {claude} command-line tool. Install it with:', slots))}
        <code class="onboarding-wizard-command">${claudeInstall}</code>
        ${para(t('Then run {claude} once in a terminal to sign in. {setupGuide} has the other install methods.', slots))}
        ${para(t('This needs a paid plan — Pro, Max, Team or Enterprise. The free claude.ai plan does not include Claude Code.', slots))}`,
      actions: [checkAgainAction()],
      note: vainNote(),
    }),

    otherProvider: () => ({
      title: t('Add a key'),
      body: para(t('Provider settings takes an API key for Anthropic, OpenAI, Gemini, Mistral, OpenRouter and the rest, and finds local models served by Ollama, LM Studio or llama.cpp.', slots)),
      actions: [{ ...settingsAction(), kind: 'primary' }],
    }),

    freeOptions: (ctx) => {
      return {
        title: t('Free ways to start'),
        body: `${para(t('None of these costs anything, and none of them needs a card.', slots))}${choiceList(FREE_ROUTES)}`,
        actions: [dismissForeverAction()],
        onMount: choiceMount(ctx, FREE_ROUTES),
      };
    },

    copilotAccount: () => ({
      title: t('Use GitHub Copilot'),
      body: `
        ${para(t('Copilot\'s free plan costs nothing, and Juggler can sign you in from here — no other app, no key to paste.', slots))}
        ${para(t('In provider settings, find {copilot} and choose Sign in.', slots))}
        ${para(t('Model choice is limited on the free plan.', slots))}`,
      actions: [{ ...settingsAction(), kind: 'primary' }],
    }),

    openrouterAccount: () => ({
      title: t('Use OpenRouter'),
      body: `
        ${para(t('OpenRouter serves some models free — no payment method, around 50 requests a day.', slots))}
        ${para(t('Create a key at {openrouterKeys}, then paste it into provider settings. The free models are the ones whose name ends in {free}.', slots))}`,
      actions: [{ ...settingsAction(), kind: 'primary' }],
    }),
  };

  return presentWizard({ steps, start: state.route, dismissLabel: t('Close setup') });
}
