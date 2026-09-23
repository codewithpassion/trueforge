import type { ContentBlock, ImageContent } from '@modelcontextprotocol/sdk/types.js';
import type { RegisteredPassthroughEvent } from '../events/PassthroughEvents';
import type { ApprovalDecision, MCPServerInitInfo } from '../events/schema';
import type { SessionFiles } from '../files/SessionFiles';
import {
  textToolContent,
  type InternalEnrichedAssistantMessage,
  type InternalEnrichedToolCall,
  type LLMToolMessage,
  type ToolContentPart,
} from '../llm/LLMTypes';
import type { MCPAuthRequired } from '../mcp/IMCPServer';
import type { AgentThreadCreateSubAgent } from '../runtime/AgentThread.types';
import { InternalEventType } from '../runtime/AgentThread.types';
import type { SandboxInfo } from '../sandbox/Sandbox';
import { describeUnknownError } from '../util/errorLogFields';
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

function imageDimension(meta: ImageContent['_meta'], key: 'width' | 'height'): number | undefined {
  const value = meta?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Stores the bytes in the session's files; the model and the event log only see the reference. */
async function toImagePart({
  image,
  files,
}: {
  image: ImageContent;
  files: SessionFiles | undefined;
}): Promise<ToolContentPart> {
  const width = imageDimension(image._meta, 'width');
  const height = imageDimension(image._meta, 'height');
  if (width === undefined || height === undefined) {
    return { type: 'text', text: '[image omitted: the tool did not report its size]' };
  }
  if (files === undefined) {
    return { type: 'text', text: `[image ${String(width)}x${String(height)} omitted: no file store]` };
  }
  try {
    const { file_id } = await files.put({ media_type: image.mimeType, bytes: Buffer.from(image.data, 'base64') });
    return { type: 'image', file_id, media_type: image.mimeType, width, height };
  } catch (error) {
    return {
      type: 'text',
      text: `[image ${String(width)}x${String(height)} omitted: storing it failed (${describeUnknownError(error)})]`,
    };
  }
}

/** The text blocks joined into one part, as before images were kept, followed by the images. */
async function toToolContent({
  blocks,
  files,
}: {
  blocks: ContentBlock[];
  files: SessionFiles | undefined;
}): Promise<ToolContentPart[]> {
  const text = blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
  const images = await Promise.all(
    blocks.filter(block => block.type === 'image').map(image => toImagePart({ image, files })),
  );
  if (text === '' && images.length === 0) {
    return textToolContent(JSON.stringify(blocks));
  }
  return [...(text === '' ? [] : textToolContent(text)), ...images];
}

export async function executeToolCalls({
  assistantMessage,
  toolMapping,
  threadId,
  approvalDecisions,
  files,
}: {
  assistantMessage: InternalEnrichedAssistantMessage;
  toolMapping: Map<string, MappedMCPTool>;
  threadId: string;
  approvalDecisions: Map<string, ApprovalDecision>;
  /** Where image results are stored; without it they reach the model as a text note. */
  files: SessionFiles | undefined;
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
    } else if (Array.isArray(result.content)) {
      content = await toToolContent({ blocks: result.content, files });
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
