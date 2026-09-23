import { createInMemoryFileStore } from '../../../src/agent-session/store/InMemoryFileStore';
import { scopeFileStore } from '../../../src/agent-session/store/SessionFileStore';
import type { SessionFiles } from '../../../src/core/files/SessionFiles';
import type { InternalEnrichedAssistantMessage } from '../../../src/core/llm/LLMTypes';
import type { MappedMCPTool } from '../../../src/core/mcp/convertMCPServers';
import { executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
import {
  toolImageResultResponse,
  toolResultResponse,
  type CallToolResponse,
  type IToolSet,
} from '../../../src/core/mcp/IMCPServer';
import { makeSilentLogger } from '../harnessMocks';

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const JPEG_B64 = Buffer.from(JPEG_BYTES).toString('base64');

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

async function run({ response, files }: { response: CallToolResponse; files: SessionFiles | undefined }) {
  const toolMapping = new Map<string, MappedMCPTool>([
    ['screenshot', { toolSet: toolSetReturning(response), originalToolName: 'screenshot' }],
  ]);
  const { toolCallResults } = await executeToolCalls({
    assistantMessage: assistantCalling('screenshot'),
    toolMapping,
    threadId: 'main',
    approvalDecisions: new Map(),
    files,
    logger: makeSilentLogger(),
  });
  const [result] = toolCallResults;
  if (result === undefined) throw new Error('expected one tool result');
  return result.message.content;
}

function sessionFiles(): SessionFiles {
  return scopeFileStore({ fileStore: createInMemoryFileStore(), tenant_id: 't1', session_id: 's1' });
}

describe('executeToolCalls image results', () => {
  it('stores the image in the session files and returns a reference part', async () => {
    const files = sessionFiles();
    const content = await run({
      response: toolImageResultResponse({ data_b64: JPEG_B64, width: 1280, height: 800, media_type: 'image/jpeg' }),
      files,
    });

    expect(content).toEqual([
      { type: 'image', file_id: expect.any(String), media_type: 'image/jpeg', width: 1280, height: 800 },
    ]);
    const [part] = content;
    if (part?.type !== 'image') throw new Error('expected an image part');
    const stored = await files.get(part.file_id);
    expect(stored?.media_type).toBe('image/jpeg');
    expect(Array.from(stored?.bytes ?? [])).toEqual(Array.from(JPEG_BYTES));
  });

  it('keeps the text next to the image', async () => {
    const response = toolImageResultResponse({
      data_b64: JPEG_B64,
      width: 10,
      height: 20,
      media_type: 'image/jpeg',
    });
    if (!('result' in response)) throw new Error('expected a result');
    response.result.content.unshift({ type: 'text', text: 'clicked' });

    const content = await run({ response, files: sessionFiles() });

    expect(content).toEqual([
      { type: 'text', text: 'clicked' },
      { type: 'image', file_id: expect.any(String), media_type: 'image/jpeg', width: 10, height: 20 },
    ]);
  });

  it('turns the image into a text note when there is no file store', async () => {
    const content = await run({
      response: toolImageResultResponse({ data_b64: JPEG_B64, width: 1280, height: 800, media_type: 'image/jpeg' }),
      files: undefined,
    });

    expect(content).toEqual([{ type: 'text', text: '[image 1280x800 omitted: no file store]' }]);
  });

  it('turns an image without a reported size into a text note, never base64', async () => {
    const content = await run({
      response: {
        result: { content: [{ type: 'image', data: JPEG_B64, mimeType: 'image/png' }] },
        wasInitialized: undefined,
      },
      files: sessionFiles(),
    });

    expect(content).toEqual([{ type: 'text', text: '[image omitted: the tool did not report its size]' }]);
  });

  it('keeps image bytes out of an error result', async () => {
    const response = toolImageResultResponse({
      data_b64: JPEG_B64,
      width: 1,
      height: 1,
      media_type: 'image/jpeg',
    });
    if (!('result' in response)) throw new Error('expected a result');
    response.result.isError = true;

    const content = await run({ response, files: sessionFiles() });

    expect(content).toEqual([{ type: 'text', text: JSON.stringify({ error: [] }) }]);
  });

  it('turns an image it could not store into a text note without the cause', async () => {
    const failing: SessionFiles = {
      put: () => Promise.reject(new Error('bucket https://internal.example/files is down')),
      get: () => Promise.resolve(undefined),
    };
    const content = await run({
      response: toolImageResultResponse({ data_b64: JPEG_B64, width: 1280, height: 800, media_type: 'image/jpeg' }),
      files: failing,
    });

    expect(content).toEqual([{ type: 'text', text: '[image 1280x800 omitted: storing it failed]' }]);
  });

  it('leaves a text-only result as one text part', async () => {
    const content = await run({ response: toolResultResponse({ text: 'plain' }), files: sessionFiles() });

    expect(content).toEqual([{ type: 'text', text: 'plain' }]);
  });
});
