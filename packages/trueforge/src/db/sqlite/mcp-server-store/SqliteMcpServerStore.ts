import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import type { OAuthClientRecord } from '../../../mcp/auth/types';
import type { McpServerManifest } from '../../../schemas/mcpServer';
import { newId } from '../../../utils/id';
import {
  fromStoredOAuthClientRecord,
  McpServerNameConflictError,
  toStoredOAuthClientRecord,
  type CreateMcpServerInput,
  type GetMcpServerInput,
  type IMcpServerStore,
  type ListMcpServersInput,
  type McpServerRecord,
  type OAuthClient,
  type OAuthServer,
  type UpsertMcpServerInput,
} from '../../mcpServerStore';
import type { AtomicRunner } from '../atomic';
import { isUniqueViolation } from '../errors';
import { jsonbBind, jsonListValues, jsonText, nowIso } from '../sqlExpressions';
import type { Database } from '../types';

/** Column list projecting the JSONB manifest as parsed JSON (see JSON_RESULT_COLUMNS). */
function recordColumns(eb: ExpressionBuilder<Database, 'mcp_server'>) {
  return [
    'id' as const,
    'tenant_id' as const,
    'name' as const,
    jsonText<McpServerManifest>(eb.ref('manifest')).as('manifest'),
    'created_at' as const,
    'updated_at' as const,
  ];
}

export class SqliteMcpServerStore implements IMcpServerStore<Kysely<Database>> {
  readonly #db: Kysely<Database>;
  readonly #atomic: AtomicRunner<Database>;

  constructor(db: Kysely<Database>, atomic: AtomicRunner<Database>) {
    this.#db = db;
    this.#atomic = atomic;
  }

  async listServers(input: ListMcpServersInput, transaction?: Kysely<Database>): Promise<McpServerRecord[]> {
    if (input.names?.length === 0) {
      return [];
    }
    const db = transaction ?? this.#db;
    let query = db.selectFrom('mcp_server').select(recordColumns).where('tenant_id', '=', input.tenant_id);
    if (input.names !== undefined) {
      query = query.where('name', 'in', jsonListValues(input.names));
    }
    return await query.orderBy('name').execute();
  }

  async getServer(input: GetMcpServerInput, transaction?: Kysely<Database>): Promise<McpServerRecord | undefined> {
    const db = transaction ?? this.#db;
    return await db
      .selectFrom('mcp_server')
      .select(recordColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('name', '=', input.name)
      .executeTakeFirst();
  }

  /**
   * No row lock in the SQLite dialect. better-sqlite3's single connection serializes route
   * transactions, so RMW of header secrets stays consistent there; D1 gives no such guarantee.
   */
  async getServerForUpdate(
    input: GetMcpServerInput,
    transaction: Kysely<Database>,
  ): Promise<McpServerRecord | undefined> {
    return await transaction
      .selectFrom('mcp_server')
      .select(recordColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('name', '=', input.name)
      .executeTakeFirst();
  }

  async createServer(input: CreateMcpServerInput, transaction?: Kysely<Database>): Promise<McpServerRecord> {
    const db = transaction ?? this.#db;
    const timestamp = nowIso();
    const stored = input.oauth_client === undefined ? undefined : toStoredOAuthClientRecord(input.oauth_client);
    try {
      return await db
        .insertInto('mcp_server')
        .values({
          id: newId(),
          tenant_id: input.tenant_id,
          name: input.name,
          manifest: jsonbBind(input.manifest),
          oauth_server: stored === undefined ? null : jsonbBind(stored.server),
          oauth_client: stored === undefined ? null : jsonbBind(stored.client),
          created_at: timestamp,
          updated_at: timestamp,
        })
        .returning(recordColumns)
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new McpServerNameConflictError({ tenant_id: input.tenant_id, name: input.name }, { cause: error });
      }
      throw error;
    }
  }

  async upsertServer(input: UpsertMcpServerInput, transaction?: Kysely<Database>): Promise<McpServerRecord> {
    const db = transaction ?? this.#db;
    const timestamp = nowIso();
    const stored = input.oauth_client === undefined ? undefined : toStoredOAuthClientRecord(input.oauth_client);
    const upsert = db
      .insertInto('mcp_server')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        name: input.name,
        manifest: jsonbBind(input.manifest),
        oauth_server: stored === undefined ? null : jsonbBind(stored.server),
        oauth_client: stored === undefined ? null : jsonbBind(stored.client),
        created_at: timestamp,
        updated_at: timestamp,
      })
      .onConflict(oc =>
        oc.columns(['tenant_id', 'name']).doUpdateSet({
          manifest: jsonbBind(input.manifest),
          updated_at: timestamp,
          ...(stored === undefined
            ? {}
            : { oauth_server: jsonbBind(stored.server), oauth_client: jsonbBind(stored.client) }),
        }),
      );
    if (input.reset_authorizations !== true) {
      return await upsert.returning(recordColumns).executeTakeFirstOrThrow();
    }

    // The upsert always writes, so its `updated_at` resolves the row id for the chained deletes.
    const writtenServer = sql<boolean>`oauth_server_id IN (
      SELECT id FROM mcp_server WHERE tenant_id = ${input.tenant_id} AND name = ${input.name} AND updated_at = ${timestamp}
    )`;
    await this.#atomic.batchWrite({
      executor: db,
      queries: [
        upsert.compile(),
        db.deleteFrom('oauth_token').where(writtenServer).compile(),
        db.deleteFrom('oauth_pending_authorization').where(writtenServer).compile(),
      ],
    });
    const record = await this.getServer({ tenant_id: input.tenant_id, name: input.name }, transaction);
    if (record === undefined) {
      throw new Error(`MCP server disappeared after upsert: ${input.name}`);
    }
    return record;
  }

  async getClient(params: { id: string }, transaction?: Kysely<Database>): Promise<OAuthClientRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('mcp_server')
      .select(eb => [
        jsonText<OAuthServer | null>(eb.ref('oauth_server')).as('oauth_server'),
        jsonText<OAuthClient | null>(eb.ref('oauth_client')).as('oauth_client'),
      ])
      .where('id', '=', params.id)
      .executeTakeFirst();
    if (row?.oauth_server == null || row.oauth_client == null) {
      return undefined;
    }
    return fromStoredOAuthClientRecord({ server: row.oauth_server, client: row.oauth_client });
  }

  async saveClient(params: { id: string; record: OAuthClientRecord }, transaction?: Kysely<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    const stored = toStoredOAuthClientRecord(params.record);
    await db
      .updateTable('mcp_server')
      .set({
        oauth_server: jsonbBind(stored.server),
        oauth_client: jsonbBind(stored.client),
      })
      .where('id', '=', params.id)
      .execute();
  }

  async deleteClient(params: { id: string }, transaction?: Kysely<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db
      .updateTable('mcp_server')
      .set({
        oauth_server: null,
        oauth_client: null,
      })
      .where('id', '=', params.id)
      .execute();
  }
}
