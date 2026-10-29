//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Capability-manifest validation unit test.
 *
 * A plugin capability class declares itself with a `static MANIFEST`, and that
 * manifest is checked in two places: `BaseRegistry.validateClass` when the class
 * is loaded or registered, and the SDK base class's own constructor when an
 * instance is made. Both must apply the **same** rule and say the **same**
 * thing, because a plugin author reads whichever one fires — and which one that
 * is depends on how the class reached the app, not on what is wrong with it.
 *
 * The two most useful properties here are the ones that were previously untrue:
 *
 *   - **One rule.** A field present but empty (`id: ''`) is as unusable as an
 *     absent one — a capability with no id cannot be addressed. Both checks
 *     reject it.
 *   - **One message, naming the class.** The class name identifies the
 *     offending plugin; the registry name identifies only which of six loaders
 *     happened to be running.
 *
 * All five capability types validate: item, strategy, command, pinboard item
 * and info card. The info card requires `eyebrow` on top of the common four,
 * which is the case that proves the required-field set is per-type rather than
 * baked into the shared check.
 *
 * `ContextItem` carries one deliberate exemption, asserted here so that removing
 * it has to be a decision rather than an accident: an item class with **no**
 * manifest at all constructs silently, because abstract bases (`edit-base.js`,
 * `subagent-item.js`) are `ContextItem` subclasses that never declare one.
 * A manifest that *exists* and is incomplete is still rejected.
 * @module unit-tests/sdk-manifest-validation-test
 */

import { assert } from '../utilities/test-helpers.js';
import ContextItem from '../../sdk/context-item.js';
import StrategyType from '../../sdk/strategy-type.js';
import CommandType from '../../sdk/command-type.js';
import PinboardItemType from '../../sdk/pinboard-item-type.js';
import InfoCardType from '../../sdk/info-card-type.js';
import BaseRegistry from '../../js/registries/base-registry.js';

/** A manifest with every commonly-required field, used as the baseline to spoil. */
const GOOD = {
  id: 'probe',
  name: 'Probe',
  version: '1.0.0',
  description: 'A capability that exists only to be validated',
  eyebrow: 'Probe',
};

/**
 * Build the constructor argument each capability type needs. The context is
 * only as real as the constructor reads before it validates.
 * @param {string} kind - Capability kind key.
 * @returns {any[]} Constructor arguments.
 */
function argsFor(kind) {
  switch (kind) {
    case 'item':
      return [{ id: 'probe-1', session: {}, conversation: {}, messageThread: {} }];
    case 'strategy':
      return [{ messageThread: { conversation: { session: {} } } }];
    case 'command':
      return [{ messageThread: undefined }];
    default:
      return [];
  }
}

/**
 * The five capability types, each with the fields its own loader requires.
 * @type {Array<{kind: string, label: string, Base: any, required: string[]}>}
 */
const CAPABILITIES = [
  { kind: 'item', label: 'ContextItem', Base: ContextItem, required: ['id', 'name', 'version', 'description'] },
  { kind: 'strategy', label: 'StrategyType', Base: StrategyType, required: ['id', 'name', 'version', 'description'] },
  { kind: 'command', label: 'CommandType', Base: CommandType, required: ['id', 'name', 'version', 'description'] },
  { kind: 'pin', label: 'PinboardItemType', Base: PinboardItemType, required: ['id', 'name', 'version', 'description'] },
  { kind: 'card', label: 'InfoCardType', Base: InfoCardType, required: ['id', 'name', 'version', 'description', 'eyebrow'] },
];

/**
 * Make a named subclass of a capability base carrying the given manifest.
 * The name is what the error message must quote, so it is set explicitly
 * rather than inferred from a `class` expression.
 * @param {any} Base - Capability base class.
 * @param {object|undefined} manifest - Manifest to attach (omitted when undefined).
 * @returns {any} The subclass.
 */
function subclassWith(Base, manifest) {
  const Sub = class extends Base {};
  Object.defineProperty(Sub, 'name', { value: 'ProbeCapability' });
  if (manifest !== undefined) Sub.MANIFEST = manifest;
  return Sub;
}

/**
 * Construct and return the thrown error, or null when nothing threw.
 * @param {any} Ctor - Class to construct.
 * @param {any[]} args - Constructor arguments.
 * @returns {Error|null} The error thrown, if any.
 */
function constructError(Ctor, args) {
  try {
    void new Ctor(...args);
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** A concrete registry, since BaseRegistry itself is abstract. */
class ProbeRegistry extends BaseRegistry {
  /** @param {string[]} required - Required manifest fields. */
  constructor(required) {
    super('ProbeRegistry', required);
  }
}

/**
 * Run the capability-manifest validation tests.
 * @param {object} _ctx - Unused test context.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated result.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Case label.
   * @param {() => void} fn - Assertions.
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  for (const { kind, label, Base, required } of CAPABILITIES) {
    const args = argsFor(kind);

    run(`${label}: a complete manifest constructs`, () => {
      const err = constructError(subclassWith(Base, { ...GOOD }), args);
      assert(err === null, `a valid manifest must construct cleanly, but threw: ${err?.message}`);
    });

    for (const field of required) {
      run(`${label}: a manifest missing ${field} is rejected`, () => {
        const manifest = { ...GOOD };
        delete (/** @type {any} */ (manifest))[field];
        const err = constructError(subclassWith(Base, manifest), args);
        assert(err !== null, `${label} accepted a manifest with no ${field}`);
        assert(
          String(err?.message).includes(field),
          `the error must name the missing field ${field}; got: ${err?.message}`,
        );
        assert(
          String(err?.message).includes('ProbeCapability'),
          `the error must name the offending class, not the loader; got: ${err?.message}`,
        );
      });

      run(`${label}: an empty ${field} is rejected like an absent one`, () => {
        const err = constructError(subclassWith(Base, { ...GOOD, [field]: '' }), args);
        assert(
          err !== null && String(err.message).includes(field),
          `${label} accepted ${field}: '' — a present-but-empty field is as unusable as `
          + `an absent one, and the registry has always rejected it. Got: ${err?.message}`,
        );
      });
    }

    run(`${label}: the registry rejects the same class with the same words`, () => {
      const manifest = { ...GOOD };
      delete (/** @type {any} */ (manifest)).description;
      const Sub = subclassWith(Base, manifest);
      const fromConstructor = constructError(Sub, args);

      let fromRegistry = null;
      try {
        new ProbeRegistry(required).validateClass(Sub);
      } catch (e) {
        fromRegistry = e instanceof Error ? e : new Error(String(e));
      }

      assert(fromRegistry !== null, 'the registry must reject a manifest with no description');
      assert(
        fromRegistry?.message === fromConstructor?.message,
        'a plugin author reads whichever check fires first, so both must say the same thing. '
        + `Constructor: ${fromConstructor?.message} / registry: ${fromRegistry?.message}`,
      );
    });
  }

  run('InfoCardType: eyebrow is required beyond the common four', () => {
    const manifest = { ...GOOD };
    delete (/** @type {any} */ (manifest)).eyebrow;
    const err = constructError(subclassWith(InfoCardType, manifest), []);
    assert(
      err !== null && String(err.message).includes('eyebrow'),
      `an info card with no eyebrow renders a header with no label; got: ${err?.message}`,
    );

    const pinErr = constructError(subclassWith(PinboardItemType, manifest), []);
    assert(
      pinErr === null,
      `eyebrow belongs to the info card alone — a pin must not need one; got: ${pinErr?.message}`,
    );
  });

  run('the missing manifest is named as such, not as four missing fields', () => {
    for (const { kind, label, Base } of CAPABILITIES) {
      if (kind === 'item') continue; // documented exemption, asserted below
      const err = constructError(subclassWith(Base, undefined), argsFor(kind));
      assert(err !== null, `${label} accepted a subclass with no MANIFEST at all`);
      assert(
        String(err.message).includes('must define a static MANIFEST'),
        `${label} must say the manifest is absent rather than list its fields; got: ${err.message}`,
      );
    }
  });

  run('ContextItem keeps its manifest-less exemption for abstract bases', () => {
    const err = constructError(subclassWith(ContextItem, undefined), argsFor('item'));
    assert(
      err === null,
      'edit-base.js and subagent-item.js are ContextItem subclasses with no manifest of '
      + `their own; requiring one here breaks them. Got: ${err?.message}`,
    );
  });

  return { passed, failed, errors };
}
