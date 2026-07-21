# Worktrees as an extension (issue #51)

## Context

[Issue #51](https://github.com/juggler-ai/juggler/issues/51) and
[PR #40](https://github.com/juggler-ai/juggler/pull/40) asked for per-conversation
git worktrees so two conversations (side-tabs) editing one repository don't
clobber each other. The maintainer's steer was explicit:

> in juggler the approach would be to implement them as an **extension**, not to
> just bake the concept into the core app. So it's a case of either finding an
> elegant way to do them via the current extension API, or finding the right
> abstraction to add to the API that would let someone add worktrees and other
> types of similar workflow as extensions.

An added hard requirement: a conversation may manipulate **more than one git
repository**, and each repo it touches should get its own dedicated worktree.

**TL;DR.** Zero API change is impossible — no extension surface can change
*where* a conversation's file/shell ops physically execute. The missing
abstraction is small and general: a **per-(conversation, source-directory)
execution-root binding**, routed by longest-prefix match. It is driven by a
lightweight **lifecycle module** (manifest `provides.lifecycle`, the same
"plain module the host loads and calls" shape as `systemPrompt`) — *not* a
Strategy, since where-work-happens is orthogonal to loop autonomy. Core gains one
indirection (a path remap) plus a bind API and stays completely ignorant of git;
the entire worktree policy lives in an ordinary extension
(`examples/extensions/juggler-worktrees/`). The multi-repo requirement forces the
per-source binding over t3code's single-cwd model. Opt-in is **per project**
(enable the extension). The same primitive enables devcontainer / remote-dev /
sandbox lifecycle modules.

## How t3code does it (and why we diverge)

t3code (`apps/server/src/git`, `apps/server/src/vcs/GitVcsDriver.ts`,
`.plans/git-integration-branch-picker-worktrees.md`):

- A thread carries a single **`worktreePath: string | null`** (and one
  `branch`). One worktree per thread, for one branch.
- The agent session is **re-rooted wholesale**: the session cwd is
  `activeThread.worktreePath ?? activeProject.cwd`, and every git op is
  `git -C <cwd> …`. There is no per-operation redirection.
- Worktrees are created by `git worktree add`, defaulting to a sibling
  `../{repo}-worktrees/{branch}` (branch slashes sanitized); a `removeWorktree`
  exists. Cross-repo PR branches are namespaced `t3code/pr-<n>/<head>`.
- **It is single-repo by construction.** A thread has exactly one `worktreePath`;
  multi-repo-per-thread is not modelled.

The load-bearing consequence: **a single session cwd can point at exactly one
worktree.** t3code's model therefore *cannot* satisfy "each of N repos a
conversation touches gets its own worktree." To support that, the binding must
be **per source directory** and applied **per path** (route each path to the
worktree of the repo that contains it), not as one session-wide cwd. That is the
one place we deliberately go beyond t3code — everything else (create via
`git worktree add`, a `juggler/conv-<id>` branch, sibling-ish worktree dirs) is
the same idea.

## What an extension can and cannot do today

An extension contributes capabilities through `web/sdk/` (see
`docs/extension_guide.md`): Context Items (tools), Strategies (shape the loop),
Commands, and a system-prompt contribution. A Context Item can *run*
`git worktree add` (it calls `shell`), and a Strategy owns per-conversation
lifecycle (`onActivate`) and path influence (`defaultAllowedPaths`) — but **none
can change where a conversation's *subsequent* ops execute.** Every
file/shell/search/tree op reaches Go and resolves against one process-global
project root (`ops.PathScope` rooted at `Server.ProjectPath()`). That is the
wall: there is no extension-facing way to say "for this conversation, run ops on
this path under a different root." So "elegant way via the current API" isn't
possible — we need the new abstraction.

## The abstraction: per-(conversation, source) workspace bindings

Core provides only:

1. **A path remap on `ops.PathScope`.** `WithRemap(fn)`: paths are still
   *validated* in real-project space (the security boundary is unchanged), then
   the resolved path is *redirected*. `file_ops` needs zero changes;
   search/tree/shell inherit it.
2. **A registry + bind API.** `server.WorkspaceRegistry` maps
   `(convID, sourceRoot) → workspaceRoot` (policy-free — core never learns what
   the roots *are*). A path is routed to the workspace of the **longest-prefix**
   bound source that contains it, so a repo and its nested repo each map to their
   own worktree; a path under no bound source is untouched. Endpoints:
   `POST /api/workspace/{bind,unbind}`.
3. **SDK surface.** `juggler/ops` exports
   `bindWorkspace(convId, sourceRoot, workspaceRoot)` / `unbindWorkspace(convId,
   sourceRoot?)`.
4. **A lifecycle module (NOT a Strategy).** See below.

The worktree **policy** — discovering the repos under the project, creating a
worktree per repo, naming branches, teardown — lives entirely in an extension
(`examples/extensions/juggler-worktrees/`). Core stays ignorant of git; it only
does prefix routing over bindings the extension supplies.

## Driven by a lifecycle module, not a Strategy

Worktrees are **not** a Strategy. A Strategy governs *loop autonomy* — read-only
vs. default vs. yolo — and a conversation has exactly one (`currentStrategyId`,
one `strategy-selector`). "Where the work physically happens" is **orthogonal**:
you might want a yolo worktree, a read-only worktree, or yolo with no worktree at
all. Bundling worktrees into a Strategy would consume the single strategy slot
and force "isolated" and "yolo/read-only" to be one choice — a category error.

So the driver is a lightweight **lifecycle module**, the same "plain module the
host loads and calls" shape as the existing `systemPrompt` contribution — *not* a
new capability type with its own selector. Chosen over a full capability type
because per-**project** opt-in is enough here (see the "Axis shape" discussion in
Open questions): a capability type would add a registry, a `currentEnvironmentId`,
selection-keyed dispatch, and a selector UI, none of which per-project opt-in
needs.

- Manifest `provides.lifecycle: "lifecycle.js"` (a single module path, like
  `systemPrompt`). SDK contract: `juggler/lifecycle` (`web/sdk/lifecycle.js`,
  JSDoc typedefs only).
- Default export = a hooks object the host invokes per conversation:
  `onConversationActivated(ctx)` (discover repos + `bindWorkspace` per repo),
  `onConversationDeleted(ctx)` (remove worktrees + `unbindWorkspace`). The delete
  hook is the real conversation-teardown signal.
- Host loader: `runExtensionLifecycleHook(hook, ctx)` in
  `web/js/services/extensions.js`, mirroring `buildExtensionSystemPromptContributions`.
- **Opt-in is per project** — enabling the extension applies it to every
  conversation in the project. It stays orthogonal to Strategy, so it composes
  with any autonomy level.

```mermaid
flowchart LR
  conv["Conversation"]
  subgraph axes["orthogonal, independent"]
    strat["Strategy (autonomy)<br/>read-only · default · yolo · per-conversation"]
    env["Lifecycle module (where)<br/>worktree · devcontainer …· per-project (enable ext)"]
  end
  conv --> strat
  conv --> env
  strat -->|"filterTools · approvalPolicy"| loop["agentic loop"]
  env -->|"bindWorkspace → WithRemap"| root["execution root(s)"]
  note["e.g. {yolo} × {worktree}, or {read-only} × {no worktree} — any combination"]:::n
  axes -.-> note
  classDef n fill:#efe,stroke:#6a6,color:#060;
```

### Before — every conversation resolves at the one project root

```mermaid
flowchart TD
  subgraph engine["Engine (JS)"]
    ext["Extension capability"]
    ops["juggler/ops (readFile · shell …)"]
    ext --> ops
  end
  subgraph server["Server (Go)"]
    opsapi["/api/ops/call"]
    scope["ops.PathScope · root = ProjectPath()"]
    opsapi --> scope --> fsops["file/search/tree/shell ops"]
  end
  ops --> opsapi
  fsops --> root[("Project root · repoA + repoB")]
  convA["Conversation A"] --> ext
  convB["Conversation B"] --> ext
  root -.-> note["Both conversations, all repos, resolve at the SAME root → collisions"]:::n
  classDef n fill:#fee,stroke:#c66,color:#600;
```

### After — an extension binds one workspace per repo; core routes by longest prefix

```mermaid
flowchart TD
  subgraph engine["Engine (JS)"]
    env["Worktree LIFECYCLE MODULE (extension) · onConversationActivated()"]
    shellop["shell: discover repos + git worktree add (per repo)"]
    bind["bindWorkspace(convId, repoRoot, worktreeRoot) · once per repo"]
    ops["juggler/ops (later tool calls)"]
    env -->|"1 create"| shellop
    env -->|"2 bind each"| bind
  end
  subgraph server["Server (Go)"]
    wsapi["/api/workspace/bind"]
    reg["WorkspaceRegistry<br/>(convID, sourceRoot) → workspace<br/>longest-prefix routing (policy-free)"]:::core
    opsapi["/api/ops/call"]
    scope["PathScope.WithRemap · validate real · redirect exec"]:::core
    wsapi --> reg
    opsapi -->|"remapperFor(convID)"| reg
    opsapi --> scope --> fsops["file/search/tree/shell ops"]
  end
  bind --> wsapi
  ops -->|"conversationId + params"| opsapi
  fsops --> wtA[("worktree of repoA · conv-A")]
  fsops --> wtB[("worktree of repoB · conv-A")]
  classDef core fill:#eef,stroke:#66c,color:#006;
```

### Runtime sequence — the worktree lifecycle module (multi-repo)

```mermaid
sequenceDiagram
  participant W as Worker
  participant X as Worktree module
  participant S as Server ops+workspace
  participant G as git

  W->>X: onConversationActivated convId
  X->>S: shell — discover repos + git worktree add, at project root
  S->>G: worktree add -b juggler/conv-ID wtA HEAD  [repoA]
  S->>G: worktree add -b juggler/conv-ID wtB HEAD  [repoB]
  S-->>X: stdout — repoA TAB wtA, repoB TAB wtB
  loop per repo
    X->>S: POST /api/workspace/bind convId, sourceRoot, workspaceRoot
    S->>S: WorkspaceRegistry.Bind
  end
  X-->>W: activation resolves
  Note over W,S: later tool calls carry conversationId
  W->>S: /api/ops/call — convId, path repoB/x.go
  S->>S: WithRemap longest-prefix repoB to wtB/x.go
  S-->>W: op runs inside repoB worktree
```

## Changes to the existing extension API

The extension-facing surface — the part the `engineApi` semver in
`web/sdk/version.js` promises, i.e. the `juggler/*` module exports and the
manifest `provides` schema — gains **three small, additive changes**. All are
backward-compatible: no existing export, capability type, or manifest field is
changed or removed, so every extension that exists today keeps loading and
running unchanged.

**1. Manifest: new optional `provides.lifecycle`.** A single module path (not a
glob), exactly mirroring the existing `provides.systemPrompt`.

```jsonc
// before — a valid manifest today
{ "id": "@you/ext", "name": "…", "version": "1.0.0", "engineApi": "^1.0.0",
  "provides": { "contextItems": ["context-items/*-context-item.js"] } }

// after — the new field an extension MAY add (nothing else changes)
{ "id": "@you/ext", "name": "…", "version": "1.0.0", "engineApi": "^1.1.0",
  "provides": { "lifecycle": "lifecycle.js" } }
```

Parsed/validated by `extmanifest.Provides.Lifecycle` (`cmd/juggler/extmanifest`)
and expanded to a served URL by `handlers/extensions.go`
(`ExtensionCapabilities.Lifecycle`).

**2. New SDK module `juggler/lifecycle`** (`web/sdk/lifecycle.js`) — JSDoc
typedefs only (`LifecycleModule`, `LifecycleContext`, `LifecycleDeleteContext`),
added to the import map in `web/index.html` and `web/engine.html`. A lifecycle
module's `export default` is a `LifecycleModule` (hooks object). No new base
class — it follows the plain-module shape of a `systemPrompt` contribution.

**3. New `juggler/ops` exports: `bindWorkspace` / `unbindWorkspace`.** The only
new *callable* API. Everything else a lifecycle module needs (`shell`, …) is
already exported.

**Version impact.** These are all covered-surface additions, so the host SDK
`ENGINE_API_VERSION` bumps **minor**: `1.0.0 → 1.1.0` (`web/sdk/version.js`).
Because it is additive, extensions declaring `engineApi: "^1.0.0"` still satisfy
a 1.1.0 host; an extension that *uses* the lifecycle capability should declare
`engineApi: "^1.1.0"` so an older host rejects it with a clear diagnostic rather
than a missing-import failure.

**Docs.** `docs/extension_guide.md` gains a short "Lifecycle module" entry
(capability table row + one example) alongside the existing capabilities.

**NOT part of the extension API** (internal core, outside the `engineApi`
promise — extension authors never touch these): `WorkspaceRegistry` and its
`.juggler/workspaces.json` persistence, `PathScope.WithRemap`, the
`POST /api/workspace/{bind,unbind}` and `GET /api/workspace/orphans` transport,
the `runExtensionLifecycleHook` host loader, and the `conversationId` threading
on tool calls. They are how the primitive is implemented, not how an extension
uses it.

## Persistence & cleanup across restarts

Worktrees are durable on-disk resources, so their cleanup must survive a
shutdown — a conversation deleted while the server is down, or a teardown that
never completed, must not leak a worktree forever. The bindings are therefore
**persisted**, not just in-memory:

- `WorkspaceRegistry` writes `(convID → source → workspace)` to
  `<project>/.juggler/workspaces.json` (atomic rewrite on every bind/unbind,
  loaded on construction). So a restart reloads the bindings — the remap keeps
  working, and core retains the record of which conversations own worktrees.
- **Orphan sweep on project open.** Core compares the persisted bindings against
  the conversations that still exist — active (`ConvNames`) plus binned
  (`ListBinnedConversations`, so a restorable conversation is never swept). Any
  binding whose conversation exists in neither is an **orphan** (permanently
  deleted, possibly during downtime) and is surfaced at
  `GET /api/workspace/orphans`. The lifecycle module drains it on project open,
  running its `onConversationDeleted` teardown per orphan, then unbinding (which
  rewrites the persisted file). The extension's teardown re-derives worktree
  paths from the conversation id, so it works even if a binding is stale.

Net effect: at every project open, worktrees belonging to conversations that no
longer exist are cleaned up, regardless of how or when they were deleted.

## How the pieces map to code

| Concern | Location | Policy? |
|---|---|---|
| Execution-root remap | `ops/validation.go` — `PathScope.WithRemap`/`BaseDir`/`Remap`/`ResolveReal` | core, policy-free |
| Ops honour the remap | `ops/{search,tree,shell}_ops.go`, `server/handlers/ops_api.go` | core |
| conversationId on tool calls | `web/sdk/context-item.js` `_withConv`, `web/js/services/ops-api.js`, `fs.js`, per-tool call sites | core |
| Registry (`(conv, source)→workspace`, longest-prefix) + persistence (`.juggler/workspaces.json`) + orphan detection | `server/workspace_registry.go` | core, policy-free |
| Bind API + orphan listing | `server/workspace_api.go`, `POST /api/workspace/{bind,unbind}`, `GET /api/workspace/orphans` | core |
| Bind SDK | `web/sdk/ops.js` (`bindWorkspace`/`unbindWorkspace`) | core |
| **Lifecycle module** | manifest `provides.lifecycle` (`extmanifest.go`) + served URL (`handlers/extensions.go`); SDK contract `web/sdk/lifecycle.js`; host loader `runExtensionLifecycleHook` (`web/js/services/extensions.js`) | core |
| **Worktree policy (discover repos, worktree each, bind each)** | `examples/extensions/juggler-worktrees/lifecycle.js` | **extension** |

### Remaining wiring (WIP)

The core mechanism, persistence, orphan detection, the manifest field + served
URL, the SDK `juggler/lifecycle` contract, and the host loader
`runExtensionLifecycleHook` are done and verified. What remains needs the running
engine — three well-located call sites into `runExtensionLifecycleHook`:

1. **`onConversationActivated`** when the engine first activates a conversation.
2. **`onConversationDeleted`** on a live delete.
3. **Orphan sweep on project open:** `GET /api/workspace/orphans`, then
   `onConversationDeleted` per orphan, then `POST /api/workspace/unbind`.

The substrate exists — the engine already receives conversation `created`/
`deleted` (`conversations-changed`, handled in `web/js/engine-app.js`) and a
project-load signal — so these are small additions, left out here only because
they can't be exercised without the live engine.

## Alternatives considered

- **On the Strategy axis (PR #54 v1–v2).** Rejected: Strategy is single-select
  (loop autonomy), so a "Worktree strategy" steals the slot you'd use for
  read-only/default/yolo. Worktrees are orthogonal to autonomy — they must be
  their own axis.
- **A single per-conversation root (t3code-style).** Rejected: a single session
  cwd cannot express >1 repo per conversation.
- **A full `Environment` capability type** (own manifest kind, registry,
  `currentEnvironmentId`, selector UI, selection-keyed dispatch). Correct axis,
  but heavier than needed once per-**project** opt-in is accepted.
- **Chosen: a lightweight lifecycle module** (`provides.lifecycle`) driving
  per-(conversation, source) `bindWorkspace` with longest-prefix routing.
  Orthogonal to Strategy, supports multi-repo, per-project opt-in, and reuses the
  established plain-module (`systemPrompt`) loading pattern — the least new
  surface. The same module shape serves devcontainer / remote / sandbox.

## Open questions for maintainers

### 1. Axis shape — full capability type, or a lighter lifecycle module?

**Decision (this PoC): the lifecycle module (b), with per-project opt-in.** The
options below are kept for the record; all drive the *same* core remap
(`bindWorkspace` + `WorkspaceRegistry` + `WithRemap`) and differ only in
packaging and opt-in granularity. Revisit (a)/(c) if per-conversation selection
is later wanted.

Both drive the *same* core remap; they differ only in how the extension is
packaged and how a conversation opts in. Three points on the spectrum:

**(a) Environment capability type.** Manifest `provides.environments`,
a registry, per-conversation `currentEnvironmentId`, an `environment-selector`
UI, and selection-keyed worker→engine dispatch. Heaviest, but gives a
first-class, per-conversation, user-visible mode.

**(b) A lifecycle-subscriber module (chosen — lighter, feasible today).** Modelled
on the existing `provides.systemPrompt`, which is already a *plain module* (not a
class) the host loads and calls. `provides.lifecycle: "lifecycle.js"` whose
default export is a hooks object the engine invokes:

```js
export default {
  async onConversationActivated({ conversationId, projectRoot, shell, bindWorkspace }) { /* worktree + bind */ },
  async onConversationDeleted({ conversationId, unbindWorkspace }) { /* teardown */ },
};
```

The substrate exists — the engine already receives conversation `created`/
`deleted` (`conversations-changed`). This **drops the selector UI,
`currentEnvironmentId`, and selection-keyed dispatch** — genuinely lighter.

**The one real tradeoff is opt-in granularity, not code size.** A subscriber
fires for *every* conversation, so on its own it means **per-project** opt-in
(enable the extension / a config flag) rather than **per-conversation** — which
loses "isolate these tabs but not that one." So:
- If "all conversations in this project run in worktrees" is acceptable → the
  lifecycle module is strictly lighter and sufficient.
- If per-conversation choice with a selector is wanted → you need roughly (a).

**(c) Hybrid (per-conversation, still no capability type).** A `/worktree`
*command* whose only side-effect is the (legitimate, declarative)
`setConversationMetadata` — it just sets a per-conversation flag — plus a
lifecycle module (b) that reads that flag in `onConversationActivated` and binds.
This keeps per-conversation opt-in while reusing Commands + a lifecycle module,
avoiding a new capability type and a bespoke selector. Slightly less discoverable
than a first-class selector.

A `Command` alone cannot do it: commands are viewer-side and declarative
("never perform these operations directly — declare intent, the host
dispatches"), so they can't call `shell`/`bindWorkspace` themselves.

Recommendation: if per-conversation opt-in matters, **(a)** or **(c)**; if
per-project is fine, **(b)** is the least new surface. All three reuse the core
remap unchanged.
### 2. Teardown & persistence — resolved

Bindings are now **persisted** to `<project>/.juggler/workspaces.json` (see
"Persistence & cleanup across restarts"), so they survive a restart and a
conversation deleted while down is swept as an orphan on the next project open.
The remaining sub-decision is only the default worktree-cleanup **policy**: the
sample removes a worktree only if it is clean (`git worktree remove` without
`--force`), keeping any with uncommitted work; prune-if-clean vs. keep-always vs.
prompt is a taste call left to the extension.

### 3. Repo discovery cost

The sample discovers repos eagerly with a bounded `find` on activation. A lazy
"bind on first touch of an unbound repo" model would avoid worktrees for
untouched repos but needs a core→extension callback on an unmatched path — a
larger surface. Eager is fine for a first cut.

## Status

WIP proof-of-concept. Verified locally on Go 1.26 + real WebKit: core builds,
`go vet` and `golangci-lint` clean, the registry (incl. the multi-repo
longest-prefix case) and an end-to-end ops remap are unit-tested, and the JS
passes `tsc` + `eslint`. The live engine↔worker path for the sample strategy is
exercised by CI, not locally.
