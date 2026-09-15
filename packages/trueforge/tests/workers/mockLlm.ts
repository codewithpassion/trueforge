/**
 * OpenAI-compatible chat completions served to the Worker through miniflare's outbound service.
 * The base URL picks the behavior: https://llm.test/<scenario>/v1, where scenario is `text`,
 * `tools-<K>` (K datetime tool calls, then text), `slow` (one delta, then a stalled stream), or
 * `huge` (one reply larger than D1 stores per value).
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

function toolCallReply(input: { toolName: string; callIndex: number }): Response {
  const toolCall = {
    index: 0,
    id: `call_${String(input.callIndex)}`,
    type: 'function',
    function: { name: input.toolName, arguments: '{}' },
  };
  return sse(
    `${chunk({ role: 'assistant', content: null, tool_calls: [toolCall] }, null)}${chunk({}, 'tool_calls')}data: [DONE]\n\n`,
  );
}

/** Bounded so a turn whose Durable Object was torn down cannot hold the test process open. */
const STALL_MS = 20_000;

function stalledReply(signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return sse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk({ role: 'assistant', content: 'thinking' }, null)));
        const end = (): void => {
          clearTimeout(timer);
          controller.close();
        };
        timer = setTimeout(end, STALL_MS);
        signal.addEventListener('abort', end, { once: true });
      },
      cancel() {
        clearTimeout(timer);
      },
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
    return stalledReply(request.signal);
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
