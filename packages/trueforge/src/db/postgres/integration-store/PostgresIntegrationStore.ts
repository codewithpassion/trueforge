import { CreatedBySubjectSchema } from '@truefoundry/trueforge-core/agent-session';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
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
  type IntegrationDeliveryRecord,
  type IntegrationRecord,
  type ListIntegrationsInput,
  type ListRetryableDeliveriesInput,
  type MarkDeliveryFailedInput,
  type MarkDeliverySentInput,
  type PruneIntegrationEventsInput,
  type RecordIntegrationEventInput,
  type ReleaseDeliveryInput,
  type UpdateIntegrationInput,
} from '../../integrationStore';
import { isUniqueViolation } from '../client';
import { json, now } from '../sqlExpressions';
import type { Database, IntegrationDeliveryTable, IntegrationTable } from '../types';

/** Re-validates both persisted documents, so a row written under an older schema cannot leak through. */
function toRecord(row: Selectable<IntegrationTable>): IntegrationRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    type: row.type,
    external_account_id: row.external_account_id,
    manifest: parseStoredIntegrationManifest(row.manifest),
    created_by_subject: CreatedBySubjectSchema.parse(row.created_by_subject),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function toDeliveryRecord(row: Selectable<IntegrationDeliveryTable>): IntegrationDeliveryRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    integration_id: row.integration_id,
    conversation_key: row.conversation_key,
    turn_id: row.turn_id,
    status: row.status,
    attempts: row.attempts,
    last_error: row.last_error,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export class PostgresIntegrationStore implements IIntegrationStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async listIntegrations(
    input: ListIntegrationsInput,
    transaction?: Transaction<Database>,
  ): Promise<IntegrationRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('integration')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(toRecord);
  }

  async getIntegration(
    input: GetIntegrationInput,
    transaction?: Transaction<Database>,
  ): Promise<IntegrationRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('integration')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async getIntegrationById(
    input: GetIntegrationByIdInput,
    transaction?: Transaction<Database>,
  ): Promise<IntegrationRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db.selectFrom('integration').selectAll().where('id', '=', input.id).executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async createIntegration(
    input: CreateIntegrationInput,
    transaction?: Transaction<Database>,
  ): Promise<IntegrationRecord> {
    const db = transaction ?? this.#db;
    try {
      const row = await db
        .insertInto('integration')
        .values({
          id: input.id,
          tenant_id: input.tenant_id,
          type: input.type,
          external_account_id: input.external_account_id,
          manifest: json(input.manifest),
          created_by_subject: json(input.created_by_subject),
          created_at: now(),
          updated_at: now(),
        })
        .returningAll()
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
    transaction?: Transaction<Database>,
  ): Promise<IntegrationRecord | undefined> {
    const db = transaction ?? this.#db;
    try {
      const row = await db
        .updateTable('integration')
        .set({
          external_account_id: input.external_account_id,
          manifest: json(input.manifest),
          updated_at: now(),
        })
        .where('tenant_id', '=', input.tenant_id)
        .where('id', '=', input.id)
        .returningAll()
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

  async deleteIntegration(input: DeleteIntegrationInput, transaction?: Transaction<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db.deleteFrom('integration').where('tenant_id', '=', input.tenant_id).where('id', '=', input.id).execute();
  }

  /** Same guarded `INSERT … SELECT FROM integration` shape as the SQLite dialect. */
  async recordEvent(
    input: RecordIntegrationEventInput,
    transaction?: Transaction<Database>,
  ): Promise<{ recorded: boolean }> {
    const db = transaction ?? this.#db;
    const inserted = await db
      .insertInto('integration_event')
      .columns(['id', 'tenant_id', 'integration_id', 'event_id', 'received_at'])
      .expression(
        sql`SELECT ${input.id}, i.tenant_id, i.id, ${input.event_id}, now()
          FROM integration AS i
          WHERE i.id = ${input.integration_id}
            AND i.tenant_id = ${input.tenant_id}
            AND NOT EXISTS (
              SELECT 1 FROM integration_event AS e
              WHERE e.integration_id = ${input.integration_id} AND e.event_id = ${input.event_id}
            )`,
      )
      .onConflict(oc => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    return { recorded: inserted !== undefined };
  }

  async deleteEvent(input: DeleteIntegrationEventInput, transaction?: Transaction<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db.deleteFrom('integration_event').where('id', '=', input.id).execute();
  }

  async pruneEvents(input: PruneIntegrationEventsInput, transaction?: Transaction<Database>): Promise<number> {
    const db = transaction ?? this.#db;
    const result = await db.deleteFrom('integration_event').where('received_at', '<', input.before).executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async enqueueDelivery(
    input: EnqueueIntegrationDeliveryInput,
    transaction?: Transaction<Database>,
  ): Promise<{ enqueued: boolean }> {
    const db = transaction ?? this.#db;
    const inserted = await db
      .insertInto('integration_delivery')
      .columns([
        'id',
        'tenant_id',
        'integration_id',
        'conversation_key',
        'turn_id',
        'status',
        'attempts',
        'last_error',
        'created_at',
        'updated_at',
      ])
      .expression(
        sql`SELECT ${input.id}, i.tenant_id, i.id, ${input.conversation_key}, ${input.turn_id},
            'pending', 0, NULL, now(), now()
          FROM integration AS i
          WHERE i.id = ${input.integration_id}
            AND i.tenant_id = ${input.tenant_id}
            AND NOT EXISTS (
              SELECT 1 FROM integration_delivery AS d WHERE d.turn_id = ${input.turn_id}
            )`,
      )
      .onConflict(oc => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    return { enqueued: inserted !== undefined };
  }

  async getPendingDelivery(
    input: GetPendingDeliveryInput,
    transaction?: Transaction<Database>,
  ): Promise<IntegrationDeliveryRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('integration_delivery')
      .selectAll()
      .where('turn_id', '=', input.turn_id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return row === undefined ? undefined : toDeliveryRecord(row);
  }

  /**
   * The exactly-once gate. `status = 'pending'` in the WHERE means only one of several callers
   * that all read the same pending row changes it, and only that caller gets a record back.
   */
  async claimDelivery(
    input: ClaimDeliveryInput,
    transaction?: Transaction<Database>,
  ): Promise<IntegrationDeliveryRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .updateTable('integration_delivery')
      .set({ status: 'sending', attempts: sql<number>`attempts + 1`, updated_at: now() })
      .where('turn_id', '=', input.turn_id)
      .where('status', '=', 'pending')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toDeliveryRecord(row);
  }

  async markDeliverySent(
    input: MarkDeliverySentInput,
    transaction?: Transaction<Database>,
  ): Promise<IntegrationDeliveryRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .updateTable('integration_delivery')
      .set({ status: 'sent', last_error: null, updated_at: now() })
      .where('id', '=', input.id)
      .where('attempts', '=', input.attempts)
      .where('status', '=', 'sending')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toDeliveryRecord(row);
  }

  async markDeliveryFailed(
    input: MarkDeliveryFailedInput,
    transaction?: Transaction<Database>,
  ): Promise<IntegrationDeliveryRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .updateTable('integration_delivery')
      .set({ status: 'failed', last_error: input.error, updated_at: now() })
      .where('id', '=', input.id)
      .where('attempts', '=', input.attempts)
      .where('status', '=', 'sending')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toDeliveryRecord(row);
  }

  async listRetryableDeliveries(
    input: ListRetryableDeliveriesInput,
    transaction?: Transaction<Database>,
  ): Promise<IntegrationDeliveryRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('integration_delivery')
      .selectAll()
      .where('status', 'in', ['pending', 'sending'])
      .where('updated_at', '<', input.before)
      .orderBy('updated_at', 'asc')
      .limit(input.limit)
      .execute();
    return rows.map(toDeliveryRecord);
  }

  /** `attempts` is the version stamp, so this claims a stranded `sending` row as well as a `pending` one. */
  async claimDeliveryForRetry(
    input: ClaimDeliveryForRetryInput,
    transaction?: Transaction<Database>,
  ): Promise<IntegrationDeliveryRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .updateTable('integration_delivery')
      .set({ status: 'sending', attempts: input.attempts + 1, updated_at: now() })
      .where('id', '=', input.id)
      .where('attempts', '=', input.attempts)
      .where('status', 'in', ['pending', 'sending'])
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toDeliveryRecord(row);
  }

  async releaseDelivery(
    input: ReleaseDeliveryInput,
    transaction?: Transaction<Database>,
  ): Promise<IntegrationDeliveryRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .updateTable('integration_delivery')
      .set({ status: 'pending', last_error: input.error, updated_at: now() })
      .where('id', '=', input.id)
      .where('attempts', '=', input.attempts)
      .where('status', '=', 'sending')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toDeliveryRecord(row);
  }
}
