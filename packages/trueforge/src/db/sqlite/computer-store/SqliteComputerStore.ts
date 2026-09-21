import { sql, type CompiledQuery, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
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
import type { AtomicRunner } from '../atomic';
import { isUniqueViolation } from '../errors';
import { jsonbBind, jsonText, nowIso } from '../sqlExpressions';
import type { Database } from '../types';

/** Column list projecting the JSONB capabilities document as parsed JSON (see JSON_RESULT_COLUMNS). */
function computerColumns(eb: ExpressionBuilder<Database, 'computer'>) {
  return [
    'id' as const,
    'tenant_id' as const,
    'name' as const,
    'owner_subject' as const,
    'status' as const,
    'credential_hash' as const,
    'hostname' as const,
    'os' as const,
    'arch' as const,
    'agent_version' as const,
    jsonText<unknown>(eb.ref('capabilities')).as('capabilities'),
    'run_as_user' as const,
    'require_approval' as const,
    'last_seen_at' as const,
    'created_at' as const,
    'updated_at' as const,
  ];
}

interface ComputerRow {
  id: string;
  tenant_id: string;
  name: string;
  owner_subject: string;
  status: ComputerRecord['status'];
  credential_hash: string | null;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  agent_version: string | null;
  capabilities: unknown;
  run_as_user: string | null;
  require_approval: number;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Re-validates the persisted document and lifts SQLite's 0/1 flag back to a boolean. */
function toRecord(row: ComputerRow): ComputerRecord {
  return {
    ...row,
    capabilities: row.capabilities === null ? null : ComputerCapabilitiesSchema.parse(row.capabilities),
    require_approval: row.require_approval !== 0,
  };
}

const AUDIT_COLUMNS = [
  'id',
  'computer_id',
  'computer_name',
  'tenant_id',
  'session_id',
  'turn_id',
  'op',
  'command',
  'exit_code',
  'outcome',
  'duration_ms',
  'bytes_out',
  'created_at',
] as const;

export class SqliteComputerStore implements IComputerStore<Kysely<Database>> {
  readonly #db: Kysely<Database>;
  readonly #atomic: AtomicRunner<Database>;

  constructor(db: Kysely<Database>, atomic: AtomicRunner<Database>) {
    this.#db = db;
    this.#atomic = atomic;
  }

  async listComputers(tenantId: string, transaction?: Kysely<Database>): Promise<ComputerRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('computer')
      .select(computerColumns)
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(toRecord);
  }

  async getComputer(
    input: { tenant_id: string; computer_id: string },
    transaction?: Kysely<Database>,
  ): Promise<ComputerRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('computer')
      .select(computerColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.computer_id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async getComputerById(computerId: string, transaction?: Kysely<Database>): Promise<ComputerRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db.selectFrom('computer').select(computerColumns).where('id', '=', computerId).executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  /** Statement 2 re-checks the row statement 1 wrote, so D1 cannot commit a computer with no code. */
  async createComputer(input: CreateComputerInput, transaction?: Kysely<Database>): Promise<ComputerRecord> {
    const db = transaction ?? this.#db;
    const timestamp = nowIso();
    const queries: readonly CompiledQuery[] = [
      db
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
          require_approval: input.require_approval ? 1 : 0,
          last_seen_at: null,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .compile(),
      db
        .insertInto('computer_enrollment')
        .columns(['code_hash', 'computer_id', 'expires_at', 'used_at', 'redeemed_credential_hash', 'created_at'])
        .expression(
          sql`SELECT ${input.code_hash}, ${input.id}, ${input.code_expires_at}, NULL, NULL, ${timestamp}
            WHERE EXISTS (SELECT 1 FROM computer WHERE id = ${input.id})`,
        )
        .compile(),
    ];
    await this.#batchWrite({ executor: db, queries, nameConflict: { tenant_id: input.tenant_id, name: input.name } });
    const created = await this.getComputerById(input.id, transaction);
    if (created === undefined) {
      throw new Error(`Computer disappeared after create: ${input.id}`);
    }
    return created;
  }

  async updateComputer(
    input: UpdateComputerInput,
    transaction?: Kysely<Database>,
  ): Promise<ComputerRecord | undefined> {
    const db = transaction ?? this.#db;
    const patch = {
      updated_at: nowIso(),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.require_approval === undefined ? {} : { require_approval: input.require_approval ? 1 : 0 }),
    };
    try {
      const row = await db
        .updateTable('computer')
        .set(patch)
        .where('tenant_id', '=', input.tenant_id)
        .where('id', '=', input.computer_id)
        .returning(computerColumns)
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
   * Every code the machine may hold goes, including unused ones issued earlier, so rotation
   * really does lock out whoever has the old material. Issuing the new code is statement 1, and
   * the later statements re-check that row: the code hash is unique to this call, where the
   * `updated_at` stamp it used to guard on is shared by anything writing in the same millisecond.
   */
  async rotateComputer(
    input: RotateComputerInput,
    transaction?: Kysely<Database>,
  ): Promise<ComputerRecord | undefined> {
    const db = transaction ?? this.#db;
    const timestamp = nowIso();
    const issued = sql<SqlBool>`EXISTS (SELECT 1 FROM computer_enrollment
      WHERE code_hash = ${input.code_hash} AND computer_id = ${input.computer_id})`;
    const queries: readonly CompiledQuery[] = [
      db
        .insertInto('computer_enrollment')
        .columns(['code_hash', 'computer_id', 'expires_at', 'used_at', 'redeemed_credential_hash', 'created_at'])
        .expression(
          sql`SELECT ${input.code_hash}, ${input.computer_id}, ${input.code_expires_at}, NULL, NULL, ${timestamp}
            WHERE EXISTS (SELECT 1 FROM computer
              WHERE id = ${input.computer_id} AND tenant_id = ${input.tenant_id} AND status <> 'revoked')`,
        )
        .compile(),
      db
        .updateTable('computer')
        .set({ credential_hash: null, status: 'pending', updated_at: timestamp })
        .where('id', '=', input.computer_id)
        .where('tenant_id', '=', input.tenant_id)
        .where('status', '<>', 'revoked')
        .where(issued)
        .compile(),
      db
        .deleteFrom('computer_enrollment')
        .where('computer_id', '=', input.computer_id)
        .where('used_at', 'is', null)
        .where('code_hash', '<>', input.code_hash)
        .where(issued)
        .compile(),
    ];
    const [issue] = await this.#batchWrite({ executor: db, queries, nameConflict: null });
    if ((issue?.changes ?? 0) === 0) {
      return undefined;
    }
    return await this.getComputer(input, transaction);
  }

  async revokeComputer(
    input: { tenant_id: string; computer_id: string },
    transaction?: Kysely<Database>,
  ): Promise<ComputerRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .updateTable('computer')
      .set({ status: 'revoked', credential_hash: null, updated_at: nowIso() })
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.computer_id)
      .returning(computerColumns)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async deleteComputer(
    input: { tenant_id: string; computer_id: string },
    transaction?: Kysely<Database>,
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
   * Statement 1 burns the code and decides the outcome; statement 2 binds the credential only
   * when that same burn landed. The burn is recognised by the credential it minted, not by its
   * instant, so a second redeem in the same millisecond cannot overwrite the winner's credential.
   * Reading the row back by its credential hash is what tells a successful enroll from a burn
   * whose computer was already revoked.
   */
  async redeemEnrollment(
    input: RedeemEnrollmentInput,
    transaction?: Kysely<Database>,
  ): Promise<ComputerRecord | undefined> {
    const db = transaction ?? this.#db;
    const queries: readonly CompiledQuery[] = [
      db
        .updateTable('computer_enrollment')
        .set({ used_at: input.now, redeemed_credential_hash: input.credential_hash })
        .where('code_hash', '=', input.code_hash)
        .where('used_at', 'is', null)
        .where('expires_at', '>', input.now)
        .compile(),
      db
        .updateTable('computer')
        .set({
          credential_hash: input.credential_hash,
          status: 'offline',
          hostname: input.hostname,
          os: input.os,
          arch: input.arch,
          agent_version: input.agent_version,
          updated_at: input.now,
        })
        .where(
          'id',
          '=',
          sql<string>`(SELECT computer_id FROM computer_enrollment WHERE code_hash = ${input.code_hash})`,
        )
        .where('status', '<>', 'revoked')
        .where(
          sql<SqlBool>`EXISTS (SELECT 1 FROM computer_enrollment
            WHERE code_hash = ${input.code_hash} AND redeemed_credential_hash = ${input.credential_hash})`,
        )
        .compile(),
    ];
    const [burn] = await this.#batchWrite({ executor: db, queries, nameConflict: null });
    if (burn?.changes !== 1) {
      return undefined;
    }
    return await this.getComputerByCredentialHash(input.credential_hash, transaction);
  }

  async hasRedeemableEnrollment(
    input: { code_hash: string; now: string },
    transaction?: Kysely<Database>,
  ): Promise<boolean> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('computer_enrollment')
      .innerJoin('computer', 'computer.id', 'computer_enrollment.computer_id')
      .select('computer_enrollment.code_hash')
      .where('computer_enrollment.code_hash', '=', input.code_hash)
      .where('computer_enrollment.used_at', 'is', null)
      .where('computer_enrollment.expires_at', '>', input.now)
      .where('computer.status', '<>', 'revoked')
      .executeTakeFirst();
    return row !== undefined;
  }

  async getComputerByCredentialHash(
    credentialHash: string,
    transaction?: Kysely<Database>,
  ): Promise<ComputerRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('computer')
      .select(computerColumns)
      .where('credential_hash', '=', credentialHash)
      .where('status', '<>', 'revoked')
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async recordPresence(input: ComputerPresenceInput, transaction?: Kysely<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    const patch = {
      status: input.status,
      updated_at: nowIso(),
      ...(input.last_seen_at === null ? {} : { last_seen_at: input.last_seen_at }),
      ...(input.hello === undefined
        ? {}
        : {
            hostname: input.hello.hostname,
            os: input.hello.os,
            arch: input.hello.arch,
            agent_version: input.hello.agent_version,
            run_as_user: input.hello.run_as_user,
            capabilities: jsonbBind(input.hello.capabilities),
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
    transaction?: Kysely<Database>,
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

  /**
   * The grants arrive as one bound JSON array read through `json_each`, so the statement holds a
   * fixed five parameters however long the allowlist is (D1 caps a statement at 100).
   */
  async putAgentAccess(
    input: { tenant_id: string; computer_id: string; agents: readonly ComputerAgentGrant[] },
    transaction?: Kysely<Database>,
  ): Promise<ComputerAgentGrant[] | undefined> {
    const db = transaction ?? this.#db;
    if ((await this.getComputer(input, transaction)) === undefined) {
      return undefined;
    }
    const grants = [...new Map(input.agents.map(agent => [agent.agent_id, agent])).values()];
    const owned = sql<SqlBool>`EXISTS (SELECT 1 FROM computer WHERE id = ${input.computer_id} AND tenant_id = ${input.tenant_id})`;
    const queries: readonly CompiledQuery[] = [
      db.deleteFrom('computer_agent_access').where('computer_id', '=', input.computer_id).where(owned).compile(),
      db
        .insertInto('computer_agent_access')
        .columns(['computer_id', 'agent_id', 'agent_name', 'created_at'])
        .expression(
          sql`SELECT ${input.computer_id}, json_extract(value, '$.agent_id'), json_extract(value, '$.agent_name'),
              ${nowIso()}
            FROM json_each(${JSON.stringify(grants)})
            WHERE ${owned}`,
        )
        .compile(),
    ];
    await this.#batchWrite({ executor: db, queries, nameConflict: null });
    return await this.listAgentAccess(input, transaction);
  }

  async isAgentAllowed(
    input: { tenant_id: string; computer_id: string; agent_id: string },
    transaction?: Kysely<Database>,
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
    transaction?: Kysely<Database>,
  ): Promise<number> {
    const db = transaction ?? this.#db;
    const result = await db
      .deleteFrom('computer_agent_access')
      .where('agent_id', '=', input.agent_id)
      .where(
        sql<SqlBool>`EXISTS (SELECT 1 FROM computer
          WHERE computer.id = computer_agent_access.computer_id AND computer.tenant_id = ${input.tenant_id})`,
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async countAgentAccess(
    input: { tenant_id: string; computer_id: string },
    transaction?: Kysely<Database>,
  ): Promise<number> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('computer_agent_access')
      .innerJoin('computer', 'computer.id', 'computer_agent_access.computer_id')
      .select(eb => eb.fn.countAll<number>().as('count'))
      .where('computer_agent_access.computer_id', '=', input.computer_id)
      .where('computer.tenant_id', '=', input.tenant_id)
      .executeTakeFirstOrThrow();
    return row.count;
  }

  async appendAudit(input: AppendComputerAuditInput, transaction?: Kysely<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db.insertInto('computer_audit').values(input).execute();
  }

  async listAudit(input: ListComputerAuditInput, transaction?: Kysely<Database>): Promise<ComputerAuditRecord[]> {
    const db = transaction ?? this.#db;
    let query = db
      .selectFrom('computer_audit')
      .select([...AUDIT_COLUMNS])
      .where('tenant_id', '=', input.tenant_id);
    if (input.computer_id !== undefined) {
      query = query.where('computer_id', '=', input.computer_id);
    }
    if (input.before_id !== undefined) {
      query = query.where('id', '<', input.before_id);
    }
    return await query.orderBy('id', 'desc').limit(input.limit).execute();
  }

  async deleteAuditBefore(input: { before: string }, transaction?: Kysely<Database>): Promise<number> {
    const db = transaction ?? this.#db;
    const result = await db.deleteFrom('computer_audit').where('created_at', '<', input.before).executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async #batchWrite(input: {
    executor: Kysely<Database>;
    queries: readonly CompiledQuery[];
    /** Set when a statement writes `computer.name`, so a unique violation is a name clash. */
    nameConflict: { tenant_id: string; name: string } | null;
  }): Promise<readonly { changes: number }[]> {
    try {
      return await this.#atomic.batchWrite({ executor: input.executor, queries: input.queries });
    } catch (error) {
      if (input.nameConflict !== null && isUniqueViolation(error)) {
        throw new ComputerNameConflictError(input.nameConflict, { cause: error });
      }
      throw error;
    }
  }
}
