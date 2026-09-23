import type { SessionFiles } from '../files/SessionFiles';
import type { ILLM } from '../llm/ILLM';
import type { LLMUserMessage } from '../llm/LLMTypes';
import type { ResponseFormat } from '../llm/responseFormat';
import type { IToolSet } from '../mcp/IMCPServer';

export type ModelParams = Record<string, unknown>;

/**
 * Static definition of an agent. Represents the authored configuration,
 * not the execution state. Inherited by sub-agent definitions.
 *
 * Model identity lives on `modelClient` (e.g. VercelAILLM providerConfig),
 * not as a parallel string on this definition.
 */
export interface AgentDefinition {
  modelClient: ILLM;
  modelProperties?:
    | {
        /** Maximum combined input/output context for the resolved model, when known. */
        contextLength: number | undefined;
      }
    | undefined;
  instruction?: string | undefined;
  messages?: readonly LLMUserMessage[] | undefined;
  modelParams?: ModelParams | undefined;
  /** Same wire shape as AgentSpec.response_format (Zod ResponseFormat). */
  responseFormat?: ResponseFormat | undefined;
  iterationLimit?: number | undefined;

  toolSets?: readonly IToolSet[] | undefined;

  /** Where tool-result images are stored. Without it, image results reach the model as text notes. */
  toolImages?: ToolImageSettings | undefined;
}

export interface ToolImageSettings {
  files: SessionFiles;
  /**
   * Once a model request would carry more than twice this many tool images, the oldest become
   * text stubs down to this many. Stubbing in batches keeps the cached prompt prefix stable.
   */
  keep: number;
}
