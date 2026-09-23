import type { ChatCompletionCreateParams, ChatCompletionCreateParamsStreaming } from 'openai/resources/chat';
import type {
  ExtendedChatCompletionChunk,
  LLMToolMessage,
  LLMUserMessage,
  RawAssistantMessage,
  RawAssistantMessageWithUsage,
} from './LLMTypes';

export type AgentMetadata = Record<string, string>;

/**
 * What the harness sends a model: its context messages without the harness-only `tool_info`, plus
 * the system prompt. Tool-result images stay file references; the client loads the bytes.
 */
export type LLMRequestMessage =
  { role: 'system'; content: string } | LLMUserMessage | RawAssistantMessage | LLMToolMessage;

/**
 * OpenAI chat-completion request knobs with `model` removed and `messages` replaced by the harness
 * message type. The bound ILLM client owns model identity (e.g. VercelAILLM providerConfig);
 * callers must not invent a model string just to satisfy OpenAI's required field.
 */
export type LLMCreateParams = Omit<ChatCompletionCreateParams, 'model' | 'messages'> & {
  messages: LLMRequestMessage[];
};
export type LLMCreateParamsStreaming = Omit<ChatCompletionCreateParamsStreaming, 'model' | 'messages'> & {
  messages: LLMRequestMessage[];
};

export interface ILLM {
  create(
    body: LLMCreateParamsStreaming,
  ): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown>;
  createNonStream(body: LLMCreateParams): Promise<RawAssistantMessageWithUsage>;
}
