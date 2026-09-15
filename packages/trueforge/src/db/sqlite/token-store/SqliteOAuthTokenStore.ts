import type { Kysely } from 'kysely';
import type { IOAuthTokenStore, OAuthPendingAuthorization, OAuthToken, OAuthTokenKey } from '../../../mcp/auth/types';
import { fromStoredOAuthToken, toStoredOAuthToken } from '../../mcpServerStore';
import type { Database } from '../types';
import {
  consumePendingAuthorization,
  deletePendingAuthorizationsForServer,
  savePendingAuthorization,
} from './queries/pendingAuthorization';
import { deleteToken, deleteTokensForServer, getToken, getTokens, saveToken } from './queries/token';

export class SqliteOAuthTokenStore implements IOAuthTokenStore<Kysely<Database>> {
  constructor(private readonly db: Kysely<Database>) {}

  savePendingAuthorization(pending: OAuthPendingAuthorization, transaction?: Kysely<Database>): Promise<void> {
    return savePendingAuthorization(transaction ?? this.db, pending);
  }

  consumePendingAuthorization(
    params: { state: string },
    transaction?: Kysely<Database>,
  ): Promise<OAuthPendingAuthorization | undefined> {
    return consumePendingAuthorization(transaction ?? this.db, params);
  }

  saveToken(params: OAuthTokenKey & { token: OAuthToken }, transaction?: Kysely<Database>): Promise<void> {
    return saveToken(transaction ?? this.db, {
      id: params.id,
      userRef: params.userRef,
      token: toStoredOAuthToken(params.token),
    });
  }

  async getToken(params: OAuthTokenKey, transaction?: Kysely<Database>): Promise<OAuthToken | undefined> {
    const stored = await getToken(transaction ?? this.db, params);
    return stored === undefined ? undefined : fromStoredOAuthToken(stored);
  }

  async getTokens(
    params: { ids: string[]; userRef: string },
    transaction?: Kysely<Database>,
  ): Promise<Map<string, OAuthToken>> {
    const stored = await getTokens(transaction ?? this.db, params);
    return new Map([...stored].map(([id, token]) => [id, fromStoredOAuthToken(token)]));
  }

  deleteToken(params: OAuthTokenKey, transaction?: Kysely<Database>): Promise<void> {
    return deleteToken(transaction ?? this.db, params);
  }

  deleteTokensForServer(params: { id: string }, transaction?: Kysely<Database>): Promise<void> {
    return deleteTokensForServer(transaction ?? this.db, params);
  }

  deletePendingAuthorizationsForServer(params: { id: string }, transaction?: Kysely<Database>): Promise<void> {
    return deletePendingAuthorizationsForServer(transaction ?? this.db, params);
  }
}
