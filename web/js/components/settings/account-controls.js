//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   https://juggler.studio
//
//   This program is free software: you can redistribute it and/or modify it under the terms of
//   the GNU Affero General Public License as published by the Free Software Foundation, either
//   version 3 of the License, or (at your option) any later version. This program is distributed
//   in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
//   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file or
//   <https://www.gnu.org/licenses/agpl-3.0.html> for full terms.

/**
 * What an account card shows in its control column, by kind of account:
 *
 * - **key** — an API key: the field, the "key is active" badge over it once one
 *   is stored, Save, and a note when the environment supplies the key instead.
 * - **oauth** — a login another app owns (the Codex CLI, an editor's Copilot):
 *   the sign-in status and a re-check, plus Copilot's own device sign-in and
 *   GitHub host.
 * - **keyless** — a CLI or a local server: anything wrong with it, a re-check,
 *   the offer to switch to a provider that suits its server better, and the
 *   server address or CLI path it may be pointed at.
 * - **endpoint** — an OpenAI-compatible endpoint: its base URL, request headers
 *   and key.
 *
 * There is no on/off switch on any of them: an account exists or it does not,
 * and taking one away is Remove, in the card's menu.
 * @module components/settings/account-controls
 */

import { openExternalURL } from '../../../sdk/lib/window-control.js';
import wsService from '../../services/websocket.js';
import providersCache from '../../services/providers-cache.js';
import { httpErrorText } from '../../services/http.js';
import * as settingsApi from '../../services/settings-api.js';
import { accountsSave, accountsSetKey } from '../../services/ops-api.js';
import { showAlert, showConfirm } from '../modal-dialog.js';
import { CHECK_SVG, REFRESH_SVG } from '../../utils/icons.js';
import { escapeHtml } from '../../../sdk/lib/html.js';
import { t } from '../../../sdk/lib/i18n.js';
import { errorText } from '../../../sdk/lib/error-utils.js';
import { providerAuthHint } from '../../utils/provider-text.js';

/** The type of a custom OpenAI-compatible endpoint. */
export const ENDPOINT_TYPE = 'openai-compatible';

/** The public GitHub host, a Copilot account's host when it names none. */
const GITHUB_HOST = 'github.com';

/**
 * What a card's controls need from the tab around them.
 * @typedef {object} ControlContext
 * @property {any} account - The account, as the list op reports it.
 * @property {() => any} provider - Its published provider status, if it has one.
 * @property {() => any} config - The /api/config payload.
 * @property {() => Promise<void>} recheck - Ask the server to look again, and
 *   redraw the card from what it publishes.
 * @property {(available: boolean, hint: string) => void} setSignedIn - Record a
 *   sign-in or sign-out this card made, and redraw it.
 * @property {(providers: any[]) => void} onSwitched - The provider list after a
 *   switch to another provider.
 * @property {() => Promise<void>} reloadConfig - Re-read config and providers
 *   without redrawing anything.
 * @property {(list: any) => void} applyList - Hand back the account list an op
 *   answered with.
 * @property {() => void} redrawModels - Rebuild the card's model list.
 * @property {(hooks: ControlHooks) => void} track - Register what the card runs
 *   for these controls.
 */

/**
 * What a card runs for its controls.
 * @typedef {object} ControlHooks
 * @property {() => void} [refresh] - Bring the control into line with what is
 *   stored, after the panel cleared the unsaved key fields.
 * @property {() => void} [dispose] - The controls are torn down.
 */

/**
 * Which controls an account takes.
 * @param {any} account - The account.
 * @param {any} provider - Its published provider status, if any.
 * @returns {'endpoint'|'oauth'|'keyless'|'key'|'none'} The kind.
 */
export function accountKind(account, provider) {
  if (account.type === ENDPOINT_TYPE) return 'endpoint';
  if (!provider) return 'none';
  if (provider.authType === 'oauth_bearer') return 'oauth';
  if (provider.configKeyName === '') return 'keyless';
  return 'key';
}

/**
 * Build the control column's contents for one account.
 * @param {ControlContext} ctx - The card context.
 * @returns {HTMLElement[]} The controls, in order.
 */
export function buildAccountControls(ctx) {
  const provider = ctx.provider();
  switch (accountKind(ctx.account, provider)) {
    case 'endpoint': return buildEndpointControls(ctx);
    case 'oauth': return buildOAuthControls(provider, ctx);
    case 'keyless': return buildKeylessControls(provider, ctx);
    case 'key': return [buildKeyField(ctx, false)];
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

/**
 * An account's API key: the field, the "key is active" badge over it once one
 * is stored, Save while something is typed, and a note when the environment
 * supplies the key instead. Every account's key is written through the
 * account's own operation, which finds its slot from the id whether or not the
 * account registered.
 * @param {ControlContext} ctx - The card context.
 * @param {boolean} optional - The account may have no key at all (an
 *   endpoint), so a stored one can be deleted without removing the account. A
 *   key that is the account is taken away with Remove, in the card's menu.
 * @returns {HTMLElement} The field.
 */
function buildKeyField(ctx, optional) {
  const { account } = ctx;
  const field = subfield(t('API key'));
  const fromEnv = () => account.keySource === 'env';

  const { wrapper, input } = wrappedInput({ ariaLabel: t('API key'), className: 'account-key-input', secret: true });
  input.id = `${account.id}-key`;

  const badge = document.createElement('span');
  badge.className = 'provider-active-badge';
  badge.innerHTML = `${CHECK_SVG}<span>${escapeHtml(t('key is active'))}</span>`;

  const buttons = document.createElement('div');
  buttons.className = 'provider-buttons';

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'btn btn-sm btn-primary account-key-save';
  saveButton.textContent = t('Save');

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'btn btn-sm btn-danger account-key-delete';
  deleteButton.textContent = t('Delete');

  const hint = document.createElement('div');
  hint.className = 'key-source-hint';

  /** Bring the row into line with what is stored. */
  const refresh = () => {
    const typed = input.value.trim() !== '';
    const stored = account.keySource === 'credentials';
    input.disabled = fromEnv();
    input.placeholder = fromEnv()
      ? t('using ${name}', { name: account.envVarName })
      : (stored ? '' : (optional ? t('optional — some endpoints need none') : t('enter a key')));
    saveButton.hidden = !(typed && !fromEnv());
    deleteButton.hidden = !(optional && stored);
    badge.hidden = !(stored && !typed);
    hint.hidden = !fromEnv();
    hint.textContent = fromEnv() ? t('Using environment variable ${name}', { name: account.envVarName }) : '';
  };
  input.addEventListener('input', refresh);
  ctx.track({ refresh });

  /**
   * @param {string} apiKey - The key to store, or '' to clear the stored one.
   */
  const writeKey = async (apiKey) => {
    field.setStatus(t('Saving…'), 'pending');
    try {
      // The server republishes the providers, so every model menu follows.
      const list = await accountsSetKey({ id: account.id, apiKey });
      field.setStatus(apiKey ? t('Saved') : t('Deleted'), 'ok');
      input.value = '';
      const stored = (list?.accounts || []).find((/** @type {any} */ a) => a.id === account.id);
      if (stored) account.keySource = stored.keySource;
      refresh();
      ctx.applyList(list);
    } catch (error) {
      field.setStatus(t('Couldn’t save the key. {error}', { error: errorText(error) }), 'error');
    }
  };
  saveButton.addEventListener('click', () => {
    const apiKey = input.value.trim();
    if (apiKey) writeKey(apiKey);
  });
  deleteButton.addEventListener('click', () => writeKey(''));

  buttons.appendChild(saveButton);
  buttons.appendChild(deleteButton);
  wrapper.appendChild(badge);
  wrapper.appendChild(buttons);
  field.body.appendChild(wrapper);
  field.body.appendChild(hint);
  refresh();
  return field.element;
}

// ---------------------------------------------------------------------------
// What an account says about itself
// ---------------------------------------------------------------------------

/**
 * An account's status line, the command that signs it in when it is not, and
 * a button group ending in the re-check. Shared by a login-backed account and
 * by a CLI or server that is reporting a hint.
 * @param {any} provider - The published provider status.
 * @param {ControlContext} ctx - The card context.
 * @param {{text: string, subject: 'sign-in'|'status', buttons?: HTMLElement[], between?: HTMLElement[]}} opts
 *   subject picks the re-check's wording (a keyless row's hint may equally be
 *   about a CLI that isn't installed); buttons go before the re-check; between
 *   goes between the status line and the rest.
 * @returns {{status: HTMLElement, elements: HTMLElement[]}} The status line,
 *   and every element in order.
 */
function statusBlock(provider, ctx, { text, subject, buttons = [], between = [] }) {
  const status = document.createElement('div');
  status.className = 'key-source-hint account-status';
  status.id = `${ctx.account.id}-status`;
  status.textContent = text;

  const group = document.createElement('div');
  group.className = 'provider-buttons';
  for (const button of buttons) group.appendChild(button);
  group.appendChild(buildRecheckButton(provider, status, ctx, subject));

  const elements = [status, ...between];
  if (ctx.account.signInCommand && !provider.available) elements.push(buildSignInCommand(ctx.account.signInCommand));
  elements.push(group);
  return { status, elements };
}

/**
 * The re-check button.
 * @param {any} provider - The published provider status.
 * @param {HTMLElement} status - The status line it reports into while it runs.
 * @param {ControlContext} ctx - The card context.
 * @param {'sign-in'|'status'} subject - What is being re-checked, for its label.
 * @returns {HTMLButtonElement} The button.
 */
function buildRecheckButton(provider, status, ctx, subject) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-icon btn-icon-lg btn-secondary settings-recheck-btn';
  const name = provider.displayName;
  btn.title = subject === 'status' ? t('Re-check status') : t('Re-check sign-in');
  btn.setAttribute('aria-label', subject === 'status'
    ? t('Re-check {name} status', { name })
    : t('Re-check {name} sign-in', { name }));
  btn.innerHTML = REFRESH_SVG;
  btn.addEventListener('click', async () => {
    const original = status.textContent;
    btn.disabled = true;
    btn.classList.add('spinning');
    status.textContent = subject === 'status' ? t('Checking status\u2026') : t('Checking sign-in\u2026');
    try {
      // The redraw that follows replaces this button and the status line, so
      // the success path has nothing to put back.
      await ctx.recheck();
    } catch (err) {
      btn.disabled = false;
      btn.classList.remove('spinning');
      status.textContent = original;
      await showAlert(err instanceof Error ? errorText(err) : t('Refresh failed'), provider.displayName);
    }
  });
  return btn;
}

/**
 * The command that signs an account in, to copy into a terminal. Juggler never
 * signs anyone in itself: the login belongs to the CLI, which is run as the
 * account's own and asked to log in there.
 * @param {string} command - The command, as the server spells it for its platform.
 * @returns {HTMLElement} The block.
 */
function buildSignInCommand(command) {
  const block = document.createElement('div');
  block.className = 'account-signin';

  const label = document.createElement('div');
  label.className = 'account-signin-label';
  label.textContent = t('To sign in, run this in a terminal:');
  block.appendChild(label);

  const row = document.createElement('div');
  row.className = 'account-signin-command';
  const code = document.createElement('code');
  code.textContent = command;
  row.appendChild(code);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn-xs btn-ghost account-signin-copy';
  copy.textContent = t('Copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(command);
      copy.textContent = t('Copied');
    } catch {
      // Selecting it by hand still works; the button just says nothing.
    }
  });
  row.appendChild(copy);
  block.appendChild(row);
  return block;
}

// ---------------------------------------------------------------------------
// A login another app owns
// ---------------------------------------------------------------------------

/**
 * The sign-in status and re-check of an account whose login lives in another
 * app, plus Copilot's own sign-in. A signed-out account keeps its card: the
 * status line says how to sign in.
 * @param {any} provider - The published provider status.
 * @param {ControlContext} ctx - The card context.
 * @returns {HTMLElement[]} The controls.
 */
function buildOAuthControls(provider, ctx) {
  // The hint is the server's own wording, translated where it sent a message.
  const text = providerAuthHint(provider) || (provider.available ? t('Signed in') : t('Sign in to continue'));
  if (provider.signInMethod !== 'github_device') {
    // The login lives in an external app, so re-checking picks up a fresh or
    // expired sign-in without relaunching Juggler.
    return statusBlock(provider, ctx, { text, subject: 'sign-in' }).elements;
  }

  // Copilot's device flow is the one sign-in Juggler runs itself. Enterprise
  // Cloud users point an account at their <tenant>.ghe.com instead of
  // github.com, for both editor-login reuse and the in-app sign-in.
  const host = buildGitHubHostField(ctx);
  const button = document.createElement('button');
  button.type = 'button';
  const block = statusBlock(provider, ctx, { text, subject: 'sign-in', buttons: [button], between: [host.element] });
  if (provider.available) {
    button.className = 'btn btn-sm btn-danger';
    button.textContent = t('Sign out');
    button.title = ctx.account.isDefault
      ? t('Sign out of the GitHub login stored by Juggler')
      : t('Sign out of this account’s GitHub login');
    button.addEventListener('click', () => copilotSignOut(button, ctx));
  } else {
    button.className = 'btn btn-sm btn-primary';
    button.textContent = t('Sign in with GitHub');
    button.addEventListener('click', () => copilotSignIn(provider, button, block.status, host, ctx));
  }
  return block.elements;
}

/**
 * The GitHub host of a Copilot account. The default account's is Juggler's
 * preferred host; a further account's is one of its own settings, so signing
 * it in to an Enterprise Cloud tenant leaves the default on github.com. A
 * change is saved and the account re-checked, so an editor login on that host
 * is picked up.
 * @param {ControlContext} ctx - The card context.
 * @returns {{element: HTMLElement, commit: () => Promise<string>}} The field,
 *   and what saves a host typed but not yet saved, answering the saved host.
 */
function buildGitHubHostField(ctx) {
  const { account } = ctx;
  const field = subfield(t('GitHub host'));
  const { wrapper, input } = wrappedInput({
    value: account.settings?.host || GITHUB_HOST,
    placeholder: t('{host} or your-tenant.ghe.com', { host: GITHUB_HOST }),
    ariaLabel: t('GitHub host'),
    className: 'account-copilot-host',
  });
  field.body.appendChild(wrapper);

  let saved = input.value;
  if (account.isDefault) {
    // Best-effort prefill: a failure keeps the default host.
    settingsApi.getCopilotHost({ fallback: null }).then((d) => {
      if (d && d.success && d.host && input.value === saved) input.value = saved = d.host;
    });
  }

  /** @type {(host: string) => Promise<void>} */
  const write = account.isDefault
    ? async (host) => {
      const data = await settingsApi.setCopilotHost(host);
      if (!data?.success) throw new Error(data?.error || t('Failed to set host'));
    }
    : async (host) => { ctx.applyList(await accountsSave({ id: account.id, settings: { host } })); };

  const commit = async () => {
    const host = input.value.trim() || GITHUB_HOST;
    if (host === saved) return saved;
    field.setStatus(t('Saving…'), 'pending');
    try {
      await write(host);
    } catch (error) {
      field.setStatus(httpErrorText(error, t('Failed to set host')), 'error');
      throw error;
    }
    saved = host;
    field.setStatus(t('Saved'), 'ok');
    await ctx.recheck();
    return saved;
  };
  onCommit(input, async () => {
    try {
      await commit();
    } catch {
      // The field's status line already says what went wrong.
    }
  });
  return { element: field.element, commit };
}

/**
 * Run the GitHub OAuth device flow: save a host typed but not yet saved, start
 * the flow there, open the verification page with the user code (copied to the
 * clipboard), then poll until GitHub authorizes.
 * @param {any} provider - The published provider status.
 * @param {HTMLButtonElement} button - The Sign in button.
 * @param {HTMLElement} status - The status line.
 * @param {{commit: () => Promise<string>}} hostField - The GitHub host field.
 * @param {ControlContext} ctx - The card context.
 */
async function copilotSignIn(provider, button, status, hostField, ctx) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = t('Starting\u2026');
  try {
    // The token is stored for the account's saved host, so the flow runs
    // against that host and no other.
    const host = await hostField.commit();
    const data = await settingsApi.startCopilotDeviceLogin(host);
    if (!data?.success) throw new Error(data?.error || t('Failed to start sign-in'));

    const { userCode, verificationUri, deviceCode, interval } = data;
    try { await navigator.clipboard.writeText(userCode); } catch { /* clipboard is best-effort */ }
    if (verificationUri) openExternalURL(verificationUri);
    button.textContent = t('Waiting\u2026');
    status.textContent = t('Enter code {code} at {url} (opened in your browser, copied to clipboard). Waiting for authorization\u2026',
      { code: userCode, url: verificationUri });

    await pollCopilotLogin(deviceCode, Number(interval) || 5, host, ctx.account.id);
    ctx.setSignedIn(true, t('Signed in with GitHub'));
  } catch (err) {
    status.textContent = providerAuthHint(provider) || t('Sign in to continue');
    button.disabled = false;
    button.textContent = originalText;
    // i18n-ignore: a product name
    await showAlert(httpErrorText(err, t('Sign-in failed')), 'GitHub Copilot');
  }
}

/**
 * Poll the device-login endpoint until it resolves. Resolves on authorization;
 * throws on expiry, denial, error, or timeout.
 * @param {string} deviceCode - The device code GitHub issued.
 * @param {number} interval - Seconds between polls (GitHub-provided).
 * @param {string} host - GitHub host the flow was started against.
 * @param {string} account - The account signing in.
 */
async function pollCopilotLogin(deviceCode, interval, host, account) {
  let delayMs = Math.max(2, interval) * 1000;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delayMs));
    const data = await settingsApi.pollCopilotDeviceLogin(deviceCode, host, account);
    if (!data?.success) throw new Error(data?.error || t('Sign-in check failed'));
    switch (data.status) {
      case 'authorized': return;
      case 'pending': break;
      case 'slow_down': delayMs += 5000; break;
      case 'expired': throw new Error(t('The code expired before you authorized. Please try again.'));
      case 'denied': throw new Error(t('Access was denied on GitHub.'));
      default: throw new Error(t('Unexpected sign-in status from GitHub.'));
    }
  }
  throw new Error(t('Timed out waiting for authorization.'));
}

/**
 * Sign out of the GitHub login Juggler stored for an account. An editor's login
 * is left alone — and the default account goes on using one, where a further
 * account never borrows another login.
 * @param {HTMLButtonElement} button - The Sign out button.
 * @param {ControlContext} ctx - The card context.
 */
async function copilotSignOut(button, ctx) {
  const ok = await showConfirm(ctx.account.isDefault
    ? t('Sign out of the GitHub login stored by Juggler? Copilot becomes unavailable until you sign in again (any editor Copilot login on this machine will still be used).')
    : t('Sign out of {name}? Its models are unavailable until you sign it in again.', { name: ctx.account.displayName || ctx.account.id }),
  t('Sign out'));
  if (!ok) return;
  button.disabled = true;
  try {
    const data = await settingsApi.signOutCopilot(ctx.account.id);
    if (!data?.success) throw new Error(data?.error || t('Sign out failed'));
    ctx.setSignedIn(false, '');
  } catch (err) {
    button.disabled = false;
    // i18n-ignore: a product name
    await showAlert(httpErrorText(err, t('Sign out failed')), 'GitHub Copilot');
  }
}

// ---------------------------------------------------------------------------
// A CLI or a local server
// ---------------------------------------------------------------------------

/**
 * The local servers whose address is a setting: the /api/config field it
 * round-trips through, the raw credential it is saved as, and the address used
 * when it is empty.
 */
export const SERVER_ADDRESSES = /** @type {Record<string, {configField: string, configKey: string, address: string}>} */ ({
  ollama: { configField: 'ollamaHost', configKey: 'ollama_host', address: 'http://localhost:11434' },
  llamacpp: { configField: 'llamacppHost', configKey: 'llamacpp_host', address: 'http://127.0.0.1:8080' },
  localai: { configField: 'localaiHost', configKey: 'localai_host', address: 'http://127.0.0.1:8080' },
  lmstudio: { configField: 'lmstudioHost', configKey: 'lmstudio_host', address: 'http://127.0.0.1:1234' },
});

/** Where the claude CLI's path is kept, for an install auto-detection cannot reach. */
export const CLAUDE_PATH = { configField: 'claudecodeBinaryPath', configKey: 'claudecode_binary_path' };

/**
 * The controls of a CLI or local-server account: what is wrong with it, if
 * anything, with a re-check; the offer to switch to a provider that suits its
 * server better; and the address or CLI path it may be pointed at.
 * @param {any} provider - The published provider status.
 * @param {ControlContext} ctx - The card context.
 * @returns {HTMLElement[]} The controls.
 */
function buildKeylessControls(provider, ctx) {
  /** @type {HTMLElement[]} */
  const out = [];
  // A CLI that is installed yet not signed in has nowhere else to say so: its
  // models are gone from the menu, and without this the first news of it is a
  // failed turn. Shown only when there is something to report.
  const authHint = providerAuthHint(provider);
  if (authHint) out.push(...statusBlock(provider, ctx, { text: authHint, subject: 'status' }).elements);

  // A provider pointed at a server another provider understands better —
  // LocalAI aimed at LM Studio — works, but assumes every model's window. Once
  // it is off, there is nothing left to switch away from.
  if (provider.switchTo && (provider.credentialed ?? provider.available)) out.push(buildSwitchNotice(provider, ctx));

  const server = SERVER_ADDRESSES[provider.name];
  if (server) {
    out.push(buildConfigRow(ctx.config, {
      ...server,
      inputId: `${provider.name}-host-input`,
      placeholder: server.address,
      ariaLabel: t('Server address'),
      savedText: (value) => (value
        ? t('Saved. Pointing at {address}.', { address: value })
        : t('Saved. Using default ({address}).', { address: server.address })),
    }));
  }
  // Empty falls back to JUGGLER_CLAUDE_PATH, then auto-detection.
  if (provider.name === 'claudecode') {
    out.push(buildConfigRow(ctx.config, {
      ...CLAUDE_PATH,
      inputId: 'claudecode-binary-input',
      placeholder: t('CLI path (leave blank for auto)'),
      ariaLabel: t('claude CLI path'),
      savedText: (value) => (value ? t('Saved. Using {path}.', { path: value }) : t('Saved. Auto-detecting the claude CLI.')),
    }));
  }
  return out;
}

/**
 * The notice offering a switch to the provider `switchTo` names: why, the
 * button, and what the switch does. The server republishes the provider list
 * once it has switched, and the tab redraws from that list.
 * @param {any} provider - Provider status carrying `switchTo`.
 * @param {ControlContext} ctx - The card context.
 * @returns {HTMLElement} The notice.
 */
function buildSwitchNotice(provider, ctx) {
  const target = provider.switchTo;
  const notice = document.createElement('div');
  notice.className = 'provider-switch-notice';

  const reason = document.createElement('div');
  reason.className = 'provider-switch-reason';
  reason.textContent = target.reason;
  notice.appendChild(reason);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm btn-primary';
  button.textContent = t('Switch to {name}', { name: target.displayName });
  notice.appendChild(button);

  const effect = document.createElement('div');
  effect.className = 'provider-switch-effect';
  effect.textContent = t('Turns {from} off and {to} on at the same address, bringing your context-window settings and hidden models with it. Conversations already using {from} keep it until you pick their model again.',
    { from: provider.displayName, to: target.displayName });
  notice.appendChild(effect);

  const status = document.createElement('div');
  status.className = 'provider-switch-status';
  notice.appendChild(status);

  /** @type {(() => void)|null} */
  let watch = null;
  const unwatch = () => {
    watch?.();
    watch = null;
  };
  // Dropped with the card's controls, so a switch whose list never comes
  // leaves nothing listening.
  ctx.track({ dispose: unwatch });

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = t('Switching…');
    // The tab is redrawn from the list that shows the switch, whenever that
    // arrives. Not by a deadline: the server asks the provider again before
    // acting, and a guess at how long that takes is a guess at the machine.
    // Taken before asking, or the push can land first.
    unwatch();
    watch = wsService.on('providers-update', (/** @type {unknown} */ data) => {
      if (!Array.isArray(data) || !data.some((p) => p.name === provider.name && !p.credentialed)) return;
      unwatch();
      ctx.onSwitched(data);
    });
    try {
      await providersCache.switchProvider(provider.name);
      status.textContent = t('Switched. {name} is on.', { name: target.displayName });
    } catch (err) {
      unwatch();
      button.disabled = false;
      status.textContent = httpErrorText(err, t("Couldn't switch provider"));
    }
  });
  return notice;
}

/**
 * A value kept as a raw credential — a local server's address, the claude
 * CLI's path — saved on blur or Enter. Empty clears it, falling back to the
 * environment or the default.
 * @param {() => any} config - The /api/config payload.
 * @param {{inputId: string, configField: string, configKey: string, placeholder: string, ariaLabel: string, savedText: (value: string) => string}} opts
 *   configField is the /api/config field the value round-trips through,
 *   configKey the raw credential the PUT posts, savedText what to say once it
 *   is saved.
 * @returns {HTMLElement} The row.
 */
function buildConfigRow(config, { inputId, configField, configKey, placeholder, ariaLabel, savedText }) {
  const row = document.createElement('div');
  const { wrapper, input } = wrappedInput({ value: config()[configField] || '', placeholder, ariaLabel });
  input.id = inputId;
  row.appendChild(wrapper);

  const status = document.createElement('div');
  status.className = 'key-source-hint';
  row.appendChild(status);

  onCommit(input, async () => {
    const value = input.value.trim();
    if (value === (config()[configField] || '')) return;
    status.textContent = t('Saving…');
    try {
      await settingsApi.setConfig(configKey, value);
      config()[configField] = value;
      status.textContent = savedText(value);
    } catch (err) {
      console.error(`[SettingsPanel] Failed to save ${configKey}:`, err);
      status.textContent = t('Failed to save.');
    }
  });
  return row;
}

// ---------------------------------------------------------------------------
// An OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

/**
 * A labelled field in a card's control column, with a status note that floats
 * on the label line so the row height never moves.
 * @param {string} label - Visible label.
 * @returns {{element: HTMLElement, body: HTMLElement, setStatus: (text: string, kind?: 'ok'|'error'|'pending') => void}}
 *   The field, the element to put controls in, and its status setter.
 */
export function subfield(label) {
  const element = document.createElement('div');
  element.className = 'provider-subfield';

  const labelEl = document.createElement('label');
  labelEl.className = 'provider-subfield-label';
  labelEl.textContent = label;
  element.appendChild(labelEl);

  const status = document.createElement('div');
  status.className = 'provider-subfield-status';
  element.appendChild(status);

  const body = document.createElement('div');
  element.appendChild(body);

  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let statusTimer;
  /**
   * @param {string} text - What to say, or '' to say nothing.
   * @param {'ok'|'error'|'pending'} [kind] - How to colour it.
   */
  const setStatus = (text, kind) => {
    clearTimeout(statusTimer);
    status.textContent = text;
    if (kind) status.dataset.kind = kind; else delete status.dataset.kind;
    // The saved value stays on screen, so a confirmation is a light touch that
    // fades. An error stays until the next attempt replaces it.
    if (kind === 'ok') {
      statusTimer = setTimeout(() => {
        status.textContent = '';
        delete status.dataset.kind;
      }, 2000);
    }
  };

  return { element, body, setStatus };
}

/**
 * A text input in the bordered wrapper the key fields use, so every input on a
 * card carries the same border and focus ring.
 * @param {{value?: string, placeholder?: string, ariaLabel: string, className?: string, secret?: boolean}} opts
 *   secret leaves off the class that keeps a value across the panel closing.
 * @returns {{wrapper: HTMLElement, input: HTMLInputElement}} The wrapper and its input.
 */
export function wrappedInput({ value, placeholder, ariaLabel, className, secret }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'provider-input-wrapper field-input';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = `${secret ? '' : 'settings-value-input'} ${className || ''}`.trim();
  input.value = value || '';
  if (placeholder) input.placeholder = placeholder;
  input.setAttribute('aria-label', ariaLabel);
  input.autocomplete = 'off';
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.spellcheck = false;
  wrapper.appendChild(input);
  return { wrapper, input };
}

/**
 * Save when the user has finished with a field: on the way out of it, or on
 * Enter, which is the same thing said explicitly.
 * @param {HTMLInputElement} input - The field.
 * @param {() => void|Promise<void>} save - What to do with it.
 */
function onCommit(input, save) {
  input.addEventListener('blur', () => { save(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
      input.blur();
    }
  });
}

/**
 * An endpoint's base URL, request headers and key.
 * @param {ControlContext} ctx - The card context.
 * @returns {HTMLElement[]} The controls.
 */
function buildEndpointControls(ctx) {
  const { account } = ctx;
  /**
   * Write some of this endpoint's settings, reporting into a field's status
   * line, then hand the list back.
   * @param {Record<string, any>} settings - The settings to change.
   * @param {(text: string, kind?: 'ok'|'error'|'pending') => void} setStatus - Where to report.
   * @param {boolean} [remodel] - The change alters what the endpoint serves,
   *   so the model list under it belongs to the old one.
   * @returns {Promise<boolean>} Whether the write landed.
   */
  const saveSettings = async (settings, setStatus, remodel = false) => {
    setStatus(t('Saving…'), 'pending');
    try {
      // The server republishes the providers, so every model menu follows.
      const list = await accountsSave({ id: account.id, settings });
      ctx.applyList(list);
      if (remodel) {
        await ctx.reloadConfig();
        ctx.redrawModels();
      }
      setStatus(t('Saved'), 'ok');
      return true;
    } catch (error) {
      setStatus(t('Couldn’t save. {error}', { error: errorText(error) }), 'error');
      return false;
    }
  };
  return [
    buildURLField(account, saveSettings),
    buildHeadersField(account, saveSettings),
    buildKeyField(ctx, true),
  ];
}

/**
 * The endpoint itself. Models come from whatever this URL's model list
 * returns, so it is the field that decides whether the endpoint works at all.
 * @param {any} account - The account.
 * @param {(settings: Record<string, any>, setStatus: any, remodel?: boolean) => Promise<boolean>} saveSettings - The writer.
 * @returns {HTMLElement} The field.
 */
function buildURLField(account, saveSettings) {
  const field = subfield(t('Base URL'));
  const { wrapper, input } = wrappedInput({
    value: account.settings?.baseURL || '',
    placeholder: 'https://gateway.example.com/v1', // i18n-ignore: an example address
    ariaLabel: t('Base URL'),
    className: 'account-url-input',
  });
  field.body.appendChild(wrapper);
  onCommit(input, async () => {
    const value = input.value.trim();
    if (value === (account.settings?.baseURL || '')) return;
    if (await saveSettings({ baseURL: value }, field.setStatus, true)) {
      account.settings = { ...account.settings, baseURL: value };
    }
  });
  return field.element;
}

/**
 * Extra headers sent with every request — a gateway's tenant or routing
 * header. Rows are shown rather than hidden behind a disclosure: most endpoints
 * have none, so the field costs one button.
 * @param {any} account - The account.
 * @param {(settings: Record<string, any>, setStatus: any, remodel?: boolean) => Promise<boolean>} saveSettings - The writer.
 * @returns {HTMLElement} The field.
 */
function buildHeadersField(account, saveSettings) {
  const field = subfield(t('Request headers'));
  const rows = document.createElement('div');
  rows.className = 'account-headers';
  field.body.appendChild(rows);

  const save = async () => {
    /** @type {Record<string, string>} */
    const headers = {};
    for (const row of Array.from(rows.querySelectorAll('.account-header-row'))) {
      const key = /** @type {HTMLInputElement} */ (row.querySelector('.account-header-name')).value.trim();
      const value = /** @type {HTMLInputElement} */ (row.querySelector('.account-header-value')).value;
      if (!key) {
        if (value.trim()) {
          field.setStatus(t('Every header needs a name.'), 'error');
          return;
        }
        continue;
      }
      headers[key] = value;
    }
    if (JSON.stringify(headers) === JSON.stringify(account.settings?.headers || {})) return;
    if (await saveSettings({ headers }, field.setStatus)) {
      account.settings = { ...account.settings, headers };
    }
  };

  /**
   * @param {string} key - Header name.
   * @param {string} value - Header value.
   * @returns {HTMLElement} The row, so a freshly added one can be focused.
   */
  const addRow = (key, value) => {
    const row = document.createElement('div');
    row.className = 'account-header-row';

    const name = wrappedInput({
      // i18n-ignore: an example header name
      value: key, placeholder: 'X-Tenant', ariaLabel: t('Header name'), className: 'account-header-name',
    });
    const val = wrappedInput({
      value,
      placeholder: t('value'),
      ariaLabel: key ? t('Value for header {name}', { name: key }) : t('Value for header being added'),
      className: 'account-header-value',
    });

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'btn btn-icon btn-icon-lg btn-secondary btn-danger-quiet account-header-remove';
    drop.textContent = '\u00d7';
    drop.setAttribute('aria-label', key ? t('Remove header {name}', { name: key }) : t('Remove header being added'));
    drop.addEventListener('click', () => {
      row.remove();
      save();
    });

    onCommit(name.input, save);
    onCommit(val.input, save);

    row.appendChild(name.wrapper);
    row.appendChild(val.wrapper);
    row.appendChild(drop);
    rows.appendChild(row);
    return row;
  };

  for (const [key, value] of Object.entries(account.settings?.headers || {})) addRow(key, String(value));

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-sm btn-secondary account-header-add';
  add.textContent = t('Add header');
  add.addEventListener('click', () => {
    const row = addRow('', '');
    /** @type {HTMLInputElement} */ (row.querySelector('.account-header-name')).focus();
  });
  field.body.appendChild(add);

  // The placeholder is filled in per request by the server (openaibase
  // sessionHeaderOpts), for gateways that want a session header of their own.
  const hint = document.createElement('div');
  hint.className = 'account-headers-hint';
  // i18n-ignore: the placeholder is literal syntax the server matches
  const placeholder = '{{sessionId}}';
  hint.textContent = t('{placeholder} in a value becomes an ID unique to each conversation.', { placeholder });
  field.body.appendChild(hint);

  return field.element;
}
