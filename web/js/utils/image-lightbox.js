//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { presentModal } from './modal-surface.js';
import { ADD_SVG, withAttrs } from './icons.js';

/**
 * Click-to-expand image lightbox with zoom and pan. Opens the given image
 * fitted to the window, centered over a dimmed backdrop.
 *
 * Zoom: trackpad pinch, Ctrl/⌘-wheel, the toolbar's −/+ buttons, the `+` `-`
 * `0` keys (with or without ⌘/Ctrl, so the View menu's Zoom In/Out act on the
 * image while it is open), or a click on the image, which toggles between
 * fitted and zoomed in on the clicked point. Pan: drag, or scroll, while
 * zoomed in. Dismiss: a click on the backdrop, the close button, or Escape.
 *
 * A trackpad pinch reaches the page in one of two shapes. The desktop app's
 * WKWebView leaves its own magnification off, so WebKit hands the pinch to the
 * page as `gesturestart`/`gesturechange` events carrying a cumulative `scale`;
 * Chromium and Firefox send it as `wheel` events with `ctrlKey` set. Both are
 * handled, and the wheel shape is ignored while a gesture is in progress in
 * case an engine sends both. A touch-screen pinch arrives as two pointers.
 *
 * Styling lives in `web/css/patterns/overlay-chrome.css` (`.image-lightbox`). Only one
 * lightbox is open at a time — opening a second dismisses the first.
 */

/** Zoom limits, as multiples of the fitted size. */
const MIN_SCALE = 1;
const MAX_SCALE = 16;
/** Factor one button press or key press zooms by. */
const STEP = 1.5;
/** Pointer travel (px) past which a press is a drag rather than a click. */
const DRAG_SLOP = 4;

// Material Symbols "remove" / "add" / "close".
const ZOOM_OUT_SVG = '<svg width="1.5em" height="1.5em" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M200-440v-80h560v80H200Z"/></svg>';
const ZOOM_IN_SVG = withAttrs(ADD_SVG, { width: '1.5em', height: '1.5em' });
const CLOSE_SVG = '<svg width="1.5em" height="1.5em" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/></svg>';

/** @type {(() => void)|null} The active lightbox's close fn, or null. */
let activeClose = null;

/**
 * Create a click-to-expand image thumbnail.
 *
 * The single place an `<img>` for displayable content is built: the image file
 * viewer, a sent message's attachments, and the composer's staged attachments
 * all render through it, so the intrinsic-size handling and the lightbox wiring
 * exist once rather than in four hand-rolled copies.
 *
 * Intrinsic `width`/`height` let the browser reserve the right box and derive
 * the aspect ratio before the bytes load; CSS caps the displayed size.
 * @param {{src: string, alt?: string, className?: string, width?: number, height?: number, clickable?: boolean}} opts - Image options
 * @returns {HTMLImageElement} The image element (not yet attached to the DOM)
 */
export function createImageThumb(opts) {
  const img = document.createElement('img');
  if (opts.className) img.className = opts.className;
  img.alt = opts.alt || '';
  img.loading = 'lazy';
  if (opts.width) img.width = opts.width;
  if (opts.height) img.height = opts.height;
  if (opts.src) {
    img.src = opts.src;
    if (opts.clickable !== false) {
      img.addEventListener('click', () => openImageLightbox(img.src, img.alt));
    }
  }
  return img;
}

/**
 * Build a toolbar button.
 * @param {string} className - Class identifying the button.
 * @param {string} label - Accessible name and tooltip.
 * @param {string} svg - Icon markup.
 * @returns {HTMLButtonElement} The button.
 */
function toolbarButton(className, label, svg) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `image-lightbox-btn ${className}`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = svg;
  return btn;
}

/**
 * Open a full-size image lightbox.
 * @param {string} src - Image URL to display.
 * @param {string} [alt] - Alt text for the enlarged image.
 * @returns {() => void} A function that closes this lightbox (idempotent).
 */
export function openImageLightbox(src, alt) {
  // Single-instance: replace any lightbox already open. Ordered before the new
  // one exists, so the old modal's onClose can only ever clear its own handle.
  if (activeClose) activeClose();

  /** @type {Array<() => void>} */
  const teardown = [];

  // Escape and the browser/mobile Back button are handled by presentModal via
  // popup-manager, which also keeps the keystroke from cancelling a running
  // turn behind the lightbox. The backdrop click is handled below rather than
  // as a dismiss selector, because a drag that ends over the backdrop must not
  // close it.
  const modal = presentModal({
    className: 'image-lightbox',
    dismissSelectors: ['.image-lightbox-close'],
    onClose: () => {
      activeClose = null;
      for (const fn of teardown) fn();
    },
  });
  const root = modal.root;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', alt || 'Image');

  const img = document.createElement('img');
  img.className = 'image-lightbox-img';
  img.src = src;
  img.alt = alt || '';
  img.draggable = false;
  root.appendChild(img);

  const toolbar = document.createElement('div');
  toolbar.className = 'image-lightbox-toolbar';
  const zoomOutBtn = toolbarButton('image-lightbox-zoom-out', 'Zoom out', ZOOM_OUT_SVG);
  const levelBtn = document.createElement('button');
  levelBtn.type = 'button';
  levelBtn.className = 'image-lightbox-btn image-lightbox-level';
  levelBtn.title = 'Fit to window';
  const zoomInBtn = toolbarButton('image-lightbox-zoom-in', 'Zoom in', ZOOM_IN_SVG);
  const closeBtn = toolbarButton('image-lightbox-close', 'Close', CLOSE_SVG);
  toolbar.append(zoomOutBtn, levelBtn, zoomInBtn, closeBtn);
  root.appendChild(toolbar);

  // The image is laid out fitted (CSS caps it to the window) and zoomed with a
  // transform about its center: screen = center + t + scale·(layout − center).
  let scale = 1;
  let tx = 0;
  let ty = 0;

  /**
   * The image's untransformed layout center, in client coordinates. Scaling
   * about the center leaves the transformed box centered at center + t.
   * @returns {{x: number, y: number}} The center.
   */
  const layoutCenter = () => {
    const r = img.getBoundingClientRect();
    return { x: r.left + r.width / 2 - tx, y: r.top + r.height / 2 - ty };
  };

  /** Keep a zoomed image covering the window, and a fitted one centered. */
  const clampPan = () => {
    const c = layoutCenter();
    const w = img.offsetWidth * scale;
    const h = img.offsetHeight * scale;
    const vw = root.clientWidth;
    const vh = root.clientHeight;
    tx = w <= vw ? 0 : Math.min(w / 2 - c.x, Math.max(vw - c.x - w / 2, tx));
    ty = h <= vh ? 0 : Math.min(h / 2 - c.y, Math.max(vh - c.y - h / 2, ty));
  };

  const render = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    root.classList.toggle('is-zoomed', scale > MIN_SCALE);
    zoomOutBtn.disabled = scale <= MIN_SCALE;
    zoomInBtn.disabled = scale >= MAX_SCALE;
    // Percent of the image's real pixel size, which is what "how zoomed am I"
    // means to a reader; blank until the image has loaded and has one.
    levelBtn.textContent = img.naturalWidth
      ? `${Math.round((100 * scale * img.offsetWidth) / img.naturalWidth)}%`
      : '';
  };

  /**
   * Zoom to `next`, keeping the client point (px, py) fixed on screen.
   * @param {number} next - Target scale, clamped to the limits.
   * @param {number} [px] - Client x of the fixed point; the window center by default.
   * @param {number} [py] - Client y of the fixed point.
   * @param {boolean} [animate] - Ease to the new scale (discrete steps), or
   *   track it exactly (continuous gestures).
   */
  const zoomTo = (next, px, py, animate = false) => {
    const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    const c = layoutCenter();
    const fx = px ?? root.clientWidth / 2;
    const fy = py ?? root.clientHeight / 2;
    const k = target / scale;
    tx = fx - c.x - k * (fx - c.x - tx);
    ty = fy - c.y - k * (fy - c.y - ty);
    scale = target;
    clampPan();
    root.classList.toggle('is-stepping', animate);
    render();
  };

  /**
   * Pan by a client-pixel delta.
   * @param {number} dx - Horizontal delta.
   * @param {number} dy - Vertical delta.
   */
  const panBy = (dx, dy) => {
    tx += dx;
    ty += dy;
    clampPan();
    root.classList.remove('is-stepping');
    render();
  };

  /**
   * The scale a click on the fitted image zooms to.
   * @returns {number} Real pixel size, or 2× if that is smaller.
   */
  const clickZoomScale = () =>
    img.naturalWidth && img.offsetWidth ? Math.max(2, img.naturalWidth / img.offsetWidth) : 2;

  zoomOutBtn.addEventListener('click', () => zoomTo(scale / STEP, undefined, undefined, true));
  zoomInBtn.addEventListener('click', () => zoomTo(scale * STEP, undefined, undefined, true));
  levelBtn.addEventListener('click', () => zoomTo(MIN_SCALE, undefined, undefined, true));
  img.addEventListener('load', render);

  // --- Pinch (WebKit gesture events) ---------------------------------------
  /** @type {Map<number, {x: number, y: number}>} Pointers currently down. */
  const pointers = new Map();
  let gestureBase = 0;
  /** @param {Event} e */
  const onGestureStart = (e) => {
    e.preventDefault();
    // A touch-screen pinch is already being tracked as two pointers.
    if (pointers.size >= 2) return;
    gestureBase = scale;
  };
  /** @param {Event} e */
  const onGestureChange = (e) => {
    e.preventDefault();
    if (!gestureBase) return;
    const g = /** @type {any} */ (e);
    zoomTo(gestureBase * g.scale, g.clientX, g.clientY);
  };
  /** @param {Event} e */
  const onGestureEnd = (e) => {
    e.preventDefault();
    gestureBase = 0;
  };
  root.addEventListener('gesturestart', onGestureStart);
  root.addEventListener('gesturechange', onGestureChange);
  root.addEventListener('gestureend', onGestureEnd);

  // --- Wheel: Ctrl-wheel (Chromium/Firefox pinch, mouse Ctrl-scroll) zooms;
  // a plain scroll pans a zoomed image. Never lets the page behind scroll.
  root.addEventListener('wheel', (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? root.clientHeight : 1;
    if (e.ctrlKey || e.metaKey) {
      if (gestureBase) return;
      const dy = Math.max(-50, Math.min(50, e.deltaY * unit));
      zoomTo(scale * Math.exp(-dy / 100), e.clientX, e.clientY);
    } else if (scale > MIN_SCALE) {
      panBy(-e.deltaX * unit, -e.deltaY * unit);
    }
  }, { passive: false });

  // --- Pointers: drag pans; two touches pinch --------------------------------
  let dragged = false;
  let pinchDist = 0;
  let pinchBase = 1;
  /** @returns {[{x: number, y: number}, {x: number, y: number}]} The first two pointers. */
  const twoPointers = () => {
    const [a, b] = pointers.values();
    return [/** @type {{x: number, y: number}} */ (a), /** @type {{x: number, y: number}} */ (b)];
  };

  root.addEventListener('pointerdown', (e) => {
    if (toolbar.contains(/** @type {Node} */ (e.target))) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragged = false;
    if (pointers.size === 2) {
      const [a, b] = twoPointers();
      pinchDist = Math.hypot(b.x - a.x, b.y - a.y);
      pinchBase = scale;
    }
  });
  /**
   * Capture a pointer once it is dragging, so the drag survives leaving the
   * window. Not on press: a captured press retargets its click to the root,
   * and a click on the image would read as one on the backdrop.
   * @param {number} id - Pointer id.
   */
  const capture = (id) => {
    try { root.setPointerCapture(id); } catch { /* synthetic pointer */ }
  };
  root.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size >= 2) {
      if (!dragged) for (const id of pointers.keys()) capture(id);
      dragged = true;
      const [a, b] = twoPointers();
      if (pinchDist) {
        zoomTo(pinchBase * (Math.hypot(b.x - a.x, b.y - a.y) / pinchDist), (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      return;
    }
    if (!dragged && Math.hypot(cur.x - prev.x, cur.y - prev.y) < DRAG_SLOP) {
      // Below the slop: keep measuring from the press point.
      pointers.set(e.pointerId, prev);
      return;
    }
    if (!dragged) capture(e.pointerId);
    dragged = true;
    root.classList.add('is-panning');
    if (scale > MIN_SCALE) panBy(cur.x - prev.x, cur.y - prev.y);
  });
  /** @param {PointerEvent} e */
  const onPointerEnd = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) root.classList.remove('is-panning');
  };
  root.addEventListener('pointerup', onPointerEnd);
  root.addEventListener('pointercancel', onPointerEnd);

  // --- Clicks: the image toggles fitted ⇄ zoomed at the point; the backdrop
  // closes. Neither acts on the click that ends a drag.
  root.addEventListener('click', (e) => {
    const target = /** @type {Node} */ (e.target);
    if (dragged) {
      dragged = false;
      return;
    }
    if (toolbar.contains(target)) return;
    if (target === img) {
      if (scale > MIN_SCALE) zoomTo(MIN_SCALE, undefined, undefined, true);
      else zoomTo(clickZoomScale(), e.clientX, e.clientY, true);
      return;
    }
    modal.close();
  });

  // --- Keys: + / - / 0, bare or with ⌘/Ctrl. Captured at the window so they
  // reach the image before the app's own font-size zoom shortcut does.
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.altKey) return;
    let handled = true;
    if (e.key === '+' || e.key === '=') zoomTo(scale * STEP, undefined, undefined, true);
    else if (e.key === '-' || e.key === '_') zoomTo(scale / STEP, undefined, undefined, true);
    else if (e.key === '0') zoomTo(MIN_SCALE, undefined, undefined, true);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  // The desktop app's View ▸ Zoom In/Out menu owns ⌘+/⌘− and dispatches these
  // instead of a keydown; while the lightbox is open they zoom the image.
  /** @param {Event} e */
  const onMenuZoomIn = (e) => {
    e.stopImmediatePropagation();
    zoomTo(scale * STEP, undefined, undefined, true);
  };
  /** @param {Event} e */
  const onMenuZoomOut = (e) => {
    e.stopImmediatePropagation();
    zoomTo(scale / STEP, undefined, undefined, true);
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('juggler:zoom-in', onMenuZoomIn, true);
  window.addEventListener('juggler:zoom-out', onMenuZoomOut, true);
  teardown.push(() => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('juggler:zoom-in', onMenuZoomIn, true);
    window.removeEventListener('juggler:zoom-out', onMenuZoomOut, true);
  });

  render();

  activeClose = () => modal.close();
  return activeClose;
}
