import type { LLMContextMessage } from '../runtime/AgentThread.types';
import type { LLMRequestMessage } from './ILLM';

/**
 * Keeps the replay fields (thinking_blocks, reasoning_content, tool-call provider_specific_fields),
 * strips only `tool_info`, and omits empty `tool_calls` (OpenAI rejects `tool_calls: []`).
 */
export function toLLMRequestMessage(msg: LLMContextMessage): LLMRequestMessage {
  if (msg.role !== 'assistant') {
    return msg;
  }
  const { tool_calls: toolCalls, ...rest } = msg;
  if (!toolCalls?.length) {
    return rest;
  }
  return {
    ...rest,
    tool_calls: toolCalls.map(({ tool_info: _toolInfo, ...call }) => {
      void _toolInfo;
      return call;
    }),
  };
}
