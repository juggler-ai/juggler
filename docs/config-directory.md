# The `~/.juggler` directory

Juggler keeps its per-user state in `~/.juggler`. The folder splits cleanly into
**durable** state worth backing up and a **regenerable** cache that's safe to
delete.

```
~/.juggler/
├── credentials.json        API keys (owner-only, 0600)
├── default-model.json      your chosen default model
├── env.json                variables for every command, in every project (see project-env.md)
├── env-approvals.json      the project env.json files you approved
├── workspace.json          desktop app's open-window set + last-used theme
├── extensions/             installed extensions
├── commands/               user-defined slash commands (see custom-commands.md)
├── hooks/                  tool hook files (see hooks.md)
└── cache/                  regenerable — safe to delete
    ├── recents.json        recently-opened projects (MRU list)
    └── claudecode-model-info.json   learned model context-window sizes (see context-window.md)
```

## Durable vs. cache

Everything directly under `~/.juggler/` is **durable**: credentials, your
default-model preference, installed extensions, and the desktop app's window
set. This is the part worth copying to a new machine.

Everything under **`~/.juggler/cache/`** is **regenerable**. Juggler rebuilds
these files on demand, so you can delete the `cache/` folder at any time without
losing anything important — the recents list repopulates as you open projects,
and model specs re-learn on the next turn. When copying `~/.juggler` to another
machine, you can safely skip `cache/`.

## Where logs are

Logs do **not** live in `~/.juggler` — they go to your platform's standard
log directory so the config folder stays small and copyable. See
[Logs & reporting issues](./logging.md).

## Project state

Each project has two kinds of files:

- **Files meant to be committed** with the repository live in
  `<project>/.juggler/`: `env.json` ([project-env.md](./project-env.md)),
  `commands/` ([custom-commands.md](./custom-commands.md)), `skills/`,
  `mcp.json`, `acp.json` and `worktree-setup`.
- **Local state**, which belongs to this checkout on this machine, also lives
  in `<project>/.juggler/` by default: `config.json`, `session.json`, the
  lockfile, the per-conversation folders, the trash, bash output, `MEMORY.md`,
  `env.local.json` and scratch-copy sandboxes.

Juggler does not add `.juggler/` to `.gitignore` for you. To keep local state
out of git, exclude it yourself, for example in `.git/info/exclude`.

### Keeping local state outside the project

If a tool that walks your project (a formatter, a linter, a file watcher)
trips over Juggler's files, turn on **Settings → Project files → Keep project
state outside the project**. Each project's local state then lives in a folder
of its own:

| Platform | Folder |
|---|---|
| macOS | `~/Library/Application Support/Juggler/projects/<name>-<hash>/` |
| Linux | `$XDG_STATE_HOME/juggler/projects/<name>-<hash>/` (default `~/.local/state/juggler/projects/…`) |
| Windows | `%LOCALAPPDATA%\Juggler\projects\<name>-<hash>\` |

`<name>` is the project folder's name and `<hash>` is a short hash of its full
path, so two projects with the same name never share a folder. The project's
log folder uses the same name.

Files meant to be committed stay in `<project>/.juggler/`. A project that has
none gets no `.juggler/` folder at all.

The setting applies the next time a project is opened. At that point Juggler
moves the project's existing local state across, and moves it back when the
setting is turned off. Files it doesn't recognise stay where they are. If
another Juggler process is using the project, nothing moves and the project
won't open until that process is gone.

Moving a project folder, or opening it through a different path, gives it a
different outside folder. Its conversations stay in the old one.

## Environment variables

These move the other directories:

| Variable | Moves |
|---|---|
| `JUGGLER_CONFIG_DIR` | `~/.juggler` — credentials, default model, extensions |
| `JUGGLER_LOG_DIR` | the log directory |
| `JUGGLER_STATE_DIR` | the folder that holds every project's outside state. Setting it also turns that placement on, whatever the setting says. |
