# Environment variables for commands

Every command the assistant runs gets a fresh shell, so an `export` in one is
gone by the next, and a variable you set in your terminal after Juggler started
never reaches it. Variables a project's commands always need go in a file
instead, and every command — foreground, background, Monitor tasks and Python —
gets them.

## The three files

Each is a JSON object of names to values:

```json
{
  "AWS_PROFILE": "staging",
  "NODE_OPTIONS": "--max-old-space-size=8192"
}
```

| File | Whose | Applies |
|---|---|---|
| `~/.juggler/env.json` | yours | in every project |
| `<project>/.juggler/env.json` | the project's, meant to be committed | in this project, **once you approve it** |
| `<project>/.juggler/env.local.json` | yours | in this project; the place for secrets |

They are merged in that order, so a later file wins for a name both set. The
variables are added to Juggler's own environment, replacing a variable of the
same name.

Values are used exactly as written: nothing is expanded, so `"$HOME/bin"` is
those nine characters, not your home directory.

The files are read for every command, so an edit applies to the next one — no
restart. A file that is not valid JSON, or names a variable no shell can hold,
is skipped whole rather than half-applied, and the Environment pin says why.

## Approving the project's file

A repository can arrive with a `.juggler/env.json`, and one variable is enough
to change what every command does — `PATH`, `GIT_SSH_COMMAND` and
`LD_PRELOAD` all redirect what runs. So none of that file's variables apply
until you have seen them and approved them, in the **Environment** pin on the
Pinboard. The approval is for exactly what the file held: change a name or a
value and it waits to be approved again. A file you write through the pin is
approved as you write it. Your two own files are never gated.

Approvals are kept in `~/.juggler/env-approvals.json`, where no repository can
write.

## Secrets

Put them in `.juggler/env.local.json`. Juggler writes it readable by you alone,
and the first time it does so in a git repository it adds the file to
`.git/info/exclude` — which keeps it out of `git status` without touching the
repository's `.gitignore`. A file you create by hand is not excluded for you.

`~/.juggler/env.json` is owner-only too. The project's `env.json` is written
like any source file, because it is meant to be shared.

## The Environment pin

Add it from the Pinboard. It lists each file's variables with their values
hidden until you ask, marks the ones a later file overrides or that are waiting
for approval, and adds and removes variables in place. It notices edits to the
two project files as they happen; for a hand edit to `~/.juggler/env.json`,
press Refresh.

## Where they do not reach

- **Workspaces** use the project's files, not any `.juggler/` a branch carries.
- **Windows:** commands run in WSL, and each variable but `PATH` is passed in
  through `WSLENV`. WSL builds its own Linux `PATH`.
- **MCP servers and agent providers** have their own `env` settings and do not
  read these files. A provider that runs commands with its own shell tool, such
  as the Claude Code CLI, does not see them either.
