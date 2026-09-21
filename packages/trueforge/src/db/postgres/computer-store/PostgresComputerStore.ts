import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { ComputerCapabilitiesSchema } from '../../../computers/protocol';
import type {
  AppendComputerAuditInput,
  ComputerAgentGrant,
  ComputerAuditRecord,
  ComputerPresenceInput,
  ComputerRecord,
  CreateComputerInput,
  IComputerStore,
  ListComputerAuditInput,
  RedeemEnrollmentInput,
  RotateComputerInput,
  UpdateComputerInput,
} from '../../computerStore';
import { ComputerNameConflictError } from '../../computerStoreErrors';
import { isUniqueViolation } from '../client';
import { json, now } from '../sqlExpressions';
import type { ComputerAuditTable, ComputerTable, Database } from '../types';

/** Re-validates the persisted document and lifts every timestamptz back to an ISO instant. */
function toRecord(row: Selectable<ComputerTable>): ComputerRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    owner_subject: row.owner_subject,
    status: row.status,
    credential_hash: row.credential_hash,
    hostname: row.hostname,
    os: row.os,
    arch: row.arch,
    agent_version: row.agent_version,
    capabilities: row.capabilities === null ? null : ComputerCapabilitiesSchema.parse(row.capabilities),
    run_as_user: row.run_as_user,
    require_approval: row.require_approval,
    last_seen_at: row.last_seen_at === null ? null : row.last_seen_at.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function toAuditRecord(row: Selectable<ComputerAuditTable>): ComputerAuditRecord {
  return { ...row, created_at: row.created_at.toISOString() };
}

export class PostgresComputerStore implements IComputerStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async listComputers(tenantId: string, transaction?: Transaction<Database>): Promise<ComputerRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('computer')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(toRecord);
  }

  async getComputer(
    input: { tenant_id: string; computer_id: string },
    transaction?: Transaction<Database>,
  ): Promise<ComputerRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('computer')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.computer_id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async getComputerById(computerId: string, transaction?: Transaction<Database>): Promise<ComputerRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db.selectFrom('computer').selectAll().where('id', '=', computerId).executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async createComputer(input: CreateComputerInput, transaction?: Transaction<Database>): Promise<ComputerRecord> {
    return await this.#write(transaction, async db => {
      let row;
      try {
        row = await db
          .insertInto('computer')
          .values({
            id: input.id,
            tenant_id: input.tenant_id,
            name: input.name,
            owner_subject: input.owner_subject,
            status: 'pending',
            credential_hash: null,
            hostname: null,
            os: null,
            arch: null,
            agent_version: null,
            capabilities: null,
            run_as_user: null,
            require_approval: input.require_approval,
            last_seen_at: null,
            created_at: now(),
            updated_at: now(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ComputerNameConflictError({ tenant_id: input.tenant_id, name: input.name }, { cause: error });
        }
        throw error;
      }
      await db
        .insertInto('computer_enrollment')
        .values({
          code_hash: input.code_hash,
          computer_id: input.id,
          expires_at: new Date(input.code_expires_at),
          used_at: null,
          redeemed_credential_hash: null,
          created_at: now(),
        })
        .execute();
      return toRecord(row);
    });
  }

  async updateComputer(
    input: UpdateComputerInput,
    transaction?: Transaction<Database>,
  ): Promise<ComputerRecord | undefined> {
    const db = transaction ?? this.#db;
    const patch = {
      updated_at: now(),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.require_approval === undefined ? {} : { require_approval: input.require_approval }),
    };
    try {
      const row = await db
        .updateTable('computer')
        .set(patch)
        .where('tenant_id', '=', input.tenant_id)
        .where('id', '=', input.computer_id)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toRecord(row);
    } catch (error) {
      if (input.name !== undefined && isUniqueViolation(error)) {
        throw new ComputerNameConflictError({ tenant_id: input.tenant_id, name: input.name }, { cause: error });
      }
      throw error;
    }
  }

  /**
   * Every unused code goes too, so rotation locks out whoever holds the old material. The
   * statements need no identity guard between them: the opening UPDATE takes the computer row's
   * lock, so a second rotation waits and re-evaluates instead of interleaving.
   */
  async rotateComputer(
    input: RotateComputerInput,
    transaction?: Transaction<Database>,
  ): Promise<ComputerRecord | undefined> {
    return await this.#write(transaction, async db => {
      const row = await db
        .updateTable('computer')
        .set({ credential_hash: null, status: 'pending', updated_at: now() })
        .where('id', '=', input.computer_id)
        .where('tenant_id', '=', input.tenant_id)
        .where('status', '<>', 'revoked')
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) {
        return undefined;
      }
      await db
        .deleteFrom('computer_enrollment')
        .where('computer_id', '=', input.computer_id)
        .where('used_at', 'is', null)
        .execute();
      await db
        .insertInto('computer_enrollment')
        .values({
          code_hash: input.code_hash,
          computer_id: input.computer_id,
          expires_at: new Date(input.code_expires_at),
          used_at: null,
          redeemed_credential_hash: null,
          created_at: now(),
        })
        .execute();
      return toRecord(row);
    });
  }

  async revokeComputer(
    input: { tenant_id: string; computer_id: string },
    transaction?: Transaction<Database>,
  ): Promise<ComputerRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .updateTable('computer')
      .set({ status: 'revoked', credential_hash: null, updated_at: now() })
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.computer_id)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async deleteComputer(
    input: { tenant_id: string; computer_id: string },
    transaction?: Transaction<Database>,
  ): Promise<boolean> {
    const db = transaction ?? this.#db;
    const result = await db
      .deleteFrom('computer')
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.computer_id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /**
   * The code is burned whatever happens next, so a revoked machine cannot retry it; only a
   * computer that took the credential comes back. The burn records the credential it minted:
   * the row lock already serialises two redeems of one code, and the stamp keeps the enrollment
   * row able to say which credential won.
   */
  async redeemEnrollment(
    input: RedeemEnrollmentInput,
    transaction?: Transaction<Database>,
  ): Promise<ComputerRecord | undefined> {
    const moment = new Date(input.now);
    return await this.#write(transaction, async db => {
      const burnt = await db
        .updateTable('computer_enrollment')
        .set({ used_at: moment, redeemed_credential_hash: input.credential_hash })
        .where('code_hash', '=', input.code_hash)
        .where('used_at', 'is', null)
        .where('expires_at', '>', moment)
        .returning('computer_id')
        .executeTakeFirst();
      if (burnt === undefined) {
        return undefined;
      }
      const row = await db
        .updateTable('computer')
        .set({
          credential_hash: input.credential_hash,
          status: 'offline',
          hostname: input.hostname,
          os: input.os,
          arch: input.arch,
          agent_version: input.agent_version,
          updated_at: moment,
        })
        .where('id', '=', burnt.computer_id)
        .where('status', '<>', 'revoked')
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toRecord(row);
    });
  }

  async hasRedeemableEnrollment(
    input: { code_hash: string; now: string },
    transaction?: Transaction<Database>,
  ): Promise<boolean> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('computer_enrollment')
      .innerJoin('computer', 'computer.id', 'computer_enrollment.computer_id')
      .select('computer_enrollment.code_hash')
      .where('computer_enrollment.code_hash', '=', input.code_hash)
      .where('computer_enrollment.used_at', 'is', null)
      .where('computer_enrollment.expires_at', '>', new Date(input.now))
      .where('computer.status', '<>', 'revoked')
      .executeTakeFirst();
    return row !== undefined;
  }

  async getComputerByCredentialHash(
    credentialHash: string,
    transaction?: Transaction<Database>,
  ): Promise<ComputerRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('computer')
      .selectAll()
      .where('credential_hash', '=', credentialHash)
      .where('status', '<>', 'revoked')
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async recordPresence(input: ComputerPresenceInput, transaction?: Transaction<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    const patch = {
      status: input.status,
      updated_at: now(),
      ...(input.last_seen_at === null ? {} : { last_seen_at: new Date(input.last_seen_at) }),
      ...(input.hello === undefined
        ? {}
        : {
            hostname: input.hello.hostname,
            os: input.hello.os,
            arch: input.hello.arch,
            agent_version: input.hello.agent_version,
            run_as_user: input.hello.run_as_user,
            capabilities: json(input.hello.capabilities),
          }),
    };
    await db
      .updateTable('computer')
      .set(patch)
      .where('id', '=', input.computer_id)
      .where('status', '<>', 'revoked')
      // A machine with no credential is waiting to be enrolled, not offline. Without this the
      // alarm of the socket a rotation just closed would overwrite `pending` a minute later.
      .where('credential_hash', 'is not', null)
      .execute();
  }

  async listAgentAccess(
    input: { tenant_id: string; computer_id: string },
    transaction?: Transaction<Database>,
  ): Promise<ComputerAgentGrant[]> {
    const db = transaction ?? this.#db;
    return await db
      .selectFrom('computer_agent_access')
      .innerJoin('computer', 'computer.id', 'computer_agent_access.computer_id')
      .select(['computer_agent_access.agent_id', 'computer_agent_access.agent_name'])
      .where('computer_agent_access.computer_id', '=', input.computer_id)
      .where('computer.tenant_id', '=', input.tenant_id)
      // Two agents may share a stale display name, so the id breaks the tie.
      .orderBy('computer_agent_access.agent_name')
      .orderBy('computer_agent_access.agent_id')
      .execute();
  }

  /** The grants arrive as one bound jsonb array, so the statement's parameter count is fixed. */
  async putAgentAccess(
    input: { tenant_id: string; computer_id: string; agents: readonly ComputerAgentGrant[] },
    transaction?: Transaction<Database>,
  ): Promise<ComputerAgentGrant[] | undefined> {
    const grants = [...new Map(input.agents.map(agent => [agent.agent_id, agent])).values()];
    return await this.#write(transaction, async db => {
      const owner = await db
        .selectFrom('computer')
        .select('id')
        .where('id', '=', input.computer_id)
        .where('tenant_id', '=', input.tenant_id)
        .executeTakeFirst();
      if (owner === undefined) {
        return undefined;
      }
      await db.deleteFrom('computer_agent_access').where('computer_id', '=', input.computer_id).execute();
      await db
        .insertInto('computer_agent_access')
        .columns(['computer_id', 'agent_id', 'agent_name', 'created_at'])
        .expression(
          sql`SELECT ${input.computer_id}, entry->>'agent_id', entry->>'agent_name', now()
            FROM jsonb_array_elements(${json(grants)}) AS entry`,
        )
        .execute();
      return await db
        .selectFrom('computer_agent_access')
        .select(['agent_id', 'agent_name'])
        .where('computer_id', '=', input.computer_id)
        .orderBy('agent_name')
        .orderBy('agent_id')
        .execute();
    });
  }

  async isAgentAllowed(
    input: { tenant_id: string; computer_id: string; agent_id: string },
    transaction?: Transaction<Database>,
  ): Promise<boolean> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('computer_agent_access')
      .innerJoin('computer', 'computer.id', 'computer_agent_access.computer_id')
      .select('computer_agent_access.agent_id')
      .where('computer_agent_access.computer_id', '=', input.computer_id)
      .where('computer_agent_access.agent_id', '=', input.agent_id)
      .where('computer.tenant_id', '=', input.tenant_id)
      .executeTakeFirst();
    return row !== undefined;
  }

  async deleteAgentAccessForAgent(
    input: { tenant_id: string; agent_id: string },
    transaction?: Transaction<Database>,
  ): Promise<number> {
    const db = transaction ?? this.#db;
    const result = await db
      .deleteFrom('computer_agent_access')
      .where('agent_id', '=', input.agent_id)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom('computer')
            .select('computer.id')
            .whereRef('computer.id', '=', 'computer_agent_access.computer_id')
            .where('computer.tenant_id', '=', input.tenant_id),
        ),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async countAgentAccess(
    input: { tenant_id: string; computer_id: string },
    transaction?: Transaction<Database>,
  ): Promise<number> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('computer_agent_access')
      .innerJoin('computer', 'computer.id', 'computer_agent_access.computer_id')
      .select(eb => eb.fn.countAll<string>().as('count'))
      .where('computer_agent_access.computer_id', '=', input.computer_id)
      .where('computer.tenant_id', '=', input.tenant_id)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async appendAudit(input: AppendComputerAuditInput, transaction?: Transaction<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db
      .insertInto('computer_audit')
      .values({ ...input, created_at: new Date(input.created_at) })
      .execute();
  }

  async listAudit(input: ListComputerAuditInput, transaction?: Transaction<Database>): Promise<ComputerAuditRecord[]> {
    const db = transaction ?? this.#db;
    let query = db.selectFrom('computer_audit').selectAll().where('tenant_id', '=', input.tenant_id);
    if (input.computer_id !== undefined) {
      query = query.where('computer_id', '=', input.computer_id);
    }
    if (input.before_id !== undefined) {
      query = query.where('id', '<', input.before_id);
    }
    const rows = await query.orderBy('id', 'desc').limit(input.limit).execute();
    return rows.map(toAuditRecord);
  }

  async deleteAuditBefore(input: { before: string }, transaction?: Transaction<Database>): Promise<number> {
    const db = transaction ?? this.#db;
    const result = await db
      .deleteFrom('computer_audit')
      .where('created_at', '<', new Date(input.before))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Multi-statement writes run in one transaction — the caller's when it holds one. */
  async #write<T>(
    transaction: Transaction<Database> | undefined,
    callback: (db: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    if (transaction !== undefined) {
      return await callback(transaction);
    }
    return await this.#db.transaction().execute(callback);
  }
}
