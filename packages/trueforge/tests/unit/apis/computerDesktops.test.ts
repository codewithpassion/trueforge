import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { Context } from 'hono';
import { createComputerDesktopsRouter } from '../../../src/apis/computerDesktops';
import { TrueForgeAuthorizer, type Authorizer } from '../../../src/auth/authorizer';
import type { RequestContext } from '../../../src/auth/identity';
import {
  ClientOpRequestSchema,
  type ComputerRelayStatus,
  type DesktopControlState,
  type RelayRequestInput,
  type RequestFailureReason,
  type RequestOutcome,
  type TakeHumanLeaseOutcome,
} from '../../../src/computers/protocol';
import type { ComputerRelayPort, ComputersService } from '../../../src/computers/service';
import type { HumanTakeoverService, PendingTakeover } from '../../../src/computers/takeover';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { BetterSqliteAtomicRunner, createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteComputerStore } from '../../../src/db/sqlite/computer-store/SqliteComputerStore';

const TENANT = 'default';
const OTHER_TENANT = 'elsewhere';
const PUBLIC_BASE_URL = 'https://forge.test';
const ORIGIN = 'https://forge.test';
const COMPUTER_ID = 'cmp_desk';
const FOREIGN_COMPUTER_ID = 'cmp_foreign';
const JPEG_B64 = '/9j/4AAQ';
const SCREENSHOT = { data_b64: JPEG_B64, width: 1280, height: 800, media_type: 'image/jpeg' };
const TYPED_SECRET = 'hunter2-typed-secret';
const CLIPBOARD_SECRET = 'clipboard-secret-value';

/**
 * The relay's lease matrix for a person, small enough to read: watching needs no lease unless
 * another person has it, and everything else needs this person to hold it.
 */
class FakeRelay implements ComputerRelayPort {
  readonly sent: RelayRequestInput[] = [];
  readonly taken: { tenant_id: string; user_id: string }[] = [];
  readonly releasedFor: { tenant_id: string; user_id: string }[] = [];
  control: DesktopControlState = { kind: 'none' };
  connected = true;
  failWith: RequestFailureReason | undefined;
  takeOutcome: TakeHumanLeaseOutcome = { ok: true };

  request(input: RelayRequestInput): Promise<RequestOutcome> {
    this.sent.push(input);
    const refuse = (reason: RequestFailureReason): Promise<RequestOutcome> =>
      Promise.resolve({ ok: false, reason, message: `refused: ${reason}`, last_seen_at: null, waited_ms: 0 });
    if (!this.connected) {
      return refuse('offline');
    }
    if (this.failWith !== undefined) {
      return refuse(this.failWith);
    }
    if (this.control.kind === 'clearing') {
      return refuse('desktop_busy');
    }
    const op = ClientOpRequestSchema.parse(JSON.parse(input.op_json));
    const principal = input.principal;
    const userId = principal.kind === 'human' ? principal.user_id : undefined;
    const holds = this.control.kind === 'human' && this.control.user_id === userId;
    if (this.control.kind === 'human' && !holds) {
      return refuse('human_in_control');
    }
    if (op.op !== 'desktop_screenshot' && !holds) {
      return refuse('forbidden');
    }
    const result =
      op.op === 'desktop_screenshot'
        ? SCREENSHOT
        : op.op === 'desktop_clipboard_get'
          ? { text: CLIPBOARD_SECRET }
          : { ok: true };
    return Promise.resolve({ ok: true, result_json: JSON.stringify(result), waited_ms: 1 });
  }

  releaseLease(): Promise<{ released: boolean }> {
    return Promise.reject(new Error('not used'));
  }

  takeHumanLease(input: { tenant_id: string; user_id: string }): Promise<TakeHumanLeaseOutcome> {
    this.taken.push(input);
    if (this.takeOutcome.ok) {
      this.control = { kind: 'human', user_id: input.user_id, expires_at: Date.parse('2026-09-24T10:05:00Z') };
    }
    return Promise.resolve(this.takeOutcome);
  }

  releaseHumanLease(input: { tenant_id: string; user_id: string }) {
    this.releasedFor.push(input);
    if (this.control.kind !== 'human' || this.control.user_id !== input.user_id) {
      return Promise.resolve({ released: false, clipboard_cleared: false });
    }
    this.control = { kind: 'none' };
    return Promise.resolve({ released: true, clipboard_cleared: true });
  }

  revoke(): Promise<{ closed: number }> {
    return Promise.reject(new Error('not used'));
  }

  disconnect(): Promise<{ closed: number }> {
    return Promise.reject(new Error('not used'));
  }

  destroy(): Promise<void> {
    return Promise.reject(new Error('not used'));
  }

  status(): Promise<ComputerRelayStatus> {
    return Promise.resolve({
      connected: this.connected,
      revoked: false,
      generation: 1,
      last_seen_at: null,
      pending: 0,
      in_flight_exec: 0,
      queued: 0,
      hello: {
        type: 'hello',
        protocol_version: 1,
        hostname: 'desk',
        os: 'linux',
        arch: 'amd64',
        version: '1.0.0',
        run_as_user: 'forge',
        workdir: '/var/lib/x/sessions',
        capabilities: {
          python3: true,
          git: true,
          skills: false,
          desktop: true,
          desktop_unavailable_reason: null,
        },
      },
      desktop_control: this.control,
    });
  }
}

class FakeTakeovers implements HumanTakeoverService {
  pending: PendingTakeover[] = [];
  answer: Awaited<ReturnType<HumanTakeoverService['resolveTakeover']>> = { ok: true };
  readonly resolved: Parameters<HumanTakeoverService['resolveTakeover']>[0][] = [];

  listPendingTakeovers(input: { tenant_id: string; computer_id: string; agent_id?: string }) {
    return Promise.resolve(
      this.pending.filter(takeover => input.agent_id === undefined || takeover.agent_id === input.agent_id),
    );
  }

  resolveTakeover(input: Parameters<HumanTakeoverService['resolveTakeover']>[0]) {
    this.resolved.push(input);
    return Promise.resolve(this.answer);
  }
}

function capturingLogger(): { logger: Logger; lines: unknown[] } {
  const lines: unknown[] = [];
  const logger: Logger = {
    debug: (message, meta) => lines.push(['debug', message, meta]),
    info: (message, meta) => lines.push(['info', message, meta]),
    warn: (message, meta) => lines.push(['warn', message, meta]),
    error: (message, meta) => lines.push(['error', message, meta]),
    child: () => logger,
  };
  return { logger, lines };
}

/** The caller comes from test headers; the router only ever sees the resolved context. */
function contextFor(c: Context): RequestContext {
  const user = c.req.header('x-test-user') ?? 'alice';
  return {
    tenant_id: TENANT,
    subject: { id: user, type: 'user', display_name: user },
    roles: c.req.header('x-test-admin') === 'true' ? ['admin'] : [],
    user_credential: null,
  };
}

function specFor(sandbox: { computer_id?: string; desktop: boolean }) {
  return AgentSpecSchema.parse({
    model: { name: 'anthropic/claude-sonnet-4-6' },
    instructions: 'Drive the desktop.',
    config: { sandbox: { enabled: true, ...sandbox } },
  });
}

let agentStore: SqliteAgentStore;
let computerStore: SqliteComputerStore;
const agents: Record<'desk' | 'elsewhere' | 'ungranted' | 'noDesktop' | 'private', string> = {
  desk: '',
  elsewhere: '',
  ungranted: '',
  noDesktop: '',
  private: '',
};

beforeAll(async () => {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  agentStore = new SqliteAgentStore(db);
  computerStore = new SqliteComputerStore(db, new BetterSqliteAtomicRunner(db));
  const future = new Date(Date.now() + 60_000).toISOString();
  for (const [id, tenant] of [
    [COMPUTER_ID, TENANT],
    [FOREIGN_COMPUTER_ID, OTHER_TENANT],
  ] as const) {
    await computerStore.createComputer({
      id,
      tenant_id: tenant,
      name: id.replace('_', '-'),
      owner_subject: 'admin',
      require_approval: false,
      code_hash: `hash-${id}`,
      code_expires_at: future,
    });
  }
  const create = async (name: string, sandbox: { computer_id?: string; desktop: boolean }) =>
    (
      await agentStore.createAgent({
        tenant_id: TENANT,
        name,
        description: '',
        manifest: specFor(sandbox),
        external_id: null,
        created_by_subject: { subject_id: 'owner', subject_type: 'user', subject_display_name: 'owner' },
      })
    ).id;
  agents.desk = await create('desk-agent', { computer_id: COMPUTER_ID, desktop: true });
  agents.elsewhere = await create('elsewhere-agent', { computer_id: 'cmp_other', desktop: true });
  agents.ungranted = await create('ungranted-agent', { computer_id: COMPUTER_ID, desktop: true });
  agents.noDesktop = await create('no-desktop-agent', { computer_id: COMPUTER_ID, desktop: false });
  agents.private = await create('private-agent', { computer_id: COMPUTER_ID, desktop: true });
  await computerStore.putAgentAccess({
    tenant_id: TENANT,
    computer_id: COMPUTER_ID,
    agents: [
      { agent_id: agents.desk, agent_name: 'desk-agent' },
      { agent_id: agents.noDesktop, agent_name: 'no-desktop-agent' },
      { agent_id: agents.private, agent_name: 'private-agent' },
    ],
  });
});

/** Everyone may use every agent except the private one. */
const authorizer: Authorizer = {
  listAgentAccess: () => Promise.resolve({ kind: 'all' }),
  canAccessAgent: input => Promise.resolve(input.agent.id !== agents.private),
  getPermissions: input => new TrueForgeAuthorizer().getPermissions(input),
};

function setup(options: { withComputers?: boolean; withTakeovers?: boolean } = {}) {
  const relay = new FakeRelay();
  const takeovers = new FakeTakeovers();
  const { logger, lines } = capturingLogger();
  const computers: ComputersService = {
    store: computerStore,
    rateLimiter: undefined,
    relay: () => relay,
    relayFetch: () => Promise.reject(new Error('not used')),
  };
  const router = createComputerDesktopsRouter({
    computers: options.withComputers === false ? undefined : computers,
    humanTakeovers: options.withTakeovers === false ? undefined : takeovers,
    resolveRequestContext: contextFor,
    resolveAgentStore: () => agentStore,
    authorizer,
    publicBaseUrl: () => PUBLIC_BASE_URL,
    logger,
  });

  function call({
    method = 'GET',
    path = '',
    agentId = agents.desk,
    user,
    admin = false,
    origin = ORIGIN,
    bearer,
    body,
    computerId = COMPUTER_ID,
  }: {
    method?: string;
    path?: string;
    /** Null sends none; undefined would take the default. */
    agentId?: string | null;
    user?: string;
    admin?: boolean;
    origin?: string | null;
    bearer?: string;
    body?: unknown;
    computerId?: string;
  }) {
    const headers: Record<string, string> = {};
    if (user !== undefined) {
      headers['x-test-user'] = user;
    }
    if (admin) {
      headers['x-test-admin'] = 'true';
    }
    if (origin !== null) {
      headers['Origin'] = origin;
    }
    if (bearer !== undefined) {
      headers['Authorization'] = `Bearer ${bearer}`;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const query = agentId === null ? '' : `?agent_id=${encodeURIComponent(agentId)}`;
    return router.request(`/${computerId}${path}${query}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  return { relay, takeovers, lines, call };
}

function opOf(sent: RelayRequestInput | undefined) {
  if (sent === undefined) {
    throw new Error('nothing was sent');
  }
  return ClientOpRequestSchema.parse(JSON.parse(sent.op_json));
}

async function errorOf(response: Response): Promise<{ message: string; code?: string | null }> {
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    throw new Error('not an error envelope');
  }
  const { error } = body;
  if (typeof error !== 'object' || error === null || !('message' in error) || typeof error.message !== 'string') {
    throw new Error('not an error envelope');
  }
  return { message: error.message, code: 'code' in error && typeof error.code === 'string' ? error.code : null };
}

async function statusOf(response: Response) {
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new Error('not a status envelope');
  }
  return body.data;
}

const PENDING_DESK: PendingTakeover = {
  session_id: 'ses_desk',
  turn_id: 'turn_1',
  tool_call_id: 'call_1',
  reason: 'Log in to the bank',
  requested_at: '2026-09-24T10:00:00.000Z',
  agent_id: '',
};

describe('access', () => {
  it('answers 404 for an agent the caller may not use', async () => {
    const { call, relay } = setup();
    const response = await call({ agentId: agents.private });
    expect(response.status).toBe(404);
    expect(relay.sent).toHaveLength(0);
  });

  it('answers 404 for an agent that does not exist', async () => {
    const { call } = setup();
    expect((await call({ agentId: 'no-such-agent' })).status).toBe(404);
  });

  it.each([
    ['whose spec points at another computer', 'elsewhere'],
    ['that is not on the allowlist', 'ungranted'],
    ['whose desktop is off', 'noDesktop'],
  ] as const)('answers 403 for an agent %s', async (_label, agent) => {
    const { call, relay } = setup();
    const response = await call({ path: '/screenshot', agentId: agents[agent] });
    expect(response.status).toBe(403);
    expect(relay.sent).toHaveLength(0);
  });

  it('refuses a caller who names no saved agent, which is all an inline agent can do', async () => {
    const { call } = setup();
    expect((await call({ agentId: null })).status).toBe(403);
    expect((await call({ method: 'POST', path: '/take-control', agentId: null })).status).toBe(403);
  });

  it('lets a tenant admin in without an agent, and shows every pending takeover', async () => {
    const { call, takeovers } = setup();
    takeovers.pending = [
      { ...PENDING_DESK, agent_id: agents.desk },
      { ...PENDING_DESK, session_id: 'ses_other', agent_id: 'agent_other' },
    ];
    const response = await call({ agentId: null, admin: true });
    expect(response.status).toBe(200);
    expect(await statusOf(response)).toEqual({
      computer_id: COMPUTER_ID,
      online: true,
      desktop: true,
      controller: { kind: 'none' },
      pending_takeovers: takeovers.pending,
    });
  });

  it('shows a non-admin only the takeovers of the agent they named', async () => {
    const { call, takeovers } = setup();
    const mine = { ...PENDING_DESK, agent_id: agents.desk };
    takeovers.pending = [mine, { ...PENDING_DESK, session_id: 'ses_other', agent_id: 'agent_other' }];
    const response = await call({});
    expect(response.status).toBe(200);
    expect(await statusOf(response)).toMatchObject({ pending_takeovers: [mine] });
  });

  it('resolves the computer in the caller tenant first, even for an admin', async () => {
    const { call } = setup();
    expect((await call({ admin: true, agentId: null, computerId: FOREIGN_COMPUTER_ID })).status).toBe(404);
  });

  it('answers 404 on a runtime without computers', async () => {
    const { call } = setup({ withComputers: false });
    expect((await call({})).status).toBe(404);
  });
});

describe('the origin check', () => {
  const WRITES = [
    { method: 'POST', path: '/input', body: { actions: [{ type: 'key', keys: 'ctrl+l' }] } },
    { method: 'PUT', path: '/clipboard', body: { text: 'x' } },
    { method: 'POST', path: '/take-control', body: undefined },
    { method: 'POST', path: '/hand-back', body: {} },
    { method: 'POST', path: '/cancel-takeover', body: { session_id: 'ses_desk' } },
  ];

  it.each(WRITES)('refuses $method $path from a cookie caller with no Origin', async ({ method, path, body }) => {
    const { call, relay, takeovers } = setup();
    const response = await call({ method, path, body, origin: null });
    expect(response.status).toBe(403);
    expect(relay.sent).toHaveLength(0);
    expect(relay.taken).toHaveLength(0);
    expect(relay.releasedFor).toHaveLength(0);
    expect(takeovers.resolved).toHaveLength(0);
  });

  it.each(WRITES)('refuses $method $path from another origin', async ({ method, path, body }) => {
    const { call, relay } = setup();
    const response = await call({ method, path, body, origin: 'https://evil.test' });
    expect(response.status).toBe(403);
    expect(relay.sent).toHaveLength(0);
    expect(relay.taken).toHaveLength(0);
  });

  it('lets a bearer caller write without an Origin', async () => {
    const { call, relay } = setup();
    const response = await call({ method: 'POST', path: '/take-control', origin: null, bearer: 'token' });
    expect(response.status).toBe(200);
    expect(relay.taken).toEqual([{ tenant_id: TENANT, user_id: 'alice' }]);
  });

  it('does not ask reads for an Origin', async () => {
    const { call } = setup();
    expect((await call({ path: '/screenshot', origin: null })).status).toBe(200);
  });
});

describe('frames and input', () => {
  it('serves a frame to a viewer while nobody controls the desktop, uncached', async () => {
    const { call } = setup();
    const response = await call({ path: '/screenshot' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(Buffer.from(await response.arrayBuffer()).toString('base64')).toBe(JPEG_B64);
  });

  it('refuses a frame with 423 human_in_control while another person controls', async () => {
    const { call, relay } = setup();
    relay.control = { kind: 'human', user_id: 'bob', expires_at: Date.now() + 60_000 };
    const response = await call({ path: '/screenshot' });
    expect(response.status).toBe(423);
    expect((await errorOf(response)).code).toBe('human_in_control');
  });

  it('answers 409 clearing while the last clipboard is being cleared', async () => {
    const { call, relay } = setup();
    relay.control = { kind: 'clearing' };
    const response = await call({ path: '/screenshot' });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('clearing');
  });

  it.each([
    ['offline', 'offline'],
    ['timeout', 'offline'],
    ['desktop_unavailable', 'desktop_unavailable'],
  ] as const)('answers 503 when the relay says %s', async (reason, code) => {
    const { call, relay } = setup();
    relay.failWith = reason;
    const response = await call({ path: '/screenshot' });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe(code);
  });

  it('refuses input without control with 423', async () => {
    const { call, relay } = setup();
    const response = await call({
      method: 'POST',
      path: '/input',
      body: { actions: [{ type: 'click', x: 1, y: 1, button: 'left', count: 1 }] },
    });
    expect(response.status).toBe(423);
    expect((await errorOf(response)).code).toBe('lease_required');
    expect(relay.sent.map(sent => opOf(sent).op)).toEqual(['desktop_input']);
  });

  it('runs input as the signed-in person and answers with a fresh frame', async () => {
    const { call, relay } = setup();
    relay.control = { kind: 'human', user_id: 'alice', expires_at: Date.now() + 60_000 };
    const response = await call({
      method: 'POST',
      path: '/input',
      body: { actions: [{ type: 'click', x: 1, y: 1, button: 'left', count: 1 }] },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(relay.sent.map(sent => opOf(sent).op)).toEqual(['desktop_input', 'desktop_screenshot']);
    expect(relay.sent.map(sent => sent.principal)).toEqual([
      { kind: 'human', user_id: 'alice' },
      { kind: 'human', user_id: 'alice' },
    ]);
  });

  it('never takes a principal from the body', async () => {
    const { call, relay } = setup();
    const response = await call({
      method: 'POST',
      path: '/input',
      body: { actions: [{ type: 'key', keys: 'a' }], principal: { kind: 'human', user_id: 'bob' } },
    });
    expect(response.status).toBe(400);
    expect(relay.sent).toHaveLength(0);
  });

  it('logs only the count and kinds of actions, never typed text or clipboard contents', async () => {
    const { call, relay, lines } = setup();
    relay.control = { kind: 'human', user_id: 'alice', expires_at: Date.now() + 60_000 };
    const input = await call({
      method: 'POST',
      path: '/input',
      body: {
        actions: [
          { type: 'type', text: TYPED_SECRET },
          { type: 'key', keys: 'Return' },
          { type: 'type', text: TYPED_SECRET },
        ],
      },
    });
    expect(input.status).toBe(200);
    expect((await call({ method: 'PUT', path: '/clipboard', body: { text: CLIPBOARD_SECRET } })).status).toBe(204);
    expect((await call({ path: '/clipboard' })).status).toBe(200);

    expect(lines).toContainEqual([
      'info',
      'Desktop input',
      { computer_id: COMPUTER_ID, action_count: 3, action_types: ['type', 'key'] },
    ]);
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain(TYPED_SECRET);
    expect(logged).not.toContain(CLIPBOARD_SECRET);
    expect(logged).not.toContain('Return');
  });
});

describe('the clipboard', () => {
  it('is refused to anyone who does not hold control', async () => {
    const { call } = setup();
    const read = await call({ path: '/clipboard' });
    expect(read.status).toBe(423);
    expect((await errorOf(read)).code).toBe('lease_required');
    const write = await call({ method: 'PUT', path: '/clipboard', body: { text: 'x' } });
    expect(write.status).toBe(423);
  });

  it('is refused while another person controls the desktop', async () => {
    const { call, relay } = setup();
    relay.control = { kind: 'human', user_id: 'bob', expires_at: Date.now() + 60_000 };
    const read = await call({ path: '/clipboard' });
    expect(read.status).toBe(423);
    expect((await errorOf(read)).code).toBe('human_in_control');
  });

  it('reads and sets both selections for the person in control', async () => {
    const { call, relay } = setup();
    relay.control = { kind: 'human', user_id: 'alice', expires_at: Date.now() + 60_000 };
    const read = await call({ path: '/clipboard' });
    expect(read.status).toBe(200);
    expect(read.headers.get('Cache-Control')).toBe('no-store');
    expect(await read.json()).toEqual({ data: { text: CLIPBOARD_SECRET } });
    expect((await call({ method: 'PUT', path: '/clipboard', body: { text: 'pasted' } })).status).toBe(204);
    expect(opOf(relay.sent.at(-1))).toEqual({
      op: 'desktop_clipboard_set',
      text: 'pasted',
      selections: ['clipboard', 'primary'],
    });
  });
});

describe('taking control', () => {
  it('preempts an agent and reports the caller in control', async () => {
    const { call, relay } = setup();
    relay.control = { kind: 'agent', session_id: 'ses_agent' };
    const response = await call({ method: 'POST', path: '/take-control' });
    expect(response.status).toBe(200);
    expect(relay.taken).toEqual([{ tenant_id: TENANT, user_id: 'alice' }]);
    expect(await statusOf(response)).toMatchObject({
      controller: { kind: 'human', user_id: 'alice', is_me: true, expires_at: '2026-09-24T10:05:00.000Z' },
    });
  });

  it('shows another viewer who is in control, not as them', async () => {
    const { call, relay } = setup();
    relay.control = { kind: 'human', user_id: 'alice', expires_at: Date.parse('2026-09-24T10:05:00Z') };
    const response = await call({ user: 'bob' });
    expect(await statusOf(response)).toMatchObject({ controller: { kind: 'human', user_id: 'alice', is_me: false } });
  });

  it('answers 503 for an offline computer and takes nothing', async () => {
    const { call, relay } = setup();
    relay.connected = false;
    const response = await call({ method: 'POST', path: '/take-control' });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('offline');
    expect(relay.taken).toHaveLength(0);
  });

  it('answers 409 clearing when the last person clipboard could not be cleared', async () => {
    const { call, relay } = setup();
    relay.takeOutcome = { ok: false, reason: 'desktop_busy', message: 'still clearing' };
    const response = await call({ method: 'POST', path: '/take-control' });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('clearing');
  });
});

describe('handing back', () => {
  it('releases control and answers the named takeover as completed, once', async () => {
    const { call, relay, takeovers } = setup();
    takeovers.pending = [{ ...PENDING_DESK, agent_id: agents.desk }];
    relay.control = { kind: 'human', user_id: 'alice', expires_at: Date.now() + 60_000 };
    const response = await call({
      method: 'POST',
      path: '/hand-back',
      body: { session_id: 'ses_desk', note: 'Logged in' },
    });
    expect(response.status).toBe(200);
    expect(relay.releasedFor).toEqual([{ tenant_id: TENANT, user_id: 'alice' }]);
    expect(takeovers.resolved).toEqual([
      {
        tenant_id: TENANT,
        computer_id: COMPUTER_ID,
        session_id: 'ses_desk',
        outcome: 'completed',
        note: 'Logged in',
        acting_user_id: 'alice',
      },
    ]);
    expect(await statusOf(response)).toMatchObject({ controller: { kind: 'none' } });
  });

  it('only releases control without a session', async () => {
    const { call, relay, takeovers } = setup();
    relay.control = { kind: 'human', user_id: 'alice', expires_at: Date.now() + 60_000 };
    const response = await call({ method: 'POST', path: '/hand-back', body: {} });
    expect(response.status).toBe(200);
    expect(relay.releasedFor).toHaveLength(1);
    expect(takeovers.resolved).toHaveLength(0);
  });

  it('needs control', async () => {
    const { call, takeovers } = setup();
    takeovers.pending = [{ ...PENDING_DESK, agent_id: agents.desk }];
    const response = await call({ method: 'POST', path: '/hand-back', body: { session_id: 'ses_desk' } });
    expect(response.status).toBe(423);
    expect((await errorOf(response)).code).toBe('lease_required');
    expect(takeovers.resolved).toHaveLength(0);
  });

  it('answers 409 when the takeover was already answered', async () => {
    const { call, relay, takeovers } = setup();
    takeovers.pending = [{ ...PENDING_DESK, agent_id: agents.desk }];
    takeovers.answer = { ok: false, code: 'takeover_already_answered' };
    relay.control = { kind: 'human', user_id: 'alice', expires_at: Date.now() + 60_000 };
    const response = await call({ method: 'POST', path: '/hand-back', body: { session_id: 'ses_desk' } });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('takeover_already_answered');
  });

  it('will not answer a session of another agent', async () => {
    const { call, relay, takeovers } = setup();
    takeovers.pending = [{ ...PENDING_DESK, agent_id: 'agent_other' }];
    relay.control = { kind: 'human', user_id: 'alice', expires_at: Date.now() + 60_000 };
    const response = await call({ method: 'POST', path: '/hand-back', body: { session_id: 'ses_desk' } });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('not_pending');
    expect(takeovers.resolved).toHaveLength(0);
    expect(relay.releasedFor).toHaveLength(0);
  });

  it('answers 503 for a session where takeovers cannot be answered, before releasing', async () => {
    const { call, relay } = setup({ withTakeovers: false });
    relay.control = { kind: 'human', user_id: 'alice', expires_at: Date.now() + 60_000 };
    const response = await call({ method: 'POST', path: '/hand-back', body: { session_id: 'ses_desk' } });
    expect(response.status).toBe(503);
    expect(relay.releasedFor).toHaveLength(0);
  });
});

describe('cancelling a takeover', () => {
  it('works without control and answers the takeover as cancelled', async () => {
    const { call, takeovers } = setup();
    takeovers.pending = [{ ...PENDING_DESK, agent_id: agents.desk }];
    const response = await call({
      method: 'POST',
      path: '/cancel-takeover',
      body: { session_id: 'ses_desk' },
    });
    expect(response.status).toBe(200);
    expect(takeovers.resolved).toEqual([
      {
        tenant_id: TENANT,
        computer_id: COMPUTER_ID,
        session_id: 'ses_desk',
        outcome: 'cancelled',
        note: null,
        acting_user_id: 'alice',
      },
    ]);
  });

  it('releases the caller control when they hold it', async () => {
    const { call, relay, takeovers } = setup();
    takeovers.pending = [{ ...PENDING_DESK, agent_id: agents.desk }];
    relay.control = { kind: 'human', user_id: 'alice', expires_at: Date.now() + 60_000 };
    const response = await call({ method: 'POST', path: '/cancel-takeover', body: { session_id: 'ses_desk' } });
    expect(response.status).toBe(200);
    expect(await statusOf(response)).toMatchObject({ controller: { kind: 'none' } });
  });

  it('answers 409 when the takeover was already answered', async () => {
    const { call, takeovers } = setup();
    takeovers.pending = [{ ...PENDING_DESK, agent_id: agents.desk }];
    takeovers.answer = { ok: false, code: 'takeover_already_answered' };
    const response = await call({ method: 'POST', path: '/cancel-takeover', body: { session_id: 'ses_desk' } });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('takeover_already_answered');
  });
});
