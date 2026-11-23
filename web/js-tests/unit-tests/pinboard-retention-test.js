//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Pins that survive a tab switch.
 *
 * Every pin used to be torn down the moment the user looked at another tab and
 * built again on the way back, which is right for a pin that re-reads a file —
 * it cannot then show anything stale — and fatal for one hosting something that
 * cannot be rebuilt: a live connection, an audio session, an `<iframe>` whose
 * page would reload and start over. A type may now ask for `retain` in its
 * manifest and be hidden instead.
 *
 * What is asserted here is the difference between the two, and the boundary
 * around the exemption: retention spares a pin the tab switch and nothing else.
 * A config change, leaving the board, the board losing its conversation, the
 * element leaving the document, throwing — each of those still ends it, and each
 * is a way a retained pin could otherwise be leaked, still running, with nothing
 * on screen to reach it by. The identity assertion is the load-bearing one:
 * these tests check the *same* DOM node comes back, not an equal-looking one,
 * because an `<iframe>` that was rebuilt looks identical and has lost everything.
 *
 * Driven through probe item types registered only here, as
 * `unit:pinboard-shell` does: a pin shipped in product code purely to be
 * measured would be a promise the app cannot keep.
 * @module unit-tests/pinboard-retention-test
 */

import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import wsService from '../../js/services/websocket.js';
import PinboardItemType from 'juggler/pinboard-item-type';
import '../../js/components/pinboard-content.js';

/** The project this fixture pretends to be in. */
const PROJECT = '/tmp/pinboard-retention';

/**
 * Tallies per pin id, so lifecycle is asserted rather than inferred.
 * @type {Map<string, {mounts: number, teardowns: number, hides: number, shows: number, updates: number}>}
 */
const calls = new Map();

/**
 * The tally for one pin, created on first use.
 * @param {string} id - The pin id.
 * @returns {{mounts: number, teardowns: number, hides: number, shows: number, updates: number}} Its tally.
 */
function tally(id) {
  let entry = calls.get(id);
  if (!entry) {
    entry = { mounts: 0, teardowns: 0, hides: 0, shows: 0, updates: 0 };
    calls.set(id, entry);
  }
  return entry;
}

/** The element each pin id was last mounted into, to test node identity. */
const bodies = new Map();

/** The signal each pin id was last mounted with, to test when it aborts. */
const signals = new Map();

/**
 * The context each pin id was last mounted with, kept so a case can subscribe
 * through it long after the mount call returned — which is what an item type
 * doing its setup in a promise continuation does.
 */
const contexts = new Map();

/**
 * A pin that counts its own lifecycle and stamps a unique mark on its body, so
 * "the same element came back" can be told from "an identical one was built".
 * @param {boolean} retain - Whether its manifest asks to be retained.
 * @param {string} id - The item-type id.
 * @returns {any} The item-type class.
 */
function probeType(retain, id) {
  return class ProbePin extends PinboardItemType {
    static MANIFEST = {
      id,
      name: `Probe ${id}`,
      version: '1.0.0',
      description: 'A pin that exists only in this test',
      instances: 'multiple',
      ...(retain ? { retain: true } : {}),
    };

    /**
     * @param {HTMLElement} container - The body region to fill.
     * @param {any} pinContext - The pin, the active snapshot and the host services.
     * @returns {any} The controller.
     */
    mount(container, pinContext) {
      const pinId = pinContext.pin.id;
      tally(pinId).mounts++;
      // A mark that cannot survive a rebuild: it is written once, here, and a
      // fresh element would carry a different one.
      container.dataset.mark = `${pinId}#${tally(pinId).mounts}`;
      container.textContent = `probe ${pinId}`;
      bodies.set(pinId, container);
      signals.set(pinId, pinContext.signal);
      contexts.set(pinId, pinContext);
      // Looked up by id on every call rather than captured once: a retained
      // controller outlives the case that built it, and a case that resets the
      // tallies would otherwise go on counting into an object nobody reads.
      return {
        update: () => { tally(pinId).updates++; },
        teardown: () => { tally(pinId).teardowns++; },
        hide: () => { tally(pinId).hides++; },
        show: () => { tally(pinId).shows++; },
      };
    }
  };
}

/** A retained pin that throws on mount, to prove a failure is not retained. */
class ThrowingRetainedPin extends PinboardItemType {
  static MANIFEST = {
    id: 'retain-thrower',
    name: 'Throwing retained probe',
    version: '1.0.0',
    description: 'A pin that exists only in this test',
    instances: 'multiple',
    retain: true,
  };

  /** @returns {any} Never returns. */
  mount() {
    throw new Error('probe refused to mount');
  }
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  // A lane reuses one JS realm across suites, so start from a known registry and
  // hand back one with no probe types in it.
  pinboardItemRegistry.reset();

  /** The active-context snapshot the panel hands the content band. */
  const active = {
    project: { path: PROJECT, displayName: 'pinboard-retention' },
    conversation: { id: 'conv_retention', title: 'Retention' },
    thread: { id: null },
  };

  /** @type {any} */
  let content = null;

  const keptPin = { id: 'pin_kept', type: 'retain-probe', config: { n: 1 } };
  const plainPin = { id: 'pin_plain', type: 'plain-probe', config: {} };

  try {
    for (const Type of [probeType(true, 'retain-probe'), probeType(false, 'plain-probe'), ThrowingRetainedPin]) {
      const reg = pinboardItemRegistry.registerClass(/** @type {any} */ (Type), { modulePath: '(test)' });
      assert(reg.registered, `registerClass refused a probe: ${reg.reason}`);
    }

    content = /** @type {any} */ (document.createElement('pinboard-content'));
    container.appendChild(content);

    await run('a type that does not ask to be retained is still rebuilt on a tab switch', () => {
      content.setPin(plainPin, active);
      content.setPin(keptPin, active);
      content.setPin(plainPin, active);
      const counts = tally('pin_plain');
      assert(counts.mounts === 2, `expected the plain pin mounted twice, got ${counts.mounts}`);
      assert(counts.teardowns === 1, `expected the plain pin torn down once, got ${counts.teardowns}`);
      assert(counts.hides === 0, 'a pin that is not retained is torn down, never hidden');
    });

    await run('a retained pin is hidden, not torn down', () => {
      calls.clear();
      content.setPin(keptPin, active);
      const mark = bodies.get('pin_kept').dataset.mark;
      const element = bodies.get('pin_kept');
      content.setPin(plainPin, active);

      const counts = tally('pin_kept');
      assert(counts.teardowns === 0, `a retained pin must not be torn down on a tab switch; got ${counts.teardowns}`);
      assert(counts.hides === 1, `expected exactly one hide, got ${counts.hides}`);
      assert(element.hidden === true, 'a retained pin off screen must be hidden');
      assert(element.isConnected, 'a retained pin must stay in the document — reparenting an iframe reloads it');
      assert(!signals.get('pin_kept').aborted,
        'a retained pin keeps its signal, or its subscriptions die with the tab switch');
      assert(element.dataset.mark === mark, 'the element must not have been rebuilt behind our back');
    });

    await run('coming back reveals the very same element rather than an equal one', () => {
      const before = bodies.get('pin_kept');
      const mark = before.dataset.mark;
      const mounts = tally('pin_kept').mounts;
      const shows = tally('pin_kept').shows;

      content.setPin(keptPin, active);

      const counts = tally('pin_kept');
      assert(counts.mounts === mounts, `a retained pin must not be mounted again; got ${counts.mounts} vs ${mounts}`);
      assert(counts.shows === shows + 1, `expected exactly one more show, got ${counts.shows - shows}`);
      assert(bodies.get('pin_kept') === before, 'the identical node must come back, not a copy of it');
      assert(before.dataset.mark === mark, `the mark must survive; got ${before.dataset.mark}`);
      assert(before.hidden === false, 'the revealed pin must not still be hidden');
    });

    await run('every pin is told when it goes out of sight and comes back, for whichever reason', () => {
      // A lane's window reports itself hidden and its pins sit off the screen,
      // so both of those are scripted: the board, the tab and the window are
      // each a reason of their own, and the pin is in sight only when none holds.
      const hiddenOwn = Object.getOwnPropertyDescriptor(document, 'hidden');
      let windowHidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => windowHidden });
      const RealObserver = window.IntersectionObserver;
      /** @type {((entries: any[]) => void)[]} */
      const observers = [];
      window.IntersectionObserver = /** @type {any} */ (class {
        /** @param {(entries: any[]) => void} callback - Told of each crossing. */
        constructor(callback) { observers.push(callback); }
        observe() {}
        disconnect() {}
      });
      const seenPin = { id: 'pin_seen', type: 'retain-probe', config: { n: 7 } };
      const plainSeen = { id: 'pin_plain_seen', type: 'plain-probe', config: {} };
      try {
        content.setVisible(true);
        content.setPin(seenPin, active);
        const sight = contexts.get('pin_seen').visibility;
        /** @type {boolean[]} */
        const heard = [];
        sight.onChange((/** @type {boolean} */ visible) => { heard.push(visible); });
        assert(sight.isVisible() === true, 'a pin on an open board, in a shown window, is in sight');

        content.setVisible(false);
        assert(sight.isVisible() === false && heard.join() === 'false', `the board put away hides it: ${heard}`);
        windowHidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        content.setVisible(true);
        assert(sight.isVisible() === false && heard.join() === 'false',
          `still out of sight while the window is hidden, and not told twice: ${heard}`);
        windowHidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        assert(sight.isVisible() === true && heard.join() === 'false,true', `back once the last reason ends: ${heard}`);

        content.setPin(plainSeen, active);
        assert(sight.isVisible() === false && heard.join() === 'false,true,false', `another tab hides a retained pin: ${heard}`);
        const plainSight = contexts.get('pin_plain_seen').visibility;
        assert(plainSight.isVisible() === true, 'and the pin on screen is in sight');
        observers.at(-1)?.([{ isIntersecting: false }]);
        assert(plainSight.isVisible() === false, 'a pin scrolled out of view is out of sight');
        observers.at(-1)?.([{ isIntersecting: true }]);
        assert(plainSight.isVisible() === true, 'and back when it scrolls in');

        content.setPin(seenPin, active);
        assert(sight.isVisible() === true && heard.join() === 'false,true,false,true', `its tab coming back shows it: ${heard}`);
        assert(plainSight.isVisible() === false, 'a pin that was torn down is out of sight for good');
      } finally {
        window.IntersectionObserver = RealObserver;
        if (hiddenOwn) Object.defineProperty(document, 'hidden', hiddenOwn);
        else delete (/** @type {any} */ (document)).hidden;
        content.setVisible(true);
      }
    });

    await run('a retained pin hears an active-context change while it is hidden', () => {
      const updates = tally('pin_kept').updates;
      content.setPin(plainPin, active);
      content.setActiveContext({ ...active, thread: { id: 'thread_x' } });
      assert(tally('pin_kept').updates > updates,
        'a retained pin still running against the active context must be told when it changes');
    });

    await run('a hidden pin subscribing late is subscribed as itself, not as whoever is on screen', () => {
      // An item type may finish its setup in a promise continuation, so the call
      // to a host service can land at any time — including while the pin is
      // hidden and a different pin is the one on screen. What decides whose
      // subscription it is must be the pin that asked, never the pin in view.
      content.setPin(keptPin, active);
      const keptContext = contexts.get('pin_kept');
      content.setPin(plainPin, active);

      let heard = 0;
      keptContext.services.files.onChange(() => { heard++; });
      wsService._emit('file-change', [{ path: 'a.go', event: 'write' }]);
      assert(heard === 1, `a hidden pin must hear a change it subscribed to; got ${heard}`);

      // Ending the pin that happened to be on screen when the subscription was
      // made must not end the subscription.
      content.setPin(keptPin, active);
      wsService._emit('file-change', [{ path: 'b.go', event: 'write' }]);
      assert(heard === 2, `the subscription must outlive the pin that was on screen; got ${heard}`);

      // Ending the pin that made it must.
      content.setPin(plainPin, active);
      content.syncPins([plainPin]);
      wsService._emit('file-change', [{ path: 'c.go', event: 'write' }]);
      assert(heard === 2, `a dropped pin must stop hearing anything; got ${heard}`);
    });

    await run('a retained pin that wrote its own config in place is revealed, whatever order the store spells it in', () => {
      content.setPin(keptPin, active);
      const before = bodies.get('pin_kept');
      const mounts = tally('pin_kept').mounts;
      // The pin records where the reader has got to; the server echoes the
      // same config back with its keys in an order of its own.
      content._noteInPlaceWrite('pin_kept', { place: 'history', n: 1 });
      content.setPin(plainPin, active);
      content.setPin({ ...keptPin, config: { n: 1, place: 'history' } }, active);

      assert(tally('pin_kept').mounts === mounts,
        `its own write coming home must not rebuild it; mounted ${tally('pin_kept').mounts - mounts} more time(s)`);
      assert(bodies.get('pin_kept') === before, 'the identical node must come back');
    });

    await run('a config change rebuilds the pin rather than revealing the old one', () => {
      content.setPin(keptPin, active);
      const before = bodies.get('pin_kept');
      const mounts = tally('pin_kept').mounts;

      content.setPin(plainPin, active);
      content.setPin({ ...keptPin, config: { n: 2 } }, active);

      const counts = tally('pin_kept');
      assert(counts.mounts === mounts + 1, `a changed config must mount afresh; got ${counts.mounts}`);
      assert(counts.teardowns >= 1, 'the pin it replaced must have been torn down, not dropped on the floor');
      assert(bodies.get('pin_kept') !== before, 'a different config is a different thing in the same tab');
      assert(!before.isConnected, 'the replaced element must leave the document');
      assert(signals.get('pin_kept') !== null && before !== bodies.get('pin_kept'),
        'the replaced mount must have been ended');
    });

    await run('leaving the board ends a retained pin rather than leaking it', () => {
      content.setPin({ ...keptPin, config: { n: 2 } }, active);
      const element = bodies.get('pin_kept');
      const signal = signals.get('pin_kept');
      const teardowns = tally('pin_kept').teardowns;

      // The board is shared, so a pin can be removed by a viewer that is not
      // this one; syncPins is how this one is told.
      content.setPin(plainPin, active);
      content.syncPins([plainPin]);

      assert(tally('pin_kept').teardowns === teardowns + 1,
        'a pin off the board must be torn down, not left hidden and running');
      assert(!element.isConnected, 'its element must leave the document');
      assert(signal.aborted, 'its signal must abort, so its subscriptions stop');
    });

    await run('a retained pin that throws on mount is not retained', () => {
      const thrower = { id: 'pin_thrower', type: 'retain-thrower', config: {} };
      content.setPin(thrower, active);
      content.setPin(plainPin, active);
      content.setPin(thrower, active);
      // Nothing to assert about the probe itself — it never got to run. The
      // claim is that the board is still standing and still switching pins,
      // rather than holding a broken mount it thinks is fine.
      content.setPin(plainPin, active);
      assert(tally('pin_plain').mounts >= 2, 'the board must go on working after a pin refuses to mount');
    });

    await run('the element coming back shows the pin it was showing', () => {
      content.setPin(plainPin, active);
      const { mounts, teardowns } = tally('pin_plain');

      content.remove();
      assert(tally('pin_plain').teardowns === teardowns + 1, 'leaving the document must end the pin');
      container.appendChild(content);

      assert(tally('pin_plain').mounts === mounts + 1,
        'a board put back in the document must mount the pin it was showing, not stand empty');
      assert(bodies.get('pin_plain').isConnected, 'the remounted pin must be in the document');
    });

    await run('the element leaving the document ends every retained pin', () => {
      content.setPin(keptPin, active);
      const element = bodies.get('pin_kept');
      const signal = signals.get('pin_kept');

      content.remove();

      assert(!element.isConnected, 'nothing may still be running against a board nobody can reach');
      assert(signal.aborted, 'its signal must abort when the board leaves the document');
      content = null;
    });
  } finally {
    content?.remove();
    container.remove();
    pinboardItemRegistry.reset();
    calls.clear();
    bodies.clear();
    signals.clear();
    contexts.clear();
  }

  return { passed, failed, errors };
}
