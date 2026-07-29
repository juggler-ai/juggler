//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// DefaultSummarizationPrompt is the canonical handoff-summary prompt that seeds
// a folded compaction thread. Go owns this text; the worker ships it to the
// browser in the "ready" bootstrap so both sides summarize from one source. The
// browser keeps a byte-identical fallback in web/js/utils/compaction-utils.js
// (defaultSummarizationPrompt), guarded against drift by a parity test.
const DefaultSummarizationPrompt = `You are creating a handoff summary of the conversation so far. Another instance of yourself will use ONLY this summary (plus the most recent messages) to continue the work seamlessly, so completeness matters more than brevity — never drop information you cannot reconstruct later.

First, in <analysis> tags, walk the conversation chronologically: note each user request, each significant action you took, every error hit and how it was resolved, and what is in flight right now. This is your scratchpad.

Then write the summary with these sections:

1. Intent & explicit requests — the user's goals and EVERY explicit instruction or constraint, quoted or closely paraphrased. Do not summarize these away.
2. Files modified — each path, what changed, and why. Include key signatures, identifiers, and snippets verbatim where they matter.
3. Key technical decisions — what was decided and the reasoning, so the choice isn't relitigated.
4. Errors & fixes — problems encountered and their resolutions, so they aren't repeated.
5. Current state — what is done, what is in progress right now.
6. Next step — the immediate next action, which must follow directly from the most recent work above. If continuing an interrupted task, quote the relevant request verbatim. Do not introduce new direction the user didn't ask for.
7. Open issues — anything unresolved or uncertain.

Be precise and technical within each section; compress prose, never facts. Then call return_result, passing the summary (sections 1–7, not the <analysis>) in its "result" argument.`
