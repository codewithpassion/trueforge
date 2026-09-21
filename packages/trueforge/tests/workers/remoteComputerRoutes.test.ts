/**
 * Every fixed path under `/api/v1/computers` sits beside `/{computer_id}`, so any of them can be
 * swallowed by the wildcard if it is registered after it. `/audit` was, and answered "no such
 * computer" instead of listing anything. This enumerates them so the next one cannot.
 */
import { env } from 'cloudflare:workers';
import type { ComputersService } from '../../src/computers/service';
import { migrateDatabase } from './harness';
import { computersApp, PUBLIC_BASE_URL, testComputersService } from './remoteComputerClient';

/** Each fixed path, and a status it must NOT answer with if the wildcard has eaten it. */
const FIXED_PATHS = [
  { method: 'GET', path: '/api/v1/computers/audit' },
  { method: 'POST', path: '/api/v1/computers/enroll' },
  { method: 'GET', path: '/api/v1/computers/connect' },
] as const;

function bodyFor(path: string): string | undefined {
  return path.endsWith('/enroll')
    ? JSON.stringify({ enrollment_code: 'nope', hostname: 'h', os: 'linux', arch: 'amd64', version: '0' })
    : undefined;
}

beforeAll(async () => {
  await migrateDatabase();
});

describe('the fixed paths are not shadowed by /{computer_id}', () => {
  it.each(FIXED_PATHS)('$method $path reaches its own handler', async ({ method, path }) => {
    const app = computersApp({ computers: testComputersService() });
    const body = bodyFor(path);
    const response = await app.fetch(
      new Request(`${PUBLIC_BASE_URL}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }),
        ...(path.endsWith('/connect') ? { headers: { Upgrade: 'websocket' } } : {}),
      }),
      env,
    );
    // The wildcard's answer, and the only one that proves the route never ran.
    if (response.status === 404) {
      await expect(response.json()).resolves.not.toEqual({ error: { message: 'No such computer' } });
    }
  });

  it('GET /audit lists the tenant rather than looking for a computer called "audit"', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const response = await app.fetch(new Request(`${PUBLIC_BASE_URL}/api/v1/computers/audit`), env);
    expect(response.status).toBe(200);
    const body = await response.json<{ data: unknown[]; pagination: { limit: number } }>();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination.limit).toBeGreaterThan(0);
  });
});

describe('the rate limiter', () => {
  it('lets a request through when it cannot answer, rather than locking the machine out', async () => {
    const working = testComputersService();
    const broken: ComputersService = {
      store: working.store,
      rateLimiter: {
        take: () => Promise.reject(new Error('the limiter is down')),
      },
      relay: computerId => working.relay(computerId),
      relayFetch: input => working.relayFetch(input),
    };
    const app = computersApp({ computers: broken });
    const response = await app.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
        body: JSON.stringify({
          enrollment_code: 'not-a-real-code',
          hostname: 'h',
          os: 'linux',
          arch: 'amd64',
          version: '0',
        }),
      }),
      env,
    );
    // 401 for the bad code, not 500 from the limiter and not 429.
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { message: 'Unauthorized' } });
  });
});
