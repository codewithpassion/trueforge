import { parseServerConfiguration } from '../../../src/config';
import { assertWorkersRuntime } from '../../../src/workers/runtimeGuard';

const MANAGED_KEYS = [
  'TRUEFORGE_RUNTIME',
  'STANDALONE',
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'PUBLIC_BASE_URL',
];

function parseWithEnv(env: Record<string, string>) {
  const saved = new Map(MANAGED_KEYS.map(key => [key, process.env[key]]));
  for (const key of MANAGED_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return parseServerConfiguration();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('assertWorkersRuntime', () => {
  it('refuses the standalone fallback an unset TRUEFORGE_RUNTIME resolves to', () => {
    const configuration = parseWithEnv({});

    expect(configuration.RUNTIME).toBe('standalone');
    expect(() => {
      assertWorkersRuntime(configuration);
    }).toThrow(/TRUEFORGE_RUNTIME must be "workers".*got "standalone"/);
  });

  it('accepts an explicit workers configuration', () => {
    const configuration = parseWithEnv({
      TRUEFORGE_RUNTIME: 'workers',
      OIDC_ISSUER_URL: 'https://issuer.example.com/',
      OIDC_CLIENT_ID: 'workers-client',
      OIDC_CLIENT_SECRET: 'workers-secret',
      PUBLIC_BASE_URL: 'https://trueforge.example.com',
    });

    expect(() => {
      assertWorkersRuntime(configuration);
    }).not.toThrow();
  });
});
