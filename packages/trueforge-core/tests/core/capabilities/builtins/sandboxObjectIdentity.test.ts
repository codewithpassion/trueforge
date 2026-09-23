import { largeToolResponse } from '../../../../src/core/capabilities/builtins/LargeToolResponse';
import { toolContentText, type ToolContentPart } from '../../../../src/core/llm/LLMTypes';
import type { IToolSet } from '../../../../src/core/mcp/IMCPServer';
import type { ToolCallResult } from '../../../../src/core/mcp/executeToolCalls';
import { getEmptyCurrentContextUsage } from '../../../../src/core/runtime/contextUsage';
import { makeMockIMCPServer, makeSilentLogger, makeStubPublicSandbox } from '../../harnessMocks';

const silentLogger = makeSilentLogger();

const LARGE_CONTENT = 'x'.repeat(50_000);

const SCREENSHOT: ToolContentPart = {
  type: 'image',
  file_id: 'f1',
  media_type: 'image/jpeg',
  width: 1280,
  height: 800,
};

function makeToolResult(
  toolSet: IToolSet,
  name: string,
  content: ToolContentPart[] = [{ type: 'text', text: LARGE_CONTENT }],
): ToolCallResult {
  return {
    message: {
      role: 'tool',
      tool_call_id: 'call-1',
      content,
    },
    info: {
      toolSet,
      originalToolName: name,
    },
    failure: false,
    isStructuredContent: false,
    completedAt: new Date().toISOString(),
  };
}

describe('LargeToolResponse sandbox object identity (ISSUE-035)', () => {
  it('classifies only the exact Sandbox instance as sandbox category', async () => {
    const sandbox = makeStubPublicSandbox();
    const sandboxNamedMcp = makeMockIMCPServer({ name: 'sandbox', preload: true });

    const processor = largeToolResponse({
      dynamicSubAgentsPresent: false,
      settings: { individualTokenThreshold: 100, totalTokenThreshold: 200 },
      logger: silentLogger,
    }).toolResponseProcessors?.[0];
    expect(processor).toBeDefined();
    if (!processor) throw new Error('expected largeToolResponse processor');

    const sandboxResult = makeToolResult(sandbox, 'exec');
    const mcpResult = makeToolResult(sandboxNamedMcp, 'search');

    await processor.process([sandboxResult, mcpResult], {
      threadId: 'main',
      sandbox,
      currentContextUsage: getEmptyCurrentContextUsage(),
      context: [],
    });

    expect(toolContentText(sandboxResult.message.content)).toContain('write to a file');
    expect(toolContentText(mcpResult.message.content)).not.toContain('write to a file');
    expect(toolContentText(mcpResult.message.content)).toContain('Content too big');
  });

  it('offloads only the text of a result and keeps its images', async () => {
    const processor = largeToolResponse({
      dynamicSubAgentsPresent: false,
      settings: { individualTokenThreshold: 100, totalTokenThreshold: 200 },
      logger: silentLogger,
    }).toolResponseProcessors?.[0];
    if (!processor) throw new Error('expected largeToolResponse processor');
    const mcp = makeMockIMCPServer({ name: 'browser', preload: true });
    const withImage = makeToolResult(mcp, 'screenshot', [{ type: 'text', text: LARGE_CONTENT }, SCREENSHOT]);
    const imageOnly = makeToolResult(mcp, 'screenshot', [SCREENSHOT]);

    await processor.process([withImage, imageOnly], {
      threadId: 'main',
      sandbox: undefined,
      currentContextUsage: getEmptyCurrentContextUsage(),
      context: [],
    });

    expect(toolContentText(withImage.message.content)).toContain('Content too big');
    expect(withImage.message.content.filter(part => part.type === 'image')).toEqual([SCREENSHOT]);
    expect(imageOnly.message.content).toEqual([SCREENSHOT]);
  });
});
