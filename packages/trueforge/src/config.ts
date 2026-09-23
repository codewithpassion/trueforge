/**
 * Server configuration.
 *
 * Environment variables are read once at module load into a typed
 * `configuration` object exported as default. Any invalid value throws at
 * import time, so a misconfigured server fails fast at boot instead of
 * mid-run.
 *
 * `RUNTIME` is the discriminated mode selector (env `TRUEFORGE_RUNTIME`; when
 * unset it follows `STANDALONE`):
 * - `standalone` (default): SQLite only; no Redis / executor peering.
 * - `distributed`: Postgres + Redis (defaults to local trueforge credentials /
 *   `redis://localhost:6379`).
 * - `workers`: Cloudflare Workers; OIDC required, no Node-only settings.
 *
 * This module must stay free of Node-only module-load work; filesystem defaults
 * live in `nodeConfig.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { ALARM_PASS_BUDGET_MS } from './workers/alarmBudget';

const DEFAULT_PORT = 8790;
/** Loopback default; container images set HOST=0.0.0.0 so probes and Service traffic reach the process. */
const DEFAULT_HOST = 'localhost';
/**
 * A sandbox command runs inside the alarm pass that holds its turn, so it must leave that pass room
 * to finish the turn afterwards. Two thirds of the pass is the cap.
 */
const SANDBOX_EXEC_TIMEOUT_MAX_SECONDS = Math.floor((ALARM_PASS_BUDGET_MS / 1000 / 3) * 2);
/** Default HTTP request body ceiling: 30 MB. */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 30 * 1024 * 1024;
/** Turn ids minted by a non-peering process; no peer can ever own them. */
const LOCAL_EXECUTOR_ID = 'local';
const DEFAULT_POSTGRES_USER = 'trueforge';
const DEFAULT_POSTGRES_PASSWORD = 'trueforge';
const DEFAULT_POSTGRES_DB = 'trueforge';
const DEFAULT_POSTGRES_HOST = 'localhost';
const DEFAULT_POSTGRES_PORT = 5432;
/** Default Postgres schema for app tables + Kysely migration bookkeeping. */
export const DEFAULT_POSTGRES_SCHEMA = 'trueforge';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
/** Unquoted Postgres identifier: letter/underscore start, then alnum/underscore, ≤63 chars. */
const POSTGRES_SCHEMA_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;
/**
 * Fixed local service credential when `STANDALONE=true` and `TRUEFORGE_API_KEY` is unset.
 * Local testing only — not for distributed deployments.
 */
export const STANDALONE_TRUEFORGE_API_KEY = 'trueforge-standalone';

const DEFAULT_OIDC_USER_REFERENCE_CLAIM = 'sub';
const DEFAULT_OIDC_USER_DISPLAY_NAME_CLAIM = 'name';
const DEFAULT_OIDC_USER_ROLE_CLAIM = 'groups';
const DEFAULT_OIDC_ADMIN_ROLE_VALUE = 'admin';
const DEFAULT_OIDC_SCOPES = 'openid,profile,email';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const POSTGRES_SSL_MODES = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify'] as const;
type PostgresSslMode = (typeof POSTGRES_SSL_MODES)[number];

/** pg Pool `ssl` object fields (client certs / CA / no-verify). */
export interface PostgresSslConfig {
  cert?: string;
  key?: string;
  ca?: string;
  rejectUnauthorized?: boolean;
}

export interface GetEnvOptions {
  defaultValue?: string;
  required?: boolean;
}

export function getEnv(key: string, options?: GetEnvOptions): string | undefined {
  const value = process.env[key];
  if (value !== undefined) {
    return value;
  }

  // Checking for undefined as value can also be 0 or ""
  if (options?.defaultValue !== undefined) {
    return options.defaultValue;
  }

  if (options?.required) {
    throw new Error(`Environment variable ${key} is required but was not specified.`);
  }

  return undefined;
}

function randomAlphanumeric(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Environment variable PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}

export function parseOidcScopes(raw: string): string[] {
  const scopes = raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
  if (scopes.length === 0) {
    throw new Error('OIDC_SCOPES must contain at least one scope.');
  }
  return scopes;
}

/**
 * Parses a comma-separated env list (trim, drop empties). Empty / unset → `[]`.
 */
export function parseCommaSeparatedEnvList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  return raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

/** Parses a JSON string array env. Empty / unset → `[]`. */
export function parseJsonStringArrayEnv({ envKey, raw }: { envKey: string; raw: string | undefined }): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  try {
    return z.array(z.string()).parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Environment variable ${envKey} must be a JSON string array`, { cause: error });
  }
}

/**
 * Parses `OIDC_ALLOWED_EMAILS`: comma-separated exact addresses and/or globs
 * (`*@company.com`). Empty / unset → no allowlist (any authenticated user may sign in).
 */
export function parseOidcAllowedEmails(raw: string | undefined): string[] {
  return parseCommaSeparatedEnvList(raw);
}

/**
 * Parses `TRUEFOUNDRY_TENANT_ID_TO_ALLOWED_MODEL_PROVIDER_ACCOUNTS` JSON.
 * Empty / unset → `{}` (no filtering).
 */
export function parseTenantIdToAllowedModelProviderAccounts(raw: string | undefined): Record<string, string[]> {
  if (raw === undefined || raw.trim() === '') {
    return {};
  }
  try {
    return z.record(z.string(), z.array(z.string())).parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      'Environment variable TRUEFOUNDRY_TENANT_ID_TO_ALLOWED_MODEL_PROVIDER_ACCOUNTS must be a JSON object of tenant_id → string[]',
      { cause: error },
    );
  }
}

/**
 * Parsed `TRUEFOUNDRY_WEB_SEARCH_PROVIDER` JSON. Empty / unset → `undefined` (feature off).
 * Requires `name: "parallel"` and non-empty `api_key`.
 */
export interface TrueFoundryWebSearchProviderEnv {
  name: 'parallel';
  api_key: string;
}

export function parseTrueFoundryWebSearchProvider(
  raw: string | undefined,
): TrueFoundryWebSearchProviderEnv | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    const parsed = z.record(z.string(), z.string()).parse(JSON.parse(raw));
    const name = parsed['name']?.trim();
    const apiKey = parsed['api_key']?.trim();
    if (name !== 'parallel' || !apiKey) {
      throw new Error('missing or unsupported name, or missing api_key');
    }
    return { name: 'parallel', api_key: apiKey };
  } catch (error) {
    throw new Error(
      'Environment variable TRUEFOUNDRY_WEB_SEARCH_PROVIDER must be a JSON object with "name":"parallel" and non-empty "api_key" (e.g. {"name":"parallel","api_key":"..."})',
      { cause: error },
    );
  }
}

/** Parses a positive-integer env var, falling back to `defaultValue` when unset/blank. */
/** Callers join with `/`, so a configured base never carries its own trailing slash. */
function trimTrailingSlash(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function parsePositiveInt(options: {
  envKey: string;
  raw: string | undefined;
  defaultValue: number;
  maxValue?: number;
}): number {
  const { envKey, raw, defaultValue, maxValue } = options;
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Environment variable ${envKey} must be a positive integer, got "${raw}"`);
  }
  if (maxValue !== undefined && value > maxValue) {
    throw new Error(`Environment variable ${envKey} must be at most ${String(maxValue)}, got "${raw}"`);
  }
  return value;
}

/** Parses a boolean env var; anything but `true`/`false` throws instead of reading as `false`. */
function parseBoolean(options: { envKey: string; raw: string | undefined; defaultValue: boolean }): boolean {
  const { envKey, raw, defaultValue } = options;
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const value = raw.trim().toLowerCase();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`Environment variable ${envKey} must be "true" or "false", got "${raw}"`);
}

function parsePostgresSchema(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_POSTGRES_SCHEMA;
  }
  const schema = raw.trim();
  if (!POSTGRES_SCHEMA_NAME_RE.test(schema)) {
    throw new Error(
      `Environment variable POSTGRES_SCHEMA must be a lowercase Postgres identifier ` +
        `(letter/underscore, then alnum/underscore, max 63 chars); got "${raw}"`,
    );
  }
  return schema;
}

/**
 * Empty stays empty. Otherwise parse as a URL, store without a trailing slash
 * (callers join with `/`), and reject query/hash or `.` / `..` path segments.
 */
function parsePublicBaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch (error) {
    throw new Error('PUBLIC_BASE_URL must be a valid URL', { cause: error });
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('PUBLIC_BASE_URL must not include a query or hash');
  }
  const segments = parsed.pathname.split('/').filter(part => part.length > 0);
  if (segments.some(part => part === '.' || part === '..')) {
    throw new Error('PUBLIC_BASE_URL path must not contain "." or ".." segments');
  }
  const path = segments.length === 0 ? '' : `/${segments.join('/')}`;
  return `${parsed.origin}${path}`;
}

function parseTrueFoundrySandboxProvider(raw: string | undefined): 'daytona' | 'truefoundry' | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim();
  if (value === 'daytona' || value === 'truefoundry') {
    return value;
  }
  throw new Error(
    `Environment variable TRUEFOUNDRY_SANDBOX_PROVIDER must be "daytona" or "truefoundry", got ${JSON.stringify(raw)}`,
  );
}

function parseSandboxBackend(raw: string | undefined): 'cloudflare-computer' | undefined {
  const value = raw?.trim() ?? '';
  if (value === '') {
    return undefined;
  }
  if (value === 'cloudflare-computer') {
    return value;
  }
  throw new Error(
    `Environment variable TRUEFORGE_SANDBOX_BACKEND must be "cloudflare-computer", got ${JSON.stringify(raw)}`,
  );
}

function requiredS3Env(envKey: string): string {
  const value = getEnv(envKey)?.trim() ?? '';
  if (value === '') {
    throw new Error(`Environment variable ${envKey} is required when FILE_STORE_BACKEND is "s3"`);
  }
  return value;
}

function resolveFileStore(): FileStoreConfiguration {
  const backend = getEnv('FILE_STORE_BACKEND')?.trim() ?? '';
  if (backend === '' || backend === 'filesystem') {
    return { FILE_STORE_BACKEND: 'filesystem' };
  }
  if (backend !== 's3') {
    throw new Error(
      `Environment variable FILE_STORE_BACKEND must be "filesystem" or "s3", got ${JSON.stringify(backend)}`,
    );
  }
  const region = getEnv('FILE_STORE_S3_REGION')?.trim() ?? '';
  const endpoint = requiredS3Env('FILE_STORE_S3_ENDPOINT');
  if (!URL.canParse(endpoint) || !/^https?:$/.test(new URL(endpoint).protocol)) {
    throw new Error(
      `Environment variable FILE_STORE_S3_ENDPOINT must be an http(s) URL, got ${JSON.stringify(endpoint)}`,
    );
  }
  return {
    FILE_STORE_BACKEND: 's3',
    FILE_STORE_S3_ENDPOINT: endpoint,
    FILE_STORE_S3_BUCKET: requiredS3Env('FILE_STORE_S3_BUCKET'),
    FILE_STORE_S3_REGION: region === '' ? 'us-east-1' : region,
    FILE_STORE_S3_ACCESS_KEY_ID: requiredS3Env('FILE_STORE_S3_ACCESS_KEY_ID'),
    FILE_STORE_S3_SECRET_ACCESS_KEY: requiredS3Env('FILE_STORE_S3_SECRET_ACCESS_KEY'),
  };
}

/** Parses `POSTGRES_SSL_MODE`. Unset/blank → `''`. Unknown values throw. */
function validatePostgresSslMode(raw: string | undefined): PostgresSslMode | '' {
  const mode = raw?.trim() ?? '';
  if (!mode) {
    return '';
  }
  for (const allowed of POSTGRES_SSL_MODES) {
    if (mode === allowed) {
      return allowed;
    }
  }
  throw new Error(
    `Environment variable POSTGRES_SSL_MODE must be one of ${POSTGRES_SSL_MODES.join(', ')}; got "${mode}"`,
  );
}

/** Absolute path from an optional env override; unset/blank → `undefined`. */
export function resolveOptionalPathEnv(envKey: string): string | undefined {
  const override = getEnv(envKey);
  if (override === undefined || override.trim() === '') {
    return undefined;
  }
  return path.resolve(override);
}

/**
 * `TRUEFORGE_RUNTIME` when set, else derived from `STANDALONE` (default true).
 * An explicit `STANDALONE` that disagrees with `TRUEFORGE_RUNTIME` is rejected.
 */
function resolveRuntime(): ServerConfiguration['RUNTIME'] {
  const rawStandalone = getEnv('STANDALONE');
  const standalone = parseBoolean({ envKey: 'STANDALONE', raw: rawStandalone, defaultValue: true });
  const rawRuntime = getEnv('TRUEFORGE_RUNTIME');
  if (rawRuntime === undefined || rawRuntime.trim() === '') {
    return standalone ? 'standalone' : 'distributed';
  }
  const runtime = rawRuntime.trim();
  if (runtime !== 'standalone' && runtime !== 'distributed' && runtime !== 'workers') {
    throw new Error(
      `Environment variable TRUEFORGE_RUNTIME must be "standalone", "distributed", or "workers", got ${JSON.stringify(rawRuntime)}`,
    );
  }
  const standaloneSet = rawStandalone !== undefined && rawStandalone.trim() !== '';
  if (standaloneSet && standalone !== (runtime === 'standalone')) {
    throw new Error(
      `TRUEFORGE_RUNTIME=${runtime} contradicts STANDALONE=${rawStandalone.trim()}; unset STANDALONE or make them agree.`,
    );
  }
  return runtime;
}

/** Redis peering URL for distributed mode. Env: `REDIS_URL`. */
function resolveRedisUrl(): string {
  const raw = getEnv('REDIS_URL', { defaultValue: DEFAULT_REDIS_URL }) ?? DEFAULT_REDIS_URL;
  if (raw.trim() === '') {
    throw new Error('Environment variable REDIS_URL must be non-empty when STANDALONE=false.');
  }
  return raw;
}

/**
 * Postgres connection string for distributed mode.
 * Prefers `DATABASE_URL` when set (Railway / managed Postgres); otherwise builds from `POSTGRES_*`.
 * TLS is not put on the URL — see `resolvePostgresSsl` / `DATABASE_SSL` (servicefoundry-style).
 */
function resolvePostgresDatabaseUrl(): string {
  const databaseUrl = getEnv('DATABASE_URL');
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
    return databaseUrl.trim();
  }

  const postgresUser = getEnv('POSTGRES_USER', { defaultValue: DEFAULT_POSTGRES_USER }) ?? DEFAULT_POSTGRES_USER;
  const postgresPassword =
    getEnv('POSTGRES_PASSWORD', { defaultValue: DEFAULT_POSTGRES_PASSWORD }) ?? DEFAULT_POSTGRES_PASSWORD;
  const postgresDb = getEnv('POSTGRES_DB', { defaultValue: DEFAULT_POSTGRES_DB }) ?? DEFAULT_POSTGRES_DB;
  const postgresHost = getEnv('POSTGRES_HOST', { defaultValue: DEFAULT_POSTGRES_HOST }) ?? DEFAULT_POSTGRES_HOST;
  const postgresPort = parsePositiveInt({
    envKey: 'POSTGRES_PORT',
    raw: getEnv('POSTGRES_PORT'),
    defaultValue: DEFAULT_POSTGRES_PORT,
  });
  if (
    postgresUser.trim() === '' ||
    postgresPassword.trim() === '' ||
    postgresDb.trim() === '' ||
    postgresHost.trim() === ''
  ) {
    throw new Error(
      'Set DATABASE_URL, or set non-empty POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, and POSTGRES_HOST when STANDALONE=false.',
    );
  }

  return buildPostgresConnectionString({
    user: postgresUser,
    password: postgresPassword,
    host: postgresHost,
    port: postgresPort,
    database: postgresDb,
  });
}

/**
 * Postgres TLS for the pg Pool — same shape as servicefoundry `getSSLConfig`.
 * Env: `POSTGRES_SSL_MODE`, `POSTGRES_SSL_CERT_PATH`, `POSTGRES_SSL_KEY_PATH`, `POSTGRES_SSL_CA_PATH`.
 * Not written into `DATABASE_URL`. `prefer` / `require` / `verify-ca` / `verify-full` all map to
 * `ssl: true` (or the cert object); use `no-verify` for encrypt-without-verify.
 */
function resolvePostgresSsl(): boolean | PostgresSslConfig {
  const sslMode = getEnv('POSTGRES_SSL_MODE');
  const cert = readOptionalFileContentsEnv('POSTGRES_SSL_CERT_PATH');
  const key = readOptionalFileContentsEnv('POSTGRES_SSL_KEY_PATH');
  // Cloud SQL / private CA often fail verify-full; Node cannot express verify-ca without hostname check.
  const ca = readOptionalFileContentsEnv('POSTGRES_SSL_CA_PATH');

  let ssl: boolean | PostgresSslConfig = false;
  if (cert || key || ca) {
    ssl = {
      ...(cert ? { cert } : {}),
      ...(key ? { key } : {}),
      ...(ca ? { ca } : {}),
    };
  }

  switch (validatePostgresSslMode(sslMode)) {
    case 'disable':
      return false;
    case 'prefer':
    case 'require':
    case 'verify-ca':
    case 'verify-full':
      return ssl || true;
    case 'no-verify':
      return { ...(ssl || {}), rejectUnauthorized: false };
    default:
      return ssl;
  }
}

/** Reads a PEM file from an optional path env; unset/blank → `undefined`. */
function readOptionalFileContentsEnv(envKey: string): string | undefined {
  const filePath = resolveOptionalPathEnv(envKey);
  return filePath ? readFileSync(filePath, 'utf8') : undefined;
}

/** Builds a Postgres connection URL from discrete `POSTGRES_*` parts (no TLS query params). */
function buildPostgresConnectionString(parts: {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}): string {
  return `postgres://${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.password)}@${parts.host}:${String(parts.port)}/${encodeURIComponent(parts.database)}`;
}

function resolveOIDCConfig(): OIDCConfig | undefined {
  const issuerUrl = getEnv('OIDC_ISSUER_URL');
  const clientId = getEnv('OIDC_CLIENT_ID');
  const clientSecret = getEnv('OIDC_CLIENT_SECRET');

  if (!issuerUrl && !clientId && !clientSecret) {
    return undefined;
  }
  if (!issuerUrl || !clientId || !clientSecret) {
    throw new Error(
      'OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET must all be set together, or all left unset ' +
        '(unset = fixed local admin identity, no IdP).',
    );
  }
  return {
    OIDC_ISSUER_URL: issuerUrl,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
    OIDC_USER_REFERENCE_CLAIM:
      getEnv('OIDC_USER_REFERENCE_CLAIM', { defaultValue: DEFAULT_OIDC_USER_REFERENCE_CLAIM }) ??
      DEFAULT_OIDC_USER_REFERENCE_CLAIM,
    OIDC_USER_DISPLAY_NAME_CLAIM:
      getEnv('OIDC_USER_DISPLAY_NAME_CLAIM', { defaultValue: DEFAULT_OIDC_USER_DISPLAY_NAME_CLAIM }) ??
      DEFAULT_OIDC_USER_DISPLAY_NAME_CLAIM,
    OIDC_USER_ROLE_CLAIM:
      getEnv('OIDC_USER_ROLE_CLAIM', { defaultValue: DEFAULT_OIDC_USER_ROLE_CLAIM }) ?? DEFAULT_OIDC_USER_ROLE_CLAIM,
    OIDC_ADMIN_ROLE_VALUE:
      getEnv('OIDC_ADMIN_ROLE_VALUE', { defaultValue: DEFAULT_OIDC_ADMIN_ROLE_VALUE }) ?? DEFAULT_OIDC_ADMIN_ROLE_VALUE,
    OIDC_SCOPES: parseOidcScopes(getEnv('OIDC_SCOPES', { defaultValue: DEFAULT_OIDC_SCOPES }) ?? DEFAULT_OIDC_SCOPES),
    OIDC_ALLOWED_EMAILS: parseOidcAllowedEmails(getEnv('OIDC_ALLOWED_EMAILS')),
  };
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

export interface OIDCConfig {
  /** e.g. an Okta custom authorization server, or an Azure AD tenant's v2.0 endpoint. Env: `OIDC_ISSUER_URL`. */
  OIDC_ISSUER_URL: string;
  /** Client ID for the OIDC client;*/
  OIDC_CLIENT_ID: string;
  /** Client secret for the OIDC client*/
  OIDC_CLIENT_SECRET: string;
  /** Claim to be used as the user reference; e.g. "sub" or "email"
   * Optional; defaults to "sub"
   */
  OIDC_USER_REFERENCE_CLAIM: string;
  /** Claim used as the display name; e.g. "name" or "preferred_username".
   * Optional; defaults to "name". Missing/empty falls back to the user reference.
   * Env: `OIDC_USER_DISPLAY_NAME_CLAIM`.
   */
  OIDC_USER_DISPLAY_NAME_CLAIM: string;
  /** Claim to be used as the user role; e.g. "role" or "groups"
   * Optional; defaults to "groups"
   */
  OIDC_USER_ROLE_CLAIM: string;
  /** Value of the user role claim that will be used to grant admin access to the server
   * Case sensitive. Optional; defaults to "admin"
   */
  OIDC_ADMIN_ROLE_VALUE: string;
  /** Comma-separated OAuth scopes for the authorization request. Env: `OIDC_SCOPES`.
   * Optional; defaults to "openid,profile,email". Whitespace around entries is stripped.
   * Okta `groups` claims require the `groups` scope; Azure AD app roles typically omit it.
   */
  OIDC_SCOPES: string[];
  /**
   * Optional allowlist of emails that may sign in. Env: `OIDC_ALLOWED_EMAILS`.
   * Comma-separated exact addresses and/or `*` globs (e.g. `alice@acme.com,*@partner.com`).
   * Matching is case-insensitive against the ID token `email` claim. Empty = unrestricted.
   */
  OIDC_ALLOWED_EMAILS: string[];
}

export interface SharedServerConfiguration {
  /** Log level. Env: `LOG_LEVEL`. */
  LOG_LEVEL: string;
  /** Log one line per HTTP request (except `/healthz` and `/assets/`). Env: `ACCESS_LOGS`. Default true. */
  ACCESS_LOGS: boolean;
  /** Node environment. Env: `NODE_ENV`. */
  NODE_ENV: string | undefined;
  /**
   * Optional override for the model catalog YAML (discovery presets for
   * GET /catalogs/model-providers). When unset, the catalog inlined at build
   * time is used. Env: `MODEL_CATALOG_PATH`.
   */
  MODEL_CATALOG_PATH: string | undefined;
  /**
   * Optional override for the MCP catalog YAML (discovery presets for
   * GET /catalogs/mcp-servers). When unset, the catalog inlined at build
   * time is used. Env: `MCP_CATALOG_PATH`.
   */
  MCP_CATALOG_PATH: string | undefined;
  /**
   * Optional override for the skill catalog YAML (discovery presets for
   * GET /catalogs/skills). When unset, the catalog inlined at build
   * time is used. Env: `SKILL_CATALOG_PATH`.
   */
  SKILL_CATALOG_PATH: string | undefined;
  /**
   * Optional override for the sandbox catalog YAML (discovery presets for
   * GET /catalogs/sandbox-providers). When unset, the catalog inlined at build
   * time is used. Env: `SANDBOX_CATALOG_PATH`.
   */
  SANDBOX_CATALOG_PATH: string | undefined;
  /** Max milliseconds for one MCP request. Env: `MCP_REQUEST_TIMEOUT_MS`. Default 4 minutes. */
  MCP_REQUEST_TIMEOUT_MS: number;
  /** Max milliseconds for an MCP transport connection. Env: `MCP_CONNECT_TIMEOUT_MS`. Default 30 seconds. */
  MCP_CONNECT_TIMEOUT_MS: number;
  /** Max bytes for one remote MCP tool-call HTTP response body (not GET SSE). Env: `MCP_TOOL_CALL_MAX_RESPONSE_BYTES`. Default 50 MB. */
  MCP_TOOL_CALL_MAX_RESPONSE_BYTES: number;
  /**
   * Client name used for Dynamic Client Registration (DCR) of MCP servers.
   * This is the client name shown on authorization-server consent screens.
   * Env: `MCP_DCR_OAUTH_CLIENT_NAME`. Default: "truefoundry-harness".
   */
  MCP_DCR_OAUTH_CLIENT_NAME: string;
  /**
   * Max bytes for a single file download out of the sandbox.
   * Env: `SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD`. Default 20 MB (same as gateway).
   */
  SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD: number;
  /**
   * Deploy-configured sandbox backend for the Workers runtime; unset means code execution is off.
   * Env: `TRUEFORGE_SANDBOX_BACKEND` (`cloudflare-computer`).
   */
  TRUEFORGE_SANDBOX_BACKEND: 'cloudflare-computer' | undefined;
  /**
   * Default timeout for one sandbox command when the caller sets none. Capped at two thirds of the
   * Workers alarm pass that holds a turn. Env: `SANDBOX_EXEC_TIMEOUT_SECONDS`. Default 5 minutes.
   */
  SANDBOX_EXEC_TIMEOUT_SECONDS: number;
  /**
   * Where `GET /install.sh` downloads the remote-computer client from, without a trailing slash;
   * the script appends `/<version>/trueforge-computer_<os>_<arch>`. Empty makes that route answer
   * 503, so no deploy points at someone else's binaries by default.
   * Env: `REMOTE_COMPUTER_RELEASE_BASE_URL`.
   */
  REMOTE_COMPUTER_RELEASE_BASE_URL: string;
  /**
   * Container image for the remote-computer client, used only to build the copyable `docker run`
   * command. Empty omits that command. Env: `REMOTE_COMPUTER_DOCKER_IMAGE`.
   */
  REMOTE_COMPUTER_DOCKER_IMAGE: string;
  /**
   * Max bytes for an HTTP request body. Env: `MAX_REQUEST_BODY_BYTES`. Default 30 MB.
   */
  MAX_REQUEST_BODY_BYTES: number;
  /**
   * Max seconds a single turn may execute before it is cancelled with
   * `server-execution-timeout`. Env: `SERVER_EXECUTION_TIMEOUT_SECONDS`. Default 600 (10 minutes).
   */
  SERVER_EXECUTION_TIMEOUT_SECONDS: number;
  /**
   * TTL for a running turn's resumable event stream.
   * Env: `TURN_STREAM_TTL_SECONDS`. Default execution timeout + 300.
   */
  TURN_STREAM_TTL_SECONDS: number;
  /**
   * TTL retained after `turn.done` so subscribers can drain remaining events.
   * Env: `TURN_STREAM_POST_COMPLETION_TTL_SECONDS`. Default 300.
   */
  TURN_STREAM_POST_COMPLETION_TTL_SECONDS: number;
  /**
   * Max ms to keep a turn subscription open.
   * Env: `TURN_SUBSCRIBE_TIMEOUT_MS`. Default 600000.
   */
  TURN_SUBSCRIBE_TIMEOUT_MS: number;
  /**
   * Public application URL (origin plus optional pathname). Used as the origin of
   * MCP OAuth and OIDC callbacks; the pathname is the UI/API public prefix when
   * a reverse proxy strips it. Optional at boot; MCP OAuth and OIDC callback
   * construction fail if empty outside standalone development. Env: `PUBLIC_BASE_URL`.
   */
  PUBLIC_BASE_URL: string;
  /** Env: `NETWORK_POLICY_ENABLED`. Default true. `false` skips the outbound URL guard. */
  NETWORK_POLICY_ENABLED: boolean;
  /** Hosts always allowed. Env: `OUTBOUND_URL_ALLOWED_HOSTS` (JSON string array). Empty = none. */
  OUTBOUND_URL_ALLOWED_HOSTS: string[];
  /** Hosts always blocked. Env: `OUTBOUND_URL_BLOCKED_HOSTS` (JSON string array). Empty = none. */
  OUTBOUND_URL_BLOCKED_HOSTS: string[];
}

/**
 * Session file storage on Node. Env: `FILE_STORE_BACKEND` (`filesystem`, the default, or `s3`). The
 * filesystem directory is `FILE_STORE_DIR` in nodeConfig.ts. `s3` needs `FILE_STORE_S3_ENDPOINT`
 * (for example `https://s3.us-east-1.amazonaws.com`, an R2 account endpoint, or MinIO),
 * `FILE_STORE_S3_BUCKET`, `FILE_STORE_S3_ACCESS_KEY_ID` and `FILE_STORE_S3_SECRET_ACCESS_KEY`;
 * `FILE_STORE_S3_REGION` defaults to `us-east-1`.
 */
export type FileStoreConfiguration =
  | { FILE_STORE_BACKEND: 'filesystem' }
  | {
      FILE_STORE_BACKEND: 's3';
      FILE_STORE_S3_ENDPOINT: string;
      FILE_STORE_S3_BUCKET: string;
      FILE_STORE_S3_REGION: string;
      FILE_STORE_S3_ACCESS_KEY_ID: string;
      FILE_STORE_S3_SECRET_ACCESS_KEY: string;
    };

/** Settings only the Node server and controller processes read. */
export interface NodeSharedServerConfiguration {
  /** HTTP port the server listens on. Env: `PORT`. */
  PORT: number;
  /** HTTP bind address. Env: `HOST`. Default `localhost`; production images use `0.0.0.0`. */
  HOST: string;
  /**
   * Base URL the controller uses to reach the server's HTTP API. Dedicated controller
   * (`STANDALONE=false`, `dist/controller-main.js`) and the in-process standalone controller
   * both call the server over HTTP(S) at this URL (loopback in standalone). When
   * `MTLS_ENABLED` is true the controller upgrades an `http://` URL to `https://`
   * and presents the client cert. Env: `SERVER_URL`.
   * Default: `http://localhost:$PORT`; in-cluster deployments MUST point this at the server Service.
   */
  SERVER_URL: string;
  /**
   * Service credential for controller calls.
   * Env: `TRUEFORGE_API_KEY`. Required and non-empty when `STANDALONE=false`.
   * Standalone defaults to {@link STANDALONE_TRUEFORGE_API_KEY} (local testing only).
   */
  TRUEFORGE_API_KEY: string;
  /**
   * Mutual TLS for this process's HTTPS listener and controller→server. When true, serves HTTPS
   * with client-cert enforcement (except `/healthz`) and the controller presents a client cert.
   * Env: `MTLS_ENABLED`. Default false.
   */
  MTLS_ENABLED: boolean;
  /**
   * Directory holding the TLS cert triple (`tls.crt` / `tls.key` / `ca.crt`) when
   * `MTLS_ENABLED` is true. Env: `MTLS_CERTS_DIR`. Default `/etc/tls`.
   */
  MTLS_CERTS_DIR: string;
  /** Peering identity embedded in the turn ids this process mints; `local` outside distributed mode. */
  EXECUTOR_ID: string;
  /**
   * Max seconds to wait for turn cancellation + connection drain on SIGTERM/SIGINT.
   * Env: `GRACEFUL_TIMEOUT_SECONDS`. Default 30.
   */
  GRACEFUL_TIMEOUT_SECONDS: number;
  /**
   * Max ms to wait for a peer executor's reply before failing with 424.
   * Env: `REDIS_REQUEST_REPLY_TIMEOUT_MS`. Default 60000.
   * Only used when a Redis client is wired (distributed mode).
   */
  REDIS_REQUEST_REPLY_TIMEOUT_MS: number;
  /**
   * How often this process refreshes its peering heartbeat key.
   * Env: `REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS`. Default 5000.
   * Only used when a Redis client is wired (distributed mode).
   */
  REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS: number;
  /**
   * TTL for reply values so abandoned reply keys are reclaimed.
   * Env: `REDIS_REQUEST_REPLY_REPLY_TTL_MS`. Default 120000.
   * Only used when a Redis client is wired (distributed mode).
   */
  REDIS_REQUEST_REPLY_REPLY_TTL_MS: number;
  /**
   * Sleep between reply poll attempts while waiting on a peer.
   * Env: `REDIS_REQUEST_REPLY_POLL_INTERVAL_MS`. Default 500.
   * Only used when a Redis client is wired (distributed mode).
   */
  REDIS_REQUEST_REPLY_POLL_INTERVAL_MS: number;
  /** Where session files are kept. */
  FILE_STORE: FileStoreConfiguration;
}

export type StandaloneServerConfiguration = SharedServerConfiguration &
  NodeSharedServerConfiguration & {
    RUNTIME: 'standalone';
    /**
     * Single-process topology: SQLite persistence, no Redis / executor peering.
     * Env: `STANDALONE`. Default: true.
     */
    STANDALONE: true;
  };

export type DistributedServerConfiguration = SharedServerConfiguration &
  NodeSharedServerConfiguration & {
    RUNTIME: 'distributed';
    /**
     * Multi-replica topology: Postgres persistence + Redis executor peering.
     * Env: `STANDALONE`. Default: true (so this branch requires an explicit `false`).
     */
    STANDALONE: false;
    /**
     * Postgres connection string. Env: `DATABASE_URL` when set; otherwise built from `POSTGRES_*`.
     * Form: `postgres://USER:PASSWORD@HOST:PORT/DB` (or `postgresql://…`) with user/password URL-encoded.
     * TLS is not encoded here — see `DATABASE_SSL`.
     */
    DATABASE_URL: string;
    /**
     * Postgres TLS for the pg Pool (servicefoundry-style).
     * Env: `POSTGRES_SSL_MODE`, `POSTGRES_SSL_CERT_PATH`, `POSTGRES_SSL_KEY_PATH`, `POSTGRES_SSL_CA_PATH`.
     */
    DATABASE_SSL: boolean | PostgresSslConfig;
    /** Max connections in the `pg` Pool. Env: `DATABASE_POOL_MAX`. Default 10. */
    DATABASE_POOL_MAX: number;
    /**
     * Postgres `statement_timeout` for app and migrations (same pool).
     * Env: `POSTGRES_STATEMENT_TIMEOUT_MS`. Default 60000.
     */
    POSTGRES_STATEMENT_TIMEOUT_MS: number;
    /**
     * Postgres `idle_in_transaction_session_timeout` for app and migrations (same pool).
     * Env: `POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS`. Default 60000.
     */
    POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: number;
    /**
     * Postgres schema for app tables and Kysely migration bookkeeping (`search_path`, Migrator).
     * Env: `POSTGRES_SCHEMA`. Default `trueforge`.
     */
    POSTGRES_SCHEMA: string;
    /** Peering URL shared by all replicas. Env: `REDIS_URL`. Default `redis://localhost:6379`. */
    REDIS_URL: string;
    /**
     * OIDC configuration for server authentication.
     * Undefined means browser login is disabled.
     */
    OIDC: OIDCConfig | undefined;
    /**
     * When set, automatically move public TrueForge tables into `POSTGRES_SCHEMA` on first bootstrap.
     * Env: `AUTOMATICALLY_MOVE_TRUEFORGE_TABLES_FROM_PUBLIC_TO_TRUEFORGE_SCHEMA`. Default true.
     */
    AUTOMATICALLY_MOVE_TRUEFORGE_TABLES_FROM_PUBLIC_TO_TRUEFORGE_SCHEMA: boolean;
    /**
     * When set, models/MCP/agents are backed by the TrueFoundry ServiceFoundry server with the
     * caller's token. Unset = local Postgres stores. Mutually exclusive with OIDC.
     * Env: `TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL`.
     */
    TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL: string | undefined;
    /**
     * Required when `TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL` is set. Env: `TRUEFOUNDRY_API_KEY`.
     */
    TRUEFOUNDRY_API_KEY: string | undefined;
    /** Max ms for non-agent ServiceFoundry HTTP calls. Env: `TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_TIMEOUT_MS`. Default 10000. */
    TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_TIMEOUT_MS: number;
    /** Max ms for agent CRUD ServiceFoundry HTTP calls. Env: `TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_AGENT_TIMEOUT_MS`. Default 3000. */
    TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_AGENT_TIMEOUT_MS: number;
    /**
     * Present this pod's client certificate on outbound calls to the ServiceFoundry server (internal
     * mutual TLS) and upgrade a mesh-direct peer URL from http to https. Off by default, so an
     * unconfigured deployment keeps calling over plain HTTP exactly as before.
     * Env: `TRUEFOUNDRY_MTLS_ENABLED`. Default false.
     */
    TRUEFOUNDRY_MTLS_ENABLED: boolean;
    /**
     * Directory holding the internal mTLS material used when `TRUEFOUNDRY_MTLS_ENABLED` is true — the
     * cert triple `tls.crt` / `tls.key` / `ca.crt`, so one chart value configures every component.
     * Env: `TRUEFOUNDRY_MTLS_CERTS_DIR`. Default `/etc/tls/truefoundry`.
     */
    TRUEFOUNDRY_MTLS_CERTS_DIR: string;
    /**
     * When TrueFoundry mode is on, enable the shared sandbox for all tenants
     * (no per-tenant PUT). Env: `TRUEFOUNDRY_SANDBOX_ENABLED`. Default false.
     */
    TRUEFOUNDRY_SANDBOX_ENABLED: boolean;
    /**
     * Shared sandbox backend when `TRUEFOUNDRY_SANDBOX_ENABLED` is true.
     * Env: `TRUEFOUNDRY_SANDBOX_PROVIDER` (`daytona` | `truefoundry`).
     */
    TRUEFOUNDRY_SANDBOX_PROVIDER: 'daytona' | 'truefoundry' | undefined;
    /**
     * Shared API key (required for Daytona; optional for truefoundry).
     * Env: `TRUEFOUNDRY_SANDBOX_API_KEY`.
     */
    TRUEFOUNDRY_SANDBOX_API_KEY: string | undefined;
    /**
     * TrueFoundry (on-prem) sandbox HTTP server URL when provider is `truefoundry`.
     * Env: `TRUEFOUNDRY_SANDBOX_SERVER_URL`.
     */
    TRUEFOUNDRY_SANDBOX_SERVER_URL: string | undefined;
    /**
     * Static JSON settings for the shared sandbox (provider-specific).
     * Daytona: `snapshotName`, intervals, `timeoutMs`. TrueFoundry: `nats_bridge_url`.
     * Env: `TRUEFOUNDRY_SANDBOX_SETTINGS`.
     */
    TRUEFOUNDRY_SANDBOX_SETTINGS: string | undefined;
    /**
     * Optional per-tenant allowlist of model provider account names. JSON object
     * `Record<tenant_id, account_name[]>`. Empty / unset → no filtering. Tenants omitted from the
     * map are unaffected; tenants present are limited to the listed provider accounts.
     * Env: `TRUEFOUNDRY_TENANT_ID_TO_ALLOWED_MODEL_PROVIDER_ACCOUNTS`.
     */
    TRUEFOUNDRY_TENANT_ID_TO_ALLOWED_MODEL_PROVIDER_ACCOUNTS: Record<string, string[]>;
    /**
     * Optional built-in web search provider (TrueFoundry mode only). JSON object
     * `Record<string, string>` with `name` (`parallel`) and `api_key`.
     * Unset / empty → web search tools are not registered. Env: `TRUEFOUNDRY_WEB_SEARCH_PROVIDER`.
     */
    TRUEFOUNDRY_WEB_SEARCH_PROVIDER: TrueFoundryWebSearchProviderEnv | undefined;
  };

/**
 * Cloudflare Workers: no Redis peering, filesystem, or HTTP loopback controller.
 * OIDC is required because standalone auth (everyone is admin) is not allowed here.
 */
export type WorkersServerConfiguration = SharedServerConfiguration & {
  RUNTIME: 'workers';
  /** Always false, so `!STANDALONE` keeps meaning "auth may be configured". */
  STANDALONE: false;
  /** OIDC configuration for server authentication. */
  OIDC: OIDCConfig;
};

export type NodeServerConfiguration = StandaloneServerConfiguration | DistributedServerConfiguration;

export type ServerConfiguration = NodeServerConfiguration | WorkersServerConfiguration;

// ============================================================================
// CONFIGURATION VALUES
// ============================================================================

/** Reads and validates `process.env`; throws on any invalid or contradictory value. */
export function parseServerConfiguration(): ServerConfiguration {
  const runtime = resolveRuntime();

  const serverExecutionTimeoutSeconds = parsePositiveInt({
    envKey: 'SERVER_EXECUTION_TIMEOUT_SECONDS',
    raw: getEnv('SERVER_EXECUTION_TIMEOUT_SECONDS'),
    defaultValue: 600,
  });

  const shared: SharedServerConfiguration = {
    LOG_LEVEL: getEnv('LOG_LEVEL', { defaultValue: 'info' }) ?? 'info',
    ACCESS_LOGS: parseBoolean({ envKey: 'ACCESS_LOGS', raw: getEnv('ACCESS_LOGS'), defaultValue: true }),
    NODE_ENV: getEnv('NODE_ENV'),
    MODEL_CATALOG_PATH: resolveOptionalPathEnv('MODEL_CATALOG_PATH'),
    MCP_CATALOG_PATH: resolveOptionalPathEnv('MCP_CATALOG_PATH'),
    SKILL_CATALOG_PATH: resolveOptionalPathEnv('SKILL_CATALOG_PATH'),
    SANDBOX_CATALOG_PATH: resolveOptionalPathEnv('SANDBOX_CATALOG_PATH'),

    MCP_REQUEST_TIMEOUT_MS: parsePositiveInt({
      envKey: 'MCP_REQUEST_TIMEOUT_MS',
      raw: getEnv('MCP_REQUEST_TIMEOUT_MS'),
      defaultValue: 4 * 60 * 1000,
    }),
    MCP_CONNECT_TIMEOUT_MS: parsePositiveInt({
      envKey: 'MCP_CONNECT_TIMEOUT_MS',
      raw: getEnv('MCP_CONNECT_TIMEOUT_MS'),
      defaultValue: 30 * 1000,
    }),
    MCP_TOOL_CALL_MAX_RESPONSE_BYTES: parsePositiveInt({
      envKey: 'MCP_TOOL_CALL_MAX_RESPONSE_BYTES',
      raw: getEnv('MCP_TOOL_CALL_MAX_RESPONSE_BYTES'),
      defaultValue: 50 * 1024 * 1024,
    }),
    MCP_DCR_OAUTH_CLIENT_NAME:
      getEnv('MCP_DCR_OAUTH_CLIENT_NAME', { defaultValue: 'truefoundry-harness' }) ?? 'truefoundry-harness',
    SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD: parsePositiveInt({
      envKey: 'SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD',
      raw: getEnv('SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD'),
      defaultValue: 20_971_520,
    }),
    TRUEFORGE_SANDBOX_BACKEND: parseSandboxBackend(getEnv('TRUEFORGE_SANDBOX_BACKEND', { required: false })),
    SANDBOX_EXEC_TIMEOUT_SECONDS: parsePositiveInt({
      envKey: 'SANDBOX_EXEC_TIMEOUT_SECONDS',
      raw: getEnv('SANDBOX_EXEC_TIMEOUT_SECONDS'),
      defaultValue: 300,
      maxValue: SANDBOX_EXEC_TIMEOUT_MAX_SECONDS,
    }),
    REMOTE_COMPUTER_RELEASE_BASE_URL: trimTrailingSlash(
      getEnv('REMOTE_COMPUTER_RELEASE_BASE_URL', { defaultValue: '' }) ?? '',
    ),
    REMOTE_COMPUTER_DOCKER_IMAGE: (getEnv('REMOTE_COMPUTER_DOCKER_IMAGE', { defaultValue: '' }) ?? '').trim(),
    MAX_REQUEST_BODY_BYTES: parsePositiveInt({
      envKey: 'MAX_REQUEST_BODY_BYTES',
      raw: getEnv('MAX_REQUEST_BODY_BYTES'),
      defaultValue: DEFAULT_MAX_REQUEST_BODY_BYTES,
    }),
    SERVER_EXECUTION_TIMEOUT_SECONDS: serverExecutionTimeoutSeconds,
    TURN_STREAM_TTL_SECONDS: parsePositiveInt({
      envKey: 'TURN_STREAM_TTL_SECONDS',
      raw: getEnv('TURN_STREAM_TTL_SECONDS'),
      defaultValue: serverExecutionTimeoutSeconds + 300,
    }),
    TURN_STREAM_POST_COMPLETION_TTL_SECONDS: parsePositiveInt({
      envKey: 'TURN_STREAM_POST_COMPLETION_TTL_SECONDS',
      raw: getEnv('TURN_STREAM_POST_COMPLETION_TTL_SECONDS'),
      defaultValue: 300,
    }),
    TURN_SUBSCRIBE_TIMEOUT_MS: parsePositiveInt({
      envKey: 'TURN_SUBSCRIBE_TIMEOUT_MS',
      raw: getEnv('TURN_SUBSCRIBE_TIMEOUT_MS'),
      defaultValue: 600_000,
    }),
    PUBLIC_BASE_URL: parsePublicBaseUrl(getEnv('PUBLIC_BASE_URL', { defaultValue: '' })),
    NETWORK_POLICY_ENABLED: parseBoolean({
      envKey: 'NETWORK_POLICY_ENABLED',
      raw: getEnv('NETWORK_POLICY_ENABLED'),
      defaultValue: true,
    }),
    OUTBOUND_URL_ALLOWED_HOSTS: parseJsonStringArrayEnv({
      envKey: 'OUTBOUND_URL_ALLOWED_HOSTS',
      raw: getEnv('OUTBOUND_URL_ALLOWED_HOSTS'),
    }),
    OUTBOUND_URL_BLOCKED_HOSTS: parseJsonStringArrayEnv({
      envKey: 'OUTBOUND_URL_BLOCKED_HOSTS',
      raw: getEnv('OUTBOUND_URL_BLOCKED_HOSTS'),
    }),
  };

  if (runtime === 'workers') {
    // Rejected rather than ignored: the deployment would otherwise silently lose its expected auth mode.
    if (getEnv('TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL') !== undefined) {
      throw new Error(
        'TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL (TrueFoundry mode) is not supported when TRUEFORGE_RUNTIME=workers.',
      );
    }
    const oidc = resolveOIDCConfig();
    if (oidc === undefined) {
      throw new Error(
        'TRUEFORGE_RUNTIME=workers requires OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET; ' +
          'standalone auth is not available on Workers.',
      );
    }
    // Fail at startup: otherwise health checks pass and only sign-in fails, when it builds the callback URL.
    if (shared.PUBLIC_BASE_URL === '') {
      throw new Error('PUBLIC_BASE_URL is required when TRUEFORGE_RUNTIME=workers; OIDC callbacks use it.');
    }
    // Workers static assets always serve the UI from `/`, so a proxy prefix cannot work there.
    if (new URL(shared.PUBLIC_BASE_URL).pathname !== '/') {
      throw new Error(
        'PUBLIC_BASE_URL must not include a path when TRUEFORGE_RUNTIME=workers; the UI is served from /.',
      );
    }
    return { ...shared, RUNTIME: 'workers', STANDALONE: false, OIDC: oidc };
  }

  // Upstream renamed these; a deployment still setting the old names would otherwise run without mTLS.
  for (const [legacy, current] of [
    ['TRUEFORGE_MTLS_ENABLED', 'MTLS_ENABLED'],
    ['TRUEFORGE_MTLS_CERTS_DIR', 'MTLS_CERTS_DIR'],
  ] as const) {
    if (getEnv(legacy) !== undefined) {
      throw new Error(`${legacy} was renamed to ${current}; set ${current} and remove ${legacy}.`);
    }
  }

  const port = parsePort(getEnv('PORT'));
  const nodeShared: NodeSharedServerConfiguration = {
    PORT: port,
    HOST: getEnv('HOST', { defaultValue: DEFAULT_HOST }) ?? DEFAULT_HOST,
    SERVER_URL:
      getEnv('SERVER_URL', { defaultValue: `http://localhost:${String(port)}` }) ?? `http://localhost:${String(port)}`,
    TRUEFORGE_API_KEY:
      runtime === 'standalone'
        ? (getEnv('TRUEFORGE_API_KEY', { defaultValue: STANDALONE_TRUEFORGE_API_KEY }) ?? STANDALONE_TRUEFORGE_API_KEY)
        : (getEnv('TRUEFORGE_API_KEY', { required: true }) ?? ''),
    MTLS_ENABLED: parseBoolean({
      envKey: 'MTLS_ENABLED',
      raw: getEnv('MTLS_ENABLED'),
      defaultValue: false,
    }),
    MTLS_CERTS_DIR: getEnv('MTLS_CERTS_DIR', { defaultValue: '/etc/tls' }) ?? '/etc/tls',
    EXECUTOR_ID: runtime === 'distributed' ? randomAlphanumeric(6) : LOCAL_EXECUTOR_ID,
    GRACEFUL_TIMEOUT_SECONDS: parsePositiveInt({
      envKey: 'GRACEFUL_TIMEOUT_SECONDS',
      raw: getEnv('GRACEFUL_TIMEOUT_SECONDS'),
      defaultValue: 30,
    }),
    REDIS_REQUEST_REPLY_TIMEOUT_MS: parsePositiveInt({
      envKey: 'REDIS_REQUEST_REPLY_TIMEOUT_MS',
      raw: getEnv('REDIS_REQUEST_REPLY_TIMEOUT_MS'),
      defaultValue: 60_000,
    }),
    REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS: parsePositiveInt({
      envKey: 'REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS',
      raw: getEnv('REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS'),
      defaultValue: 5_000,
    }),
    REDIS_REQUEST_REPLY_REPLY_TTL_MS: parsePositiveInt({
      envKey: 'REDIS_REQUEST_REPLY_REPLY_TTL_MS',
      raw: getEnv('REDIS_REQUEST_REPLY_REPLY_TTL_MS'),
      defaultValue: 120_000,
    }),
    REDIS_REQUEST_REPLY_POLL_INTERVAL_MS: parsePositiveInt({
      envKey: 'REDIS_REQUEST_REPLY_POLL_INTERVAL_MS',
      raw: getEnv('REDIS_REQUEST_REPLY_POLL_INTERVAL_MS'),
      defaultValue: 500,
    }),
    FILE_STORE: resolveFileStore(),
  };

  if (runtime === 'standalone') {
    return { ...shared, ...nodeShared, RUNTIME: 'standalone', STANDALONE: true };
  }

  const configuration: DistributedServerConfiguration = {
    ...shared,
    ...nodeShared,
    RUNTIME: 'distributed',
    STANDALONE: false,
    DATABASE_URL: resolvePostgresDatabaseUrl(),
    DATABASE_SSL: resolvePostgresSsl(),
    DATABASE_POOL_MAX: parsePositiveInt({
      envKey: 'DATABASE_POOL_MAX',
      raw: getEnv('DATABASE_POOL_MAX'),
      defaultValue: 10,
    }),
    POSTGRES_STATEMENT_TIMEOUT_MS: parsePositiveInt({
      envKey: 'POSTGRES_STATEMENT_TIMEOUT_MS',
      raw: getEnv('POSTGRES_STATEMENT_TIMEOUT_MS'),
      defaultValue: 60_000,
    }),
    POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: parsePositiveInt({
      envKey: 'POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS',
      raw: getEnv('POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS'),
      defaultValue: 60_000,
    }),
    POSTGRES_SCHEMA: parsePostgresSchema(getEnv('POSTGRES_SCHEMA')),
    REDIS_URL: resolveRedisUrl(),
    OIDC: resolveOIDCConfig(),
    AUTOMATICALLY_MOVE_TRUEFORGE_TABLES_FROM_PUBLIC_TO_TRUEFORGE_SCHEMA: parseBoolean({
      envKey: 'AUTOMATICALLY_MOVE_TRUEFORGE_TABLES_FROM_PUBLIC_TO_TRUEFORGE_SCHEMA',
      raw: getEnv('AUTOMATICALLY_MOVE_TRUEFORGE_TABLES_FROM_PUBLIC_TO_TRUEFORGE_SCHEMA'),
      defaultValue: true,
    }),
    TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL: getEnv('TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL', { required: false }),
    TRUEFOUNDRY_API_KEY: getEnv('TRUEFOUNDRY_API_KEY', { required: false }),
    TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_TIMEOUT_MS: parsePositiveInt({
      envKey: 'TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_TIMEOUT_MS',
      raw: getEnv('TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_TIMEOUT_MS'),
      defaultValue: 10_000,
    }),
    TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_AGENT_TIMEOUT_MS: parsePositiveInt({
      envKey: 'TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_AGENT_TIMEOUT_MS',
      raw: getEnv('TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_AGENT_TIMEOUT_MS'),
      defaultValue: 3_000,
    }),
    TRUEFOUNDRY_MTLS_ENABLED: parseBoolean({
      envKey: 'TRUEFOUNDRY_MTLS_ENABLED',
      raw: getEnv('TRUEFOUNDRY_MTLS_ENABLED'),
      defaultValue: false,
    }),
    TRUEFOUNDRY_MTLS_CERTS_DIR:
      getEnv('TRUEFOUNDRY_MTLS_CERTS_DIR', { defaultValue: '/etc/tls/truefoundry' }) ?? '/etc/tls/truefoundry',
    TRUEFOUNDRY_SANDBOX_ENABLED: parseBoolean({
      envKey: 'TRUEFOUNDRY_SANDBOX_ENABLED',
      raw: getEnv('TRUEFOUNDRY_SANDBOX_ENABLED'),
      defaultValue: false,
    }),
    TRUEFOUNDRY_SANDBOX_PROVIDER: parseTrueFoundrySandboxProvider(
      getEnv('TRUEFOUNDRY_SANDBOX_PROVIDER', { required: false }),
    ),
    TRUEFOUNDRY_SANDBOX_API_KEY: getEnv('TRUEFOUNDRY_SANDBOX_API_KEY', { required: false }),
    TRUEFOUNDRY_SANDBOX_SERVER_URL: getEnv('TRUEFOUNDRY_SANDBOX_SERVER_URL', { required: false }),
    TRUEFOUNDRY_SANDBOX_SETTINGS: getEnv('TRUEFOUNDRY_SANDBOX_SETTINGS', { required: false }),
    TRUEFOUNDRY_TENANT_ID_TO_ALLOWED_MODEL_PROVIDER_ACCOUNTS: parseTenantIdToAllowedModelProviderAccounts(
      getEnv('TRUEFOUNDRY_TENANT_ID_TO_ALLOWED_MODEL_PROVIDER_ACCOUNTS', { required: false }),
    ),
    TRUEFOUNDRY_WEB_SEARCH_PROVIDER: parseTrueFoundryWebSearchProvider(
      getEnv('TRUEFOUNDRY_WEB_SEARCH_PROVIDER', { required: false }),
    ),
  };

  if (isTrueFoundryModeEnabled(configuration)) {
    // TrueFoundry authenticates each caller with their own gateway token, so browser SSO must be off.
    if (isOidcConfigured(configuration)) {
      throw new Error(
        'TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL (TrueFoundry mode) and OIDC (SSO) cannot both be enabled at once.',
      );
    }
    // TRUEFOUNDRY_API_KEY is required when TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL is set.
    if (configuration.TRUEFOUNDRY_API_KEY === undefined) {
      throw new Error('TRUEFOUNDRY_API_KEY is required when TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL is set.');
    }

    // Shared sandbox
    if (configuration.TRUEFOUNDRY_SANDBOX_ENABLED) {
      if (configuration.TRUEFOUNDRY_SANDBOX_PROVIDER === undefined) {
        throw new Error(
          'TRUEFOUNDRY_SANDBOX_ENABLED is true but TRUEFOUNDRY_SANDBOX_PROVIDER is not set. ' +
            'Set TRUEFOUNDRY_SANDBOX_PROVIDER to "daytona" or "truefoundry", or set TRUEFOUNDRY_SANDBOX_ENABLED=false.',
        );
      }
      if (configuration.TRUEFOUNDRY_SANDBOX_SETTINGS === undefined) {
        throw new Error(
          'TRUEFOUNDRY_SANDBOX_ENABLED is true but TRUEFOUNDRY_SANDBOX_SETTINGS is not set. ' +
            'Provide a JSON settings object, or set TRUEFOUNDRY_SANDBOX_ENABLED=false.',
        );
      }
      try {
        JSON.parse(configuration.TRUEFOUNDRY_SANDBOX_SETTINGS);
      } catch (error) {
        throw new Error('TRUEFOUNDRY_SANDBOX_SETTINGS must be valid JSON', { cause: error });
      }
      if (
        configuration.TRUEFOUNDRY_SANDBOX_PROVIDER === 'daytona' &&
        configuration.TRUEFOUNDRY_SANDBOX_API_KEY === undefined
      ) {
        throw new Error(
          'TRUEFOUNDRY_SANDBOX_PROVIDER=daytona requires TRUEFOUNDRY_SANDBOX_API_KEY, or set TRUEFOUNDRY_SANDBOX_ENABLED=false.',
        );
      }
      if (
        configuration.TRUEFOUNDRY_SANDBOX_PROVIDER === 'truefoundry' &&
        configuration.TRUEFOUNDRY_SANDBOX_SERVER_URL === undefined
      ) {
        throw new Error(
          'TRUEFOUNDRY_SANDBOX_PROVIDER=truefoundry requires TRUEFOUNDRY_SANDBOX_SERVER_URL, or set TRUEFOUNDRY_SANDBOX_ENABLED=false.',
        );
      }
    }
  }

  if (configuration.TRUEFORGE_API_KEY.trim() === '') {
    throw new Error('TRUEFORGE_API_KEY must not be empty when STANDALONE=false.');
  }

  return configuration;
}

const configuration = parseServerConfiguration();

export function isOidcConfigured(
  value: ServerConfiguration,
): value is (DistributedServerConfiguration | WorkersServerConfiguration) & { OIDC: OIDCConfig } {
  return !value.STANDALONE && value.OIDC !== undefined;
}

/**
 * TrueFoundry mode: ServiceFoundry-backed models/MCP/agents. Only available on
 * distributed config when `TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL` is set.
 */
export function isTrueFoundryModeEnabled(
  config: ServerConfiguration = configuration,
): config is DistributedServerConfiguration & { TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL: string } {
  return config.RUNTIME === 'distributed' && config.TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL !== undefined;
}

/** Runtime auth/integration mode for this process. */
export enum TrueForgeAuthMode {
  Standalone = 'standalone',
  Oidc = 'oidc',
  TrueFoundry = 'truefoundry',
}

/**
 * Resolve the active {@link TrueForgeAuthMode} from configuration.
 * TrueFoundry wins over OIDC when both would otherwise be set (startup already rejects that combo).
 */
export function getTrueForgeAuthMode(config: ServerConfiguration = configuration): TrueForgeAuthMode {
  if (isTrueFoundryModeEnabled(config)) {
    return TrueForgeAuthMode.TrueFoundry;
  }
  if (isOidcConfigured(config)) {
    return TrueForgeAuthMode.Oidc;
  }
  return TrueForgeAuthMode.Standalone;
}

/**
 * Effective public application URL. Empty `PUBLIC_BASE_URL` stays empty
 * (callers that need a callback origin throw).
 */
function effectivePublicBaseUrl(config: ServerConfiguration): string {
  // Standalone production is one process on $PORT. Ignore a leftover Vite
  // PUBLIC_BASE_URL (e.g. http://localhost:3000) from the shared .env.
  if (config.STANDALONE && config.NODE_ENV !== 'development') {
    return `http://localhost:${String(config.PORT)}`;
  }
  return config.PUBLIC_BASE_URL;
}

/**
 * Public origin for OAuth callbacks.
 * Standalone (non-development) → `http://localhost:$PORT`; otherwise `PUBLIC_BASE_URL`
 * (required in development and distributed; throws if empty).
 */
export function getPublicBaseUrl(config: ServerConfiguration = configuration): string {
  const publicBaseUrl = effectivePublicBaseUrl(config);
  if (publicBaseUrl === '') {
    throw new Error('PUBLIC_BASE_URL is required for OIDC callbacks but was empty');
  }
  return publicBaseUrl;
}

/** The same value for a caller that would rather answer than throw. */
export function getPublicBaseUrlOrUndefined(config: ServerConfiguration = configuration): string | undefined {
  const publicBaseUrl = effectivePublicBaseUrl(config);
  return publicBaseUrl === '' ? undefined : publicBaseUrl;
}

/** `/` or `/custom/proxy/path/` — trailing slash for asset URLs and the boot script. Empty / standalone non-dev → `/`. */
export function getPublicUiBasePath(config: ServerConfiguration = configuration): string {
  const publicBaseUrl = effectivePublicBaseUrl(config);
  if (publicBaseUrl === '') {
    return '/';
  }
  const path = new URL(publicBaseUrl).pathname;
  return path === '/' ? '/' : `${path}/`;
}

export default configuration;
