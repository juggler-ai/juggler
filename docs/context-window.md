# Context windows and compaction

Every model Juggler talks to has a finite context window. This page explains
how Juggler keeps requests inside that window: where the limits come from,
what is checked before each call, and what happens when a conversation
outgrows the window anyway.

## Where the limits come from

**The provider's own numbers are definitive.** Juggler never guesses from a
model's name or marketing page; it uses what the provider reports for the
exact model id you selected:

- **Cloud providers** (Claude, OpenAI, Gemini, OpenRouter, Z.AI, Deepseek, …):
  the context window — and maximum output, when the provider reports one —
  comes from the provider's model catalog. Refreshing the model list in
  settings refreshes these numbers.
- **Ollama:** the window that matters is the one the daemon is *serving* with,
  not the model's training maximum. Juggler probes each model's Modelfile for
  a configured `num_ctx`. When nothing reveals the daemon's setting it assumes
  Ollama's documented default of 4096 — deliberately conservative, because
  over-estimating the window makes the daemon silently truncate your history.
  If you raised your daemon's default (`OLLAMA_CONTEXT_LENGTH`), declare it in
  the provider settings (stored as `ollama_num_ctx`) or via `OLLAMA_NUM_CTX`;
  a Modelfile value always wins over the override.
- **Claude Code custom aliases:** an alias the CLI has never seen has no known
  limit, so the first turn is allowed through and the real limit is learned
  from the provider's response. Learned sizes are cached in
  `~/.juggler/cache/claudecode-model-info.json` (safe to delete; it
  re-learns).
- **Other custom aliases fail closed.** If you type a model id the provider
  doesn't report, Juggler refuses to guess — it does *not* inherit the
  provider's default window. The error tells you to check the model id or
  refresh the provider's model list in settings.

## The output reserve

Every request must leave room for the answer. Juggler reserves, in order of
preference: the model's reported maximum output, or — when only the window is
known — a derived reserve (20k tokens for very large windows, otherwise a
fifth of the window). The same number is sent to the provider as the wire
output cap and charged against the window before sending, so the two never
diverge.

## What is checked before each call

Before any model call, Juggler conservatively estimates the full request
envelope — messages, system prompt, tool definitions, images, framing, and
provider overhead — and refuses to send when *estimate + reserve* exceeds the
window. The estimator is deliberately pessimistic: it over-counts dense
content (hashes, base64, CJK, emoji) because it is not the provider's real
tokenizer. A borderline request can therefore be declined slightly early;
that's the safe direction.

## Automatic recovery

When a conversation still outgrows the window — estimates drift, or the
provider's count differs — Juggler recovers instead of failing the turn:

1. The status line shows *"Summarizing earlier conversation to fit the
   context window"*.
2. The oldest history is summarized into a compaction-summary item; the most
   recent items stay verbatim. Tool calls and their results fold atomically,
   so a pair is never split.
3. A tool result too large to ever fit is summarized in place (marked
   *"[tool result exceeded the model context window and was summarized]"*);
   the tool call and its summary stay paired and visible.
4. The turn is retried once, and the loop continues.

If **your newest message alone** exceeds the window, recovery cannot help and
you get a concise terminal error — nothing is folded. Edits made while a
summary is being built abort the fold rather than clobbering newer content.
Summary and error items carry the operation's accounting (calls, token usage,
duration) in their item data, so you can inspect what the recovery cost.

## Proactive compaction

`/compact` folds a conversation on demand through the same engine the
automatic recovery uses: a bounded map/reduce pinned to your model, capped at
8 reduction passes and 64 hidden calls with a spend ceiling. The fold either
converges to a faithful handoff summary or fails with a typed error — it never
degrades into an unbounded summary-of-a-summary spiral.
