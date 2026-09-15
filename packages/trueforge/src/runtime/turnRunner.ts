import {
  CancellationReason,
  EventType,
  SessionStoreNotFoundError,
  TurnResourceResolver,
  type SessionHandle,
  type Turn,
  type TurnHandle,
  type TurnInputItem,
  type TurnRecordWithoutSnapshot,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { VercelAILLM } from '@truefoundry/trueforge-core/core/llm/VercelAILLM';
import { redisKey } from '@truefoundry/trueforge-core/core/redisKeys';
import { isAgentInputUserMessage, isFileContentPart } from '@truefoundry/trueforge-core/core/runtime/UserInputMessage';
import { existingSandboxIdForProvider } from '@truefoundry/trueforge-core/core/sandbox/sandboxRef';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import { HTTPException } from 'hono/http-exception';
import configuration, { isTrueFoundryModeEnabled } from '../config';
import type { SandboxIntegration } from '../sandbox/integration';
import type { ActiveTurnRegistry } from './activeTurns';
import type { EventSubscription, EventSubscriptionRegistry } from './event-subscription';
import {
  buildGatewayMetadata,
  gatewayMetadataHeaders,
  getMcpConnection,
  getModelDetails,
  withGatewayMetadataHeaders,
} from './sessionResources';
import type { TurnStores } from './turnExecutor';

export function toWireTurn(record: TurnRecordWithoutSnapshot): Turn {
  return {
    id: record.turn_id,
    session_id: record.session_id,
    previous_turn_id: record.previous_turn_id,
    input: record.input,
    state: record.state,
    created_at: record.created_at.toISOString(),
  };
}

/**
 * Deps needed to create a turn and drain events in-process (no HTTP). Carries already-resolved
 * stores; callers must resolve them from the request context (e.g. schedule `resolveTurnDeps(c, agent)`)
 * so TrueFoundry mode stays token-bound for models, MCP, and skills.
 */
export type BeginTurnExecutionDeps = TurnStores & {
  activeTurns: ActiveTurnRegistry;
  /** Resumable live turn-event transport: create-turn writes, subscribe polls. */
  eventSubscriptions: Pick<EventSubscriptionRegistry<TurnStreamingEvent>, 'get'>;
  logger: Logger;
  sandboxIntegration: SandboxIntegration | undefined;
};

/**
 * Builds the per-turn resolver. Agent / MCP / sandbox / LLM lookups are wired
 * the same way: async factories over the corresponding stores.
 */
function createTurnResolver(
  deps: TurnStores & {
    sandboxIntegration: SandboxIntegration | undefined;
    logger: Logger;
    signal: AbortSignal;
    userRef: string;
    session: SessionHandle;
    turnId: string;
  },
): TurnResourceResolver {
  const {
    mcpServerStore,
    skillStore,
    sandboxProviderStore,
    agentStore,
    modelProviderStore,
    sandboxIntegration,
    logger,
    signal,
    userRef,
    session,
    turnId,
  } = deps;
  const tenant_id = session.tenant_id;
  const sessionId = session.session_id;
  const metadataHeaders = isTrueFoundryModeEnabled()
    ? gatewayMetadataHeaders(buildGatewayMetadata({ session, turnId }))
    : {};

  return new TurnResourceResolver({
    llm: async name => {
      const resolved = await getModelDetails({
        tenant_id,
        name,
        store: modelProviderStore,
      });
      return {
        modelClient: new VercelAILLM({
          providerConfig: {
            ...resolved.providerConfig,
            headers: { ...resolved.providerConfig.headers, ...metadataHeaders },
          },
          logger,
          signal,
        }),
        defaultModelParams: resolved.defaultModelParams,
        modelProperties: resolved.modelProperties,
      };
    },
    mcp: async name => {
      const connection = await getMcpConnection({
        tenant_id,
        name,
        store: mcpServerStore,
        userRef,
      });
      if (connection === undefined) {
        throw new HTTPException(422, {
          message: `Unknown MCP server "${name}" — not configured`,
        });
      }
      return {
        url: connection.url,
        headers: withGatewayMetadataHeaders({
          headers: connection.headers,
          metadataHeaders,
        }),
      };
    },
    mcpRequestTimeoutMs: configuration.MCP_REQUEST_TIMEOUT_MS,
    mcpConnectTimeoutMs: configuration.MCP_CONNECT_TIMEOUT_MS,
    // Stays wired without an integration so sandbox-enabled specs get the 422 below instead of running sandbox-less.
    sandboxProvider: async ({ spec, existingSandboxId, tracing }) => {
      const provider = await sandboxIntegration?.resolveProvider({
        tenant_id,
        store: sandboxProviderStore,
        logger,
        sessionId,
      });
      if (sandboxIntegration === undefined || provider === undefined) {
        throw new HTTPException(422, {
          message: 'no sandbox provider configured — PUT /settings/sandbox-providers',
        });
      }
      const carriedSandboxId = existingSandboxIdForProvider({
        existingSandboxId,
        currentProviderType: provider.type,
      });
      // A fresh Daytona sandbox is cloned from the release snapshot, so the build must be ready first.
      // Restoring an existing sandbox goes through daytona.get and never touches the snapshot.
      // Local fallback has no image build.
      if (carriedSandboxId === undefined && provider.type !== 'local') {
        const status = await sandboxIntegration.checkSnapshotStatus({ store: sandboxProviderStore, tenant_id, logger });
        if (status?.status !== 'ready') {
          throw new HTTPException(422, {
            message:
              status?.status === 'failed'
                ? `sandbox image build failed (${status.status_reason ?? 'unknown error'})`
                : 'sandbox image is activating — retry shortly',
          });
        }
      }
      const skills = spec.skills ?? [];
      const mountSkills =
        skills.length === 0
          ? []
          : await skillStore.resolveTurnSkills({
              tenant_id,
              skills,
            });
      return sandboxIntegration.buildTurnSandbox({
        provider,
        logger,
        skills: mountSkills,
        fileDownloadEnabled: spec.config.sandbox.file_downloads,
        existingSandboxId: carriedSandboxId,
        tracing,
      });
    },
    agent: async agentId => {
      const record = await agentStore.getAgent({ tenant_id, id: agentId });
      if (record === undefined) {
        throw new HTTPException(422, { message: `Agent not found: ${agentId}` });
      }
      return record.manifest;
    },
    logger,
  });
}

const MAX_SESSION_TITLE_LENGTH = 50;

/**
 * Derives a session title from the first user message of the first turn. Returns the
 * trimmed text (capped at {@link MAX_SESSION_TITLE_LENGTH}) or `undefined` when no usable
 * text is present (e.g. file-only or tool-approval input).
 */
export function deriveSessionTitle(input: TurnInputItem[] | undefined): string | undefined {
  const firstUserMessage = input?.find(isAgentInputUserMessage);
  if (!firstUserMessage) {
    return undefined;
  }

  const text =
    typeof firstUserMessage.content === 'string'
      ? firstUserMessage.content
      : firstUserMessage.content
          .filter(part => !isFileContentPart(part))
          .map(part => part.text)
          .join(' ');

  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, MAX_SESSION_TITLE_LENGTH);
}

/**
 * turn.created arms the active-run TTL, turn.done shortens it to the
 * post-completion drain window; mid-run events leave the TTL untouched.
 */
export function streamTTLSecondsFor(event: TurnStreamingEvent): number | undefined {
  if (event.type === EventType.TURN_CREATED) {
    return configuration.TURN_STREAM_TTL_SECONDS;
  }
  if (event.type === EventType.TURN_DONE) {
    return configuration.TURN_STREAM_POST_COMPLETION_TTL_SECONDS;
  }
  return undefined;
}

/** Redis/in-memory key for one turn's resumable event stream. */
export function turnStreamId(tenantId: string, sessionId: string, turnId: string): string {
  return redisKey('agent', 'turn', tenantId, sessionId, turnId, 'stream');
}

/**
 * Dual-write turn events to the resumable subscription registry, then optionally
 * forward each sequenced event (SSE path). Shared by streaming and non-streaming
 * create-turn; the HTTP response lifecycle does not own execution.
 */
export async function drainTurnEvents(input: {
  trackedStream: AsyncIterable<TurnStreamingEvent>;
  turnEventStream: EventSubscription<TurnStreamingEvent>;
  sessionId: string;
  turnId: string;
  maxExecutionTimer: NodeJS.Timeout;
  logger: Logger;
  onEvent?: (event: TurnStreamingEvent, sequenceNumber: number) => Promise<void>;
}): Promise<void> {
  const { trackedStream, turnEventStream, sessionId, turnId, maxExecutionTimer, logger, onEvent } = input;
  try {
    for await (const event of trackedStream) {
      // Dual-write before any client sink so subscribers can resume after disconnect.
      const sequenceNumber = await turnEventStream.put(event, {
        streamTTLSeconds: streamTTLSecondsFor(event),
      });
      await onEvent?.(event, sequenceNumber);
    }
  } catch (error) {
    if (error instanceof SessionStoreNotFoundError) {
      logger.warn('Turn stream ended after session/turn was removed', {
        sessionId,
        turnId,
        ...extractErrorLogFields(error),
      });
    } else {
      logger.error('Unexpected error in turn event drain', {
        sessionId,
        turnId,
        ...extractErrorLogFields(error),
      });
    }
  } finally {
    clearTimeout(maxExecutionTimer);
  }
}

/** Inputs for {@link drainTurnEvents} produced by {@link beginTurnExecution}. */
export interface TurnEventDrainInput {
  trackedStream: AsyncIterable<TurnStreamingEvent>;
  turnEventStream: EventSubscription<TurnStreamingEvent>;
  sessionId: string;
  turnId: string;
  maxExecutionTimer: NodeJS.Timeout;
  logger: Logger;
}

/**
 * Shared create-turn engine: persist the turn, start execution, and return the
 * drain inputs. Does not wait for events and does not write HTTP/SSE.
 * The executor mints `turn_id` so it can record the id before the store write.
 */
export async function beginTurnExecution(params: {
  session: SessionHandle;
  turn_id: string;
  input: TurnInputItem[] | undefined;
  previous_turn_id: string | undefined;
  userRef: string;
  deps: BeginTurnExecutionDeps;
}): Promise<{ turn: TurnHandle; drainInput: TurnEventDrainInput }> {
  const { session, turn_id: turnId, input, previous_turn_id: previousTurnId, userRef, deps } = params;
  const sessionId = session.session_id;

  const abortController = new AbortController();
  const tenant_id = session.tenant_id;
  const resolver = createTurnResolver({
    mcpServerStore: deps.mcpServerStore,
    skillStore: deps.skillStore,
    sandboxProviderStore: deps.sandboxProviderStore,
    agentStore: deps.agentStore,
    modelProviderStore: deps.modelProviderStore,
    sandboxIntegration: deps.sandboxIntegration,
    logger: deps.logger,
    signal: abortController.signal,
    userRef,
    session,
    turnId,
  });

  // First turn only: derive the title from the first user message. The store
  // never overwrites an existing title.
  const title = session.record.last_turn_id ? undefined : deriveSessionTitle(input);

  const turn = await session.createTurn({
    turn_id: turnId,
    input,
    previous_turn_id: previousTurnId,
    signal: abortController.signal,
    resolver,
    update_session_title_if_not_exist: title,
  });

  const maxExecutionTimer = setTimeout(() => {
    if (!abortController.signal.aborted) {
      abortController.abort(CancellationReason.ServerExecutionTimeout);
    }
  }, configuration.SERVER_EXECUTION_TIMEOUT_SECONDS * 1000);
  maxExecutionTimer.unref();

  const trackedStream = deps.activeTurns.track({
    sessionId,
    turnId: turn.id,
    abortController,
    stream: turn.stream(),
  });

  // Held for the whole turn; the stream's sequence counter dies with it.
  const turnEventStream = deps.eventSubscriptions.get(turnStreamId(tenant_id, sessionId, turn.id));

  return {
    turn,
    drainInput: {
      trackedStream,
      turnEventStream,
      sessionId,
      turnId: turn.id,
      maxExecutionTimer,
      logger: deps.logger,
    },
  };
}

/**
 * Non-stream create-turn: begin execution and resolve once the first event is
 * dual-written so immediate subscribe cannot 412. Same as `stream: false`.
 */
export async function startTurnInProcess(params: {
  session: SessionHandle;
  turn_id: string;
  input: TurnInputItem[] | undefined;
  previous_turn_id: string | undefined;
  userRef: string;
  deps: BeginTurnExecutionDeps;
}): Promise<TurnHandle> {
  const { turn, drainInput } = await beginTurnExecution(params);

  // Same unawaited drain scheduling as Hono streamSSE's run(cb).
  const { promise: firstEventDualWritten, resolve: markFirstEventDualWritten } = Promise.withResolvers<undefined>();
  void drainTurnEvents({
    ...drainInput,
    onEvent: () => {
      markFirstEventDualWritten(undefined);
      return Promise.resolve();
    },
  }).finally(() => {
    markFirstEventDualWritten(undefined);
  });
  await firstEventDualWritten;
  return turn;
}
