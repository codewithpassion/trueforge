/**
 * Unique or primary-key constraint failure from better-sqlite3 (error code) or D1 (message text,
 * possibly on the wrapped cause), without driver-specific instanceof checks.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  if ('code' in err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY')) {
    return true;
  }
  if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
    return true;
  }
  return 'cause' in err && err.cause !== err && isUniqueViolation(err.cause);
}
