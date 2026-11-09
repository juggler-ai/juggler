# Project Memory

Juggler keeps a small, durable **project memory** so the assistant remembers
what it learns about your project from one conversation to the next — your
build command, a convention you corrected it on, a non-obvious constraint. It is
the Juggler-native equivalent of the "saved memories" you may know from other
assistants.

Memory is **per project, private, and editable**. It is not a replacement for
your agent instructions file (`AGENTS.md` / `CLAUDE.md`): that file is the
instructions *you* write for the assistant; memory is the notes the *assistant*
keeps for itself.

## Where it lives

```
<your project>/.juggler/MEMORY.md
```

`.juggler/` is git-ignored, so memory is **private to your checkout** — never
committed, never shared with your team, and per-machine. It is a plain Markdown
file you can open and edit in your own editor at any time.

## What it looks like

A single heading over a flat list of dated, one-line facts:

```markdown
# Memory

- [2026-06-14] Build is `make build`, never `go build`
- [2026-06-14] Never commit to git — the user runs all commits
- [2026-06-13] Window geometry lives in the session, not app-side
```

The format is deliberately strict and flat — one fact per bullet, order
preserved as written — which keeps the file easy to skim and to hand-edit. If
you edit it loosely (extra blank lines, a missing date), the assistant tidies it
back to this canonical shape the next time it writes.

## How it gets written

The assistant maintains memory through a single `memory` tool with two actions:

- **`remember`** — record one durable fact (stamped with today's date).
- **`forget`** — remove facts matching a substring. To revise a fact, the
  assistant forgets the old one and remembers the new one.

It is prompted to use `remember` only for things that stay true *across*
sessions — commands, conventions, corrections, architectural constraints — and
*not* for ephemeral within-task state. Every `remember` / `forget` shows up in
the conversation transcript, so you can always see what changed.

## Seeing and editing memory

Memory appears as a **Memory** context item on each conversation (once the file
exists). Open it to see exactly what the assistant currently knows, with each
fact on its own dated row and a delete button to forget it directly.

Because the file is the single source of truth, you have three equivalent ways
to curate it:

1. Click the delete button on any row in the Memory panel.
2. Ask the assistant to `remember` or `forget` something in chat.
3. Open `.juggler/MEMORY.md` in your editor and change it by hand.

All three write the same file, and the panel always shows what it currently
holds.

## When a change takes effect

Each conversation is given the facts **as they stood when that conversation
began**, and keeps that list for its lifetime. A `remember` or `forget` — from
any conversation, or by hand on disk — lands in the file immediately and is
picked up by every conversation started afterwards. Conversations already
running are left alone.

That is deliberate. Memory sits in the system prompt, which is the part of the
request the model provider caches; changing it means the whole conversation has
to be re-read at full price on the next turn. If memory were live, one
`remember` would do that to every open conversation at once — so a fact learned
in a throwaway side chat would silently bill your long-running one. Freezing the
list per conversation keeps a write cheap no matter how many are open.

In practice the running conversation loses nothing: it was the one that just
learned the fact, so the fact is already in its transcript.

## Turning it off

Memory is provided by the `memory` plugin in the Juggler Core extension. Disable
that plugin in the plugin catalog and the tool, the panel, and the system-prompt
guidance all go away; your existing `.juggler/MEMORY.md` is left untouched on
disk.
