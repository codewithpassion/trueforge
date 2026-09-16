import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { sql, type Kysely } from 'kysely';
import { createLogger } from 'winston';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { BetterSqliteAtomicRunner, createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteIntegrationStore } from '../../../src/db/sqlite/integration-store/SqliteIntegrationStore';
import type { Database } from '../../../src/db/sqlite/types';
import {
  INTEGRATION_EVENT_PRUNE_INTERVAL_MS,
  INTEGRATION_EVENT_PRUNE_LOOP_NAME,
  INTEGRATION_EVENT_RETENTION_MS,
  integrationEventPruneLoop,
} from '../../../src/integrations/pruneEvents';
import type { IntegrationManifest } from '../../../src/schemas/integration';
import { newId } from '../../../src/utils/id';

const TENANT = 'default';

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

describe('integrationEventPruneLoop', () => {
  let db: Kysely<Database>;

  afterEach(async () => {
    await db?.destroy();
  });

  it('drops dedupe rows past the retention window and keeps fresh ones', async () => {
    db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const integrationStore = new SqliteIntegrationStore(db, new BetterSqliteAtomicRunner(db));
    const integration = await integrationStore.createIntegration({
      id: newId(),
      tenant_id: TENANT,
      type: 'slack',
      external_account_id: 'T0TEAM',
      manifest: manifest(),
      created_by_subject: CREATED_BY,
    });
    await integrationStore.recordEvent({
      id: 'event-old',
      tenant_id: TENANT,
      integration_id: integration.id,
      event_id: 'Ev-old',
    });
    await integrationStore.recordEvent({
      id: 'event-new',
      tenant_id: TENANT,
      integration_id: integration.id,
      event_id: 'Ev-new',
    });
    // Age one row past the window without waiting a day.
    const stale = new Date(Date.now() - INTEGRATION_EVENT_RETENTION_MS - 60_000).toISOString();
    await sql`UPDATE integration_event SET received_at = ${stale} WHERE id = 'event-old'`.execute(db);

    const loop = integrationEventPruneLoop({ integrationStore, logger: createLogger({ silent: true }) });
    expect(loop.name).toBe(INTEGRATION_EVENT_PRUNE_LOOP_NAME);
    expect(loop.intervalMs).toBe(INTEGRATION_EVENT_PRUNE_INTERVAL_MS);
    await loop.tick(new AbortController().signal);

    const remaining = await db.selectFrom('integration_event').select('id').execute();
    expect(remaining).toEqual([{ id: 'event-new' }]);
  });

  it('a store failure does not throw out of the pass', async () => {
    db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const integrationStore = new SqliteIntegrationStore(db, new BetterSqliteAtomicRunner(db));
    await db.destroy();

    const loop = integrationEventPruneLoop({ integrationStore, logger: createLogger({ silent: true }) });
    await expect(loop.tick(new AbortController().signal)).resolves.toBeUndefined();
  });
});
