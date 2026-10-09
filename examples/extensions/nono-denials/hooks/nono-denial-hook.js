//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import HookType from 'juggler/hook-type';

/** What the model is told the first time a call in a thread looks sandboxed. */
const GUIDANCE = [
  'This looks like a sandbox denial: Juggler is running inside a nono sandbox,',
  'and the operating system refused that access. Before retrying or working',
  'around it, run `nono why` (see `nono why --help`) to find out which rule',
  'denied it. If the access is genuinely needed, tell the user what the profile',
  'is missing and offer to update it; do not try to get around the sandbox.'
].join(' ');

/**
 * Tells the model how to diagnose a nono sandbox denial, right after the call
 * that hit one — so it explains and offers a fix instead of retrying blind.
 *
 * Everything that decides WHEN it fires is declared in the manifest, not coded:
 * the runtime only calls `afterTool` for a result matching `match.result`, and
 * `repeat: 'once-per-thread'` keeps the guidance to one telling per thread
 * however many calls are denied. The method itself is just the answer.
 * @augments HookType
 */
class NonoDenialHook extends HookType {
  static MANIFEST = {
    id: 'nono-denial',
    name: 'nono denial diagnostics',
    version: '1.0.0',
    description: 'After a call the sandbox refused, tells the model to run `nono why` and offer a profile fix',
    author: 'Juggler Team',
    events: ['afterTool'],
    match: { result: 'Operation not permitted|EPERM|EACCES' },
    repeat: 'once-per-thread'
  };

  /**
   * @returns {import('juggler/hook-type').AfterToolOutcome} The note for the model
   */
  afterTool() {
    return { note: GUIDANCE };
  }
}

export default NonoDenialHook;
