import type { LLMRequestMessage } from '../../llm/ILLM';
import { toolImageStub } from '../../llm/LLMTypes';
import type { AgentCapability } from '../AgentCapability';

/**
 * How many of `count` tool images, oldest first, a request replaces with stubs. Whenever more than
 * twice `keep` are live, the oldest go until `keep` remain, so the stub boundary only moves in
 * batches and a cached prompt prefix survives the requests in between.
 */
export function stubbedToolImageCount({ count, keep }: { count: number; keep: number }): number {
  let stubbed = 0;
  let live = 0;
  for (let i = 0; i < count; i++) {
    live++;
    if (live > 2 * keep) {
      stubbed += live - keep;
      live = keep;
    }
  }
  return stubbed;
}

/** Trims the request only; the thread's stored history keeps every image. */
export function trimToolImages({
  messages,
  keep,
}: {
  messages: LLMRequestMessage[];
  keep: number;
}): LLMRequestMessage[] {
  const count = messages.reduce(
    (total, msg) => total + (msg.role === 'tool' ? msg.content.filter(part => part.type === 'image').length : 0),
    0,
  );
  let remaining = stubbedToolImageCount({ count, keep });
  if (remaining === 0) {
    return messages;
  }
  return messages.map(msg => {
    if (msg.role !== 'tool' || remaining === 0) {
      return msg;
    }
    return {
      ...msg,
      content: msg.content.map(part => {
        if (part.type !== 'image' || remaining === 0) {
          return part;
        }
        remaining--;
        return toolImageStub({ image: part, reason: 'trimmed from the conversation to save space' });
      }),
    };
  });
}

export function toolImageTrimming({ keep }: { keep: number }): AgentCapability {
  return {
    preLLMEphemeralProcessors: [{ processPreLLMEphemeral: messages => trimToolImages({ messages, keep }) }],
  };
}
