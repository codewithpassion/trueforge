import type { ContentBlock, ImageContent } from '@modelcontextprotocol/sdk/types.js';
import type { RegisteredPassthroughEvent } from '../events/PassthroughEvents';
import type { ApprovalDecision, MCPServerInitInfo } from '../events/schema';
import { readImageHeader } from '../files/imageHeader';
import {
  textToolContent,
  type InternalEnrichedAssistantMessage,
  type InternalEnrichedToolCall,
  type LLMToolMessage,
  type ToolContentPart,
} from '../llm/LLMTypes';
import type { MCPAuthRequired } from '../mcp/IMCPServer';
import type { ToolImageSettings } from '../runtime/AgentDefinition';
import type { AgentThreadCreateSubAgent } from '../runtime/AgentThread.types';
import { InternalEventType } from '../runtime/AgentThread.types';
import type { SandboxInfo } from '../sandbox/Sandbox';
import { extractErrorLogFields } from '../util/errorLogFields';
import type { Logger } from '../util/logger';
import type { MappedMCPTool } from './convertMCPServers';
import {
  isApprovalRequiredResponse,
  isAuthRequired,
  isCallToolResponseCreateSubAgent,
  isClientSideToolRequiredResponse,
  toolResultResponse,
} from './IMCPServer';

export interface ToolCallResult {
  message: LLMToolMessage;
  // Absent only for unknown-tool calls (LLM hallucinated a name not in toolMapping):
  // there is no backing MCP server. Downstream consumers (e.g. LargeToolResponse)
  // gate on `failure: false` before reading `info`, so the absence is naturally
  // short-circuited on the success path.
  info?: MappedMCPTool | undefined;
  failure: boolean;
  isStructuredContent: boolean;
  completedAt: string;
}

export interface ExecuteToolCallsResult {
  toolCallResults: ToolCallResult[];
  initializationInfo: MCPServerInitInfo[];
  createThreadEvents: AgentThreadCreateSubAgent[];
  sandboxCreated: SandboxInfo | undefined;
  authRequirementInfo: MCPAuthRequired[];
  approvalRequiredToolCalls: InternalEnrichedToolCall[];
  clientSideToolCalls: InternalEnrichedToolCall[];
  events: RegisteredPassthroughEvent[];
}

function metaDimension(meta: ImageContent['_meta'], key: 'width' | 'height'): number | undefined {
  const value = meta?.[key];
  return typeof value === 'number' ? value : undefined;
}

function imageNote(reason: string): ToolContentPart {
  return { type: 'text', text: `[image omitted: ${reason}]` };
}

/**
 * Stores the bytes in the session's files; the model and the event log only see the reference.
 * The bytes are checked first: a model request carrying an oversized or undecodable image fails,
 * and would fail again on every later request that replays it.
 */
async function toImagePart({
  image,
  toolImages,
  logger,
}: {
  image: ImageContent;
  toolImages: ToolImageSettings | undefined;
  logger: Logger;
}): Promise<ToolContentPart> {
  if (toolImages === undefined) {
    return imageNote('no file store');
  }
  const { files, maxBytes } = toolImages;
  const lowered = image.mimeType.toLowerCase();
  // A common mislabel for JPEG; the check is there to catch data that is not what it claims.
  const declared = lowered === 'image/jpg' ? 'image/jpeg' : lowered;
  // Four base64 characters carry three bytes, so an oversized image is refused before it is decoded.
  const approxBytes = Math.floor((image.data.length * 3) / 4);
  if (approxBytes > maxBytes) {
    logger.warn('Tool-result image is too large; sending a note', {
      media_type: declared,
      bytes: approxBytes,
      max_bytes: maxBytes,
    });
    return imageNote(`larger than ${String(maxBytes)} bytes`);
  }
  const bytes = Buffer.from(image.data, 'base64');
  const header = readImageHeader(bytes);
  if (header === undefined) {
    logger.warn('Tool-result image is not a PNG, JPEG, GIF or WebP image; sending a note', {
      media_type: declared,
      bytes: bytes.byteLength,
    });
    return imageNote('not a PNG, JPEG, GIF or WebP image');
  }
  if (header.media_type !== declared) {
    logger.warn('Tool-result image data does not match its media type; sending a note', {
      media_type: declared,
      detected_media_type: header.media_type,
    });
    return imageNote(`the data is not ${declared}`);
  }
  const { width, height } = header;
  const metaWidth = metaDimension(image._meta, 'width');
  const metaHeight = metaDimension(image._meta, 'height');
  if ((metaWidth !== undefined && metaWidth !== width) || (metaHeight !== undefined && metaHeight !== height)) {
    logger.warn('Tool-reported image size differs from the image header; using the header', {
      width,
      height,
      meta_width: metaWidth,
      meta_height: metaHeight,
    });
  }
  try {
    const { file_id } = await files.put({ media_type: header.media_type, bytes });
    return { type: 'image', file_id, media_type: header.media_type, width, height };
  } catch (error) {
    // The model and the event log get a note; the cause stays in the logs.
    logger.warn('Could not store a tool-result image', extractErrorLogFields(error));
    return { type: 'text', text: `[image ${String(width)}x${String(height)} omitted: storing it failed]` };
  }
}

/**
 * Text and image blocks in their original order; adjacent text blocks stay one part, as text-only
 * results always were. Other block kinds only show when there is nothing else.
 */
async function toToolContent({
  blocks,
  toolImages,
  logger,
}: {
  blocks: ContentBlock[];
  toolImages: ToolImageSettings | undefined;
  logger: Logger;
}): Promise<ToolContentPart[]> {
  const parts: ToolContentPart[] = [];
  let pendingText: string[] = [];
  const flushText = (): void => {
    if (pendingText.length > 0) {
      parts.push({ type: 'text', text: pendingText.join('\n') });
      pendingText = [];
    }
  };
  for (const block of blocks) {
    if (block.type === 'text') {
      pendingText.push(block.text);
    } else if (block.type === 'image') {
      flushText();
      parts.push(await toImagePart({ image: block, toolImages, logger }));
    }
  }
  flushText();
  return parts.length > 0 ? parts : textToolContent(JSON.stringify(blocks));
}

export async function executeToolCalls({
  assistantMessage,
  toolMapping,
  threadId,
  approvalDecisions,
  toolImages,
  logger,
}: {
  assistantMessage: InternalEnrichedAssistantMessage;
  toolMapping: Map<string, MappedMCPTool>;
  threadId: string;
  approvalDecisions: Map<string, ApprovalDecision>;
  /** Where image results are stored; without it they reach the model as a text note. */
  toolImages: ToolImageSettings | undefined;
  logger: Logger;
}): Promise<ExecuteToolCallsResult> {
  const toolMessages: ToolCallResult[] = [];
  const initializationInfo: MCPServerInitInfo[] = [];
  const createThreadEvents: AgentThreadCreateSubAgent[] = [];
  const authRequirementInfo: MCPAuthRequired[] = [];
  const approvalRequiredToolCalls: InternalEnrichedToolCall[] = [];
  const clientSideToolCalls: InternalEnrichedToolCall[] = [];
  const passthroughEvents: RegisteredPassthroughEvent[] = [];
  let sandboxCreated: SandboxInfo | undefined;

  if (!assistantMessage.tool_calls) {
    return {
      toolCallResults: toolMessages,
      initializationInfo,
      createThreadEvents,
      sandboxCreated,
      authRequirementInfo,
      approvalRequiredToolCalls,
      clientSideToolCalls,
      events: passthroughEvents,
    };
  }

  const toolCallPromises = assistantMessage.tool_calls.map(async toolCall => {
    const toolInfo = toolMapping.get(toolCall.function.name);
    if (!toolInfo) {
      return {
        toolCall,
        toolInfo,
        response: toolResultResponse({ text: `Tool ${toolCall.function.name} not found in tool mapping` }),
        failure: true,
        completedAt: new Date().toISOString(),
      };
    }

    try {
      const args: Record<string, unknown> = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
      const response = await toolInfo.toolSet.callTool(
        {
          name: toolInfo.originalToolName,
          arguments: args,
        },
        approvalDecisions.get(toolCall.id),
      );
      return { toolCall, toolInfo, response, failure: false, completedAt: new Date().toISOString() };
    } catch (error) {
      return {
        toolCall,
        toolInfo,
        response: toolResultResponse({
          text: JSON.stringify({ error: error instanceof Error ? error.message : 'Tool execution failed' }),
          isError: true,
        }),
        failure: true,
        completedAt: new Date().toISOString(),
      };
    }
  });

  const results = await Promise.all(toolCallPromises);
  for (const { toolCall, toolInfo, response, failure, completedAt } of results) {
    if (isCallToolResponseCreateSubAgent(response)) {
      createThreadEvents.push({
        type: InternalEventType.AGENT_CREATE_SUBAGENT,
        thread_id: threadId,
        tool_call_id: toolCall.id,
        agent_info: response.createSubAgent,
      });
      continue;
    }

    if (isAuthRequired(response)) {
      authRequirementInfo.push(response.authRequired);
      // Must still emit a tool result so every tool_call in the assistant message has a
      // matching tool_result in context; otherwise the LLM API rejects the conversation.
      toolMessages.push({
        message: {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: textToolContent('Waiting for user to authenticate. Please try again 1 time.'),
        },
        failure: true,
        info: toolInfo,
        isStructuredContent: false,
        completedAt,
      });
      continue;
    }

    if (isApprovalRequiredResponse(response)) {
      approvalRequiredToolCalls.push(toolCall);
      continue;
    }

    if (isClientSideToolRequiredResponse(response)) {
      clientSideToolCalls.push(toolCall);
      continue;
    }

    const { result, wasInitialized } = response;

    let content: ToolContentPart[];
    let isStructuredContent = false;
    if (result.isError) {
      // Image bytes would only bloat the error text.
      const blocks = Array.isArray(result.content)
        ? result.content.filter(block => block.type !== 'image')
        : result.content;
      content = textToolContent(JSON.stringify({ error: blocks }));
    } else if (result.structuredContent) {
      isStructuredContent = true;
      content = textToolContent(JSON.stringify(result.structuredContent));
      // The structured result stands in for the text blocks, which repeat it; images have no such twin.
      for (const block of Array.isArray(result.content) ? result.content : []) {
        if (block.type === 'image') {
          content.push(await toImagePart({ image: block, toolImages, logger }));
        }
      }
    } else if (Array.isArray(result.content)) {
      content = await toToolContent({ blocks: result.content, toolImages, logger });
    } else {
      content = textToolContent(JSON.stringify(result.content));
    }

    toolMessages.push({
      message: { role: 'tool' as const, tool_call_id: toolCall.id, content },
      failure,
      info: toolInfo,
      isStructuredContent,
      completedAt,
    });
    if (wasInitialized) {
      initializationInfo.push(wasInitialized);
    }
    if (response.sandboxCreated && response.sandboxInfo) {
      sandboxCreated = response.sandboxInfo;
    }
    if (response.events?.length) {
      passthroughEvents.push(...response.events);
    }
  }

  return {
    toolCallResults: toolMessages,
    initializationInfo,
    createThreadEvents,
    sandboxCreated,
    authRequirementInfo,
    approvalRequiredToolCalls,
    clientSideToolCalls,
    events: passthroughEvents,
  };
}
