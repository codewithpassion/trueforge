import { AgentSpecSchema, Sessions, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import type { Kysely, Selectable } from 'kysely';
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
import { DELIVERY_RETRY_BASE_MS, MAX_DELIVERY_ATTEMPTS } from '../../../src/integrations/deliverySchedule';
import { retryIntegrationDeliveries } from '../../../src/integrations/retryDeliveries';
import { TurnCompletionNotifier } from '../../../src/integrations/TurnCompletionNotifier';
import type { DeliveryResult } from '../../../src/integrations/types';
import type { IntegrationManifest } from '../../../src/schemas/integration';
import { newId } from '../../../src/utils/id';
import { fakeChannelAdapter, type FakeChannelAdapter } from './fakeChannelAdapter';

/** Notification rules only fire for schedule sessions, which these cases do not create. */
const scheduleStore = { getSchedule: (): Promise<undefined> => Promise.resolve(undefined) };

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
    bot_display_name: 'trueforge',
    team_id: 'T0TEAM',
    bot_user_id: 'U0BOT',
    default_agent_name: 'support-bot',
    allowed_channel_ids: ['C0GENERAL'],
    allow_direct_messages: true,
    reply_mode: 'thread',
    approver_slack_user_ids: [],
    notification_rules: [],
    auth: { bot_token: 'xoxb-test', signing_secret: 'sigsecret' },
  };
}

const past = (msAgo = 60_000): Date => new Date(Date.now() - msAgo);
const soon = (msAhead = 60_000): Date => new Date(Date.now() + msAhead);

interface Harness {
  db: Kysely<Database>;
  integrationStore: SqliteIntegrationStore;
  channel: FakeChannelAdapter;
  sweep: (signal?: AbortSignal) => Promise<void>;
  row: () => Promise<Selectable<Database['integration_delivery']> | undefined>;
}

async function createHarness(
  options: { deliver?: () => DeliveryResult; turnRunning?: boolean; dueAt?: Date } = {},
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
    session_external_id: CONVERSATION_KEY,
    next_attempt_at: options.dueAt ?? past(),
  });

  const logger = createLogger({ silent: true });
  const channel = fakeChannelAdapter(options.deliver === undefined ? {} : { deliver: options.deliver });
  const deps = {
    integrationStore,
    sessions: new Sessions({ sessionStore }),
    notifier: new TurnCompletionNotifier({ integrationStore, scheduleStore, adapters: channel.adapters, logger }),
    logger,
  };

  return {
    db,
    integrationStore,
    channel,
    sweep: signal => retryIntegrationDeliveries({ ...deps, signal }),
    row: () => db.selectFrom('integration_delivery').selectAll().where('id', '=', DELIVERY_ID).executeTakeFirst(),
  };
}

describe('retryIntegrationDeliveries', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.db.destroy();
  });

  it('leaves a row alone until it is due', async () => {
    harness = await createHarness({ dueAt: soon() });

    await harness.sweep();

    expect(harness.channel.delivered).toEqual([]);
    expect(await harness.row()).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('posts a row that is due and settles it', async () => {
    harness = await createHarness();

    await harness.sweep();

    expect(harness.channel.delivered).toHaveLength(1);
    expect(harness.channel.delivered[0]).toMatchObject({ id: DELIVERY_ID, turn_id: TURN_ID });
    expect(await harness.row()).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('reclaims a claim whose deadline passed, and leaves one that still has time', async () => {
    harness = await createHarness();
    await harness.integrationStore.claimDelivery({
      turn_id: TURN_ID,
      conversation_key: CONVERSATION_KEY,
      next_attempt_at: soon(5 * 60_000),
    });

    await harness.sweep();
    expect(harness.channel.delivered).toEqual([]);
    expect(await harness.row()).toMatchObject({ status: 'sending', attempts: 1 });

    await harness.integrationStore.releaseDelivery({
      id: DELIVERY_ID,
      attempts: 1,
      error: 'stalled',
      next_attempt_at: past(),
    });
    await harness.integrationStore.claimDeliveryForRetry({ id: DELIVERY_ID, attempts: 1, next_attempt_at: past() });

    await harness.sweep();
    expect(harness.channel.delivered).toHaveLength(1);
    expect(await harness.row()).toMatchObject({ status: 'sent', attempts: 3 });
  });

  it('waits out the pause the channel asked for instead of its own backoff', async () => {
    harness = await createHarness({
      deliver: () => ({ ok: false, error: 'Slack rate limited the message', retry_after_ms: 10 * 60_000 }),
    });

    await harness.sweep();

    const row = await harness.row();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'Slack rate limited the message' });
    const waited = Date.parse(row?.next_attempt_at ?? '') - Date.now();
    expect(waited).toBeGreaterThan(DELIVERY_RETRY_BASE_MS * 2);
    expect(waited).toBeLessThanOrEqual(10 * 60_000);

    // Not due again, so a second pass posts nothing.
    await harness.sweep();
    expect(harness.channel.delivered).toHaveLength(1);
  });

  it('gives a row up once its attempts are spent', async () => {
    harness = await createHarness({ deliver: () => ({ ok: false, error: 'channel rejected the message' }) });
    await harness.db.updateTable('integration_delivery').set({ attempts: MAX_DELIVERY_ATTEMPTS }).execute();

    await harness.sweep();

    expect(harness.channel.delivered).toEqual([]);
    expect(await harness.row()).toMatchObject({ status: 'failed', attempts: MAX_DELIVERY_ATTEMPTS + 1 });
  });

  it('leaves a turn that is still running to the drain that owns it', async () => {
    harness = await createHarness({ turnRunning: true });

    await harness.sweep();

    expect(harness.channel.delivered).toEqual([]);
    expect(await harness.row()).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('two sweeps racing the same row post exactly once', async () => {
    harness = await createHarness();

    await Promise.all([harness.sweep(), harness.sweep(), harness.sweep()]);

    expect(harness.channel.delivered).toHaveLength(1);
  });

  it('posts nothing when the pass is already out of time', async () => {
    harness = await createHarness();
    const controller = new AbortController();
    controller.abort();

    await harness.sweep(controller.signal);

    expect(harness.channel.delivered).toEqual([]);
    expect(await harness.row()).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('stops after the row that used up the pass, and hands its deadline to the channel', async () => {
    const controller = new AbortController();
    harness = await createHarness({
      deliver: () => {
        // Stands in for a post that consumed the rest of the alarm's wall time.
        controller.abort();
        return { ok: true };
      },
    });
    const [integration] = await harness.integrationStore.listIntegrations({ tenant_id: TENANT });
    await harness.integrationStore.enqueueDelivery({
      id: newId(),
      tenant_id: TENANT,
      integration_id: integration?.id ?? '',
      conversation_key: CONVERSATION_KEY,
      turn_id: 'turn-2',
      session_external_id: CONVERSATION_KEY,
      // Due later than the first, so the pass reaches it second and the abort stops it there.
      next_attempt_at: past(1_000),
    });

    await harness.sweep(controller.signal);

    expect(harness.channel.delivered).toHaveLength(1);
    expect(harness.channel.signals[0]).toBe(controller.signal);
  });
});
