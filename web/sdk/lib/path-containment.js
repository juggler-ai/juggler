//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/utils/path-containment` — static, syscall-free path-containment
 * helpers shared by the shell tool (write-redirect gate) and the file
 * write/edit tools (write approval gate). Both need the same question answered:
 * does this path resolve inside a set of allowed roots? Keeping the logic in one
 * place means a `~/deploy` grant widens shell *and* write access identically,
 * and the Windows-spelling folding is maintained once.
 *
 * Every function here is pure (no filesystem access) and worker-safe (no DOM),
 * so this single module serves both the viewer and the engine worker — it is
 * exposed as `juggler/utils/path-containment` in the document import maps and in
 * `workerSDKImports` (cmd/juggler/server/worker_module.go), mirroring
 * `juggler/utils/html`.
 */

/**
 * Minimal POSIX path normaliser (no filesystem calls). Collapses `.` and `..`
 * segments where possible. `..` past the start of a relative path stays as
 * leading `..`.
 * @param {string} p input path
 * @returns {string} normalised path
 */
export function posixNormalize(p) {
  if (!p) return '.';
  const absolute = p.startsWith('/');
  const parts = p.split('/');
  /** @type {string[]} */
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
    } else {
      out.push(part);
    }
  }
  let result = out.join('/');
  if (absolute) result = '/' + result;
  return result || (absolute ? '/' : '.');
}

/**
 * Canonicalise a Windows path to a single comparable POSIX-shaped, lower-cased
 * form, so the same location compares equal however it was spelled. On Windows
 * (git-bash / MSYS is the expected shell) one directory can arrive as a native
 * drive path (`C:\Users\me`), a forward-slash drive path (`C:/Users/me`), an
 * MSYS drive path (`/c/Users/me`), or a Cygwin path (`/cygdrive/c/Users/me`) —
 * all the same place. We fold every form to `/c/users/me`:
 *   - backslashes become forward slashes;
 *   - a `/cygdrive/<d>/…` or `<d>:/…` (or bare `<d>:`) drive prefix becomes
 *     `/<d>/…`, so a drive path becomes an ordinary rooted path;
 *   - the whole path is lower-cased, because Windows filesystems are
 *     case-insensitive, so `C:\Users` and `c:\users` are one location.
 * Idempotent: a path already in `/c/…` lower-case form is returned unchanged.
 *
 * Called ONLY when the conversation's platform is Windows. On POSIX platforms
 * `/c/foo` is a real absolute path and a bare `C:` could be a filename, so this
 * reinterpretation must never run there — every caller gates on `platform`.
 *
 * The rooting is as much of the point as the comparing: a drive path becomes a
 * `/`-rooted one, so a caller that decides absolute-versus-relative by a leading
 * slash reads `C:/proj` as the absolute path it is instead of gluing it onto the
 * working directory.
 * @param {string} p input path in any Windows spelling
 * @returns {string} canonical POSIX-shaped, lower-cased path
 */
export function windowsToComparable(p) {
  if (!p) return p;
  let s = p.replace(/\\/g, '/');
  s = s.replace(/^\/cygdrive\/([A-Za-z])(?=\/|$)/, (_m, d) => '/' + d);
  s = s.replace(/^([A-Za-z]):(?=\/|$)/, (_m, d) => '/' + d);
  return s.toLowerCase();
}

/**
 * Reduce a path to a canonical string for allowed-root containment comparison,
 * so the same location compares equal however it is written. Both the command's
 * path argument and each stored allowed root pass through here before matching —
 * stored roots are kept verbatim as the user typed them, so either side may be
 * absolute OR `~`-form, and only canonicalising both makes them comparable.
 *
 *   - On Windows, every drive-path spelling is first folded to one comparable
 *     `/c/…` lower-case form (see {@link windowsToComparable}) — including
 *     `home`, so `~` still expands consistently.
 *   - A leading `~`/`~/<suffix>` expands to its absolute path when `home` is
 *     known (mirroring the shell expanding `~` to $HOME); when `home` is unknown
 *     a `~/<suffix>` path keeps a canonical `~/<suffix>` form so a `~`-form root
 *     and a `~`-form input still compare on equal footing.
 *   - Absolute paths normalise `.`/`..`/trailing-slash segments.
 *   - A relative path normalises as-is; one that escapes via `..` is unusable.
 *
 * Returns '' for a path that cannot anchor a comparison (empty, a bare `~`/`~/`,
 * a `~/..`-escape, or a shell expansion we cannot resolve).
 * @param {string} path input path or stored root
 * @param {string} [home] backend user-home dir for resolving `~`
 * @param {string} [platform] conversation platform; 'windows' enables drive-path folding
 * @returns {string} comparable canonical path, or '' if unusable
 */
function toComparablePath(path, home = '', platform = '') {
  if (!path) return '';
  if (path.includes('$') || path.includes('`')) return '';
  if (platform === 'windows') {
    path = windowsToComparable(path);
    if (home) home = windowsToComparable(home);
  }
  if (path === '~' || path === '~/') {
    return home ? posixNormalize(home.endsWith('/') ? home.slice(0, -1) : home) : '';
  }
  if (path.startsWith('~/')) {
    const suffix = posixNormalize(path.slice(2));
    if (!suffix || suffix === '..' || suffix.startsWith('../')) return '';
    if (home) {
      const base = home.endsWith('/') ? home.slice(0, -1) : home;
      return posixNormalize(base + '/' + suffix);
    }
    return '~/' + suffix;
  }
  if (path.startsWith('/')) return posixNormalize(path);
  const norm = posixNormalize(path);
  if (norm === '..' || norm.startsWith('../')) return '';
  return norm;
}

/**
 * Resolve a path against the directory a command actually runs in, so a
 * relative argument can be judged as the concrete location it names.
 *
 * The shell tool's analyser knows the command's working directory (the project
 * root, plus any `cd` it has walked through), which is what makes `../../js` a
 * decidable path rather than a mystery. Only a genuinely relative path moves:
 * an absolute or `~`-form path already names its location, and one carrying a
 * shell expansion (`$`, backtick) is left alone for the containment check to
 * refuse. With no known `cwd` the path is returned unchanged, so callers that
 * don't track one keep the old relative-path behaviour.
 *
 * On Windows a drive path (`C:/proj`) names an absolute location while looking
 * relative, so `platform` is consulted before joining — otherwise it would be
 * glued onto the working directory and land somewhere that does not exist.
 * @param {string} p input path
 * @param {string} [cwd] absolute working directory, forward-slashed
 * @param {string} [platform] conversation platform; 'windows' recognises drive paths as rooted
 * @returns {string} `p` resolved against `cwd`, or `p` unchanged
 */
export function resolveAgainstCwd(p, cwd = '', platform = '') {
  if (!p || !cwd) return p;
  if (p.startsWith('/') || p.startsWith('~')) return p;
  if (platform === 'windows' && /^[A-Za-z]:[\\/]/.test(p)) return p;
  if (p.includes('$') || p.includes('`')) return p;
  const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
  return posixNormalize(base + '/' + p);
}

/**
 * Does `p` resolve to a location inside any of `allowedRoots`?
 *
 * Static check only — no syscalls. Each root is matched independently; the
 * path is safe as soon as one root accepts it. Both `p` and every root are
 * canonicalised through {@link toComparablePath} first, so a `~`-form root and
 * an absolute path (or vice versa) for the same folder compare equal.
 *
 *   - Absolute and `~/<suffix>` paths must normalise to a location at or below
 *     some root.
 *   - Relative paths must not escape via `..` — they're judged against the
 *     conversation's working directory, which we assume is itself an
 *     allowed root (any caller that wires this differently can prepend `.`
 *     to the roots list).
 * @param {string} p input path
 * @param {string[]} allowedRoots allowed filesystem roots
 * @param {string} [home] backend user-home dir for resolving `~/...`
 * @param {string} [platform] conversation platform; 'windows' folds every drive-path spelling before matching
 * @returns {boolean} true if `p` resolves inside any allowed root
 */
export function isPathInsideAllowedRoots(p, allowedRoots, home = '', platform = '') {
  if (!p) return false;
  if (p.includes('$') || p.includes('`')) return false;
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) return false;

  // On Windows a drive path (`C:\…`, `C:/…`, `/cygdrive/c/…`) denotes an
  // absolute location, but only `/c/…` and native `C:\…` *look* rooted — a
  // forward-slash `C:/…` would fall through to the relative branch below and be
  // mis-approved as an in-project path. Fold to the comparable form FIRST so the
  // rooted-vs-relative decision is made on the canonical spelling.
  const cp = platform === 'windows' ? windowsToComparable(p) : p;

  // Relative path: just verify it doesn't escape via `..`. We treat
  // the cwd as implicitly allowed (the conversation's project path is
  // always among the roots in normal use).
  if (!cp.startsWith('/') && !cp.startsWith('~')) {
    const norm = posixNormalize(cp);
    return norm !== '..' && !norm.startsWith('../');
  }

  const target = toComparablePath(p, home, platform);
  if (!target) return false;
  for (const root of allowedRoots) {
    const r = toComparablePath(root, home, platform);
    if (!r) continue;
    if (target === r || target.startsWith(r + '/')) return true;
  }
  return false;
}

/**
 * Resolve a path argument to the canonical absolute root that, once added to
 * `allowedRoots`, makes {@link isPathInsideAllowedRoots} accept `p`. This is
 * the form an "add this folder to allowed paths" suggestion should grant —
 * absolute and fully resolved, so the stored grant is unambiguous regardless of
 * how a future command writes the same path.
 *
 * Returns null when `p` cannot — or need not — be granted as a root:
 *   - it carries a shell expansion (`$` / backtick) whose target we can't know;
 *   - it is a bare `~` / `~/` (the whole home dir — too broad to auto-suggest);
 *   - a `~/…` path with no known `home` to expand against; or
 *   - a relative path (the cwd is implicitly allowed, so no grant is needed).
 * @param {string} p path argument
 * @param {string} [home] backend home dir for `~` expansion
 * @returns {string | null} absolute root to grant, or null if ungrantable / unneeded
 */
export function canonicalRoot(p, home = '') {
  if (!p) return null;
  if (p.includes('$') || p.includes('`')) return null;
  if (p === '~' || p === '~/') return null;
  /** @type {string | null} */
  let candidate = null;
  if (p.startsWith('~/')) {
    const suffix = posixNormalize(p.slice(2));
    if (!suffix || suffix === '..' || suffix.startsWith('../')) return null;
    if (!home) return null;
    const base = home.endsWith('/') ? home.slice(0, -1) : home;
    candidate = base + '/' + suffix;
  } else if (p.startsWith('/')) {
    const norm = posixNormalize(p);
    if (norm === '..' || norm.startsWith('../')) return null;
    candidate = norm;
  } else {
    // Relative path — judged against the (implicitly allowed) cwd; no grant needed.
    return null;
  }
  // Sanity gate: never offer to grant an over-broad root. A grant whitelists
  // reads anywhere beneath the folder for every future command, so `/`, a bare
  // system top-level (`/usr`), or the whole home dir would blanket-approve the
  // machine. Reject those so the suggester falls back to a narrow glob instead.
  return isGrantableRoot(candidate, home) ? candidate : null;
}

/**
 * Is `absRoot` specific enough to offer as an auto-approval folder grant?
 *
 * Adding a folder to the allowed-paths list lets every future command read
 * anywhere beneath it without prompting — so the grant must be narrow. A root
 * is grantable only when it is an absolute path at least two segments deep that
 * is neither the user's home directory itself nor an ancestor of it. That
 * rejects the cases no sane auto-approval should ever propose:
 *   - `/` — the whole filesystem;
 *   - a bare system top-level (`/usr`, `/etc`, `/Users`, `/var`, …);
 *   - the user's entire home directory (or `/Users`, which contains it).
 * @param {string} absRoot canonical absolute root (from {@link canonicalRoot})
 * @param {string} [home] backend home dir, to reject home and its ancestors
 * @returns {boolean} true if the root is narrow enough to grant
 */
export function isGrantableRoot(absRoot, home = '') {
  if (!absRoot || !absRoot.startsWith('/')) return false;
  const segs = absRoot.split('/').filter(Boolean);
  if (segs.length < 2) return false; // `/` or a bare top-level dir
  if (home) {
    const h = posixNormalize(home.endsWith('/') ? home.slice(0, -1) : home);
    // Reject the home dir itself or any ancestor of it (`/Users/jules`, `/Users`).
    if (absRoot === h || h.startsWith(absRoot + '/')) return false;
  }
  return true;
}
