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
 * A session's Settings: the settings panel (settings-panel-shell.js) with
 * every tab. The sessions page's has the tabs that need no session
 * (machine-settings-panel.js).
 * @module components/settings-panel
 */

import { provideSettingsTabs } from './settings-panel-shell.js';
import { ProvidersTab } from './settings/providers-tab.js';
import { DefaultsTab } from './settings/defaults-tab.js';
import { ConnectivityTab } from './settings/connectivity-tab.js';
import { AppearanceTab } from './settings/appearance-tab.js';
import { LanguageTab } from './settings/language-tab.js';
import { NotificationsTab } from './settings/notifications-tab.js';
import { ShortcutsTab } from './settings/shortcuts-tab.js';
import { LogsTab } from './settings/logs-tab.js';
import { McpTab, AcpTab } from './settings/subprocess-tabs.js';
import { SkillsTab } from './settings/skills-tab.js';
import { CommandsTab } from './settings/commands-tab.js';
import { UpdatesTab } from './settings/updates-tab.js';
import { WebSearchTab } from './settings/web-search-tab.js';
import { ProjectFilesTab } from './settings/project-files-tab.js';

provideSettingsTabs('session', (panel) => {
  const providersTab = new ProvidersTab(panel);
  const defaultsTab = new DefaultsTab(panel);
  const connectivityTab = new ConnectivityTab(panel);
  return {
    providersTab,
    defaultsTab,
    connectivityTab,
    tabs: {
      providers: providersTab,
      defaults: defaultsTab,
      connectivity: connectivityTab,
      'web-search': new WebSearchTab(panel),
      mcp: new McpTab(panel),
      acp: new AcpTab(panel),
      commands: new CommandsTab(panel),
      skills: new SkillsTab(panel),
      appearance: new AppearanceTab(panel),
      language: new LanguageTab(panel),
      notifications: new NotificationsTab(panel),
      shortcuts: new ShortcutsTab(panel),
      'project-files': new ProjectFilesTab(panel),
      logs: new LogsTab(panel),
      updates: new UpdatesTab(panel),
    },
  };
});
