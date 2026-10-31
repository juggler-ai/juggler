# Custom slash commands

Custom slash commands let you save a prompt you use often as `/name`, with no
code. A command is a small markdown file — a prompt template plus a few options —
that Juggler turns into a real slash command in the menu. They hot-reload the
moment you save, and you can share the project-scoped ones through git.

For commands that need real logic (call an API, transform the document, add a
tool), write an **extension** instead — see the [extension guide](extension_guide.md).
Custom commands are the no-code tier below that.

## Creating one

Three ways, all equivalent — they write the same file:

- **Type a name that doesn't exist.** `/standup` with no such command offers a
  pinned **"New command '/standup'…"** row that opens the editor pre-filled.
- **"Browse/edit slash commands…"** — the button at the top of the slash menu
  (and of the `/` button's list) opens **Settings → Slash commands**. It lists
  every command: your own, grouped by scope, then the built-ins. **New command…**
  creates one; selecting one of yours opens it in the editor beside the list,
  where it can be changed or deleted. Selecting a built-in shows what it does,
  and **Show in Extensions** takes you to the extension that provides it.
  `/commands` opens the same page from the keyboard.
- **Ask the assistant.** "Make that a slash command" → it calls `define_command`
  and you approve the full definition before it's written.

## The file format

One file per command under a `commands/` directory (see [Scopes](#scopes)). The
name of the file (without `.md`) is the command name, so `review-pr.md` becomes
`/review-pr`. Names are lowercase letters, digits, and hyphens, starting with a
letter.

Each file is YAML frontmatter followed by the prompt template:

```markdown
---
description: Review a PR and report findings   # required — shown in the menu
argsHint: <pr-number>                           # optional — hint after you accept it
run: subthread                                  # send (default) | draft | subthread
strategy: read-only                             # optional — subthread only
provider: anthropic                             # optional — subthread only
model: claude-haiku-...                          # optional — subthread only
thinking: high                                  # optional — subthread only
serviceTier: priority                           # optional — subthread only
goal: PR review                                 # optional — short UI label, subthread only
icon: icon-eye                                  # optional — a menu icon class
---
Review PR $1. Check out the branch, read the diff, and
report each finding as `file:line — description`.
$ARGUMENTS
```

### Placeholders

The template is expanded against whatever you type after the command name:

| Placeholder    | Expands to                                             |
| -------------- | ------------------------------------------------------ |
| `$1` … `$9`    | The 1st … 9th positional argument (empty if not given) |
| `$ARGUMENTS`   | Everything after the command name, exactly as typed    |
| `$$`           | A literal `$` (so `$$1` is the text `$1`, not an arg)  |

Placeholders are single-digit, so `$10` is `$1` followed by a literal `0`. If a
template uses placeholders and you supply no arguments, it still sends — the
model can ask for what it needs.

`$ARGUMENTS` keeps your line breaks, so a command whose argument is a long
description — headings, lists, fenced code — reaches the prompt as you wrote it.
The positional `$1` … `$9` are the whitespace-delimited words of that same text.

## Run modes

`run:` decides what invoking the command does:

- **`send`** (default) — expands the template and sends it as your next message.
- **`draft`** — expands the template into the composer so you can edit it before
  sending.
- **`subthread`** — runs the expanded prompt in an isolated sub-thread and lands
  the result back in the conversation, keeping the main context clean. Only this
  mode honours `strategy`, the model fields, and `goal`. Keep `goal` to a few
  words: it is shown in the thread UI, while the expanded template is the task
  itself.

The model override is a full reference — `provider`, `model`, and the `thinking`
and `serviceTier` dials that model advertises — which is what the editor's model
picker writes. `model` on its own is also valid: the id is matched against the
providers you have configured, so a hand-written file (or one the assistant
writes with `define_command`) needs nothing else. Either way, a model no
provider offers is ignored and the thread inherits the conversation's own.

## Scopes

A command lives in one of two places:

| Scope       | Location                          | Applies to        |
| ----------- | --------------------------------- | ----------------- |
| **Project** | `<project>/.juggler/commands/*.md` | this project (git-shareable) |
| **User**    | `~/.juggler/commands/*.md`         | all your projects |

If both scopes define the same name, the **project** command wins. A custom
command may **not** shadow a built-in command (`/clear`, `/compact`, …): such a
file still loads but is flagged invalid on the Slash commands settings page with
the reason, so it never silently overrides a built-in.

## Sharing and trust

Project-scoped commands arrive with the repository, so a command someone else
wrote can ship in a project you clone. A command is only ever run when **you**
invoke it — never automatically — and its scope is shown as a badge in the menu
and as its group on the Slash commands settings page, so you can always see
where a command came from before you run it. Commands cannot run shell or read files on their own; they only send a
prompt (which the model then acts on under your normal approval rules).

## Importing from Claude Code

The format is deliberately close to Claude Code's `.claude/commands/*.md`. Juggler
does not scan `.claude/` automatically; copy the files into a `commands/`
directory (Juggler reads `argument-hint` as `argsHint` and ignores keys it does
not recognise).
