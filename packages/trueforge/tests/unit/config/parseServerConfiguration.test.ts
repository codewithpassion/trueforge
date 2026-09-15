import { parseServerConfiguration } from '../../../src/config';

/** Keys these tests set; each test starts with all of them cleared and restores them afterwards. */
const MANAGED_KEYS = [
  'TRUEFORGE_RUNTIME',
  'STANDALONE',
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'REDIS_URL',
  'DATABASE_URL',
  'TRUEFORGE_API_KEY',
  'TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL',
  'PUBLIC_BASE_URL',
] as const;

type ManagedEnv = Partial<Record<(typeof MANAGED_KEYS)[number], string>>;

const OIDC_ENV: ManagedEnv = {
  OIDC_ISSUER_URL: 'https://issuer.example.com/',
  OIDC_CLIENT_ID: 'workers-client',
  OIDC_CLIENT_SECRET: 'workers-secret',
};

/** The minimum a workers configuration accepts. */
const WORKERS_ENV: ManagedEnv = {
  TRUEFORGE_RUNTIME: 'workers',
  ...OIDC_ENV,
  PUBLIC_BASE_URL: 'https://trueforge.example.com',
};

function parseWithEnv(env: ManagedEnv) {
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

describe('parseServerConfiguration', () => {
  describe('without TRUEFORGE_RUNTIME', () => {
    it('defaults to standalone', () => {
      const config = parseWithEnv({});
      expect(config.RUNTIME).toBe('standalone');
      expect(config.STANDALONE).toBe(true);
    });

    it('follows STANDALONE=true', () => {
      const config = parseWithEnv({ STANDALONE: 'true' });
      expect(config.RUNTIME).toBe('standalone');
      expect(config.STANDALONE).toBe(true);
    });

    it('follows STANDALONE=false', () => {
      const config = parseWithEnv({ STANDALONE: 'false', TRUEFORGE_API_KEY: 'service-key' });
      if (config.RUNTIME !== 'distributed') {
        throw new Error(`expected distributed, got ${config.RUNTIME}`);
      }
      expect(config.STANDALONE).toBe(false);
      expect(config.REDIS_URL).toBe('redis://localhost:6379');
      expect(config.TRUEFORGE_API_KEY).toBe('service-key');
    });
  });

  it('accepts TRUEFORGE_RUNTIME=distributed without STANDALONE', () => {
    const config = parseWithEnv({ TRUEFORGE_RUNTIME: 'distributed', TRUEFORGE_API_KEY: 'service-key' });
    expect(config.RUNTIME).toBe('distributed');
    expect(config.STANDALONE).toBe(false);
  });

  describe('TRUEFORGE_RUNTIME=workers', () => {
    it('parses with OIDC configured', () => {
      const config = parseWithEnv(WORKERS_ENV);
      if (config.RUNTIME !== 'workers') {
        throw new Error(`expected workers, got ${config.RUNTIME}`);
      }
      expect(config.STANDALONE).toBe(false);
      expect(config.OIDC.OIDC_CLIENT_ID).toBe('workers-client');
    });

    it('accepts an agreeing STANDALONE=false', () => {
      expect(parseWithEnv({ ...WORKERS_ENV, STANDALONE: 'false' }).RUNTIME).toBe('workers');
    });

    it('ignores Node-only settings', () => {
      const config = parseWithEnv({
        ...WORKERS_ENV,
        REDIS_URL: 'redis://redis:6379',
        DATABASE_URL: 'postgres://user:pass@db:5432/trueforge',
        TRUEFORGE_API_KEY: 'service-key',
      });
      for (const key of [
        'REDIS_URL',
        'DATABASE_URL',
        'TRUEFORGE_API_KEY',
        'SERVER_URL',
        'PORT',
        'HOST',
        'EXECUTOR_ID',
        'GRACEFUL_TIMEOUT_SECONDS',
        'REDIS_REQUEST_REPLY_TIMEOUT_MS',
        'REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS',
        'REDIS_REQUEST_REPLY_REPLY_TTL_MS',
        'REDIS_REQUEST_REPLY_POLL_INTERVAL_MS',
      ]) {
        expect(config).not.toHaveProperty(key);
      }
    });

    it('requires OIDC', () => {
      expect(() => parseWithEnv({ TRUEFORGE_RUNTIME: 'workers' })).toThrow(
        /TRUEFORGE_RUNTIME=workers requires OIDC_ISSUER_URL/,
      );
    });

    it('rejects STANDALONE=true', () => {
      expect(() => parseWithEnv({ TRUEFORGE_RUNTIME: 'workers', STANDALONE: 'true', ...OIDC_ENV })).toThrow(
        /TRUEFORGE_RUNTIME=workers contradicts STANDALONE=true/,
      );
    });

    it('accepts a PUBLIC_BASE_URL origin', () => {
      const config = parseWithEnv({
        TRUEFORGE_RUNTIME: 'workers',
        ...OIDC_ENV,
        PUBLIC_BASE_URL: 'https://trueforge.example.com/',
      });
      expect(config.PUBLIC_BASE_URL).toBe('https://trueforge.example.com');
    });

    it('rejects a PUBLIC_BASE_URL with a path prefix', () => {
      expect(() =>
        parseWithEnv({ TRUEFORGE_RUNTIME: 'workers', ...OIDC_ENV, PUBLIC_BASE_URL: 'https://example.com/trueforge' }),
      ).toThrow(/PUBLIC_BASE_URL must not include a path when TRUEFORGE_RUNTIME=workers/);
    });

    it('rejects an empty PUBLIC_BASE_URL', () => {
      expect(() => parseWithEnv({ TRUEFORGE_RUNTIME: 'workers', ...OIDC_ENV })).toThrow(
        /PUBLIC_BASE_URL is required when TRUEFORGE_RUNTIME=workers/,
      );
    });

    it('rejects TrueFoundry mode', () => {
      expect(() =>
        parseWithEnv({
          TRUEFORGE_RUNTIME: 'workers',
          ...OIDC_ENV,
          TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL: 'https://servicefoundry.example.com',
        }),
      ).toThrow(/not supported when TRUEFORGE_RUNTIME=workers/);
    });
  });

  it('rejects TRUEFORGE_RUNTIME=distributed with STANDALONE=true', () => {
    expect(() => parseWithEnv({ TRUEFORGE_RUNTIME: 'distributed', STANDALONE: 'true' })).toThrow(
      /TRUEFORGE_RUNTIME=distributed contradicts STANDALONE=true/,
    );
  });

  it('rejects an unknown TRUEFORGE_RUNTIME', () => {
    expect(() => parseWithEnv({ TRUEFORGE_RUNTIME: 'lambda' })).toThrow(/TRUEFORGE_RUNTIME must be/);
  });
});
