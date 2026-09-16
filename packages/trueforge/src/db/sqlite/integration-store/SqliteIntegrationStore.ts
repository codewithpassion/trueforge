import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import type { IntegrationManifest } from '../../../schemas/integration';
import {
  IntegrationConflictError,
  type CreateIntegrationInput,
  type DeleteIntegrationInput,
  type EnqueueIntegrationDeliveryInput,
  type GetIntegrationByIdInput,
  type GetIntegrationInput,
  type GetPendingDeliveryInput,
  type IIntegrationStore,
  type IntegrationDeliveryRecord,
  type IntegrationRecord,
  type ListIntegrationsInput,
  type MarkDeliveryFailedInput,
  type MarkDeliverySentInput,
  type PruneIntegrationEventsInput,
  type RecordIntegrationEventInput,
  type UpdateIntegrationInput,
} from '../../integrationStore';
import type { AtomicRunner } from '../atomic';
import { isUniqueViolation } from '../errors';
import { jsonbBind, jsonText, nowIso } from '../sqlExpressions';
import type { Database } from '../types';

/** Column list projecting the JSONB manifest/created_by_subject as parsed JSON (see JSON_RESULT_COLUMNS). */
function integrationColumns(eb: ExpressionBuilder<Database, 'integration'>) {
  return [
    'id' as const,
    'tenant_id' as const,
    'type' as const,
    'external_account_id' as const,
    jsonText<IntegrationManifest>(eb.ref('manifest')).as('manifest'),
    jsonText<CreatedBySubject>(eb.ref('created_by_subject')).as('created_by_subject'),
    'created_at' as const,
    'updated_at' as const,
  ];
}

const DELIVERY_COLUMNS = [
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
    return await db
      .selectFrom('integration')
      .select(integrationColumns)
      .where('tenant_id', '=', input.tenant_id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  async getIntegration(
    input: GetIntegrationInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationRecord | undefined> {
    const db = transaction ?? this.#db;
    return await db
      .selectFrom('integration')
      .select(integrationColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
  }

  async getIntegrationById(
    input: GetIntegrationByIdInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationRecord | undefined> {
    const db = transaction ?? this.#db;
    return await db.selectFrom('integration').select(integrationColumns).where('id', '=', input.id).executeTakeFirst();
  }

  async createIntegration(input: CreateIntegrationInput, transaction?: Kysely<Database>): Promise<IntegrationRecord> {
    const db = transaction ?? this.#db;
    const timestamp = nowIso();
    try {
      return await db
        .insertInto('integration')
        .values({
          id: input.id,
          tenant_id: input.tenant_id,
          type: input.type,
          external_account_id: input.external_account_id,
          manifest: jsonbBind(input.manifest),
          created_by_subject: jsonbBind(input.created_by_subject),
          created_at: timestamp,
          updated_at: timestamp,
        })
        .returning(integrationColumns)
        .executeTakeFirstOrThrow();
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
      return await db
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

  async pruneEvents(input: PruneIntegrationEventsInput, transaction?: Kysely<Database>): Promise<number> {
    const db = transaction ?? this.#db;
    const result = await db
      .deleteFrom('integration_event')
      .where('received_at', '<', input.before.toISOString())
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Guarded write with the same shape as `recordEvent`: the parent must exist and the turn must be new. */
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
            'pending', 0, NULL, ${timestamp}, ${timestamp}
          FROM integration AS i
          WHERE i.id = ${input.integration_id}
            AND i.tenant_id = ${input.tenant_id}
            AND NOT EXISTS (
              SELECT 1 FROM integration_delivery AS d WHERE d.turn_id = ${input.turn_id}
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
      .where('turn_id', '=', input.turn_id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
  }

  async markDeliverySent(
    input: MarkDeliverySentInput,
    transaction?: Kysely<Database>,
  ): Promise<IntegrationDeliveryRecord | undefined> {
    const db = transaction ?? this.#db;
    return await db
      .updateTable('integration_delivery')
      .set({ status: 'sent', attempts: sql<number>`attempts + 1`, last_error: null, updated_at: nowIso() })
      .where('id', '=', input.id)
      .where('status', '=', 'pending')
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
      .set({
        status: 'failed',
        attempts: sql<number>`attempts + 1`,
        last_error: input.error,
        updated_at: nowIso(),
      })
      .where('id', '=', input.id)
      .where('status', '=', 'pending')
      .returning([...DELIVERY_COLUMNS])
      .executeTakeFirst();
  }
}
