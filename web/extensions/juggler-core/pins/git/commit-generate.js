//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Writing a commit message for what is staged, from one of three sources the
 * user picks:
 *
 * - **a conversation** that made the changes: its digest (the user's messages,
 *   which say why; the turns that touched the files, with the agent's closing
 *   message of each; which files) plus the commit context, in one cheap
 *   `generateText` call;
 * - **the staged diff alone**: the commit context, in one cheap call;
 * - **an agent that explores**: a read-only `runAgent` under the
 *   `subagent-commit-message` strategy, told the repository, the amend, the
 *   house style and the stat, which reads the diff and the files itself.
 *
 * Every prompt asks for exactly what is staged (plus HEAD when amending), in
 * the repository's style, as a summary of 72 characters or fewer, a blank line
 * and an unwrapped body. A reply is cleaned before it is used — fences and
 * wrapping quotes gone, newlines normalised, body paragraphs unwrapped — since
 * the commit box holds the body unwrapped and wraps it when it commits.
 *
 * The prompts are pure functions of the reads; `createGenerator` puts them
 * together with the reads and the model calls. The model calls are this
 * module's `juggler/ops` imports unless a test replaces them
 * (`__setModelCallsForTests`). Everything a model reads here is English.
 * @module pins/git/commit-generate
 */

import { markUntranslated } from 'juggler/i18n';
import { generateText, runAgent } from 'juggler/ops';
import { unwrapBody } from '../../lib/commit-message.js';

/**
 * What a commit message is written from: the `commit-context` read.
 * @typedef {object} CommitContext
 * @property {string} repo - The repository, '' for the root.
 * @property {boolean} amend - Whether it describes an amend of HEAD.
 * @property {string} [headMessage] - HEAD's message, when amending.
 * @property {{path: string, oldPath?: string, status: string}[]} files - The staged files.
 * @property {string} stat - `--stat` of the change.
 * @property {string} diff - The staged patch, cut to size, every cut marked.
 * @property {boolean} truncated - Whether anything was cut.
 * @property {string[]} subjects - Recent subjects, newest first.
 * @property {string} rules - What the project's instruction files say about commits.
 * @property {boolean} wrapsBody - Whether the repository's bodies are wrapped.
 */

/**
 * One conversation's account of why files changed: the digest read.
 * @typedef {object} ConversationDigest
 * @property {string} conv - The conversation.
 * @property {string} title - Its title.
 * @property {string[]} userMessages - Its user messages, oldest first.
 * @property {{user: string, closing: string, files: string[]}[]} turns - The turns that touched the files.
 * @property {boolean} truncated - Whether anything was cut.
 */

/**
 * Where a message is generated from.
 * @typedef {{kind: 'conv', conv: string, title: string, files: string[]}|{kind: 'diff'}|{kind: 'explore'}} GenerateSource
 */

/**
 * @typedef {object} GeneratorDeps
 * @property {(amend: boolean, signal?: AbortSignal) => Promise<CommitContext>} commitContext - Read the commit context.
 * @property {(conv: string, paths: string[], signal?: AbortSignal) => Promise<ConversationDigest>} digest - Read a conversation's digest.
 * @property {() => boolean} amend - Whether the message is for an amend.
 * @property {() => string} repoPath - The repository's absolute path, for the agent.
 * @property {() => string} workspaceId - The workspace the repository is in, '' for the project.
 */

/** The longest a one-shot call may take, in milliseconds. */
const ONE_SHOT_TIMEOUT_MS = 60_000;
/** The output cap for a one-shot call. */
const ONE_SHOT_MAX_TOKENS = 1024;
/** The most model responses the exploring agent may take. */
const EXPLORE_MAX_TURNS = 30;

/** The model calls, replaceable by a test. */
let calls = { generateText, runAgent };

/**
 * Replace the model calls for a test.
 * @param {{generateText?: typeof generateText, runAgent?: typeof runAgent}} replacement - The stand-ins.
 * @returns {() => void} Puts the real ones back.
 */
export function __setModelCallsForTests(replacement) {
  const before = calls;
  calls = { ...calls, ...replacement };
  return () => { calls = before; };
}

/**
 * What every source's instructions say.
 * @param {boolean} amend - Whether the message is for an amend.
 * @returns {string} The system prompt.
 */
function systemPrompt(amend) {
  return markUntranslated([
    'You write git commit messages.',
    '',
    amend
      ? 'This commit amends the last one (HEAD): describe exactly what HEAD changed together with what is staged now, as one commit. HEAD\'s current message is given; your message replaces it, so keep what is still true of it and correct what is not.'
      : 'Describe exactly what is staged, and nothing else: not unstaged work, not plans, not what might come next.',
    '',
    'Match the repository\'s style. Its recent subjects show the tense, length, capitalisation and any prefix convention to follow; commit-message rules quoted from the project\'s instruction files override everything else here.',
    '',
    'Reply with the commit message and nothing else: a summary line of 72 characters or fewer, a blank line, then the body as paragraphs, each paragraph on a single line (do not hard-wrap). Leave the body out when the summary says it all. No code fences, no quotes around it, no preamble, no explanation.',
    '',
    'The diff has been cut to fit, and every cut is marked on a line of its own beginning "[…":',
    '- "[… N more lines of this file\'s diff left out]": the rest of that file\'s diff is not shown.',
    '- "[… N more files left out; the stat lists them]": those files\' diffs are not shown, but the stat lists every file.',
    '- "[binary file: content left out]", "[lock file: …]" and similar: the file changed, its content is not shown.',
    'Describe such changes from the stat and the file names; never guess at content you were not shown.',
  ].join('\n'));
}

/**
 * The staged files, one per line, with git's status letter.
 * @param {CommitContext} ctx - The commit context.
 * @returns {string} The lines.
 */
function fileLines(ctx) {
  return (ctx.files || []).map((f) => `${f.status} ${f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path}`).join('\n');
}

/**
 * The house style: the recent subjects and the project's rules.
 * @param {CommitContext} ctx - The commit context.
 * @returns {string[]} Its sections.
 */
function styleSections(ctx) {
  /** @type {string[]} */
  const out = [];
  if (ctx.subjects?.length) out.push(`Recent commit subjects in this repository, newest first:\n${ctx.subjects.map((s) => `- ${s}`).join('\n')}`);
  else out.push('This repository has no earlier commits to take a style from.');
  if (ctx.rules?.trim()) out.push(`Commit-message rules from the project's instruction files:\n${ctx.rules.trim()}`);
  return out;
}

/**
 * The amend, when there is one: HEAD's message.
 * @param {CommitContext} ctx - The commit context.
 * @returns {string[]} Its section, or none.
 */
function amendSections(ctx) {
  if (!ctx.amend) return [];
  return [`This amends HEAD, whose message is now:\n<<<\n${(ctx.headMessage || '').trim()}\n>>>`];
}

/**
 * Everything the commit context says, for a one-shot prompt.
 * @param {CommitContext} ctx - The commit context.
 * @returns {string} The sections, joined.
 */
function contextPrompt(ctx) {
  return [
    ...amendSections(ctx),
    ...styleSections(ctx),
    `Staged files:\n${fileLines(ctx) || '(none)'}`,
    `Stat:\n${(ctx.stat || '').trimEnd() || '(empty)'}`,
    `Staged diff${ctx.amend ? ' (HEAD and what is staged, against HEAD\'s parent)' : ''}:\n${(ctx.diff || '').trimEnd() || '(empty)'}`,
  ].join('\n\n');
}

/**
 * The prompt for the staged diff alone.
 * @param {CommitContext} ctx - The commit context.
 * @returns {string} The prompt.
 */
function diffPrompt(ctx) {
  return markUntranslated(`${contextPrompt(ctx)}\n\nWrite the commit message.`);
}

/**
 * What a conversation says about why the files changed.
 * @param {ConversationDigest} digest - Its digest.
 * @returns {string} The section.
 */
function digestSection(digest) {
  const parts = [`The changes were made in a conversation with a coding agent, "${digest.title || digest.conv}". It says why they were made.`];
  if (digest.userMessages?.length) {
    parts.push(`The user's messages, oldest first:\n${digest.userMessages.map((m) => `---\n${m.trim()}`).join('\n')}\n---`);
  }
  if (digest.turns?.length) {
    parts.push(`The turns that touched the staged files:\n${digest.turns.map((turn) => [
      `User: ${turn.user.trim()}`,
      `Agent's closing message: ${turn.closing.trim()}`,
      `Files touched: ${turn.files.join(', ')}`,
    ].join('\n')).join('\n\n')}`);
  }
  if (digest.truncated) parts.push('(Some of the conversation was cut to fit.)');
  return parts.join('\n\n');
}

/**
 * The prompt for a conversation that made the changes.
 * @param {CommitContext} ctx - The commit context.
 * @param {ConversationDigest} digest - The conversation's digest.
 * @returns {string} The prompt.
 */
function conversationPrompt(ctx, digest) {
  return markUntranslated(`${digestSection(digest)}\n\n${contextPrompt(ctx)}\n\nWrite the commit message. Take the reasons from the conversation, but describe only what the staged diff shows.`);
}

/**
 * The prompt for the exploring agent: where to look and how to write, not
 * what changed, which it reads for itself.
 * @param {CommitContext} ctx - The commit context.
 * @param {string} repoPath - The repository's absolute path.
 * @returns {string} The prompt.
 */
function explorePrompt(ctx, repoPath) {
  return markUntranslated([
    `Repository: ${repoPath}`,
    ctx.amend
      ? 'This amends HEAD: describe HEAD and what is staged together (`git diff --cached HEAD~1`, or `git show HEAD` with `git diff --cached`); the message replaces HEAD\'s.'
      : 'Describe what is staged (`git diff --cached`), and nothing else.',
    ...amendSections(ctx),
    ...styleSections(ctx),
    `Stat of the change:\n${(ctx.stat || '').trimEnd() || '(empty)'}`,
    'Read the diff and whatever files you need to understand it, then reply with the commit message alone: a summary of 72 characters or fewer, a blank line, and the body as unwrapped paragraphs.',
  ].join('\n\n'));
}

/**
 * The first message of a visible conversation asked for a commit message: the
 * same context, and a request to show the message rather than commit it.
 * @param {CommitContext} ctx - The commit context.
 * @param {ConversationDigest|null} digest - The best attributed conversation's digest, if any.
 * @param {string} repoPath - The repository's absolute path.
 * @returns {string} The message.
 */
function discussPrompt(ctx, digest, repoPath) {
  return markUntranslated([
    `Help me write the commit message for what is staged in ${repoPath}${ctx.amend ? ', amending the last commit' : ''}.`,
    'Don\'t commit or change anything: propose the message here, and we\'ll refine the wording together. It should be a summary of 72 characters or fewer, a blank line, then the body as unwrapped paragraphs.',
    ...(digest ? [digestSection(digest)] : []),
    contextPrompt(ctx),
  ].join('\n\n'));
}

/**
 * Make a reply into the message the box holds: no fences or wrapping quotes,
 * `\n` newlines, no trailing spaces, a blank line after the summary, and the
 * body's paragraphs unwrapped.
 * @param {string} text - The model's reply.
 * @returns {string} The message, '' when there was none.
 */
function cleanReply(text) {
  let s = String(text || '').replace(/\r\n?/g, '\n').trim();
  const fenced = /^(```|~~~)[^\n]*\n([\s\S]*?)\n?\1\s*$/.exec(s);
  if (fenced) s = (fenced[2] || '').trim();
  const quoted = /^(["'“‘`])([\s\S]*)(["'”’`])$/.exec(s);
  if (quoted && s.length > 1) s = (quoted[2] || '').trim();
  const lines = s.split('\n').map((line) => line.replace(/\s+$/, ''));
  if (lines.length > 1 && lines[1]) lines.splice(1, 0, '');
  return unwrapBody(lines.join('\n').replace(/\n{3,}/g, '\n\n')).trim();
}

/**
 * A failure to generate: `busy` when trying again later may well work.
 * @param {string} message - What went wrong.
 * @param {boolean} busy - Whether the model pool was busy.
 * @returns {Error & {busy: boolean}} The error.
 */
function generateError(message, busy) {
  const e = /** @type {Error & {busy: boolean}} */ (new Error(message));
  e.busy = busy;
  return e;
}

/**
 * @param {any} e - A failed one-shot call.
 * @returns {never} Throws it again, marked busy for a full pool or a timeout.
 */
function rethrow(e) {
  if (e?.name === 'AbortError') throw e;
  if (e?.status === 429 || e?.status === 504) e.busy = true;
  throw e;
}

/**
 * @param {string} reply - What came back.
 * @returns {string} It, cleaned, or a throw when nothing is left.
 */
function usable(reply) {
  const message = cleanReply(reply);
  if (!message) throw generateError('The model gave no message.', false);
  return message;
}

/**
 * @param {AbortSignal|undefined} signal - The caller's signal.
 */
function checkAborted(signal) {
  if (signal?.aborted) throw new DOMException('Generation stopped', 'AbortError');
}

/**
 * Put the reads and the model calls together.
 * @param {GeneratorDeps} deps - The reads, and what they are about.
 * @returns {{
 *   generate: (source: GenerateSource, options?: {signal?: AbortSignal, onProgress?: (line: string) => void}) => Promise<string>,
 *   discussMessage: (best: {conv: string, files: string[]}|null, options?: {signal?: AbortSignal}) => Promise<string>,
 * }} The generator.
 */
export function createGenerator(deps) {
  /**
   * @param {GenerateSource} source - Where from.
   * @param {{signal?: AbortSignal, onProgress?: (line: string) => void}} [options] - Stop, and the agent's progress.
   * @returns {Promise<string>} The cleaned message. Rejects with an AbortError
   *   when stopped, and otherwise with an Error whose `busy` says to try again.
   */
  const generate = async (source, options = {}) => {
    const { signal, onProgress } = options;
    const amend = deps.amend();
    const ctx = await deps.commitContext(amend, signal);
    checkAborted(signal);
    if (source.kind === 'explore') {
      const result = await calls.runAgent({
        prompt: explorePrompt(ctx, deps.repoPath()),
        strategy: 'subagent-commit-message',
        model: 'cheap',
        workspaceId: deps.workspaceId(),
        maxTurns: EXPLORE_MAX_TURNS,
        name: `commit-message-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        onProgress: (progress) => { if (progress?.summary) onProgress?.(progress.summary); },
      }, signal);
      checkAborted(signal);
      if (result.status === 'cancelled') throw new DOMException('Generation stopped', 'AbortError');
      if (result.status !== 'completed') {
        throw generateError(result.errorText || result.status, result.errorKind === 'busy' || result.status === 'timeout');
      }
      return usable(result.text);
    }
    let prompt;
    if (source.kind === 'conv') {
      const digest = await deps.digest(source.conv, source.files, signal);
      checkAborted(signal);
      prompt = conversationPrompt(ctx, digest);
    } else {
      prompt = diffPrompt(ctx);
    }
    const reply = await calls.generateText({
      prompt,
      system: systemPrompt(ctx.amend),
      model: 'cheap',
      maxTokens: ONE_SHOT_MAX_TOKENS,
      timeoutMs: ONE_SHOT_TIMEOUT_MS,
    }, signal).catch(rethrow);
    checkAborted(signal);
    return usable(reply?.text || '');
  };

  /**
   * @param {{conv: string, files: string[]}|null} best - The conversation that made most of it, if one did.
   * @param {{signal?: AbortSignal}} [options] - Cancellation.
   * @returns {Promise<string>} The first message for a conversation asked to help.
   */
  const discussMessage = async (best, options = {}) => {
    const ctx = await deps.commitContext(deps.amend(), options.signal);
    const digest = best ? await deps.digest(best.conv, best.files, options.signal).catch(() => null) : null;
    return discussPrompt(ctx, digest, deps.repoPath());
  };

  return { generate, discussMessage };
}
