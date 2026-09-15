import {
  CreatedBySubjectSchema,
  type CreatedBySubject,
  type TokenPagination,
} from '@truefoundry/trueforge-core/agent-session';
import {
  decodeOffsetPageToken,
  paginateOffsetRows,
} from '@truefoundry/trueforge-core/agent-session/store/OffsetPageToken';
import {
  sql,
  type CompiledQuery,
  type ExpressionBuilder,
  type Kysely,
  type RawBuilder,
  type Transaction,
} from 'kysely';
import { nextTriggerAfter } from '../../../runtime/cron';
import type { ScheduleManifest, ScheduleRunStatus, ScheduleStatus } from '../../../schemas/schedule';
import { newId } from '../../../utils/id';
import {
  cronRunName,
  parseStoredScheduleManifest,
  ScheduleConcurrentUpdateError,
  ScheduleNameConflictError,
  ScheduleRunConflictError,
  shouldSyncPendingRun,
  type CreateScheduleInput,
  type CreateScheduleRunInput,
  type DeleteScheduleInput,
  type FinishScheduleRunInput,
  type GetOwnedIdsInput,
  type GetRunByIdInput,
  type GetRunInput,
  type GetScheduledRunForInput,
  type GetScheduleInput,
  type IScheduleStore,
  type ListRunsInput,
  type ListScheduledRunsInput,
  type ListSchedulesInput,
  type ScheduleRecord,
  type ScheduleRunRecord,
  type ScheduleWriteResult,
  type UpdateScheduleInput,
  type UpdateScheduleRunStatusInput,
} from '../../scheduleStore';
import type { AtomicRunner, BatchStatementResult } from '../atomic';
import { isUniqueViolation } from '../client';
import { jsonbBind, jsonText, nowIso, whereCreatedByOrAgentIds } from '../sqlExpressions';
import type { Database } from '../types';

/** Column list projecting the JSONB manifest as parsed JSON (see JSON_RESULT_COLUMNS). */
function scheduleColumns(eb: ExpressionBuilder<Database, 'schedule'>) {
  return [
    'id' as const,
    'tenant_id' as const,
    'agent_id' as const,
    'agent_name' as const,
    'name' as const,
    jsonText<ScheduleManifest>(eb.ref('manifest')).as('manifest'),
    'status' as const,
    jsonText<CreatedBySubject>(eb.ref('created_by_subject')).as('created_by_subject'),
    'created_at' as const,
    'updated_at' as const,
  ];
}

function runColumns(eb: ExpressionBuilder<Database, 'schedule_run'>) {
  return [
    'id' as const,
    'tenant_id' as const,
    'schedule_id' as const,
    'name' as const,
    'scheduled_for' as const,
    'status' as const,
    jsonText<CreatedBySubject>(eb.ref('created_by_subject')).as('created_by_subject'),
    'triggered_at' as const,
    'reason' as const,
    'created_at' as const,
    'updated_at' as const,
  ];
}

interface ScheduleRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_name: string;
  name: string;
  manifest: ScheduleManifest;
  status: ScheduleStatus;
  created_by_subject: CreatedBySubject;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  tenant_id: string;
  schedule_id: string;
  name: string;
  scheduled_for: string;
  status: ScheduleRunStatus;
  created_by_subject: CreatedBySubject;
  triggered_at: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function toScheduleRecord(row: ScheduleRow): ScheduleRecord {
  return {
    ...row,
    manifest: parseStoredScheduleManifest(row.manifest),
    created_by_subject: CreatedBySubjectSchema.parse(row.created_by_subject),
  };
}

function toRunRecord(row: RunRow): ScheduleRunRecord {
  return {
    ...row,
    created_by_subject: CreatedBySubjectSchema.parse(row.created_by_subject),
  };
}

/** Chain predicate: the schedule still carries the `updated_at` this write read or wrote. */
function scheduleAt(schedule: { id: string; updated_at: string }): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM schedule WHERE id = ${schedule.id} AND updated_at = ${schedule.updated_at})`;
}

/**
 * Pending run copied from the schedule row, written only while the schedule carries
 * `schedule_updated_at` (and, when finishing a run, that run still exists).
 */
function pendingRunQuery(
  db: Kysely<Database>,
  args: { schedule_id: string; schedule_updated_at: string; scheduled_for: Date; finished_run_id: string | null },
): CompiledQuery {
  const timestamp = nowIso();
  const finishedRunExists =
    args.finished_run_id === null
      ? sql``
      : sql` AND EXISTS (SELECT 1 FROM schedule_run WHERE id = ${args.finished_run_id})`;
  return db
    .insertInto('schedule_run')
    .columns([
      'id',
      'tenant_id',
      'schedule_id',
      'name',
      'scheduled_for',
      'status',
      'created_by_subject',
      'triggered_at',
      'reason',
      'created_at',
      'updated_at',
    ])
    .expression(
      sql`SELECT ${newId()}, tenant_id, id, ${cronRunName(args.scheduled_for)}, ${args.scheduled_for.toISOString()},
          'scheduled', created_by_subject, NULL, NULL, ${timestamp}, ${timestamp}
        FROM schedule
        WHERE id = ${args.schedule_id} AND updated_at = ${args.schedule_updated_at}${finishedRunExists}`,
    )
    .compile();
}

/** Batches cannot say which statement failed; the constraint message names the table. */
function isScheduleRunUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('schedule_run.');
}

export class SqliteScheduleStore implements IScheduleStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;
  readonly #atomic: AtomicRunner<Database>;

  constructor(db: Kysely<Database>, atomic: AtomicRunner<Database>) {
    this.#db = db;
    this.#atomic = atomic;
  }

  async getSchedule(input: GetScheduleInput, transaction?: Transaction<Database>): Promise<ScheduleRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('schedule')
      .select(scheduleColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toScheduleRecord(row);
  }

  /** No row lock in the SQLite dialect; writes guard on the `updated_at` read here instead. */
  async getScheduleForUpdate(
    input: GetScheduleInput,
    transaction: Transaction<Database>,
  ): Promise<ScheduleRecord | undefined> {
    return this.getSchedule(input, transaction);
  }

  async createScheduleAndRun(
    input: CreateScheduleInput,
    transaction?: Transaction<Database>,
  ): Promise<ScheduleWriteResult> {
    const db = transaction ?? this.#db;
    const id = newId();
    const timestamp = nowIso();
    const queries: CompiledQuery[] = [
      db
        .insertInto('schedule')
        .values({
          id,
          tenant_id: input.tenant_id,
          agent_id: input.agent_id,
          agent_name: input.agent_name,
          name: input.name,
          manifest: jsonbBind(input.manifest),
          // Column mirrors the manifest so the dispatch scan and API reads share one value.
          status: input.manifest.status,
          created_by_subject: jsonbBind(input.created_by_subject),
          created_at: timestamp,
          updated_at: timestamp,
        })
        .compile(),
    ];
    if (input.manifest.status === 'active') {
      queries.push(
        pendingRunQuery(db, {
          schedule_id: id,
          finished_run_id: null,
          schedule_updated_at: timestamp,
          scheduled_for: nextTriggerAfter({
            cron: input.manifest.cron,
            timezone: input.manifest.timezone,
            from: input.runFrom,
          }),
        }),
      );
    }
    await this.#batchWrite({
      executor: db,
      queries,
      nameConflict: { tenant_id: input.tenant_id, agent_name: input.agent_name, name: input.name },
    });
    return this.#readWriteResult({ tenant_id: input.tenant_id, id }, transaction);
  }

  /**
   * Conditional chain keyed on `updated_at`: the schedule UPDATE requires the value read here,
   * and the pending-run delete/insert require the new value, which only that UPDATE writes.
   */
  async updateScheduleAndRun(
    input: UpdateScheduleInput,
    transaction?: Transaction<Database>,
  ): Promise<ScheduleWriteResult | undefined> {
    const db = transaction ?? this.#db;
    const previous = await this.getSchedule({ tenant_id: input.tenant_id, id: input.id }, transaction);
    if (previous === undefined) {
      return undefined;
    }

    // Strictly later than the read value, so the chain marker cannot match the old row.
    const timestamp = new Date(Math.max(Date.now(), Date.parse(previous.updated_at) + 1)).toISOString();
    const queries: CompiledQuery[] = [
      db
        .updateTable('schedule')
        .set({
          name: input.name,
          manifest: jsonbBind(input.manifest),
          status: input.manifest.status,
          updated_at: timestamp,
        })
        .where('tenant_id', '=', input.tenant_id)
        .where('id', '=', input.id)
        .where('updated_at', '=', previous.updated_at)
        .compile(),
    ];
    if (shouldSyncPendingRun(previous, { status: input.manifest.status, manifest: input.manifest })) {
      queries.push(
        db
          .deleteFrom('schedule_run')
          .where('tenant_id', '=', input.tenant_id)
          .where('schedule_id', '=', input.id)
          .where('status', '=', 'scheduled')
          .where(scheduleAt({ id: input.id, updated_at: timestamp }))
          .compile(),
      );
      if (input.manifest.status === 'active') {
        queries.push(
          pendingRunQuery(db, {
            schedule_id: input.id,
            finished_run_id: null,
            schedule_updated_at: timestamp,
            scheduled_for: nextTriggerAfter({
              cron: input.manifest.cron,
              timezone: input.manifest.timezone,
              from: input.runFrom,
            }),
          }),
        );
      }
    }

    const [scheduleUpdate] = await this.#batchWrite({
      executor: db,
      queries,
      nameConflict: { tenant_id: input.tenant_id, agent_name: previous.agent_name, name: input.name },
    });
    if ((scheduleUpdate?.changes ?? 0) === 0) {
      if ((await this.getSchedule({ tenant_id: input.tenant_id, id: input.id }, transaction)) === undefined) {
        return undefined;
      }
      throw new ScheduleConcurrentUpdateError(input.id);
    }
    return this.#readWriteResult({ tenant_id: input.tenant_id, id: input.id }, transaction);
  }

  async #readWriteResult(input: GetScheduleInput, transaction?: Transaction<Database>): Promise<ScheduleWriteResult> {
    const schedule = await this.getSchedule(input, transaction);
    if (schedule === undefined) {
      throw new Error(`Schedule disappeared after write: ${input.id}`);
    }
    const pendingRun = await this.getScheduledRunFor(
      { tenant_id: schedule.tenant_id, schedule_id: schedule.id },
      transaction,
    );
    return { schedule, pendingRun };
  }

  async #batchWrite(input: {
    executor: Kysely<Database>;
    queries: CompiledQuery[];
    /** Set when a statement writes `schedule.name`, so a non-run unique violation is a name clash. */
    nameConflict: { tenant_id: string; agent_name: string; name: string } | null;
  }): Promise<readonly BatchStatementResult[]> {
    try {
      return await this.#atomic.batchWrite({ executor: input.executor, queries: input.queries });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      if (isScheduleRunUniqueViolation(error)) {
        throw new ScheduleRunConflictError('Schedule run already exists', { cause: error });
      }
      if (input.nameConflict === null) {
        throw error;
      }
      throw new ScheduleNameConflictError(input.nameConflict, { cause: error });
    }
  }

  async deleteSchedule(input: DeleteScheduleInput, transaction?: Transaction<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db.deleteFrom('schedule').where('tenant_id', '=', input.tenant_id).where('id', '=', input.id).execute();
  }

  async listSchedules(
    input: ListSchedulesInput,
    transaction?: Transaction<Database>,
  ): Promise<{ data: ScheduleRecord[]; pagination: TokenPagination }> {
    const offset = decodeOffsetPageToken(input.page_token);
    const db = transaction ?? this.#db;
    let query = db.selectFrom('schedule').select(scheduleColumns).where('tenant_id', '=', input.tenant_id);
    if (input.agent_names !== undefined) {
      query = query.where('agent_name', 'in', [...input.agent_names]);
    }
    query = whereCreatedByOrAgentIds(query, input.created_by_or_agent_ids);
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(input.limit + 1)
      .offset(offset)
      .execute();
    const { data, pagination } = paginateOffsetRows(rows, input.limit, offset);
    return { data: data.map(toScheduleRecord), pagination };
  }

  async getOwnedIds(input: GetOwnedIdsInput, transaction?: Transaction<Database>): Promise<readonly string[]> {
    if (input.ids.length === 0) {
      return [];
    }
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('schedule')
      .select('id')
      .where('tenant_id', '=', input.tenant_id)
      .where('id', 'in', [...input.ids])
      .where(sql`json_extract(created_by_subject, '$.subject_id')`, '=', input.subject_id)
      .execute();
    return rows.map(row => row.id);
  }

  async listRuns(
    input: ListRunsInput,
    transaction?: Transaction<Database>,
  ): Promise<{ data: ScheduleRunRecord[]; pagination: TokenPagination }> {
    const offset = decodeOffsetPageToken(input.page_token);
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('schedule_run')
      .select(runColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('schedule_id', '=', input.schedule_id)
      .orderBy('scheduled_for', 'desc')
      .orderBy('id')
      .limit(input.limit + 1)
      .offset(offset)
      .execute();
    const { data, pagination } = paginateOffsetRows(rows, input.limit, offset);
    return { data: data.map(toRunRecord), pagination };
  }

  async getRun(input: GetRunInput, transaction?: Transaction<Database>): Promise<ScheduleRunRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('schedule_run')
      .select(runColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRunRecord(row);
  }

  async getRunById(
    input: GetRunByIdInput,
    transaction?: Transaction<Database>,
  ): Promise<ScheduleRunRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db.selectFrom('schedule_run').select(runColumns).where('id', '=', input.id).executeTakeFirst();
    return row === undefined ? undefined : toRunRecord(row);
  }

  async getScheduledRunFor(
    input: GetScheduledRunForInput,
    transaction?: Transaction<Database>,
  ): Promise<ScheduleRunRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('schedule_run')
      .select(runColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('schedule_id', '=', input.schedule_id)
      .where('status', '=', 'scheduled')
      .executeTakeFirst();
    return row === undefined ? undefined : toRunRecord(row);
  }

  async createRun(input: CreateScheduleRunInput, transaction?: Transaction<Database>): Promise<ScheduleRunRecord> {
    const db = transaction ?? this.#db;
    const timestamp = nowIso();
    try {
      const row = await db
        .insertInto('schedule_run')
        .values({
          id: newId(),
          tenant_id: input.tenant_id,
          schedule_id: input.schedule_id,
          name: input.name,
          scheduled_for: input.scheduled_for.toISOString(),
          status: input.status,
          created_by_subject: jsonbBind(input.created_by_subject),
          triggered_at: input.triggered_at?.toISOString() ?? null,
          reason: input.reason ?? null,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .returning(runColumns)
        .executeTakeFirstOrThrow();
      return toRunRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ScheduleRunConflictError(`Schedule run already exists: ${input.name}`, { cause: error });
      }
      throw error;
    }
  }

  async updateRunStatus(
    input: UpdateScheduleRunStatusInput,
    transaction?: Transaction<Database>,
  ): Promise<ScheduleRunRecord | undefined> {
    const db = transaction ?? this.#db;
    const timestamp = nowIso();
    const reason = input.status === 'failed' ? (input.reason ?? null) : null;
    const patch =
      input.status === 'triggered'
        ? { status: input.status, triggered_at: timestamp, reason, updated_at: timestamp }
        : { status: input.status, reason, updated_at: timestamp };
    const row = await db
      .updateTable('schedule_run')
      .set(patch)
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .returning(runColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toRunRecord(row);
  }

  /** Same `updated_at` chain as updateScheduleAndRun, keyed on the schedule the caller read. */
  async finishRun(input: FinishScheduleRunInput, transaction?: Transaction<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    const { run, schedule } = input;
    const timestamp = nowIso();
    const reason = input.status === 'failed' ? input.reason : null;
    const patch =
      input.status === 'triggered'
        ? { status: input.status, triggered_at: timestamp, reason, updated_at: timestamp }
        : { status: input.status, reason, updated_at: timestamp };

    let updateRun = db
      .updateTable('schedule_run')
      .set(patch)
      .where('tenant_id', '=', run.tenant_id)
      .where('id', '=', run.id);
    if (schedule !== undefined) {
      updateRun = updateRun.where(scheduleAt(schedule));
    }
    const queries: CompiledQuery[] = [updateRun.compile()];
    if (schedule !== undefined && input.next_scheduled_for !== undefined) {
      queries.push(
        pendingRunQuery(db, {
          schedule_id: schedule.id,
          schedule_updated_at: schedule.updated_at,
          scheduled_for: input.next_scheduled_for,
          finished_run_id: run.id,
        }),
      );
    }

    const [runUpdate] = await this.#batchWrite({ executor: db, queries, nameConflict: null });
    if ((runUpdate?.changes ?? 0) === 0) {
      if ((await this.getRun({ tenant_id: run.tenant_id, id: run.id }, transaction)) === undefined) {
        return;
      }
      throw new ScheduleConcurrentUpdateError(run.schedule_id);
    }
  }

  async listScheduledRuns(
    input: ListScheduledRunsInput,
    transaction?: Transaction<Database>,
  ): Promise<ScheduleRunRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('schedule_run')
      .select(runColumns)
      .where('status', '=', 'scheduled')
      .where('scheduled_for', '<=', input.until.toISOString())
      .orderBy('scheduled_for')
      .limit(input.limit)
      .execute();
    return rows.map(toRunRecord);
  }
}
