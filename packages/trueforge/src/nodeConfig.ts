/**
 * Node-only configuration defaults derived from the package location, the OS temp dir, and
 * `env-paths`. Evaluated at import, so only Node entry points and Node-only modules import it.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import envPaths from 'env-paths';

import { getEnv, resolveOptionalPathEnv } from './config';

/**
 * Package root whether this module runs as `src/nodeConfig.ts` (tsx) or is bundled
 * into `dist/main.js` (`import.meta` → `dist/` → parent).
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** OS-standard data dir for SQLite in standalone mode. */
const ENV_PATHS_APP_NAME = 'trueforge';

const appDataDir = envPaths(ENV_PATHS_APP_NAME, {
  suffix: getEnv('APP_DATA_DIR_SUFFIX', { defaultValue: '' }) ?? '',
}).data;

/**
 * Prefer `dist/_frontend` shipped in the npm tarball (npx / `pnpm start`).
 * Fall back to the monorepo sibling `../frontend/dist` (host-dev before a copy).
 */
function resolveDefaultFrontendDir(): string {
  const packaged = path.join(PACKAGE_ROOT, 'dist', '_frontend');
  if (existsSync(path.join(packaged, 'index.html'))) {
    return packaged;
  }
  return path.join(PACKAGE_ROOT, '..', 'frontend', 'dist');
}

/**
 * Frontend build served alongside the API; a missing directory leaves the server API-only.
 * Env: `FRONTEND_DIR`. Default: packaged `dist/_frontend` (npx tarball) or
 * monorepo `packages/frontend/dist` — always absolute, independent of CWD.
 */
export const FRONTEND_DIR = resolveOptionalPathEnv('FRONTEND_DIR') ?? resolveDefaultFrontendDir();

/**
 * Absolute SQLite database file path for standalone mode.
 * Env: `SQLITE_PATH` (optional). Default: env-paths data dir + `db/db.sqlite`.
 */
export const SQLITE_PATH = resolveOptionalPathEnv('SQLITE_PATH') ?? path.join(appDataDir, 'db', 'db.sqlite');

/** Parent directory for local sandbox roots (ULID children): `{env-paths data}/sandboxes`. */
export const LOCAL_SANDBOX_ROOT_PARENT = path.join(appDataDir, 'sandboxes');

/**
 * Parent directory for Code Mode UDS sockets (`tf_cms` under os.tmpdir()).
 * Caller prepares/removes this directory; must stay ≤65 bytes after realpath.
 */
export const CODE_MODE_SOCKET_PARENT = path.join(os.tmpdir(), 'tf_cms');
