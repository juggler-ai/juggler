//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * This computer's Settings, as the machine server's sessions page opens it
 * (web/machine/header-buttons.js): the settings panel (settings-panel-shell.js)
 * with the tabs that need no session, saved through the machine server
 * (services/settings-endpoint.js).
 *
 * Its own entry point rather than settings-panel.js because that one imports
 * every session tab, and through them modules that name `juggler/*` SDK
 * specifiers and `yjs`, which only a page with an import map resolves. The
 * sessions page has none, so nothing this module imports may need one
 * (TestSessionsPageModulesResolveWithoutAnImportMap walks it).
 * @module components/machine-settings-panel
 */

import { provideSettingsTabs } from './settings-panel-shell.js';
import { ConnectivityTab } from './settings/connectivity-tab.js';
import { AppearanceTab } from './settings/appearance-tab.js';
import { LanguageTab } from './settings/language-tab.js';
import { ShortcutsTab } from './settings/shortcuts-tab.js';
import { UpdatesTab } from './settings/updates-tab.js';
import { ProjectFilesTab } from './settings/project-files-tab.js';
import { machineSettingsInfo } from '../services/settings-endpoint.js';

provideSettingsTabs('machine', (panel) => {
  const connectivityTab = new ConnectivityTab(panel);
  return {
    connectivityTab,
    tabs: {
      language: new LanguageTab(panel),
      appearance: new AppearanceTab(panel, { tips: false }),
      connectivity: connectivityTab,
      'project-files': new ProjectFilesTab(panel, { project: false }),
      updates: new UpdatesTab(panel, { machineVersion: machineSettingsInfo().version }),
      shortcuts: new ShortcutsTab(panel),
    },
  };
});
