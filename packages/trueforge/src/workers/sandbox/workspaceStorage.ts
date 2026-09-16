import type { DurableObjectStorageLike } from '@cloudflare/computer';

/**
 * `DurableObjectStorage` is not assignable to Computer's `DurableObjectStorageLike`: its
 * `sql.exec<Row extends object>` promises `Row[]` for a row type the caller picks, while workerd's
 * `SqlStorage` only ever yields `Record<string, SqlStorageValue>`. No implementation can honour the
 * wider promise, so the Computer examples reach it with `as unknown as`. This adapter keeps that one
 * unprovable step in an overload declaration instead. Drop it once Computer's storage port is
 * parameterised on the row type.
 */
function rowsOfWiderType<Row extends object>(rows: Record<string, SqlStorageValue>[]): Row[];
function rowsOfWiderType(rows: Record<string, SqlStorageValue>[]): Record<string, SqlStorageValue>[] {
  return rows;
}

/**
 * Computer's storage port over the Durable Object's own SQLite storage. Bindings pass through
 * untouched: workerd validates them, and the workspace binds chunk hashes as byte arrays, which a
 * narrower guard here would reject.
 */
export function workspaceStorage(storage: DurableObjectStorage): DurableObjectStorageLike {
  return {
    sql: {
      exec: (query, ...bindings) => {
        const cursor = storage.sql.exec(query, ...bindings);
        return { toArray: () => rowsOfWiderType(cursor.toArray()) };
      },
    },
    transactionSync: closure => storage.transactionSync(closure),
  };
}
