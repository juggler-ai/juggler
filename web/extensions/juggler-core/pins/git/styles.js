//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git pin's frame and its Changes, History and Refs places: the head line, the
 * place switcher, the list and detail panes, the commit box, the toast, the
 * command log and the anchored popovers. Layout follows the pin, never the
 * viewport: by width, container queries on the pin (`git-pin`) — below 34rem
 * it is a stack showing one pane at a time (the root's `data-level` says
 * which), from 34rem a split, past 60rem full (the Refs list a sidebar beside
 * Changes and History); by height, what pins/git/layout writes on the root —
 * under 5.5rem tall it is a chip, the head line alone (`data-mode`).
 * @module pins/git/styles
 */

import { injectStylesOnce } from 'juggler/ui';

/** Put the stylesheet in the document, once. */
export function injectGitClientStyles() {
  injectStylesOnce('git-client-styles', `
/* Width only. A height container sized by the board's scrolling body stops
   Chromium wheel-scrolling every list and pane in the pin wherever scrollbars
   take room (Windows); height is read in pins/git/layout instead. */
.git-pin {
  container: git-pin / inline-size;
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  -webkit-user-select: none;
  user-select: none;
}

/* The pin is chrome — rows, labels, captions and buttons are aimed at with
   clicks, so a drag across them selects nothing (base/text-selection.css) —
   except for what is worth copying (a diff is, everywhere): the Review place, a commit's
   or ref's message and facts, the command log, what the hooks printed, the
   fields, and the errors worth pasting into a report. */
.git-pin :is(input, textarea),
.git-changes__file,
.git-pin__place--review,
.git-history__about,
.git-history__facts,
.git-refs__facts,
.git-refs__message,
.git-pin__log-list,
.git-commit__output,
.git-inline-error__text,
.git-pop__detail {
  -webkit-user-select: text;
  user-select: text;
}

/* Focused as the board opens and after Escape leaves a field: a place the
   keys are read from, as pinboard-content is, not a control picked out. The
   whole pin is far too big a shape to ring; its controls ring themselves. */
.git-pin:focus {
  outline: none;
}

/* The head: its line, and under it the switcher's row when the switcher does
   not fit in the line (pins/git/head's fit) — one bar, with no rule between. */
.git-pin__head {
  flex: none;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--space-4);
  min-width: 0;
  padding: var(--space-4) var(--pane-inset);
  border-bottom: 1px solid var(--border-divider);
}

.git-pin__bar {
  display: flex;
  align-items: center;
  gap: var(--toolbar-gap);
  min-width: 0;
}

/* \`repo / branch\`: one name of two buttons, each answering a hover on its own
   so each reads as the chooser it opens. The repository gives way first. */
.git-pin__ref {
  min-width: 0;
  flex: 0 1 auto;
  display: inline-flex;
  align-items: center;
}

.git-pin__slash {
  flex: none;
  color: var(--text-tertiary);
}

.git-pin__seg {
  min-width: 0;
  flex: 0 1 auto;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
}

.git-pin__seg[hidden],
.git-pin__slash[hidden] {
  display: none;
}

.git-pin__seg:hover:not(:disabled) {
  background: var(--wash-1);
}

.git-pin__seg .git-pin__icon {
  color: var(--text-tertiary);
}

.git-pin__repo {
  flex-shrink: 3;
  color: var(--text-secondary);
}

/* One repository: its name, with nothing to choose. */
.git-pin__repo:disabled {
  cursor: default;
}

.git-pin__repo:disabled .git-pin__icon {
  display: none;
}

/* The sha and "detached" are different faces on one line: inline text, so
   they share a baseline whatever their fonts' metrics. */
.git-pin__branch-text {
  min-width: 0;
}

/* The pin's picker: the app's compact field (field-input-xs draws the box),
   opening the app's menu. A button gets none of the field's padding, which
   the pattern gives only inputs, so it takes the field's own. */
.git-select {
  flex: 0 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--field-pad-y) var(--space-4) var(--field-pad-y) var(--field-pad-x);
  font: inherit;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  cursor: pointer;
}

/* As the pattern's select answers a hover. */
.git-select:hover:not(:focus) {
  border-color: var(--text-secondary);
}

.git-select[hidden] {
  display: none;
}

.git-select .git-pin__icon {
  color: var(--text-tertiary);
}

.git-select-menu {
  max-height: min(70vh, 30rem);
}

.git-pin__icon {
  flex: none;
  width: 1em;
  height: 1em;
  fill: none;
  stroke: currentcolor;
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.git-pin__branch-name {
  font-family: var(--font-mono);
  font-weight: var(--font-weight-semibold);
}

.git-pin__detached,
.git-pin__sync-none {
  color: var(--text-tertiary);
}

.git-pin__sync {
  display: flex;
  gap: var(--space-8);
  white-space: nowrap;
}

/* A count beside the branch: glyph, number and what it counts, at the size
   of the line, so it reads as words rather than as a code. */
.git-pin__stat {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  white-space: nowrap;
  cursor: default;
}

.git-pin__stat[hidden] {
  display: none;
}

.git-pin__stat-num {
  font-variant-numeric: tabular-nums;
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.git-pin__ahead .git-pin__stat-glyph {
  color: var(--accent-blue);
}

.git-pin__behind .git-pin__stat-glyph {
  color: var(--accent-orange);
}

.git-pin__sync-ok {
  color: var(--success);
}

.git-pin__dirty .git-pin__stat-glyph {
  color: var(--accent-yellow);
}

/* Either side of the switcher in the line, so it stands centred between the
   two groups; the lead is shown only then. */
.git-pin__spacer,
.git-pin__lead {
  flex: 1;
}

.git-pin__lead[hidden] {
  display: none;
}

/* While the line is measured (pins/git/head's fit) nothing in it shrinks, so
   each item reads at the width it wants. */
.git-pin__bar.git-pin__bar--measure > * {
  flex: none;
}

/* The commands the line has room for: head's fit drops them from the end. */
.git-pin__commands {
  display: flex;
  gap: var(--space-2);
}

.git-pin__command {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  white-space: nowrap;
}

.git-pin__command:is([hidden], .git-pin__command--dropped) {
  display: none;
}

@container git-pin (width < 40rem) {
  .git-pin__stat-word { display: none; }
}

/* Refresh ends the left group, its glyph at the size of the command buttons'
   text rather than a small icon's, so it reads as a control and not a mark. */
.git-pin__refresh {
  flex: none;
}

.git-pin__refresh .git-pin__icon {
  width: 1.25em;
  height: 1.25em;
  stroke-width: 1.5;
}

/* 1.2s is SPIN_TURN_MS in pins/git/head, which lets a turn finish. */
.git-pin__refresh--spin .git-pin__icon--sync {
  animation: btn-spin 1.2s linear infinite;
}

/* Without the turn, the button dims for as long as it would have turned. */
@media (prefers-reduced-motion: reduce) {
  .git-pin__refresh--spin .git-pin__icon--sync {
    animation: none;
    opacity: 0.4;
  }
}

/* While a network write runs, Refresh stops it: under the pointer, or with
   the keyboard on it, its turning glyph gives way to the ✕ a click is. */
.git-pin__refresh-stop {
  display: none;
  width: 1.25em;
  line-height: 1;
  text-align: center;
}

.git-pin__refresh--stop:is(:hover, :focus-visible) .git-pin__icon--sync {
  display: none;
}

.git-pin__refresh--stop:is(:hover, :focus-visible) .git-pin__refresh-stop {
  display: inline-block;
}

.git-pin__primary {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  white-space: nowrap;
}

.git-pin__offline {
  display: inline-flex;
  align-items: center;
  color: var(--text-tertiary);
}

.git-pin__primary--spin .git-pin__icon--sync,
.git-pin__command--spin .git-pin__icon--sync {
  animation: btn-spin 1.2s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .git-pin__primary--spin .git-pin__icon--sync,
  .git-pin__command--spin .git-pin__icon--sync {
    animation: none;
  }
}

.git-pin__head[data-operation] {
  background: color-mix(in srgb, var(--warning) 8%, transparent);
}

.git-op {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--stack-gap-tight) var(--toolbar-gap);
  min-width: 0;
  padding: var(--space-6) var(--pane-inset);
  font-size: var(--font-size-meta);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
}

.git-op[hidden] {
  display: none;
}

.git-op__text {
  flex: 1 1 12rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

.git-op__buttons {
  display: flex;
  align-items: center;
  gap: var(--toolbar-gap);
  flex: none;
  margin-left: auto;
}

.git-op__skip[hidden],
.git-op__hint[hidden] {
  display: none;
}

/* Why Continue is disabled, beside it. */
.git-op__hint {
  color: var(--text-secondary);
}

/* The switcher: in the head line when it fits there, else the head's second
   row (pins/git/head's fit). */
.git-pin__places {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
}

/* On its own row the toast ends at the row's end, as the line's buttons do. */
.git-pin__head > .git-pin__places > .git-pin__toast {
  right: 0;
}

/* With the switcher in the line, the toast floats in the line's gap between
   the switcher and the commands (git-pin's toastHome), centred and no wider
   than the gap, so it covers none of the line's buttons. */
.git-pin__bar > .git-pin__spacer {
  position: relative;
  align-self: stretch;
  min-width: 0;
}

.git-pin__spacer > .git-pin__toast {
  right: auto;
  left: 50%;
  max-width: 100%;
  transform: translate(-50%, -50%);
}

/* A warning or failure is a few lines, which the gap — often a few words
   wide — would squeeze into a column of letters. It hangs from under the
   head instead, at the commands' end and as wide as the pin allows, so it
   still covers none of the line's buttons: the head, not the gap, is what it
   is placed against. */
.git-pin__head:has(> .git-pin__bar > .git-pin__spacer > :is(.git-pin__toast--error, .git-pin__toast--warn)) {
  position: relative;
}

.git-pin__bar > .git-pin__spacer:has(> :is(.git-pin__toast--error, .git-pin__toast--warn)) {
  position: static;
}

.git-pin__spacer > :is(.git-pin__toast--error, .git-pin__toast--warn) {
  top: calc(100% + var(--space-2));
  right: var(--pane-inset);
  left: auto;
  max-width: min(32rem, calc(100% - 2 * var(--pane-inset)));
  transform: none;
}

/* A segmented control, not a row of pills: the pinboard's own tabs above it
   are pills, and the pin's places must not read as more of them. */
.git-pin__tabs {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--bg-tertiary);
  border-radius: var(--radius-lg);
}

.git-pin__place-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  font: inherit;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  background: none;
  border: 0;
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-10);
  cursor: pointer;
}

.git-pin__place-btn:hover {
  color: var(--text-primary);
}

.git-pin__place-btn[aria-selected="true"] {
  color: var(--text-primary);
  background: var(--bg-secondary);
  font-weight: var(--font-weight-semibold);
  box-shadow: var(--shadow-sm);
}

/* How many files Changes holds, as a count on its tab: a plain count, like
   every other count in the pin, and not the colour of a modified file. */
.git-pin__place-count {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-normal);
  font-variant-numeric: tabular-nums;
  color: var(--text-tertiary);
}

.git-pin__place-count[hidden] {
  display: none;
}

.git-pin__spin {
  display: inline-block;
  color: var(--accent-blue);
  animation: git-pin-spin 1s linear infinite;
}

@keyframes git-pin-spin {
  to { transform: rotate(360deg); }
}

/* The toast has one home: the right end of the switcher's row, over the
   row's empty end and never over a place's actions, so it is always where
   it was last time and never in front of the button the user wants next.
   It floats there, so showing it moves nothing. It stands above everything
   else in the pin — the places' sticky crumbs and split handles are raised
   too, and come later — so a failure hanging down over a place is not drawn
   behind it.

   Its kind is its colour (--git-kind): washed through the surface, the
   border, the glyph and the actions — green for what was done, yellow for
   what stopped short, red for what failed. The inline errors, a choice's
   account of a failure and a dialog's refusal speak the same way. */
.git-pin__toast {
  --git-kind: var(--success);
  --btn-ghost-hover-bg: color-mix(in srgb, var(--git-kind) 18%, transparent);
  --btn-ghost-hover-border: transparent;

  position: absolute;
  right: var(--pane-inset);
  top: 50%;
  transform: translateY(-50%);
  z-index: var(--z-controls);
  display: flex;
  align-items: center;
  gap: var(--space-6);
  max-width: calc(100% - 2 * var(--pane-inset));
  padding: var(--space-2) var(--space-6) var(--space-2) var(--space-8);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  background: color-mix(in srgb, var(--git-kind) 14%, var(--bg-raised));
  border: 1px solid color-mix(in srgb, var(--git-kind) 45%, transparent);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  white-space: nowrap;
}

.git-pin__toast--warn {
  --git-kind: var(--warning);
}

.git-pin__toast--error {
  --git-kind: var(--danger);
}

.git-pin__toast-icon {
  flex: none;
  font-weight: var(--font-weight-semibold);
  color: var(--git-kind);
}

.git-pin__toast :is(.git-pin__toast-action, .git-pin__toast-undo) {
  font-weight: var(--font-weight-semibold);
  color: var(--git-kind);
}

.git-pin__toast[hidden] {
  display: none;
}

/* A failure or a warning hangs down from the row rather than centring on it,
   so the lines it wraps to grow over the place below and never off the top of
   the pin. */
.git-pin__toast--error,
.git-pin__toast--warn {
  top: var(--space-2);
  transform: none;
  align-items: flex-start;
  width: max-content;
  max-width: min(32rem, calc(100% - 2 * var(--pane-inset)));
  padding-block: var(--space-4);
  white-space: normal;
}

:is(.git-pin__toast--error, .git-pin__toast--warn) .git-pin__toast-text {
  max-height: 10lh;
  overflow-y: auto;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  user-select: text;
  -webkit-user-select: text;
}

.git-pin__log {
  flex: none;
  border-top: 1px solid var(--border-divider);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
}

.git-pin__log-toggle {
  display: block;
  width: 100%;
  font: inherit;
  color: inherit;
  text-align: start;
  background: none;
  border: 0;
  padding: var(--space-4) var(--pane-inset);
  cursor: pointer;
}

.git-pin__log-toggle:hover {
  color: var(--text-secondary);
}

/* Closed, the log's line marks a last command that failed. */
.git-pin__log-failed {
  margin-inline-end: var(--space-4);
  color: var(--danger);
}

.git-pin__log-list {
  max-height: 9rem;
  overflow: auto;
  padding: 0 var(--pane-inset) var(--space-4);
}

.git-pin__log-entry {
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--space-8);
}

.git-pin__log-cmd {
  white-space: pre-wrap;
  color: var(--text-secondary);
}

.git-pin__log-entry[data-state="failed"] .git-pin__log-state {
  color: var(--danger);
}

.git-pin__log-progress {
  color: var(--text-tertiary);
}

.git-pin__log-output {
  flex-basis: 100%;
  margin: 0;
  white-space: pre-wrap;
}

.git-changes {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.git-changes[hidden] {
  display: none;
}

.git-changes__body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr;
}

.git-changes__list {
  container: git-changes-list / inline-size;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.git-changes__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* The detail is a column whose diff (or file) takes the height left under the
   crumb and scrolls itself — a diff viewer's own height cap is for one shown
   inline among other things, which this one is not. */
.git-changes__detail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
}

/* A file's diff fills the detail edge to edge: the pane's dividers frame it,
   so it draws no border or shadow of its own. An untracked file's whole
   content is inset, as a file viewer may draw right up to its edge. */
.git-changes__viewer,
.git-changes__file {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.git-changes__file {
  padding: var(--space-8);
  overflow: auto;
}

@container git-pin (width < 34rem) {
  .git-pin[data-level="list"] .git-changes__detail,
  .git-pin[data-level="detail"] .git-changes__list,
  .git-pin[data-level="list"] .git-refs__detail,
  .git-pin[data-level="detail"] .git-refs__list,
  .git-pin[data-level="list"] .git-history__detail,
  .git-pin[data-level="detail"] .git-history__list {
    display: none;
  }

  /* A detail has no switcher, but its row comes back while a toast is up:
     that is the toast's home. */
  [data-level="detail"] .git-pin__places:has(> .git-pin__toast[hidden]) {
    display: none;
  }
}

@container git-pin (width >= 34rem) {
  .git-changes__body {
    --git-split-at: clamp(15rem, var(--git-split-changes, 42%), calc(100% - 16rem));

    grid-template-columns: var(--git-split-at) 1fr;
  }

  .git-changes__detail {
    border-left: 1px solid var(--border-divider);
  }

  .git-changes__back {
    display: none;
  }
}

.git-pin__main {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}

/* A split's handle (pins/git/splitter): a strip astride the line between a
   list and its detail, or at the sidebar's edge, lit while hovered, dragged
   or focused. Shown only where there is a split to move. A list's handle
   stands where the stylesheet puts the line, --git-split-at, the same
   clamped expression its body sizes the first column by. */
.git-split {
  display: none;
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--git-split-at, 50%);
  z-index: var(--z-raised);
  width: 0.5rem;
  margin-left: calc(-1 * var(--space-4));
  cursor: var(--cursor-col-resize);
  touch-action: none;
}

.git-split--sidebar {
  left: 100%;
}

.git-split::after {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0.1875rem;
  width: 0.125rem;
  content: "";
  background: transparent;
  transition: background-color var(--transition-fast);
}

.git-split:hover::after,
.git-split:focus-visible::after,
.git-split--dragging::after {
  background: var(--accent-blue);
}

.git-split:focus-visible {
  outline: none;
}

.git-pin[data-resizing] {
  cursor: var(--cursor-col-resize);
  user-select: none;
}

@container git-pin (width >= 34rem) {
  .git-changes__body > .git-split,
  .git-history__body > .git-split,
  .git-refs__body > .git-split {
    display: block;
  }
}

.git-pin__main > .git-pin__place {
  flex: 1 1 0;
  min-width: 0;
}

/* Beside Changes and History the Refs place is left unhidden, for a full pin
   to show as a sidebar; at any other size it is not shown there. */
.git-pin[data-place="changes"] .git-refs,
.git-pin[data-place="history"] .git-refs {
  display: none;
}

/* Full: beside Changes and History, the Refs list as a sidebar — its detail is
   what the place it is beside shows. Refs is never a place of its own there
   (git-pin's placeFor), so it has no tab beside any place. */
@container git-pin (width > 60rem) {
  .git-pin__place-btn[data-place="refs"] {
    display: none;
  }

  .git-pin[data-place="changes"] .git-refs,
  .git-pin[data-place="history"] .git-refs {
    position: relative;
    display: flex;
    order: -1;
    flex: 0 0 clamp(10rem, var(--git-split-sidebar, 14rem), 40%);
    border-right: 1px solid var(--border-divider);
    background: var(--bg-primary);
  }

  .git-pin[data-place="changes"] .git-refs__body,
  .git-pin[data-place="history"] .git-refs__body {
    grid-template-columns: 1fr;
  }

  .git-pin[data-place="changes"] .git-refs > .git-split--sidebar,
  .git-pin[data-place="history"] .git-refs > .git-split--sidebar {
    display: block;
  }

  .git-pin[data-place="changes"] .git-refs__body > .git-split,
  .git-pin[data-place="history"] .git-refs__body > .git-split,
  .git-pin[data-place="changes"] .git-refs__detail,
  .git-pin[data-place="history"] .git-refs__detail,
  .git-pin[data-place="changes"] .git-refs__chip--conv,
  .git-pin[data-place="history"] .git-refs__chip--conv {
    display: none;
  }
}

/* Squeezed: the head drops the repository's name when there is no other to
   choose — the switcher names it too — but keeps it while it is a chooser. */
@container git-pin (width < 24rem) {
  .git-pin__ref[data-repo-optional] > .git-pin__repo,
  .git-pin__ref[data-repo-optional] > .git-pin__slash {
    display: none;
  }
}

@container git-pin (width < 16rem) {
  .git-pin__sync {
    display: none;
  }
}

/* Chip: a pin too short for anything else is its head line. It is height that
   makes one, so a narrow pin in a tall sidebar stays a stack. */
.git-pin[data-mode="chip"] > :is(.git-op, .git-pin__main, .git-pin__log),
.git-pin[data-mode="chip"] .git-pin__places {
  display: none;
}

.git-pin[data-mode="chip"] > .git-pin__head {
  flex: 1;
  border-bottom: 0;
}

.git-pin[data-mode="chip"] > .git-pin__toast {
  right: auto;
  left: 50%;
  transform: translate(-50%, -50%);
}

.git-pin[data-mode="chip"] > :is(.git-pin__toast--error, .git-pin__toast--warn) {
  transform: translateX(-50%);
}

.git-changes[data-big="true"] .git-changes__scroll {
  display: none;
}

.git-changes[data-big="true"] .git-commit {
  flex: 1;
  min-height: 0;
  border-top: 0;
}

.git-changes[data-big="true"] .git-commit__wrap {
  flex: 1;
}

.git-changes[data-big="true"] .git-commit__msg {
  flex: 1;
  max-height: none;
}

/* Exactly the headerHeight the windowed list places rows by
   (changes-place.js): sized by its content instead, a header a fraction taller
   pushes every row below it off where the list believes it is. */
.git-changes__sect {
  box-sizing: border-box;
  height: 2rem;
  display: flex;
  align-items: center;
  gap: var(--space-6);
  padding: 0 var(--space-6) 0 var(--pane-inset);
  color: var(--text-tertiary);
  user-select: none;
}

.git-changes__count {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}

.git-changes__group-act {
  margin-left: auto;
  font: inherit;
  font-size: var(--font-size-xs);
  color: var(--accent-blue);
  background: none;
  border: 0;
  padding: 0 var(--space-2);
  cursor: pointer;
}

.git-changes__row {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  height: 1.5rem;
  padding: 0 var(--space-4) 0 var(--pane-inset);
  font-size: var(--font-size-sm);
  white-space: nowrap;
  min-width: 0;
  cursor: default;
}

.git-changes__row:hover {
  background: var(--wash-1);
}

.git-changes__row[aria-selected="true"] {
  background: var(--selection-bg);
}

.git-changes__row[aria-selected="true"]:hover {
  background: linear-gradient(var(--wash-2), var(--wash-2)), var(--selection-bg);
}

.git-changes__row[data-pending="true"] {
  opacity: 0.6;
}

.git-changes__more {
  visibility: hidden;
}

.git-changes__row:hover .git-changes__more,
.git-changes__row[aria-selected="true"] .git-changes__more {
  visibility: visible;
}

/* The letter is the app's change-status badge; here it is also the button that
   stages the file, which says so as the pointer reaches it. */
.git-changes__st {
  cursor: pointer;
}

.git-changes__st:hover {
  outline: var(--space-2) solid color-mix(in srgb, var(--change-tone) 45%, transparent);
}

/* As the review rail lays a path out: the name, then the directory, which
   gives up its width first. */
.git-changes__path {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: var(--space-6);
}

.git-changes__name {
  flex: 0 1 auto;
  min-width: 0;
}

.git-changes__dir {
  flex: 1 1 0;
  min-width: 0;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

/* What changed inside a submodule, where a file's directory would be. */
.git-changes__inside {
  flex: 1 1 0;
  min-width: 0;
  font-size: var(--font-size-meta);
  color: var(--text-tertiary);
}

/* A lozenge: a word about the file (binary, LFS, submodule). */
.git-changes__badge {
  flex: none;
  font-size: var(--font-size-xs);
  line-height: var(--leading-tight);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  padding: 0 var(--space-8);
}

.git-changes__part {
  font-size: var(--font-size-xs);
  color: var(--accent-blue);
}

.git-changes__nums {
  display: flex;
  gap: var(--space-4);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}

.git-changes__sides {
  display: flex;
  gap: var(--space-2);
  flex: none;
}

@container git-changes-list (width < 22rem) {
  .git-changes__sides {
    display: none;
  }
}

.git-changes__add { color: var(--accent-green); }
.git-changes__del { color: var(--accent-red); }

.git-changes__empty,
.git-changes__placeholder {
  padding: var(--section-gap) var(--pane-inset);
  text-align: center;
  color: var(--text-tertiary);
  line-height: var(--leading-relaxed);
}

.git-changes__empty-title {
  color: var(--text-secondary);
}

.git-changes__more-files,
.git-changes__error {
  padding: var(--space-6) var(--pane-inset);
  font-size: var(--font-size-meta);
  color: var(--text-tertiary);
}

/* A read that failed, or a write refused, said where it happened: one look in
   every place (pins/git/inline-error), tinted as a warning toast is, with
   Retry when reading again may help. It wins over the place's own rule for
   the same element, and sits inset in the pane as a box of its own. */
.git-pin .git-inline-error {
  --git-kind: var(--warning);

  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-4) var(--space-6);
  margin: var(--space-4) var(--pane-inset);
  padding: var(--space-4) var(--space-8);
  font-size: var(--font-size-meta);
  color: var(--text-primary);
  background: color-mix(in srgb, var(--git-kind) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--git-kind) 40%, transparent);
  border-radius: var(--radius-lg);
}

/* Where the pane already insets what it holds. */
.git-history__meta > .git-inline-error,
.git-pin__content > .git-inline-error {
  margin-inline: 0;
}

.git-inline-error__icon {
  flex: none;
  font-weight: var(--font-weight-semibold);
  color: var(--git-kind);
}

.git-inline-error__text {
  flex: 1 1 12rem;
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.git-inline-error__retry {
  flex: none;
}

/* Every place's detail has the same crumb: the way back to the list in a
   stack, and in Changes and Refs the detail's title too. It never shrinks:
   its min-height replaces the flex item's min-content floor, so a tall file
   under it would squeeze a wrapped crumb to one row and spill the rest over
   the content. */
.git-changes__crumb,
.git-refs__crumb,
.git-history__crumb {
  position: sticky;
  top: 0;
  z-index: var(--z-raised);
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2) var(--toolbar-gap);
  box-sizing: border-box;
  min-height: 2rem;
  padding: var(--space-2) var(--space-6) var(--space-2) var(--pane-inset);
  white-space: nowrap;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-divider);
}

/* The bar is the same height as the lists' section headers, so the columns'
   first rows line up. What does not fit on it — the diff's view options, then
   the actions — wraps under the file's name rather than squeezing it away. */
.git-changes__crumb-title {
  flex: 0 1 auto;
  min-width: 0;
  font-family: var(--font-mono);
  font-weight: var(--font-weight-semibold);
}

.git-changes__crumb-nums {
  flex: none;
  margin-right: auto;
}

.git-changes__view-opts {
  flex: none;
}

.git-changes__view-opts + .git-changes__crumb-acts {
  padding-left: var(--toolbar-gap);
  border-left: 1px solid var(--border-divider);
}

.git-changes__crumb-discard-lines[hidden] {
  display: none;
}

/* The title is one line of inline text, cut at its end, so the directory is
   set off from the name by a margin rather than a row's flex gap. */
.git-changes__crumb-title .git-changes__dir {
  margin-left: var(--space-6);
  font-weight: var(--font-weight-normal);
}

.git-changes__crumb-acts {
  display: flex;
  align-items: center;
  gap: var(--toolbar-gap);
  flex: none;
}

.git-changes__note {
  padding: var(--space-6) var(--pane-inset);
  font-size: var(--font-size-meta);
  color: var(--warning);
  border-bottom: 1px solid var(--border-divider);
}

.git-changes__note[hidden],
.git-changes__placeholder[hidden],
.git-changes__viewer[hidden],
.git-changes__file[hidden] {
  display: none;
}

.git-commit {
  container: git-commit / inline-size;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--stack-gap);
  padding: var(--space-8) var(--pane-inset);
  border-top: 1px solid var(--border-divider);
}

.git-commit__files {
  align-self: flex-start;
}

.git-commit__wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.git-commit__msg {
  display: block;
  width: 100%;
  resize: none;
  min-height: 1.85rem;
  max-height: min(calc(var(--git-pin-height, 100vh) * 0.45), 20rem);
  padding-right: var(--space-24);
  overflow-y: auto;
}

.git-commit__msg::placeholder {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-pin[data-tall] .git-commit__msg:focus {
  min-height: 6rem;
}

.git-commit__expand {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
}

.git-commit__expand .git-pin__icon {
  width: 1rem;
  height: 1rem;
  stroke-width: 1.5;
}

.git-commit__len {
  position: absolute;
  bottom: var(--space-4);
  right: var(--space-6);
  pointer-events: none;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
}

.git-commit__len[data-over="true"] {
  color: var(--warning);
}

/* The checkbox on one line, the buttons on the next, flush right — unless
   the box is wide enough for both on one line, the buttons still at its end. */
.git-commit__row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--stack-gap);
  min-width: 0;
}

@container git-commit (width >= 24rem) {
  .git-commit__row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
}

.git-commit__options {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--stack-gap-tight) var(--toolbar-gap);
  min-width: 0;
}

.git-commit__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--toolbar-gap);
}

.git-commit__option {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  font-size: var(--font-size-meta);
  color: var(--text-secondary);
  white-space: nowrap;
}

/* Why Commit is not offered, beside it, so the button keeps its own name. */
.git-commit__hint {
  font-size: var(--font-size-meta);
  color: var(--text-tertiary);
  white-space: nowrap;
}

.git-commit__hint[hidden] {
  display: none;
}

.git-commit__option[hidden] {
  display: none;
}

.git-commit__amend-short {
  display: none;
}

@container git-commit (width < 22rem) {
  .git-commit__amend-long {
    display: none;
  }

  .git-commit__amend-short {
    display: inline;
  }
}

.git-commit__output {
  margin: 0;
  max-height: 8rem;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
  color: var(--text-secondary);
}

.git-commit__output[hidden] {
  display: none;
}

.git-commit__op {
  font-size: var(--font-size-meta);
  color: var(--warning);
}

.git-commit__op[hidden] {
  display: none;
}

/* Auto-generate: the neutral button beside Commit, as the pin's other
   secondary actions are; while a message is written it is Stop, pulsing. */
.git-commit__gen {
  white-space: nowrap;
}

.git-commit__gen[data-running="true"] {
  animation: git-gen-pulse 1.2s ease-in-out infinite;
}

@keyframes git-gen-pulse {
  50% { opacity: 0.35; }
}

.git-commit__source {
  align-self: flex-start;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: none;
  font-size: var(--font-size-meta);
  color: var(--text-tertiary);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.git-commit__source:hover {
  color: var(--text-secondary);
}

.git-commit__source[data-kind="error"] {
  color: var(--warning);
}

.git-commit__source[hidden] {
  display: none;
}

.git-gen-menu {
  min-width: 16rem;
  max-width: 24rem;
}

.git-gen-menu__item {
  display: flex;
  align-items: baseline;
  gap: var(--space-8);
  width: 100%;
  text-align: start;
}

.git-gen-menu__label {
  flex: 1 1 auto;
  min-width: 0;
}

.git-gen-menu__meta {
  flex: 0 0 auto;
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
}

.git-gen-menu__loading {
  color: var(--text-tertiary);
  font-style: italic;
}

.git-refs {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.git-refs[hidden] {
  display: none;
}

.git-refs__body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr;
}

/* After the rules it overrides, at their specificity: written before them, a
   split would lose to the single column at any width. */
@container git-pin (width >= 34rem) {
  .git-refs__body {
    --git-split-at: clamp(15rem, var(--git-split-refs, 42%), calc(100% - 16rem));

    grid-template-columns: var(--git-split-at) 1fr;
  }

  .git-refs__detail {
    border-left: 1px solid var(--border-divider);
  }

  .git-refs__back {
    display: none;
  }
}

.git-refs__list {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.git-refs__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* A scroller clips what is drawn outside it: the shared ring goes inside. */
.git-refs__scroll:focus-visible {
  outline-offset: calc(-1 * var(--focus-ring-width));
}

.git-refs__detail {
  min-height: 0;
  overflow: auto;
}

/* Exactly the headerHeight the windowed list places rows by (refs-place.js),
   as the Changes sections are. */
.git-refs__sect {
  box-sizing: border-box;
  height: 2rem;
  display: flex;
  align-items: center;
  gap: var(--space-6);
  padding: 0 var(--space-6) 0 var(--pane-inset);
  color: var(--text-tertiary);
  white-space: nowrap;
  user-select: none;
}

/* A section with nothing in it says so by its count alone. */
.git-refs__sect[data-empty] .git-refs__fold {
  opacity: 0.7;
}

/* A section's title is the button that folds it. */
.git-refs__fold {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}

.git-refs__fold:hover {
  color: var(--text-secondary);
}

.git-refs__fold .git-refs__title {
  min-width: 0;
}

.git-refs__fold .git-pin__icon--chev {
  transition: transform var(--transition-base);
}

.git-refs__fold[aria-expanded="false"] .git-pin__icon--chev {
  transform: rotate(-90deg);
}

.git-refs__count {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}

/* The section's actions answer the pointer over the header, as a row's ⋯
   does; a keyboard reaches them regardless, and a touchscreen always sees them. */
.git-refs__sect-acts {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-6);
  margin-left: auto;
}

@media (hover: hover) {
  .git-refs__sect:not(:hover, :focus-within) .git-refs__sect-acts {
    opacity: 0;
  }
}

.git-refs__sect-act {
  font: inherit;
  font-size: var(--font-size-xs);
  color: var(--accent-blue);
  background: none;
  border: 0;
  padding: 0 var(--space-2);
  cursor: pointer;
}

.git-refs__sect-act:disabled {
  color: var(--text-tertiary);
  cursor: default;
}

.git-refs__row {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  height: 1.5rem;
  padding: 0 var(--space-4) 0 var(--pane-inset);
  white-space: nowrap;
  min-width: 0;
  cursor: pointer;
}

.git-refs__row:hover {
  background: var(--wash-1);
}

.git-refs__row[aria-selected="true"] {
  background: var(--selection-bg);
}

.git-refs__row[aria-selected="true"]:hover {
  background: linear-gradient(var(--wash-2), var(--wash-2)), var(--selection-bg);
}

.git-refs__more {
  visibility: hidden;
}

.git-refs__row:hover .git-refs__more,
.git-refs__row[aria-selected="true"] .git-refs__more {
  visibility: visible;
}

.git-refs__name {
  flex: 1;
  min-width: 0;
}

.git-refs__mono {
  font-family: var(--font-mono);
}

.git-refs__dir {
  margin-left: var(--space-6);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
}

.git-refs__here {
  flex: none;
  width: 0.6rem;
  color: var(--accent-blue);
}

.git-refs__glyph {
  display: inline-flex;
  color: var(--text-tertiary);
}

.git-refs__glyph--viewing {
  color: var(--accent-blue);
}

.git-refs__dirty {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--accent-yellow);
}

.git-refs__nums {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.git-refs__chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  max-width: 10rem;
  font-size: var(--font-size-xs);
  line-height: var(--leading-tight);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  padding: 0 var(--space-8);
}

.git-refs__error,
.git-refs__more {
  display: block;
  padding: var(--space-2) var(--pane-inset) var(--space-4);
  font-size: var(--font-size-meta);
  color: var(--text-tertiary);
}

.git-refs__empty,
.git-refs__placeholder {
  padding: var(--section-gap) var(--pane-inset);
  text-align: center;
  color: var(--text-tertiary);
}

.git-refs__crumb-title {
  display: inline-flex;
  align-items: center;
  gap: var(--space-6);
  flex: 1;
  min-width: 0;
  font-weight: var(--font-weight-semibold);
}

/* As a commit's detail: what the ref is, then a section below it, what can be
   done with it. */
.git-refs__meta {
  display: flex;
  flex-direction: column;
  gap: var(--section-gap);
  padding: var(--pane-inset);
}

.git-refs__facts {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: var(--stack-gap-tight) var(--space-12);
  margin: 0;
  font-size: var(--font-size-meta);
}

.git-refs__facts dt {
  color: var(--text-tertiary);
}

.git-refs__facts dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.git-refs__message {
  white-space: pre-wrap;
}

.git-refs__tip {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--space-4);
}

.git-refs__sha {
  padding: 0;
  font: inherit;
  font-family: var(--font-mono);
  color: var(--accent-blue);
  background: none;
  border: 0;
  cursor: pointer;
}

.git-refs__sha:hover {
  text-decoration: underline;
}

.git-refs__acts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--toolbar-gap);
}

.git-refs__acts-head {
  flex-basis: 100%;
  color: var(--text-tertiary);
}

.git-history {
  --git-history-lanes: 6;
  --git-history-lane-0: var(--accent-blue);
  --git-history-lane-1: var(--accent-orange);
  --git-history-lane-2: var(--accent-green);
  --git-history-lane-3: var(--accent-purple);
  --git-history-lane-4: var(--accent-red);
  --git-history-lane-5: var(--accent-yellow);
  --git-history-lane-6: color-mix(in srgb, var(--accent-blue) 55%, var(--accent-green));
  --git-history-lane-7: color-mix(in srgb, var(--accent-purple) 55%, var(--accent-red));

  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.git-history[hidden] {
  display: none;
}

.git-history__body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr;
}

.git-history__list {
  container: git-history-list / inline-size;
  position: relative;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.git-history__bar,
.git-list-filter {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: var(--toolbar-gap);
  padding: var(--space-4) var(--pane-inset);
  border-bottom: 1px solid var(--border-divider);
}

.git-history__scope {
  max-width: 100%;
}

/* The filter and what it searches, as one field: the picker sits at its end. */
.git-history__search {
  flex: 1 1 12rem;
  min-width: 8rem;
  display: flex;
  align-items: stretch;
}

.git-history__search > .git-history__filter {
  flex: 1;
  min-width: 0;
  border-start-end-radius: 0;
  border-end-end-radius: 0;
}

.git-history__search > .git-history__field {
  flex: none;
  color: var(--text-secondary);
  background-color: var(--bg-secondary);
  border-start-start-radius: 0;
  border-end-start-radius: 0;
}

.git-history__filter,
.git-list-filter__input {
  flex: 1 1 8rem;
  min-width: 6rem;
}

/* The Changes and Refs filter bar is hidden until asked for, and display:flex would beat [hidden]. */
.git-list-filter[hidden] {
  display: none;
}

.git-history__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.git-graph__dot--worktree {
  fill: var(--bg-secondary);
  stroke: var(--accent-yellow);
  stroke-width: 2.2;
}

.git-graph__out--worktree {
  stroke-dasharray: 2.5 2;
}

.git-history__wip-text {
  font-style: italic;
}

.git-history__wip-count {
  margin-inline-start: var(--space-6);
  font-size: var(--font-size-xs);
  font-style: normal;
  color: var(--text-secondary);
}

.git-history__wip-go {
  flex: none;
  padding-inline-end: var(--space-6);
  font-size: var(--font-size-xs);
  color: var(--accent-blue);
}

/* The list takes focus to take the arrow keys, and the selected row is where
   they are: a ring round the whole list would say nothing the row does not. */
.git-history__scroll:focus,
.git-history__scroll:focus-visible {
  outline: none;
}

/* The shared ring, inside the row: the scroller clips what is drawn outside it. */
.git-history__scroll:focus .git-history__row[aria-selected="true"] {
  outline: var(--focus-ring);
  outline-offset: calc(-1 * var(--focus-ring-width));
}

.git-history__spacer {
  position: relative;
}

.git-history__row {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  padding: 0 var(--space-2);
  white-space: nowrap;
  min-width: 0;
  cursor: default;
}

.git-history__row:hover {
  background: var(--wash-1);
}

/* The working tree's changes, as their row of the graph, right above HEAD's:
   tinted, its ring hollow and its edge into HEAD dashed — a commit still to
   come. A click shows them in Changes, so it takes the pointer that other rows,
   which only select, do not. After the plain row's rules, which match it at the
   same specificity; before the selected row's, which it gives way to. */
.git-history__row--worktree {
  background: color-mix(in srgb, var(--accent-yellow) 10%, transparent);
  cursor: pointer;
}

.git-history__row--worktree:hover {
  background: color-mix(in srgb, var(--accent-yellow) 18%, transparent);
}

/* A marked run is drawn as one selection, every row of it alike. */
.git-history__row[aria-selected="true"],
.git-history__row--in-run {
  background: var(--selection-bg);
}

/* Hovering a selected row tints the selection rather than replacing it. */
.git-history__row[aria-selected="true"]:hover,
.git-history__row--in-run:hover {
  background: linear-gradient(var(--wash-2), var(--wash-2)), var(--selection-bg);
}

.git-history__more {
  flex: none;
  margin-inline-start: var(--space-2);
  visibility: hidden;
}

.git-history__row:hover .git-history__more,
.git-history__row[aria-selected="true"] .git-history__more {
  visibility: visible;
}

.git-history__acts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--toolbar-gap);
}

/* A little room after the lanes, so the subject and its chips don't crowd the
   rightmost line. */
.git-graph {
  flex: none;
  margin-inline-end: var(--space-6);
  fill: none;
  stroke-width: 1.6;
}

.git-graph__dot--head {
  fill: var(--bg-secondary);
  stroke-width: 2.2;
}

.git-graph__dot--over {
  fill: none;
  stroke-dasharray: 2 1.5;
}

.git-history__subject {
  flex: 1;
  min-width: 0;
  padding-inline: var(--space-4) var(--space-8);
}

/* The checked-out commit: tinted, its subject bold, so it is found at a
   glance and not only by reading its branch's chip. */
.git-history__row--head {
  background: color-mix(in srgb, var(--accent-blue) 8%, transparent);
}

.git-history__row--head .git-history__subject {
  font-weight: var(--font-weight-semibold);
}

/* Author, id and time are narrow columns of fixed width, each in a face of its
   own, so they line up row under row. A divider the row's full height starts
   each, so they need only a little padding to be told apart, and the room goes
   to the subject and its chips. */
.git-history__author,
.git-history__sha,
.git-history__when {
  flex: none;
  align-self: stretch;
  padding-inline: var(--space-6);
  font-size: var(--font-size-xs);
  line-height: var(--git-history-row);
  border-inline-start: 0.0625rem solid var(--border-divider);
}

.git-history__author {
  width: 6.5rem;
  color: var(--text-secondary);
}

/* Seven characters of the id, and its padding. */
.git-history__sha {
  width: calc(7ch + 2 * var(--space-6) + 0.0625rem);
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

.git-history__when {
  width: 6.75rem;
  text-align: end;
  font-variant-numeric: tabular-nums;
  color: var(--text-tertiary);
}


/* By the list's own width, which beside a commit's detail is half the pin's. */
@container git-history-list (width < 36rem) {
  .git-history__sha {
    display: none;
  }
}

@container git-history-list (width < 26rem) {
  .git-history__author {
    display: none;
  }
}

/* A ref's lozenge: a solid fill per kind, from the context-item presets, whose
   --ci-text reads on every one of them in either theme (deep fills under white
   in dark, pale ones under ink in light). The UI face, a small corner and
   tight padding keep a row of them narrow. */
.git-history__chip {
  --git-chip-fill: var(--ci-preset-slate);

  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-right: var(--space-4);
  padding: 0 var(--space-4);
  font-family: var(--font-ui);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  line-height: var(--leading-tight);
  color: var(--ci-text);
  background: var(--git-chip-fill);
  border-radius: var(--radius-sm);
  vertical-align: 0.05em;
}

/* A reflog row's move, in git's words, ahead of the commit's subject. */
.git-history__reflog {
  margin-right: var(--space-6);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
}

/* The checked-out branch is the one chip in the accent itself, bold, so it
   stands out from the other branches' deeper or paler blue. A remote branch
   keeps the neutral fill. */
.git-history__chip[data-kind="head"] {
  --git-chip-fill: var(--accent-blue);

  color: var(--text-on-accent);
  font-weight: var(--font-weight-bold);
}

.git-history__chip[data-kind="branch"] {
  --git-chip-fill: var(--ci-preset-blue);
}

.git-history__chip[data-kind="wt"],
.git-history__chip[data-kind="detached"] {
  --git-chip-fill: var(--ci-preset-purple);
}

.git-history__chip[data-kind="tag"] {
  --git-chip-fill: var(--ci-preset-orange);
}

.git-history__note {
  padding: var(--section-gap) var(--pane-inset);
  text-align: center;
  color: var(--text-tertiary);
}

.git-history__note[hidden],
.git-history__list-error[hidden] {
  display: none;
}

.git-history__list-error {
  padding-block: var(--space-2);
}

.git-history__detail {
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.git-history__crumb-title {
  flex: 1;
  min-width: 0;
}

/* The split, after the body, detail and crumb rules it overrides, at their
   specificity: written before them it would lose to the single column at any
   width. The crumb is the way back to the list, which a split shows anyway. */
@container git-pin (width >= 34rem) {
  .git-history__body {
    --git-split-at: clamp(18rem, var(--git-split-history, 55%), calc(100% - 14rem));

    grid-template-columns: var(--git-split-at) 1fr;
  }

  .git-history__detail {
    border-left: 1px solid var(--border-divider);
  }

  .git-history__crumb {
    display: none;
  }
}

.git-history__mono {
  font-family: var(--font-mono);
}

.git-history__placeholder {
  padding: var(--section-gap) var(--pane-inset);
  text-align: center;
  color: var(--text-tertiary);
}

/* Two groups, a section apart: what the commit is (.git-history__about), then
   what can be done with it (.git-history__acts). Every part of the pane,
   the files below included, starts at --pane-inset. */
.git-history__meta {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--section-gap);
  padding: var(--pane-inset);
}

.git-history__about {
  display: flex;
  flex-direction: column;
  gap: var(--stack-gap);
  min-width: 0;
}

.git-history__title {
  font-size: var(--font-size-title);
  font-weight: var(--font-weight-semibold);
  line-height: var(--leading-snug);
  overflow-wrap: anywhere;
}

.git-history__message {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--font-size-body);
  line-height: var(--leading-normal);
  color: var(--text-secondary);
}

.git-history__facts {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: var(--stack-gap-tight) var(--space-12);
  margin: 0;
  font-size: var(--font-size-meta);
}

.git-history__id {
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
}

.git-history__copy {
  --btn-icon-size: 1.25rem;
  --btn-glyph: 0.875rem;
}

.git-history__facts dt {
  color: var(--text-tertiary);
}

.git-history__facts dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.git-history__parents {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--space-6);
}

.git-history__parent {
  padding: 0;
  font: inherit;
  font-family: var(--font-mono);
  color: var(--accent-blue);
  background: none;
  border: 0;
  cursor: pointer;
}

.git-history__parent:hover {
  text-decoration: underline;
}

.git-history__outside {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--toolbar-gap);
  font-size: var(--font-size-meta);
  color: var(--text-secondary);
}

.git-history__error {
  font-size: var(--font-size-meta);
  color: var(--text-tertiary);
}

/* The review panel draws no inset of its own: its host gives it the pane's. */
.git-history__files {
  flex: 1 0 auto;
  min-height: 18rem;
  padding: var(--pane-inset);
  border-top: 1px solid var(--border-divider);
}

.git-history__files[hidden] {
  display: none;
}

/* The anchored popovers. A confirmation's dialog is a .git-pop too, so the
   pin can find whichever question is open, but it is the app's dialog and
   keeps the dialog's own chrome. */
.git-pop.dropdown-menu {
  min-width: 14rem;
  max-width: 24rem;
  padding: var(--menu-padding);
}

.git-pop__ask,
.git-pop__choose {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.git-pop__label {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  font-size: var(--font-size-sm);
}

/* askText's fields, in the app's form dialog. */
.git-ask {
  gap: var(--space-12);
}

.git-ask .git-pop__label {
  gap: var(--space-6);
  color: var(--text-secondary);
}

/* A message of several lines: a reword's. */
.git-pop__input--lines {
  min-height: 7rem;
  resize: vertical;
  font-family: var(--font-mono);
}

/* The chip's commit popover: the commit box itself, lent from the list. */
.git-pop.git-pop--commit {
  width: 24rem;
  max-width: calc(100vw - var(--space-16));
}

.git-pop__commit {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.git-pop__commit > .git-commit {
  padding: 0;
  border-top: 0;
}

.git-pop__check {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

/* A confirmation's question with its checkbox under it. */
.git-pop__confirm {
  display: flex;
  flex-direction: column;
  gap: var(--stack-gap);
}

/* A confirmation's question, set as the dialog sets its own message. */
.git-pop__text {
  margin: 0;
  line-height: var(--leading-relaxed);
  color: var(--text-primary);
}

/* chooseAction's caption: inset to line up with the rows under it, as a menu's
   header does. */
.git-pop__title {
  padding: var(--space-4) var(--menu-item-padding-inline) var(--space-2);
  font-size: var(--font-size-xs);
  line-height: var(--leading-normal);
  color: var(--text-tertiary);
}

/* chooseAction's account of what went wrong: git's words whole, at the size
   of the choices under it, to be read and copied — tinted as a warning toast
   is, since what follows are the ways past it. */
.git-pop__detail {
  max-width: 28rem;
  max-height: 12lh;
  overflow-y: auto;
  margin: var(--space-2) var(--space-2) var(--space-4);
  padding: var(--space-6) var(--space-8);
  font-size: var(--font-size-body);
  line-height: var(--leading-normal);
  color: var(--text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
  border-radius: var(--radius-lg);
}

/* askText's answer that its validate found wrong, under its field, tinted
   as a failure toast is; the field itself is marked by aria-invalid. */
.git-pop__problem {
  display: flex;
  align-items: baseline;
  gap: var(--space-6);
  padding: var(--space-4) var(--space-8);
  font-size: var(--font-size-meta);
  color: var(--text-primary);
  overflow-wrap: anywhere;
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
  border-radius: var(--radius-lg);
}

.git-pop__problem-icon {
  flex: none;
  font-weight: var(--font-weight-semibold);
  color: var(--danger);
}

.git-pop__problem[hidden] {
  display: none;
}

.git-pop__choose {
  gap: var(--space-2);
}

.git-pop__choice {
  font: inherit;
  text-align: start;
  color: var(--text-primary);
  background: none;
  border: 0;
  border-radius: var(--radius-menu-item);
  padding: var(--menu-item-padding-block) var(--menu-item-padding-inline);
  cursor: pointer;
}

.git-pop__choice:hover,
.git-pop__choice:focus-visible {
  background: var(--wash-1);
}

.git-switcher {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.git-switcher__tree,
.git-switcher__act {
  display: flex;
  font: inherit;
  text-align: start;
  color: var(--text-primary);
  background: none;
  border: 0;
  border-radius: var(--radius-menu-item);
  padding: var(--menu-item-padding-block) var(--menu-item-padding-inline);
  cursor: pointer;
}

.git-switcher__tree {
  flex-direction: column;
  gap: var(--space-2);
}

.git-switcher__act {
  align-items: center;
  gap: var(--space-6);
}

.git-switcher__tree:hover,
.git-switcher__act:hover,
.git-switcher__tree:focus-visible,
.git-switcher__act:focus-visible {
  background: var(--wash-1);
}

/* The tree in view, filled as every picker's chosen row is (patterns/menus.css
   .menu-item-selected); its muted greys and yellow would be unreadable on the
   accent, so they take the accent's own text colour. */
.git-switcher__tree[aria-current="true"] {
  color: var(--text-on-accent);
  background: var(--accent-blue);
}

.git-switcher__tree[aria-current="true"]:hover {
  background: var(--accent-blue-strong);
}

.git-switcher__tree[aria-current="true"] .git-switcher__mark,
.git-switcher__tree[aria-current="true"] .git-switcher__sub {
  color: color-mix(in srgb, var(--text-on-accent) 75%, transparent);
}

.git-switcher__line {
  display: flex;
  align-items: center;
  gap: var(--space-6);
  min-width: 0;
}

.git-switcher__name {
  flex: 1;
  min-width: 0;
}

.git-switcher__mark {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--accent-yellow);
}

.git-switcher__sub {
  display: flex;
  gap: var(--space-6);
  padding-left: calc(1em + var(--space-6));
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
}

.git-switcher__head {
  font-family: var(--font-mono);
}

.git-switcher__conv {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

/* A checkbox row's leading tick, in a gutter as wide as the other rows' icons
   so the labels line up whether it is on or off. It is drawn in the row's own
   colour, as the model picker's tick is. */
.git-switcher__check {
  display: inline-flex;
  flex: none;
  width: 1em;
}

.git-switcher__sep {
  margin: var(--space-2) 0;
  border-top: 1px solid var(--border-divider);
}
`);
}
