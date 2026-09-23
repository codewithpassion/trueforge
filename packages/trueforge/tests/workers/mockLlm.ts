/**
 * OpenAI-compatible chat completions served to the Worker through miniflare's outbound service.
 * The base URL picks the behavior: https://llm.test/<scenario>/v1, where scenario is `text`,
 * `tools-<K>` (K datetime tool calls, then text), `ask-<K>` (K `ask_user_question` calls in ONE
 * message, so the turn pauses holding all of them, then text), `sandbox` (one sandbox exec, then
 * text), `desktop` (one `computer_screenshot`, then text), `slow` (one delta, then a stalled stream), `gap` (one delta, a second after `GAP_MS`,
 * then a stalled stream), `delay-<ms>` (a text reply after ms), or `huge` (one reply larger than
 * D1 stores per value).
 */
export const HUGE_REPLY_BYTES = 2_100_000;

interface ChatRequestBody {
  messages?: { role?: string }[];
  tools?: { function?: { name?: string } }[];
}

function isChatRequestBody(value: unknown): value is ChatRequestBody {
  return typeof value === 'object' && value !== null;
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  })}\n\n`;
}

function sse(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function textReply(text: string): Response {
  return sse(`${chunk({ role: 'assistant', content: text }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`);
}

interface MockToolCall {
  name: string;
  arguments: string;
}

/** One assistant message carrying every call, which is what makes a turn hold more than one. */
function toolCallsReply(calls: MockToolCall[]): Response {
  const toolCalls = calls.map((call, index) => ({
    index,
    id: `call_${String(index + 1)}`,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }));
  return sse(
    `${chunk({ role: 'assistant', content: null, tool_calls: toolCalls }, null)}${chunk({}, 'tool_calls')}data: [DONE]\n\n`,
  );
}

function toolCallReply(input: { toolName: string; callIndex: number; args?: Record<string, string> }): Response {
  const toolCall = {
    index: 0,
    id: `call_${String(input.callIndex)}`,
    type: 'function',
    function: { name: input.toolName, arguments: JSON.stringify(input.args ?? {}) },
  };
  return sse(
    `${chunk({ role: 'assistant', content: null, tool_calls: [toolCall] }, null)}${chunk({}, 'tool_calls')}data: [DONE]\n\n`,
  );
}

function namedTool(body: ChatRequestBody, fragment: string): string | undefined {
  return (body.tools ?? []).map(tool => tool.function?.name).find(name => name?.includes(fragment));
}

/** Bounded so a turn whose Durable Object was torn down cannot hold the test process open. */
const STALL_MS = 20_000;

/** Long enough for a test to cancel its reader after the first delta and before the second. */
export const GAP_MS = 5_000;

function stalledReply({ signal, secondDeltaAfterMs }: { signal: AbortSignal; secondDeltaAfterMs?: number }): Response {
  const encoder = new TextEncoder();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const clearTimers = (): void => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
  };
  return sse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk({ role: 'assistant', content: 'thinking' }, null)));
        const end = (): void => {
          clearTimers();
          controller.close();
        };
        if (secondDeltaAfterMs !== undefined) {
          timers.push(
            setTimeout(() => {
              controller.enqueue(encoder.encode(chunk({ content: ' still thinking' }, null)));
            }, secondDeltaAfterMs),
          );
        }
        timers.push(setTimeout(end, STALL_MS));
        signal.addEventListener('abort', end, { once: true });
      },
      cancel: clearTimers,
    }),
  );
}

export async function handleMockLlmRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/([^/]+)\/v1\/chat\/completions$/.exec(url.pathname);
  if (url.hostname !== 'llm.test' || match?.[1] === undefined) {
    return new Response(`Unexpected outbound request: ${request.method} ${request.url}`, { status: 599 });
  }
  const scenario = match[1];
  const body: unknown = await request.json();
  if (!isChatRequestBody(body)) {
    return new Response('Expected a JSON body', { status: 400 });
  }

  if (scenario === 'text') {
    return textReply('Hello from the mock model.');
  }
  if (scenario === 'huge') {
    return textReply('x'.repeat(HUGE_REPLY_BYTES));
  }
  if (scenario === 'slow') {
    return stalledReply({ signal: request.signal });
  }
  if (scenario === 'gap') {
    return stalledReply({ signal: request.signal, secondDeltaAfterMs: GAP_MS });
  }
  const delayed = /^delay-(\d+)$/.exec(scenario);
  if (delayed?.[1] !== undefined) {
    await new Promise(resolve => setTimeout(resolve, Number(delayed[1])));
    return textReply('Hello after a delay.');
  }
  if (scenario === 'sandbox') {
    const done = (body.messages ?? []).filter(message => message.role === 'tool').length;
    const toolName = (body.tools ?? []).map(tool => tool.function?.name).find(name => name?.endsWith('exec'));
    if (done > 0 || toolName === undefined) {
      return textReply(`Finished after ${String(done)} sandbox calls.`);
    }
    return toolCallReply({
      toolName,
      callIndex: 1,
      args: { intent: 'check the Code Mode client', command: 'mcp-client call-tool context7 query-docs {}' },
    });
  }
  if (scenario === 'desktop') {
    const done = (body.messages ?? []).filter(message => message.role === 'tool').length;
    const toolName = namedTool(body, 'computer_screenshot');
    if (done > 0 || toolName === undefined) {
      return textReply(`Finished after ${String(done)} desktop calls.`);
    }
    return toolCallReply({ toolName, callIndex: 1 });
  }
  const asks = /^ask-(\d+)$/.exec(scenario);
  if (asks?.[1] !== undefined) {
    const askName = namedTool(body, 'ask_user_question');
    const answered = (body.messages ?? []).filter(message => message.role === 'tool').length;
    if (answered > 0 || askName === undefined) {
      return textReply('Finished after the question.');
    }
    // One message carrying them all, which is what makes the turn hold more than one call.
    return toolCallsReply(
      Array.from({ length: Number(asks[1]) }, (_unused, index) => ({
        name: askName,
        arguments: JSON.stringify({ question: `Question ${String(index + 1)}?`, options: ['staging', 'production'] }),
      })),
    );
  }
  const toolCalls = /^tools-(\d+)$/.exec(scenario);
  if (toolCalls?.[1] !== undefined) {
    const wanted = Number(toolCalls[1]);
    const done = (body.messages ?? []).filter(message => message.role === 'tool').length;
    const toolName = (body.tools ?? [])
      .map(tool => tool.function?.name)
      .find(name => name?.includes('current_datetime'));
    if (done >= wanted || toolName === undefined) {
      return textReply(`Finished after ${String(done)} tool calls.`);
    }
    return toolCallReply({ toolName, callIndex: done + 1 });
  }
  return new Response(`Unknown mock scenario: ${scenario}`, { status: 404 });
}
