//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the file-viewer registry's resolution rules.
 *
 * Resolution is the load-bearing part of the file-viewer abstraction: it decides
 * which viewer renders a file (and whether any does) from static manifest data
 * alone, without importing a viewer module. Covers:
 *  - exact mime match and extension fallback;
 *  - priority ordering, with registry precedence breaking ties;
 *  - `maxBytes` declining an oversized file;
 *  - the `claims()` veto (how the text viewer refuses binary content) and the
 *    `claims()` force-include for a file no manifest field matches;
 *  - empty resolution, which is what lands a file on the "no viewer" fallback;
 *  - extracted text, which resolves past the viewer for the file it came from.
 * @module unit-tests/file-viewer-registry-test
 */

import fileViewerRegistry from '../../js/registries/file-viewer-registry.js';
import { fileSourceFromReadResult, fileSourceFromText, mimeForPath, toDescriptor } from '../../sdk/file-source.js';

/**
 * @param {boolean} cond - Assertion condition
 * @param {string} msg - Failure message
 * @param {string[]} errors - Collected failures
 * @returns {number} 1 when the assertion passed, 0 when it failed
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * Build a viewer class with the given manifest, without touching the SDK base
 * class — resolution reads static data only, so a plain class is a faithful
 * stand-in and keeps the test free of module-loading concerns.
 * @param {object} manifest - The MANIFEST to attach
 * @param {((d: any) => boolean|undefined)} [claims] - Optional claims override
 * @returns {any} A viewer-shaped class
 */
function viewerClass(manifest, claims) {
  const cls = class {};
  /** @type {any} */ (cls).MANIFEST = manifest;
  if (claims) /** @type {any} */ (cls).claims = claims;
  return cls;
}

/**
 * Install a set of viewer classes into the singleton registry, replacing
 * whatever was there, and return a restore function.
 * @param {Array<[string, any]>} entries - [id, class] pairs in precedence order
 * @returns {() => void} Restores the registry's previous contents
 */
function installViewers(entries) {
  const reg = /** @type {any} */ (fileViewerRegistry);
  const savedItems = new Map(reg.items);
  const savedPaths = new Map(reg.modulePaths);
  const savedExts = new Map(reg.itemExtensions);
  reg.items.clear();
  for (const [id, cls] of entries) reg.items.set(id, cls);
  return () => {
    reg.items = savedItems;
    reg.modulePaths = savedPaths;
    reg.itemExtensions = savedExts;
  };
}

/**
 * @param {Partial<import('juggler/file-viewer').FileDescriptor>} over - Overrides
 * @returns {import('juggler/file-viewer').FileDescriptor} A descriptor
 */
function descriptor(over = {}) {
  return { path: 'a.txt', mime: '', size: 100, isBinary: false, ...over };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @param {number} n - 1 when passed */
  const tally = (n) => { if (n) passed++; else failed++; };

  const TEXT = viewerClass(
    { id: 'text', name: 'Text', version: '1.0.0', description: '', matchAll: true, priority: 0 },
    (/** @type {any} */ d) => (d.isBinary ? false : undefined)
  );
  const PDF = viewerClass({
    id: 'pdf', name: 'PDF', version: '1.0.0', description: '',
    mimeTypes: ['application/pdf'], extensions: ['pdf'], priority: 50, maxBytes: 1000,
  });
  const IMAGE = viewerClass({
    id: 'image', name: 'Image', version: '1.0.0', description: '',
    mimeTypes: ['image/png', 'image/jpeg'], extensions: ['png', 'jpg'], priority: 50,
  });

  let restore = installViewers([['text', TEXT], ['pdf', PDF], ['image', IMAGE]]);
  try {
    // Exact mime match beats the matchAll fallback.
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'doc.pdf', mime: 'application/pdf', size: 500, isBinary: true })) === PDF,
      'exact mime match should resolve to the PDF viewer', errors));

    // Mime matching is case-insensitive — servers vary on casing.
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'doc.pdf', mime: 'APPLICATION/PDF', size: 500, isBinary: true })) === PDF,
      'mime matching should be case-insensitive', errors));

    // No mime reported: the extension carries the match.
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'doc.pdf', mime: '', size: 500, isBinary: true })) === PDF,
      'extension should resolve the viewer when no mime is reported', errors));

    // Priority ordering: a plain text file matches only the fallback.
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'a.js', mime: 'text/javascript' })) === TEXT,
      'a text file should fall through to the matchAll text viewer', errors));

    // maxBytes declines: an oversized PDF is not a candidate, and since the text
    // viewer vetoes binary content, nothing claims it.
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'big.pdf', mime: 'application/pdf', size: 5000, isBinary: true })) === undefined,
      'a file past maxBytes should not resolve to that viewer', errors));

    // claims() veto: binary content with no dedicated viewer resolves to
    // nothing, which is what produces the "no viewer" fallback state.
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'a.bin', mime: '', size: 10, isBinary: true })) === undefined,
      'binary content with no dedicated viewer should resolve to nothing', errors));

    // An image still resolves despite being binary — isBinary is advisory for
    // every viewer except the text fallback that vetoes on it.
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'a.png', mime: 'image/png', size: 10, isBinary: true })) === IMAGE,
      'a binary image should still resolve to the image viewer', errors));

    // Extracted text keeps the name of the file it came from, but it is not that
    // file's bytes: a PDF's extracted text must reach the fallback, not the PDF
    // viewer, which would try to parse it as a PDF.
    const extractedPdf = fileSourceFromText({ path: 'doc.pdf', text: 'page one', extracted: true });
    tally(check(
      fileViewerRegistry.resolve(toDescriptor(extractedPdf)) === TEXT,
      'extracted text should resolve to the text fallback, not the viewer for its file type', errors));
  } finally {
    restore();
  }

  // Priority ordering and precedence tie-breaks, with two viewers claiming one
  // format.
  const LOW = viewerClass({ id: 'low', name: 'Low', version: '1.0.0', description: '', extensions: ['pdf'], priority: 10 });
  const HIGH = viewerClass({ id: 'high', name: 'High', version: '1.0.0', description: '', extensions: ['pdf'], priority: 90 });
  const TIE_A = viewerClass({ id: 'tieA', name: 'A', version: '1.0.0', description: '', extensions: ['xyz'], priority: 5 });
  const TIE_B = viewerClass({ id: 'tieB', name: 'B', version: '1.0.0', description: '', extensions: ['xyz'], priority: 5 });

  restore = installViewers([['low', LOW], ['high', HIGH], ['tieA', TIE_A], ['tieB', TIE_B]]);
  try {
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'a.pdf' })) === HIGH,
      'the higher-priority viewer should win', errors));
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'a.xyz' })) === TIE_A,
      'equal priority should break by registry precedence (load order)', errors));
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'a.txt' })) === undefined,
      'a file no viewer matches should resolve to nothing', errors));
  } finally {
    restore();
  }

  // claims() can force-include a viewer the declarative fields would not match,
  // and a claims() that throws must not break resolution for everyone else.
  const FORCED = viewerClass(
    { id: 'forced', name: 'Forced', version: '1.0.0', description: '', priority: 1 },
    (/** @type {any} */ d) => (d.path.endsWith('.weird') ? true : undefined)
  );
  const THROWS = viewerClass(
    { id: 'throws', name: 'Throws', version: '1.0.0', description: '', extensions: ['weird'], priority: 99 },
    () => { throw new Error('boom'); }
  );

  restore = installViewers([['forced', FORCED]]);
  try {
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'a.weird' })) === FORCED,
      'claims() returning true should force-include a viewer with no declarative match', errors));
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'a.txt' })) === undefined,
      'claims() returning undefined should leave a non-matching viewer out', errors));
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'a.weird', extracted: true })) === undefined,
      'claims() should not force a viewer onto text extracted from its file type', errors));
  } finally {
    restore();
  }

  restore = installViewers([['throws', THROWS], ['forced', FORCED]]);
  try {
    // THROWS matches declaratively and has the higher priority, so a claims()
    // that throws is treated as "no opinion" rather than dropping the viewer.
    tally(check(
      fileViewerRegistry.resolve(descriptor({ path: 'a.weird' })) === THROWS,
      'a throwing claims() should be treated as no opinion, not a veto', errors));
  } finally {
    restore();
  }

  // The persisted-shape compatibility shim: an OLD read result (no mime, no
  // isBinary, a baked-in warning) must still normalise into a usable source.
  const legacyBinary = fileSourceFromReadResult({
    content: '',
    path: 'assets/logo.ico',
    exists: true,
    size: 4286,
    warning: 'This appears to be a binary file. Binary content cannot be displayed as text.',
  }, '/proj/assets/logo.ico');
  tally(check(legacyBinary.isBinary === true,
    'a legacy warning-only result should normalise to isBinary', errors));
  tally(check(legacyBinary.warning !== undefined,
    'a legacy warning should survive normalisation as the fallback message', errors));
  tally(check(legacyBinary.absPath === '/proj/assets/logo.ico',
    'the resolved absolute path should be carried on the source', errors));

  const legacyText = fileSourceFromReadResult({
    content: 'const a = 1;\n',
    path: 'src/a.js',
    language: 'javascript',
    exists: true,
    size: 13,
    totalLines: 2,
    lineOffset: 1,
    lineCount: 2,
  }, '/proj/src/a.js');
  tally(check(legacyText.isBinary === false && legacyText.text === 'const a = 1;\n',
    'a legacy text result should normalise to a non-binary source carrying its text', errors));
  tally(check(legacyText.mime === 'text/javascript',
    'a missing mime should be derived from the path extension', errors));

  const legacyImage = fileSourceFromReadResult({
    path: 'img/shot.png',
    exists: true,
    size: 2048,
    isImage: true,
    attachment: { id: 'abc123', mime: 'image/png', bytes: 2048, width: 10, height: 10 },
  }, '/proj/img/shot.png', { assetURL: (id) => `/api/assets/${id}` });
  tally(check(legacyImage.isBinary === true && legacyImage.mime === 'image/png',
    'a legacy image result should normalise to a binary image source', errors));
  tally(check(legacyImage.url() === '/api/assets/abc123',
    'a legacy image should stream from its stored asset, not the content endpoint', errors));

  // toDescriptor must expose exactly the fields resolution matches on.
  const desc = toDescriptor(legacyText);
  tally(check(
    Object.keys(desc).sort().join(',') === 'extracted,isBinary,mime,path,size',
    'toDescriptor should expose exactly the resolution fields', errors));

  tally(check(mimeForPath('a.pdf') === 'application/pdf' && mimeForPath('a.unknown') === '',
    'mimeForPath should map known extensions and return empty for unknown ones', errors));

  return { passed, failed, errors };
}
