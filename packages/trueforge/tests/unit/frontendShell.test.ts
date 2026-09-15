import { parse, type ParseError } from 'jsonc-parser';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { applyShellTokens, renderStaticAssetHeaders, SERVER_PATH_PREFIXES } from '../../src/frontendShell';

function readRunWorkerFirst(): unknown[] {
  const errors: ParseError[] = [];
  const config: unknown = parse(readFileSync(path.join(__dirname, '../../wrangler.jsonc'), 'utf8'), errors, {
    allowTrailingComma: true,
  });
  expect(errors).toEqual([]);
  if (typeof config !== 'object' || config === null || !('assets' in config)) {
    throw new Error('wrangler.jsonc has no assets block');
  }
  const { assets } = config;
  if (typeof assets !== 'object' || assets === null || !('run_worker_first' in assets)) {
    throw new Error('wrangler.jsonc assets has no run_worker_first');
  }
  if (!Array.isArray(assets.run_worker_first)) {
    throw new Error('run_worker_first must be an array');
  }
  return assets.run_worker_first;
}

describe('applyShellTokens', () => {
  it('replaces every base path token in the shell', () => {
    const html =
      '<script src="%%TRUEFORGE_BASE_PATH%%assets/app.js"></script>' +
      "<script>window.__TRUEFORGE_BASE_PATH__='%%TRUEFORGE_BASE_PATH%%';</script>";

    expect(applyShellTokens({ html, uiBasePath: '/' })).toBe(
      '<script src="/assets/app.js"></script>' + "<script>window.__TRUEFORGE_BASE_PATH__='/';</script>",
    );
  });
});

describe('renderStaticAssetHeaders', () => {
  it('caches hashed assets forever and revalidates everything else', () => {
    expect(renderStaticAssetHeaders()).toBe(
      [
        '/*',
        '  Cache-Control: no-cache',
        '',
        '/assets/*',
        '  ! Cache-Control',
        '  Cache-Control: public, max-age=31536000, immutable',
        '',
      ].join('\n'),
    );
  });
});

describe('wrangler.jsonc assets.run_worker_first', () => {
  it('sends exactly the server paths to the Worker instead of static assets', () => {
    const patterns = readRunWorkerFirst();
    expect([...patterns].sort()).toEqual(SERVER_PATH_PREFIXES.flatMap(p => [p, `${p}/*`]).sort());
  });
});
