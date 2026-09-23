/**
 * The browser Origin check on the desktop writes, through the app the Worker builds rather than a
 * router given its public URL. `wrangler dev` rewrites both the request URL and the Origin header
 * to the route's host, so a same-origin write there matches neither `PUBLIC_BASE_URL` nor localhost.
 */
import { env } from 'cloudflare:workers';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { Authenticator } from '../../src/auth/authenticator';
import { TrueForgeAuthorizer } from '../../src/auth/authorizer';
import type { RequestContext } from '../../src/auth/identity';
import { createServerRuntime } from '../../src/runtime/createServerRuntime';
import { workersComputersService } from '../../src/workers/computersService';
import { createConsoleLogger } from '../../src/workers/logger';
import { createWorkersRuntimeDeps } from '../../src/workers/runtime';
import { migrateDatabase, TENANT_ID, USER_REF } from './harness';
import { connectNewComputer, PUBLIC_BASE_URL } from './remoteComputerClient';

const SESSION_COOKIE = 'id_token=browser-session';
/** Where `wrangler dev` says a request to http://localhost:<port> was addressed, per the route in wrangler.jsonc. */
const DEV_PROXIED_ORIGIN = 'http://trueforge.rockyshoreslabs.io';

/** Accepts only the browser's session cookie, so every call here is a cookie-authenticated one. */
class CookieAuthenticator implements Authenticator {
  authenticate(c: Context): Promise<RequestContext> {
    if (getCookie(c, 'id_token') !== 'browser-session') {
      return Promise.reject(new HTTPException(401, { message: 'Unauthorized' }));
    }
    return Promise.resolve({
      tenant_id: TENANT_ID,
      subject: { id: USER_REF, type: 'user', display_name: USER_REF },
      roles: ['admin'],
      user_credential: null,
    });
  }
}

/** `createWorkersServerRuntime`, with the OIDC authenticator swapped for the cookie stand-in. */
function workerApp() {
  const { persistence, turnExecutor, sandboxIntegration, computers } = createWorkersRuntimeDeps(env);
  return createServerRuntime({
    persistence,
    logger: createConsoleLogger({ level: 'error', bindings: { component: 'origin-test' } }),
    sandboxIntegration,
    computers,
    clientCertificateMiddleware: undefined,
    authenticator: new CookieAuthenticator(),
    authorizer: new TrueForgeAuthorizer(),
    turnExecutor,
  });
}

function desktopAnswer(frame: Record<string, unknown>): Record<string, unknown> | undefined {
  return frame['op'] === 'desktop_clipboard_set' ? { ok: true } : undefined;
}

let computerCount = 0;
async function desktopComputer() {
  computerCount += 1;
  return connectNewComputer({
    name: `origin-box-${String(computerCount)}`,
    options: {
      hello: {
        capabilities: { python3: true, git: true, skills: false, desktop: true, desktop_unavailable_reason: null },
      },
      onRequest: desktopAnswer,
    },
  });
}

async function desktopWrite({
  app,
  computerId,
  path,
  requestOrigin,
  origin,
}: {
  app: Awaited<ReturnType<typeof workerApp>>;
  computerId: string;
  path: '/take-control' | '/hand-back';
  requestOrigin: string;
  origin: string | undefined;
}): Promise<Response> {
  return app.fetch(
    new Request(`${requestOrigin}/api/v1/computer-desktops/${computerId}${path}`, {
      method: 'POST',
      headers: {
        Cookie: SESSION_COOKIE,
        'Content-Type': 'application/json',
        ...(origin === undefined ? {} : { Origin: origin }),
      },
      body: '{}',
    }),
    env,
  );
}

beforeAll(async () => {
  await migrateDatabase();
});

describe('cookie-authenticated desktop writes', () => {
  it('are accepted from the origin the request was addressed to, as under wrangler dev', async () => {
    const app = await workerApp();
    const { computerId, client } = await desktopComputer();
    const at = { app, computerId, requestOrigin: DEV_PROXIED_ORIGIN, origin: DEV_PROXIED_ORIGIN };

    const taken = await desktopWrite({ ...at, path: '/take-control' });
    expect(taken.status).toBe(200);
    await expect(taken.json()).resolves.toMatchObject({ data: { controller: { kind: 'human', is_me: true } } });
    expect((await desktopWrite({ ...at, path: '/hand-back' })).status).toBe(200);
    client.close();
  });

  it('are accepted from PUBLIC_BASE_URL when a proxy addressed the request to another host', async () => {
    const app = await workerApp();
    const { computerId, client } = await desktopComputer();
    const response = await desktopWrite({
      app,
      computerId,
      path: '/take-control',
      requestOrigin: 'http://internal.test:8080',
      origin: PUBLIC_BASE_URL,
    });
    expect(response.status).toBe(200);
    client.close();
  });

  it.each([
    { name: 'another site', origin: 'https://evil.test' },
    { name: 'no Origin at all', origin: undefined },
  ])('are refused from $name', async ({ origin }) => {
    const app = await workerApp();
    const { computerId, client } = await desktopComputer();
    const response = await desktopWrite({
      app,
      computerId,
      path: '/take-control',
      requestOrigin: PUBLIC_BASE_URL,
      origin,
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { message: 'Cross-origin request refused' } });
    await expect(workersComputersService(env).relay(computerId).status()).resolves.toMatchObject({
      desktop_control: { kind: 'none' },
    });
    client.close();
  });
});
