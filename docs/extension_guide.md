# Writing Juggler Extensions

This is the authoring guide for **extensions** — the unit Juggler uses to add
capabilities. It covers the concepts, packaging, and workflow. For the actual
classes and methods you call, it points you at the SDK source: every base class
in `web/sdk/` carries a JSDoc header with a quickstart and a full method
reference, and that source is the canonical API documentation. This guide stays
high-level so it doesn't drift from the code.

> **Terminology.** The unit of packaging is an **extension**. The things an
> extension can contribute are **capabilities**. ("Plugin" is the old word for a
> capability — you'll still see it in some identifiers like the `@plugin-api`
> JSDoc marker and the `plugins.disabled` config key.)

## Capabilities

An extension bundles any mix of three capability types — each a class you
`export default`, extending an SDK base class and declaring a `static MANIFEST`:

| Capability | What it does | Base class (SDK module) | Built-in examples |
|------------|--------------|-------------------------|-------------------|
| **Context Item** | A tool the LLM can call (read a file, search, run a command) | `juggler/context-item` | `glob`, `read_file`, `write_file` |
| **Strategy** | Controls how the agentic loop runs — turns, tools, stopping | `juggler/strategy-type` | `default`, `read-only`, `yolo` |
| **Command** | A user-invoked slash command (`/clear`, `/compact`) | `juggler/command-type` | `clear`, `compact`, `thread` |

An extension may **also** contribute two non-class, single-module capabilities:
a **system-prompt contribution** (default export adds terse, durable guidance to
the system prompt — see [System-prompt contribution](#system-prompt-contribution))
and a **lifecycle module** (default export is a hooks object the host invokes on
conversation lifecycle events — see [Lifecycle module](#lifecycle-module)). An
extension that provides *only* one of these is valid.

Juggler ships its own built-ins as one core extension, `@juggler/core`
(`web/extensions/juggler-core/`), loaded through the **exact same path** as any
third-party extension. It is the best reference for well-formed capabilities.

> **Just want a `/name` shortcut for a prompt you reuse?** You don't need an
> extension. A [custom slash command](custom-commands.md) is a no-code markdown
> file — a prompt template plus a few options — editable from the UI. Reach for a
> Command capability (below) only when the command needs real code.

## Quick start

```bash
juggler ext init my-extension       # scaffold manifest + one sample of each capability + README
juggler ext validate ./my-extension # run the server's admission check locally
juggler ext link ./my-extension     # symlink into ~/.juggler/extensions (hot-reloads on save)
juggler ext add github.com/owner/repo  # git-clone a published extension into ~/.juggler/extensions
```

`ext validate` applies the **same** check the server runs at discovery —
required manifest fields, `engineApi` compatibility with this host, and that
every `provides` glob resolves to real files — so a packaging mistake fails fast
with a clear `✗` instead of a silently-missing extension. `ext link` symlinks
your dev directory into `~/.juggler/extensions/` (validating first); start or
reconnect to Juggler once and it loads. From then on, editing any capability
file or the manifest **hot-reloads** the extension in connected viewers — no
restart.

`ext add` is a plain `git clone` into `~/.juggler/extensions/<name>`; it prints
the extension's declared permissions and asks you to confirm before keeping it
(`-y` skips the prompt). There is no auto-update — **update an installed
extension with `git pull` in `~/.juggler/extensions/<name>`**, then reconnect (or
save a file to hot-reload).

## Anatomy of an extension

An extension is a directory with a `juggler.extension.json` manifest at its root
and capability files grouped by type:

```
my-extension/
  juggler.extension.json
  context-items/word-count-context-item.js
  strategies/cautious-strategy-type.js
  commands/hello-command-type.js
  README.md
```

A capability file's name **must** end with the suffix for its type — that is how
the manifest globs find it:

| Capability | Filename suffix |
|------------|-----------------|
| Context Item | `*-context-item.js` |
| Strategy | `*-strategy-type.js` |
| Command | `*-command-type.js` |

Files without a suffix (private helpers, base classes) are imported by capability
files but are not themselves registered — group them in subdirectories as the
core extension does (`context-items/edit/`, `context-items/execute/`).

### The manifest

```jsonc
// juggler.extension.json
{
  "id": "@you/my-extension",        // scoped id — no global collisions
  "name": "My Extension",
  "version": "1.0.0",
  "author": "you",                  // optional
  "homepage": "https://…",          // optional
  "engineApi": "^1.0.0",            // host SDK compat range, checked at load
  "permissions": ["filesystem.read"],
  "provides": {
    "contextItems": ["context-items/*-context-item.js"],
    "strategies":   ["strategies/*-strategy-type.js"],
    "commands":     ["commands/*-command-type.js"],
    "systemPrompt": "system-prompt-contribution.js",  // optional; single module path
    "lifecycle":    "lifecycle.js"                    // optional; single module path
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `id` | Yes | Scoped, e.g. `@you/name`. The unit of enable/disable. |
| `name`, `version` | Yes | Display name and semver. |
| `provides` | Yes | At least one capability. `contextItems`/`strategies`/`commands` are root-relative globs; `systemPrompt` and `lifecycle` are single module paths (see [System-prompt contribution](#system-prompt-contribution) and [Lifecycle module](#lifecycle-module)). None may escape the extension root. |
| `engineApi` | Recommended | Semver range (`^1.0.0`, `1.2.3`, or `*`). Omitting it disables the compat check and earns a validation warning. The host SDK version lives in `web/sdk/version.js`. |
| `permissions` | As needed | **Declares** the host access this extension's code uses. Surfaced to the user in the catalog and the install prompt — a disclosure, not a sandbox (see [Trust model](#trust-model)). Known values: `filesystem.read`, `filesystem.write`, `shell.exec`, `web.fetch`. |
| `author`, `homepage` | Optional | Metadata. |

A duplicate capability id across extensions is a surfaced load error, never a
silent last-write-wins: the lowest-precedence provider holds the id.

The manifest is the canonical definition of these fields:
`cmd/juggler/extmanifest/extmanifest.go`. Each capability *also* has its own
`static MANIFEST` (id, name, version, description, plus type-specific fields) —
that's defined in the SDK base class's JSDoc typedef.

### Where extensions live

| Location | Scope | Path |
|----------|-------|------|
| **Built-in** | Always | embedded `@juggler/core` |
| **Global** | All projects | `~/.juggler/extensions/` |

Precedence is global → built-in. Two extensions cannot provide the same
capability id: a duplicate is a surfaced load error, and the built-in (lowest
precedence) keeps the id.

## Trust model

Extensions are **unsandboxed JavaScript running with the full privileges of the
app** — exactly like plugins in an editor. An enabled extension's code can read
and write your files, run shell commands, and reach the network through
`juggler/ops` (and, being ES modules in the same realm, even around it). There is
no per-extension containment.

That means the `permissions` manifest field and the catalog's permission badges
are **disclosure, not enforcement**: they tell you what host access an
extension's code declares it uses, so you can make an informed decision. They do
not stop an extension from doing more. The real safeguards are the ones you
control at runtime — tool-approval dialogs and allowed-paths — plus the single
rule that matters most:

> **Install and enable only extensions you trust.** Treat an extension like any
> other code you're about to run — you install a global extension deliberately
> (`ext add` prints its declared permissions and asks you to confirm), so only
> add ones whose source you trust.

## The SDK

Extensions import **only** from the public `juggler/*` specifiers — the same
surface the core extension uses, which is how third-party parity is guaranteed.
The import map in `web/index.html` / `web/engine.html` is the full list; the ones
you'll reach for:

```javascript
import ContextItem from 'juggler/context-item';
import StrategyType, { APPROVAL_POLICY } from 'juggler/strategy-type';
import CommandType from 'juggler/command-type';
import { readFile, writeFile, glob, grep, shell, webFetch, bindWorkspace } from 'juggler/ops';
import { smartTruncate, createElement } from 'juggler/ui';
// (a lifecycle module annotates its default export with the type below)
/** @typedef {import('juggler/lifecycle').LifecycleModule} LifecycleModule */
```

- **`juggler/ops`** is the privileged host-operations layer — filesystem, shell,
  search, tree, and web operations that were once built-in-only. These ops run
  with the user's full authority; there is no per-extension sandbox. Declare the
  access your code uses in the manifest `permissions` list — that declaration is
  surfaced to the user (catalog + install prompt) as disclosure, **not** a gate
  (see [Trust model](#trust-model)). The actual gate is the user-approval layer
  (tool approval dialogs, allowed-paths), which applies to every op. The export
  names are a clean vocabulary (`readFile`, `writeFile`, `editFile`, `stat`,
  `mkdir`, `glob`, `getTree`, `grep`, `findSymbol`, `shell`, `shellBackground`,
  `webFetch`, `webSearch`, `openPath`, `revealPath`, plus
  `FileSystem`/`ReadOnlyFileSystem` and `OpsError`). It also exports
  `bindWorkspace`/`unbindWorkspace`, which redirect a conversation's execution
  root — the primitive a [lifecycle module](#lifecycle-module) uses for
  worktree-style workflows. See `web/sdk/ops.js`.
- **`juggler/lifecycle`** is the typedef contract for a [lifecycle
  module](#lifecycle-module) (`LifecycleModule` and its hook-context types). See
  `web/sdk/lifecycle.js`.
- **`juggler/ui`** holds render/format helpers (`smartTruncate`, `createElement`,
  `FormattingHelpers`, …). See `web/sdk/ui.js`.

An extension whose `engineApi` range excludes the current SDK version is refused
at load with a clear diagnostic instead of a mystery `import` failure
(`web/sdk/version.js`).

### What the version promise covers

The `engineApi` semver promise (`web/sdk/version.js`) covers a **specific
surface**, not everything you can reach:

- **Covered:** the named exports of each `juggler/*` module; the documented
  `static MANIFEST` fields and `provides` fields; and the MessageThread methods
  marked **`@plugin-api`** in `web/js/model/message-thread.js`.
- **Not covered:** anything reached through `this.session` / `this.conversation`,
  the raw Y.Map objects from `messageThread.items` / `CommandType.items`, and any
  member tagged `@internal` or `@deprecated`. These work today but can change at
  any release — don't build on them.

## Writing each capability

Each base class's JSDoc header is the real reference — read it first. Below is
the shape of each, with one runnable example. Study the matching built-ins under
`web/extensions/juggler-core/` as templates.

### Context Item — a tool for the LLM

Implement `static getToolDefinitions()` (the schemas the model sees), `execute()`
(do the work), and `getSummary()` (format the result). `execute()` returns **raw**
data; the framework wraps it as an outcome `{ success, result, prepared, error }`.
The single most common mistake is reading `outcome.foo` instead of
`outcome.result.foo` — that returns `undefined` and the model sees an empty
result.

```javascript
import ContextItem from 'juggler/context-item';

class WordCountContextItem extends ContextItem {
  static MANIFEST = {
    id: 'word-count',
    name: 'Word Count',
    version: '1.0.0',
    description: 'Count words in a text string'
  };

  static getToolDefinitions() {
    return [{
      name: 'word_count',
      category: 'read',
      description: 'Count words in a text string',
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to count' } },
        required: ['text']
      }
    }];
  }

  async execute(params) {
    return { count: params.text.split(/\s+/).filter(Boolean).length };
  }

  getSummary(outcome) {
    if (!outcome.success) return { summary: outcome.error, success: false };
    return { summary: `${outcome.result.count} words`, success: true };
  }
}

export default WordCountContextItem;
```

For destructive tools set `requiresApproval: true` and implement
`getApprovalConfig()`; for rich viewer rendering implement `getStatusUI()`. The
full method table, the engine-vs-viewer execution-context rules, and every typedef
live in **`web/sdk/context-item.js`**. Good templates: `glob-context-item.js`
(simple read), `read-file-context-item.js` (validation + status UI),
`write-file-context-item.js` (approval + diff), `search-context-item.js` (many
params, truncation).

### Strategy — control the agentic loop

**How strategies actually run:** in a normal install the **Go worker owns the
loop** (call → execute tools → repeat). A strategy does not drive that loop — it
*shapes* it through its `static MANIFEST` and a set of hooks the worker calls in
the engine. The built-in strategies (`read-only`, `default`, `yolo`) work purely
this way; `read-only-strategy-type.js` is the simplest and best starting point.

The production surface is:

- **MANIFEST fields**: `defaultRules`, `defaultAllowedPaths`, `toolExecution`,
  `showsApprovalControls`, `recommendations`, `color`, `icon`.
- **`filterTools(tools)`** — restrict the tools the model may call (per phase).
- **`getApprovalPolicy(info)`** — auto-approve or force-approve a tool call
  (with the exported `APPROVAL_POLICY` constants).
- **`onActivate(prevId)` / `onWorkerIdle()`** — inject guidance / drive
  follow-on work. Steer the model with **`injectGuidance()`** (a durable
  system-reminder), never by authoring system-prompt text.
- **`createThread()` / `continueConversation()`** — worker-request primitives
  for multi-phase strategies.

```javascript
import StrategyType, { APPROVAL_POLICY } from 'juggler/strategy-type';

// A "planning" strategy: expose only read/meta tools and auto-approve them, so
// the model investigates without touching files or stopping for prompts.
class PlanningStrategyType extends StrategyType {
  static MANIFEST = {
    id: 'planning',
    name: 'Planning',
    version: '1.0.0',
    description: 'Read-only investigation before any changes',
    author: 'You',
    showsApprovalControls: false
  };

  filterTools(tools) {
    return tools.filter(t => t.category === 'read' || t.category === 'meta');
  }

  getApprovalPolicy({ category }) {
    return (category === 'read' || category === 'meta')
      ? APPROVAL_POLICY.APPROVE
      : APPROVAL_POLICY.DEFAULT;
  }

  onActivate() {
    this.injectGuidance('PLANNING MODE: investigate and propose a plan; do not modify anything.');
  }
}

export default PlanningStrategyType;
```

A strategy never drives the loop itself: the Go worker owns it, and the strategy
shapes it through the manifest and hooks above.

The built-in strategies form a single autonomy axis — **Read-only** (cannot
write), **Default** (asks before writing), **YOLO** (never asks). The full hook
list and manifest fields are in **`web/sdk/strategy-type.js`**.

### Command — a slash command

The simplest type: no LLM, no approval. Implement `execute(args)` and return a
`CommandResult` (`{ handled, message?, error?, sideEffects? }`). Commands can't
perform host side-effects directly (opening a thread, etc.) — they **declare**
them on `sideEffects` and the host dispatches.

```javascript
import CommandType from 'juggler/command-type';

class HelloCommandType extends CommandType {
  static MANIFEST = {
    id: 'hello',
    name: 'Hello',
    version: '1.0.0',
    description: 'Say hello'
  };

  async execute(args) {
    return { handled: true, message: `Hello, ${args[0] || 'world'}!` };
  }
}

export default HelloCommandType;
```

Manifest extras (`alias`, `icon`, `danger`, `mutatesConversation`,
`coalesceUndo`) and the `CommandResult`/`CommandSideEffect` typedefs are in
**`web/sdk/command-type.js`**. Templates: `clear-command-type.js` (minimal),
`compact-command-type.js` (alias), `thread-command-type.js` (side effects).

If your command **writes to the conversation** (snapshots, moves, deletes, or
re-seeds items), set both **`mutatesConversation: true`** (so the host settles
any live turn before `execute()` runs, avoiding a race) and **`coalesceUndo:
true`** (so a multi-step mutation reverts as one undo). *When in doubt, set
both* — they are only unnecessary for pure read/side-effect commands (`/help`, a
command that only opens a panel), and setting them there is harmless.

### System-prompt contribution

Add durable guidance to the prompt. Not a class: a **single module** named by the manifest's `provides.systemPrompt`
(a plain path, not a glob). Its **default export** is
`({ enabledPluginIds }) => string` and must be a **pure function** of the
enabled-plugin set — it is folded into the *cached* system-prompt anchor, so it
runs once and its output must be stable across turns and strategy changes (do not
read the clock, conversation, or anything else). Gate each section on the plugins
that are on (`enabledPluginIds.includes('my-tool')`) so the prompt never
advertises a capability the user has disabled. Keep it terse: this text is a
permanent resident of every turn's context, billed at the cache-read rate. An
extension may provide *only* this (a prompt pack) with no other capabilities.

```javascript
// system-prompt-contribution.js
export default function systemPromptContribution({ enabledPluginIds }) {
  const has = (id) => enabledPluginIds.includes(id);
  const sections = [];
  if (has('my-tool')) {
    sections.push('## My Tool\nPrefer `my_tool` over shelling out for X; it returns structured Y.');
  }
  return sections.join('\n\n'); // may be empty
}
```

Reference: `web/extensions/juggler-core/system-prompt-contribution.js`; the
aggregation contract is in `web/sdk/lib/system-prompt-registry.js`.

### Lifecycle module

Run project-scoped setup/teardown on conversation lifecycle events. Not a class:
a **single module** named by the manifest's `provides.lifecycle` (a plain path,
not a glob). Its **default export** is a hooks object — the `LifecycleModule`
type in `juggler/lifecycle`. The host invokes each hook, in the engine, for every
conversation in the project, so opt-in is **per project** (enabling the
extension). It is orthogonal to strategies: a lifecycle module composes with any
autonomy level.

Its purpose is the class of "where does the work physically happen" workflows the
capability types can't express — most notably moving each of a project's git
repositories into a per-conversation **worktree**, by calling
`bindWorkspace(conversationId, sourceRoot, workspaceRoot)` from `juggler/ops`
(which redirects that conversation's file/shell/search/tree ops under
`workspaceRoot`, paths still validated in real-project space). The same shape
serves devcontainer / remote / sandbox workflows.

```javascript
// lifecycle.js
import { shell, bindWorkspace, unbindWorkspace } from 'juggler/ops';

/** @type {import('juggler/lifecycle').LifecycleModule} */
export default {
  async onConversationActivated({ conversationId, projectRoot }) {
    // prepare an alternate root (e.g. `git worktree add`) then bind it:
    // await bindWorkspace(conversationId, repoRoot, worktreePath);
  },
  async onConversationDeleted({ conversationId }) {
    await unbindWorkspace(conversationId);
  }
};
```

Hooks are optional; a throwing hook is logged and skipped (it never breaks
conversation handling). Reference: `web/sdk/lifecycle.js` (the typedef contract)
and `examples/extensions/juggler-worktrees/lifecycle.js` (a worked example).

## Talking to the conversation

Commands and strategies receive a **`MessageThread`** (`this.messageThread`). It
is the **only** interface you should use to read or mutate conversation state.
Its safe public methods are marked **`@plugin-api`** in the source —
`web/js/model/message-thread.js` is the reference; grep it for `@plugin-api`.

Common reads: `items`, `length`, `findByItemId(id)`, `contextItems`,
`modelConfig`, `permissions`. Common writes: `addEvent()`, `deleteItemById()`,
`addContextItem()`. For several mutations as one atomic Yjs
transaction use **`mutate(fn)`** (it also runs `assertInvariants()` in dev mode);
`buildThreadYMap()` is the safe way to seed a sub-thread with items.

> **Never touch raw Yjs objects from a capability** — `messageThread.yarray`,
> `.container.set(…)`, or importing `yjs.mjs`. The framework maintains invariants
> (every thread owns one SYSTEM_1, itemId uniqueness, the tool state machine)
> reactively in Yjs observers that only fire for mutations routed through the
> `@plugin-api` methods. Bypassing them breaks undo, redo, and peer sync. This is
> a hard rule, not a style preference.

## Pinned file content: live-at-send-time

Juggler ships two file-content context items with deliberately different
contracts — worth understanding if you build anything that pins or snapshots
files:

| Item | Role | Content read | Cached in Yjs? |
|------|------|--------------|----------------|
| `ReadFileContextItem` | Immutable record of a `read_file` tool call | Once, at call time | Yes (part of history) |
| `FileContentContextItem` | User-pinned ambient reference (`@file`, paperclip) | Every send, via `getContextText()` | No — only the `path` is stored |

A pin means "this file, kept current." Resolving at send time means there is **no
file watcher** (nothing is in flight between sends to invalidate, so mid-edit
saves never touch the Yjs doc, propagate to peers, or bust unrelated prompt
caches), **no on-disk content cache** (the `.yjs` stores only the path, so pinning
a 5 MB file doesn't bloat the document), and the properties panel always shows
live disk bytes (nothing to be stale against). Cross-turn history therefore shows
the file's *current* bytes; if you need bytes-as-of-an-earlier-turn, the
`read_file` tool call in that turn captured an immutable snapshot. Per-turn
snapshots, if ever needed, belong in the outgoing-prompt builder
(`cmd/juggler/providers/anthropic/conversation.go`), not the context item.

## Enabling and disabling

Settings (gear icon) → **Extensions** lists every installed extension, its
bundled capabilities, and any that failed to load. Toggle a whole extension or an
individual capability live. Toggles persist to your project config
(`<project>/.juggler/config.json`) as a flat list of disabled ids — an extension
id disables everything it bundles:

```json
{ "plugins": { "disabled": ["web-search", "@you/my-extension"] } }
```

## Reference map

- **API source of truth** — `web/sdk/`: `context-item.js`, `strategy-type.js`,
  `command-type.js`, `ops.js`, `ui.js`, `version.js`. Read the JSDoc headers.
- **Conversation API** — `web/js/model/message-thread.js` (grep `@plugin-api`).
- **Worked examples** — `web/extensions/juggler-core/` (the built-in extension).
- **Manifest format** — `cmd/juggler/extmanifest/extmanifest.go`.
- **CLI** — `juggler ext --help`.
