//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ARIA semantics of the skills tab's "Add source" menu.
 *
 *   1. The trigger announces itself as a menu button (`aria-haspopup="menu"`)
 *      and starts collapsed.
 *   2. The surface is a named `menu` that owns nothing but items and
 *      separators: every row is a `menuitem`, an already-added source a
 *      disabled one, the divider a `separator`, and the "Suggested sources"
 *      heading carries no role of its own.
 *   3. `aria-expanded` follows the menu: true while it is open, false again
 *      after a dismissal through the popup manager and after choosing a row.
 *
 *   4. Under en-XA, nothing any state of the tab draws is plain English.
 *
 * The suggested rows are the server's compiled-in default sources; the first
 * is marked as already configured so the disabled row is exercised too.
 * @module unit-tests/skills-add-source-menu-aria-test
 */

import { assert } from '../utilities/test-helpers.js';
import { assertMenuShape } from '../utilities/menu-assertions.js';
import { closeAllPopups, __resetPopupManagerForTests } from '../../js/utils/popup-manager.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { fetchDefaultSources, resetCatalogCache } from '../../js/services/skills-registry.js';
import { resetSkillsCache } from '../../js/services/skills.js';
import { SkillsTab } from '../../js/components/settings/skills-tab.js';
import { openInstalledSkillPreview } from '../../js/components/settings/skill-preview.js';

/** Roles a `menu` may own directly. */
const MENU_CHILD_ROLES = new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio', 'separator', 'group', 'none']);

/**
 * Mount a skills tab on a stub host, its Discover view rendered over a catalog
 * that lists `sourceIds` as configured.
 * @param {string[]} sourceIds - Source ids the catalog reports as configured.
 * @returns {{tab: any, host: HTMLElement}} The controller and its host.
 */
function mountSkillsTab(sourceIds) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:640px;height:600px;';
  host.innerHTML = '<div id="skills-tab-root"></div>';
  document.body.appendChild(host);
  const tab = /** @type {any} */ (new SkillsTab(host));
  tab.render();
  tab.catalog = {
    entries: [],
    sources: sourceIds.map((id) => ({ id, label: id, repo: `x/${id}`, trust: 'official', stale: false, entryCount: 0 })),
  };
  tab._renderBody();
  return { tab, host };
}

/**
 * Assert the trigger's menu-button attributes.
 * @param {HTMLElement|null} button - The trigger.
 * @param {'true'|'false'} expanded - The aria-expanded value expected.
 * @param {string} label - Assertion label.
 */
function assertTrigger(button, expanded, label) {
  assert(!!button, `${label}: no trigger button`);
  const b = /** @type {HTMLElement} */ (button);
  assert(b.getAttribute('aria-haspopup') === 'menu',
    `${label}: the trigger does not announce a menu (aria-haspopup=${JSON.stringify(b.getAttribute('aria-haspopup'))})`);
  assert(b.getAttribute('aria-expanded') === expanded,
    `${label}: aria-expanded should be ${expanded}, got ${JSON.stringify(b.getAttribute('aria-expanded'))}`);
}

/**
 * Run the add-source menu ARIA suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const defaults = await fetchDefaultSources();

  // ── Test 1: roles on the surface and its rows, expanded state on dismissal ──
  {
    __resetPopupManagerForTests();
    const { tab, host } = mountSkillsTab([defaults[0]?.id ?? '']);
    try {
      assert(defaults.length > 1, `expected the server to offer several default sources, got ${defaults.length}`);
      const button = /** @type {HTMLElement|null} */ (host.querySelector('[data-action="add-source"]'));
      assertTrigger(button, 'false', 'closed');

      await tab._openAddSourceMenu(button);
      const menu = /** @type {HTMLElement|null} */ (document.querySelector('.skills-add-source-menu [role="menu"]'));
      assert(!!menu, 'the add-source surface holds no role="menu"');
      const m = /** @type {HTMLElement} */ (menu);
      assert(!!m.getAttribute('aria-label'), 'the menu has no accessible name');
      assertTrigger(button, 'true', 'open');

      const rows = /** @type {HTMLElement[]} */ ([...m.querySelectorAll('.menu-item')]);
      assert(rows.length === defaults.length + 1, `expected ${defaults.length + 1} rows, got ${rows.length}`);
      const unroled = rows.filter((r) => r.getAttribute('role') !== 'menuitem').map((r) => (r.textContent || '').trim());
      assert(unroled.length === 0, `rows without role="menuitem": ${JSON.stringify(unroled)}`);
      const added = rows.filter((r) => r.classList.contains('menu-item-unavailable'));
      assert(added.length === 1 && added[0].getAttribute('aria-disabled') === 'true',
        'the already-added source is not a single disabled item');
      assert(m.querySelector('.menu-divider')?.getAttribute('role') === 'separator', 'the divider is not a separator');

      const stray = /** @type {HTMLElement[]} */ ([...m.children])
        .filter((c) => !MENU_CHILD_ROLES.has(c.getAttribute('role') || ''))
        .map((c) => `${c.className}: ${(c.textContent || '').trim()}`);
      assert(stray.length === 0, `the menu owns children that are not items or separators: ${JSON.stringify(stray)}`);
      assertMenuShape(m, 'add-source menu');

      closeAllPopups();
      assert(!document.querySelector('.skills-add-source-menu'), 'the dismissed menu is still in the page');
      assertTrigger(button, 'false', 'dismissed');
      passed++;
    } catch (e) {
      failed++;
      errors.push('add-source-roles: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      closeAllPopups();
      host.remove();
    }
  }

  // ── Test 2: choosing a row collapses the trigger ───────────────────────────
  {
    __resetPopupManagerForTests();
    const { tab, host } = mountSkillsTab([]);
    try {
      // The URL row opens a prompt dialog; only the menu's own close is under test.
      tab._promptAddSource = async () => {};
      const button = /** @type {HTMLElement|null} */ (host.querySelector('[data-action="add-source"]'));
      await tab._openAddSourceMenu(button);
      assertTrigger(button, 'true', 'open before choosing');
      const urlRow = /** @type {HTMLElement|null} */ (document.querySelector('.skills-add-source-menu .menu-item'));
      assert(!!urlRow, 'no "Enter a URL…" row to choose');
      /** @type {HTMLElement} */ (urlRow).click();
      assert(!document.querySelector('.skills-add-source-menu'), 'choosing a row left the menu open');
      assertTrigger(button, 'false', 'after choosing');
      passed++;
    } catch (e) {
      failed++;
      errors.push('add-source-choose: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      closeAllPopups();
      host.remove();
    }
  }

  // ── Test 3: en-XA — every state the tab draws is translated ────────────────
  {
    __resetPopupManagerForTests();
    try {
      await underPseudoLocale('skills-tab-xa', runPseudoLocaleWalk);
      passed++;
    } catch (e) {
      failed++;
      errors.push('skills-tab-en-XA: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      closeAllPopups();
    }
  }

  // ── Test 4: en-XA — every failure the tab reports is translated ────────────
  {
    __resetPopupManagerForTests();
    try {
      await underPseudoLocale('skills-tab-xa-errors', runPseudoLocaleErrorWalk);
      passed++;
    } catch (e) {
      failed++;
      errors.push('skills-tab-en-XA-errors: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      closeAllPopups();
    }
  }

  __resetPopupManagerForTests();
  return { passed, failed, errors };
}

/**
 * Walk every failure the skills tab reports under en-XA: the request prefix
 * (`Install failed`, …) and the way it is joined to the server's detail are
 * both the UI's text. The server detail is a digit, so any letter shown is ours.
 * The installed preview's request fails with no detail at all, the form that
 * names only the status.
 */
async function runPseudoLocaleErrorWalk() {
  /** @type {string[]} */
  const unexpected = [];
  /** @type {any[]} */
  const alerts = [];
  /** @type {Set<string>} */
  const failing = new Set();
  const answer = skillsFetchStub(unexpected);
  const realFetch = window.fetch;
  const realModal = /** @type {any} */ (window).showModal;
  window.fetch = /** @type {any} */ (async (/** @type {any} */ input, /** @type {any} */ init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const key = `${(init?.method || 'GET').toUpperCase()} ${url.pathname.replace(/^.*\/api/, '')}`;
    if (key === 'GET /skills/user/juggler/31' && failing.has(key)) return new window.Response('', { status: 404 });
    if (failing.has(key)) {
      return new window.Response(JSON.stringify({ error: '7' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return answer(input, init);
  });
  /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => {
    if (options.type === 'alert') alerts.push(options);
    if (options.type === 'prompt') return '1/1';
    return options.type === 'confirm' ? true : null;
  };
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:640px;height:600px;';
  host.innerHTML = '<div id="skills-tab-root"></div>';
  document.body.appendChild(host);
  const tab = /** @type {any} */ (new SkillsTab(host));
  try {
    tab.render();

    // The catalog itself fails to load.
    failing.add('GET /skills/catalog');
    await tab._loadAll(true);
    assert(!!tab.loadError, 'the failed catalog load reported nothing');
    assertPseudoLocalized(/** @type {Element} */ (host.querySelector('#skills-body')), { where: 'catalog load failure' });
    failing.clear();
    await tab._loadAll(true);
    assert(tab.catalog?.entries?.length === 3, 'the stubbed catalog did not load');

    // Every mutation fails, each reported in an alert.
    for (const key of ['DELETE /skills/1/2/31', 'POST /skills/registries', 'DELETE /skills/registries/1',
      'POST /skills/install', 'GET /skills/catalog/entry', 'GET /skills/user/juggler/31']) failing.add(key);
    await tab._uninstall('1', '2', '31');
    await tab._promptAddSource();
    await tab._removeSource('1');
    await tab._install(XA_CATALOG.entries[0], 'user', 'juggler');
    assert(alerts.length === 4, `expected 4 failure alerts, got ${alerts.length}`);
    for (const options of alerts) {
      assert(isPseudoLocalized(String(options.message ?? '')),
        `failure alert is plain English: ${JSON.stringify(options.message)}`);
    }

    // The catalog preview fails to load.
    await tab._openPreview('1:c');
    const drawer = /** @type {Element} */ (host.querySelector('#skills-drawer'));
    const drawerError = drawer.querySelector('.skills-empty');
    assert(!!drawerError, 'the failed catalog preview reported nothing');
    assertPseudoLocalized(/** @type {Element} */ (drawerError), { where: 'catalog preview failure' });
    tab._closePreview();

    // The installed preview fails with no detail.
    await openInstalledSkillPreview(XA_INSTALLED[0]);
    const overlay = [...document.querySelectorAll('.skills-drawer')].find((el) => el.id !== 'skills-drawer');
    const overlayError = overlay?.querySelector('.skills-empty');
    assert(!!overlayError, 'the failed installed preview reported nothing');
    assertPseudoLocalized(/** @type {Element} */ (overlayError), { where: 'installed preview failure' });
    /** @type {HTMLElement} */ (/** @type {Element} */ (overlay).querySelector('.skills-preview-close')).click();

    assert(unexpected.length === 0, `unanswered requests: ${JSON.stringify(unexpected)}`);
  } finally {
    window.fetch = realFetch;
    /** @type {any} */ (window).showModal = realModal;
    tab._closePreview();
    resetCatalogCache();
    resetSkillsCache();
    host.remove();
  }
}

/** Digit-only fixtures, so anything with letters on screen came from the UI. */
const XA_CATALOG = {
  sources: [
    { id: '1', label: '11', repo: '1/1', trust: 'official', stale: true, entryCount: 3 },
    { id: '2', label: '22', repo: '2/2', trust: 'community', stale: false, entryCount: 0 },
  ],
  entries: [
    { id: '1:a', source: '1', path: '5', name: '42', description: '', category: ['9'], hasScripts: true, error: '6', sourceUrl: 'https://example.com/1' },
    { id: '1:b', source: '1', path: '5', name: '43', description: '', category: ['9'], installed: { upToDate: true, path: '/1/43' }, sourceUrl: 'https://example.com/2' },
    { id: '1:c', source: '1', path: '5', name: '44', description: '', category: ['9'], slugged: true, license: '8',
      installed: { upToDate: false, path: '/1/44' }, sourceUrl: 'https://example.com/3' },
  ],
};
const XA_INSTALLED = [
  { name: '31', scope: 'user', source: 'juggler', description: '', hasScripts: true, shadowedBy: '32', path: '/3/31' },
  { name: '33', scope: 'project', source: 'agents', description: '', error: '34' },
];
const XA_DEFAULTS = [
  { id: '1', label: '11', repo: '1/1', trust: 'official' },
  { id: '2', label: '22', repo: '2/2', trust: 'official' },
];

/**
 * Answer the tab's requests from the fixtures; nothing reaches the server.
 * @param {string[]} unexpected - Collects requests no route answers.
 * @returns {(input: any, init?: any) => Promise<Response>} The stub.
 */
function skillsFetchStub(unexpected) {
  const json = (/** @type {any} */ body, status = 200) =>
    new window.Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const route = url.pathname.replace(/^.*\/api/, '');
    const method = (init?.method || 'GET').toUpperCase();
    if (route === '/skills/registries/defaults') return json(XA_DEFAULTS);
    if (route === '/skills/catalog/entry') {
      return json({ body: '---\nname: 44\n---\n1', files: [{ path: '2', size: 3, runs: true }, { path: '4', size: 5, runs: false }] });
    }
    if (route === '/skills/catalog') return json(XA_CATALOG);
    if (route === '/skills/install' && method === 'POST') return json({ error: '4', existing: '4' }, 409);
    if (route === '/skills' && method === 'GET') return json(XA_INSTALLED);
    if (route === '/skills/user/juggler/31' && method === 'GET') {
      return json({ body: '1', path: '/3/31', files: [{ path: '2', size: 3 }] });
    }
    unexpected.push(`${method} ${route}`);
    throw 'unexpected request';
  };
}

/**
 * Walk every state the skills tab draws under en-XA: both views (populated,
 * filtered to nothing, empty), the add-source menu, every dialog it asks
 * through, the install-location picker and both previews.
 */
async function runPseudoLocaleWalk() {
  /** @type {string[]} */
  const unexpected = [];
  /** @type {any[]} */
  const asked = [];
  const realFetch = window.fetch;
  const realModal = /** @type {any} */ (window).showModal;
  window.fetch = /** @type {any} */ (skillsFetchStub(unexpected));
  /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => { asked.push(options); return null; };
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:640px;height:600px;';
  host.innerHTML = '<div id="skills-tab-root"></div>';
  document.body.appendChild(host);
  const tab = /** @type {any} */ (new SkillsTab(host));
  try {
    tab.render();
    await tab._loadAll(true);
    assert(tab.catalog?.entries?.length === 3, 'the stubbed catalog did not load');

    // Discover, populated: header, toolbar, chips, toggles, stale note, cards.
    const dataSkip = '[data-source-chip]:not([data-source-chip="all"]), [data-cat-chip], .skills-chip-remove, '
      + '.skills-card-name, .skills-card-meta, .skills-badge.error';
    assertPseudoLocalized(host, { skip: dataSkip, atLeast: 15, where: 'Discover' });
    const remove = host.querySelector('.skills-chip-remove');
    assert(!!remove, 'no remove-source control');
    for (const attr of ['title', 'aria-label']) {
      const v = /** @type {Element} */ (remove).getAttribute(attr) || '';
      assert(isPseudoLocalized(v), `remove-source ${attr} is plain English: ${JSON.stringify(v)}`);
    }
    const errBadge = host.querySelector('.skills-card .skills-badge.error');
    assert(!!errBadge, 'no error badge on the broken card');
    const errText = (/** @type {Element} */ (errBadge).textContent || '').replace('⚠', '').trim();
    assert(isPseudoLocalized(errText), `error badge is plain English: ${JSON.stringify(errText)}`);

    // Discover, filtered to nothing.
    tab.query = '000';
    tab._rerenderGrid();
    assertPseudoLocalized(/** @type {Element} */ (host.querySelector('.skills-grid')), { where: 'no matches' });
    tab.query = '';

    // Installed, populated (shadowed, scripts, broken) then after a rescan, then empty.
    tab._setMode('manage');
    const manageSkip = '.skills-card-name, .skills-scope-badge, .skills-badge.error, .skills-filepath-mount';
    assertPseudoLocalized(host, { skip: manageSkip, atLeast: 8, where: 'Installed' });
    await tab._refreshInstalled();
    assert(tab.installed.length === 2, 'the rescan did not reload the stubbed list');
    assertPseudoLocalized(host, { skip: manageSkip, atLeast: 8, where: 'Installed after rescan' });
    tab.installed = [];
    tab._renderBody();
    assertPseudoLocalized(/** @type {Element} */ (host.querySelector('#skills-body')), { where: 'Installed, empty' });
    tab.installed = XA_INSTALLED;
    tab._setMode('discover');

    // The add-source menu, one suggestion already added.
    const button = /** @type {HTMLElement} */ (host.querySelector('[data-action="add-source"]'));
    await tab._openAddSourceMenu(button);
    const surface = document.querySelector('.skills-add-source-menu');
    assert(!!surface, 'the add-source menu did not open');
    assert(!!surface?.querySelector('.menu-item.menu-item-unavailable'), 'no already-added suggestion');
    assertPseudoLocalized(/** @type {Element} */ (surface), {
      skip: '.menu-item:not(.menu-item-unavailable):not(:first-child)', atLeast: 4, where: 'add-source menu',
    });
    closeAllPopups();

    // Every dialog the tab asks through.
    await tab._promptAddSource();
    await tab._removeSource('1');
    await tab._uninstall('1', '2', '31'); // scope and source are ids, shown as data
    await tab._install({ ...XA_CATALOG.entries[0], name: '' }, 'user', 'juggler');
    await tab._install(XA_CATALOG.entries[0], 'user', 'juggler');
    assert(asked.length === 5, `expected 5 dialogs, got ${asked.length}`);
    for (const options of asked) {
      for (const key of ['title', 'message']) {
        assert(isPseudoLocalized(String(options[key] ?? '')),
          `dialog ${key} is plain English: ${JSON.stringify(options[key])}`);
      }
    }

    // The install-location picker.
    const picked = tab._promptInstallScope(XA_CATALOG.entries[0]);
    const picker = document.querySelector('.skills-scope-dialog');
    assert(!!picker, 'the install-location dialog did not open');
    assertPseudoLocalized(/** @type {Element} */ (picker), { skip: '.skills-scope-action-hint', atLeast: 6, where: 'install location' });
    /** @type {HTMLElement} */ (/** @type {Element} */ (picker).querySelector('[data-scope-cancel]')).click();
    await picked;

    // The catalog preview: frontmatter, files that run, licence, slug note, update available.
    await tab._openPreview('1:c');
    const drawer = /** @type {Element} */ (host.querySelector('#skills-drawer'));
    assert(!!drawer.querySelector('.skills-slug-note'), 'the preview did not render');
    assertPseudoLocalized(drawer, {
      skip: '.skills-preview-title, .skills-preview-meta, .skills-meta-table, .skills-drawer-body, '
        + '.skills-run-file, .skills-file-path, .skills-file-size, .skills-filepath-mount',
      atLeast: 8, where: 'catalog preview',
    });
    const metaText = drawer.querySelector('.skills-preview-meta')?.textContent || '';
    const licence = metaText.split(' · ').pop() || '';
    assert(isPseudoLocalized(licence), `licence line is plain English: ${JSON.stringify(licence)}`);
    tab._closePreview();

    // The installed-skill preview the Installed view opens.
    await openInstalledSkillPreview(XA_INSTALLED[0]);
    const overlay = [...document.querySelectorAll('.skills-drawer')].find((el) => el.id !== 'skills-drawer');
    assert(!!overlay?.querySelector('.skills-files'), 'the installed preview did not render');
    assertPseudoLocalized(/** @type {Element} */ (overlay), {
      skip: '.skills-preview-title, .skills-scope-badge, .skills-filepath-mount, .skills-file-path, .skills-file-size, .skills-drawer-body',
      atLeast: 4, where: 'installed preview',
    });
    /** @type {HTMLElement} */ (/** @type {Element} */ (overlay).querySelector('.skills-preview-close')).click();

    assert(unexpected.length === 0, `unanswered requests: ${JSON.stringify(unexpected)}`);
  } finally {
    window.fetch = realFetch;
    /** @type {any} */ (window).showModal = realModal;
    tab._closePreview();
    resetCatalogCache();
    resetSkillsCache();
    host.remove();
  }
}
