# nono Denials

A hook: policy or observation that runs around every tool call, whichever
strategy is active. This one is for running Juggler inside a
[nono](https://github.com/nolabs-ai/nono) sandbox. When a call fails because the
sandbox refused it, the model is told to run `nono why` and offer to update the
profile, rather than retrying blind or hunting for a way around it.

```bash
juggler ext link ./examples/extensions/nono-denials
JUGGLER_ENGINE_HOST=node nono run --profile juggler --allow-cwd -- juggler --project ~/my-project
```

## How it works

| Manifest field | Does |
|----------------|------|
| `events: ['afterTool']` | Runs after a call, before its result is written |
| `match.result` | Only calls whose result text matches `Operation not permitted\|EPERM\|EACCES` |
| `repeat: 'once-per-thread'` | Says it once per thread, not after every denied call |

`afterTool()` returns `{ note }`. The note is sent to the model **inside that
call's tool result**, after the tool's own output, so the model reads it before it
decides what to do next. The call's properties panel shows it under **Hooks**, so
you can see exactly what the model was told.

## The same thing without code

A hook this simple doesn't need an extension. Put this in
`~/.juggler/hooks/nono-denial.md` instead:

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

Write an extension hook when deciding needs code — reading the input, calling a
command, keeping state. See [`docs/hooks.md`](../../../docs/hooks.md) for both.
