import type { AgentSpec, SessionHandle } from '@truefoundry/trueforge-core/agent-session';
import type { VercelAIProviderConfig } from '@truefoundry/trueforge-core/core/llm/VercelAILLM';
import type { RemoteMcpHeaders } from '@truefoundry/trueforge-core/core/mcp/RemoteMCP';
import type { AgentDefinition, ModelParams } from '@truefoundry/trueforge-core/core/runtime/AgentDefinition';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { computerNotUsableMessage } from '../computers/resolveComputer';
import { isTrueFoundryModeEnabled } from '../config';
import type { IMcpServerStore, IMcpServerWithAuthStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { ISkillStore } from '../db/skillStore';
import type { SandboxIntegration, SandboxUsability } from '../sandbox/integration';
import type { ReasoningEffort } from '../schemas/modelProvider';
import type { SandboxBuildStatus } from '../schemas/sandboxProvider';
import { resolveWebSearchProvider } from '../websearch/providers';

export interface McpConnection {
  url: string;
  headers: RemoteMcpHeaders;
}

/** Gateway header carrying stringified JSON metadata. */
export const X_TFY_METADATA = 'x-tfy-metadata';

/** Prefix for harness-owned keys */
export const TFG_METADATA_PREFIX = 'tfg';

const GatewayMetadataSchema = z.record(z.string().min(1), z.string());

/**
 * Parse inbound `x-tfy-metadata`. Rejects malformed values rather than dropping them.
 */
export function parseGatewayMetadataHeader(raw: string): Record<string, string> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new HTTPException(400, { message: `${X_TFY_METADATA} must be a JSON object`, cause: error });
  }
  const parsed = GatewayMetadataSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: `${X_TFY_METADATA} must be a JSON object of string values`,
    });
  }
  return parsed.data;
}

export function buildGatewayMetadata(input: { session: SessionHandle; turnId: string }): Record<string, string> {
  // Session.metadata is intentionally omitted for now (Unicode-in-header risk); re-add later.
  const metadata: Record<string, string> = {
    [`${TFG_METADATA_PREFIX}.session_id`]: input.session.session_id,
    [`${TFG_METADATA_PREFIX}.turn_id`]: input.turnId,
  };
  const { agent } = input.session;
  if (agent.type === 'reference') {
    metadata[`${TFG_METADATA_PREFIX}.agent_id`] = agent.id;
    if (agent.name !== null) {
      metadata[`${TFG_METADATA_PREFIX}.agent_name`] = agent.name;
    }
  }
  return metadata;
}

/** Caller requestMetadata first; harness tfg.* always win */
export function mergeGatewayMetadata(input: {
  session: SessionHandle;
  turnId: string;
  requestMetadata?: Record<string, string> | undefined;
}): Record<string, string> {
  return {
    ...input.requestMetadata,
    ...buildGatewayMetadata({ session: input.session, turnId: input.turnId }),
  };
}

export function gatewayMetadataHeaders(metadata: Record<string, string>): Record<string, string> {
  if (Object.keys(metadata).length === 0) {
    return {};
  }
  return { [X_TFY_METADATA]: JSON.stringify(metadata) };
}

/**
 * Per-turn gateway headers for LLM/MCP calls: harness tfg.* stamps over caller
 * metadata. Empty outside TrueFoundry mode. Every turn start must wire this in.
 */
export function gatewayTurnHeaders(input: {
  session: SessionHandle;
  turnId: string;
  requestMetadata?: Record<string, string> | undefined;
}): Record<string, string> {
  if (!isTrueFoundryModeEnabled()) {
    return {};
  }
  return gatewayMetadataHeaders(mergeGatewayMetadata(input));
}

/**
 * Merge gateway metadata into MCP invoke headers. Preserves authRequired;
 * metadata is applied after auth/per-server headers.
 */
export function withGatewayMetadataHeaders(input: {
  headers: RemoteMcpHeaders;
  metadataHeaders: Record<string, string>;
}): RemoteMcpHeaders {
  const { headers, metadataHeaders } = input;
  if (Object.keys(metadataHeaders).length === 0) {
    return headers;
  }
  if (typeof headers !== 'function') {
    return { ...headers, ...metadataHeaders };
  }
  return async () => {
    const result = await headers();
    if ('authRequired' in result) {
      return result;
    }
    return { headers: { ...result.headers, ...metadataHeaders } };
  };
}

/** Split `provider/model` FQN. Returns undefined when the shape is not exactly one slash. */
export function parseModelFqn(name: string): { providerName: string; modelName: string } | undefined {
  const slash = name.indexOf('/');
  if (slash <= 0 || slash === name.length - 1) {
    return undefined;
  }
  if (name.includes('/', slash + 1)) {
    return undefined;
  }
  return { providerName: name.slice(0, slash), modelName: name.slice(slash + 1) };
}

/**
 * Load turn-ready model config and defaults for a configured FQN (`provider/model`).
 * Malformed FQN or missing provider/model → HTTPException(422).
 */

export async function getModelDetails({
  tenant_id,
  name,
  store,
}: {
  tenant_id: string;
  name: string;
  store: IModelProviderStore;
}): Promise<{
  providerConfig: VercelAIProviderConfig;
  defaultModelParams: ModelParams;
  modelProperties: AgentDefinition['modelProperties'];
  reasoningEfforts: ReasoningEffort[] | undefined;
}> {
  const parsed = parseModelFqn(name);
  if (parsed === undefined) {
    throw new HTTPException(422, {
      message: `Model name must be a fully qualified "provider/model": ${name}`,
    });
  }
  const provider = await store.getProvider({
    tenant_id,
    name: parsed.providerName,
    model_name: parsed.modelName,
  });
  if (provider === undefined) {
    throw new HTTPException(422, {
      message: `Unknown model "${name}" — provider not configured`,
    });
  }
  const model = provider.manifest.models.find(entry => entry.name === parsed.modelName);
  if (model === undefined) {
    throw new HTTPException(422, {
      message: `Unknown model "${name}" — not configured on provider`,
    });
  }
  // Provider types are adapter names, so this assignment is what keeps them so: a type with no
  // `buildLanguageModel` case fails to compile here.
  const { type, base_url: baseUrl } = provider.manifest;
  return {
    providerConfig: {
      provider: { type, name: provider.name },
      model: { id: model.model_id, name: model.name },
      name,
      baseUrl,
      apiKey: provider.manifest.auth?.api_key ?? '',
      headers: {},
    },
    defaultModelParams: model.properties.max_output_tokens ? { max_tokens: model.properties.max_output_tokens } : {},
    modelProperties: { contextLength: model.properties.context_length },
    reasoningEfforts: model.properties.reasoning_efforts,
  };
}

/**
 * Load MCP url + headers for a configured server. Returns undefined when unregistered.
 *
 * TODO: OAuth header resolvers re-run on every RemoteMCP listTools/callTool; cache or gate later.
 */
export async function getMcpConnection({
  tenant_id,
  name,
  store,
  userRef,
}: {
  tenant_id: string;
  name: string;
  store: IMcpServerWithAuthStore;
  userRef: string;
}): Promise<McpConnection | undefined> {
  const record = await store.getServer({ tenant_id, name });
  if (record === undefined) {
    return undefined;
  }
  return {
    url: record.manifest.url,
    headers: store.resolveInvokeHeaders({ record, userRef }),
  };
}

/** Keeps the old wording for "nothing configured" and names the build state otherwise. */
function sandboxNotUsableMessage({
  hasSkills,
  status,
}: {
  hasSkills: boolean;
  status: SandboxBuildStatus | undefined;
}): string {
  const subject = hasSkills ? 'skills require a sandbox' : 'sandbox is enabled';
  switch (status) {
    case 'pending':
      return `${subject}, but the sandbox image is still being prepared — retry shortly`;
    case 'failed':
      return `${subject}, but the sandbox image build failed — re-save the provider at PUT /settings/sandbox-providers`;
    default:
      return hasSkills
        ? 'skills require a sandbox provider — configure via PUT /settings/sandbox-providers'
        : 'sandbox is enabled but no sandbox provider is configured — PUT /settings/sandbox-providers';
  }
}

/**
 * Checking a Daytona build can take a 60 s timeout and then throw. That is the provider being
 * unreachable, not a bad spec, so it is a 503 the caller can retry rather than a generic 500.
 * `GET /capabilities` answers the same outage with the sandbox reported disabled.
 */
async function resolveSandboxUsabilityOrThrow({
  sandboxIntegration,
  sandboxProviderStore,
  tenant_id,
  logger,
  computer_id,
  agent_id,
  skills_requested,
}: {
  sandboxIntegration: SandboxIntegration;
  sandboxProviderStore: ISandboxProviderStore;
  tenant_id: string;
  logger: Logger;
  computer_id: string | undefined;
  agent_id: string | undefined;
  skills_requested: boolean;
}): Promise<SandboxUsability> {
  try {
    return await sandboxIntegration.resolveSandboxUsability({
      store: sandboxProviderStore,
      tenant_id,
      logger,
      computer_id,
      agent_id,
      skills_requested,
    });
  } catch (error) {
    logger.error('Sandbox image status check failed while validating an agent spec', extractErrorLogFields(error));
    throw new HTTPException(503, {
      message: 'sandbox provider is unreachable — could not check its image build status; retry shortly',
      cause: error,
    });
  }
}

/**
 * Cross-checks an AgentSpec against configured models / MCP / skills and
 * sandbox capability. Throws HTTPException(422) for semantic failures.
 * Skills must exist in the skill store (git name) or pass SFY resolve (registry FQN).
 */
export async function validateAgentSpec({
  spec,
  tenant_id,
  agent_id,
  modelProviderStore,
  mcpServerStore,
  skillStore,
  sandboxProviderStore,
  sandboxIntegration,
  logger,
}: {
  spec: AgentSpec;
  tenant_id: string;
  /**
   * The immutable id of the saved agent this spec will belong to, or undefined for an inline spec.
   * Only a saved agent can be granted a computer, and the grant is keyed by this id.
   */
  agent_id: string | undefined;
  modelProviderStore: IModelProviderStore;
  mcpServerStore: IMcpServerStore;
  skillStore: ISkillStore;
  sandboxProviderStore: ISandboxProviderStore;
  sandboxIntegration: SandboxIntegration | undefined;
  logger: Logger;
}): Promise<void> {
  const resolved = await getModelDetails({
    tenant_id,
    name: spec.model.name,
    store: modelProviderStore,
  });
  const reasoningEffort = spec.model.params?.reasoning_effort;
  if (reasoningEffort !== undefined) {
    const efforts = resolved.reasoningEfforts;
    if (!efforts?.some(effort => effort === reasoningEffort)) {
      throw new HTTPException(422, {
        message: efforts
          ? `Reasoning effort "${reasoningEffort}" is not supported by model "${spec.model.name}"`
          : `Model "${spec.model.name}" does not support configurable reasoning effort`,
      });
    }
  }

  const requestedMcpServers = spec.mcp_servers ?? [];
  if (requestedMcpServers.length > 0) {
    const names = requestedMcpServers.map(server => server.name);
    const configuredNames = new Set(
      (
        await mcpServerStore.listServers({
          tenant_id,
          names,
        })
      ).map(record => record.name),
    );
    const unknown = requestedMcpServers.find(server => !configuredNames.has(server.name));
    if (unknown !== undefined) {
      throw new HTTPException(422, {
        message: `Unknown MCP server "${unknown.name}" — not configured`,
      });
    }
  }

  const requestedSkills = spec.skills ?? [];
  if (requestedSkills.length > 0) {
    await skillStore.validateAgentSkills({ tenant_id, skills: requestedSkills });
  }

  const wantsSandbox = spec.config.sandbox.enabled;
  const hasSkills = requestedSkills.length > 0;
  const computerId = spec.config.sandbox.computer_id;
  if (wantsSandbox || hasSkills || computerId !== undefined) {
    // Without an integration a stored record is unusable, so it does not count as configured.
    // Same question GET /capabilities asks, so a spec is never admitted that a turn then rejects.
    const usability =
      sandboxIntegration === undefined
        ? undefined
        : await resolveSandboxUsabilityOrThrow({
            sandboxIntegration,
            sandboxProviderStore,
            tenant_id,
            logger,
            computer_id: computerId,
            agent_id,
            skills_requested: hasSkills,
          });
    if (usability?.usable !== true) {
      throw new HTTPException(422, {
        message:
          computerId === undefined
            ? sandboxNotUsableMessage({ hasSkills, status: usability?.status })
            : computerNotUsableMessage({ computerId, reason: usability?.reason }),
      });
    }
  }

  if (spec.config.web_search.enabled && resolveWebSearchProvider() === undefined) {
    throw new HTTPException(422, {
      message: 'web_search is enabled but no web-search provider is configured',
    });
  }
}
