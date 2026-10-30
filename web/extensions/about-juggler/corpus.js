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

Juggler is a visual workbench for AI coding agents: see and control your coding
agent, locally or remotely. Work in the desktop app, or run the juggler server
on a dev box and open the same live session from the app or a browser; several
clients can attach at once.

- **A real desktop GUI.** Finder-style Miller columns; tool calls, context and
  properties open into their own views.
- **The session is a tree, not a doom-scroll.** A conversation is a persistent
  Yjs document: branch nested threads, move or copy items between branches, and
  undo structural changes. It survives a quit, approvals waiting included.
- **You see what the model saw.** Any recorded LLM transaction opens to show its
  system prompt, messages, tool definitions, output, token and cache use.
- **Plugins all the way down.** Tools, commands, strategies, pins, workspaces
  and hooks are JavaScript extensions you can inspect, fork or replace.
- **Vendor-neutral.** Hosted APIs, agent CLIs you already have, or local models,
  switchable mid-conversation. No house model, no resold tokens, no account.

## Core concepts

- **Conversation** — a Yjs document holding the tree of messages, threads and
  context items; attached clients stay in sync.
- **Threads** — sub-conversations branched off a point in the tree, for a
  tangent, a delegated sub-task or a competing approach; a child works in
  isolation and returns its result to the parent.
- **Context items** — the typed units of context (files, tool calls, memory, the
  system prompt, dropped files). Each is a plugin with its own UI, and every
  tool the model can call is backed by one.
- **Strategies** — pluggable loop policies that gate which tools are offered and
  how calls are approved, without changing the cached system prompt.

## Pinboard

A tabbed panel behind the right edge of the window. Each tab is a "pin" supplied
by an extension; pins belong to the project session, so every viewer sees the
same board. A pin is only a view: pinning a file shows it to you, not to the
model, and the agent can request a pin but cannot list or read the board.
Built-in pins:

- **Plan** and **Todos** — the plan or checklist of the thread you are reading,
  else of the nearest parent with one. Read-only; they change through their tools.
- **Git** — review changes: each repository's branch and drift from upstream,
  and every changed file's diff, for the project or the visible conversation's
  workspace. Working tree against HEAD by default, or staged, a branch, the last
  commit or any git diff range. Line comments go to the conversation as one
  message. It reads git, so edits made by hand show too.
- **Memory** — the project facts the assistant keeps.
- **Running tasks** — every command the project's conversations are running now,
  background or foreground, grouped by conversation, each with a Stop and a link
  to the action that started it.
- **File** — a live file or directory (an agent-made pin is held to the project).
- **Project files** — the project's files as a tree, everything on disk.
- **Environment** — the variables commands run with in this project, and the
  approval for the project's committed env file (see "Environment variables").

An HTML file is shown as its rendered page wherever a file is displayed (a pin, a
read or write result, a dropped file), in a sandboxed frame that cannot reach
Juggler, with a Source button. So the agent can show you a report or mock-up by
writing an HTML file in the project and pinning it.

## Tools the agent can use

Availability depends on enabled extensions and capabilities, and the strategy
may withhold some. Juggler Core provides:

- **read**, **write**, **edit** (exact-string replacement), **glob** (files by
  name), **grep** (ripgrep content search), **batch_read / batch_grep**.
- **bash** — a command in a fresh shell rooted at the project; nothing persists
  between calls (standing variables go in the env files). Can run in background.
- **Monitor** — a background command whose output lines stream in as events.
- **TaskOutput / TaskStop** (alias KillShell) — read or stop a background task.
- **query_code** — JavaScript over a read-only view of the codebase; only the
  returned value and console.log output enter context; image(path) attaches one.
- **run_code** — a JavaScript program that also calls the conversation's tools.
  Only its return value and a list of its changes enter context. Each call is
  approved as if made directly; one awaiting approval pauses the program and a
  denial ends it. Its description names the tools a program cannot call.
- **WebFetch** — a URL as markdown (15-minute cache), or an image as an image;
  given a prompt, a sub-agent reads the page and returns only the answer.
- **WebSearch** — web search returning titles, URLs and descriptions.
- **Explore** / **Research** — sub-agents that investigate the codebase
  (read-only) or the web and return only their findings.
- **create_thread** — a self-contained sub-task in an isolated thread.
- **new_conversation** — an independent peer conversation in its own tab.
- **todo** — a lightweight checklist; **plan** — an approval-gated plan whose
  steps are then tracked.
- **memory** — remember or forget durable project facts.
- **skill** — load an Agent Skill on demand.
- **pin_to_pinboard** — show something on the Pinboard.
- **AskUserQuestion** — structured multiple-choice questions for the user.
- **define_command** — save a prompt as a custom /name command (user-approved).

Other built-in extensions add **AboutJuggler** (this manual),
**ReadJugglerSource** (the app's SDK and example-extension source), MCP server
tools, and **exa_search** (Exa web search; needs an Exa API key in its settings).

## Strategies

- **Default** — standard general-purpose coding-assistant behaviour.
- **Auto-approve** — like Default, but a cheap model auto-approves routine
  prompts it is sure are safe, so you are asked only about risky ones (review
  level balanced, relaxed or custom, in Juggler Core's settings).
- **Read-only** — any action that may change files is automatically refused.
- **YOLO** — auto-approves every tool use. Use at your own risk.

Switch with the strategy switcher (default Shift+Tab; hold for a menu).

## Approvals

A tool call that needs permission shows a card with these buttons:

- **Yes** approves just this call.
- **Yes + Don't Ask Again for <pattern>** also saves that pattern, for example
  "make *", for this conversation. Click the pencil on the button to edit the
  pattern. The permissions button ("Edits on" / "Edits off", in the line of
  settings under the message box with the strategy and model; above the text
  on a touch screen) lists saved patterns and allowed folders. There you can
  edit them, add patterns for all conversations, and turn file edits on or off
  (⌘E on macOS).
- **No** refuses this call. It also refuses every other call waiting with it and
  stops the turn.

To stop being asked, switch strategy: **Auto-approve** has a cheap model approve
routine calls, and **YOLO** approves everything. This is the quickest way to let
a multi-step job such as a rebuild run. If you keep approving within one turn,
the card offers both. Switching there, or with Shift+Tab, also decides the calls
already waiting.

## Slash commands

Type "/" in the composer. Built in: **/new** (new empty conversation),
**/duplicate** (clone this one), **/clear** (clear messages), **/compact**
(compact everything into a summary thread), **/handoff** (summarise into a new
conversation to continue), **/thread** (new sub-conversation thread),
**/export** (save as an HTML page to share), **/commands** (manage custom
commands), **/init** (have the agent survey the project and draft an
AGENTS.md), **/shell** (run a shell command yourself). Juggler MCP adds **/mcp**.

**Running a command yourself**: start a message with "!" ("! npm run lint" is
the same as "/shell npm run lint"). The command runs in the conversation's
workspace with the same shell and project environment as the bash tool, but
with no model call and no approval card. While it runs the composer shows it
with a Stop button. When it ends, its output joins the conversation as a Shell
item, and the model reads it with your next message. If a turn is running, the
output waits for the turn's next boundary. A "!" on its own is an ordinary
message.

**Custom commands** need no code: a markdown file of YAML frontmatter over a
prompt template, hot-reloaded on save. "$1".."$9" are positional arguments,
"$ARGUMENTS" everything after the name as typed, "$$" a literal dollar. Run
modes: send, insert as an editable draft, or run in a sub-thread (with its own
strategy or model if set). Create one by typing an unknown name (the menu offers
"New command…"), with /commands, or by asking the assistant. Files live in
~/.juggler/commands/ or <project>/.juggler/commands/ (shared through git); a
project command shadows a user one, and neither overrides a built-in.

## Agent Skills

A skill follows the open Agent Skills standard (agentskills.io): a folder with a
SKILL.md (YAML frontmatter plus markdown), optionally scripts/, references/ and
assets/. Only names and descriptions are listed; the skill tool loads a body
when a task matches. Discovered at:

- <project>/.juggler/skills/<name>/SKILL.md and <project>/.agents/skills/...
- <config>/skills/<name>/SKILL.md (~/.juggler/skills/) and ~/.agents/skills/...

The .agents paths are cross-agent aliases. Files in a skill are read through the
ordinary read and bash tools under normal approval — no new access path.

## Tool hooks

A hook applies around every tool call whatever the strategy: beforeTool (deny
the call, make it ask you, or add a note) or afterTool (add a note to the
result). Hook files are no-code markdown in ~/.juggler/hooks/ — user scope only,
never from a project — with frontmatter for description, event, and optional
tool, input/result patterns, isError, verdict (deny or ask) and repeat. A hook
file can never allow a call. Extensions can provide code hooks. Deny beats ask
beats allow, and a hook's ask overrides even YOLO. A call's properties show the
hooks that acted on it.

## Workspaces

A workspace is where a conversation's tools run — where bash executes and what
file tools are relative to. Every project is one already. Built-in providers:

- **Group** — only organises conversations; they work in the project, nothing is
  created on disk. Ungrouping returns them; deleting it bins them.
- **Git Worktree** — another branch in a tree of its own. Files are separate;
  ports, databases and the machine are not, and the first build is a full one.
- **Scratch Copy** — a throwaway copy of the tree, git or not, minus what
  .gitignore excludes. Applying back copies whole files and refuses any the
  project has changed since.
- **Subfolder** — work in one folder of a monorepo; the rest stays readable.
  Nothing is created or removed.

Create one with "New workspace or group". Several conversations can share one,
and it can outlive them. Its conversations sit in a box in the tab strip, with a
dot for uncommitted work and a "+" for a new conversation there. Selecting the
box opens a panel: the place, its path, its state, and the provider's ways of
finishing (a worktree offers commit or discard; discard deletes tree and
branch). Closing a workspace bins its conversations; the Bin restores them. To
move a conversation, drag its tab to another box or the flat strip (the project
folder) and confirm; a move within the same tree, such as into a group, needs no
confirmation. Providers are extension-declared files
(workspaces/*-workspace-provider.js), so adding one needs no rebuild; every
workspace is a tree on the machine the server runs on.

## Keyboard shortcuts

Shortcuts are customisable. The current bindings for this platform:

{{KEYBOARD_SHORTCUTS}}

## Model providers

- **Anthropic (API)**, **Anthropic (Claude Code CLI)**
- **OpenAI ChatGPT**, **OpenAI Codex (ChatGPT plan)**
- **Google Gemini**, **GitHub Copilot**, **Mistral AI**, **Moonshot Kimi**,
  **DeepSeek**, **Z.AI GLM**, **OpenRouter**, **OpenCode Zen**
- **ACP Agents** (external agents speaking the Agent Client Protocol)
- **Ollama (local)**, **LM Studio (local)**, **llama.cpp (local)**,
  **LocalAI (local)**
- **Jev (TypeSafe)** — a decision model answering yes/no, choice and score
  questions (e.g. judging tool approvals); not usable for chat.

Plus any number of **custom endpoints** (gateways, tenants, regions, local
servers), each with its own base URL, credentials, headers and models, and each
its own provider in the picker. Keys are stored locally.

## Configuration and data locations

Per-user state lives in ~/.juggler:

- **credentials.json** — API keys, owner-only. **default-model.json** — your
  default model. **custom-providers.json** — your custom endpoints.
- **env.json** — variables for every command, in every project.
- **env-approvals.json** — the project env.json contents you approved.
- **workspace.json** — the desktop app's open windows and theme.
- **extensions/**, **commands/**, **hooks/**, **skills/** — your extensions,
  custom commands, hook files and Agent Skills.
- **cache/** — regenerable (recent projects, learned context sizes); safe to
  delete.

Everything directly under ~/.juggler is durable and worth copying to a new
machine; cache/ is not. Logs are elsewhere (see Troubleshooting).
JUGGLER_CONFIG_DIR moves ~/.juggler and JUGGLER_LOG_DIR the logs.

Per-project state lives in <project>/.juggler: MEMORY.md (the memory tool's
project facts, private to your checkout), commands/, skills/, env.json and
env.local.json, plus config, session, conversation folders, MCP config and bash
output. That location is fixed; a checkout that must not be written to has to
exclude the folder.

### Environment variables

Every command (foreground, background, Monitor, Python) gets variables from
three JSON files of names to values, merged in this order, later winning:

- ~/.juggler/env.json — yours, in every project.
- <project>/.juggler/env.json — the project's, meant to be committed. Applies
  only once you approve its exact contents in the Environment pin, and asks
  again after any change. Your own two files are never gated.
- <project>/.juggler/env.local.json — yours, in this project; the place for
  secrets. Juggler writes it owner-only and, in a git repository, adds it to
  .git/info/exclude (a file you create by hand is not excluded for you).

Values are not expanded, and an edit applies to the next command. MCP servers,
and providers that run commands with their own shell such as the Claude Code
CLI, do not get them.

## Extensions

Built in: Juggler Core (@juggler/core — tools, strategies, commands, pins,
viewers, workspace providers), Juggler MCP (@juggler/mcp), Exa Search
(@juggler/exa) and About Juggler (@juggler/about — this manual; turning it off
removes this tool). User extensions go in ~/.juggler/extensions/. The Extensions
view toggles each extension and capability and edits their settings.

### Writing an extension

No source checkout is needed; the binary has an "ext" subcommand:

- "juggler ext init <name>" — scaffold an extension (manifest, sample tool,
  strategy and command, README) that loads unedited.
- "juggler ext validate <path>" — the app's admission check (required fields,
  engineApi compatibility) plus that every "provides" glob matches files.
- "juggler ext link <path>" — symlink into ~/.juggler/extensions/; saves then
  hot-reload it in connected viewers.
- "juggler ext add github.com/owner/repo" — git-clone a published extension.

An extension is a folder with a juggler.extension.json manifest and capability
files named with a type suffix, which the manifest's globs match:

- context-items/*-context-item.js — tools ("juggler/context-item")
- strategies/*-strategy-type.js — loop policies ("juggler/strategy-type")
- commands/*-command-type.js — slash commands ("juggler/command-type")
- cards/*-card.js — sidebar info tiles ("juggler/info-card-type")
- pins/*-pin.js — Pinboard tabs ("juggler/pinboard-item-type"); an optional
  pins/*-pin.meta.js descriptor lets the agent pin one
- viewers/*-file-viewer.js — how a file type is shown ("juggler/file-viewer")
- workspaces/*-workspace-provider.js — places to work
  ("juggler/workspace-provider")
- hooks/*-hook.js — tool hooks ("juggler/hook-type")

Each capability is a default-exported class extending its SDK base class, with a
static MANIFEST. An extension may also contribute one system-prompt module and
declare "settings" (typed values including secrets, read at runtime with
extensionConfigResolve from "juggler/ops").

Minimal manifest. Required: id, name, version, provides; engineApi is
recommended (checked against web/sdk/version.js); unknown keys are an error:

    {
      "id": "@you/word-count",
      "name": "Word Count",
      "version": "1.0.0",
      "engineApi": "^1.0.0",
      "provides": { "contextItems": ["context-items/*-context-item.js"] }
    }

Minimal tool: getToolDefinitions() (the schema), execute() (return RAW data)
and getSummary(). The most common mistake is reading outcome.foo instead of
outcome.result.foo — execute()'s return value is outcome.result:

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

For the exact API, call ReadJugglerSource with a path under sdk/ or extensions/
(offline, no repo needed): sdk/context-item.js, sdk/strategy-type.js and
sdk/command-type.js each open with a quickstart and method reference;
extensions/juggler-core/context-items/read-file-context-item.js shows validation
and status UI, write-file-context-item.js an approval gate; for a workspace
provider, sdk/workspace-provider.js and
extensions/juggler-core/workspaces/git-worktree-workspace-provider.js. The
running app also serves them at /sdk/... and /extensions/....

## Updates and connectivity

Juggler contacts the network when it needs to: LLM requests go to the provider
you configured, WebFetch/WebSearch reach the sites you ask for, enabled
extensions may reach the hosts they declare, and Juggler checks for new
versions. Model traffic goes straight from the machine Juggler's server runs on
to the provider you chose; Juggler does not proxy it.

## Troubleshooting

- **Logs** — not in ~/.juggler; on this platform they are written to
  {{LOG_LOCATION}}. docs/logging.md covers reading them and reporting issues.
- **Reset the cache** — deleting ~/.juggler/cache/ is safe.
- **A tool seems missing** — check the Extensions view and the strategy.
- **A variable is missing in commands** — open the Environment pin: the
  project's env.json may await approval, or a file may not be valid JSON.

## Source code and deeper documentation

Juggler is open source at https://github.com/juggler-ai/juggler. Paths below are
repo-relative; to open one, prefix the blob URL, e.g.
https://github.com/juggler-ai/juggler/blob/develop/docs/extension_guide.md.

- **Extensions** — docs/extension_tutorial.md (step by step),
  docs/extension_guide.md (manifest, every capability, settings, trust model),
  examples/extensions/ (small copyable examples, Apache-2.0). The SDK base
  classes in web/sdk/ are the canonical API: context-item.js, strategy-type.js,
  command-type.js, info-card-type.js, pinboard-item-type.js, file-viewer.js,
  workspace-provider.js, hook-type.js. web/extensions/ holds the built-in
  extensions; both are readable in-app via ReadJugglerSource.
- **Configuration** — docs/config-directory.md (~/.juggler, durable vs. cache),
  docs/project-env.md (environment variables for commands).
- **Features** — docs/custom-commands.md, docs/hooks.md, docs/memory.md,
  docs/context-window.md (measuring, budgeting, compacting), docs/mcp.md.
- **Running** — docs/logging.md, docs/headless-linux.md, docs/distribution.md;
  README.md covers building from source. docs/translating.md for the UI.
- **Contributing and licensing** — CONTRIBUTING.md, LICENSING.md (core
  AGPL-3.0; web/sdk/ and web/extensions/ Apache-2.0).

## Where to learn more

https://juggler.studio has the current overview. This manual is generated from
Juggler's source; for the newest details defer to the source above, the running
app's Extensions view, and the official docs.`;

export default CORPUS;
