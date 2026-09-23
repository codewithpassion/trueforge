import { CreatedBySubjectSchema } from '@truefoundry/trueforge-core/agent-session';
import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import type { IntegrationType } from '../../../schemas/integration';
import {
  IntegrationConflictError,
  parseStoredIntegrationManifest,
  type ClaimDeliveryForRetryInput,
  type ClaimDeliveryInput,
  type CreateIntegrationInput,
  type DeleteIntegrationEventInput,
  type DeleteIntegrationInput,
  type EnqueueIntegrationDeliveryInput,
  type GetIntegrationByIdInput,
  type GetIntegrationInput,
  type GetPendingDeliveryInput,
  type IIntegrationStore,
  type IntegrationDecisionRecord,
  type IntegrationDeliveryRecord,
  type IntegrationRecord,
  type ListIntegrationDecisionsInput,
  type ListIntegrationsInput,
  type ListRetryableDeliveriesInput,
  type MarkDeliveryFailedInput,
  type MarkDeliverySentInput,
  type PruneIntegrationEventsInput,
  type RecordIntegrationDecisionInput,
  type RecordIntegrationEventInput,
  type ReleaseDeliveryInput,
  type UpdateIntegrationInput,
} from '../../integrationStore';
import type { AtomicRunner } from '../atomic';
import { isUniqueViolation } from '../errors';
import { jsonbBind, jsonListValues, jsonText, nowIso, whereCreatedByOrAgentIds } from '../sqlExpressions';
import type { Database } from '../types';

/** Column list projecting the JSONB manifest/created_by_subject as parsed JSON (see JSON_RESULT_COLUMNS). */
function integrationColumns(eb: ExpressionBuilder<Database, 'integration'>) {
  return [
    'id' as const,
    'tenant_id' as const,
    'agent_id' as const,
    'agent_name' as const,
    'type' as const,
    'external_account_id' as const,
    jsonText<unknown>(eb.ref('manifest')).as('manifest'),
    jsonText<unknown>(eb.ref('created_by_subject')).as('created_by_subject'),
    'created_at' as const,
    'updated_at' as const,
  ];
}

interface IntegrationRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_name: string;
  type: IntegrationType;
  external_account_id: string;
  manifest: unknown;
  created_by_subject: unknown;
  created_at: string;
  updated_at: string;
}

/** Re-validates both persisted documents, so a row written under an older schema cannot leak through. */
function toRecord(row: IntegrationRow): IntegrationRecord {
  return {
    ...row,
    manifest: parseStoredIntegrationManifest(row.manifest),
    created_by_subject: CreatedBySubjectSchema.parse(row.created_by_subject),
  };
}

const DELIVERY_COLUMNS = [
  'id',
  'tenant_id',
  'integration_id',
  'conversation_key',
  'turn_id',
  'session_external_id',
  'status',
  'attempts',
  'last_error',
  'created_at',
  'updated_at',
  'next_attempt_at',
] as const;

const DECISION_COLUMNS = [
  'id',
  'tenant_id',
  'integration_id',
  'turn_id',
  'session_id',
  'decided_by_id',
  'decided_by_display_name',
  'decision',
  'decided_at',
] as const;

export class SqliteIntegrationStore implements IIntegrationStore<Kysely<Database>> {
  readonly #db: Kysely<Database>;
  readonly #atomic: AtomicRunner<Database>;

  constructor(db: Kysely<Database>, atomic: AtomicRunner<Database>) {
    this.#db = db;
    this.#atomic = atomic;
  }

  async listIntegrations(input: ListIntegrationsInput, transaction?: Kysely<Database>): Promise<IntegrationRecord[]> {
    const db = transaction ?? this.#db;
    let query = db.selectFrom('integration').select(integrationColumns).where('tenant_id', '=', input.tenant_id);
    if (input.agent_ids !== undefined) {
      query = query.where('agent_id', 'in', jsonListValues(input.agent_ids));
    }
    if (input.agent_names !== undefined) {
      query = query.where('agent_name', 'in', jsonListValues(input.agent_names));
    }
    query = whereCreatedByOrAgentIds(query, input.created_by_or_agent_ids);
    const rows = await query.orderBy('created_at').orderBy('id').execute();
    return rows.map(toRecord);
  }

  async getIntegration(
    input: GetIntegrationInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('integration')
      .select(integrationColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async getIntegrationById(
    input: GetIntegrationByIdInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('integration')
      .select(integrationColumns)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async createIntegration(input: CreateIntegrationInput, transaction?: Kysely<Database>): Promise<IntegrationRecord> {
    const db = transaction ?? this.#db;
    const timestamp = nowIso();
    try {
      const row = await db
        .insertInto('integration')
        .values({
          id: input.id,
          tenant_id: input.tenant_id,
          agent_id: input.agent_id,
          agent_name: input.agent_name,
          type: input.type,
          external_account_id: input.external_account_id,
          manifest: jsonbBind(input.manifest),
          created_by_subject: jsonbBind(input.created_by_subject),
          created_at: timestamp,
          updated_at: timestamp,
        })
        .returning(integrationColumns)
        .executeTakeFirstOrThrow();
      return toRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new IntegrationConflictError(
          { tenant_id: input.tenant_id, type: input.type, external_account_id: input.external_account_id },
          { cause: error },
        );
      }
      throw error;
    }
  }

  async updateIntegration(
    input: UpdateIntegrationInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationRecord | undefined> {
    const db = transaction ?? this.#db;
    try {
      const row = await db
        .updateTable('integration')
        .set({
          external_account_id: input.external_account_id,
          manifest: jsonbBind(input.manifest),
          updated_at: nowIso(),
        })
        .where('tenant_id', '=', input.tenant_id)
        .where('id', '=', input.id)
        .returning(integrationColumns)
        .executeTakeFirst();
      return row === undefined ? undefined : toRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new IntegrationConflictError(
          {
            tenant_id: input.tenant_id,
            type: input.manifest.type,
            external_account_id: input.external_account_id,
          },
          { cause: error },
        );
      }
      throw error;
    }
  }

  async deleteIntegration(input: DeleteIntegrationInput, transaction?: Kysely<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db.deleteFrom('integration').where('tenant_id', '=', input.tenant_id).where('id', '=', input.id).execute();
  }

  /**
   * Guarded write: the row is inserted only when the integration still exists and no row
   * holds this event id. The conflict clause makes a lost race report zero changes rather
   * than erroring, so two concurrent copies of one event agree on a single winner.
   */
  async recordEvent(
    input: RecordIntegrationEventInput,
    transaction?: Kysely<Database>,
  ): Promise<{ recorded: boolean }> {
    const db = transaction ?? this.#db;
    const query = db
      .insertInto('integration_event')
      .columns(['id', 'tenant_id', 'integration_id', 'event_id', 'received_at'])
      .expression(
        sql`SELECT ${input.id}, i.tenant_id, i.id, ${input.event_id}, ${nowIso()}
          FROM integration AS i
          WHERE i.id = ${input.integration_id}
            AND i.tenant_id = ${input.tenant_id}
            AND NOT EXISTS (
              SELECT 1 FROM integration_event AS e
              WHERE e.integration_id = ${input.integration_id} AND e.event_id = ${input.event_id}
            )`,
      )
      .onConflict(oc => oc.doNothing())
      .compile();
    const [insert] = await this.#atomic.batchWrite({ executor: db, queries: [query] });
    return { recorded: (insert?.changes ?? 0) > 0 };
  }

  async deleteEvent(input: DeleteIntegrationEventInput, transaction?: Kysely<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db.deleteFrom('integration_event').where('id', '=', input.id).execute();
  }

  async pruneEvents(input: PruneIntegrationEventsInput, transaction?: Kysely<Database>): Promise<number> {
    const db = transaction ?? this.#db;
    const result = await db
      .deleteFrom('integration_event')
      .where('received_at', '<', input.before.toISOString())
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * Guarded write with the same shape as `recordEvent`: the parent must exist and this turn
   * must owe nothing to this conversation yet.
   */
  async enqueueDelivery(
    input: EnqueueIntegrationDeliveryInput,
    transaction?: Kysely<Database>,
  ): Promise<{ enqueued: boolean }> {
    const db = transaction ?? this.#db;
    const timestamp = nowIso();
    const query = db
      .insertInto('integration_delivery')
      .columns([...DELIVERY_COLUMNS])
      .expression(
        sql`SELECT ${input.id}, i.tenant_id, i.id, ${input.conversation_key}, ${input.turn_id},
            ${input.session_external_id}, 'pending', 0, NULL, ${timestamp}, ${timestamp},
            ${input.next_attempt_at.toISOString()}
          FROM integration AS i
          WHERE i.id = ${input.integration_id}
            AND i.tenant_id = ${input.tenant_id}
            AND NOT EXISTS (
              SELECT 1 FROM integration_delivery AS d
              WHERE d.integration_id = ${input.integration_id}
                AND d.turn_id = ${input.turn_id}
                AND d.conversation_key = ${input.conversation_key}
            )`,
      )
      .onConflict(oc => oc.doNothing())
      .compile();
    const [insert] = await this.#atomic.batchWrite({ executor: db, queries: [query] });
    return { enqueued: (insert?.changes ?? 0) > 0 };
  }

  async getPendingDelivery(
    input: GetPendingDeliveryInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationDeliveryRecord | undefined> {
    const db = transaction ?? this.#db;
    return await db
      .selectFrom('integration_delivery')
      .select([...DELIVERY_COLUMNS])
      .where('integration_id', '=', input.integration_id)
      .where('turn_id', '=', input.turn_id)
      .where('conversation_key', '=', input.conversation_key)
      .where('status', '=', 'pending')
      .executeTakeFirst();
  }

  /**
   * The exactly-once gate. `status = 'pending'` in the WHERE means only one of several callers
   * that all read the same pending row changes it, and only that caller gets a record back.
   */
  async claimDelivery(
    input: ClaimDeliveryInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationDeliveryRecord | undefined> {
    const db = transaction ?? this.#db;
    return await db
      .updateTable('integration_delivery')
      .set({
        status: 'sending',
        attempts: sql<number>`attempts + 1`,
        updated_at: nowIso(),
        next_attempt_at: input.next_attempt_at.toISOString(),
      })
      .where('integration_id', '=', input.integration_id)
      .where('turn_id', '=', input.turn_id)
      .where('conversation_key', '=', input.conversation_key)
      .where('status', '=', 'pending')
      .returning([...DELIVERY_COLUMNS])
      .executeTakeFirst();
  }

  async markDeliverySent(
    input: MarkDeliverySentInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationDeliveryRecord | undefined> {
    const db = transaction ?? this.#db;
    return await db
      .updateTable('integration_delivery')
      .set({ status: 'sent', last_error: null, updated_at: nowIso() })
      .where('id', '=', input.id)
      .where('attempts', '=', input.attempts)
      .where('status', '=', 'sending')
      .returning([...DELIVERY_COLUMNS])
      .executeTakeFirst();
  }

  async markDeliveryFailed(
    input: MarkDeliveryFailedInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationDeliveryRecord | undefined> {
    const db = transaction ?? this.#db;
    return await db
      .updateTable('integration_delivery')
      .set({ status: 'failed', last_error: input.error, updated_at: nowIso() })
      .where('id', '=', input.id)
      .where('attempts', '=', input.attempts)
      .where('status', '=', 'sending')
      .returning([...DELIVERY_COLUMNS])
      .executeTakeFirst();
  }

  async listRetryableDeliveries(
    input: ListRetryableDeliveriesInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationDeliveryRecord[]> {
    const db = transaction ?? this.#db;
    return await db
      .selectFrom('integration_delivery')
      .select([...DELIVERY_COLUMNS])
      .where('status', 'in', ['pending', 'sending'])
      .where('next_attempt_at', '<', input.before.toISOString())
      .orderBy('next_attempt_at', 'asc')
      .limit(input.limit)
      .execute();
  }

  /** `attempts` is the version stamp, so this claims a stranded `sending` row as well as a `pending` one. */
  async claimDeliveryForRetry(
    input: ClaimDeliveryForRetryInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationDeliveryRecord | undefined> {
    const db = transaction ?? this.#db;
    return await db
      .updateTable('integration_delivery')
      .set({
        status: 'sending',
        attempts: input.attempts + 1,
        updated_at: nowIso(),
        next_attempt_at: input.next_attempt_at.toISOString(),
      })
      .where('id', '=', input.id)
      .where('attempts', '=', input.attempts)
      .where('status', 'in', ['pending', 'sending'])
      .returning([...DELIVERY_COLUMNS])
      .executeTakeFirst();
  }

  /** The caller holds the turn's guarded resume row, so `ON CONFLICT DO NOTHING` only ever
   * absorbs a replay of the same decision rather than losing a different one. */
  async recordDecision(input: RecordIntegrationDecisionInput, transaction?: Kysely<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db
      .insertInto('integration_decision')
      .values({ ...input, decided_at: nowIso() })
      .onConflict(oc => oc.doNothing())
      .execute();
  }

  async listDecisions(
    input: ListIntegrationDecisionsInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationDecisionRecord[]> {
    const db = transaction ?? this.#db;
    return await db
      .selectFrom('integration_decision')
      .select([...DECISION_COLUMNS])
      .where('tenant_id', '=', input.tenant_id)
      .where('integration_id', '=', input.integration_id)
      .orderBy('decided_at', 'desc')
      .orderBy('id', 'desc')
      .limit(input.limit)
      .execute();
  }

  async releaseDelivery(
    input: ReleaseDeliveryInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationDeliveryRecord | undefined> {
    const db = transaction ?? this.#db;
    return await db
      .updateTable('integration_delivery')
      .set({
        status: 'pending',
        last_error: input.error,
        updated_at: nowIso(),
        next_attempt_at: input.next_attempt_at.toISOString(),
      })
      .where('id', '=', input.id)
      .where('attempts', '=', input.attempts)
      .where('status', '=', 'sending')
      .returning([...DELIVERY_COLUMNS])
      .executeTakeFirst();
  }
}
