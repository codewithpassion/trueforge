/**
 * A stand-in for the Go client, speaking the frozen v1 contract over a real WebSocket against the
 * deployed routes. It answers ops from a table the test sets, so a test never reaches into the relay.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { env } from 'cloudflare:workers';
import {
  createComputerMachineRouter,
  createComputersRouter,
  registerComputerConnectRoute,
} from '../../src/apis/computers';
import type { RequestContext } from '../../src/auth/identity';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  PROTOCOL_VERSION,
  type HelloMessage,
} from '../../src/computers/protocol';
import type { ComputersService } from '../../src/computers/service';
import { workersComputersService } from '../../src/workers/computersService';
import { createConsoleLogger } from '../../src/workers/logger';
import { d1Persistence, TENANT_ID, USER_REF } from './harness';

export const PUBLIC_BASE_URL = 'https://trueforge.test';

export function testComputersService(): ComputersService {
  return workersComputersService(env);
}

function requestContextFor(tenantId: string): RequestContext {
  return {
    tenant_id: tenantId,
    subject: { id: USER_REF, type: 'user', display_name: USER_REF },
    roles: ['admin'],
    user_credential: null,
  };
}

/**
 * Only the computer routers, mounted in the same order the real app uses, so the machine's two
 * routes sit in front of the admin one. Auth is stood in for: this exercises the handlers, not OIDC.
 */
export function computersApp({
  computers,
  tenantId = TENANT_ID,
  dockerImage = '',
}: {
  computers: ComputersService | undefined;
  tenantId?: string;
  dockerImage?: string;
}) {
  const app = new OpenAPIHono();
  const logger = createConsoleLogger({ level: 'error', bindings: { component: 'computers-test' } });
  registerComputerConnectRoute({ app, path: '/api/v1/computers/connect', computers, logger });
  app.route('/api/v1/computers', createComputerMachineRouter({ computers, logger }));
  app.route(
    '/api/v1/computers',
    createComputersRouter({
      computers,
      resolveRequestContext: () => requestContextFor(tenantId),
      resolveAgentStore: () => d1Persistence().agentStore,
      publicBaseUrl: () => PUBLIC_BASE_URL,
      releaseBaseUrl: 'https://releases.test/trueforge-computer',
      dockerImage,
      logger,
    }),
  );
  return app;
}

export interface FakeClientOptions {
  hello?: Partial<HelloMessage>;
  /** Answers one op. Returning undefined leaves the request unanswered, which the relay times out. */
  onRequest?: (frame: Record<string, unknown>) => Record<string, unknown> | undefined;
}

/** A connected machine. `close()` drops the socket the way killing the process would. */
export class FakeComputerClient {
  readonly received: Record<string, unknown>[] = [];
  /** Requests the handler chose not to answer, so a test can settle them when it is ready. */
  readonly held: string[] = [];
  readonly #socket: WebSocket;
  #onRequest: FakeClientOptions['onRequest'];
  readonly #heartbeat: ReturnType<typeof setInterval>;

  private constructor(socket: WebSocket, options: FakeClientOptions) {
    this.#socket = socket;
    this.#onRequest = options.onRequest;
    // The contract says the client heartbeats; without it the relay's staleness check fires
    // twenty-five seconds after connect and a slow test looks like a suspended laptop.
    this.#heartbeat = setInterval(() => {
      socket.send(HEARTBEAT_PING);
    }, HEARTBEAT_INTERVAL_MS / 2);
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data === HEARTBEAT_PONG) {
        return;
      }
      const parsed: unknown = JSON.parse(event.data);
      if (typeof parsed !== 'object' || parsed === null || !('id' in parsed) || typeof parsed.id !== 'string') {
        return;
      }
      const frame: Record<string, unknown> = { ...parsed };
      this.received.push(frame);
      const result = this.#onRequest?.(frame);
      if (result === undefined) {
        this.held.push(parsed.id);
        return;
      }
      socket.send(JSON.stringify({ id: parsed.id, result }));
    });
  }

  /** Swaps the handler, so a test can stop holding requests once it has asserted. */
  answerWith(onRequest: FakeClientOptions['onRequest']): void {
    this.#onRequest = onRequest;
  }

  /** Answers everything the handler held back, so a test never waits out a relay deadline. */
  releaseHeld(result: Record<string, unknown>): void {
    for (const id of this.held.splice(0)) {
      this.#socket.send(JSON.stringify({ id, result }));
    }
  }

  static async connect({
    app,
    credential,
    options = {},
  }: {
    app: ReturnType<typeof computersApp>;
    credential: string;
    options?: FakeClientOptions;
  }): Promise<FakeComputerClient> {
    const response = await app.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers/connect`, {
        headers: { Upgrade: 'WebSocket', Authorization: `Bearer ${credential}` },
      }),
      env,
    );
    if (response.status !== 101 || response.webSocket === null) {
      throw new Error(`connect answered ${String(response.status)} with no socket`);
    }
    const socket = response.webSocket;
    socket.accept();
    const client = new FakeComputerClient(socket, options);
    client.sendHello(options.hello ?? {});
    return client;
  }

  sendHello(overrides: Partial<HelloMessage>): void {
    const hello: HelloMessage = {
      type: 'hello',
      protocol_version: PROTOCOL_VERSION,
      hostname: 'fake-box',
      os: 'linux',
      arch: 'amd64',
      version: '0.1.0-test',
      run_as_user: 'trueforge',
      capabilities: { python3: true, git: true },
      ...overrides,
    };
    this.#socket.send(JSON.stringify(hello));
  }

  /** Sends a frame the relay cannot read, to prove it is ignored rather than mistaken for a reply. */
  sendRaw(frame: string): void {
    this.#socket.send(frame);
  }

  close(code = 1000): void {
    clearInterval(this.#heartbeat);
    this.#socket.close(code, 'test');
  }
}

/** Waits for a condition rather than a fixed number of ticks, so a slow round trip is not a flake. */
export async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) {
      return;
    }
    await settle(2);
  }
  throw new Error('condition never became true');
}

/** Lets the runtime deliver frames both ways before the test asserts. */
export function settle(turns = 10): Promise<void> {
  return new Promise(resolve => {
    let remaining = turns;
    const step = (): void => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });
}
