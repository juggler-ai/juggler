//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The "About Juggler" corpus — a self-contained reference manual describing the
 * Juggler application itself. It is returned verbatim by the AboutJuggler tool
 * when the user asks about Juggler (its features, tools, shortcuts, config, etc.).
 *
 * COST MODEL: this string never enters the model's context until the tool is
 * actually called, so it costs zero tokens on a normal turn. When the extension
 * is disabled, the tool disappears and this module is never loaded.
 *
 * STRUCTURE: this is the GENERIC, cross-platform base manual. It is not the
 * whole answer — the AboutJuggler tool fills two placeholders at call time with
 * text derived from the live session's platform, so the manual reads correctly
 * on the machine it is describing:
 *   - {{KEYBOARD_SHORTCUTS}} — the current shortcut table, each binding rendered
 *     for the platform (⌘J on macOS, Ctrl+J on Windows/Linux), from the app's
 *     own SHORTCUT_DEFS (so it can never drift from the real key map).
 *   - {{LOG_LOCATION}} — the platform's actual log directory.
 * Keep these tokens intact when regenerating; never hard-code a shortcut table
 * or a single platform's paths into this base.
 *
 * MAINTENANCE: this file is generated, not hand-edited section by section. When
 * Juggler's tools/commands/providers change, regenerate the whole corpus from
 * repo source using the prompt in ./REGEN-CORPUS.md so it never drifts from
 * reality. Keep it grounded in real repo facts — no speculation.
 * @module about-juggler/corpus
 */

/** @type {string} The full About-Juggler reference manual (markdown). */
const CORPUS = `# About Juggler

This is Juggler's own reference manual — factual information about the Juggler
application itself. Use it to answer questions about what Juggler is, how it
works, and how to drive it. It does not describe the user's own code or project.

## What Juggler is

Juggler is a local-first AI coding agent with a graphical workbench UI. Its
angle is hands-on control: instead of a scrolling chat transcript, it gives you
an inspectable, navigable view of everything the model is doing to your codebase.

Distinguishing ideas:

- **It is a proper GUI**, not a console app — graphical navigation, inspection,
  and control throughout.
- **The session is a tree, not a doom-scroll.** A conversation is a Yjs document,
  not a flat transcript: you can branch sub-threads, drill down, backtrack,
  compare, and edit context items directly.
- **Everything important is visible.** Tool calls, approvals, thread structure,
  item properties, and raw context are laid out in Finder-style Miller columns.
- **It is plugins all the way down.** Context items (tools), slash commands, LLM
  loop strategies, workspaces, and their UIs are JavaScript extensions you can
  inspect, fork, or replace.
- **It runs locally, remotely, or both at once.** The same session, with the same
  UI, is reachable from the native desktop app and/or a browser; multiple clients
  can attach to one session simultaneously.

## Core concepts

- **Conversation / session** — a Yjs document holding the whole tree of messages,
  threads, and context items. Because it is a CRDT document, multiple attached
  clients stay in sync and edits are non-destructive.
- **Threads** — sub-conversations branched off a point in the tree. Use them to
  explore a tangent, delegate a self-contained sub-task, or compare approaches
  without polluting the main line.
- **Context items** — the typed units that make up context: files, tool calls,
  memory, the system prompt, dropped files, and so on. Each is a plugin with its
  own UI, and each tool the model can call is backed by a context-item type.
- **Strategies** — pluggable LLM-loop policies that steer the model by gating
  which tools are available and injecting guidance, without changing the cached
  system prompt.
- **Workspaces** — the place a conversation's tools actually run in: the project
  folder itself, or somewhere made for the purpose, such as a git worktree or a
  throwaway copy. Several conversations can work in one workspace. A group is a
  workspace that only organises conversations. See below.
- **Pinboard** — a tabbed panel behind the right edge of the window, opened with
  the edge tab or its shortcut. Each tab is a "pin" supplied by an extension. The
  built-in ones keep a live file within reach, follow the current plan, todo list
  and project memory, review the git working tree, and list running background
  tasks. Plan and Todo show the list belonging to the thread you are reading,
  falling back to the nearest parent that has one; both are read-only, since those
  lists change through their tools. Git is where changes are reviewed: every
  repository under the project with its branch, its drift from upstream, and every
  changed file with its whole diff against HEAD, comments written onto the lines
  they are about, and one action that sends them all to the conversation as a
  message. It is git that is read, so a change made by a shell command, a
  formatter or by hand is there like any other. Background tasks is a live
  inventory rather than a history: a command appears while it runs and is gone
  once it ends, each row offering a Stop and a way back to the action that started
  it. Pins belong to the project session, so every viewer sees the same board. A
  pin is only a view: unlike a context item, pinning a file shows it to you and
  not to the model. An HTML file is shown as the page it describes, wherever a
  file is displayed (a pin, a read or write result, a dropped file): it runs in a
  sandboxed frame that cannot reach Juggler itself, with a Source button for the
  markup. A partial read, or a file the server will not serve, is shown as source.
  So the agent can show you a report or mock-up by writing it to an HTML file in
  the project and pinning it.

## Tools the agent can use

Tool availability depends on which extensions/plugins are enabled; the built-in
core provides:

- **read** — read a file (preferred over cat/head/tail).
- **write** — create or overwrite a file.
- **edit** — exact-string replacement in a file.
- **grep** — content search built on ripgrep (regex, globs, file-type filters).
- **glob** — find files by name pattern.
- **bash** — run a shell command; supports long-running background processes.
- **query_code** — run reads/greps/globs inside one sandboxed JavaScript call
  and return only the computed value, keeping intermediate output out of context.
- **batch_read / batch_grep** — read or search several files in one call.
- **WebFetch** — fetch a URL and convert it to markdown (with a short cache).
- **WebSearch** — web search returning titles, URLs, and descriptions.
- **create_thread** — run a self-contained sub-task in an isolated sub-conversation
  whose intermediate steps stay out of the parent context.
- **new_conversation** — open a new, independent conversation seeded with a first
  message. Unlike create_thread it is a peer, not a sub-task: it works in its own
  tab and never reports back.
- **Explore** — investigate the codebase in a read-only sub-agent, which reads as
  many files as it needs and returns only what it found.
- **Research** — answer a question from the web in a sub-agent, which reads as
  many pages as it needs and returns only the answer.
- **Monitor** — stream lines from a long-running command as events.
- **TaskOutput / TaskStop (KillShell)** — read new output from, or stop, a
  background task.
- **todo** — track a lightweight, no-approval checklist during multi-step work;
  each call replaces the whole list.
- **plan** — propose an approval-gated implementation plan for user review, then
  track its execution step by step.
- **memory** — record or remove durable, cross-session project facts.
- **skill** — load an Agent Skill: a specialised instruction set for a kind of
  task (see below).
- **pin_to_pinboard** — attach something to the Pinboard and bring it into view.
- **AskUserQuestion** — ask the user a structured multiple-choice question.
- **define_command** — save a reusable prompt as a custom "/name" slash command;
  the user approves the full definition before it is created.

The About Juggler extension adds two more: **AboutJuggler** (this manual) and
**ReadJugglerSource** (the app's own SDK and example-extension source).

## Strategies

- **Default** — standard general-purpose coding-assistant behaviour.
- **Auto-approve** — like Default, but a cheap model auto-approves the routine
  prompts it is sure are safe, so you are only asked about the risky ones.
- **Read-only** — any action that could change files is automatically refused;
  useful for safe exploration and review.
- **YOLO** — auto-approves every tool call. Fast but unguarded; use at your own
  risk.

Switch the active strategy with the strategy switcher (default shortcut Shift+Tab;
hold to open the strategy menu).

## Slash commands

Type "/" in the composer to run a command against the current conversation. The
built-in commands are:

- **/new** — open a new, empty conversation.
- **/duplicate** — clone the current conversation into a new one.
- **/clear** — clear the conversation's messages.
- **/compact** — compact the whole conversation into a summary thread.
- **/handoff** — summarise this conversation into a new one to continue work.
- **/thread** — create a new sub-conversation thread.
- **/commands** — open the manager for creating and editing custom commands.

### Custom slash commands

You can define your own "/name" commands without writing code. A custom command
is a markdown file — YAML frontmatter (description, run mode, and a few options)
over a prompt template — that Juggler turns into a real menu command and
hot-reloads the moment you save. Placeholders in the template expand from what
you type after the command: "$1".."$9" for positional arguments, "$ARGUMENTS"
for everything after the command name exactly as typed (line breaks and all),
and "$$" for a literal dollar sign.

There are three ways to create one, all writing the same file: type a name that
does not exist yet (the menu offers a "New command…" row that opens the editor),
use "/commands", or ask the assistant to save a workflow as a command (it calls
the define_command tool and you approve the full definition first). A command
runs in one of three modes: send it immediately, insert it into the composer as
an editable draft, or run it in an isolated sub-thread (which can use its own
strategy or model).

Custom commands are stored as markdown files in two scopes:
"~/.juggler/commands/" (yours, across all projects) and
"<project>/.juggler/commands/" (shared through the project's git repository). A
project command shadows a user command of the same name, but neither can override
a built-in. For commands that need real code, write an extension instead. See
docs/custom-commands.md.

## Agent Skills

A skill is a folder of instructions for a kind of task, following the open Agent
Skills standard (agentskills.io): a SKILL.md of YAML frontmatter plus markdown,
optionally alongside scripts/, references/ and assets/. Juggler lists every
skill's name and description cheaply, and the model loads one body on demand with
the skill tool — so a skill costs nothing until a task matches it.

They are discovered in four places, two scopes each with a native path and a
cross-agent alias, so a skill written for another agent still loads:

- "<project>/.juggler/skills/<name>/SKILL.md"
- "<project>/.agents/skills/<name>/SKILL.md"
- "<config>/skills/<name>/SKILL.md" (that is "~/.juggler/skills/" by default)
- "~/.agents/skills/<name>/SKILL.md"

Files inside a skill are read through the ordinary read and bash tools under
normal approval, so a skill adds no new execution or file-access path.

## Workspaces

A workspace is where a conversation's tools run — where bash executes, and what
read, write and edit are relative to. Every project already has one: itself. The
others are made by workspace providers, and the built-in ones are:

- **Group** — a named box to keep related conversations together, and nothing
  else: conversations in a group work in the project exactly as they would
  outside it, and nothing is created on disk. It is first in the list the "New
  workspace or group" button opens. Ungrouping puts its conversations back in
  the project; deleting it sends them to the Bin.
- **Git Worktree** — another branch of the repository, checked out in a tree of
  its own. Best for work on a branch that should not disturb the tree you are
  looking at; not worth it for a quick edit to the branch you are already on. The
  files are separate, but ports, databases and anything else on the machine are
  not, and a fresh tree has no build output, so the first build is a full one.
- **Scratch Copy** — a copy of the tree to try something risky in and throw away,
  in a project with or without git. Anything .gitignore leaves out is left out of
  the copy. Applying a change back copies whole files, and refuses the ones the
  project has changed since.
- **Subfolder** — conversations work in a subfolder instead of the project
  root. Best for one package, service or subrepo of a large monorepo: commands run
  in the folder while the rest of the project stays readable. Nothing is created
  and nothing is removed.

Several conversations can work in the same workspace, and none of them owns it —
a workspace outliving the conversations that used it is normal. In the tab strip,
the conversations working in a workspace are drawn in a box named after it, with
a dot when the tree holds uncommitted work. Selecting the box (as you would a
tab) opens a panel showing what the place is, where it is on disk, how it is
doing, and the ways of finishing with it. Each box has a "+" that starts a new
conversation already working there.

Moving a single conversation is a tab action, not a box action, since a box of
three conversations names none of them: use "Use a different workspace…" on the
tab's context menu, or drag the tab to another box, which opens the same dialog
rather than moving it silently. A move that leaves it working in the same folder,
such as into or out of a group, is made without asking.

Finishing a workspace is the provider's business and the options are its own — a
worktree offers to commit or to discard, and discarding deletes the tree and the
branch. Closing a workspace bins the conversations that were working in it: they
go with the place they were working in, and the Bin restores them.

Nothing about workspaces needs a rebuild. The workspaces themselves are made at
runtime and kept with the project's session. The providers above are not a fixed
list either: each is a "workspaces/*-workspace-provider.js" file that an
extension declares in its manifest, so an installed extension can add a provider
of its own; see "Writing an extension". What is built into the server is only
where a workspace's operations run, and today that is always this machine — a
provider makes a directory on it, and cannot reach another host by itself.

## Keyboard shortcuts

Shortcuts are customisable. The following are the current bindings, shown for
this platform:

{{KEYBOARD_SHORTCUTS}}

## Model providers

Juggler talks to models through pluggable providers. The built-in set is:

- **Anthropic (API)** and **Anthropic (Claude Code CLI)**
- **OpenAI ChatGPT** and **OpenAI Codex (ChatGPT plan)**
- **Google Gemini**
- **GitHub Copilot**
- **Mistral AI**
- **Moonshot Kimi**
- **DeepSeek**
- **Z.AI GLM**
- **OpenRouter**
- **OpenCode Zen**
- **ACP Agents** (external agents speaking the Agent Client Protocol)
- **Ollama (local)**, **LM Studio (local)**, **llama.cpp (local)** and **LocalAI (local)**

Beyond those you can define **custom endpoints**: any number of named gateways,
tenants, regions or local servers, each with its own base URL, credentials,
headers and model list, and each appearing in the picker as its own provider.

Pick and configure your default model in the app; API keys are stored locally
(see below).

## Configuration and data locations

Per-user state lives in the "~/.juggler" directory:

- **credentials.json** — API keys, owner-only permissions.
- **default-model.json** — your chosen default model.
- **custom-providers.json** — your named custom endpoints.
- **workspace.json** — the desktop app's open-window set and last-used theme.
- **extensions/** — installed user extensions.
- **commands/** — your custom slash commands (see custom-commands.md).
- **skills/** — your Agent Skills, available in every project.
- **cache/** — regenerable cache (recent projects, learned model context sizes);
  safe to delete at any time.

Everything directly under "~/.juggler" is durable and worth copying to a new
machine; everything under "~/.juggler/cache/" is regenerable. Logs do not live
here — they go to the platform's standard log directory to keep the config folder
small and copyable. "JUGGLER_CONFIG_DIR" moves the config directory and
"JUGGLER_LOG_DIR" the log directory.

Per-project state lives in a ".juggler" folder inside the project: "MEMORY.md" —
the durable, user-visible project memory the memory tool writes to (gitignored by
default) — plus "commands/" and "skills/" (both shared through the project's git
repository), the session and config files, and the lockfile. That location is
fixed: there is no setting that moves it. A checkout that must not be written to
has to exclude the folder instead.

## Extensions

Juggler's capabilities are delivered as extensions. Built-in ones include Juggler
Core (the standard tools, strategies, commands and workspace providers) and
Juggler MCP (tools from configured MCP servers). "About Juggler" — the extension
providing this manual — is itself one such extension: it is on by default and can
be turned off in the Extensions view, which removes this tool entirely.

User extensions can be installed under "~/.juggler/extensions/". Extensions are
managed in the Extensions view, where each extension and each capability has an
enable/disable toggle.

### Writing an extension

You do not need Juggler's source checked out to build one — everything you need
ships with the app.

Fastest start: the Juggler binary has an "ext" subcommand.

- "juggler ext init <name>" scaffolds a complete, working extension (a manifest
  plus one sample of each capability and a README) that loads and passes
  validation unedited — edit the samples into what you want.
- "juggler ext validate <path>" runs the exact admission check the app applies
  at load: required manifest fields, engineApi compatibility with this host, and
  that every "provides" glob resolves to real files.
- "juggler ext link <path>" symlinks your directory into "~/.juggler/extensions/";
  after that, saving any file hot-reloads the extension in connected viewers with
  no restart.
- "juggler ext add github.com/owner/repo" clones a published extension.

Anatomy: an extension is a folder with a "juggler.extension.json" manifest at its
root plus capability files whose names carry a type suffix, which is how the
manifest globs find them. The capability types are:

- "context-items/*-context-item.js" — tools the model can call ("juggler/context-item")
- "strategies/*-strategy-type.js" — agentic-loop policies ("juggler/strategy-type")
- "commands/*-command-type.js" — slash commands ("juggler/command-type")
- "cards/*-card.js" — sidebar info tiles ("juggler/info-card-type")
- "pins/*-pin.js" — tabs on the Pinboard ("juggler/pinboard-item-type")
- "viewers/*-file-viewer.js" — how a file type is displayed and extracted for the
  model ("juggler/file-viewer")
- "workspaces/*-workspace-provider.js" — places a conversation can work in, such
  as a worktree or a copy ("juggler/workspace-provider")

Each capability is a class that "export default"s, extends its SDK base class,
and declares a static MANIFEST. An extension may also contribute a single
system-prompt module, and may declare "settings" (typed user-configurable values
including secrets, rendered in the Extensions view and read back at runtime with
extensionConfigResolve from "juggler/ops"). (For a reusable prompt you do not
need an extension at all — a custom slash command is enough.)

Minimal manifest. Required fields are id, name, version, and provides; engineApi
is recommended and is checked against the host SDK version in web/sdk/version.js:

    {
      "id": "@you/word-count",
      "name": "Word Count",
      "version": "1.0.0",
      "engineApi": "^1.0.0",
      "provides": { "contextItems": ["context-items/*-context-item.js"] }
    }

Minimal tool (a context item). Implement getToolDefinitions() (the schema the
model sees), execute() (do the work; return RAW data), and getSummary() (format
the outcome). The single most common mistake is reading outcome.foo instead of
outcome.result.foo — execute()'s return value is wrapped as outcome.result:

    import ContextItem from 'juggler/context-item';

    class WordCountContextItem extends ContextItem {
      static MANIFEST = { id: 'word-count', name: 'Word Count', version: '1.0.0',
        description: 'Count words in a text string' };

      static getToolDefinitions() {
        return [{
          name: 'word_count',
          category: 'read',
          description: 'Count words in a text string',
          input_schema: { type: 'object',
            properties: { text: { type: 'string', description: 'Text to count' } },
            required: ['text'] }
        }];
      }

      async execute(params) {
        return { count: params.text.split(/\\s+/).filter(Boolean).length };
      }

      getSummary(outcome) {
        if (!outcome.success) return { summary: outcome.error, success: false };
        return { summary: outcome.result.count + ' words', success: true };
      }
    }

    export default WordCountContextItem;

For the exact API — every base-class method, the engine-vs-viewer execution
rules, approval and status-UI hooks, and the full manifest schema — read the SDK
source and the built-in examples directly. You can pull that source inside this
app, with no repo and no network, using the ReadJugglerSource tool: pass a path
under sdk/ or extensions/. The most useful targets are sdk/context-item.js,
sdk/strategy-type.js, and sdk/command-type.js (each opens with a quickstart and a
full method reference), plus the working examples under
extensions/juggler-core/context-items/ (for example read-file-context-item.js for
validation and status UI, or write-file-context-item.js for an approval gate).
For a workspace provider, sdk/workspace-provider.js and
extensions/juggler-core/workspaces/git-worktree-workspace-provider.js cover every
hook. The same files are also served by the running app at /sdk/... and
/extensions/... if you would rather open them in a browser tab.

Two documents in the repo go further than this quickstart can (they are not in
the app, so they need a checkout or GitHub): docs/extension_tutorial.md builds a
complete extension step by step — tool, approval gate, setting, command, and
sidebar card — and docs/extension_guide.md is the reference for the manifest,
every capability type, and the trust model. The repo's examples/extensions/
directory holds small, self-contained examples covering every capability type, all
Apache-2.0 and meant to be copied.

## Updates and connectivity

Juggler runs locally and only contacts the network when it needs to: LLM requests
go to whichever model provider you have configured, WebFetch/WebSearch reach the
sites you ask for, and Juggler checks for new versions. Your code is not sent
anywhere except to the model provider you choose for a given request.

## Troubleshooting

- **Logs** — logs do not live in "~/.juggler"; on this platform they are written
  to {{LOG_LOCATION}}. The in-app logging documentation explains how to read them
  and report issues.
- **Reset the cache** — deleting "~/.juggler/cache/" is safe; Juggler rebuilds it.
- **A tool seems missing** — check the Extensions view; the tool's providing
  extension or capability may be disabled.

## Source code and deeper documentation

Juggler is open source at https://github.com/juggler-ai/juggler. The app lives at
the repository root, so the paths below are relative to it — when you need more
than this manual carries (exact API signatures, precise behaviour, or how to
extend the app), read the source rather than guessing:

- **Writing extensions** — docs/extension_tutorial.md builds one end to end and
  is the place to start; docs/extension_guide.md is the reference (manifest,
  every capability type, settings and secrets, the trust model). examples/
  extensions/ holds small, copyable examples of every capability type, Apache-2.0
  and meant to be copied. The base classes an extension subclasses live in
  web/sdk/, and each carries a JSDoc header with a quickstart and full method
  reference — that source is the canonical API documentation:
  web/sdk/context-item.js (tools/context items), web/sdk/strategy-type.js
  (strategies), web/sdk/command-type.js (slash commands),
  web/sdk/info-card-type.js (sidebar cards), web/sdk/pinboard-item-type.js
  (Pinboard tabs), web/sdk/file-viewer.js (file display and extraction), and
  web/sdk/workspace-provider.js (places a conversation can work in). The built-in
  extensions under web/extensions/ (juggler-core and juggler-mcp) are larger
  working examples.
  The docs and examples/ live on GitHub, but those SDK base classes and the
  web/extensions/ examples are also readable inside this app via the
  ReadJugglerSource tool (paths under sdk/ or extensions/) — so you can consult
  the exact API offline, with no repo checkout.
- **Configuration and data layout** — docs/config-directory.md (the ~/.juggler
  directory, durable vs. cache).
- **Custom slash commands** — docs/custom-commands.md (the no-code command
  format: placeholders, run modes, and scopes).
- **Project memory** — docs/memory.md (how .juggler/MEMORY.md is read and written).
- **Context window** — docs/context-window.md (how context is measured, budgeted
  and compacted).
- **MCP servers** — docs/mcp.md (configuring MCP and how its tools appear).
- **Logs and reporting issues** — docs/logging.md.
- **Running without a desktop** — docs/headless-linux.md.
- **Building and distribution** — docs/distribution.md; the top-level README.md
  covers cloning (with submodules) and building from source.
- **Contributing and licensing** — CONTRIBUTING.md, and LICENSING.md for the
  license boundary (the core is AGPL-3.0; the extension SDK under web/sdk/ and the
  built-in extensions under web/extensions/ are Apache-2.0).

To open any of these in a browser, prefix the repo-relative path with the
repository's blob URL on the default branch — for example
https://github.com/juggler-ai/juggler/blob/main/docs/extension_guide.md.

## Where to learn more

The website https://juggler.studio has the current overview and docs. This manual
is generated from Juggler's own source, so for the newest details always defer to
the source above, the running app's Extensions view, and the official docs.`;

export default CORPUS;
