import path from 'node:path';

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { handleMockLlmRequest } from './mockLlm';

const harnessDir = import.meta.dirname;

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(harnessDir, '../../migrations/d1'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: path.join(harnessDir, 'wrangler.jsonc') },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          // Every subrequest the Worker or its Durable Objects make lands here.
          outboundService: handleMockLlmRequest,
        },
      }),
    ],
    // Workspace packages resolve to src/ through their `trueforge-dev` export condition.
    resolve: { conditions: ['trueforge-dev'] },
    ssr: { resolve: { conditions: ['trueforge-dev'], externalConditions: ['trueforge-dev'] } },
    test: {
      globals: true,
      include: [path.join(harnessDir, '**/*.test.ts')],
      testTimeout: 180_000,
    },
  };
});
