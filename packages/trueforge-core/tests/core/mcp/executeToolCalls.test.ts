import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { createInMemoryFileStore } from '../../../src/agent-session/store/InMemoryFileStore';
import { scopeFileStore } from '../../../src/agent-session/store/SessionFileStore';
import type { SessionFiles } from '../../../src/core/files/SessionFiles';
import type { InternalEnrichedAssistantMessage, ToolContentPart } from '../../../src/core/llm/LLMTypes';
import type { MappedMCPTool } from '../../../src/core/mcp/convertMCPServers';
import { executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import {
  toolImageResultResponse,
  toolResultResponse,
  type CallToolResponse,
  type IToolSet,
} from '../../../src/core/mcp/IMCPServer';
import type { ToolImageSettings } from '../../../src/core/runtime/AgentDefinition';
import { jpegBytes, pngBytes, toBase64 } from '../files/imageFixtures';
import { makeSilentLogger } from '../harnessMocks';

const PNG = pngBytes({ width: 64, height: 48 });
const PNG_B64 = toBase64(PNG);
const JPEG_B64 = toBase64(jpegBytes({ width: 64, height: 48 }));
const MAX_BYTES = 1024;

const IMAGE_PART = { type: 'image', file_id: expect.any(String), media_type: 'image/png', width: 64, height: 48 };

function toolSetReturning(response: CallToolResponse): IToolSet {
  return {
    name: 'desktop',
    id: 'desktop',
    preload: true,
    hasPreloadedTools: true,
    listTools: jest.fn(),
    callTool: jest.fn(() => Promise.resolve(response)),
    toolCallInfo: jest.fn(),
  };
}

function assistantCalling(toolName: string): InternalEnrichedAssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: toolName, arguments: '{}' },
        tool_info: {
          type: 'mcp',
          mcp_server_id: 'desktop',
          mcp_server_name: 'desktop',
          original_tool_name: toolName,
        },
      },
    ],
  };
}

function sessionFiles(): SessionFiles {
  return scopeFileStore({ fileStore: createInMemoryFileStore(), tenant_id: 't1', session_id: 's1' });
}

function settings(files: SessionFiles = sessionFiles()): ToolImageSettings {
  return { files, keep: 5, maxBytes: MAX_BYTES };
}

async function run({
  response,
  toolImages,
}: {
  response: CallToolResponse;
  toolImages: ToolImageSettings | undefined;
}): Promise<ToolContentPart[]> {
  const toolMapping = new Map<string, MappedMCPTool>([
    ['screenshot', { toolSet: toolSetReturning(response), originalToolName: 'screenshot' }],
  ]);
  const { toolCallResults } = await executeToolCalls({
    assistantMessage: assistantCalling('screenshot'),
    toolMapping,
    threadId: 'main',
    approvalDecisions: new Map(),
    toolImages,
    logger: makeSilentLogger(),
  });
  const [result] = toolCallResults;
  if (result === undefined) throw new Error('expected one tool result');
  return result.message.content;
}

function contentResponse(content: ContentBlock[], structuredContent?: Record<string, unknown>): CallToolResponse {
  return {
    result: { content, ...(structuredContent !== undefined ? { structuredContent } : {}) },
    wasInitialized: undefined,
  };
}

function image(data: string, mimeType = 'image/png'): ContentBlock {
  return { type: 'image', data, mimeType };
}

describe('executeToolCalls image results', () => {
  it('stores the image in the session files and returns a reference part', async () => {
    const toolImages = settings();
    const content = await run({
      response: toolImageResultResponse({ data_b64: PNG_B64, width: 64, height: 48, media_type: 'image/png' }),
      toolImages,
    });

    expect(content).toEqual([IMAGE_PART]);
    const [part] = content;
    if (part?.type !== 'image') throw new Error('expected an image part');
    const stored = await toolImages.files.get(part.file_id);
    expect(stored?.media_type).toBe('image/png');
    expect(Array.from(stored?.bytes ?? [])).toEqual(Array.from(PNG));
  });

  it('reads the size from the image header when the tool reports none', async () => {
    const content = await run({ response: contentResponse([image(PNG_B64)]), toolImages: settings() });

    expect(content).toEqual([IMAGE_PART]);
  });

  it('trusts the image header over the size the tool reports', async () => {
    const content = await run({
      response: toolImageResultResponse({ data_b64: PNG_B64, width: 1280, height: 800, media_type: 'image/png' }),
      toolImages: settings(),
    });

    expect(content).toEqual([IMAGE_PART]);
  });

  it('accepts the declared media type in any case', async () => {
    const content = await run({ response: contentResponse([image(PNG_B64, 'IMAGE/PNG')]), toolImages: settings() });

    expect(content).toEqual([IMAGE_PART]);
  });

  it('takes image/jpg as JPEG', async () => {
    const content = await run({ response: contentResponse([image(JPEG_B64, 'image/jpg')]), toolImages: settings() });

    expect(content).toEqual([{ ...IMAGE_PART, media_type: 'image/jpeg' }]);
  });

  it('turns an image larger than the cap into a note without storing it', async () => {
    const files = sessionFiles();
    const put = jest.spyOn(files, 'put');
    const big = new Uint8Array(MAX_BYTES + 1);
    big.set(PNG);

    const content = await run({ response: contentResponse([image(toBase64(big))]), toolImages: settings(files) });

    expect(content).toEqual([{ type: 'text', text: `[image omitted: larger than ${String(MAX_BYTES)} bytes]` }]);
    expect(put).not.toHaveBeenCalled();
  });

  it('turns an image wider or taller than 8000 px into a note without storing it', async () => {
    const files = sessionFiles();
    const put = jest.spyOn(files, 'put');

    const content = await run({
      response: contentResponse([image(toBase64(pngBytes({ width: 8001, height: 600 })))]),
      toolImages: settings(files),
    });

    expect(content).toEqual([{ type: 'text', text: '[image omitted: 8001x600 is wider or taller than 8000 px]' }]);
    expect(put).not.toHaveBeenCalled();
  });

  it('keeps an image of exactly 8000 px on a side', async () => {
    const content = await run({
      response: contentResponse([image(toBase64(pngBytes({ width: 8000, height: 8000 })))]),
      toolImages: settings(),
    });

    expect(content).toEqual([{ ...IMAGE_PART, width: 8000, height: 8000 }]);
  });

  it('turns data that is no known image format into a note', async () => {
    const files = sessionFiles();
    const put = jest.spyOn(files, 'put');

    const content = await run({
      response: contentResponse([image(Buffer.from('not an image at all').toString('base64'))]),
      toolImages: settings(files),
    });

    expect(content).toEqual([{ type: 'text', text: '[image omitted: not a PNG, JPEG, GIF or WebP image]' }]);
    expect(put).not.toHaveBeenCalled();
  });

  it('turns an image whose data does not match its media type into a note', async () => {
    const content = await run({ response: contentResponse([image(JPEG_B64, 'image/png')]), toolImages: settings() });

    expect(content).toEqual([{ type: 'text', text: '[image omitted: the data is not image/png]' }]);
  });

  it('keeps text and image blocks in their original order', async () => {
    const content = await run({
      response: contentResponse([
        { type: 'text', text: 'before' },
        image(PNG_B64),
        { type: 'text', text: 'after' },
        { type: 'text', text: 'more' },
        image(JPEG_B64, 'image/jpeg'),
      ]),
      toolImages: settings(),
    });

    expect(content).toEqual([
      { type: 'text', text: 'before' },
      IMAGE_PART,
      { type: 'text', text: 'after\nmore' },
      { ...IMAGE_PART, media_type: 'image/jpeg' },
    ]);
  });

  it('keeps the images next to structured content', async () => {
    const content = await run({
      response: contentResponse([{ type: 'text', text: '{"ok":true}' }, image(PNG_B64)], { ok: true }),
      toolImages: settings(),
    });

    expect(content).toEqual([{ type: 'text', text: '{"ok":true}' }, IMAGE_PART]);
  });

  it('turns the image into a text note when there is no file store', async () => {
    const content = await run({
      response: toolImageResultResponse({ data_b64: PNG_B64, width: 64, height: 48, media_type: 'image/png' }),
      toolImages: undefined,
    });

    expect(content).toEqual([{ type: 'text', text: '[image omitted: no file store]' }]);
  });

  it('keeps image bytes out of an error result', async () => {
    const response = toolImageResultResponse({ data_b64: PNG_B64, media_type: 'image/png' });
    if (!('result' in response)) throw new Error('expected a result');
    response.result.isError = true;

    const content = await run({ response, toolImages: settings() });

    expect(content).toEqual([{ type: 'text', text: JSON.stringify({ error: [] }) }]);
  });

  it('turns an image it could not store into a text note without the cause', async () => {
    const failing: SessionFiles = {
      put: () => Promise.reject(new Error('bucket https://internal.example/files is down')),
      get: () => Promise.resolve(undefined),
    };
    const content = await run({
      response: toolImageResultResponse({ data_b64: PNG_B64, media_type: 'image/png' }),
      toolImages: settings(failing),
    });

    expect(content).toEqual([{ type: 'text', text: '[image 64x48 omitted: storing it failed]' }]);
  });

  it('leaves a text-only result as one text part', async () => {
    const content = await run({ response: toolResultResponse({ text: 'plain' }), toolImages: settings() });

    expect(content).toEqual([{ type: 'text', text: 'plain' }]);
  });
});
