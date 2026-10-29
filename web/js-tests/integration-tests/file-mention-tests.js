//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: @ File Mention
 *
 * An `@`-mention turns each mentioned path into a FROZEN file-content context
 * item when the message is sent: the model is handed the file as it stood at
 * that send, and later edits to the file never change it. A deliberate pin (the
 * file picker) is the live case.
 * @module integration-tests/file-mention-tests
 */

import { textResponse, toolUseResponse, testDirFor } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const atMentionAddsFileContentItem = {
  name: 'at-mention-adds-file-content-item',
  description: 'Selecting a file via @ completion adds a file-content context item and strips @path from message',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('I can see the file content.')
  ],

  operations: [
    { type: 'at-mention-file', path: 'src/main.go' },
    { type: 'send-message', message: '@src/main.go explain this file' },
    { type: 'validate-context-snapshot', expectedContent: ['Hello, World!'] }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'file-content', itemId: '$ITEM_2' },
      { type: 'user', content: '@src/main.go explain this file' },
      { type: 'assistant', content: 'I can see the file content.' }
    ]
  },

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    );
    if (fileItems.length === 0) {
      throw new Error('Expected a file-content context item but none found');
    }
    const fileItem = /** @type {any} */ (fileItems[0]);
    if (fileItem.data.path !== 'src/main.go') {
      throw new Error(`Expected file path "src/main.go", got "${fileItem.data.path}"`);
    }
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const atMentionDeduplicates = {
  name: 'at-mention-deduplicates',
  description: 'Selecting the same file twice via @ results in only one file-content context item',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Got it.')
  ],

  operations: [
    { type: 'at-mention-file', path: 'src/main.go' },
    { type: 'at-mention-file', path: 'src/main.go' },
    { type: 'send-message', message: '@src/main.go @src/main.go look at this' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'file-content', itemId: '$ITEM_2' },
      { type: 'user', content: '@src/main.go @src/main.go look at this' },
      { type: 'assistant', content: 'Got it.' }
    ]
  },

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    );
    if (fileItems.length !== 1) {
      throw new Error(`Expected exactly 1 file-content item but found ${fileItems.length}`);
    }
  }
};

// Mentioning, in a later message, a file the conversation already holds —
// unchanged since — must not add a second identical item: the model already has
// exactly those bytes.
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
const atMentionOfFileAlreadyInContextReusesIt = {
  name: 'at-mention-of-file-already-in-context-reuses-it',
  description: 'Re-mentioning an unchanged file in a later message reuses the item already holding it',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Seen it.'),
    textResponse('Still seen it.')
  ],

  operations: [
    { type: 'send-message', message: '@src/main.go explain this file' },
    { type: 'send-message', message: 'and again, @src/main.go' }
  ],

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    );
    if (fileItems.length !== 1) {
      throw new Error(`Expected exactly 1 file-content item but found ${fileItems.length}`);
    }
  }
};

// The same, for a mention in a message queued behind a running turn: it rides
// the pending queue rather than landing in the items directly, and must still
// reuse the item the conversation already holds.
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
const queuedAtMentionOfFileAlreadyInContextReusesIt = {
  name: 'queued-at-mention-of-file-already-in-context-reuses-it',
  description: 'Re-mentioning an unchanged file in a message queued while busy reuses the item already holding it',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Seen it.'),
    textResponse('Working.', { pauseBeforeReturn: true }),
    textResponse('Still seen it.')
  ],

  operations: [
    { type: 'send-message', message: '@src/main.go explain this file' },
    { type: 'send-message-no-wait', message: 'keep going' },
    { type: 'wait-for-mock-paused' },
    { type: 'send-message-no-wait', message: 'and again, @src/main.go' },
    { type: 'release-mock' },
    { type: 'wait-for-idle' }
  ],

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    );
    if (fileItems.length !== 1) {
      throw new Error(`Expected exactly 1 file-content item but found ${fileItems.length}`);
    }
  }
};

// On send, every at-mention in the message text should be parsed and turned
// into a file-content context item. Covers multiple paths, a quoted path
// containing spaces, a backslash-escaped space, and trailing punctuation
// that should be stripped from the path.
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
const sendMessageCreatesFileItemsForAllMentions = {
  name: 'send-message-creates-file-items-for-all-mentions',
  description: 'Sending a message containing multiple @-mentions (quoted, escaped, and plain) creates a file-content item for each path',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Looked at all of those.')
  ],

  operations: [
    {
      type: 'send-message',
      message: 'Please review @src/main.go and @"docs/notes with spaces.md" plus @docs/notes\\ with\\ spaces.md and @README.md.'
    }
  ],

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    );
    const paths = /** @type {any[]} */ (fileItems).map(f => f.data.path).sort();

    // 'docs/notes with spaces.md' appears twice in the message (quoted and
    // backslash-escaped) — mergeOrReplace dedupes by path, so we expect three
    // unique items: src/main.go, docs/notes with spaces.md, README.md.
    const expected = ['README.md', 'docs/notes with spaces.md', 'src/main.go'];
    const actual = JSON.stringify(paths);
    const want = JSON.stringify(expected);
    if (actual !== want) {
      throw new Error(`Expected file-content paths ${want} but got ${actual}`);
    }

    for (const f of /** @type {any[]} */ (fileItems)) {
      if (f.data.frozen !== true) {
        throw new Error(`a mention must be frozen, but the item for "${f.data.path}" is a live pin`);
      }
    }
  }
};

// The case the freeze exists for: the user mentions a file so the agent can work
// on it, and the agent rewrites it within the same turn. The request after the
// rewrite must carry the mention exactly as it was sent — a live render would
// change a message near the head of the conversation and cold-start the whole
// cached prefix. The rewritten bytes are not lost to the model: they are in the
// history, in the write that produced them.
const TD_frozen = testDirFor('at-mention-is-frozen-at-send');
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
const atMentionIsFrozenAtSend = {
  name: 'at-mention-is-frozen-at-send',
  description: 'A file the agent rewrites after it was @-mentioned still reaches the model as it was when mentioned',
  fixture: 'unit-test-fixture',

  setupFiles: {
    [`${TD_frozen}/plan.md`]: 'AS-MENTIONED-MARKER\n'
  },

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_frozen}/plan.md`, content: 'REWRITTEN-MARKER\n' },
      'Rewriting it.'
    ),
    textResponse('Rewritten.')
  ],

  operations: [
    { type: 'send-message', message: `Rewrite @${TD_frozen}/plan.md please` },
    // The last transaction is the request made AFTER the write landed.
    { type: 'validate-context-snapshot', expectedContent: ['AS-MENTIONED-MARKER'] }
  ],

  fileAssertions: [
    { path: `${TD_frozen}/plan.md`, content: 'REWRITTEN-MARKER\n' }
  ]
};

// Mentioning the file again after it has changed is the user handing the model
// the file as it stands NOW. The existing snapshot is retaken in place: a second
// item beside it would carry the stale copy on every turn from then on.
const TD_remention = testDirFor('at-mention-of-changed-file-replaces-snapshot');
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
const atMentionOfChangedFileReplacesSnapshot = {
  name: 'at-mention-of-changed-file-replaces-snapshot',
  description: 'Re-mentioning a file that changed since its snapshot retakes that snapshot instead of adding a second',
  fixture: 'unit-test-fixture',

  setupFiles: {
    [`${TD_remention}/plan.md`]: 'AS-MENTIONED-MARKER\n'
  },

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_remention}/plan.md`, content: 'REWRITTEN-MARKER\n' },
      'Rewriting it.'
    ),
    textResponse('Rewritten.'),
    textResponse('Looked again.')
  ],

  operations: [
    { type: 'send-message', message: `Rewrite @${TD_remention}/plan.md please` },
    { type: 'send-message', message: `Now look at @${TD_remention}/plan.md again` }
  ],

  customAssertions(conversation) {
    const fileItems = /** @type {any[]} */ (conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    ));
    if (fileItems.length !== 1) {
      throw new Error(`Expected exactly 1 file-content item but found ${fileItems.length}`);
    }
    const content = String(fileItems[0].data.content ?? '');
    if (!content.includes('REWRITTEN-MARKER') || content.includes('AS-MENTIONED-MARKER')) {
      throw new Error(`Expected the snapshot to be retaken from the rewritten file, got: ${content.slice(0, 200)}`);
    }
  }
};

// Trailing sentence punctuation after an unquoted path should be stripped so
// the path resolves correctly. A bare "@" with no path after it should be
// ignored entirely (no spurious empty-path file-content item).
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
const sendMessageHandlesPunctuationAndBareAt = {
  name: 'send-message-handles-punctuation-and-bare-at',
  description: 'Trailing punctuation after @path is stripped; a bare @ with no following path is ignored',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Got it.')
  ],

  operations: [
    {
      type: 'send-message',
      message: 'See @src/main.go, then check @README.md! Also @ alone should not match.'
    }
  ],

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    );
    const paths = /** @type {any[]} */ (fileItems).map(f => f.data.path).sort();
    const expected = ['README.md', 'src/main.go'];
    if (JSON.stringify(paths) !== JSON.stringify(expected)) {
      throw new Error(`Expected paths ${JSON.stringify(expected)} but got ${JSON.stringify(paths)}`);
    }
  }
};

// A token that only looks like a path — a scoped npm package in a pasted plan —
// must not become a mention. Frozen at send, its item could only ever say "File
// does not exist", and the model spends its reasoning on that phantom file.
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
const sendMessageDropsMentionOfMissingPath = {
  name: 'send-message-drops-mention-of-missing-path',
  description: 'An @-token containing a slash that names no existing path makes no file-content item',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Got it.')
  ],

  operations: [
    {
      type: 'send-message',
      message: 'Install @acme/widgets and @types/node, then read @src/main.go'
    }
  ],

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    );
    const paths = /** @type {any[]} */ (fileItems).map(f => f.data.path);
    if (JSON.stringify(paths) !== JSON.stringify(['src/main.go'])) {
      throw new Error(`Expected only ["src/main.go"] but got ${JSON.stringify(paths)}`);
    }
  }
};

// Code is quoted text, not a request: an `@` inside a code span or a fenced
// block is never a mention, even when it names a file that exists.
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
const sendMessageSkipsMentionsInCode = {
  name: 'send-message-skips-mentions-in-code',
  description: '@-tokens inside inline code spans and fenced code blocks make no file-content item',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Got it.')
  ],

  operations: [
    {
      type: 'send-message',
      message: 'Read @README.md, then run `cat @src/main.go` and this:\n' +
        '```sh\n@src/main.go\n```\n' +
        '~~~\n  @docs/notes\\ with\\ spaces.md\n~~~\n' +
        'and ``a `tick` then @src/main.go`` too.'
    }
  ],

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content'
    );
    const paths = /** @type {any[]} */ (fileItems).map(f => f.data.path);
    if (JSON.stringify(paths) !== JSON.stringify(['README.md'])) {
      throw new Error(`Expected only ["README.md"] but got ${JSON.stringify(paths)}`);
    }
  }
};

// A deliberate pin (the file picker) must:
//   (a) reach the LLM with the file's current on-disk bytes (resolved live), and
//   (b) leave no copy of those bytes in the Yjs document (only the path).
// A pin is "kept current": it renders live each turn, and because it rides the
// cached leading prefix, an unchanged file caches (byte-identical render) while a
// real change busts it — exactly the pin contract. No bytes are ever persisted.
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
const pinResolvesLiveAndPersistsNoBytes = {
  name: 'pin-resolves-live-and-persists-no-bytes',
  description: 'A pinned file is resolved live at send time; only `path` (+isDirectory) is persisted in Yjs',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Read it.')
  ],

  operations: [
    // Pins README.md the way the file picker does.
    { type: 'add-context-item-to-root' },
    { type: 'send-message', message: 'look at the pinned file' },
    // Live read: the actual file bytes must appear in the outgoing context.
    { type: 'validate-context-snapshot', expectedContent: ['A simple test fixture used for integration tests.'] }
  ],

  customAssertions(conversation) {
    const fileItems = conversation.rootMessageThread.contextItems.filter(
      item => item.type === 'file-content' && /** @type {any} */ (item).data.path === 'README.md'
    );
    if (fileItems.length !== 1) {
      throw new Error(`Expected exactly 1 README.md pin, got ${fileItems.length}`);
    }
    const data = /** @type {any} */ (fileItems[0]).data;

    // Hard invariant: no bytes leak into Yjs — a pin persists only its path.
    const allowedKeys = new Set(['path', 'isDirectory']);
    const leaked = Object.keys(data).filter(k => !allowedKeys.has(k));
    if (leaked.length > 0) {
      throw new Error(
        `Pin must persist only {path, isDirectory} but Yjs data also carried: ${leaked.join(', ')}`
      );
    }
    if (JSON.stringify(data).includes('A simple test fixture')) {
      throw new Error('File content bytes leaked into the pin\'s Yjs data');
    }
  }
};

// A directory typed or pasted without its conventional trailing slash must still
// be fetched as a tree. The completion UI supplies a slash, but raw text (and
// absolute Finder paths) does not.
/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
const sendMessageTreatsDirectoryMentionWithoutTrailingSlashAsFolder = {
  name: 'send-message-treats-directory-mention-without-trailing-slash-as-folder',
  description: 'A directory @-mention without trailing slash reaches the LLM as a directory listing',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Read the folder.')
  ],

  operations: [
    {
      type: 'send-message',
      message: 'Review @mentioned-directory please.'
    },
    { type: 'validate-context-snapshot', expectedContent: ['child.txt'] }
  ]
};

// Export all tests
export const tests = [
  atMentionAddsFileContentItem,
  atMentionDeduplicates,
  atMentionOfFileAlreadyInContextReusesIt,
  queuedAtMentionOfFileAlreadyInContextReusesIt,
  sendMessageCreatesFileItemsForAllMentions,
  sendMessageHandlesPunctuationAndBareAt,
  sendMessageDropsMentionOfMissingPath,
  sendMessageSkipsMentionsInCode,
  atMentionIsFrozenAtSend,
  atMentionOfChangedFileReplacesSnapshot,
  pinResolvesLiveAndPersistsNoBytes,
  sendMessageTreatsDirectoryMentionWithoutTrailingSlashAsFolder
];
