import type { DurableObjectStorageLike } from '@cloudflare/computer';

/**
 * `DurableObjectStorage` is not assignable to Computer's `DurableObjectStorageLike`: its
 * `sql.exec<Row extends object>` promises `Row[]` for a row type the caller picks, while workerd's
 * `SqlStorage` only ever yields `Record<string, SqlStorageValue>`. No implementation can honour the
 * wider promise, so the Computer examples reach it with `as unknown as`. This adapter keeps that one
 * unprovable step in an overload declaration instead, validates the bindings it can, and forwards
 * everything else unchanged. Drop it once Computer's storage port is parameterised on the row type.
 */
function rowsOfWiderType<Row extends object>(rows: Record<string, SqlStorageValue>[]): Row[];
function rowsOfWiderType(rows: Record<string, SqlStorageValue>[]): Record<string, SqlStorageValue>[] {
  return rows;
}

function toSqlStorageValue(binding: unknown): SqlStorageValue {
  if (binding === null || typeof binding === 'string' || typeof binding === 'number') {
    return binding;
  }
  if (binding instanceof ArrayBuffer) {
    return binding;
  }
  throw new TypeError(`Workspace storage binding must be a SQLite value, got ${typeof binding}`);
}

/** Computer's storage port over the Durable Object's own SQLite storage. */
export function workspaceStorage(storage: DurableObjectStorage): DurableObjectStorageLike {
  return {
    sql: {
      exec: (query, ...bindings) => {
        const cursor = storage.sql.exec(query, ...bindings.map(toSqlStorageValue));
        return { toArray: () => rowsOfWiderType(cursor.toArray()) };
      },
    },
    transactionSync: closure => storage.transactionSync(closure),
  };
}
