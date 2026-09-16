import { AgentSpecSchema, Sessions, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import type { Kysely } from 'kysely';
import { createLogger } from 'winston';
import {
  makeCreateTurnInput,
  makeDoneTurnState,
  makeTurnDoneEvent,
} from '../../../../trueforge-core/tests/agent-session/testHelpers';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { BetterSqliteAtomicRunner, createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteIntegrationStore } from '../../../src/db/sqlite/integration-store/SqliteIntegrationStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import type { Database } from '../../../src/db/sqlite/types';
import {
  DELIVERY_RETRY_BASE_MS,
  DELIVERY_SENDING_TIMEOUT_MS,
  deliveryRetryBackoffMs,
  retryIntegrationDeliveries,
} from '../../../src/integrations/retryDeliveries';
import { MAX_DELIVERY_ATTEMPTS, TurnCompletionNotifier } from '../../../src/integrations/TurnCompletionNotifier';
import type { IntegrationManifest } from '../../../src/schemas/integration';
import { newId } from '../../../src/utils/id';
import { fakeChannelAdapter, type FakeChannelAdapter } from './fakeChannelAdapter';

const TENANT = 'default';
const SESSION_ID = 's1';
const TURN_ID = 'turn-1';
const DELIVERY_ID = 'del-1';
const CONVERSATION_KEY = 'slack:T0TEAM:C0GENERAL:1700000000.000100';

const CREATED_BY: CreatedBySubject = {
  subject_id: 'admin-1',
  subject_type: 'user',
  subject_display_name: 'Admin One',
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

interface Harness {
  db: Kysely<Database>;
  sessionStore: SqliteSessionStore;
  integrationStore: SqliteIntegrationStore;
  channel: FakeChannelAdapter;
  sweep: () => Promise<void>;
  /** Moves the outbox row's clock back, standing in for a pass that ran long ago. */
  age: (ms: number) => Promise<void>;
  row: () => Promise<Database['integration_delivery'] | undefined>;
}

async function createHarness(
  options: { deliver?: () => { ok: false; error: string }; turnRunning?: boolean } = {},
): Promise<Harness> {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const atomic = new BetterSqliteAtomicRunner(db);
  const sessionStore = new SqliteSessionStore(db, atomic);
  const integrationStore = new SqliteIntegrationStore(db, atomic);
  const integrationId = newId();

  await integrationStore.createIntegration({
    id: integrationId,
    tenant_id: TENANT,
    type: 'slack',
    external_account_id: 'T0TEAM',
    manifest: manifest(),
    created_by_subject: CREATED_BY,
  });
  await sessionStore.createSession({
    tenant_id: TENANT,
    session_id: SESSION_ID,
    created_by_subject: CREATED_BY,
    agent: { type: 'inline', spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }) },
    custom: null,
    metadata: {},
    external_id: CONVERSATION_KEY,
    source: { type: 'integration', id: integrationId, conversation_key: CONVERSATION_KEY },
  });
  await sessionStore.createTurn(makeCreateTurnInput({ sessionId: SESSION_ID, turnId: TURN_ID }));
  if (options.turnRunning !== true) {
    const state = makeDoneTurnState();
    await sessionStore.updateTurnState({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      state,
      turn_done_event: makeTurnDoneEvent(state),
    });
  }
  await integrationStore.enqueueDelivery({
    id: DELIVERY_ID,
    tenant_id: TENANT,
    integration_id: integrationId,
    conversation_key: CONVERSATION_KEY,
    turn_id: TURN_ID,
  });

  const logger = createLogger({ silent: true });
  const channel = fakeChannelAdapter(options.deliver === undefined ? {} : { deliver: options.deliver });
  const deps = {
    integrationStore,
    sessions: new Sessions({ sessionStore }),
    notifier: new TurnCompletionNotifier({ integrationStore, adapters: channel.adapters, logger }),
    logger,
  };

  return {
    db,
    sessionStore,
    integrationStore,
    channel,
    sweep: () => retryIntegrationDeliveries(deps),
    age: async ms => {
      const row = await db.selectFrom('integration_delivery').select('updated_at').executeTakeFirstOrThrow();
      await db
        .updateTable('integration_delivery')
        .set({ updated_at: new Date(Date.parse(row.updated_at) - ms).toISOString() })
        .execute();
    },
    row: () => db.selectFrom('integration_delivery').selectAll().executeTakeFirst(),
  };
}

describe('deliveryRetryBackoffMs', () => {
  it('doubles each attempt and stops at the ceiling', () => {
    expect(deliveryRetryBackoffMs(1)).toBe(DELIVERY_RETRY_BASE_MS);
    expect(deliveryRetryBackoffMs(2)).toBe(DELIVERY_RETRY_BASE_MS * 2);
    expect(deliveryRetryBackoffMs(3)).toBe(DELIVERY_RETRY_BASE_MS * 4);
    expect(deliveryRetryBackoffMs(20)).toBe(deliveryRetryBackoffMs(21));
  });
});

describe('retryIntegrationDeliveries', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.db.destroy();
  });

  it('leaves a row alone until its backoff has passed', async () => {
    harness = await createHarness();

    await harness.sweep();

    expect(harness.channel.delivered).toEqual([]);
    expect(await harness.row()).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('posts a row whose backoff has passed and settles it', async () => {
    harness = await createHarness();
    await harness.age(DELIVERY_RETRY_BASE_MS + 1000);

    await harness.sweep();

    expect(harness.channel.delivered).toHaveLength(1);
    expect(harness.channel.delivered[0]).toMatchObject({ id: DELIVERY_ID, turn_id: TURN_ID });
    expect(await harness.row()).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('reclaims a row a stopped process stranded mid-post', async () => {
    harness = await createHarness();
    const claimed = await harness.integrationStore.claimDelivery({ turn_id: TURN_ID });
    expect(claimed).toMatchObject({ status: 'sending', attempts: 1 });

    // Still within the delivery timeout: whoever holds it may yet finish.
    await harness.age(DELIVERY_RETRY_BASE_MS + 1000);
    await harness.sweep();
    expect(harness.channel.delivered).toEqual([]);
    expect(await harness.row()).toMatchObject({ status: 'sending', attempts: 1 });

    await harness.age(DELIVERY_SENDING_TIMEOUT_MS);
    await harness.sweep();

    expect(harness.channel.delivered).toHaveLength(1);
    expect(await harness.row()).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('keeps a rate-limited row queued with its reason for the next pass', async () => {
    harness = await createHarness({
      deliver: () => ({ ok: false, error: 'Slack rate limited the message; retry after 60s' }),
    });
    await harness.age(DELIVERY_RETRY_BASE_MS + 1000);

    await harness.sweep();

    expect(await harness.row()).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'Slack rate limited the message; retry after 60s',
    });

    // One backoff step is enough for the second attempt.
    await harness.age(DELIVERY_RETRY_BASE_MS + 1000);
    await harness.sweep();
    expect(harness.channel.delivered).toHaveLength(2);
    expect(await harness.row()).toMatchObject({ status: 'pending', attempts: 2 });

    // The third has to wait twice as long as the second.
    await harness.age(DELIVERY_RETRY_BASE_MS + 1000);
    await harness.sweep();
    expect(harness.channel.delivered).toHaveLength(2);

    await harness.age(deliveryRetryBackoffMs(2));
    await harness.sweep();
    expect(harness.channel.delivered).toHaveLength(3);
  });

  it('gives a row up once its attempts are spent', async () => {
    harness = await createHarness({ deliver: () => ({ ok: false, error: 'channel rejected the message' }) });
    await harness.db.updateTable('integration_delivery').set({ attempts: MAX_DELIVERY_ATTEMPTS }).execute();
    await harness.age(deliveryRetryBackoffMs(MAX_DELIVERY_ATTEMPTS) + 1000);

    await harness.sweep();

    expect(harness.channel.delivered).toEqual([]);
    expect(await harness.row()).toMatchObject({ status: 'failed', attempts: MAX_DELIVERY_ATTEMPTS + 1 });
  });

  it('leaves a turn that is still running to the drain that owns it', async () => {
    harness = await createHarness({ turnRunning: true });
    await harness.age(DELIVERY_RETRY_BASE_MS + 1000);

    await harness.sweep();

    expect(harness.channel.delivered).toEqual([]);
    expect(await harness.row()).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('two sweeps racing the same row post exactly once', async () => {
    harness = await createHarness();
    await harness.age(DELIVERY_RETRY_BASE_MS + 1000);

    await Promise.all([harness.sweep(), harness.sweep(), harness.sweep()]);

    expect(harness.channel.delivered).toHaveLength(1);
  });
});
