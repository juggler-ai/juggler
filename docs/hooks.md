# Tool hooks

A tool hook is a rule or a note that applies around every tool call, whatever
strategy is running. Strategies decide how much the agent does without asking;
hooks say what holds regardless. For example:

- "never touch `migrations/` without asking me, even in YOLO"
- "when the sandbox refuses something, tell the model how to diagnose it"

A hook runs at one of two points:

| Event | When | What a hook can do |
|-------|------|--------------------|
| `beforeTool` | After the call's input checks out, before anyone approves it | **Deny** it, make it **ask** you, or add a note |
| `afterTool` | After the tool has run, before its result is saved | Add a note for the model (an extension hook can also mark the call failed) |

There are two ways to write one:

- **A hook file.** A small markdown file in `~/.juggler/hooks/`, with no code.
  It suits anything that comes down to "when this matches, say this" or "when
  this matches, stop".
- **An extension hook.** A class in an extension, for when deciding needs code:
  reading the input properly, running a command, or keeping state. See
  [Extension hooks](#extension-hooks) below.

## Hook files

Each hook is one file in `~/.juggler/hooks/`. The file name without `.md` is the
hook's id, so it must be lowercase letters, digits and hyphens, starting with a
letter. Saving a file reloads it straight away.

The frontmatter says when the hook fires. The body is what it says:

```markdown
---
description: Explain nono sandbox denials
event: afterTool
result: Operation not permitted|EPERM|EACCES
repeat: once-per-thread
---
This looks like a sandbox denial. Run `nono why` to find out which rule denied
it, and offer to update the profile if the access is needed.
```

| Field | Required | Meaning |
|-------|----------|---------|
| `description` | Yes | What the hook does. Shown wherever it acts. |
| `event` | Yes | `beforeTool` or `afterTool`. |
| `tool` | No | Tool names, comma-separated, as the model calls them (e.g. `bash, write_file`). Leave it out to match every tool. |
| `input` | No | A regular expression tested against the call's input, as JSON. |
| `result` | No | A regular expression tested against the result text. `afterTool` only. |
| `isError` | No | `true` for failed calls only, `false` for successful ones only. `afterTool` only. |
| `verdict` | No | `deny` or `ask`. `beforeTool` only. Leave it out and the hook adds its body as a note instead. |
| `repeat` | No | `always` (the default) or `once-per-thread`. With `once-per-thread`, the note is only added if no earlier call in the same thread already has it. |

Patterns are JavaScript regular expressions and are case-insensitive. To match a
character such as `|` or `(` literally, escape it. For a `deny`, the body is the
reason the model is given. For an `ask`, the body is optional and is shown in
the approval card.

Two more examples:

```markdown
---
description: Ask before anything touches migrations
event: beforeTool
input: migrations/
verdict: ask
---
Migrations are shared with production.
```

```markdown
---
description: Never force-push
event: beforeTool
tool: bash
input: push\s+(-f|--force)
verdict: deny
---
Force-pushing is not allowed here. Push normally, or explain why a force-push
is needed and let the user do it.
```

Hook files have **user scope only**: there is no project `.juggler/hooks/`.
Hooks run without anyone invoking them, so a hook file that came with a cloned
repository would be the repository's own text acting on every call you make.
The ones in your home directory are there because you put them there.

A hook file can never **allow** a call. Static text can't tell the calls it
should wave through from the ones it shouldn't, so approving stays with you, a
saved permission rule, or code.

If a hook file is broken (a missing field, or a pattern that won't compile),
Juggler says so when it loads it, and the hook doesn't run.

## What you see

Everything a hook does is recorded on the call it acted on:

- The call's properties panel has a **Hooks** section. For each hook that
  matched, it shows what the hook did (blocked, held, allowed, added a note,
  failed) and the full text of any note or reason.
- A call a hook **held** for you shows the hook's name and reason in its
  approval card.
- A call a hook **allowed** carries a **Hook** approval badge.
- A call a hook **denied** fails, and its result says which hook blocked it and
  why. The model sees that result.

## What the model sees

A note is sent **inside the call's own tool result**, after the tool's output:

```
touch: /etc/hosts: Operation not permitted

<hook-note source="nono-denial">
This looks like a sandbox denial. Run `nono why` ...
</hook-note>
```

So the model reads it as part of what the call returned, before it decides what
to do next. The note is kept on the call in the conversation, so it is also
present in every later request.

## How hooks combine

- All matching hooks run, in this order: extension hooks first, then hook files
  by name.
- When their rulings disagree, **deny** beats **ask**, which beats **allow**.
- A hook's **ask** overrides even a strategy that approves everything. The call
  goes to you, not to an auto-approve reviewer.
- A hook's **allow** counts like a saved permission rule. It can't override a
  strategy that requires approval, and it can't approve a call that must reach
  you anyway (a question for you, a plan, a destructive delete).

## Limits

- Hooks run on the tools the engine executes, which is nearly all of them. They
  don't run on sub-threads (`create_thread`) or the tools Juggler handles
  internally.
- A `beforeTool` hook gets at most 3 seconds (2 by default) and an `afterTool`
  hook at most 30 (5 by default). One that takes longer is treated as having
  failed.
- When a hook fails, the call goes ahead as if it hadn't run, and the failure is
  shown in the call's Hooks section. An extension hook can instead set
  `onError: 'closed'`, which holds the call for you when a `beforeTool` hook
  fails.
- A note is capped at 4,000 characters.

## Extension hooks

An extension provides hooks through `provides.hooks` in its manifest. Each one
is a class extending `HookType` from `juggler/hook-type`. The class declares in
its manifest which calls it wants, and implements `beforeTool` and/or
`afterTool`:

```javascript
import HookType from 'juggler/hook-type';

export default class NoMigrationsHook extends HookType {
  static MANIFEST = {
    id: 'no-migrations',
    name: 'Migrations guard',
    version: '1.0.0',
    description: 'Holds any call that touches migrations/ for approval',
    events: ['beforeTool'],
    match: { input: 'migrations/' }
  };

  beforeTool({ toolName }) {
    return { verdict: 'ask', reason: `${toolName} would touch migrations, which are shared.` };
  }
}
```

The [extension guide](extension_guide.md#hook--policy-and-notes-around-every-tool-call)
covers the full API. `examples/extensions/nono-denials` is a complete hook
extension.
