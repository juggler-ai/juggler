<!--
  ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
  ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
SPDX-License-Identifier: Apache-2.0
-->

# Regenerating `corpus.js`

`corpus.js` in this folder is the reference manual the **AboutJuggler** tool
returns when a user asks about Juggler itself. It is **generated from repo
source, not hand-maintained** — so when Juggler's tools, shortcuts, commands,
providers, or config layout change, regenerate it instead of patching prose.

Hand this whole file to an LLM (Juggler itself, ideally) with access to the
`juggler/` source tree. It should read the source-of-truth files below, then
rewrite `corpus.js` so every factual section matches what the code actually
declares today.

## Hard rules

1. **Ground every claim in the source files listed below.** If the source does
   not support a statement, cut it — never invent behaviour, telemetry claims,
   provider names, or shortcuts.
2. **Only `corpus.js` changes.** Keep it a single ES module that
   `export default`s one markdown string, with the existing Apache-2.0 header.
3. **No backtick characters inside the string.** The corpus is a JS template
   literal, so backticks would break it. Use plain text or single quotes for
   paths and commands (e.g. write ~/.juggler/credentials.json, not a code span).
   For a multi-line code sample, use a 4-space-indented block (markdown renders
   it as code) rather than a triple-backtick fence, and never use a JS template
   literal inside the sample. Any backslash the rendered markdown must show
   (e.g. a regex like /\s+/) has to be DOUBLED in this source (write /\\s+/), or
   the template literal will swallow it.
   Preserve the two placeholder tokens verbatim — `{{KEYBOARD_SHORTCUTS}}` and
   `{{LOG_LOCATION}}`. The tool substitutes these at call time with text rendered
   for the live session's platform. Do NOT hard-code a keyboard-shortcut table or
   a single platform's log path into the base — the base is generic and
   cross-platform; platform-specifics are injected. (Shortcuts with no modifier,
   like Shift+Tab for the strategy switcher, are platform-neutral and may be
   named in prose.)
4. **Keep it sensibly sized** — a scannable manual (roughly 150–280 lines of
   markdown), not an exhaustive dump. Prefer the user-facing shape of a feature
   over implementation detail. The one deliberate exception to "user-facing
   shape over detail" is the "Writing an extension" quickstart (the ext CLI, a
   minimal manifest, and a minimal context-item example): keep it, because it is
   the only extension-authoring content that works for a user who has just the
   app and no repo checkout.
5. **Audience is the model at runtime**, answering an end user. Factual and
   terse; no marketing.

## Source-of-truth files (read these, then write the sections)

Paths are relative to the `juggler/` repo root.

- **What Juggler is / core concepts** — `README.md` (the product one-liner and
  the TL;DR bullets: GUI, session-as-tree/Yjs, visibility, plugins, local+remote).
- **Tools** — `web/extensions/juggler-core/context-items/*-context-item.js`. Each
  file's `getToolDefinitions()` returns the tool `name` + `description`; the
  `MANIFEST.id` is the capability id. List the user-facing tools (skip internal
  items that expose no tool, e.g. `file-content`, `system-prompt`, `dropped-file`).
  Cross-check tool names against the alias map in
  `web/js/services/tool-generator.js`.
  **Two kinds of file declare a tool, and a grep for `getToolDefinitions` finds
  only the first.** Sub-agent tools (`Explore`, `Research`) extend
  `SubagentContextItem` and declare themselves through a `static SUBAGENT`
  descriptor instead, taking the tool name from `MANIFEST.name`. Enumerate the
  directory and account for every file, rather than matching on one method name —
  that is exactly how `Explore`, `Research`, `skill`, `new_conversation` and
  `pin_to_pinboard` all came to be missing from the manual at once.
- **Strategies** — `web/extensions/juggler-core/strategies/*-strategy-type.js`
  (each declares `id`, `name`, `description`). Not every file in that directory
  is a strategy — `auto-approve-reviewer.js` is a helper of one.
- **Slash commands** — `web/extensions/juggler-core/commands/*-command-type.js`
  (each declares `id` and a `description`).
- **Workspaces** — a workspace is the place a conversation's tools run in. The
  user-facing shape is: the providers in
  `web/extensions/juggler-core/workspaces/*-workspace-provider.js` (each
  `static MANIFEST` gives `id`, `name`, `description` and a `recommendations`
  block written for exactly this purpose), the boxes in the tab strip
  (`web/js/components/workspace-box-header.js`), and the panel a selected box
  opens (`web/js/components/workspace-panel.js`, whose header comment states
  what belongs to the box and what belongs to the tab). Describe binding
  (several conversations to one workspace), the per-box `+`, moving a
  conversation with "Use a different workspace…", and finishing a workspace.
  Say where workspaces come from, because users go looking for a hardcoded list
  and find the wrong one: providers are extension-declared
  (`provides.workspaceProviders` in a manifest — no rebuild), while the kinds
  registered in `cmd/juggler/ops/workspace_kinds.go` (where operations run) are
  compiled in, and today hold only the local machine.
  Do NOT describe the provisioning state machine or the rebinding internals.
- **Agent Skills** — `cmd/juggler/core/skills.go:19-38` documents the
  format and the four discovery roots (project and user scope, each with a
  `.juggler` native path and a `.agents` cross-agent alias). The `skill` tool
  loads one body on demand; the list is metadata only.
- **Keyboard shortcuts** — do NOT transcribe these into the base. The tool
  generates the table live from `SHORTCUT_DEFS` in
  `web/js/services/key-shortcut-manager.js` and drops it in at the
  `{{KEYBOARD_SHORTCUTS}}` token, formatted per platform. Just keep the token and
  the surrounding sentence noting bindings are customisable.
- **Log location** — do NOT transcribe. The tool injects the platform's real log
  directory (mirrored from `internal/logpaths/logpaths.go`) at the
  `{{LOG_LOCATION}}` token. If those Go paths change, update the `logLocationFor`
  table in `context-items/about-juggler-context-item.js`, not the base corpus.
- **Model providers** — the directories under `cmd/juggler/providers/`. **Do not
  infer the list from directory names.** A user-facing provider is one whose
  package sets a `DisplayName`, and that string is the name to print — grep
  `DisplayName:` across `cmd/juggler/providers/*/*.go` (skipping `_test.go`) and
  use what it says. The packages carrying no `DisplayName` are shared
  infrastructure and must not be listed as providers: `openaibase`, `provider`,
  `utils`, `audit` (cross-provider catalog checks, no production code) and
  `streamidle` (a timeout setting). The one exception is `customprovider`, which
  has no fixed `DisplayName` because it is the user's own named endpoints — any
  number of gateways, tenants, regions or local servers, each appearing as its
  own provider (`customprovider/config.go:5-20`). Mention that capability; do not
  invent a name for it.
- **Configuration & data locations** — `docs/config-directory.md` (the
  `~/.juggler` layout, durable-vs-cache split, and that logs live elsewhere);
  `docs/memory.md` for the project-level `.juggler/MEMORY.md`. That doc does not
  list every file: `custom-providers.json` is durable per-user state
  (`customprovider/config.go:83-90`) and user-scope skills live at
  `<config>/skills/`. Prefer the doc for the shape and the source for the
  inventory.
- **Extensions** — `web/extensions/*/juggler.extension.json` for the built-in
  extension ids/names (@juggler/core, @juggler/mcp, and this @juggler/about);
  `cmd/juggler/server/handlers/extensions.go` for how embedded vs user
  (`~/.juggler/extensions/`) extensions are discovered.
- **Writing an extension (the quickstart section)** — ground it in
  `docs/extension_guide.md`: the `juggler ext init|validate|link|add` CLI
  (`cmd/juggler/app/ext.go` is the implementation), the anatomy (manifest +
  suffix-named capability files), the manifest field table, and the minimal
  context-item example (the WordCount sample). Keep the required/recommended
  manifest fields matching the guide.
  **The capability list is the part that rots: never write a count ("there are
  six capability types") and never copy the list from the previous corpus.**
  Take it from `TYPE_TO_KEY` in `web/js/services/extensions.js` — the map the
  host actually loads by — cross-checked against `provides` in
  `web/extensions/juggler-core/juggler.extension.json` for the glob conventions
  and against the `Provides` struct in `cmd/juggler/extmanifest/extmanifest.go`
  for the manifest key names. `pinboard-item-meta` is a companion file of
  `pinboard-item`, not a capability written on its own. Also keep
  the `outcome.result` gotcha — the guide calls it "the single most common
  mistake." This @juggler/about extension ALSO ships a second tool,
  **ReadJugglerSource** (`context-items/juggler-source-context-item.js`), that
  same-origin-fetches the app-served SDK/example sources; the corpus tells the
  model to use it. If you rename that tool or change the paths it allows (today:
  anything under `sdk/` or `extensions/`), update the corpus prose to match.
- **Source code and deeper documentation** — the corpus ends with a section
  linking the public repo and its docs so the model can dive deeper (especially
  for writing extensions). Keep it grounded: the repo URL is
  `https://github.com/juggler-ai/juggler` (confirm against `git remote -v` and the
  root `README.md`), and every repo-relative path you cite must actually exist —
  the deep-dive targets are `docs/extension_guide.md`, the SDK base classes under
  `web/sdk/`, the example extensions under `web/extensions/`, and the other
  `docs/*.md`. List the base classes and the docs by enumerating those two
  directories rather than from memory — one base class per capability in
  `TYPE_TO_KEY` (including `workspace-provider.js`), and every `docs/*.md` that
  is useful to an end user. Prefer repo-relative paths plus one example
  `blob/<default-branch>` URL over hand-writing a full URL per file (branch
  names drift).
- **Updates/connectivity** — `internal/updatecheck/` confirms the update check;
  keep connectivity claims conservative and true (LLM calls go to the configured
  provider; WebFetch/WebSearch reach requested sites; version check runs). Do not
  assert "no telemetry" unless the source supports it.

## After regenerating

Check the corpus against the source **by counting both sides**, not by reading
the corpus and finding it plausible. Each of these has been wrong before:

| Count in the corpus | Must equal |
|---|---|
| tools | files in `juggler-core/context-items/` that declare a tool (both kinds — see Tools above) |
| strategies | `*-strategy-type.js` in `juggler-core/strategies/` |
| slash commands | `*-command-type.js` in `juggler-core/commands/` |
| model providers | packages under `cmd/juggler/providers/` with a `DisplayName`, plus custom endpoints |
| capability types | entries in `TYPE_TO_KEY`, less `pinboard-item-meta` |
| workspace providers | `*-workspace-provider.js` in `juggler-core/workspaces/` |
| `web/sdk/` files cited | one per capability type |

- Verify the string still parses (no stray backticks; balanced template literal).
- Build the app so the new extension asset is embedded and served — from the
  parent repo run `make build` (per the parent's build convention), or build the
  core standalone if working in the submodule directly.
- Sanity-check by asking a running Juggler a question like "what keyboard
  shortcuts do you have?" and confirming the AboutJuggler tool fires and answers
  from the refreshed corpus.
