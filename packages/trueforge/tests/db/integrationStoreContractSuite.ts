/**
 * Backend-agnostic behavioural contract for IIntegrationStore.
 * Runs under jest (SQLite / Postgres) and vitest (D1) against a fresh store per test.
 */
import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { ulid } from 'ulid';
import type { CreateIntegrationInput, IIntegrationStore } from '../../src/db/integrationStore';
import { IntegrationConflictError } from '../../src/db/integrationStore';
import type { IntegrationManifest } from '../../src/schemas/integration';

const TENANT = 'default';
const TEAM_ID = 'T0LACROSSE';

const CREATED_BY: CreatedBySubject = {
  subject_id: 'admin-1',
  subject_type: 'user',
  subject_display_name: 'Admin One',
};

function manifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return {
    type: 'slack',
    team_id: TEAM_ID,
    bot_user_id: 'U0BOT',
    default_agent_name: 'support-bot',
    allowed_channel_ids: ['C0GENERAL'],
    allow_direct_messages: true,
    reply_mode: 'thread',
    auth: { bot_token: 'xoxb-test', signing_secret: 'sigsecret' },
    ...overrides,
  };
}

function createInput(overrides: Partial<CreateIntegrationInput> = {}): CreateIntegrationInput {
  return {
    id: ulid().toLowerCase(),
    tenant_id: TENANT,
    type: 'slack',
    external_account_id: TEAM_ID,
    manifest: manifest(),
    created_by_subject: CREATED_BY,
    ...overrides,
  };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** One outbox row `del-1` owed to `turn-1`, the shape the delivery cases start from. */
function enqueue(store: IIntegrationStore, integrationId: string): Promise<{ enqueued: boolean }> {
  return store.enqueueDelivery({
    id: 'del-1',
    tenant_id: TENANT,
    integration_id: integrationId,
    conversation_key: 'slack:T:C:1',
    turn_id: 'turn-1',
  });
}

export function runIntegrationStoreContractSuite(getStore: () => IIntegrationStore): void {
  it('create round-trips the manifest and creator, and is readable by id', async () => {
    const store = getStore();
    const input = createInput();
    const created = await store.createIntegration(input);

    expect(created.id).toBe(input.id);
    expect(created.tenant_id).toBe(TENANT);
    expect(created.type).toBe('slack');
    expect(created.external_account_id).toBe(TEAM_ID);
    expect(created.manifest).toEqual(manifest());
    expect(created.created_by_subject).toEqual(CREATED_BY);
    expect(created.created_at).toMatch(ISO_UTC);
    expect(created.updated_at).toBe(created.created_at);

    expect(await store.getIntegration({ tenant_id: TENANT, id: input.id })).toEqual(created);
    expect(await store.getIntegrationById({ id: input.id })).toEqual(created);
    expect(await store.listIntegrations({ tenant_id: TENANT })).toEqual([created]);
  });

  it('get and list are scoped to one tenant while getIntegrationById is not', async () => {
    const store = getStore();
    const mine = await store.createIntegration(createInput());

    expect(await store.getIntegration({ tenant_id: 'other-tenant', id: mine.id })).toBeUndefined();
    expect(await store.listIntegrations({ tenant_id: 'other-tenant' })).toEqual([]);
    // Ingress has no tenant to scope by; the row carries it.
    expect((await store.getIntegrationById({ id: mine.id }))?.tenant_id).toBe(TENANT);
  });

  it('create rejects a second integration for the same channel account', async () => {
    const store = getStore();
    await store.createIntegration(createInput());
    await expect(store.createIntegration(createInput())).rejects.toBeInstanceOf(IntegrationConflictError);
  });

  it('the same channel account may be connected once per tenant', async () => {
    const store = getStore();
    await store.createIntegration(createInput());
    const other = await store.createIntegration(createInput({ tenant_id: 'other-tenant' }));
    expect(other.external_account_id).toBe(TEAM_ID);
  });

  it('update replaces the whole manifest and preserves created_at', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());

    const replacement = manifest({ allowed_channel_ids: ['C0GENERAL', 'C0RANDOM'], allow_direct_messages: false });
    const updated = await store.updateIntegration({
      tenant_id: TENANT,
      id: created.id,
      external_account_id: TEAM_ID,
      manifest: replacement,
    });

    expect(updated?.manifest).toEqual(replacement);
    expect(updated?.created_at).toBe(created.created_at);
    expect(Date.parse(updated?.updated_at ?? '')).toBeGreaterThanOrEqual(Date.parse(created.updated_at));
  });

  it('update returns undefined for an unknown integration', async () => {
    const store = getStore();
    expect(
      await store.updateIntegration({
        tenant_id: TENANT,
        id: 'missing',
        external_account_id: TEAM_ID,
        manifest: manifest(),
      }),
    ).toBeUndefined();
  });

  it('update rejects moving onto an account another integration already holds', async () => {
    const store = getStore();
    await store.createIntegration(createInput());
    const second = await store.createIntegration(
      createInput({ external_account_id: 'T0OTHER', manifest: manifest({ team_id: 'T0OTHER' }) }),
    );

    await expect(
      store.updateIntegration({
        tenant_id: TENANT,
        id: second.id,
        external_account_id: TEAM_ID,
        manifest: manifest(),
      }),
    ).rejects.toBeInstanceOf(IntegrationConflictError);
  });

  it('delete removes the integration with its events and deliveries', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    await store.recordEvent({
      id: ulid().toLowerCase(),
      tenant_id: TENANT,
      integration_id: created.id,
      event_id: 'Ev1',
    });
    await store.enqueueDelivery({
      id: ulid().toLowerCase(),
      tenant_id: TENANT,
      integration_id: created.id,
      conversation_key: 'slack:T:C:1',
      turn_id: 'turn-1',
    });

    await store.deleteIntegration({ tenant_id: TENANT, id: created.id });

    expect(await store.getIntegrationById({ id: created.id })).toBeUndefined();
    expect(await store.getPendingDelivery({ turn_id: 'turn-1' })).toBeUndefined();
    // The dedupe row went with it, so the same event id is accepted again after a re-connect.
    const reconnected = await store.createIntegration(createInput({ id: created.id }));
    expect(
      await store.recordEvent({
        id: ulid().toLowerCase(),
        tenant_id: TENANT,
        integration_id: reconnected.id,
        event_id: 'Ev1',
      }),
    ).toEqual({ recorded: true });
  });

  it('delete is idempotent', async () => {
    const store = getStore();
    await expect(store.deleteIntegration({ tenant_id: TENANT, id: 'missing' })).resolves.toBeUndefined();
  });

  it('recordEvent accepts one event id and drops the replay', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    const event = { tenant_id: TENANT, integration_id: created.id, event_id: 'Ev0001' };

    expect(await store.recordEvent({ id: ulid().toLowerCase(), ...event })).toEqual({ recorded: true });
    expect(await store.recordEvent({ id: ulid().toLowerCase(), ...event })).toEqual({ recorded: false });
    // A different event id on the same integration is still accepted.
    expect(await store.recordEvent({ id: ulid().toLowerCase(), ...event, event_id: 'Ev0002' })).toEqual({
      recorded: true,
    });
  });

  it('recordEvent drops an event whose integration is gone or belongs to another tenant', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());

    expect(
      await store.recordEvent({
        id: ulid().toLowerCase(),
        tenant_id: TENANT,
        integration_id: 'missing',
        event_id: 'Ev1',
      }),
    ).toEqual({ recorded: false });
    expect(
      await store.recordEvent({
        id: ulid().toLowerCase(),
        tenant_id: 'other-tenant',
        integration_id: created.id,
        event_id: 'Ev1',
      }),
    ).toEqual({ recorded: false });
  });

  it('concurrent copies of one event record exactly once', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.recordEvent({
          id: ulid().toLowerCase(),
          tenant_id: TENANT,
          integration_id: created.id,
          event_id: 'Ev-race',
        }),
      ),
    );

    expect(attempts.filter(attempt => attempt.recorded)).toHaveLength(1);
  });

  it('pruneEvents drops only rows older than the cutoff', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    await store.recordEvent({
      id: ulid().toLowerCase(),
      tenant_id: TENANT,
      integration_id: created.id,
      event_id: 'Old',
    });

    // Everything recorded so far is older than a cutoff in the future.
    expect(await store.pruneEvents({ before: new Date(Date.now() + 60_000) })).toBe(1);
    expect(
      await store.recordEvent({
        id: ulid().toLowerCase(),
        tenant_id: TENANT,
        integration_id: created.id,
        event_id: 'Old',
      }),
    ).toEqual({ recorded: true });
    // A cutoff in the past leaves the fresh row alone.
    expect(await store.pruneEvents({ before: new Date(Date.now() - 60_000) })).toBe(0);
  });

  it('enqueueDelivery writes at most one outbox row per turn', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    const delivery = {
      tenant_id: TENANT,
      integration_id: created.id,
      conversation_key: 'slack:T0LACROSSE:C0GENERAL:1700000000.000100',
      turn_id: 'turn-1',
    };

    expect(await store.enqueueDelivery({ id: ulid().toLowerCase(), ...delivery })).toEqual({ enqueued: true });
    expect(await store.enqueueDelivery({ id: ulid().toLowerCase(), ...delivery })).toEqual({ enqueued: false });

    const pending = await store.getPendingDelivery({ turn_id: 'turn-1' });
    expect(pending).toMatchObject({
      tenant_id: TENANT,
      integration_id: created.id,
      conversation_key: delivery.conversation_key,
      turn_id: 'turn-1',
      status: 'pending',
      attempts: 0,
      last_error: null,
    });
    expect(pending?.created_at).toMatch(ISO_UTC);
  });

  it('concurrent enqueues for one turn write exactly one outbox row', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.enqueueDelivery({
          id: ulid().toLowerCase(),
          tenant_id: TENANT,
          integration_id: created.id,
          conversation_key: 'slack:T:C:1',
          turn_id: 'turn-race',
        }),
      ),
    );

    expect(attempts.filter(attempt => attempt.enqueued)).toHaveLength(1);
  });

  it('enqueueDelivery drops a delivery whose integration is gone', async () => {
    const store = getStore();
    expect(
      await store.enqueueDelivery({
        id: ulid().toLowerCase(),
        tenant_id: TENANT,
        integration_id: 'missing',
        conversation_key: 'slack:T:C:1',
        turn_id: 'turn-1',
      }),
    ).toEqual({ enqueued: false });
  });

  it('claimDelivery takes the row once and counts the attempt', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    await enqueue(store, created.id);

    const claimed = await store.claimDelivery({ turn_id: 'turn-1' });
    expect(claimed).toMatchObject({ id: 'del-1', status: 'sending', attempts: 1 });
    // A claimed row is no longer owed, so a second caller has nothing to post.
    expect(await store.getPendingDelivery({ turn_id: 'turn-1' })).toBeUndefined();
    expect(await store.claimDelivery({ turn_id: 'turn-1' })).toBeUndefined();
  });

  it('concurrent claims for one turn hand the row to exactly one caller', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    await enqueue(store, created.id);

    const claims = await Promise.all(Array.from({ length: 8 }, () => store.claimDelivery({ turn_id: 'turn-1' })));

    expect(claims.filter(claim => claim !== undefined)).toHaveLength(1);
  });

  it('markDeliverySent settles the row this caller claimed', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    await enqueue(store, created.id);
    await store.claimDelivery({ turn_id: 'turn-1' });

    const sent = await store.markDeliverySent({ id: 'del-1', attempts: 1 });
    expect(sent).toMatchObject({ status: 'sent', attempts: 1, last_error: null });

    // A second terminal write finds nothing in flight and leaves the row alone.
    expect(await store.markDeliveryFailed({ id: 'del-1', attempts: 1, error: 'late' })).toBeUndefined();
    expect(await store.getPendingDelivery({ turn_id: 'turn-1' })).toBeUndefined();
  });

  it('markDeliveryFailed records the reason on the row this caller claimed', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    await enqueue(store, created.id);
    await store.claimDelivery({ turn_id: 'turn-1' });

    const failed = await store.markDeliveryFailed({ id: 'del-1', attempts: 1, error: 'no adapter for slack' });
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, last_error: 'no adapter for slack' });
    expect(await store.getPendingDelivery({ turn_id: 'turn-1' })).toBeUndefined();
  });

  it('a terminal write without a claim changes nothing', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    await enqueue(store, created.id);

    expect(await store.markDeliverySent({ id: 'del-1', attempts: 0 })).toBeUndefined();
    expect(await store.getPendingDelivery({ turn_id: 'turn-1' })).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('releaseDelivery puts a claimed row back in the queue with its reason', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    await enqueue(store, created.id);
    await store.claimDelivery({ turn_id: 'turn-1' });

    const released = await store.releaseDelivery({ id: 'del-1', attempts: 1, error: 'slack unreachable' });
    expect(released).toMatchObject({ status: 'pending', attempts: 1, last_error: 'slack unreachable' });
    expect(await store.getPendingDelivery({ turn_id: 'turn-1' })).toMatchObject({ status: 'pending', attempts: 1 });
    // Nothing is in flight any more, so a second release changes nothing.
    expect(await store.releaseDelivery({ id: 'del-1', attempts: 1, error: 'late' })).toBeUndefined();
  });

  it('listRetryableDeliveries returns unsettled rows older than the cutoff, oldest first', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    await enqueue(store, created.id);
    await store.enqueueDelivery({
      id: 'del-2',
      tenant_id: TENANT,
      integration_id: created.id,
      conversation_key: 'slack:T:C:2',
      turn_id: 'turn-2',
    });
    await store.enqueueDelivery({
      id: 'del-3',
      tenant_id: TENANT,
      integration_id: created.id,
      conversation_key: 'slack:T:C:3',
      turn_id: 'turn-3',
    });
    // `del-2` is stranded mid-post and `del-3` is settled; only the first two are owed.
    await store.claimDelivery({ turn_id: 'turn-2' });
    await store.claimDelivery({ turn_id: 'turn-3' });
    await store.markDeliverySent({ id: 'del-3', attempts: 1 });

    const soon = new Date(Date.now() + 60_000);
    const owed = await store.listRetryableDeliveries({ before: soon, limit: 10 });
    expect(owed.map(row => row.id).sort()).toEqual(['del-1', 'del-2']);

    // Rows touched after the cutoff are not the sweep's yet.
    expect(await store.listRetryableDeliveries({ before: new Date(Date.now() - 60_000), limit: 10 })).toEqual([]);
    expect(await store.listRetryableDeliveries({ before: soon, limit: 1 })).toHaveLength(1);
  });

  it('claimDeliveryForRetry takes a stranded sending row once, guarded by its attempt count', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    await enqueue(store, created.id);
    const stranded = await store.claimDelivery({ turn_id: 'turn-1' });
    expect(stranded).toMatchObject({ status: 'sending', attempts: 1 });

    const reclaimed = await store.claimDeliveryForRetry({ id: 'del-1', attempts: 1 });
    expect(reclaimed).toMatchObject({ status: 'sending', attempts: 2 });
    // The attempt count moved on, so the stale read no longer claims anything.
    expect(await store.claimDeliveryForRetry({ id: 'del-1', attempts: 1 })).toBeUndefined();
  });

  it('concurrent retry claims for one row hand it to exactly one sweep', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    await enqueue(store, created.id);

    const claims = await Promise.all(
      Array.from({ length: 8 }, () => store.claimDeliveryForRetry({ id: 'del-1', attempts: 0 })),
    );

    expect(claims.filter(claim => claim !== undefined)).toHaveLength(1);
  });

  it('a settled row is never handed back to the sweep', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    await enqueue(store, created.id);
    await store.claimDelivery({ turn_id: 'turn-1' });
    await store.markDeliveryFailed({ id: 'del-1', attempts: 1, error: 'gave up' });

    expect(await store.listRetryableDeliveries({ before: new Date(Date.now() + 60_000), limit: 10 })).toEqual([]);
    expect(await store.claimDeliveryForRetry({ id: 'del-1', attempts: 1 })).toBeUndefined();
  });

  it('a settle from a caller the sweep already took over from changes nothing', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    await enqueue(store, created.id);
    await store.claimDelivery({ turn_id: 'turn-1' });
    // The sweep decides the first holder is stranded and takes the row for another attempt.
    await store.claimDeliveryForRetry({ id: 'del-1', attempts: 1 });

    expect(await store.markDeliverySent({ id: 'del-1', attempts: 1 })).toBeUndefined();
    expect(await store.markDeliveryFailed({ id: 'del-1', attempts: 1, error: 'late' })).toBeUndefined();
    expect(await store.releaseDelivery({ id: 'del-1', attempts: 1, error: 'late' })).toBeUndefined();

    expect(await store.markDeliverySent({ id: 'del-1', attempts: 2 })).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('deleteEvent releases the event id so the channel retry runs again', async () => {
    const store = getStore();
    const created = await store.createIntegration(createInput());
    const event = { tenant_id: TENANT, integration_id: created.id, event_id: 'Ev-release' };

    expect(await store.recordEvent({ id: 'event-1', ...event })).toEqual({ recorded: true });
    expect(await store.recordEvent({ id: 'event-2', ...event })).toEqual({ recorded: false });

    await store.deleteEvent({ id: 'event-1' });

    expect(await store.recordEvent({ id: 'event-3', ...event })).toEqual({ recorded: true });
  });

  it('deleteEvent is idempotent', async () => {
    const store = getStore();
    await expect(store.deleteEvent({ id: 'missing' })).resolves.toBeUndefined();
  });
}
