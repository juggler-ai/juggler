//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Chime synth — generates the "needs your attention" notification tone with
 * Web Audio, no samples. Rather than a single struck note, the chime plays a
 * short **pattern**: one to four notes scheduled in sequence, each voiced by a
 * selectable **sound** (a set of partials + waveform + envelope) under an
 * exponential-decay envelope. Every note also blooms in from just above pitch —
 * a subtle downward micro-glide that gives the voice life instead of a dead
 * static tone.
 *
 * The public surface is three concrete choices the settings UI exposes directly:
 *  - `pattern` — the *tune*: an id into a curated {@link PATTERNS} table of ~30
 *    named musical motifs (lone notes at various pitches → 2/3/4-note figures),
 *    each carrying its own base pitch and timing. Shown as a popup menu.
 *  - `sound` — the *timbre*: an id into a {@link SOUNDS} table of distinct voices
 *    (bell, music box, marimba, glass, pluck, …). Shown as a popup menu.
 *  - `volume` — 0..1 output level. Shown as a rotary.
 *
 * All the DSP (frequencies, partial ratios, pattern tables, envelope timing)
 * lives here and is clamped into a tasteful band so no choice can make the chime
 * sound broken or alarming. Unknown ids fall back to the defaults.
 * @module utils/chime-synth
 */

/**
 * @typedef {object} ChimeParams
 * @property {string} pattern - Id into {@link PATTERNS} — the tune (pitch + timing baked in).
 * @property {string} sound   - Id into {@link SOUNDS} — the timbre voicing each note.
 * @property {number} volume  - 0..1, output level.
 */

/**
 * Pleasant, balanced default chime — a pentatonic three-note figure voiced as
 * the rounded retro blip at a comfortable volume.
 * @type {ChimeParams}
 */
export const CHIME_DEFAULTS = Object.freeze({
  pattern: 'pentatonic',
  sound: 'retro',
  volume: 0.6,
});

/**
 * Reference pitch: A4 = 440 Hz. A pattern's `root` is a semitone offset from
 * here, and each note's `s` is a further offset from that root — so every note
 * lands on an equal-tempered chromatic pitch (never between notes, which reads
 * as out-of-tune) inside a tasteful, non-piercing register (~220–1320 Hz).
 */
const A4_HZ = 440;

/**
 * @typedef {object} PatternNote
 * @property {number} s  - Semitone offset from the pattern's root.
 * @property {number} [a] - Accent (relative level, default 1).
 * @property {number} [g] - Glide-from offset in semitones: the note starts `g`
 *   above its target and slides down into it. Small values just add life; a
 *   larger value is an audible downward portamento finish.
 */
/**
 * @typedef {object} ChimePattern
 * @property {string} id      - Stable identifier stored in prefs.
 * @property {string} name    - Human-facing label shown in the popup menu.
 * @property {number} root    - Semitone offset of the pattern's base note from A4.
 * @property {number} spacing - Seconds between successive note onsets.
 * @property {number} decay   - Per-note exponential decay time, seconds.
 * @property {ReadonlyArray<PatternNote>} notes - The motif, in play order.
 */

/**
 * Curated pattern table — the "tune" popup. ~30 named motifs, grouped lone →
 * 2-note → 3-note → 4-note, each a self-contained musical figure with its own
 * pitch (`root`) and timing (`spacing`/`decay`). Names are deliberately playful.
 * Kept inside a tasteful register (roots + offsets ~ -12..+19 semitones from A4).
 * @type {ReadonlyArray<ChimePattern>}
 */
const PATTERNS = Object.freeze(/** @type {ReadonlyArray<ChimePattern>} */ ([
  // ── Lone notes, various pitches ──────────────────────────────────────
  { id: 'lone-bell',   name: 'Lone Bell',   root: 0,   spacing: 0.1,  decay: 0.5,  notes: [{ s: 0 }] },
  { id: 'droplet',     name: 'Droplet',     root: 5,   spacing: 0.1,  decay: 0.32, notes: [{ s: 0 }] },
  { id: 'halo',        name: 'Halo',        root: 9,   spacing: 0.1,  decay: 0.4,  notes: [{ s: 0 }] },
  { id: 'pip',         name: 'Pip',         root: 14,  spacing: 0.1,  decay: 0.16, notes: [{ s: 0 }] },
  { id: 'deep-ping',   name: 'Deep Ping',   root: -12, spacing: 0.1,  decay: 0.45, notes: [{ s: 0 }] },
  { id: 'needlepoint', name: 'Needlepoint', root: 19,  spacing: 0.1,  decay: 0.13, notes: [{ s: 0 }] },
  // ── Two notes ────────────────────────────────────────────────────────
  { id: 'ascend',      name: 'Ascend',      root: 0,   spacing: 0.11, decay: 0.3,  notes: [{ s: 0 }, { s: 7 }] },
  { id: 'descend',     name: 'Descend',     root: 7,   spacing: 0.11, decay: 0.3,  notes: [{ s: 0 }, { s: -7 }] },
  { id: 'leap',        name: 'Leap',        root: 0,   spacing: 0.12, decay: 0.32, notes: [{ s: 0 }, { s: 12 }] },
  { id: 'doorbell',    name: 'Doorbell',    root: 9,   spacing: 0.16, decay: 0.4,  notes: [{ s: 0 }, { s: -4 }] },
  { id: 'sigh',        name: 'Sigh',        root: 8,   spacing: 0.13, decay: 0.34, notes: [{ s: 0 }, { s: -3 }] },
  { id: 'nudge',       name: 'Nudge',       root: 0,   spacing: 0.09, decay: 0.2,  notes: [{ s: 0 }, { s: 2 }] },
  { id: 'knock-knock', name: 'Knock Knock', root: 4,   spacing: 0.1,  decay: 0.18, notes: [{ s: 0 }, { s: 0 }] },
  { id: 'sixth-sense', name: 'Sixth Sense', root: 0,   spacing: 0.12, decay: 0.34, notes: [{ s: 0 }, { s: 9 }] },
  // ── Three notes ──────────────────────────────────────────────────────
  { id: 'major-triad', name: 'Major Triad', root: 0,   spacing: 0.1,  decay: 0.3,  notes: [{ s: 0 }, { s: 4 }, { s: 7 }] },
  { id: 'minor-mood',  name: 'Minor Mood',  root: 0,   spacing: 0.1,  decay: 0.32, notes: [{ s: 0 }, { s: 3 }, { s: 7 }] },
  { id: 'ta-da',       name: 'Ta-Da',       root: 0,   spacing: 0.13, decay: 0.34, notes: [{ s: 0, a: 0.85 }, { s: 7 }, { s: 12 }] },
  { id: 'cascade',     name: 'Cascade',     root: 12,  spacing: 0.09, decay: 0.26, notes: [{ s: 0 }, { s: -5 }, { s: -8 }] },
  { id: 'little-turn', name: 'Little Turn', root: 5,   spacing: 0.09, decay: 0.24, notes: [{ s: 0 }, { s: 2 }, { s: 0 }] },
  { id: 'bounce',      name: 'Bounce',      root: 0,   spacing: 0.1,  decay: 0.26, notes: [{ s: 0 }, { s: 12 }, { s: 0, g: 5 }] },
  { id: 'question',    name: 'Question?',   root: 0,   spacing: 0.11, decay: 0.3,  notes: [{ s: 0 }, { s: 4 }, { s: 5 }] },
  { id: 'pentatonic',  name: 'Pentatonic',  root: 0,   spacing: 0.1,  decay: 0.3,  notes: [{ s: 0 }, { s: 2 }, { s: 7 }] },
  { id: 'suspended',   name: 'Suspended',   root: 0,   spacing: 0.11, decay: 0.32, notes: [{ s: 0 }, { s: 5 }, { s: 7 }] },
  // ── Four notes ───────────────────────────────────────────────────────
  { id: 'sparkle',     name: 'Sparkle',     root: 0,   spacing: 0.09, decay: 0.26, notes: [{ s: 0 }, { s: 4 }, { s: 7 }, { s: 12 }] },
  { id: 'skip',        name: 'Skip',        root: 0,   spacing: 0.09, decay: 0.26, notes: [{ s: 0 }, { s: 2 }, { s: 4 }, { s: 7 }] },
  { id: 'music-box',   name: 'Music Box',   root: 12,  spacing: 0.1,  decay: 0.28, notes: [{ s: 0 }, { s: -5 }, { s: -8 }, { s: -12 }] },
  { id: 'fountain',    name: 'Fountain',    root: 0,   spacing: 0.08, decay: 0.24, notes: [{ s: 0 }, { s: 7 }, { s: 12 }, { s: 16 }] },
  { id: 'wander',      name: 'Wander',      root: 0,   spacing: 0.1,  decay: 0.28, notes: [{ s: 0 }, { s: 5 }, { s: 3 }, { s: 7 }] },
  { id: 'pixie-dust',  name: 'Pixie Dust',  root: 7,   spacing: 0.08, decay: 0.22, notes: [{ s: 0 }, { s: 5 }, { s: 7 }, { s: 12 }] },
  { id: 'staircase',   name: 'Staircase',   root: -5,  spacing: 0.1,  decay: 0.3,  notes: [{ s: 0 }, { s: 4 }, { s: 7 }, { s: 11 }] },
]));

/**
 * @typedef {object} ChimeSound
 * @property {string} id       - Stable identifier stored in prefs.
 * @property {string} name     - Human-facing label shown in the popup menu.
 * @property {OscillatorType} wave - Oscillator waveform voicing every partial.
 * @property {ReadonlyArray<readonly [number, number]>} partials - `[ratio, level]`
 *   pairs relative to the note's fundamental. The set of ratios (harmonic vs
 *   inharmonic) is most of what gives a voice its character.
 * @property {number} [attack]     - Strike time, seconds (default 0.005).
 * @property {number} [decayScale] - Multiplier on the pattern's decay (default 1).
 * @property {number} [gain]       - Loudness trim so voices sit at a similar level (default 1).
 * @property {number} [lowpassRatio] - If set, a lowpass at `fundamental × ratio`
 *   (clamped) tames a bright waveform (square/sawtooth) into something round.
 */

/**
 * Curated sound table — the "timbre" popup. Each voice differs audibly in
 * waveform, partial structure, envelope and/or filtering, so every entry is
 * worth its place. `gain` trims are hand-tuned so switching voices doesn't jump
 * in loudness; bright waveforms (square/sawtooth) are rounded by a lowpass.
 * @type {ReadonlyArray<ChimeSound>}
 */
const SOUNDS = Object.freeze(/** @type {ReadonlyArray<ChimeSound>} */ ([
  // Metallic struck bell — inharmonic partials, the original voice.
  { id: 'bell',      name: 'Bell',       wave: 'sine',     partials: [[1, 1], [2.76, 0.18], [5.4, 0.08]], gain: 1 },
  // Bright, glassy, quick to fade — a wind-up music box.
  { id: 'music-box', name: 'Music Box',  wave: 'sine',     partials: [[1, 1], [3, 0.3], [6, 0.14]], attack: 0.004, decayScale: 0.7, gain: 0.85 },
  // Woody mallet — the strong 4th-harmonic bar of a marimba, plucky and dry.
  { id: 'marimba',   name: 'Marimba',    wave: 'triangle', partials: [[1, 1], [4, 0.25], [10, 0.05]], attack: 0.004, decayScale: 0.8, gain: 0.9 },
  // Icy, shimmering, slightly inharmonic — struck glass with a long tail.
  { id: 'glass',     name: 'Glass',      wave: 'sine',     partials: [[1, 1], [2.4, 0.2], [3.8, 0.14], [7.2, 0.06]], decayScale: 1.2, gain: 0.85 },
  // Plucked string — a filtered sawtooth with a short, snappy decay.
  { id: 'pluck',     name: 'Pluck',      wave: 'sawtooth', partials: [[1, 1]], attack: 0.004, decayScale: 0.55, gain: 0.5, lowpassRatio: 6 },
  // Clean, soft sine — the gentlest, least attention-grabbing voice.
  { id: 'pure',      name: 'Pure Tone',  wave: 'sine',     partials: [[1, 1]], decayScale: 1.1, gain: 1.1 },
  // Stacked harmonics with a slow swell — a small reed organ.
  { id: 'organ',     name: 'Organ',      wave: 'sine',     partials: [[1, 1], [2, 0.5], [3, 0.3], [4, 0.15]], attack: 0.02, decayScale: 1.3, gain: 0.5 },
  // Chiptune blip — a rounded square wave, short and retro.
  { id: 'retro',     name: 'Retro',      wave: 'square',   partials: [[1, 1]], attack: 0.004, decayScale: 0.6, gain: 0.42, lowpassRatio: 8 },
  // Crystalline — pure fundamental plus high harmonics, bright and delicate.
  { id: 'crystal',   name: 'Crystal',    wave: 'sine',     partials: [[1, 0.9], [4, 0.4], [9, 0.15]], decayScale: 0.9, gain: 0.8 },
]));

/** @type {ReadonlyMap<string, ChimePattern>} */
const PATTERN_BY_ID = new Map(PATTERNS.map((p) => [p.id, p]));
/** @type {ReadonlyMap<string, ChimeSound>} */
const SOUND_BY_ID = new Map(SOUNDS.map((s) => [s.id, s]));

/**
 * Resolve a pattern id to its definition, falling back to the default pattern
 * for an unknown/stale id (so a removed pattern never breaks playback).
 * @param {string} id
 * @returns {ChimePattern} The named pattern, or the default.
 */
function getPattern(id) {
  return PATTERN_BY_ID.get(id) || /** @type {ChimePattern} */ (PATTERN_BY_ID.get(CHIME_DEFAULTS.pattern));
}

/**
 * Resolve a sound id to its definition, falling back to the default voice for an
 * unknown/stale id.
 * @param {string} id
 * @returns {ChimeSound} The named sound, or the default.
 */
function getSound(id) {
  return SOUND_BY_ID.get(id) || /** @type {ChimeSound} */ (SOUND_BY_ID.get(CHIME_DEFAULTS.sound));
}

/**
 * The pattern menu: `{ id, name }` for every pattern, in table order. The
 * settings popup is built from this — the DSP stays private to this module.
 * @returns {Array<{id: string, name: string}>} Pattern options for the UI.
 */
export function chimePatterns() {
  return PATTERNS.map((p) => ({ id: p.id, name: p.name }));
}

/**
 * The sound menu: `{ id, name }` for every voice, in table order.
 * @returns {Array<{id: string, name: string}>} Sound options for the UI.
 */
export function chimeSounds() {
  return SOUNDS.map((s) => ({ id: s.id, name: s.name }));
}

/** Default per-note bloom: start this many semitones sharp and settle to pitch. */
const BLOOM_SEMITONES = 0.32;

/**
 * Linear-interpolate `v` (clamped to 0..1) into the [lo, hi] band.
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number} The interpolated value within [lo, hi].
 */
function lerp(v, lo, hi) {
  return lo + Math.max(0, Math.min(1, v)) * (hi - lo);
}

/**
 * Semitone offset → frequency multiplier (equal temperament).
 * @param {number} semitones
 * @returns {number} The frequency ratio 2^(semitones/12).
 */
function semis(semitones) {
  return Math.pow(2, semitones / 12);
}

/**
 * @typedef {object} ChimeNote
 * @property {number} freq      - Target frequency of the note's fundamental, Hz.
 * @property {number} fromFreq  - Frequency the note glides in from, Hz.
 * @property {number} at        - Onset time relative to the start of the chime, s.
 * @property {number} glide     - Time to settle from `fromFreq` to `freq`, s.
 * @property {number} decay     - Exponential decay time, s.
 * @property {number} level     - Per-note level (accent), 0..1.
 */

/**
 * Translate the chosen params into a concrete, schedulable plan: the resolved
 * pattern as a list of notes, the resolved voice, the master gain, and the total
 * duration. Unknown pattern/sound ids fall back to the defaults. Pure (no
 * AudioContext) so it can be unit-tested.
 * @param {ChimeParams} p
 * @returns {{notes: ChimeNote[], gain: number, duration: number, sound: ChimeSound}} The schedulable chime plan.
 */
export function mapChimeParams(p) {
  const pattern = getPattern(p.pattern);
  const sound = getSound(p.sound);

  // The pattern owns pitch (root, chromatic) and timing (spacing/decay); the
  // voice can stretch the decay (`decayScale`). Output level keeps headroom so
  // stacked partials never clip, trimmed per-voice so switching sounds doesn't
  // jump in loudness.
  const f0 = A4_HZ * semis(pattern.root);
  const spacing = pattern.spacing;
  const decay = pattern.decay * (sound.decayScale ?? 1);
  const gain = lerp(p.volume, 0, 0.45) * (sound.gain ?? 1);

  const bloomGlide = Math.min(0.045, spacing * 0.5);

  const notes = pattern.notes.map((n, i) => {
    const freq = f0 * semis(n.s);
    const g = n.g ?? BLOOM_SEMITONES;
    return {
      freq,
      fromFreq: freq * semis(g),
      at: i * spacing,
      // A large, deliberate glide (e.g. `bounce`'s drop finish) settles over the
      // note's own decay; the subtle bloom settles almost instantly.
      glide: n.g ? Math.min(decay, 0.18) : bloomGlide,
      decay,
      level: n.a ?? 1,
    };
  });

  const last = notes[notes.length - 1];
  const duration = last ? last.at + 0.005 + last.decay : 0;
  return { notes, gain, duration, sound };
}

/** @type {AudioContext|null} Lazily created; shared for the document's life. */
let ctx = null;

/**
 * True when WE deliberately suspended the shared context because the app went
 * idle (no chime playing), so the *automatic* wake paths must NOT resume it —
 * only a real chime ({@link playChime}) or an explicit gesture
 * ({@link unlockAudio}) should revive it. Distinct from an OS-driven park
 * (autoplay `suspended`, or `interrupted`), which those wake paths still
 * recover. Only ever set where {@link keepAudioContextWarm} is false.
 * @type {boolean}
 */
let idleSuspended = false;

/**
 * Monotonic id bumped per scheduled chime. A chime's deferred idle-suspend only
 * fires if it is still the most recent chime when its tail rings out, so a burst
 * of overlapping chimes parks the context once, after the last one finishes.
 * @type {number}
 */
let chimeGeneration = 0;

/**
 * Whether to keep the shared AudioContext running for the document's life rather
 * than parking it when idle. True on Apple platforms (macOS/iOS): the app's
 * whole always-alive + media-element-sink design exists to survive a macOS
 * WKWebView sleep/wake wedge that silences audio process-wide (see
 * {@link mediaEl}), and suspending across that transition is exactly what must
 * be avoided there. Elsewhere (Linux WebKitGTK, Windows WebView2) that wedge
 * does not exist, so the context is parked when idle to stop its always-on audio
 * render thread — which otherwise spins for the whole life of the process in
 * every window even when no chime ever plays.
 *
 * Pure: platform/ua are injected (defaulting to navigator) so it is unit-testable.
 * @param {string} [platform] - navigator.platform equivalent.
 * @param {string} [ua] - navigator.userAgent equivalent.
 * @returns {boolean} True to keep the context warm (never idle-suspend).
 */
export function keepAudioContextWarm(
  platform = typeof navigator !== 'undefined' ? navigator.platform || '' : '',
  ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '',
) {
  return /Mac|iPhone|iPad|iPod/i.test(`${platform} ${ua}`);
}

/**
 * Whether an automatic/passive wake (the `onstatechange` handler, or a focus/
 * visibility {@link rearmAudio}) should resume the context. A `running` context
 * needs nothing. A context WE parked for idleness (`idleParked` && `suspended`)
 * is left alone — reviving it on focus would defeat idle-suspend and re-spin the
 * audio render thread; only a real chime or a gesture revives it. Any other
 * parked state (an autoplay `suspended` we did not set, `interrupted`, `closed`)
 * is an OS/policy park that should be resumed exactly as before.
 *
 * Pure, so the guard is unit-testable without a real AudioContext.
 * @param {string} state - The context's current state.
 * @param {boolean} idleParked - Whether we suspended it for idleness.
 * @returns {boolean} True to attempt resume().
 */
export function shouldAutoResume(state, idleParked) {
  if (state === 'running') return false;
  if (idleParked && state === 'suspended') return false;
  return true;
}

/**
 * Persistent output element and the MediaStream sink feeding it. The chime is
 * routed through an HTMLMediaElement (see {@link audioSink}) rather than straight
 * to `AudioContext.destination`, because a macOS sleep/wake wedges the WKWebView's
 * Web-Audio output path **process-wide**: the shared context keeps reporting
 * `state === 'running'` with an advancing clock, yet every note is silent — a
 * fault invisible to JS (no bad state, no error), so it can't be detected or
 * recovered at the AudioContext layer. The media-element output path survives the
 * same wedge, so routing through it is the fix rather than a recovery. Created
 * lazily and started inside the {@link unlockAudio} gesture, then reused for the
 * document's life; the sink is rebound whenever the context is rebuilt.
 * @type {HTMLAudioElement|null}
 */
let mediaEl = null;
/** @type {MediaStreamAudioDestinationNode|null} Sink feeding {@link mediaEl}, rebound per context. */
let streamDest = null;

/**
 * Report an untoward audio event to the APPLICATION log — not the browser
 * console. Every failure in this module is best-effort and swallowed by design
 * (a parked context simply doesn't sound), which otherwise leaves a silent chime
 * — or a silent settings Preview — with no clue why. The desktop app's WebView
 * console is invisible in a shipped build, so a fault a real user hits would
 * leave no trace to send us; this POSTs it to the shared frontend→app-log bridge
 * ({@link module:cmd/juggler/server/client_report} / `POST /api/client/report`)
 * tagged source="chime", at Info (`level` "info") or Error ("error").
 *
 * Fire-and-forget and fully swallowed — reporting a fault must never throw back
 * into the audio path. Reserved for genuinely untoward events (a wedged/rebuilt
 * context, a resume that never recovers, a fresh context that comes up
 * `interrupted`, no Web Audio at all); routine state transitions are deliberately
 * NOT reported, so the app log — like the console — stays quiet unless something
 * actually went wrong.
 * @param {'info'|'error'} level
 * @param {string} message
 * @returns {void}
 */
function areport(level, message) {
  try {
    if (typeof fetch !== 'function') return;
    fetch('/api/client/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'chime', event: level, message }),
    }).catch(() => { /* reporting a fault must never surface as an error itself */ });
  } catch { /* fetch unavailable (tests/workers) — never throw into the audio path */ }
}

/**
 * Resume a parked context. The shared AudioContext is created once and kept for
 * the document's life, so any state other than `running` means *every* later
 * chime is scheduled against a clock that isn't advancing — i.e. silence — until
 * the app restarts. Two states park it:
 *  - `suspended`: the autoplay-policy start state, lifted by a user gesture.
 *  - `interrupted`: a non-standard WebKit state (the desktop app runs in a
 *    WKWebView). The OS audio session gets interrupted by an output-device
 *    change (headphones in/out, AirPods), system sleep/wake, or another app
 *    grabbing audio. It does **not** recover on its own.
 * Resuming on anything that isn't `running` (rather than only `suspended`) clears
 * the common cases; a stubborn `interrupted` session that resume() can't revive is
 * handled by {@link unlockAudio}, which rebuilds the context from inside a user
 * gesture (see {@link isContextWedged}). `resume()` on a `closed` context rejects
 * harmlessly — the rejection handler reports it to the app log and never rethrows.
 * @param {AudioContext} ac
 * @returns {void}
 */
export function wakeContext(ac) {
  if (!shouldAutoResume(ac.state, idleSuspended)) return;
  const from = ac.state;
  ac.resume().then(
    () => { /* resumed to `running` — the routine case, not reported */ },
    // Stays parked until the next attempt/gesture. A rejection handler (not a
    // bare .catch) so a stuck `interrupted`/`closed` session lands in the app log,
    // while still never surfacing as an unhandled rejection.
    () => areport('error', `resume() from ${from} rejected — still ${ac.state}`),
  );
}

/**
 * Is this context stuck in a state machine resume() can't clear — so a caller
 * inside a user gesture should discard it and build a fresh one rather than
 * resume it? Two states qualify:
 *  - `closed`: terminal; resume() rejects forever, so the context must be replaced.
 *  - `interrupted`: a non-standard WebKit state resume() *sometimes* can't clear;
 *    a fresh context comes up `suspended` and resumes cleanly, so replacing it is
 *    a reliable state-machine reset. NOTE: rebuilding resets the context's *state*
 *    only — it does NOT re-bind audio output to the current device. A sleep/wake
 *    can wedge the WKWebView's output path process-wide while the context still
 *    reports `running`; a fresh context inherits the same dead route (confirmed:
 *    a brand-new context was `running`, clock advancing, yet silent). That failure
 *    is handled by routing the chime through a media element instead (see
 *    {@link mediaEl}/{@link audioSink}), not here. `interrupted` has never been
 *    observed in this app's field logs, but the branch is kept as cheap insurance
 *    (and {@link audioContext}'s telemetry is the canary if it ever occurs).
 * Pure (needs no AudioContext) so the decision is unit-testable.
 * @param {{state: string} | null | undefined} ac
 * @returns {boolean} True when the context should be rebuilt, not resumed.
 */
export function isContextWedged(ac) {
  return !ac || ac.state === 'closed' || ac.state === 'interrupted';
}

/**
 * Tear down the shared context so the next {@link audioContext} builds a fresh
 * one. The escape hatch for a context stuck past resume() (see
 * {@link isContextWedged}); the old context is closed best-effort and its handles
 * dropped. This resets the context's state machine — it does NOT re-bind audio
 * output to the current device (a fresh context inherits the same output route).
 * @returns {void}
 * @private
 */
function recreateContext() {
  const dead = ctx;
  ctx = null;
  // Drop the media sink so the next audioSink() rebinds the element to the fresh
  // context; the element itself persists (and keeps its play() permission).
  streamDest = null;
  if (dead) {
    dead.onstatechange = null; // don't let the pending close() re-enter wakeContext
    if (dead.state !== 'closed') {
      try {
        dead.close().catch(() => { /* already closing/closed */ });
      } catch { /* close() didn't return a promise, or context already gone */ }
    }
  }
}

/**
 * Park the shared context after its motif has finished and the app is idle,
 * stopping the audio render thread that otherwise spins for the whole life of
 * the process. Guarded so it only ever parks the *current* running context; the
 * resulting `suspended` state is flagged {@link idleSuspended} so the automatic
 * wake paths ({@link wakeContext}/{@link rearmAudio}) leave it parked until a
 * real chime or gesture revives it. Never called where {@link keepAudioContextWarm}
 * is true (Apple platforms). Best-effort: a failed suspend() clears the flag so
 * nothing is left wedged.
 * @param {AudioContext} ac - The context whose motif just finished.
 * @returns {void}
 * @private
 */
function suspendForIdle(ac) {
  if (ctx !== ac || ac.state !== 'running' || typeof ac.suspend !== 'function') return;
  idleSuspended = true;
  try {
    const p = ac.suspend();
    if (p && typeof p.catch === 'function') {
      p.catch(() => { idleSuspended = false; });
    }
  } catch {
    idleSuspended = false; // suspend() unsupported/threw — treat as never parked
  }
}

/**
 * Resolve (lazily creating) the shared AudioContext. Returns null if Web Audio
 * is unavailable. Browsers start the context `suspended` until a user gesture;
 * callers that run inside a gesture should also call {@link unlockAudio}.
 * @returns {AudioContext|null} The shared context, or null when Web Audio is unavailable.
 * @private
 */
function audioContext() {
  // A closed context can never resume — discard it so we build a fresh one below.
  if (ctx && ctx.state === 'closed') recreateContext();
  if (ctx) return ctx;
  const Ctor = /** @type {any} */ (window).AudioContext || /** @type {any} */ (window).webkitAudioContext;
  if (!Ctor) return null;
  let ac;
  try {
    ac = new Ctor();
  } catch {
    return null;
  }
  // Proactively heal a parked context the moment it parks: an output-device swap
  // or sleep/wake can flip the session to `suspended`/`interrupted` mid-run, and
  // resuming on that transition keeps the next chime ready without waiting for a
  // click. (A gesture still rebuilds when resume() can't clear it — see
  // unlockAudio.) Best-effort, not load-bearing: playChime's play-time recovery
  // (recoverThenSchedule) covers the same ground if onstatechange is unsupported
  // or never fires.
  // A fresh context normally comes up `suspended`; coming up `interrupted` would
  // mean the OS audio session is wedged below the web layer where no JS resume can
  // reach. This has never been seen in the field, and it is NOT the known
  // total-silence failure — that one comes up `running` with an advancing clock,
  // invisible here, and is handled by the media-element sink (see audioSink). We
  // still surface `interrupted` as the canary in case such a state ever occurs.
  if (ac.state === 'interrupted') {
    areport('error', 'fresh AudioContext came up interrupted — OS audio session wedged below the web layer');
  }
  try {
    ac.onstatechange = () => {
      // Report only the OS parking the session live; routine suspend/resume churn
      // isn't worth an app-log line.
      if (ac.state === 'interrupted') areport('info', 'audio session parked (onstatechange → interrupted)');
      wakeContext(ac);
    };
  } catch { /* onstatechange unsettable — play-time recoverThenSchedule still covers it */ }
  ctx = ac;
  return ac;
}

/**
 * Resume the AudioContext from within a user gesture (a click/keypress). Autoplay
 * policy keeps a context `suspended` until this runs at least once; wiring it to
 * the settings "preview" button and the mute toggle is enough to unlock playback
 * for the rest of the session. Safe to call repeatedly.
 * @returns {void}
 */
export function unlockAudio() {
  // An explicit gesture means the user wants audio ready: cancel any deliberate
  // idle-suspend so the resume/prime below is allowed to wake the context.
  idleSuspended = false;
  let ac = audioContext();
  if (!ac) { areport('error', 'unlockAudio: Web Audio unavailable'); return; }
  // Inside a user gesture we can afford the heavy hammer. If the context is stuck
  // past what resume() can fix — a `closed` context, or a stale `interrupted`
  // session — discard it and build a fresh one so this gesture (the settings
  // Preview button or the header bell) reliably clears the stuck state. NOTE: this
  // resets the context's state only; it does NOT restore a wedged *output* route
  // (that's handled by the media-element sink — see audioSink). It's the
  // state-machine reset playChime's play-time resume() path can't perform alone.
  if (isContextWedged(ac)) {
    areport('info', `unlockAudio: context wedged (${ac.state}) — rebuilding to reset stuck state`);
    recreateContext();
    ac = audioContext();
    if (!ac) { areport('error', 'unlockAudio: rebuild failed — Web Audio unavailable'); return; }
  }
  // Start the media-element sink within this gesture so automatic chimes can feed
  // the already-playing element without a gesture of their own (see audioSink).
  primeSink(ac);
  wakeContext(ac);
}

/**
 * Best-effort re-arm of an already-unlocked context, for a *passive* wake signal
 * (window focus / tab becoming visible) rather than a click. Only touches an
 * existing context — it never *creates* one: with no prior unlock gesture there's
 * nothing warmed to lose, and a fresh context would just sit `suspended` until a
 * real gesture anyway.
 *
 * This closes a gap the {@link audioContext} `onstatechange` handler can't cover:
 * when the OS parks the session while the app is backgrounded, the resume() fired
 * on that transition is rejected (a hidden tab isn't allowed to start audio), and
 * `onstatechange` won't fire again because the state doesn't change. Retrying on
 * the focus/visibility edge — the first moment a resume() is actually permitted —
 * revives the context so the next chime plays warm, with no user click.
 * @returns {void}
 */
export function rearmAudio() {
  if (ctx) wakeContext(ctx);
}

/** Retry budget + spacing for driving a parked context to `running` at play time. */
const RECOVER_RETRIES = 3;
const RECOVER_RETRY_MS = 250;

/**
 * Drive a parked context to `running`, then schedule the chime on it — or give up.
 *
 * The automatic alert path fires with no user gesture, so at trigger time the
 * shared context may be `suspended` (autoplay start), `interrupted` (the WKWebView
 * session wedge), or `closed`. Scheduling notes straight away would pin them to a
 * clock that isn't advancing — they'd be dropped, or fire in a clump when it wakes
 * — so we resume FIRST and only schedule once the state is actually `running`:
 *  - `suspended`/`interrupted` that resume() can clear → resumes, then schedules.
 *  - `interrupted`/`closed` that resume() can't → rebuilds the context ONCE (as
 *    {@link unlockAudio} does inside a gesture) and drives the fresh one.
 *  - transient failures → retries a bounded number of times, spaced by `defer`.
 *  - exhausted → logs the terminal state. This is the residual an OS-level session
 *    wedge leaves: nothing in JS can start audio the OS is actively blocking, so
 *    we surface it rather than swallow it.
 *
 * The context factory (`rebuild`), the scheduler (`schedule`), and the retry timer
 * (`defer`) are injected so this control flow is unit-testable without a real
 * AudioContext. Every resume() has a rejection handler, so retries never surface
 * as unhandled rejections.
 * @param {AudioContext} ac - The context to drive.
 * @param {(ac: AudioContext) => void} schedule - Builds+starts the voice graph on a running context.
 * @param {() => AudioContext|null} rebuild - Discards the wedged context and returns a fresh one (or null).
 * @param {{retries?: number, defer?: (fn: () => void) => void}} [opts]
 * @returns {void}
 */
export function recoverThenSchedule(ac, schedule, rebuild, { retries = RECOVER_RETRIES, defer = (fn) => setTimeout(fn, RECOVER_RETRY_MS) } = {}) {
  /**
   * @param {AudioContext} context - Context for this attempt (the original, or a rebuilt one).
   * @param {number} triesLeft - Remaining resume retries.
   * @param {boolean} rebuilt - Whether the one-shot rebuild has already been spent.
   */
  const attempt = (context, triesLeft, rebuilt) => {
    if (context.state === 'running') { schedule(context); return; }
    // Stuck past what resume() can fix (`closed`, or a resume-proof `interrupted`):
    // rebuild once to reset the state machine, then drive the fresh context (which
    // starts `suspended` → resume). This does not re-route wedged output (the
    // media-element sink handles that — see audioSink); it only clears a bad state.
    if (!rebuilt && isContextWedged(context)) {
      areport('info', `playChime: context wedged (${context.state}) — rebuilding`);
      const fresh = rebuild();
      if (!fresh) { areport('error', 'playChime: rebuild failed — Web Audio unavailable'); return; }
      attempt(fresh, triesLeft, true);
      return;
    }
    context.resume().then(
      () => {
        if (context.state === 'running') schedule(context);
        else if (triesLeft > 0) defer(() => attempt(context, triesLeft - 1, rebuilt));
        else areport('error', `playChime: gave up after ${retries} tries — state=${context.state}`);
      },
      () => {
        if (triesLeft > 0) defer(() => attempt(context, triesLeft - 1, rebuilt));
        else areport('error', `playChime: resume() rejected, gave up after ${retries} tries — state=${context.state}`);
      },
    );
  };
  attempt(ac, retries, false);
}

/**
 * Play one chime with the given abstract parameters. No-op (resolves silently)
 * when Web Audio is unavailable. If the shared context is already `running` the
 * voice graph is scheduled immediately (the healthy path — no added latency);
 * otherwise the context is recovered first and the chime scheduled once it's live
 * (see {@link recoverThenSchedule}), so a chime firing against a parked or wedged
 * session still sounds instead of being lost against a frozen clock. Each call
 * builds a fresh, self-disposing voice graph — there is no persistent state to leak.
 * @param {Partial<ChimeParams>} [params] - Overrides merged over CHIME_DEFAULTS.
 * @returns {void}
 */
export function playChime(params = {}) {
  // A real chime revives the context: clear any deliberate idle-suspend so the
  // recover/resume path below may wake it (and the onstatechange handler won't
  // immediately re-park it via the shouldAutoResume guard).
  idleSuspended = false;
  const ac = audioContext();
  if (!ac) { areport('error', 'playChime: Web Audio unavailable — chime dropped'); return; }
  const plan = mapChimeParams({ ...CHIME_DEFAULTS, ...params });
  if (ac.state === 'running') { scheduleChime(ac, plan); return; }
  recoverThenSchedule(
    ac,
    (context) => scheduleChime(context, plan),
    () => { recreateContext(); return audioContext(); },
  );
}

/**
 * Resolve the node the chime's master gain connects to. Prefers an
 * HTMLMediaElement sink — a {@link MediaStreamAudioDestinationNode} whose stream
 * drives a persistent `<audio>` element — over the context's own `destination`,
 * because the media-element output path survives the process-wide sleep/wake wedge
 * that silences `AudioContext.destination` (see {@link mediaEl}). The stream is a
 * live `srcObject` (no `data:`/`blob:` URL), so it needs no `media-src` in the CSP.
 *
 * The sink is (re)built whenever it isn't bound to the current context — first use,
 * or after a rebuild via {@link recreateContext}. Falls back to `ac.destination`
 * where no media-element path exists (e.g. `Audio` or `createMediaStreamDestination`
 * unavailable), so playback still routes somewhere rather than throwing.
 * @param {AudioContext} ac - The running context the chime is scheduled on.
 * @returns {AudioNode} The node to connect the chime's master gain to.
 * @private
 */
function audioSink(ac) {
  const AudioEl = /** @type {any} */ (window).Audio;
  if (typeof AudioEl !== 'function' || typeof ac.createMediaStreamDestination !== 'function') {
    return ac.destination; // no media-element path — best-effort direct output
  }
  if (!streamDest || streamDest.context !== ac) {
    streamDest = ac.createMediaStreamDestination();
    const el = mediaEl ?? (mediaEl = new AudioEl());
    el.autoplay = true;
    el.srcObject = streamDest.stream;
    // Best-effort here; the unlockAudio gesture is what reliably grants playback.
    el.play().catch(() => { /* re-primed on the next unlockAudio gesture */ });
  }
  return streamDest;
}

/**
 * Build and start the output element from inside a user gesture, so later
 * *automatic* chimes (which fire with no gesture of their own) can feed the
 * already-playing element. Called by {@link unlockAudio}; a no-op where no
 * media-element path exists.
 * @param {AudioContext} ac - The context to bind the sink to.
 * @returns {void}
 * @private
 */
function primeSink(ac) {
  audioSink(ac); // (re)build + bind the element to this context
  if (mediaEl) mediaEl.play().catch(() => { /* retried on the next gesture */ });
}

/**
 * Build and start the self-disposing voice graph for one chime on a *running*
 * context. The motif is scheduled relative to `ac.currentTime` read here, so this
 * must run only once the context is live — otherwise the notes pin to a clock that
 * isn't advancing (the whole reason {@link recoverThenSchedule} gates on `running`).
 * @param {AudioContext} ac - A running context.
 * @param {{notes: ChimeNote[], gain: number, duration: number, sound: ChimeSound}} plan - The mapped chime plan.
 * @returns {void}
 * @private
 */
function scheduleChime(ac, { notes, gain, duration, sound }) {
  // Claim this chime's generation so the deferred idle-suspend below only fires
  // if no newer chime has started by the time this one's tail rings out.
  const gen = ++chimeGeneration;
  const start = ac.currentTime;
  const attack = sound.attack ?? 0.005; // near-instant strike by default
  const wave = sound.wave ?? 'sine';
  const partials = sound.partials;

  // Shared master so `volume` scales the whole motif and the stacked notes share
  // one route to the speakers — via the media-element sink, which survives the
  // sleep/wake wedge that silences ac.destination (see audioSink).
  const master = ac.createGain();
  master.gain.value = gain;
  master.connect(audioSink(ac));

  /**
   * Schedule one note: its strike envelope plus the partials voicing it, each
   * gliding in from `fromFreq` to `freq`. When the voice specifies a
   * `lowpassRatio`, the summed partials pass through a per-note lowpass tuned to
   * the note's pitch, rounding off a bright waveform.
   * @param {ChimeNote} note
   */
  const playNote = (note) => {
    const t0 = start + note.at;
    const end = t0 + attack + note.decay;

    // Exponential-decay envelope. exponentialRamp can't reach 0, so we strike to
    // a small floor and ramp to a near-silent target, then hard-stop.
    const env = ac.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(note.level, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, end);

    // Optional per-note lowpass (env → filter → master); otherwise env → master.
    /** @type {BiquadFilterNode|null} */
    let lp = null;
    if (sound.lowpassRatio) {
      lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.max(600, Math.min(14000, note.freq * sound.lowpassRatio));
      env.connect(lp);
      lp.connect(master);
    } else {
      env.connect(master);
    }

    for (const [ratio, level] of partials) {
      const osc = ac.createOscillator();
      osc.type = wave;
      osc.frequency.setValueAtTime(note.fromFreq * ratio, t0);
      osc.frequency.exponentialRampToValueAtTime(note.freq * ratio, t0 + note.glide);
      const g = ac.createGain();
      g.gain.value = level;
      osc.connect(g);
      g.connect(env);
      osc.start(t0);
      osc.stop(end + 0.05);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
      };
    }

    // Drop the note's envelope (and filter) once its tail has rung out.
    setTimeout(() => {
      try {
        env.disconnect();
        if (lp) lp.disconnect();
      } catch { /* already gone */ }
    }, (note.at + attack + note.decay + 0.1) * 1000 + 50);
  };

  notes.forEach(playNote);

  // Tear the shared master down once the whole motif has finished, then — off
  // Apple platforms, and only if no newer chime has started — park the context
  // so its audio render thread stops until the next chime instead of spinning
  // for the whole idle life of the app.
  setTimeout(() => {
    try {
      master.disconnect();
    } catch { /* already gone */ }
    if (gen === chimeGeneration && !keepAudioContextWarm()) suspendForIdle(ac);
  }, (duration + 0.1) * 1000 + 50);
}
