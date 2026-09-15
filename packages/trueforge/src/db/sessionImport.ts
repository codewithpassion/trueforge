import type { ImportSessionRequest, ImportSessionResult, ImportSessionsCheckpoint } from '../schemas/agentImport';

/** Client/data rejection for session import — map to HTTP 4xx (not retryable). */
export class SessionImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionImportValidationError';
  }
}

/** Historical session backfill (temporary SF→TrueForge migration); only engines that support it provide one. */
export interface SessionImport {
  importSessionSnapshot(input: ImportSessionRequest): Promise<ImportSessionResult>;
  getImportSessionsCheckpoint(input: { tenant_id: string }): Promise<ImportSessionsCheckpoint>;
}
