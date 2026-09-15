// Writes `worker-configuration.d.ts` from wrangler.jsonc, or with `--check` fails when the committed
// file is stale. An empty env file keeps a developer's local `.env` out of the generated `Env`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const packageDir = path.resolve(import.meta.dirname, '..');
const COMMITTED = 'worker-configuration.d.ts';
// Next to the committed file, so the generated relative imports match.
const CHECK_OUTPUT = 'worker-configuration.check.d.ts';
const EMPTY_ENV = path.join('.wrangler', 'empty.env');

/** Line 2 names the command, output path, and a hash of both, so only the rest is compared. */
function typesBody(file) {
  return readFileSync(path.join(packageDir, file), 'utf8').split(/\r?\n/).slice(2).join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const output = check ? CHECK_OUTPUT : COMMITTED;
  // Wrangler skips writing when the file's header hash already matches, which would keep a hand edit.
  rmSync(path.join(packageDir, output), { force: true });
  mkdirSync(path.join(packageDir, '.wrangler'), { recursive: true });
  writeFileSync(path.join(packageDir, EMPTY_ENV), '');
  try {
    const result = spawnSync(
      'bunx',
      ['wrangler', 'types', output, '--config=wrangler.jsonc', `--env-file=${EMPTY_ENV}`],
      {
        cwd: packageDir,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      },
    );
    if (result.status !== 0) {
      return result.status ?? 1;
    }
    if (check && typesBody(CHECK_OUTPUT) !== typesBody(COMMITTED)) {
      console.error(`${COMMITTED} does not match wrangler.jsonc; run \`pnpm workers:types\` and commit the result.`);
      return 1;
    }
    return 0;
  } finally {
    if (check) {
      rmSync(path.join(packageDir, CHECK_OUTPUT), { force: true });
    }
  }
}

process.exitCode = main();
