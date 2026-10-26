//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * shell-streaming.js - Live shell execution over the WebSocket.
 *
 * Every other backend operation is a request/response over `/api/ops/call`
 * (see ops-api.js). This one is not: the bash tool needs output as it is
 * produced, so it opens a shell-start / shell-output / shell-cancel exchange
 * on the WebSocket and keeps a per-shell state machine alive for the duration
 * of the command — output accumulation, an abort listener, a safety-net
 * timeout, and listener teardown on every exit path.
 *
 * It lives beside websocket.js rather than inside the ops catalogue because it
 * is a client of the socket, not of the ops endpoint.
 */

import wsService from './websocket.js';
import { MAX_EXEC_TIMEOUT_MS } from './ops-api.js';

/**
 * @typedef {import('./ops-api.js').ShellExecuteParams} ShellExecuteParams
 */

/**
 * Streaming shell output chunk
 * @typedef {object} ShellStreamChunk
 * @property {string} shellId - Shell execution ID
 * @property {string} data - Output data chunk
 * @property {boolean} done - Whether execution is complete
 * @property {number} [exitCode] - Exit code (only present when done=true)
 * @property {string} [error] - Error message (only present on failure)
 * @property {boolean} [blocked] - Whether the command was refused outright and never ran
 * @property {string} [status] - Liveness status for a silent command: "awaiting-permission" | "running" (non-done, empty data)
 * @property {string} [hint] - Human-readable explanation accompanying status
 * @property {string} [outputFile] - Absolute path to the full-output spill file (only when output was spilled, on the done chunk)
 * @property {number} [outputBytes] - Complete output byte count (only when spilled)
 * @property {boolean} [truncated] - Whether output was truncated and spilled to outputFile
 */

/**
 * Streaming shell execution result
 * @typedef {object} ShellStreamResult
 * @property {string} command - Command that was executed
 * @property {string} stdout - Accumulated stdout (merged with stderr)
 * @property {number} exitCode - Process exit code
 * @property {boolean} success - Whether command succeeded (exitCode === 0)
 * @property {string} [error] - Error message if execution failed
 * @property {boolean} [blocked] - Whether the command was refused outright and never ran
 * @property {boolean} [cancelled] - Whether execution was cancelled via AbortSignal
 * @property {string} [outputFile] - Absolute path to the full-output spill file (only when output was spilled)
 * @property {number} [outputBytes] - Complete output byte count (only when spilled)
 * @property {boolean} [truncated] - Whether output was truncated and spilled to outputFile
 */

/**
 * Execute shell command with streaming output via WebSocket.
 * Output is streamed in real-time via the onOutput callback as chunks arrive.
 * Returns a promise that resolves when the command completes.
 * @param {ShellExecuteParams} params - Command parameters
 * @param {(chunk: ShellStreamChunk) => void} onOutput - Callback for each output chunk
 * @param {AbortSignal} [signal] - Optional AbortSignal to cancel the execution
 * @param {string} [workspaceId] - Workspace to run in; '' (or omitted) is the
 *   project. The id travels rather than the directory for the same reason it
 *   does on /api/ops/call — this command's text was composed by an LLM, and an
 *   id only resolves to somewhere the user registered. The server refuses one it
 *   cannot honour, through the same `Usable` check the ops endpoint uses.
 * @returns {Promise<ShellStreamResult>} Final result when command completes
 */
export async function shellStreaming(params, onOutput, signal, workspaceId) {
  // Validate parameters
  if (!params.command && !params.code) {
    throw new TypeError('command or code is required');
  }

  const command = params.command || params.code || '';

  // Generate unique shell ID
  const shellId = `shell-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

  return new Promise((resolve, reject) => {
    // Accumulated merged stdout/stderr. Resolved values use trimEnd (not
    // trim): a trailing newline from the shell is noise, but leading
    // whitespace/blank lines are real output and must be preserved so the
    // properties panel shows the command's output verbatim.
    let stdout = '';
    let resolved = false;

    // Store abort handler reference for cleanup
    /** @type {(() => void)|null} */
    let abortHandler = null;

    // Safety-net client timeout: the backend already caps at the max exec
    // timeout, but if the worker crashes or the WS disconnects mid-stream we'd
    // otherwise leak the listener and the promise forever. Default to backend
    // cap + 30 s of slack so legitimate long-running commands still finish.
    const backendCapMs = MAX_EXEC_TIMEOUT_MS;
    const slackMs = 30_000;
    const timeoutMs = Math.max(params.timeout || backendCapMs, backendCapMs) + slackMs;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timeoutHandle = null;

    /**
     * Cleanup all listeners
     */
    const cleanup = () => {
      wsService.off('shell-output', handleOutput);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    /**
     * @param {unknown} data
     */
    const handleOutput = (data) => {
      const chunk = /** @type {ShellStreamChunk} */ (data);

      // Ignore events for other shells
      if (chunk.shellId !== shellId) return;

      // Accumulate output
      if (chunk.data) {
        stdout += chunk.data;
      }

      // Call user's callback for streaming display
      if (onOutput && !resolved) {
        onOutput(chunk);
      }

      // Handle completion
      if (chunk.done && !resolved) {
        resolved = true;
        cleanup();

        // Full-output spill accounting, present only when output was spilled.
        const spillFields = chunk.outputFile
          ? { outputFile: chunk.outputFile, outputBytes: chunk.outputBytes, truncated: chunk.truncated }
          : {};

        if (chunk.error) {
          // Error case - still resolve with result, let caller handle. `error`
          // is the only account of what went wrong (a refusal, a bad cwd, a
          // timeout), so it travels with the result rather than being inferred
          // from the exit code, which is 1 for all of them.
          resolve({
            command,
            stdout: stdout.trimEnd(),
            exitCode: chunk.exitCode || 1,
            success: false,
            error: chunk.error,
            ...(chunk.blocked ? { blocked: true } : {}),
            ...spillFields
          });
        } else {
          resolve({
            command,
            stdout: stdout.trimEnd(),
            exitCode: chunk.exitCode || 0,
            success: (chunk.exitCode || 0) === 0,
            ...spillFields
          });
        }
      }
    };

    // Handle abort signal for cancellation
    abortHandler = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        cancelShellStreaming(shellId);
        resolve({
          command,
          stdout: stdout.trimEnd(),
          exitCode: -1,
          success: false,
          cancelled: true
        });
      }
    };

    // Check if already aborted before starting
    if (signal?.aborted) {
      abortHandler();
      return;
    }

    // Listen for abort signal
    if (signal) {
      signal.addEventListener('abort', abortHandler);
    }

    // Register listener
    wsService.on('shell-output', handleOutput);

    // Arm safety-net timeout
    timeoutHandle = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      cancelShellStreaming(shellId);
      resolve({
        command,
        stdout: stdout.trimEnd(),
        exitCode: -1,
        success: false,
        error: `shellStreaming hit client-side safety timeout after ${timeoutMs}ms (worker never sent done)`
      });
    }, timeoutMs);

    // Send shell-start request
    const sent = wsService.sendShellStart(
      shellId,
      params.convId || '',
      command,
      params.cwd,
      params.timeout,
      workspaceId,
      { threadId: params.threadId, toolUseId: params.toolUseId }
    );

    if (!sent) {
      resolved = true;
      cleanup();
      reject(new Error('WebSocket not connected, cannot execute streaming command'));
    }
  });
}

/**
 * Cancel a running streaming shell command. The socket must be the same
 * singleton shellStreaming started the shell on — a cancel sent anywhere
 * else is a silent no-op, and the server-side process then runs on until its
 * timeout reaps it (up to 20 minutes). tool-cancellation-test.js test 5 guards
 * exactly that, by stubbing websocket.js and asserting the frame is sent.
 * @param {string} shellId - Shell ID to cancel
 * @returns {boolean} True if cancel request was sent
 */
export function cancelShellStreaming(shellId) {
  return wsService.sendShellCancel(shellId);
}
