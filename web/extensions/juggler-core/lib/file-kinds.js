//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What sort of thing a directory entry is, at a glance: a dozen kinds, each
 * with an icon of its own, so a tree can be read for its shape before a single
 * name is.
 *
 * Deliberately not an icon theme. A row is sixteen pixels tall and read in
 * passing; what it has to answer is "folder, code, picture, something I will
 * not open here?", and one glyph per family answers that where one per language
 * would only be noise. The kind is decided by name alone — nothing is read — so
 * it costs nothing to ask for every row.
 * @module lib/file-kinds
 */

import { markForTranslation } from 'juggler/i18n';

/**
 * @typedef {'dir'|'code'|'script'|'web'|'doc'|'text'|'data'|'image'|'media'|'archive'|'lock'|'binary'|'program'|'link'} FileKind
 */

/** What each kind is called where it is spelled out, for the preview's header. */
export const KIND_LABELS = /** @type {Record<FileKind, string>} */ ({
  dir: markForTranslation('Folder'),
  code: markForTranslation('Source code'),
  script: markForTranslation('Script'),
  web: markForTranslation('Web page or stylesheet'),
  doc: markForTranslation('Document'),
  text: markForTranslation('Text'),
  data: markForTranslation('Data or config'),
  image: markForTranslation('Image'),
  media: markForTranslation('Audio or video'),
  archive: markForTranslation('Archive'),
  lock: markForTranslation('Lockfile'),
  binary: markForTranslation('Binary'),
  program: markForTranslation('Program'),
  link: markForTranslation('Symbolic link'),
});

/** @type {Record<string, FileKind>} */
const BY_EXTENSION = {};
/**
 * @param {FileKind} kind - The kind.
 * @param {string} extensions - Space-separated, lower case, no dots.
 */
const claim = (kind, extensions) => {
  for (const ext of extensions.split(' ')) BY_EXTENSION[ext] = kind;
};
claim('code', 'js mjs cjs jsx ts mts cts tsx go py pyi rb rs c h cc cpp cxx hh hpp cs java kt kts swift '
  + 'm mm php lua pl pm r scala zig dart ex exs erl hrl hs ml mli clj cljs vue svelte sql cmajor glsl hlsl wgsl '
  + 'asm s v sv vhd nim jl fs fsx elm');
claim('script', 'sh bash zsh fish ps1 psm1 bat cmd command');
claim('web', 'html htm xhtml css scss sass less');
claim('doc', 'md markdown mdx rst adoc tex pdf doc docx odt rtf pages key numbers ppt pptx xls xlsx');
claim('text', 'txt log text out err');
claim('data', 'json jsonc json5 ndjson jsonl yaml yml toml xml ini cfg conf env csv tsv plist proto graphql gql '
  + 'cmajorpatch properties editorconfig gitignore gitattributes gitmodules npmrc nvmrc dockerignore');
claim('image', 'png jpg jpeg gif webp svg ico icns bmp tif tiff avif heic psd');
claim('media', 'mp3 wav flac ogg oga m4a aac aif aiff mid midi mp4 m4v mov webm mkv avi');
claim('archive', 'zip gz tgz tar bz2 xz zst 7z rar dmg pkg deb rpm jar war whl apk msi');
claim('lock', 'lock sum');
claim('binary', 'ttf otf woff woff2 eot exe dll so dylib a o obj class wasm pyc bin dat db sqlite sqlite3');

/** Whole names that say more than their extension does, or have none. */
const BY_NAME = /** @type {Record<string, FileKind>} */ ({
  makefile: 'code',
  gnumakefile: 'code',
  dockerfile: 'code',
  justfile: 'code',
  rakefile: 'code',
  gemfile: 'code',
  procfile: 'data',
  license: 'doc',
  licence: 'doc',
  copying: 'doc',
  readme: 'doc',
  changelog: 'doc',
  authors: 'doc',
  'package-lock.json': 'lock',
  'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock',
  'cargo.lock': 'lock',
  'go.sum': 'lock',
  'go.mod': 'data',
  'go.work': 'data',
});

/**
 * The kind of a directory entry, by its name and what the listing said of it.
 * @param {string} name - The entry's name.
 * @param {{isDir?: boolean, linkDir?: boolean, kind?: string, executable?: boolean}} [entry] - What the
 *   listing said: a folder, a link, an executable file.
 * @returns {FileKind} Its kind.
 */
export function fileKind(name, entry = {}) {
  if (entry.isDir) return 'dir';
  if (entry.linkDir) return 'dir';
  const lower = name.toLowerCase();
  const named = BY_NAME[lower];
  if (named) return named;
  const dot = lower.lastIndexOf('.');
  // A dot-file with no further dot (".gitignore", ".env") is named for what it
  // is, so its whole name after the dot is looked up as an extension would be.
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  const byExt = ext ? BY_EXTENSION[ext] : undefined;
  if (byExt) return byExt;
  // "Dockerfile.dev", "README.old": a known name with something on the end.
  const stem = BY_NAME[lower.replace(/\.[^.]*$/, '')];
  if (stem) return stem;
  if (entry.kind === 'symlink') return 'link';
  if (entry.executable) return dot > 0 ? 'script' : 'program';
  return 'text';
}

/** The outline every file icon is drawn on: a page with its corner turned. */
const PAGE = '<path d="M3.5 1.5h6l3 3v10h-9z" class="file-icon__page"/><path d="M9.5 1.5v3h3" class="file-icon__fold"/>';

/** The mark drawn on the page, by kind. */
const GLYPHS = /** @type {Record<FileKind, string>} */ ({
  dir: '',
  code: '<path d="m6.6 8.3-1.6 1.7 1.6 1.7m2.8-3.4 1.6 1.7-1.6 1.7"/>',
  script: '<path d="m5.4 8 1.8 1.7-1.8 1.7m3 .1h2.3"/>',
  web: '<circle cx="8" cy="10" r="2.6"/><path d="M5.4 10h5.2M8 7.4c-1.2 1.6-1.2 3.6 0 5.2m0-5.2c1.2 1.6 1.2 3.6 0 5.2"/>',
  doc: '<path d="M5.5 7.5h5m-5 2h5m-5 2h3.5"/>',
  // i18n-ignore: SVG markup for the text kind's icon, not words
  text: '<path d="M5.5 8h5m-5 2h5m-5 2h3" class="file-icon__faint"/>',
  data: '<path d="M7 7.4c-.9 0-.9.7-.9 1.4s-.4 1-.7 1c.3 0 .7.3.7 1s0 1.4.9 1.4m2-4.8c.9 0 .9.7.9 1.4s.4 1 .7 1c-.3 0-.7.3-.7 1s0 1.4-.9 1.4"/>',
  image: '<path d="m4.9 12.6 2.3-2.9 1.6 1.8 1.2-1.3 1.5 2.4z" class="file-icon__solid"/><circle cx="9.9" cy="7.6" r=".9" class="file-icon__solid"/>',
  media: '<path d="M6.6 7.6v4.8l3.9-2.4z" class="file-icon__solid"/>',
  archive: '<path d="M8 2v1.2m0 1.1v1.2m0 1.1v1.2"/><rect x="6.9" y="9" width="2.2" height="2.8" rx=".4"/>',
  lock: '<rect x="5.6" y="9.2" width="4.8" height="3.5" rx=".6" class="file-icon__solid"/><path d="M6.6 9.2v-1a1.4 1.4 0 0 1 2.8 0v1"/>',
  binary: '<path d="M5.6 7.6v3m2.4-3v3m2.4-3v3" class="file-icon__faint"/><path d="M5 12.2h6"/>',
  program: '<path d="m5.4 8 1.8 1.7-1.8 1.7m3 .1h2.3"/>',
  link: '<path d="M6.8 11.6 9.6 8.8m-2.4 0h2.4v2.4"/>',
});

/**
 * The icon for a kind, as markup to set on an element. Drawn in `currentColor`,
 * so the kind's colour is the stylesheet's to choose and follows the theme.
 * @param {FileKind} kind - What to draw.
 * @param {boolean} [open] - For a folder: drawn open.
 * @returns {string} An `<svg>`, hidden from assistive technology — the row's
 *   name and its expanded state already say everything the picture does.
 */
export function fileIconSvg(kind, open = false) {
  const body = kind === 'dir'
    ? (open
      ? '<path d="M1.5 3.5h4.2l1.4 1.4h6.4v1.6" class="file-icon__fold"/><path d="M1.5 3.5v9.5h11.2l2-6.5H4.2L2 13" class="file-icon__page"/>'
      : '<path d="M1.5 3.5h4.2l1.4 1.4h7.4v8.1H1.5z" class="file-icon__page"/>')
    : PAGE + GLYPHS[kind];
  return `<svg class="file-icon" data-kind="${kind}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${body}</svg>`;
}
