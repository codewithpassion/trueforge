import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type {
  ExtendedChatCompletionChunk,
  LLMToolMessage,
  RawAssistantMessageWithUsage,
  ToolContentPart,
} from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage, normalizeToolContent } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* finalAnswer(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  return { output: { role: 'assistant', content: 'done' }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

describe('normalizeToolContent', () => {
  it('turns a legacy string into one text part and leaves parts alone', () => {
    expect(normalizeToolContent('legacy')).toEqual([{ type: 'text', text: 'legacy' }]);
    const parts: ToolContentPart[] = [{ type: 'text', text: 'x' }];
    expect(normalizeToolContent(parts)).toBe(parts);
  });
});

describe('AgentThread context replay', () => {
  it('sends a tool result persisted as a plain string as one text part', async () => {
    const bodies: LLMCreateParamsStreaming[] = [];
    const modelClient: ILLM = {
      create: jest.fn((body: LLMCreateParamsStreaming) => {
        bodies.push(body);
        return finalAnswer();
      }),
      createNonStream: jest.fn(),
    };
    const legacyToolMessage: LLMToolMessage = { role: 'tool', tool_call_id: 'c1', content: [] };
    // Snapshots written before tool content became parts hold a string here.
    Reflect.set(legacyToolMessage, 'content', 'legacy result');

    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, instruction: 'test', toolSets: [] },
      context: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
              tool_info: { type: 'mcp', mcp_server_id: 's', mcp_server_name: 's', original_tool_name: 'lookup' },
            },
          ],
        },
        legacyToolMessage,
      ],
    });

    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      void event;
    }

    const toolMessages = (bodies[0]?.messages ?? []).filter(m => m.role === 'tool');
    expect(toolMessages).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'legacy result' }] },
    ]);
    expect(thread.toSnapshot().context[2]).toEqual(toolMessages[0]);
  });

  it('replays a finished sub-agent whose snapshot holds its result as a plain string', async () => {
    const modelClient: ILLM = { create: jest.fn(), createNonStream: jest.fn() };
    const sendToParent: LLMToolMessage = { role: 'tool', tool_call_id: 'spawn-1', content: [] };
    // Snapshots written before tool content became parts hold a string here.
    Reflect.set(sendToParent, 'content', 'sub-agent answer');

    const thread = new AgentThread({
      threadId: 'child',
      title: 'Child',
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, instruction: 'test', toolSets: [] },
      parent: { thread_id: 'main', tool_call_id: 'spawn-1' },
      preComputedCompletion: {
        type: 'done',
        output: {
          type: 'model.message',
          id: 'evt-1',
          thread_id: 'child',
          created_at: '2026-09-24T00:00:00.000Z',
          content: 'sub-agent answer',
        },
        send_to_parent: sendToParent,
      },
    });

    const events = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    const normalized = { role: 'tool', tool_call_id: 'spawn-1', content: [{ type: 'text', text: 'sub-agent answer' }] };
    expect(events).toEqual([expect.objectContaining({ status: 'done', send_to_parent: normalized })]);
    expect(thread.toSnapshot().completion?.send_to_parent).toEqual(normalized);
    expect(modelClient.create).not.toHaveBeenCalled();
  });
});
