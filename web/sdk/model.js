//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/model` — the conversation data model surface: message constructors,
 * type/state enums, message predicates, and the compaction lifecycle helpers a
 * strategy or command needs to read/segment a thread.
 */

// Message constructors, enums and predicates
export {
  MESSAGE_TYPES,
  TOOL_STATES,
  RESULT_TYPES,
  ACTION_STATES,
  isUserMessage,
  isAssistantMessage,
  isThinkingMessage,
  isToolUseMessage,
  isToolResultMessage,
  isToolActionMessage,
  isGuidanceMessage,
  isSystemReminderMessage,
  isErrorMessage,
  isThreadMessage,
  isConversationalItemType,
  createUserMessage,
  createAssistantMessage,
  createToolActionMessage,
  createContextItemMessage,
  createErrorMessage,
  createGuidanceMessage,
  createSystemReminderMessage,
  createThreadMessage,
} from './lib/message.js';

// Compaction lifecycle (used by /compact-style commands)
export {
  defaultSummarizationPrompt,
  getContentMessages,
  isCompactionPending,
  startCompaction,
  endCompaction,
  compactConversation,
} from '../js/utils/compaction-utils.js';
