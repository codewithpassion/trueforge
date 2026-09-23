/**
 * Images in tool results: the per-provider-type stub table, the `content` output with `file` parts,
 * and one real image sent through each installed adapter to pin what reaches the wire.
 */
import { createInMemoryFileStore } from '../../../src/agent-session/store/InMemoryFileStore';
import { scopeFileStore } from '../../../src/agent-session/store/SessionFileStore';
import type { SessionFiles, StoredFile } from '../../../src/core/files/SessionFiles';
import type { LLMRequestMessage } from '../../../src/core/llm/ILLM';
import type { ToolContentPart } from '../../../src/core/llm/LLMTypes';
import {
  convertMessages,
  providerAcceptsToolImages,
  VercelAILLM,
  type VercelAIProviderName,
} from '../../../src/core/llm/VercelAILLM';
import { setOutboundPolicy } from '../../../src/core/util/outboundFetch';
import { makeSilentLogger } from '../harnessMocks';

const IMAGE_PROVIDERS = ['anthropic', 'openai', 'google-gemini'] as const satisfies readonly VercelAIProviderName[];
const STUB_PROVIDERS = [
  'fireworks',
  'zai',
  'together',
  'custom',
  'truefoundry',
  'moonshot',
  'alibaba',
] as const satisfies readonly VercelAIProviderName[];

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const JPEG_B64 = Buffer.from(JPEG_BYTES).toString('base64');
const STUB = '[screenshot 1280x800 omitted: model does not accept images in tool results]';

function screenshotConversation(fileId: string): LLMRequestMessage[] {
  const content: ToolContentPart[] = [
    { type: 'text', text: 'clicked' },
    { type: 'image', file_id: fileId, media_type: 'image/jpeg', width: 1280, height: 800 },
  ];
  return [
    { role: 'user', content: 'take a screenshot' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'computer_screenshot', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content },
  ];
}

function toolOutput({
  provider,
  images,
}: {
  provider: VercelAIProviderName;
  images: ReadonlyMap<string, StoredFile>;
}): unknown {
  const { messages } = convertMessages({
    messages: screenshotConversation('f1'),
    provider,
    providerName: provider,
    images,
  });
  const tool = messages.find(m => m.role === 'tool');
  if (tool?.role !== 'tool') throw new Error('expected a tool message');
  const [result] = tool.content;
  if (result?.type !== 'tool-result') throw new Error('expected a tool result');
  return result.output;
}

describe('providerAcceptsToolImages', () => {
  it('lets only anthropic, openai and google carry images in tool results', () => {
    expect(IMAGE_PROVIDERS.map(providerAcceptsToolImages)).toEqual([true, true, true]);
    expect(STUB_PROVIDERS.map(providerAcceptsToolImages)).toEqual(STUB_PROVIDERS.map(() => false));
  });
});

describe('convertMessages with tool-result images', () => {
  const loaded = new Map<string, StoredFile>([['f1', { bytes: JPEG_BYTES, media_type: 'image/jpeg' }]]);

  it.each(IMAGE_PROVIDERS)('%s gets a file part', provider => {
    expect(toolOutput({ provider, images: loaded })).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'clicked' },
        { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: JPEG_BYTES } },
      ],
    });
  });

  it.each(STUB_PROVIDERS)('%s gets the text stub', provider => {
    expect(toolOutput({ provider, images: loaded })).toEqual({ type: 'text', value: `clicked\n${STUB}` });
  });

  it('stubs an image whose file could not be loaded', () => {
    expect(toolOutput({ provider: 'anthropic', images: new Map() })).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'clicked' },
        { type: 'text', text: '[screenshot 1280x800 omitted: the image file could not be loaded]' },
      ],
    });
  });

  it('keeps the plain text output for a text-only result', () => {
    const { messages } = convertMessages({
      messages: [{ role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'plain' }] }],
      provider: 'anthropic',
      providerName: 'anthropic',
      images: new Map(),
    });
    expect(messages[0]?.content).toEqual([expect.objectContaining({ output: { type: 'text', value: 'plain' } })]);
  });
});

describe('VercelAILLM sends tool-result images through each adapter', () => {
  let requestBodies: string[] = [];

  beforeEach(() => {
    requestBodies = [];
    const capture: typeof fetch = (_input, init) => {
      requestBodies.push(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'captured', type: 'invalid_request_error' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    setOutboundPolicy({ fetch: capture, mcpFetch: capture, assertUrl: () => Promise.resolve() });
  });

  afterAll(() => {
    const platformFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
    setOutboundPolicy({ fetch: platformFetch, mcpFetch: platformFetch, assertUrl: () => Promise.resolve() });
  });

  async function sendScreenshot(provider: VercelAIProviderName): Promise<{ body: string; files: SessionFiles }> {
    const files = scopeFileStore({ fileStore: createInMemoryFileStore(), tenant_id: 't1', session_id: 's1' });
    const { file_id } = await files.put({ media_type: 'image/jpeg', bytes: JPEG_BYTES });
    const get = jest.spyOn(files, 'get');
    const llm = new VercelAILLM({
      providerConfig: {
        provider: { type: provider, name: provider },
        model: { id: 'test-model', name: 'test-model' },
        name: provider,
        baseUrl: 'http://llm.test/v1',
        apiKey: 'sk-test',
        headers: {},
      },
      logger: makeSilentLogger(),
      files,
    });
    await expect(llm.createNonStream({ messages: screenshotConversation(file_id) })).rejects.toThrow();
    expect(requestBodies).toHaveLength(1);
    // Adapters that cannot carry the image never cost a file read.
    expect(get).toHaveBeenCalledTimes(providerAcceptsToolImages(provider) ? 1 : 0);
    return { body: requestBodies[0] ?? '', files };
  }

  // Each adapter's own image shape inside the tool result, next to the bytes themselves.
  it.each([
    ['anthropic', '"type":"image"'],
    ['openai', '"type":"input_image"'],
    ['google-gemini', '"inlineData"'],
  ] as const)('%s puts the image bytes in the request', async (provider, marker) => {
    const { body } = await sendScreenshot(provider);
    expect(body).toContain(JPEG_B64);
    expect(body).toContain(marker);
    expect(body).not.toContain('omitted');
  });

  it.each(STUB_PROVIDERS)('%s gets the stub and no image bytes', async provider => {
    const { body } = await sendScreenshot(provider);
    expect(body).toContain(STUB);
    expect(body).not.toContain(JPEG_B64);
  });
});
