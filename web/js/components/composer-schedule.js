//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * composer-schedule — the composer's scheduled send ("send later"), for
 * composer.js.
 *
 * Clicking the clock button opens a picker that sends the box's message for
 * later. Two waits are offered:
 *   • a time   — a chosen wall-clock time (`notBefore`). The intended use is
 *                firing a queued command the instant the next LLM-provider time
 *                slice opens, so precision is coarse (5-minute granularity).
 *   • run end  — as soon as the thread's run is over (`hold: 'run-end'`).
 *                Distinct from just pressing Send mid-turn: that queues the
 *                message and the worker promotes it at the next turn boundary,
 *                steering the run in progress. This one keeps out of the running
 *                turn entirely and opens a fresh one once it has finished.
 * Either is a held send (the composer's `sendMessage({schedule})`): the worker
 * queues the message in the thread's pending queue at once, stamped with the
 * hold, and fires it itself — with or without a client connected. The box
 * empties as for any send, and neither the box nor its draft keeps a timer.
 *
 * Each function takes the Composer element as its first argument and reads or
 * writes its state through it, mirroring conversation-area-rendering.js.
 * @module components/composer-schedule
 */

import { t, formatDate, formatNumber } from '../../sdk/lib/i18n.js';

/**
 * The preset delay chips offered in the scheduled-send picker, tuned to the
 * primary use case: firing a command when the next LLM-provider time slice
 * opens. Minutes only — the picker's steppers cover everything in between.
 * Each chip is labelled by {@link formatDelayShort}.
 * @type {number[]}
 */
const SCHEDULE_PRESET_MINUTES = [15, 30, 60, 120, 180, 240, 300];

/** Granularity (minutes) of the scheduled-send picker — no finer than this. */
const SCHEDULE_MINUTE_STEP = 5;

/** Upper bound (hours) on the scheduled-send picker's hours stepper. */
const SCHEDULE_MAX_HOURS = 12;

/**
 * Format a millisecond duration compactly, as the preset chips are labelled:
 * "2h", "1h5m", "45m", or "<1m" under a minute.
 * @param {number} ms
 * @returns {string} The compact countdown string.
 */
function formatDelayShort(ms) {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  if (totalMin < 1) return t('<1m');
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return t('{hours}h{minutes}m', { hours: h, minutes: m });
  if (h) return t('{hours}h', { hours: h });
  return t('{minutes}m', { minutes: m });
}

/**
 * Format an epoch-ms instant as a 24-hour wall-clock time ("14:35" in English)
 * — the absolute time the user is actually aligning to ("sends at 14:35"). The
 * queued zone labels a held send with it too, so the picker and the queue read
 * the same clock.
 * @param {number} epochMs
 * @returns {string} The 24-hour wall-clock time, in the active locale's form.
 */
export function formatClockTime(epochMs) {
  return formatDate(epochMs, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/**
 * Reflect the box on the clock button. A scheduled send leaves the box the
 * moment it is armed — it waits in the worker's queue, not here — so the button
 * has no armed state to show: it is enabled exactly when the box holds
 * something to send.
 * @param {any} composer - Composer instance
 */
export function updateScheduleButton(composer) {
  const btn = composer.querySelector('.schedule-send-btn');
  if (!btn) return;
  /** @type {HTMLButtonElement} */ (btn).disabled = composer.isEmpty();
  btn.setAttribute('title', t('Send later'));
}

/**
 * Build the delay picker, detached; the composer's `_schedulePopup` presents
 * it, anchored to the clock button (or as a bottom sheet on a
 * phone): full-width preset chips (15m…5h), hours + 5-minute steppers, one
 * full-width "Schedule to send at HH:MM" button that both previews the target
 * time and confirms it, and below them the other wait: "Run at end of turn",
 * disabled unless a turn is actually running.
 *
 * Either choice sends the box's message as a held send (the composer's
 * `sendMessage({schedule})`): the worker queues it at once and fires it
 * itself, so the box empties like any send and keeps no timer of its own.
 * @param {any} composer - Composer instance
 * @returns {HTMLElement} The detached picker.
 */
export function buildSchedulePicker(composer) {
  const close = () => composer._schedulePopup.close();

  // A dialog, not a menu: it holds preset chips, steppers and a confirm button.
  const menu = document.createElement('div');
  menu.className = 'dropdown-menu schedule-send-menu';
  menu.id = 'schedule-send-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', t('Send later'));

  let hours = 1;
  let minutes = 0;

  const heading = document.createElement('div');
  heading.className = 'schedule-send-heading';
  heading.textContent = t('Send after a delay');
  menu.appendChild(heading);

  // Preset chips — stretch to fill the row.
  const presetRow = document.createElement('div');
  presetRow.className = 'schedule-preset-row';
  menu.appendChild(presetRow);

  // Steppers.
  const steppers = document.createElement('div');
  steppers.className = 'schedule-steppers';
  menu.appendChild(steppers);

  /**
   * @param {string} unitLabel - Shown beside the value.
   * @param {string} fewerLabel - The minus button's accessible name.
   * @param {string} moreLabel - The plus button's accessible name.
   * @param {() => number} get
   * @param {(v: number) => void} set
   * @param {number} min
   * @param {number} max
   * @param {number} step
   * @returns {HTMLElement} the value element (for later text updates)
   */
  const buildStepper = (unitLabel, fewerLabel, moreLabel, get, set, min, max, step) => {
    const wrap = document.createElement('div');
    wrap.className = 'schedule-stepper';
    const dec = document.createElement('button');
    dec.type = 'button';
    dec.className = 'schedule-stepper-btn';
    dec.textContent = '\u2212'; // minus
    dec.setAttribute('aria-label', fewerLabel);
    const val = document.createElement('span');
    val.className = 'schedule-stepper-value';
    const unit = document.createElement('span');
    unit.className = 'schedule-stepper-unit';
    unit.textContent = unitLabel;
    const inc = document.createElement('button');
    inc.type = 'button';
    inc.className = 'schedule-stepper-btn';
    inc.textContent = '+';
    inc.setAttribute('aria-label', moreLabel);
    dec.addEventListener('click', () => { set(Math.max(min, get() - step)); refresh(); });
    inc.addEventListener('click', () => { set(Math.min(max, get() + step)); refresh(); });
    wrap.append(dec, val, unit, inc);
    steppers.appendChild(wrap);
    return val;
  };

  const hoursValueEl = buildStepper(
    t('hr', undefined, { context: 'unit: hours' }), t('Fewer hr'), t('More hr'),
    () => hours, (v) => { hours = v; }, 0, SCHEDULE_MAX_HOURS, 1);
  const minutesValueEl = buildStepper(
    t('min', undefined, { context: 'unit: minutes' }), t('Fewer min'), t('More min'),
    () => minutes, (v) => { minutes = v; }, 0, 60 - SCHEDULE_MINUTE_STEP, SCHEDULE_MINUTE_STEP);

  // One full-width button that both previews and confirms the target time.
  const actions = document.createElement('div');
  actions.className = 'schedule-actions';
  const scheduleBtn = document.createElement('button');
  scheduleBtn.type = 'button';
  scheduleBtn.className = 'schedule-confirm-btn';
  actions.appendChild(scheduleBtn);
  menu.appendChild(actions);

  const refresh = () => {
    hoursValueEl.textContent = formatNumber(hours);
    minutesValueEl.textContent = formatNumber(minutes, { minimumIntegerDigits: 2 });
    const totalMin = hours * 60 + minutes;
    if (totalMin <= 0) {
      scheduleBtn.textContent = t('Pick a delay above');
      scheduleBtn.disabled = true;
    } else {
      scheduleBtn.disabled = false;
      scheduleBtn.textContent = t('Schedule to send at {time}', { time: formatClockTime(Date.now() + totalMin * 60000) });
    }
  };

  for (const presetMinutes of SCHEDULE_PRESET_MINUTES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'schedule-preset';
    chip.textContent = formatDelayShort(presetMinutes * 60000);
    chip.addEventListener('click', () => {
      hours = Math.min(SCHEDULE_MAX_HOURS, Math.floor(presetMinutes / 60));
      minutes = presetMinutes % 60;
      refresh();
    });
    presetRow.appendChild(chip);
  }

  scheduleBtn.addEventListener('click', () => {
    const totalMin = hours * 60 + minutes;
    if (totalMin <= 0) return;
    close();
    composer.sendMessage({ schedule: { notBefore: Date.now() + totalMin * 60000 } });
  });

  // The other wait: hold the message back until the running turn is done. Live
  // only while a turn IS running — with nothing in flight the wait is already
  // over, so arming it would just be a roundabout Send (and the worker fires a
  // run-end hold on an idle thread at once).
  const conversation = composer._messageThread ? composer._messageThread.conversation : null;
  const turnRunning = !!conversation && conversation.isTurnActive();
  const turnEndBtn = document.createElement('button');
  turnEndBtn.type = 'button';
  turnEndBtn.className = 'schedule-turn-end-btn';
  turnEndBtn.textContent = t('Run at end of turn');
  turnEndBtn.disabled = !turnRunning;
  turnEndBtn.title = turnRunning
    ? t('Wait for the current turn to finish, then send — the running turn is left alone')
    : t('Nothing is running');
  turnEndBtn.addEventListener('click', () => {
    close();
    composer.sendMessage({ schedule: { hold: 'run-end' } });
  });
  menu.appendChild(turnEndBtn);

  refresh();
  return menu;
}
