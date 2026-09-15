import type { ISessionStore, TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import { RequestReplyRouter } from '@truefoundry/trueforge-core/request-reply';
import { createLogger } from 'winston';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { NodeTurnExecutor } from '../../../src/runtime/nodeTurnExecutor';
import type { SandboxIntegration } from '../../../src/sandbox/integration';
import { createNodeSandboxIntegration } from '../../../src/sandbox/nodeSandboxIntegration';

/** Standalone-shaped Node executor for route tests: in-memory streams, no Redis peers. */
export function testNodeTurnExecutor(
  options: {
    sandboxIntegration?: SandboxIntegration | undefined;
    logger?: Logger;
    eventSubscriptions?: EventSubscriptionRegistry<TurnStreamingEvent>;
    sessionStore?: Pick<ISessionStore, 'getTurn'>;
  } = {},
): NodeTurnExecutor {
  return new NodeTurnExecutor({
    activeTurns: new ActiveTurnRegistry(),
    eventSubscriptions: options.eventSubscriptions ?? new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
    sessionStore: options.sessionStore ?? { getTurn: () => Promise.resolve(undefined) },
    redis: undefined,
    requestReplyRouter: new RequestReplyRouter(),
    sandboxIntegration:
      'sandboxIntegration' in options
        ? options.sandboxIntegration
        : createNodeSandboxIntegration({ localSupport: undefined }),
    logger: options.logger ?? createLogger({ silent: true }),
    executorId: 'local',
    requestReply: { replyTimeoutMs: 60_000, pollIntervalMs: 500 },
  });
}
