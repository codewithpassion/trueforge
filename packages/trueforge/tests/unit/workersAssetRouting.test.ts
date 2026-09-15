import { parse, type ParseError } from 'jsonc-parser';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { SERVER_PATH_PREFIXES } from '../../src/frontendShell';

function readRunWorkerFirst(): unknown {
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
  return assets.run_worker_first;
}

describe('wrangler.jsonc assets.run_worker_first', () => {
  it('sends every server path to the Worker instead of static assets', () => {
    const patterns = readRunWorkerFirst();
    if (!Array.isArray(patterns)) {
      throw new Error('run_worker_first must be an array');
    }
    for (const prefix of SERVER_PATH_PREFIXES) {
      expect(patterns).toContain(prefix);
      expect(patterns).toContain(`${prefix}/*`);
    }
  });
});
