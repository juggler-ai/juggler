# The `~/.juggler` directory

Juggler keeps its per-user state in `~/.juggler`. The folder splits cleanly into
**durable** state worth backing up and a **regenerable** cache that's safe to
delete.

```
~/.juggler/
├── credentials.json        API keys (owner-only, 0600)
├── default-model.json      your chosen default model
├── workspace.json          desktop app's open-window set + last-used theme
├── extensions/             installed extensions
├── commands/               user-defined slash commands (see custom-commands.md)
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
