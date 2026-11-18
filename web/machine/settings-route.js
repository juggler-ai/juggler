//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Point the page's settings at the machine server (services/settings-endpoint.js),
 * as this module is evaluated: the sessions page's first import
 * (sessions-page.js), so it runs before any module that reads a setting or a
 * preference as it loads — the theme and zoom managers among them.
 *
 * It hands on the control API's credential, which the machine server's
 * settings routes take as the rest of the control API does (control-api.js).
 * @module machine/settings-route
 */

import { controlApiRoot, readPageConfig, TOKEN_HEADER } from './control-api.js';
import { useMachineSettings } from '../js/services/settings-endpoint.js';

const config = readPageConfig();
useMachineSettings({
  base: controlApiRoot(config.base),
  headers: { [TOKEN_HEADER]: config.token },
  version: config.version,
});
