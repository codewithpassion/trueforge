import { AgentSpecSchema, Sessions, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { runInDurableObject } from 'cloudflare:test';
import { createIntegrationAdapters } from '../../src/integrations/registry';
import { TurnCompletionNotifier } from '../../src/integrations/TurnCompletionNotifier';
import type { Delivery } from '../../src/integrations/types';
import type { IntegrationManifest } from '../../src/schemas/integration';
import { createConsoleLogger } from '../../src/workers/logger';
import { d1Persistence, migrateDatabase, sessionStub, TENANT_ID, upsertMockProvider, USER_REF } from './harness';

/** Deliveries the fake Slack adapter was asked to post, from inside the Durable Object. */
const delivered = vi.hoisted((): Delivery[] => []);

vi.mock('../../src/integrations/registry', () => ({
  createIntegrationAdapters: () =>
    new Map([
      [
        'slack',
        {
          type: 'slack',
          receive: () => Promise.resolve({ type: 'ignore', reason: 'fake adapter' }),
          deliver: (input: { delivery: Delivery }) => {
            delivered.push(input.delivery);
            return Promise.resolve({ ok: true });
          },
        },
      ],
    ]),
}));

const CREATED_BY: CreatedBySubject = {
  subject_id: USER_REF,
  subject_type: 'user',
  subject_display_name: USER_REF,
};

function manifest(): IntegrationManifest {
  return {
    type: 'slack',
    team_id: 'T0TEAM',
    bot_user_id: 'U0BOT',
    default_agent_name: 'support-bot',
    allowed_channel_ids: ['C0GENERAL'],
    allow_direct_messages: true,
    reply_mode: 'thread',
    auth: { bot_token: 'xoxb-test', signing_secret: 'sigsecret' },
  };
}

/** A session an integration owns, bound to the mock model scenario named in its base URL. */
async function createIntegrationSession(input: { sessionId: string; scenario: string; conversationKey: string }) {
  const stores = d1Persistence();
  const providerName = await upsertMockProvider({ stores, scenario: input.scenario });
  const integrationId = `int-${input.sessionId}`;
  await stores.integrationStore.createIntegration({
    id: integrationId,
    tenant_id: TENANT_ID,
    type: 'slack',
    external_account_id: `T-${input.sessionId}`,
    manifest: manifest(),
    created_by_subject: CREATED_BY,
  });
  await stores.sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: input.sessionId,
    created_by_subject: CREATED_BY,
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({ model: { name: `${providerName}/mock-model` }, instructions: 'test' }),
    },
    custom: null,
    metadata: {},
    external_id: input.conversationKey,
    source: { type: 'integration', id: integrationId, conversation_key: input.conversationKey },
  });
  return { stores, integrationId };
}

beforeAll(async () => {
  await migrateDatabase();
});

beforeEach(() => {
  delivered.length = 0;
});

describe('TurnCompletionNotifier inside SessionDO', () => {
  it('delivers once from the alarm invocation that holds the turn', async () => {
    const sessionId = 'integration-delivery';
    const conversationKey = 'slack:T0TEAM:C0GENERAL:1700000000.000100';
    const { stores, integrationId } = await createIntegrationSession({
      sessionId,
      // Long enough that the outbox row lands before the drain ends, as it does in production.
      scenario: 'delay-3000',
      conversationKey,
    });
    const stub = sessionStub(sessionId);

    const started = await stub.startTurn({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      input: [{ type: 'user.message', content: 'hi' }],
      previous_turn_id: undefined,
      user_ref: USER_REF,
    });
    if (!started.ok) {
      throw new Error(`startTurn failed: ${started.code} ${started.message}`);
    }
    await stores.integrationStore.enqueueDelivery({
      id: 'del-1',
      tenant_id: TENANT_ID,
      integration_id: integrationId,
      conversation_key: conversationKey,
      turn_id: started.turn.id,
    });

    // The alarm holds the turn until its drain settles, so the notifier runs before this returns.
    await runInDurableObject(stub, instance => instance.alarm());

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ id: 'del-1', conversation_key: conversationKey, turn_id: started.turn.id });
    expect(delivered[0]?.content).toMatchObject({ type: 'message' });

    const turn = await d1Persistence().sessionStore.getTurn({ session_id: sessionId, turn_id: started.turn.id });
    expect(turn?.state.status).toBe('done');
    expect(await stores.integrationStore.getPendingDelivery({ turn_id: started.turn.id })).toBeUndefined();
  });

  it('two flushes racing for one turn post exactly once on D1', async () => {
    const sessionId = 'integration-delivery-race';
    const conversationKey = 'slack:T0TEAM:C0GENERAL:1700000000.000200';
    const { stores, integrationId } = await createIntegrationSession({
      sessionId,
      scenario: 'text',
      conversationKey,
    });
    const stub = sessionStub(sessionId);

    const started = await stub.startTurn({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      input: [{ type: 'user.message', content: 'hi' }],
      previous_turn_id: undefined,
      user_ref: USER_REF,
    });
    if (!started.ok) {
      throw new Error(`startTurn failed: ${started.code} ${started.message}`);
    }
    // Nothing is owed while the turn runs, so the alarm's own flush posts nothing.
    await runInDurableObject(stub, instance => instance.alarm());
    expect(delivered).toHaveLength(0);

    await stores.integrationStore.enqueueDelivery({
      id: 'del-race',
      tenant_id: TENANT_ID,
      integration_id: integrationId,
      conversation_key: conversationKey,
      turn_id: started.turn.id,
    });
    const session = await new Sessions({ sessionStore: stores.sessionStore }).get({
      tenant_id: TENANT_ID,
      session_id: sessionId,
    });
    if (session === undefined) {
      throw new Error('session was not created');
    }
    const notifier = new TurnCompletionNotifier({
      integrationStore: stores.integrationStore,
      adapters: createIntegrationAdapters(),
      logger: createConsoleLogger({ level: 'error', bindings: {} }),
    });

    // The drain hook and the router's post-start flush run in different isolates in production;
    // only the D1 claim keeps them from both posting.
    await Promise.all(Array.from({ length: 4 }, () => notifier.deliverForTurn({ session, turn_id: started.turn.id })));

    expect(delivered).toHaveLength(1);
    expect(await stores.integrationStore.getPendingDelivery({ turn_id: started.turn.id })).toBeUndefined();
  });

  it('leaves a turn no integration owns alone', async () => {
    const sessionId = 'integration-delivery-plain';
    const stores = d1Persistence();
    const providerName = await upsertMockProvider({ stores, scenario: 'text' });
    await stores.sessionStore.createSession({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      created_by_subject: CREATED_BY,
      agent: {
        type: 'inline',
        spec: AgentSpecSchema.parse({ model: { name: `${providerName}/mock-model` }, instructions: 'test' }),
      },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
    const stub = sessionStub(sessionId);

    const started = await stub.startTurn({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      input: [{ type: 'user.message', content: 'hi' }],
      previous_turn_id: undefined,
      user_ref: USER_REF,
    });
    if (!started.ok) {
      throw new Error(`startTurn failed: ${started.code} ${started.message}`);
    }
    await runInDurableObject(stub, instance => instance.alarm());

    expect(delivered).toHaveLength(0);
  });
});
