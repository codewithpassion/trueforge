import { AgentSpecSchema, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1StatementCounter } from '../../src/db/d1/client';
import { createD1Persistence } from '../../src/db/d1/persistence';
import type { SequencedEvent } from '../../src/runtime/event-subscription';
import { decodeTurnEvents } from '../../src/workers/turnEventWire';

export const TENANT_ID = 'default';
export const USER_REF = 'workers-test-user';

export async function migrateDatabase(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

export function d1Persistence(onStatements?: D1StatementCounter) {
  return createD1Persistence({ database: env.DB, mcpClientName: 'trueforge-workers-tests', onStatements });
}

/** A session whose inline agent talks to the mock model scenario named in its base URL. */
export async function createMockSession({ sessionId, scenario }: { sessionId: string; scenario: string }) {
  const stores = d1Persistence();
  const providerName = `mock-${scenario}`;
  await stores.modelProviderStore.upsertProvider({
    tenant_id: TENANT_ID,
    name: providerName,
    manifest: {
      type: 'custom',
      name: providerName,
      base_url: `https://llm.test/${scenario}/v1`,
      auth: { api_key: 'sk-mock' },
      models: [
        {
          model_id: 'mock-model',
          name: 'mock-model',
          properties: { context_length: 128_000, max_output_tokens: 1_024 },
        },
      ],
    },
  });
  await stores.sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: sessionId,
    created_by_subject: { subject_id: USER_REF, subject_type: 'user', subject_display_name: USER_REF },
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({ model: { name: `${providerName}/mock-model` }, instructions: 'test' }),
    },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  return stores;
}

export function sessionStub(sessionId: string) {
  return env.SESSION_DO.get(env.SESSION_DO.idFromName(`${TENANT_ID}:${sessionId}`));
}

/** Reads turn events until `turn.done`. */
export async function collectTurnEvents(
  events: AsyncGenerator<SequencedEvent<TurnStreamingEvent>, void, unknown>,
): Promise<SequencedEvent<TurnStreamingEvent>[]> {
  const collected: SequencedEvent<TurnStreamingEvent>[] = [];
  for await (const event of events) {
    collected.push(event);
    if (event.type === 'turn.done') {
      break;
    }
  }
  return collected;
}

/** Reads a Durable Object event stream until `turn.done`. */
export function collectEvents(stream: ReadableStream<Uint8Array>): Promise<SequencedEvent<TurnStreamingEvent>[]> {
  return collectTurnEvents(decodeTurnEvents({ stream, signal: new AbortController().signal }));
}
