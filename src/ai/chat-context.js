// Compatibility entry point; group conversation context has its own service.
export { getContextStore, startContextMaintenance, flushContext, captureGroupMessage,
  contextIsCurrent, buildChatContext, recordAssistantReply, searchChatHistory,
  summarizePending } from '../context/service.js';
