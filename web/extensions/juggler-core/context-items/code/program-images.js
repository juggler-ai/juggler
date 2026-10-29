//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Images out of a program.
 *
 * A script's result is text, and the pixels of an image never enter the
 * sandbox. What a program holds instead is a handle: a plain object naming an
 * image in the conversation's asset store, `{image, mime, bytes, width?,
 * height?, label?}`. A program gets one from a call whose result carried images
 * (`tools.read` on a PNG, an MCP tool's screenshot), and passing it to
 * `image()` attaches that image to the program's own result, which is how the
 * model comes to see it. `image()` also takes a path, for an image the program
 * found with `fs` or `glob`: it is read on the same footing as `fs.readFile`
 * and stored first.
 *
 * Handles are checked against the images this program was actually given, so
 * one it made up, or copied from elsewhere, attaches nothing. The images it was
 * given are kept in its snapshot with its journal (program-journal.js), since
 * a replayed call's handle comes back from the journal rather than from the
 * call. A path's image is read through `loadPath`, which run_code journals, so
 * a replay attaches what the run before it read. Every image the program holds
 * is named on its item as `heldAssets`, so the asset store keeps it while the
 * program waits on the user.
 * @module context-items/code/program-images
 */

/** Most images one program may attach to its result. */
const MAX_PROGRAM_IMAGES = 8;

/**
 * @typedef {object} AssetRef
 * @property {string} id - Content hash of the bytes
 * @property {string} mime - e.g. image/png
 * @property {number} bytes - Size in bytes
 * @property {number} [width] - Width in pixels
 * @property {number} [height] - Height in pixels
 * @property {string} [filename] - Display name
 */

/**
 * @typedef {object} ImageHandle
 * @property {string} image - The asset's id
 * @property {string} mime - Its type
 * @property {number} bytes - Its size
 * @property {number} [width] - Width in pixels
 * @property {number} [height] - Height in pixels
 * @property {string} [label] - Where it came from: a path, or the tool that made it
 */

/**
 * @typedef {object} ReceivedImage
 * @property {AssetRef} ref - The stored asset
 * @property {string} [label] - Where it came from
 */

/**
 * The images one program run holds and shows.
 * @param {object} opts
 * @param {Map<string, ReceivedImage>} [opts.received] - Images the run a replay resumes was given, by id; mutated
 * @param {(path: string) => Promise<AssetRef>} [opts.loadPath] - Read and store the image at a path; without it, image() takes only handles
 * @param {(ids: string[]) => void} [opts.onHeld] - Told every id the program holds, whenever that grows
 * @param {number} [opts.max] - Most images the result may carry
 * @returns {{receive: (refs: AssetRef[], label?: string) => ImageHandle[], show: (target: unknown) => Promise<void>,
 *   shown: () => AssetRef[], received: Map<string, ReceivedImage>, labelOf: (id: string) => string|undefined}} The program's images
 */
export function createProgramImages(opts = {}) {
  const received = opts.received ?? new Map();
  const max = opts.max ?? MAX_PROGRAM_IMAGES;
  /** @type {Map<string, AssetRef>} */
  const shown = new Map();

  const held = () => opts.onHeld?.([...new Set([...received.keys(), ...shown.keys()])]);

  /**
   * @param {AssetRef} ref - The stored asset
   * @param {string} [label] - Where it came from
   * @returns {ImageHandle} Its handle
   */
  const handleOf = (ref, label) => {
    /** @type {ImageHandle} */
    const handle = { image: ref.id, mime: ref.mime, bytes: ref.bytes };
    if (ref.width) handle.width = ref.width;
    if (ref.height) handle.height = ref.height;
    if (label) handle.label = label;
    return handle;
  };

  /**
   * Attach an image to the result.
   * @param {AssetRef} ref - The image
   * @param {string} [label] - Where it came from
   */
  const attach = (ref, label) => {
    if (shown.has(ref.id)) return;
    if (shown.size >= max) {
      throw new Error(`Couldn't attach ${label || 'the image'}: a result carries at most ${max} images.`);
    }
    if (!received.has(ref.id)) received.set(ref.id, { ref, label });
    shown.set(ref.id, ref);
    held();
  };

  return {
    received,

    /**
     * Take the images a call's result carried, and hand back their handles.
     * @param {AssetRef[]} refs - The call's attachments
     * @param {string} [label] - Where they came from
     * @returns {ImageHandle[]} One handle per image
     */
    receive(refs, label) {
      const handles = [];
      for (const ref of refs) {
        if (!ref?.id) continue;
        if (!received.has(ref.id)) received.set(ref.id, { ref, label });
        handles.push(handleOf(ref, received.get(ref.id)?.label));
      }
      held();
      return handles;
    },

    /**
     * `image(handleOrPath)` in the sandbox: attach an image to the result.
     * @param {unknown} target - A handle this program was given, or a path
     * @returns {Promise<void>}
     */
    async show(target) {
      if (typeof target === 'string') {
        if (!opts.loadPath) {
          throw new Error(`Couldn't attach ${target}: image() takes a handle from a tool's result here.`);
        }
        attach(await opts.loadPath(target), target);
        return;
      }
      const id = target && typeof target === 'object' ? /** @type {any} */ (target).image : undefined;
      const got = typeof id === 'string' ? received.get(id) : undefined;
      if (!got) {
        throw new Error('Couldn\'t attach that image: image() takes a handle a tool\'s result gave this program '
          + '(its images[] entries), or a path.');
      }
      attach(got.ref, got.label);
    },

    /** @returns {AssetRef[]} The images attached, in the order they were */
    shown: () => [...shown.values()],

    /**
     * @param {string} id - An image's id
     * @returns {string|undefined} Where it came from
     */
    labelOf: (id) => received.get(id)?.label,
  };
}

/**
 * The lines a result's text ends with, saying which images are attached, so a
 * model reading it knows what it is looking at.
 * @param {AssetRef[]} refs - The attached images
 * @param {(id: string) => string|undefined} [labelOf] - Where each came from
 * @returns {string} Text to append, or '' for none
 */
export function attachedImagesNote(refs, labelOf) {
  if (refs.length === 0) return '';
  const lines = refs.map((ref) => {
    const dims = ref.width && ref.height ? `${ref.width}\u00d7${ref.height}` : ref.mime;
    return `- ${labelOf?.(ref.id) || ref.filename || ref.mime} (${dims})`;
  });
  return `\n\nImages attached below:\n${lines.join('\n')}`;
}

/**
 * Make a script's `fs.readFile` on an image say how to show it, rather than
 * only that it is not text. Mutates and returns `fs`.
 * @template {{readFile: (...args: any[]) => Promise<any>}} T
 * @param {T} fs - The script's read-only filesystem
 * @returns {T} The same filesystem
 */
export function pointImageReadsAtImage(fs) {
  const readFile = fs.readFile.bind(fs);
  fs.readFile = async (...args) => {
    try {
      return await readFile(...args);
    } catch (err) {
      if (err instanceof Error && /is an image, not text$/.test(err.message)) {
        throw new Error(`${err.message}. To show it to the model, pass its path to image().`, { cause: err });
      }
      throw err;
    }
  };
  return fs;
}

/**
 * Read the image at a path and store it in the conversation's assets, on the
 * footing a program's `fs.readFile` reads on.
 * @param {object} deps
 * @param {(params: Record<string, unknown>, signal?: AbortSignal) => Promise<any>} deps.readFile - The item's bound read op
 * @param {(convId: string, base64: string, mime: string, signal?: AbortSignal) => Promise<AssetRef>} deps.upload - The asset upload
 * @param {string|undefined} deps.conversationId - Whose assets
 * @param {AbortSignal} [deps.signal] - The program's signal
 * @returns {(path: string) => Promise<AssetRef>} The loader
 */
export function imagePathLoader({ readFile, upload, conversationId, signal }) {
  return async (path) => {
    if (!conversationId) throw new Error(`Couldn't attach ${path}: there is no conversation to keep it in.`);
    const result = await readFile({ path }, signal);
    if (!result || result.exists === false) throw new Error(`Couldn't attach ${path}: no such file.`);
    if (!result.isImage || typeof result.imageBase64 !== 'string') {
      const mime = typeof result.mime === 'string' ? result.mime : '';
      const why = result.isBinary && mime.startsWith('image/')
        ? 'it is too large to attach'
        : 'it is not an image (PNG, JPEG, GIF or WebP)';
      throw new Error(`Couldn't attach ${path}: ${why}.`);
    }
    return upload(conversationId, result.imageBase64, result.mime, signal);
  };
}
