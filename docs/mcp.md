# MCP servers

Juggler is an [MCP](https://modelcontextprotocol.io) client. Point it at a
server — a local process or a remote endpoint — and that server's tools become
ordinary Juggler tools: the model can call them, each call is an inspectable
context item with its own approval and result view, and they sit in the same list
as `read`, `bash` and the rest.

Juggler keeps its **own** MCP configuration. It does not read another agent's
config, so an existing setup elsewhere doesn't carry over — you declare your
servers once, here.

## Where the config lives

Two files, both optional:

```
~/.juggler/mcp.json                    every project
<your project>/.juggler/mcp.json       this project only
```

They're merged, and an entry in the project file replaces a global one of the
same name. On Linux the global file follows XDG:
`$XDG_CONFIG_HOME/juggler/mcp.json`, otherwise `~/.config/juggler/mcp.json`. See
[The `~/.juggler` directory](./config-directory.md).

Note the path: it is `.juggler/mcp.json` inside your project, **not** a `.mcp.json`
at the project root. Juggler also doesn't look in `~/.claude.json`,
`.cursor/mcp.json`, or anywhere else an agent you already use keeps its servers.

The easiest way to write either file is **Settings → MCP servers → Add server**,
which also gives you a live status list, a Restart button, and each server's log.

> If you use the Claude Code **CLI** provider: Juggler spawns the CLI with
> `--strict-mcp-config` and serves it Juggler's own tools over a private
> connection. That deliberately ignores the MCP servers configured in the CLI's
> own settings, so the CLI's toolset is exactly the one Juggler shows you. The
> servers below are used by every provider, the CLI included.

## The file

```json
{
  "mcpServers": {
    "<name>": { … }
  }
}
```

### A local server

A server Juggler launches as a child process and talks to over stdio. This is the
default, so no `transport` line is needed:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_…" }
    }
  }
}
```

### A remote server

An HTTP endpoint, with any headers it needs:

```json
{
  "mcpServers": {
    "linear": {
      "transport": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer lin_api_…" }
    }
  }
}
```

`"type"` is accepted as a synonym for `"transport"`, and `"streamable-http"` as
one for `"http"`, so a server block copied from another agent works as-is.
Juggler stores it under `transport` next time it writes the file.

### Every key

| Key | Applies to | What it does |
|---|---|---|
| `command` | local | The executable to launch. Required for a local server. |
| `args` | local | Arguments, one per array entry. |
| `env` | local | Extra environment variables for the child process. |
| `transport` | all | `stdio` (the default), `http`, or `sse`. |
| `url` | remote | The endpoint. Required for `http`/`sse`. |
| `headers` | remote | Sent on every request — this is where a token goes. |
| `enabled` | all | `false` keeps the entry but never starts it. Default `true`. |
| `tools` | all | `{"allow": […]}` / `{"deny": […]}` — see below. |
| `defaultArguments` | all | Fixed arguments merged into every call — see below. |
| `autoApprove` | all | `true` runs the server's tools without asking. Global file only — see below. |

### When an edit takes effect

There's nothing to restart by hand, Juggler least of all. An edit to either
file — in Settings, in an editor, or by the agent — is read at the next MCP
call. A running server whose `command`, `args`, `env`, `transport`, `url` or
`headers` changed is restarted then. A change to `tools` or `defaultArguments`
applies to the server already running. A local server in a project's file is a
command the repository supplied, so once edited it stops and waits for you to
trust it again in Settings → MCP servers.

A local server's environment is Juggler's own, as it was when Juggler started,
plus its `env`. A variable you set since then, system-wide or in a shell
profile, never reaches it, and `.juggler/env.json` is for shell commands only
([Project environment](./project-env.md)). Put what a server needs in its `env`.

To restart a server by hand — say it reads a config file of its own — use the
Restart button, `/mcp restart <name>`, or ask the agent: it has a
`McpRestartServer` tool whenever a server is configured, which asks you first
and reports back whether the server came up and, if not, its error and output.

## Authentication

Juggler sends the static `headers` you configure and nothing else. There is **no
browser sign-in flow** and no dynamic client registration, so a server whose only
path is interactive OAuth won't connect on its own.

Two ways round it:

- **Use a token.** Most hosted servers accept a personal API token in an
  `Authorization: Bearer …` header, which is the config above. Prefer a
  read-scoped token where the server offers one.
- **Put a proxy in front of it.** `mcp-remote` performs the OAuth exchange, caches
  the token, and presents the result as a local stdio server:

  ```json
  {
    "mcpServers": {
      "linear": {
        "command": "npx",
        "args": ["-y", "mcp-remote", "https://mcp.linear.app/mcp"]
      }
    }
  }
  ```

## How the tools reach the model

Each discovered tool is offered as `mcp__<server>__<tool>` — so the name you
choose for a server becomes part of every one of its tool names. Keep it short,
with no spaces or `/`. `juggler` is reserved for Juggler's own tools.

Two behaviours are worth knowing, because both are decided by the server rather
than by you:

- **Read-only annotation.** A tool that declares itself read-only is treated as a
  read: it can run in parallel with other reads, and read-only strategies such as
  Plan and the Explore/Research sub-agents will use it. A tool that says nothing
  is assumed to modify things, so it needs approval and those strategies withhold
  it. A server that annotates nothing therefore has no tools available while
  you're planning.
- **Schema quality.** The input schema comes from the server as-is. A tool whose
  schema is malformed is dropped rather than offered, and the drop is named in the
  log — the rest of the server's tools are unaffected.

## Narrowing a server down

Servers often expose far more than you want, and every tool costs schema tokens on
every request. Two controls, per server:

```json
{
  "mcpServers": {
    "memory": {
      "command": "memory-server",
      "tools": { "deny": ["delete_all"] },
      "defaultArguments": { "bank_id": "general" }
    }
  }
}
```

- **`tools`** hides tools from the model and blocks calls to them. `allow`, when
  present, is a strict allowlist; `deny` subtracts. An allowlist is the safer
  choice: a server update can add a destructive tool that a denylist won't catch.
  Settings → MCP servers → edit gives you a checkbox per tool.
- **`defaultArguments`** are merged into every call to that server and removed
  from the schema the model sees. The configured value wins over anything the
  model supplies, so a routing key is decided by your config, not by the model.

Settings shows each server's tool count and its approximate token cost per
request, which is the number to watch if your context is filling up.

## Approving calls

An MCP tool call asks for approval by default — Juggler can't know what a
third-party tool does. The approval offers three widths: this tool, all read-only
tools on this server, or every tool on that server (trust the server). Granting
by read-only only ever covers tools the server itself annotated as read-only.

A grant covers every conversation in the project, not just the one you clicked
it in. The permissions popup lists them under **MCP tools approved**, where each
can be narrowed to its own conversation or deleted.

To skip the question altogether for a server you trust, tick **Pre-approve this
server's tools** in Settings → MCP servers, or set `"autoApprove": true` on its
entry. Its calls then run without asking, in every conversation of every
project. This works **only in the global file**. A project's
`.juggler/mcp.json` can arrive with a repository you cloned, so Juggler ignores
`autoApprove` there. A project entry that replaces a pre-approved global one of
the same name doesn't inherit it either.

## When it isn't working

Four places to look, in order:

1. **The System Prompt item's Tools section.** Select System Prompt at the top of
   any column: its properties panel lists every tool the model is being offered
   in that thread, grouped by which server it came from. If your server's tools
   aren't in that list, the model has never seen them, whatever it says. A server
   that is configured but not serving gets its own line there, and tools the
   thread's strategy is holding back are shown struck through rather than
   silently dropped. Clicking any tool opens the settings that govern it — its
   server's entry for an MCP tool, so you land on the same form as the per-tool
   checkboxes below.
2. **Settings → MCP servers.** A dot per server (grey stopped, amber starting,
   green running, red failed), the first line of the error when it failed, plus
   Restart and the server's own log output.
3. **`/mcp`** in a conversation, for the same list without leaving the keyboard.
   `/mcp restart <name>`, `/mcp logs <name>`, and `/mcp reload` also work.
4. **`server.log`**, where every MCP line is tagged `[mcp]`. See
   [Logs & reporting issues](./logging.md).

For what a past turn actually sent — as opposed to what would be sent now — click
the token count in the conversation footer. That opens the round-trip's record,
whose tools row lists every tool definition the model received.

A server has 30 seconds to connect. A local server that dies is restarted up to
three times, and the tail of its stderr is attached to the error. A server that
fails on a variable it can't see wants it in its `env` — see
[When an edit takes effect](#when-an-edit-takes-effect).

| What you see | What it means |
|---|---|
| "No MCP servers yet" | Your config isn't in a file Juggler reads. Check the two paths above. |
| An error banner above the list | `mcp.json` didn't parse. The message names the position. |
| `has a "url" but no transport` | A remote entry missing its transport line. Add `"transport": "http"`. |
| `no command configured` | A local entry with no `command`. |
| `unsupported transport "…"` | Typo — it's `stdio`, `http`, or `sse`. |
| 401 / unauthorized | The server wants credentials Juggler isn't sending. See Authentication. |
| Running, tools listed, but the model says the tool doesn't exist | The tool list for a turn is fixed when the turn starts. A server that finished connecting mid-turn shows up on the next one — the Tools section says so when it has tools the last turn didn't carry. |
| The tool exists but is never used while planning | It isn't annotated read-only, so read-only strategies withhold it. |
| A tool is missing from an otherwise healthy server | Either the `tools` filter excludes it, or its schema was malformed — the log says which. |
