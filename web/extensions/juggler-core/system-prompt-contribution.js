//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Juggler Core's system-prompt contribution.
 *
 * Scope: ONLY per-tool usage guidance, each section gated on the plugin that
 * provides the tool (`has(id)`), so the prompt never advertises a tool the user
 * has disabled. This is factual "how to drive these specific tools" text — not
 * persona, tone, or general working style. Tool-independent, opinion-free
 * guidance (identity, working loop, code quality, code references) lives in the
 * editable system-prompt presets instead, where the user can see and change it.
 *
 * The default export is a PURE function of the enabled-plugin set, so its output
 * is cache-stable across turns and strategy changes — it belongs in the cached
 * system-prompt anchor, not the per-turn message stream. Keep additions terse:
 * this text is a permanent resident of every turn's context, billed at the
 * cache-read rate.
 * @module juggler-core/system-prompt-contribution
 */

/**
 * Build Juggler Core's contribution to the system prompt.
 * @param {object} args
 * @param {string[]} args.enabledPluginIds - Capability ids currently enabled
 *   (catalog minus the disabled set). Sections gate on membership.
 * @returns {string} Guidance text (possibly empty), sections separated by blank lines
 */
export default function systemPromptContribution({ enabledPluginIds }) {
  const ids = Array.isArray(enabledPluginIds) ? enabledPluginIds : [];
  const has = (/** @type {string} */ id) => ids.includes(id);

  // Tool Usage — one parent section; each subsection gates on its plugin so
  // the prompt never advertises a tool the user has disabled. Everything here
  // is per-tool guidance; general working style lives in the prompt presets.
  /** @type {string[]} */
  const toolUsage = [];

  // Prefer specialized tools over shelling out to bash.
  /** @type {string[]} */
  const preferLines = [];
  if (has('read-file')) preferLines.push('- **read** for reading files (not cat/head/tail)');
  if (has('write-file')) preferLines.push('- **write** for creating files (not echo/cat)');
  if (has('replace-text')) preferLines.push('- **edit** for editing files (not sed/awk)');
  if (has('search')) preferLines.push('- **grep** for searching file contents (not grep/rg in bash)');
  if (has('glob')) preferLines.push('- **glob** for finding files by name (not find/ls)');
  if (preferLines.length > 0) {
    const lead = has('execute')
      ? '### Prefer specialized tools over bash\nUse the dedicated tool instead of shelling out for the same job:'
      : '### Specialized tools';
    toolUsage.push(lead + '\n' + preferLines.join('\n'));
  }

  // Batching — only meaningful when more than one tool can run; describes how to
  // issue tool calls, so it is per-tool guidance rather than general style.
  /** @type {string[]} */
  const batchLines = [
    '- Call multiple independent tools in parallel',
    '- Read files before editing to understand current state'
  ];
  if (has('batch')) {
    batchLines.push('- Prefer batch_read / batch_grep when reading or searching several files at once');
  }
  toolUsage.push('### Tool Batching\n' + batchLines.join('\n'));

  // Context economy — every tool whose point is doing work without putting it
  // in the transcript, explained once and side by side, because the choice
  // between them (computation vs. judgement) is what the model gets wrong when
  // each is described alone. Each line gates on its own plugin.
  /** @type {string[]} */
  const economyLines = [];
  if (has('explore-code')) {
    economyLines.push(
      '- **Computation → `query_code`.** The answer is computable from the codebase: trace a call chain, ' +
      'find every usage of a symbol, map how a module fits together. One script replaces three or more ' +
      'read/grep/glob calls; only what it returns or prints comes back.'
    );
  }
  if (has('explore-agent')) {
    economyLines.push(
      '- **Judgement about this codebase → `Explore`.** An open question that needs reading and weighing ' +
      '("how does auth work here"). A read-only sub-agent investigates and returns only what it found.'
    );
  }
  if (has('research-agent')) {
    economyLines.push(
      '- **Judgement from the web → `Research`.** A question that takes several sources. A sub-agent ' +
      'searches and reads; only the answer returns.'
    );
  }
  if (has('web-fetch')) {
    economyLines.push(
      '- **One fact from one large page → `WebFetch` with a `prompt`.** Omit `prompt` to read the page yourself.'
    );
  }
  if (has('thread')) {
    economyLines.push(
      '- **A self-contained sub-task → `create_thread`.** It runs in isolation and only its final summary ' +
      'returns. Give `goal` only a very short user-facing label. Put the complete self-contained task and ' +
      'context in `prompt`, and the required contents and shape of the final answer in `resultSpec`. Give each ' +
      'thread one task — never a task list, and never tell it to spawn further threads; run multiple tasks as ' +
      'separate threads yourself.'
    );
  }
  if (economyLines.length > 0) {
    let economy = '### Keeping intermediate work out of context\n' +
      'These tools do work whose intermediate steps never enter this conversation — only the result does. ' +
      'Choose by what the work needs:\n' + economyLines.join('\n');
    if (has('explore-code') && (has('explore-agent') || has('research-agent') || has('thread'))) {
      economy += '\nIf a script could compute the answer exactly, the work is computation, not judgement: ' +
        'write `query_code` rather than delegating it.';
    }
    toolUsage.push(economy);
  }

  if (has('new-conversation')) {
    toolUsage.push(
      '### Spinning off a separate line of work — use new_conversation\n' +
				'When the user asks for a **new conversation, a new tab, or a new chat** (all the same thing), or you ' +
				'want to start a fresh, independent line of work that does not belong in this conversation, call ' +
				'`new_conversation` with the initial `message`. It opens a separate top-level conversation in its own ' +
				'tab, taking the user there if they are still watching this one and have not begun typing. This is NOT ' +
				'create_thread: it is a peer conversation, not a sub-task ' +
				'— it works on its own and never reports back to you, so the message must be self-contained. Leave ' +
				'`autostart` at its default to have it begin immediately; set it false to hand the user a ready-to-send ' +
				'message they can review first.'
    );
  }

  // Planning vs tracking — steer the model between the two checklist tools:
  // `todo` for its own live progress tracking, `plan` for an approval-gated
  // proposal. Gated so it only mentions the tools actually enabled.
  if (has('plan') || has('todo')) {
    /** @type {string[]} */
    const planTrack = ['### Planning vs tracking'];
    if (has('plan') && has('todo')) {
      planTrack.push(
        'For multi-step work, keep a `todo` checklist and update it as you go — exactly one item ' +
        'in_progress at a time, and each call replaces the whole list. Use the `plan` tool only to ' +
        'propose an approach for the user\'s review: plans should be detailed enough to evaluate ' +
        '(steps name the files involved and how the change is verified). Never submit a bare checklist ' +
        'as a plan.'
      );
    } else if (has('todo')) {
      planTrack.push(
        'For multi-step work, keep a `todo` checklist and update it as you go — exactly one item ' +
        'in_progress at a time. Each call replaces the whole list, so include every item.'
      );
    } else {
      planTrack.push(
        'Use the `plan` tool to propose an approach for the user\'s review, then track its execution. ' +
        'Plans should be detailed enough to evaluate: steps name the files involved and how the change ' +
        'is verified.'
      );
    }
    toolUsage.push(planTrack.join('\n'));
  }

  /** @type {string[]} */
  const sections = [];

  if (toolUsage.length > 0) {
    sections.push('## Tool Usage\n\n' + toolUsage.join('\n\n'));
  }

  // Memory — durable, cross-session project facts. Gated on the memory plugin.
  // The tool only gets used if the prompt tells the model when to reach for it;
  // without this, project memory stays empty.
  if (has('memory')) {
    sections.push(
      '## Memory\n' +
				'The `memory` tool keeps durable project facts in `.juggler/MEMORY.md`, already shown at the top ' +
				'of your context every turn (never re-read it). The block is fixed for this conversation — a ' +
				'fact you record now reaches future ones.\n' +
				'- `remember` a durable, cross-session fact worth recalling — a build/test command, a convention, ' +
				'a user correction, a non-obvious constraint. One concise fact per call.\n' +
				'- `forget` (substring match) to drop a stale fact; to revise, forget then remember.\n' +
				'- Not for ephemeral within-task state — only what stays true across sessions.'
    );
  }

  // define_command — offer to save a repeatable workflow as a user-defined slash
  // command. Gated on the plugin so the prompt never advertises it when disabled.
  if (has('define-command')) {
    sections.push(
      '## Custom slash commands\n' +
        'When the user asks to save, name, or repeat a prompt/workflow as a reusable command ' +
        '("make that a slash command", "save this as /review"), offer the `define_command` tool: it ' +
        'writes a user-defined slash command they can invoke with `/name`. The user approves the full ' +
        'definition before it is created.'
    );
  }

  return sections.join('\n\n');
}
