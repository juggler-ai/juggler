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

An extension bundles any mix of eight capability types — each a class you
`export default`, extending an SDK base class and declaring a `static MANIFEST`:

| Capability | What it does | Base class (SDK module) | Built-in examples |
|------------|--------------|-------------------------|-------------------|
| **Context Item** | A tool the LLM can call (read a file, search, run a command) | `juggler/context-item` | `glob`, `read_file`, `write_file` |
| **Strategy** | Controls how the agentic loop runs — turns, tools, stopping | `juggler/strategy-type` | `default`, `read-only`, `yolo` |
| **Command** | A user-invoked slash command (`/clear`, `/compact`) | `juggler/command-type` | `clear`, `compact`, `thread` |
| **Info Card** | An ambient tile in the sidebar's spare space | `juggler/info-card-type` | `usage`, `git-status` |
| **Pinboard Item** | A tab on the Pinboard, the workbench behind the right edge | `juggler/pinboard-item-type` | `file` |
| **File Viewer** | How a file type is shown to you and extracted for the model | `juggler/file-viewer` | `text`, `pdf`, `image` |
| **Workspace Provider** | Makes and looks after a place a conversation works in | `juggler/workspace-provider` | — |
| **Hook** | Policy and notes around every tool call, whatever the strategy — deny, ask, allow, or tell the model something | `juggler/hook-type` | — |

An extension may **also** contribute a **system-prompt contribution** — not a
class but a single module whose default export adds terse, durable guidance to
the system prompt (see [System-prompt contribution](#system-prompt-contribution)
below). An extension that provides *only* a system-prompt contribution (a
"prompt pack") is valid.

Juggler ships its own built-ins as one core extension, `@juggler/core`
(`web/extensions/juggler-core/`), loaded through the **exact same path** as any
third-party extension. It is the best reference for well-formed capabilities.

> **Just want a `/name` shortcut for a prompt you reuse?** You don't need an
> extension. A [custom slash command](custom-commands.md) is a no-code markdown
> file — a prompt template plus a few options — editable from the UI. Reach for a
> Command capability (below) only when the command needs real code.
>
> The same goes for hooks: a rule like "ask before touching `migrations/`" or
> "after a sandbox denial, say how to diagnose it" is a [hook file](hooks.md) in
> `~/.juggler/hooks/`, no code needed.

## Quick start

```bash
juggler ext init my-extension       # scaffold: manifest + a sample tool, strategy and command + README
juggler ext validate ./my-extension # run the server's admission check locally
juggler ext link ./my-extension     # symlink into ~/.juggler/extensions (hot-reloads on save)
juggler ext add github.com/owner/repo  # git-clone a published extension into ~/.juggler/extensions
```

`ext validate` applies the server's admission check — required manifest fields
and `engineApi` compatibility with this host — and then goes one step further:
it also confirms that every `provides` glob resolves to real files. That last
check is validate-only, and it is the one worth having. At discovery a glob
matching nothing is not an error; the extension just loads contributing nothing
for that type. So a mistyped path fails fast here with a clear `✗` instead of
becoming a capability that mysteriously never appears. `ext link` symlinks
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
  cards/streak-card.js
  viewers/csv-file-viewer.js
  _tests/word-count-test.js
  README.md
```

A capability file's name **must** end with the suffix for its type — that is how
the manifest globs find it:

| Capability | Conventional directory | Filename suffix |
|------------|------------------------|-----------------|
| Context Item | `context-items/` | `*-context-item.js` |
| Strategy | `strategies/` | `*-strategy-type.js` |
| Command | `commands/` | `*-command-type.js` |
| Info Card | `cards/` | `*-card.js` |
| Pinboard Item | `pins/` | `*-pin.js` |
| File Viewer | `viewers/` | `*-file-viewer.js` |

The directories are convention, not law — the globs in your manifest are what
actually decide. The suffixes are worth keeping: they are what makes a glob like
`cards/*-card.js` pick up capabilities and skip the helper modules beside them.

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
  "license": "Apache-2.0",          // optional; informational SPDX id
  "engineApi": "^1.0.0",            // host SDK compat range, checked at load
  "permissions": ["filesystem.read"],
  "settings": [                     // optional; see Settings and secrets
    { "key": "api_key", "type": "secret", "label": "API key", "required": true }
  ],
  "provides": {
    "contextItems": ["context-items/*-context-item.js"],
    "strategies":   ["strategies/*-strategy-type.js"],
    "commands":     ["commands/*-command-type.js"],
    "infoCards":    ["cards/*-card.js"],
    "pinboardItems": ["pins/*-pin.js"],
    "fileViewers":  ["viewers/*-file-viewer.js"],
    "workspaceProviders": ["workspaces/*-workspace-provider.js"],
    "hooks":        ["hooks/*-hook.js"],
    "systemPrompt": "system-prompt-contribution.js",  // optional; single module path
    "tests":        ["_tests/*-test.js"]              // optional; test-only, never served
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `id` | Yes | Scoped, e.g. `@you/name`. The unit of enable/disable. |
| `name`, `version` | Yes | Display name and semver. |
| `provides` | Yes | At least one capability. `contextItems`/`strategies`/`commands`/`infoCards`/`pinboardItems`/`fileViewers`/`workspaceProviders`/`hooks` are root-relative globs; `systemPrompt` is a single module path (see [System-prompt contribution](#system-prompt-contribution)); `tests` is test-only (see [Testing your extension](#testing-your-extension)) and does not count as a capability. None may escape the extension root. |
| `engineApi` | Recommended | Semver range (`^1.0.0`, `1.2.3`, or `*`). Omitting it disables the compat check and earns a validation warning. The host SDK version lives in `web/sdk/version.js`. |
| `permissions` | As needed | **Declares** the host access this extension's code uses. Surfaced to the user in the catalog and the install prompt — a disclosure, not a sandbox (see [Trust model](#trust-model)). See the vocabulary below. |
| `settings` | As needed | User-configurable values, rendered in the extensions catalog. See [Settings and secrets](#settings-and-secrets). |
| `author`, `homepage`, `license` | Optional | Metadata. `license` is an informational SPDX id for your own code (e.g. `MIT`) — it is displayed, never enforced. |

**Unknown keys are a hard error.** The manifest is parsed with
`DisallowUnknownFields`, so a typo like `"contextitems"` fails the extension at
load with a clear message rather than quietly providing nothing.

**Permission values** are free-form strings, but stick to the established
vocabulary so the catalog reads consistently:

| Value | Meaning |
|-------|---------|
| `filesystem.read` / `filesystem.write` | Reads or writes the user's files |
| `shell.exec` | Runs shell commands |
| `web.fetch` | Fetches arbitrary URLs or searches the web |
| `network.http:<host>` | Talks to one specific host — e.g. `network.http:api.exa.ai` |

Prefer the scoped `network.http:<host>` form when you know the host: "talks to
`api.exa.ai`" is a far more useful disclosure than "reaches the web".

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
import InfoCardType from 'juggler/info-card-type';
import PinboardItemType from 'juggler/pinboard-item-type';
import FileViewer from 'juggler/file-viewer';
import HookType from 'juggler/hook-type';
import { readFile, writeFile, glob, grep, shell, webFetch } from 'juggler/ops';
import { smartTruncate, createElement } from 'juggler/ui';
```

The full set of specifiers, and what each is for:

| Specifier | What it gives you |
|-----------|-------------------|
| `juggler/context-item` | `ContextItem` — the tool base class |
| `juggler/strategy-type` | `StrategyType`, `APPROVAL_POLICY` |
| `juggler/command-type` | `CommandType` |
| `juggler/info-card-type` | `InfoCardType` |
| `juggler/pinboard-item-type` | `PinboardItemType` |
| `juggler/file-viewer` | `FileViewer` |
| `juggler/workspace-provider` | `WorkspaceProvider` — the workspace lifecycle base class |
| `juggler/hook-type` | `HookType` — the tool-hook base class, and `validateHookManifest` |
| `juggler/file-source` | `FileSource`/`FileAccess` types, `toDescriptor`, `fetchFileBytes` — what a file viewer is handed |
| `juggler/ops` | The privileged host operations (below) |
| `juggler/ui` | Render/format helpers — `createElement`, `smartTruncate`, markdown, syntax highlighting, `FormattingHelpers` |
| `juggler/item-utils` | Item-level formatting — paths, sizes, badges, empty states, LLM content formatting |
| `juggler/model` | Conversation vocabulary — `MESSAGE_TYPES`, `TOOL_STATES`, `RESULT_TYPES`, message predicates |
| `juggler/registry` | `createItem()` to materialise another registered item type; `extractFileSource()` |
| `juggler/sandbox` | `runInSandbox(code, { capabilities, timeoutMs })` — run untrusted code in an opaque-origin iframe |
| `juggler/version` | `ENGINE_API_VERSION`, `satisfiesEngineApi(range, version)` |
| `juggler/utils/html` | HTML escaping and templating helpers |
| `juggler/utils/path-containment` | Path containment checks — use these rather than hand-rolling `startsWith` |

- **`juggler/ops`** is the privileged host-operations layer — filesystem, shell,
  search, tree, and web operations that were once built-in-only. These ops run
  with the user's full authority; there is no per-extension sandbox. Declare the
  access your code uses in the manifest `permissions` list — that declaration is
  surfaced to the user (catalog + install prompt) as disclosure, **not** a gate
  (see [Trust model](#trust-model)). The actual gate is the user-approval layer
  (tool approval dialogs, allowed-paths), which applies to every op. The export
  names are a clean vocabulary, deliberately decoupled from the internal
  implementation names, grouped roughly as:

  | Area | Exports |
  |------|---------|
  | Filesystem | `readFile`, `writeFile`, `editFile`, `editFileLines`, `fileHash`, `stat`, `mkdir`, `uploadAssetBase64` |
  | Tree & search | `glob`, `getTree`, `expandDirectory`, `grep`, `findSymbol`, `copyTree`, `compareTrees` |
  | Shell | `shell`, `shellBackground`, `shellOutput`, `shellOutputDelta`, `shellKill`, `shellStreaming`, `cancelShellStreaming` |
  | Web | `httpRequest` (generic server-side HTTP), `webFetch`, `webSearch` |
  | Extension settings | `extensionConfigGet`, `extensionConfigSet`, `extensionConfigResolve` |
  | LLM | `generateText` — one bounded, tool-less, unpersisted turn, for micro-tasks like titles and one-line labels |
  | OS | `openPath`, `revealPath` |
  | MCP | `mcpListServers`, `mcpListTools`, `mcpCallTool`, … |
  | Types | `FileSystem`, `ReadOnlyFileSystem`, `OpsError` |

  There is deliberately no bare `fetch` or `search` export — those would shadow
  web globals. `web/sdk/ops.js` is the list of record.
- **`juggler/ui`** holds render/format helpers (`smartTruncate`, `createElement`,
  `FormattingHelpers`, …) and `createDiffViewer`, the shared diff renderer, which
  draws either a Git patch (`setPatch`) or a pair of before/after snapshots
  (`setDiff`) for one file. `createReviewPanel` is the layer around it for a pin
  reviewing several files at once: it owns the file rail, the comment editor and
  the draft footer, and is given an already-worded manifest, a per-file patch
  loader and a `services.review` to keep the comments in.
  See `web/sdk/ui.js`. It has a worker-safe twin: in the
  engine, the pure formatters are real and the DOM helpers throw, so a capability
  that runs in both realms must keep its rendering on the viewer side.

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

The base class carries the boilerplate for those three methods:
`this.successSummary(text,
extra)` / `this.failureSummary(message, extra)` build the standard summary shape,
`this.truncateForLLM(output)` caps large output at the conversation's budget
(appending the "output truncated" note), and `this.buildStatusUI(actionStatus,
{ typeName, pending, success, failurePrefix })` renders the usual
pending / success / failure status ladder.

For destructive tools set `requiresApproval: true` and implement
`getApprovalConfig()`; for rich viewer rendering implement `getStatusUI()`. The
full method table, the engine-vs-viewer execution-context rules, and every typedef
live in **`web/sdk/context-item.js`**. Good templates: `glob-context-item.js`
(simple read), `read-file-context-item.js` (validation + status UI),
`write-file-context-item.js` (approval + diff), `search-context-item.js` (many
params, truncation).

**Staying out of collapsed tool groups — `static isGroupable()`:** the transcript
can fold a run of adjacent tool rows into a single tile, and every ordinary tool
row folds — a run of "this tool ran" records is exactly what is worth collapsing.
Return `false` from `static isGroupable()` when your row must stay on screen in
its own right: either because the row IS the item (a type that returns `false`
from `isVisible()` has no standing card, so it renders its whole state on the
row, and folding would hide the item rather than a record of it), or because the
user is meant to keep it in sight. The built-ins that opt out are `plan` and
`todo` (no standing card), `AskUserQuestion` (the record of what the user was
asked and answered), and `define_command` / `new_conversation` (artifacts created
outside this transcript). An opted-out row is left unfolded and breaks the run
around it, so no tile ever spans it.

**Per-turn side-effects — `static onTurnEnd(ctx)`:** to do work once at the end of
every turn — retain a memory, ping an external service, checkpoint state — add a
static `onTurnEnd(ctx)`. It runs in the engine each time the root conversation
goes idle, once per completed turn, for **every** context-item type that defines
it — including turns where your tool was never called. It's a *type*-level hook
(context items are per-tool-call, so there's no per-conversation instance), so
keep conversation-scoped state in session/conversation metadata keyed off
`ctx.conversation.id`. It's fire-and-forget and **side-effects only** — read the
transcript via `ctx.messageThread` and do external work; to feed something back
into the next turn use `getContextText()` instead (the read-in half to
`onTurnEnd`'s write-out). Forward `ctx.signal` to async work so a slow run bails
when the next turn supersedes it. A throw is logged and isolated.

### Strategy — control the agentic loop

**How strategies actually run:** in a normal install the **Go worker owns the
loop** (call → execute tools → repeat). A strategy does not drive that loop — it
*shapes* it through its `static MANIFEST` and a set of hooks the worker calls in
the engine. The built-in strategies (`read-only`, `default`, `yolo`) work purely
this way; `read-only-strategy-type.js` is the simplest and best starting point.

The production surface is:

- **MANIFEST fields**: `defaultRules`, `defaultAllowedPaths`,
  `showsApprovalControls`, `recommendations`, `color`, `icon`.
- **`static GUIDANCE`** — what the strategy tells the model when it becomes
  active, or `''` for one that tells it nothing. The base `onActivate` injects
  it as a durable system-reminder; never author system-prompt text. Declaring
  it also publishes it: Settings → Extensions prints a strategy's guidance
  verbatim, so the user can see exactly what a mode says to the model.
- **`filterTools(tools)`** — restrict the tools the model may call (per phase).
- **`getApprovalPolicy(info)`** — auto-approve or force-approve a tool call
  (with the exported `APPROVAL_POLICY` constants).
- **`onActivate(prevId)` / `onWorkerIdle()`** — inject further guidance / drive
  follow-on work. An `onActivate` override must call `super.onActivate()`, or
  the declared `GUIDANCE` stops being what the model is sent.
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

  static GUIDANCE = 'PLANNING MODE: investigate and propose a plan; do not modify anything.';

  filterTools(tools) {
    return tools.filter(t => t.category === 'read' || t.category === 'meta');
  }

  getApprovalPolicy({ category }) {
    return (category === 'read' || category === 'meta')
      ? APPROVAL_POLICY.APPROVE
      : APPROVAL_POLICY.DEFAULT;
  }
}

export default PlanningStrategyType;
```

A strategy never drives the loop itself: the Go worker owns it, and the strategy
shapes it through the manifest and hooks above.

The built-in strategies form a single autonomy axis — **Read-only** (cannot
write), **Default** (asks before writing), **YOLO** (never asks). The full hook
list and manifest fields are in **`web/sdk/strategy-type.js`**.

**Keeping a strategy out of the picker — `hidden: true`:** a strategy with
`hidden: true` in its manifest is excluded from every user-facing list (the
selector, the Shift+Tab ring, the default-strategy picker, the command editor)
and from the first-available fallbacks, but stays resolvable by id. That is for a
strategy nobody picks — one that shapes a single delegated run rather than a mode
the user enters. See the sub-agent pattern below.

### Sub-agent — a tool that runs as its own agent

A context item whose tool runs its invocation as a delegated child thread, under
a strategy the item itself owns. The child's working context — its searches, its
reads, its intermediate tool calls — never enters the caller's; only its final
message comes back as the tool result. `Explore` and `Research` in
`@juggler/core` are the reference implementations: the mechanics below live once
in `context-items/subagents/subagent-item.js`, and each tool is the descriptor
that sits on top of it (`context-items/explore-agent-context-item.js`).

Three parts:

1. **The item delegates.** Set `delegatesToSubthread: true` in its MANIFEST and
   return a spec from `buildSubthreadSpec(toolInput)` — a very short,
   single-line, user-facing `goal`; a complete self-contained `prompt` (the child
   sees nothing of the caller's conversation); and `resultSpec`, containing only
   the return contract. Keep these three jobs separate. If the tool exposes a
   session argument, pass it through as `sessionName`.

   Add `requiresDelegation: true` as well if `buildSubthreadSpec` never returns
   `null` — i.e. the tool has no inline behaviour, as a sub-agent does not. Some
   turns cannot delegate at all: inside a delegated thread (or any descendant of
   one), which is what stops sub-agents recursing, and at the thread-nesting cap.
   The flag is what lets the worker withhold the tool on exactly those turns, so
   the model is never offered a call whose only possible outcome is an error.
   Leave it unset for a tool that delegates *conditionally* and has a real inline
   path — `WebFetch` delegates when given a `prompt` and otherwise fetches the
   page itself, so it stays offered and merely loses its delegation.
2. **The item owns a hidden strategy.** Return it from
   `static getStrategies()`; the framework registers it and forces
   `hidden: true`. Put the class in a module *beside* the item, not under the
   extension's `strategies/` directory — that glob would register it as an
   ordinary, visible strategy.
3. **The spec pins it.** Set `spec.strategyId` to the strategy's id, guarded on
   `strategyRegistry.has(id)` so a user who disabled the extension's strategies
   gets a working (if unfiltered) child instead of a broken tool.
4. **The item says whether the child only reads.** Set
   `readOnlySubthread: true` in the MANIFEST when the child changes nothing
   outside its own transcript. When one turn spawns a batch of children, the
   flagged ones run alongside each other and the rest run one after another — so
   an investigation that fans out four ways costs one wait rather than four.

   It is a claim about the **child**, not about the tool. Every delegating tool
   call is a read from the caller's side, so that is not what is being declared;
   what is being declared is what the agent at the other end may do. Nothing
   verifies it, and the cost of overstating it is siblings racing. The honest
   test: would you be content for two of these to run at the same moment against
   the same working tree?

   `Explore` and `Research` set it — each is pinned to a strategy that admits
   only reading, and refuses anything the permission system would have put to a
   human. `WebFetch` does not, and it is worth understanding why: its child's
   entire brief is to answer from page text it was handed, but its spec pins no
   strategy, so the child inherits the caller's — possibly one that writes
   without asking. A child whose prompt is read-only but whose **tools** are not
   is not a read-only subthread.

**The no-hang invariant.** A sub-agent thread has no human in it, and
`APPROVAL_POLICY` has no DENY. So a tool the strategy exposes but cannot
auto-approve does not prompt anybody — it strands the caller's tool call for the
life of the conversation. Everything surviving `filterTools` must therefore be
either auto-approved by `getApprovalPolicy` or refused outright by
`onToolPending` (`refuseApproval(toolUseId, reason)`, which settles the call as a
failed tool the sub-agent can work around — **not**
`resolveApproval(toolUseId, 'no')`, which records it as a human denial and stops
the turn). Withhold anything that
blocks on a person — note `AskUserQuestion` is category `read`, so a naive
read-only filter keeps it, and as an *elicitation* it can be neither approved nor
refused — and anything that steers the caller's session (`todo`, `plan`,
`memory`, `define_command`, `new_conversation`). Sub-agent tools need no entry in
that list: `SubagentStrategyType.withoutWithheld` drops anything flagged
`requiresDelegation`, matching what the worker does server-side, so a new
sub-agent excludes itself and its siblings by declaring the flag.

Deliver the sub-agent's brief as the strategy's `static GUIDANCE`, from its own
prompt module. In a freshly-born thread that reminder leads the transcript, so it
acts as the brief without touching the cached system prefix.

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

### Info Card — an ambient tile in the sidebar

Info cards are the tiles parked in the sidebar's spare space above the Bin (Usage,
Git status). Your card fills a content region; the host chrome supplies
the eyebrow label and the close button around it.

Cards are **viewer-only** — they touch the DOM and never run in the engine, so
unlike the other capability types there is no worker twin to think about.

Implement `mount(contentEl, session)` and return a teardown function. Optionally
override `hasContent()` (return `false` to drop the card from the rail when there
is nothing to show) and `onEnabled()` (run when the user un-hides the card).

```javascript
import InfoCardType from 'juggler/info-card-type';

class StreakCard extends InfoCardType {
  static MANIFEST = {
    id: 'streak',
    name: 'Streak',
    version: '1.0.0',
    description: 'Show how many turns have run without a failed tool call.',
    eyebrow: 'Streak',
    priority: 10
  };

  mount(contentEl) {
    const paint = () => { contentEl.textContent = `${countClean()} clean turns`; };
    paint();
    const timer = setInterval(paint, 5000);
    return () => clearInterval(timer);   // teardown: stop the timer
  }
}

export default StreakCard;
```

**`priority` decides who survives a squeeze.** Cards stack highest-priority
first, and when the column runs out of room the lowest-priority card is dropped.
A dropped card is genuinely torn down and later **re-mounted** from scratch, so
`mount()` runs more often than you might assume: keep it cheap, and never kick
off an unguarded network request there — a card that fetches on every mount will
hammer the host during a resize. Cache outside the mount and paint from the
cache.

Return a teardown for anything that outlives the element (timers, listeners,
observers), or a resize will leak one per drop. Full reference:
**`web/sdk/info-card-type.js`**. Templates: `cards/usage-card.js` and
`cards/git-status-card.js` (both poll the host).

### Pinboard Item — a tab on the Pinboard

The Pinboard is the tabbed workspace behind the right edge of the window. Each
tab is one **pin**: a configured instance of an item type, kept in server-backed
session state so every viewer of the project sees the same board. You supply the
body of the tab; the host owns the tabs, the toolbar, drag, remove, and the
loading and error shells.

Pinboard items are **viewer-only**, like info cards — they touch the DOM and
never run in the engine, so there is no worker twin to think about.

Know which of the three you actually want:

- An **info card** is an ambient tile the sidebar may *drop* when it runs out of
  room. A pin is guaranteed workspace the user or agent asked to keep visible.
- A **context item** belongs to a conversation and is visible to the model.
  A pin is a one-way view: pinning a file *shows* it, but does not put it in
  anyone's context. The agent may request a pin; it cannot list or read the board.

```javascript
import PinboardItemType from 'juggler/pinboard-item-type';

class ClockPin extends PinboardItemType {
  static MANIFEST = {
    id: 'clock',
    name: 'Clock',
    version: '1.0.0',
    description: 'Shows the time, which is rarely what you wanted to know',
    instances: 'multiple',   // 'single' (default) makes the type a singleton
    order: 0,                // add-picker sort key, ascending; ties keep registration order
    addLabel: 'Add a clock…',// what the add picker calls it, where that differs from name
    addable: true            // default; false for a type only ever pinned from a source
  };

  describe(config) {
    return { title: config.zone || 'Local', subtitle: 'clock' };
  }

  mount(container, { signal }) {
    const tick = () => { container.textContent = new Date().toLocaleTimeString(); };
    tick();
    const timer = setInterval(tick, 1000);
    return {
      teardown: () => clearInterval(timer),
      getActions: () => [{ id: 'now', label: 'Now', primary: true, run: tick }],
    };
  }
}

export default ClockPin;
```

**Config is the only thing that persists**, so keep it small, JSON-serializable,
and meaningful without the machine that produced it: a path, not file bytes.
Board state is shared and long-lived, and it outlives your class — a pin whose
extension has been disabled keeps its config until the user removes it, and
`normalizeConfig()` is what you get called with when it comes back.

**Hold no authoritative state on the instance.** One instance serves every pin of
its type, mount and teardown happen for reasons you do not control, and the same
board is open in windows you cannot see. `mount()` may return a bare teardown
function, or a controller with `update()` (apply a new active-context snapshot in
place instead of being rebuilt), `focus()`, and `getActions()`.

**`getActions()` puts controls in the toolbar the host draws above you.** Mark at
most one `primary`; everything else waits behind the overflow. The host asks
after `mount()` and after every `update()` and at no other time, so return the
same set each call and use `disabled` for an action that cannot run yet.

`mount()` receives a `PinContext`: the `pin` itself, an immutable `active`
snapshot (project, conversation, thread), `services` for data that snapshot does
not carry, a `signal` aborted on teardown, and `updateConfig()` — your only way to
write anything down. Anything you throw is caught and shown in the pin's place
with the error text intact, so let a real failure throw rather than rendering your
own apology.

**Services are read-only, and added one at a time** as the provider that needs one
lands — so write against what is there rather than what you expect to be. Five
exist, and the two that write are called out as the exceptions they are:

| Service | What it gives you |
|---------|-------------------|
| `services.files` | `onChange(listener)` — files changing on disk, absolute paths. Only inside the open project, and never dot-files: the watcher is rooted at the project and skips them. Offer a way to re-read rather than trusting it to be complete, and never poll for what it does not tell you. |
| `services.contextItems` | `find(type, from?)` — the nearest context item of a type, as a copy, with the thread it came from; `onChange(listener)` — the items or the focused thread moved, call `find` again; `reveal(threadId)` — bring that thread's column into view. |
| `services.git` | The ambient half: `status()` — every repository under the project with its branch, upstream divergence, counts and bounded file list, or null before the first read; `error()` — the last read's failure, shown beside the last good status rather than instead of it; `onChange(listener)`; `refresh()`. The deliberate half: `review({signal})` — every repository and every changed file in each of them, with whatever could not be reached named in `warnings`; `diff(repo, path, {signal})` — one file's whole working-tree change against `HEAD`, as structured hunks. |
| `services.tasks` | `list()` — the background tasks this conversation has running, newest first, or null before the first check; `error()`; `onChange(listener)`; `reveal(itemId)` — select the tool action that started one; `stop(taskId)`. |
| `services.review` | `draft()` — the unsent review comments on the thread being read, as a copy, or null when there is no conversation to hold any; `onChange(listener)` — they changed, here or in another window, or the reader moved to a thread with different ones; `save({comments})` — replace them; `clear()` — discard them; `compose()` — put them as one ordinary message into that thread's composer for the reader to send, keeping them on the draft. |

`contextItems.find()` resolves the way the columns do: the thread the user is
reading first, then its ancestors, nearest first, ending at the root. That is why
the result carries a `source` — say whose it is when `source.inherited` is true,
because a list belonging to a thread the user is not in is a different claim from
one belonging to the thread they are.

Pass `from` to start that walk somewhere other than the thread being read — a
thread id, or `null` for the conversation root. That is how a pin stops following
the reader and stays on one thread. The resolution is identical either way, so
the `source` you get back is still whichever thread actually owns the item; a pin
that watches one thread should say both which thread it is watching and whose
list it ended up with, because they are different questions.

**A reveal happens in the window that has the columns.** A board detached into a
window of its own has none, so its reveal is relayed back to the window that
opened it and carried out there, which then brings itself forward. Nothing about
your pin changes — that is the point — but it does mean a reveal is best-effort
and one-way: it returns nothing, and once the window that owns the board has gone
there is nowhere left to point.

`services.git` is a **poll, not a watch**: nothing under `.git` reaches the file
watcher, so the host asks git on a timer while the window is focused, and
`onChange` means a fresh answer arrived rather than that the repository changed
when it did. Give the user a way to ask again, and never poll yourself — every
surface shares the one poll, and a second would run git twice.

`review()` and `diff()` are the other half of that service, and they are the
opposite of the poll: asked for rather than kept up to date, and never quietly
shortened. A review reads every repository under the project, so ask when a
review is opened or refreshed — concurrent callers share one read, so a second
surface costs nothing, but a loop here runs git in a loop. Its `complete` field
is the one thing not to paper over: false means something is missing, `warnings`
says what in sentences fit to show a user, and partial results are worth keeping
on screen as long as you describe them as partial. Ask for a patch one file at a
time, at the moment something is going to show it. Pass a `signal` to either and
cancelling really does cancel the read; the host also cancels whatever your pin
has out when the pin goes away. Both reject rather than resolving with nothing —
the read failed, you cancelled it, or the project changed while it was out — so a
cancelled request is never mistaken for a file that turned out to be unchanged.

`services.tasks` is a **live inventory, not a history**: a task leaves the list
the moment it ends, however it ended, and nothing survives a server restart. That
is not a gap to paper over — the history is on the tool action that started the
task, with its output and its exit code, which is where `reveal` goes. Two things
follow. `list()` returning null means the host has not checked yet and is not the
same as an empty list, so say you are still looking rather than that nothing is
running. And there is no way to ask what tasks *exist*: the host builds the list
from the ids in this conversation's own transcript and asks the server only which
of those are alive, so nothing here can show you another conversation's work.

`tasks.stop` is the one thing any service does rather than reports, and it is a
deliberate exception rather than a precedent: it acts on a process, at the user's
request, on a surface the conversation already offers a Stop button for. It
rejects if the task could not be asked to stop — show what came back.

**A review draft belongs to a thread, not to your pin or to the project.** It is
kept where the message it will become would go, in the conversation's own
document, which is what makes it survive a tab switch, a detached board and a
restart — and what makes two boards on the same conversation two views of one
draft rather than two drafts. Moving to another thread or another conversation
therefore reveals that one's comments; it never carries these across, because a
comment is addressed to whoever is going to read it. `draft()` returning null is
that situation rather than an empty review: there is no conversation, so there is
nowhere to write, and offering somewhere anyway would quietly discard it.

`review.save` is the second write, and it refuses rather than trims: a draft over
a limit — 500 comments, 8000 characters in one of them — rejects and writes
nothing, as does a save with no conversation to write to. Keep the text on screen
and show what came back beside it. What you get from `draft()` is a copy, so edit
it and save it back; the comments you send are yours to build, but the quoted
source lines are bounded on the way in, being a copy of code the file still holds.

`review.compose` hands over what was last saved, so save an edit before handing it
over. It becomes one ordinary message on the thread the comments belong to,
written in the same `file:line` blocks the context menu quotes a selection in —
text the reader can see and the agent already knows how to read, with nothing
hidden in it and nothing parsed back out. It is not sent: it is inserted into that
thread's composer at the caret, for the reader to read back, add to, cut down or
abandon. A half-written question already in the box survives it, along with its
attachments and an armed scheduled send, and one undo takes the review back out.
From a detached board, which has no composer of its own, it goes to the window the
board was opened from; with neither a composer nor that window, it is sent as a
message rather than dropped. **The comments are never cleared** — text sitting in
a box has not been said, so only `clear()` discards them, and a rejection (nowhere
to put it, nothing to say) leaves them untouched too. Show what came back and
leave the review alone.

**The board and your pin share a keyboard, and position decides who gets a key.**
While focus is on the board itself — the region a reader lands on when the board
opens — the arrows step along the tabs, the Page/Home/End keys scroll your pin,
and Return goes into it. Once focus is inside your pin, the keys are yours: the
board keeps only ←/→, so a reader who has tabbed to the last button in your pin
is not stranded there, and Escape, which takes them back out to the region.
Handle a key you want and call `preventDefault()` — the board listens above you,
sees it was handled and stands down — and the same is true of a text field, whose
arrows are never taken. There is nothing to register and no flag to set. The
chord (⌥⌘←/→, Ctrl+Page Up/Down) belongs to the board wherever focus is, which is
why your pin may safely claim every plain key it wants.

Full reference: **`web/sdk/pinboard-item-type.js`**. Templates:
`pins/file-pin.js` (multiple instances, a picker in `configure()`, a live file
watched through `services.files`, and four toolbar actions) and `pins/plan-pin.js`
(a singleton reading the conversation through `services.contextItems`, with a
shared body in `lib/task-list-pin.js`).

### File Viewer — how a file type is shown and extracted

A file viewer owns one file type end to end: what **you** see in the panel, and
what the **model** sees when the file reaches its context. Those are two
different jobs in two different realms, and the class splits them cleanly:

| Method | Realm | Job |
|--------|-------|-----|
| `render(source, host, ctx)` | viewer (has DOM) | Draw the file for the user; return teardown |
| `extract(source, ctx)` | engine (**no DOM**) | Produce the model-facing text/attachments |

Resolution is **declarative and cheap**: the registry picks a winner from static
MANIFEST data alone and only *then* imports the module. Candidates are viewers
whose `mimeTypes` or `extensions` match (or that set `matchAll`) and whose
`maxBytes` the file does not exceed; the highest `priority` wins. Because of
that, a viewer with a heavy dependency must `import()` it **inside** the method
that needs it — otherwise the engine downloads a rendering library it will never
use.

```javascript
import FileViewer from 'juggler/file-viewer';

class CsvFileViewer extends FileViewer {
  static MANIFEST = {
    id: 'csv',
    name: 'CSV',
    version: '1.0.0',
    description: 'Renders CSV as a table and extracts it as aligned text',
    mimeTypes: ['text/csv'],
    extensions: ['csv'],
    priority: 50,
    maxBytes: 8 << 20
  };

  async render(source, host) {
    const rows = parse(await source.bytes());
    host.appendChild(buildTable(rows));
  }

  async extract(source, ctx) {
    const rows = parse(await source.bytes());
    const budget = ctx?.maxChars ?? Infinity;
    const kept = takeWhileUnderBudget(rows, budget);   // stop on a row boundary
    return { text: format(kept), truncated: kept.length < rows.length };
  }
}

export default CsvFileViewer;
```

`static claims(descriptor)` overrides the declarative match where `mimeTypes` and
`extensions` cannot express the rule: return `true` to claim a file the manifest
would have missed, `false` to refuse one it would have taken, `undefined` to
defer. It runs during resolution, so it must be cheap, synchronous, and read
nothing but the descriptor — **the bytes have not been fetched**. The text viewer
uses the veto to decline binary files, which is how a binary with no dedicated
viewer falls through to the host's "no viewer" fallback.

When honouring `ctx.maxChars` in `extract()`, stop at a natural boundary (a row,
a page, a record) and set `truncated: true` — do not return everything and leave
the caller to cut it mid-word. Full reference: **`web/sdk/file-viewer.js`**, with
the `FileSource` shape (`path`, `mime`, `size`, `bytes()`, `url()`) in
**`web/sdk/file-source.js`**. Templates: `viewers/text-file-viewer.js` (the
fallback, and the `claims()` veto), `viewers/pdf-file-viewer.js` (lazy `import()`
of a heavy dependency, teardown), `viewers/image-file-viewer.js` (attachments
instead of text).

### Workspace Provider — somewhere else for a conversation to work

A **workspace** is the environment a conversation's tools run in: somewhere to
run commands and read and write files, plus the identity it is shown under. Every
project already has one — itself. A provider makes the others: a git worktree, a
throwaway copy of the tree, a folder inside the project.

| Method | Job |
|--------|-----|
| `renderSetup(container, ctx)` / `getSetupValue()` | Draw the fields in the new-conversation panel, and report what they say |
| `provision(values, ctx)` | **Headless.** Build the place from those values alone |
| `status(workspace, ctx)` | How it is doing. **Must be cheap** — asked of every row the panel lists |
| `finishOptions(workspace)` / `finish(workspace, id, ctx)` | The ways to be done with it, and doing one |
| `status()` does **not** say what kind of place it is | The manifest's `name` and `description` do, from the first draw |
| `status()` does **not** name it | The `label` on the row does, everywhere. A status is asked for after the first draw and can take a git call to answer, so a name from it would arrive late and change the title under the reader |
| `reconcile(workspaces, ctx)` | What exists, set against what the session thinks it has. Only looks |
| `cleanupPartial(workspace, ctx)` | Undo a provision that died with the tab, from `workspace.meta` alone |

Three rules carry most of the weight.

**Say what each option does to the conversation, not just to the files.** Every
`finishOptions()` entry is shown with its `description` under it, and finishing
bins every conversation that was working there — recoverably, but it takes them
off the strip — so a description that stops at "removes the tree" leaves the
reader guessing at the half they actually feel. An ending that leaves nothing
behind the conversations were about returns `conversations: 'return'` alongside
`done: true`, and the host moves them back to the workspace this one was made
from instead of binning them (the group provider's "Ungroup" does this). An
option that is *not* a way of being done — committing, pushing,
reinstalling — sets `keepsWorkspace: true` and returns `done: false`; the host
shows it apart from the endings, above the heading that warns what the rest of
them are.

**Setup and provisioning are separate on purpose.** `provision()` runs from
collected values and never asks a question of its own, which is what makes a
whole lifecycle testable as a sequence of commands rather than as UI puppetry.

**Record how to undo each irreversible step *before* taking it** — twice, because
the two undos happen in different worlds. `ctx.checkpoint({…})` persists what you
are about to do, and `cleanupPartial()` can then unwind a provision whose tab
died; `ctx.rollback.push(…)` is the live stack the host runs in reverse on
cancel, on failure, and on Undo. Declaring intent first is what leaves no gap: an
abort can land between a step and the line after it, and a compensation pushed on
that line is never pushed at all. The price is that a compensation routinely runs
for a step that never happened, so every one of them must tolerate absence —
`rm -rf`, not `rm`.

```javascript
import WorkspaceProvider from 'juggler/workspace-provider';

class GitWorktreeProvider extends WorkspaceProvider {
  static MANIFEST = {
    id: 'git-worktree',
    name: 'Git Worktree',
    version: '1.0.0',
    description: 'Another branch of this repository, checked out in a tree of its own',
    setupLabel: 'New git worktree'
  };

  plannedRoot(values) { return values.location; }   // the host registers the row first

  async provision(values, ctx) {
    const { branch, base, treeRel } = places(values, ctx);
    ctx.progress('Creating the worktree', values.location);
    await ctx.checkpoint({ branch, treeRel });
    ctx.rollback.push(async () => {
      await ctx.ops.shell({ command: `git worktree remove --force "${treeRel}"` }, ctx.signal);
      await ctx.ops.shell({ command: `git branch -D "${branch}"` }, ctx.signal);
    });
    await ctx.ops.shell(
      { command: `git worktree add -b "${branch}" "${treeRel}" "${base}"` }, ctx.signal);
    return {
      workspace: { root: values.location, label: branch, meta: { branch, treeRel } }
    };
  }
}

export default GitWorktreeProvider;
```

`ctx.ops` is the only way a provider touches anything, and it arrives already
rooted: at the **base** workspace during `provision` (the repository — the tree
does not exist yet), and at the workspace itself everywhere else. A provider is
handed operations rather than a place, and does its work through them.

`ctx.baseOps` is the other end of the same thread: operations rooted at the
workspace this one was **made from**. An ending that lands work back where it
came from writes through those, and so does anything whose own artifacts live
beside the base rather than beside the project — a path outside an operation's
root is refused, not sanitised, so the copy's own operations cannot reach the
tree it is a copy of.

A finish option that needs something typed before it runs — a commit message, a
reason — says so with `prompt`, and what is typed arrives as `ctx.input.message`.
An option with no `prompt` is confirmed rather than asked.

```js
prompt: {
  label: 'Message',                  // the field's caption. Name the thing, not the act
  placeholder: 'What this work does',
  hint: 'What changed and why.',     // read under the field, while typing
  multiline: true,                   // a textarea; ⌘/Ctrl+Enter runs the ending
  requiresWork: true,                // pointless unless the workspace holds changes
  alternative: {                     // a second answer, as its own button
    label: 'Let this conversation write it',
    hint: 'It has read the work; the commit happens on its next turn.'
  }
}
```

**An empty field must not mean something other than a full one.** Where answering
nothing is a real choice rather than an omission, declare it as an `alternative`:
it runs the same ending with an empty `ctx.input.message`, and the host will not
let the primary button submit a blank field. A prompt with no `alternative` gets
no second button — the host invents nothing.

`requiresWork` is declared rather than inferred. The host knows whether the
workspace is dirty, but "nothing has changed" is a reason to stop a commit and no
reason at all to stop an ending that merely asks for a name.

**A provider may be absent when its workspaces come back.** A workspace's `root`
is the session's, so an extension that is disabled or broken cannot strand a
conversation: its operations keep resolving. Only what the provider supplies
degrades — status becomes "provider unavailable", the finish menu renders empty
with that reason, and reconcile does not run for its rows, which are left
strictly alone because nothing present understands them.

Full reference: **`web/sdk/workspace-provider.js`**. Template:
`workspaces/git-worktree-workspace-provider.js` in `@juggler/core` — every hook,
a real cancellation story, and the reason no absolute path is ever put in a
command.

### Hook — policy and notes around every tool call

A hook runs around every tool call, whichever strategy is active and alongside
every other hook. A strategy decides how autonomous the agent is; a hook says
what is true regardless. Use one for a guard ("never `git push --force`"), an
approval rule ("ask before anything touches `migrations/`, even in YOLO"), or
a note the model needs after a certain kind of result ("that was a sandbox
denial — here is how to diagnose it").

```javascript
// hooks/nono-denial-hook.js
import HookType from 'juggler/hook-type';

export default class NonoDenialHook extends HookType {
  static MANIFEST = {
    id: 'nono-denial',
    name: 'nono denial diagnostics',
    version: '1.0.0',
    description: 'After a call the sandbox refused, tells the model to run `nono why`',
    events: ['afterTool'],
    match: { result: 'Operation not permitted|EPERM|EACCES' },
    repeat: 'once-per-thread'
  };

  afterTool({ toolName, result }) {
    return { note: `The sandbox refused that ${toolName} call. Run \`nono why\` before retrying.` };
  }
}
```

**Declare what you match; don't test for it.** `match` narrows the calls a hook
is offered: `tools` (names as the model calls them), `input` (a regular
expression tested against the input as JSON), and, for `afterTool`, `result` (a
regular expression tested against the result text) and `isError`. The runtime
applies it before calling you, so a hook never pays for a call it didn't ask
for, and the catalog can show exactly what each hook fires on.

| Method | Receives | May return |
|--------|----------|------------|
| `beforeTool(ctx)` | `toolName`, `toolInput` (a copy), `toolUseId`, `conversationId`, `threadId`, `signal` | `{ verdict: 'deny' \| 'ask' \| 'allow', reason }`, and/or `{ note }` |
| `afterTool(ctx)` | the same, plus `result: { content, isError }` | `{ note }`, and/or `{ markError: true }` |

Either method may be async. Returning nothing means no opinion.

- **`deny`** ends the call as a failed tool. Its result reads `Blocked by hook
  "<name>": <reason>`, and the model sees it.
- **`ask`** parks the call for the user, even under a strategy that approves
  everything. The call is never handed to the strategy's `onToolPending`
  reviewer, and its approval card names the hook and its reason.
- **`allow`** waives the gate the way a saved permission rule does, and the
  call is stamped as approved by a hook. It never overrides a strategy that
  requires approval, and never applies to a call that must reach a human (an
  elicitation, or a call whose `autoApprovable` is false).
- When hooks disagree, deny beats ask beats allow.
- **A note goes inside the call's tool result**, after the tool's own output,
  as a `<hook-note source="<id>">` block. It is never a separate message. On
  the Claude Code provider, anything after a batch's tool results would read as
  the user interjecting and cost a session respawn, so keeping the note in the
  result avoids that. The note is stored on the tool-action (its `hooks` field)
  and shown in the call's properties panel, so the transcript still holds
  exactly what the model was told.
- **`repeat: 'once-per-thread'`** drops your note when an earlier call in the
  same thread already carries one from you. Verdicts are never deduplicated.

**Where and when it runs.** Hooks run only in the engine, once per call, never
in a viewer tab.

- `beforeTool` runs between `prepare()` and the approval decision. It gets
  `timeoutMs` (default 2000, at most 3000), which stays under the worker's
  re-drive of an unanswered tool command.
- `afterTool` runs after the tool returns and before its result is written,
  while the call still reads as running. It gets `timeoutMs` (default 5000, at
  most 30000), and its `signal` aborts if the call is cancelled.
- A hook that throws or times out fails open: the call goes ahead as if the
  hook hadn't run, and the failure is recorded. A `beforeTool` hook can set
  `onError: 'closed'` to hold the call for the user instead.

One instance of each hook class is kept for the life of the registry, so a hook
may keep state between calls.

Hooks do not run on sub-threads (`create_thread`) or on the meta tools the
worker handles itself.

Full reference: **`web/sdk/hook-type.js`**. Example:
`examples/extensions/nono-denials`. For the no-code version (a markdown file in
`~/.juggler/hooks/`), see [Tool hooks](hooks.md).

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
aggregation contract is `buildExtensionSystemPromptContributions()` in
`web/js/services/extensions.js`.

## Talking to the conversation

Commands and strategies receive a **`MessageThread`** (`this.messageThread`). It
is the **only** interface you should use to read or mutate conversation state.
Its safe public methods are marked **`@plugin-api`** in the source —
`web/js/model/message-thread.js` is the reference; grep it for `@plugin-api`.

Common reads: `items`, `length`, `findByItemId(id)`, `contextItems`,
`modelConfig`, and the permission rules via `getAllRules()` /
`getRulesFor(itemType)`. Common writes: `addEvent()`, `deleteItemById()`,
`addContextItem()`. For several mutations as one atomic Yjs
transaction use **`mutate(fn)`** (it also runs `assertInvariants()` in dev mode);
`buildThreadYMap()` is the safe way to seed a sub-thread with items.

> **Never touch raw Yjs objects from a capability** — `messageThread.yarray`,
> `.container.set(…)`, or importing `yjs.mjs`. The framework maintains invariants
> (every thread owns one SYSTEM_1, itemId uniqueness, the tool state machine)
> reactively in Yjs observers that only fire for mutations routed through the
> `@plugin-api` methods. Bypassing them breaks undo, redo, and peer sync. This is
> a hard rule, not a style preference.

## Pinned file content vs. reads

Juggler distinguishes two ways a file's contents reach the model:

| Item | Role | Content read | Placement |
|------|------|--------------|-----------|
| `ReadFileContextItem` | Immutable record of a `read` tool call | Once, at call time | conversation history (part of the transcript) |
| `FileContentContextItem` | A user's "keep this file current" pin (the file picker) | Live, every turn | `contextPosition: 'prefix'` (before history) |
| `FileContentContextItem` with `data.frozen` | An `@`-mention | Once, at the send that carried it | `contextPosition: 'prefix'` (before history) |
| `FileContentContextItem` with `data.seeded` | An agents file the session added to itself | Once, at the first transaction | `contextPosition: 'prefix'` (before history) |

A **read** is the model's: it lands in the append-only history as a
`tool_use`/`tool_result` pair and never moves, so it is inside the byte-stable
cached prefix and is paid for **once**.

An **`@`-mention** is the user's counterpart of a read: a one-shot "here is this
file", frozen at the send that carried it. The composer creates one frozen item
per mentioned path. A later mention of the same file reuses that item, retaking
its snapshot if the file has changed, so the model is never sent two copies. A mentioned file is usually mentioned so the
agent can work on it, so it must not re-render when the agent does — see
[Frozen items](#seeded-agents-files-and-mentions-freeze) below.

A **pin** — the file picker — is the deliberate exception, and the only live
case. It means "this file, kept current." It persists only a `path` in Yjs (no
bytes), and `createContextText()` resolves the live file every turn. Because a pin
rides the leading, cached prefix (`contextPosition: 'prefix'`), an *unchanged* file
renders byte-identically each turn → the prompt cache hits and the pin is paid for
once; only a *genuine change* to the file busts the cache from that point — which
is the price of asking for the file to be kept current. There is no watcher
(nothing is in flight between sends) and no bytes in the document (pinning a 5 MB
file doesn't bloat Yjs).

### Seeded agents files and mentions freeze

An `@`-mention (`data.frozen`) and the `CLAUDE.md` / `AGENTS.md` /
`.cursorrules` a session seeds itself with (`session.js` `addAIAssistantFiles`,
`data.seeded`, which implies frozen) are the same class, and they are **frozen**,
not live: they snapshot once into `data.content` and serve that for the life of
the conversation.

Live would be the expensive default for both, for the same reason. The agent
editing the file it was handed is *routine* — a file is mentioned so the agent can
work on it, and an agents file is the one it is most often asked to update — and
because the item sits in the cached prefix, a live re-read would cold-start the
conversation from that point every time it did so. Worse, it would be paying that
cold start to tell the model something it already knows: right after such an edit
the new bytes are in the history anyway, verbatim, in the `tool_use` pair that
wrote them.

Two details matter if you write another item like this:

- **Freeze at the first transaction, not at add-time.** A conversation can sit
  open for an hour before its first send, and a mention made while a turn runs
  waits in the pending queue; what belongs in context is what was true when the
  model was handed it. `contextParams.forRequest` marks the dispatch render; a
  properties-panel render does not carry it, so merely *looking* at an item can
  never decide what it is going to say.
- **Give the user the live view and a way back.** The properties panel reads the
  file live, says plainly that the conversation is reading a frozen copy, and
  offers an update that re-snapshots on demand — stating the re-read it costs. A
  frozen item whose staleness is invisible is a worse bug than the cold start it
  avoided.

### `contextPosition`: where a standing item's content is injected

A context item's `MANIFEST.contextPosition` decides where its rendered content
lands in the request, which governs whether it is cached:

| Value | Placement | Cached? | Built-in users |
|-------|-----------|---------|----------------|
| `system` | folded into the system prompt | yes; a change re-bills the whole request | memory, skills, system-prompt |
| `prefix` (default) | leading messages, **before** history | yes; unchanged render caches, a real change busts once | file-content, dropped-file |
| `none` | not injected at all | n/a — state lives in tool_use history | todo, plan |

**Freeze anything at the `system` position that is sourced from outside the
conversation.** Both built-in examples read from somewhere shared — memory from
`.juggler/MEMORY.md`, skills from the skills directories — so both snapshot into
`this.data` in `onToolCall` (write-once) and render that snapshot in
`createContextText`. Reading live there is the most expensive mistake in this
table: the system block is the head of the cached prefix, so a single edit
doesn't just bust the current turn, it forces **every open conversation** to
re-read its entire context at the uncached rate. Freezing costs those
conversations nothing and lets the change reach new ones instead.

At `prefix` the same question is a judgement rather than a rule, because the bill
is smaller and lands only on the conversation that caused it: one cold start,
here, now. Ask **who asked for this item to exist**. A user who pins a file chose
it, is thinking about that file, and wants it kept current — live is right, and
the occasional cold start is the deal they made. An item the session added for
them chose nothing on their behalf, and can be edited by the agent as part of
ordinary work, so it should freeze (see the seeded agents files above). The
guiding line is the same one that governs `system`: **content sourced from
outside the conversation should not be able to re-price the conversation without
anyone asking it to.**

**An item that freezes anything read out of the tree should implement
`onWorkspaceChanged()`.** A conversation can be moved to another workspace after
it has started, and a snapshot taken from the tree it left would otherwise go on
being served in the tree it arrives in. The default does nothing, which is right
for an item that reads through `this.ops` and resolves its paths at use time —
those follow a move on their own. The built-in `file-content` item overrides it
to take its snapshot again, and to leave it alone when the new tree has no such
file: a snapshot is only ever replaced by another snapshot, never by the
"file does not exist" that reading one would return.

There is deliberately **no trailing/tail position**. Standing content is either
cacheable (`system`/`prefix`) or lives in the model's own tool history (`none`);
content that genuinely changes every turn is an anti-pattern (it would bust the
cache each turn) — put that state in a tool result instead. Content the model
fetched for itself (a `read`) belongs in the append-only history, not in a
standing context item.

## Settings and secrets

An extension that needs an API key, an endpoint, or a preference declares it in
the manifest's `settings` array. Juggler renders the form in the extensions
catalog, validates and stores the values, and hands them to your code — you write
no settings UI.

```jsonc
"settings": [
  { "key": "api_key",  "type": "secret",  "label": "API key",
    "help": "Create one at https://example.com/keys", "required": true },
  { "key": "endpoint", "type": "url",     "label": "Endpoint",
    "default": "https://api.example.com" },
  { "key": "depth",    "type": "enum",    "label": "Search depth",
    "options": ["shallow", "deep"], "default": "shallow" }
]
```

| Field | Notes |
|-------|-------|
| `key` | Required. Letters, digits, `_`, `-`; must start with a letter. Unique within the extension. |
| `type` | Required. One of `string`, `text` (multi-line string), `secret`, `boolean`, `number`, `url`, `enum`. |
| `label` | Required. Shown beside the control. |
| `help` | Optional one-liner under the control. |
| `default` | Optional, validated against `type`. |
| `required` | Optional. |
| `options` | Required for `enum`, rejected for every other type. |
| `scope` | Optional; only `global` is supported today (the field exists so project scope can arrive without changing the manifest shape). |
| `capability` | Optional `"<itemType>:<id>"` of one of your capabilities, e.g. `"strategy:my-strategy"`. The setting is then also shown on that capability's page. Only where it is displayed changes: it is stored and resolved with the extension's other settings. |

A capability that owns `text` settings can also define a static
`settingsView(values)`. The form calls it with the current values whenever one
changes, and it returns, per setting key, `{preview, seed, note}`:
- `preview` shows that text read-only in place of the value. The stored value is
  kept aside, and it is the stored value that gets saved.
- `seed` starts a blank editable field. A field that was just showing a preview
  starts from that preview instead.
- `note` is a line shown under the field.

The built-in Auto-approve strategy uses it to show each preset's policy and to
start a custom one from it.

Two rules the validator enforces that are easy to trip over: **only `enum` may
carry `options`**, and **a `secret` may not declare a `default`** — a shipped
default credential is never what you meant.

### Reading them at runtime

```javascript
import { extensionConfigResolve } from 'juggler/ops';

const EXTENSION_ID = '@you/my-extension';   // must match the manifest id

const config = await extensionConfigResolve({ extId: EXTENSION_ID }, this.signal);
const apiKey = typeof config.api_key === 'string' ? config.api_key.trim() : '';
if (!apiKey) {
  throw new Error('API key is not configured. Set it in Settings → Extensions.');
}
```

There are two readers, and the difference matters:

- **`extensionConfigResolve`** returns the *real* values, secrets included. This
  is what your capability code calls.
- **`extensionConfigGet`** is the viewer-safe reader: secrets come back as a
  presence marker (`{ __present: true }`), never the value. It is what the
  settings UI uses.

Values are keyed by extension id, so the id you pass must match your manifest
exactly. Non-secret values live in `~/.juggler/extension-config`; secrets go to
the credential store under an `ext:` prefix, never into that file. Defaults are
applied on read, so a setting the user has never touched still resolves to its
declared default.

**Missing configuration is a normal state, not a crash.** Fail with a sentence
that says where to fix it — `'Set it in Settings → Extensions'` — because that
message is what the model relays to the user.

Worked example: `web/extensions/exa/` (a `secret` API key, declared with the
scoped permission `network.http:api.exa.ai`).

## Testing your extension

An extension owns its tests instead of dumping them into the host's shared pool.
Declare them in the manifest and Juggler's test harness picks them up:

```jsonc
"provides": {
  "contextItems": ["context-items/*-context-item.js"],
  "tests":        ["_tests/*-test.js"]
}
```

`tests` is **test-only**: it does not count as a capability (an extension that
provides *only* tests fails validation), and it is never served through the
extensions API at runtime.

**Keep them in a directory whose name starts with an underscore** — `_tests/` by
convention. That leading underscore is what makes Go's `//go:embed extensions/*`
skip the directory, so your test code never ships inside a production binary. A
`tests/` directory would be embedded.

Every built-in extension follows this pattern; `web/extensions/juggler-core/_tests/`
has a couple of dozen worked examples.

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

- **Tutorial** — [`extension_tutorial.md`](extension_tutorial.md) builds one
  extension end to end, if you would rather follow a worked example than a
  reference.
- **API source of truth** — `web/sdk/`: `context-item.js`, `strategy-type.js`,
  `command-type.js`, `info-card-type.js`, `pinboard-item-type.js`,
  `file-viewer.js`, `hook-type.js`, `ops.js`, `ui.js`, `version.js`. Read the JSDoc headers.
- **Conversation API** — `web/js/model/message-thread.js` (grep `@plugin-api`).
- **Worked examples** — `examples/extensions/` (small extensions covering every
  capability type) and `web/extensions/juggler-core/` (the built-in extension —
  bigger, and the best reference for real-world detail).
- **Manifest format** — `cmd/juggler/extmanifest/extmanifest.go`.
- **CLI** — `juggler ext --help`.
