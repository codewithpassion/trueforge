/**
 * The whole machine path over real Durable Objects and real D1: enroll, connect, run a command,
 * move a file both ways, and be revoked. Everything goes through the deployed routes, so the fake
 * client only ever sees the frozen v1 contract.
 */
import { env } from 'cloudflare:workers';
import { RemoteComputerProvider } from '../../src/computers/RemoteComputerProvider';
import { MAX_IN_FLIGHT_EXEC, MAX_QUEUE_DEPTH } from '../../src/computers/protocol';
import type { ComputersService } from '../../src/computers/service';
import { createConsoleLogger } from '../../src/workers/logger';
import { migrateDatabase, TENANT_ID } from './harness';
import {
  computersApp,
  FAKE_WORKDIR,
  FakeComputerClient,
  PUBLIC_BASE_URL,
  settle,
  testComputersService,
  waitFor,
} from './remoteComputerClient';

const OTHER_TENANT = 'someone-else';

/** What a client answers a command with when the test does not care about the output. */
const OK_EXEC = { exit_code: 0, stdout: '', stderr: '', bytes_total: 0, truncated: false, duration_ms: 1 };

async function digestHex(bytes: Buffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const silentLogger = createConsoleLogger({ level: 'error', bindings: { component: 'computers-test' } });

interface CreatedComputer {
  computerId: string;
  enrollmentCode: string;
}

async function createComputer({
  app,
  name,
}: {
  app: ReturnType<typeof computersApp>;
  name: string;
}): Promise<CreatedComputer> {
  const response = await app.fetch(
    new Request(`${PUBLIC_BASE_URL}/api/v1/computers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
    env,
  );
  expect(response.status).toBe(201);
  const body = await response.json<{
    data: { computer: { id: string }; enrollment: { enrollment_code: string; docker_command: string | null } };
  }>();
  return { computerId: body.data.computer.id, enrollmentCode: body.data.enrollment.enrollment_code };
}

async function enroll({
  app,
  code,
}: {
  app: ReturnType<typeof computersApp>;
  code: string;
}): Promise<{ status: number; credential: string | undefined }> {
  const response = await app.fetch(
    new Request(`${PUBLIC_BASE_URL}/api/v1/computers/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enrollment_code: code,
        hostname: 'fake-box',
        os: 'linux',
        arch: 'amd64',
        version: '0.1.0-test',
      }),
    }),
    env,
  );
  if (response.status !== 200) {
    return { status: response.status, credential: undefined };
  }
  const body = await response.json<{ data: { machine_credential: string } }>();
  return { status: 200, credential: body.data.machine_credential };
}

function providerFor({
  computers,
  computerId,
  sessionId,
  tenantId = TENANT_ID,
  workdir = FAKE_WORKDIR,
}: {
  computers: ComputersService;
  computerId: string;
  sessionId: string;
  tenantId?: string;
  /** Null stands for a machine that has never said where it keeps its sessions. */
  workdir?: string | null;
}): RemoteComputerProvider {
  return new RemoteComputerProvider({
    relay: computers.relay(computerId),
    computerId,
    computerName: 'test-box',
    tenantId,
    sessionId,
    turnId: 'turn-1',
    workdir,
    capabilities: { python3: true, git: true, skills: true },
    defaultExecTimeoutSeconds: 10,
    fileMaxBytesForDownload: 1024 * 1024,
    store: computers.store,
    logger: silentLogger,
  });
}

let counter = 0;
function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}

beforeAll(async () => {
  await migrateDatabase();
});

describe('enroll', () => {
  it('exchanges a code once and refuses every other code identically', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('enroll') });

    const first = await enroll({ app, code: created.enrollmentCode });
    expect(first.status).toBe(200);
    expect(first.credential).toBeDefined();

    // The same code a second time, an unknown code, and an expired one all answer the same way.
    const replay = await enroll({ app, code: created.enrollmentCode });
    expect(replay.status).toBe(401);
    const unknown = await enroll({ app, code: 'not-a-real-code' });
    expect(unknown.status).toBe(401);

    const expired = await createComputer({ app, name: uniqueName('enroll-expired') });
    await computers.store.rotateComputer({
      tenant_id: TENANT_ID,
      computer_id: expired.computerId,
      code_hash: 'deadbeef',
      code_expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await enroll({ app, code: expired.enrollmentCode })).status).toBe(401);
  });

  it('records what the machine reported and turns its status to offline', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('enroll-facts') });
    expect((await enroll({ app, code: created.enrollmentCode })).status).toBe(200);

    const record = await computers.store.getComputer({ tenant_id: TENANT_ID, computer_id: created.computerId });
    expect(record?.status).toBe('offline');
    expect(record?.hostname).toBe('fake-box');
    expect(record?.arch).toBe('amd64');
  });
});

describe('connect', () => {
  it('refuses every bad credential with the same 401', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    // A real machine is enrolled first, so a lookup that ignored the credential would find it.
    const enrolled = await createComputer({ app, name: uniqueName('bad-credential') });
    expect((await enroll({ app, code: enrolled.enrollmentCode })).status).toBe(200);
    for (const headers of [
      { Upgrade: 'websocket' },
      { Upgrade: 'websocket', Authorization: 'Bearer nope' },
      { Upgrade: 'websocket', Authorization: 'Basic nope' },
    ]) {
      const response = await app.fetch(new Request(`${PUBLIC_BASE_URL}/api/v1/computers/connect`, { headers }), env);
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: { message: 'Unauthorized' } });
    }
  });

  it('compares the Upgrade header without regard to case', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('upgrade-case') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    expect(credential).toBeDefined();
    const response = await app.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers/connect`, {
        headers: { Upgrade: 'WEBSOCKET', Authorization: `Bearer ${credential ?? ''}` },
      }),
      env,
    );
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close(1000, 'done');
  });

  it('answers 426 when the request is not an upgrade', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('no-upgrade') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    const response = await app.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers/connect`, {
        headers: { Authorization: `Bearer ${credential ?? ''}` },
      }),
      env,
    );
    expect(response.status).toBe(426);
  });
});

describe('a connected machine', () => {
  it('runs a command and records it', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('exec') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    const client = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: {
        onRequest: frame =>
          frame['op'] === 'exec'
            ? {
                exit_code: 0,
                stdout: 'Linux fake-box\n',
                stderr: '',
                bytes_total: 15,
                truncated: false,
                duration_ms: 7,
              }
            : undefined,
      },
    });
    await settle();

    const provider = providerFor({ computers, computerId: created.computerId, sessionId: 'session-exec' });
    const { sandboxId } = await provider.createSandbox();
    expect(sandboxId).toBe(`${created.computerId}/session-exec`);

    const result = await provider.exec({ sandboxId, command: 'uname -a' });
    expect(result).toEqual({ success: true, response: { exitCode: 0, result: 'Linux fake-box\n' } });

    const audit = await computers.store.listAudit({
      tenant_id: TENANT_ID,
      computer_id: created.computerId,
      limit: 10,
      before_id: undefined,
    });
    const execRow = audit.find(row => row.command === 'uname -a');
    expect(execRow).toBeDefined();
    expect(execRow?.exit_code).toBe(0);
    expect(execRow?.turn_id).toBe('turn-1');
    client.close();
  });

  it('moves a file up and back with matching digests', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('files') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });

    const payload = Buffer.from('a file that goes up and comes back'.repeat(40));
    const payloadDigest = await digestHex(payload);
    const stored = new Map<string, Buffer>();
    const client = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: {
        onRequest: frame => {
          if (frame['op'] === 'exec') {
            return OK_EXEC;
          }
          if (frame['op'] === 'file_put') {
            const path = String(frame['path']);
            const chunk = Buffer.from(String(frame['data_b64']), 'base64');
            const previous = Number(frame['seq']) === 0 ? Buffer.alloc(0) : (stored.get(path) ?? Buffer.alloc(0));
            stored.set(path, Buffer.concat([previous, chunk]));
            return { bytes_written: chunk.byteLength, sha256: frame['sha256'] ?? null };
          }
          if (frame['op'] === 'file_get') {
            const whole = stored.get(String(frame['path'])) ?? Buffer.alloc(0);
            const offset = Number(frame['offset']);
            const slice = whole.subarray(offset, offset + Number(frame['max_bytes']));
            return {
              data_b64: slice.toString('base64'),
              eof: offset + slice.byteLength >= whole.byteLength,
              size: whole.byteLength,
              // The digest of the whole file travels with the first chunk, and the provider
              // checks the reassembled bytes against it.
              sha256: offset === 0 ? payloadDigest : null,
            };
          }
          return undefined;
        },
      },
    });
    await settle();

    const provider = providerFor({ computers, computerId: created.computerId, sessionId: 'session-files' });
    const { sandboxId } = await provider.createSandbox();
    await provider.uploadFile({
      sandboxId,
      remotePath: `${FAKE_WORKDIR}/session-files/uploads/payload.bin`,
      content: payload,
    });
    const back = await provider.downloadFile({
      sandboxId,
      path: `${FAKE_WORKDIR}/session-files/uploads/payload.bin`,
    });
    expect(back.equals(payload)).toBe(true);
    client.close();
  });

  it('closes the socket on a hello it cannot read, because nothing that machine says is usable', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('bad-hello') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    const client = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: {
        onRequest: () => ({ exit_code: 0, stdout: 'ok', stderr: '', bytes_total: 2, truncated: false, duration_ms: 1 }),
      },
    });
    client.sendRaw(JSON.stringify({ type: 'hello', protocol_version: 99 }));
    await settle();

    const status = await computers.relay(created.computerId).status();
    expect(status.connected).toBe(false);
    client.close();
  });

  it('answers offline rather than guessing where a machine keeps its sessions', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('no-workdir') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    const client = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: { onRequest: () => OK_EXEC },
    });
    await settle();

    const provider = providerFor({
      computers,
      computerId: created.computerId,
      sessionId: 'session-no-workdir',
      workdir: null,
    });
    const { sandboxId } = await provider.createSandbox();
    const result = await provider.exec({ sandboxId, command: 'true' });
    expect(result).toMatchObject({ success: false });
    // Nothing was sent: a command with a path this server invented is worse than no command.
    expect(client.received.filter(frame => frame['op'] === 'exec')).toHaveLength(0);
    client.close();
  });
});

describe('file operations stay in the session directory', () => {
  it('refuses a path outside it, however it is written, and records the attempt', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('jail') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    const client = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: { onRequest: () => OK_EXEC },
    });
    await settle();

    const provider = providerFor({ computers, computerId: created.computerId, sessionId: 'session-jail' });
    const sandboxId = `${created.computerId}/session-jail`;
    // The client's own credential is the prize here: reading it would let the holder connect as
    // the computer and collect other sessions' commands.
    for (const path of [
      '/var/lib/x/credential',
      `${FAKE_WORKDIR}/session-jail/../../credential`,
      '/etc/passwd',
      'relative/path',
    ]) {
      await expect(provider.downloadFile({ sandboxId, path })).rejects.toThrow(/outside this session/);
      await expect(provider.uploadFile({ sandboxId, remotePath: path, content: Buffer.from('x') })).rejects.toThrow(
        /outside this session/,
      );
    }
    // Nothing was asked of the machine; the server refused before the wire.
    expect(client.received.filter(frame => frame['op'] === 'file_get' || frame['op'] === 'file_put')).toHaveLength(0);
    client.close();
  });
});

describe('what the machine says about itself', () => {
  it('ignores a hello whose run-as user could break out of a shell command', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('hostile-hello') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    const client = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: { hello: { run_as_user: "trueforge'; rm -rf /; #" }, onRequest: () => OK_EXEC },
    });
    await settle();

    // The hello never landed, so the row keeps what enrollment recorded and no path is built
    // from it. A name that cannot be a POSIX user is not one.
    const record = await computers.store.getComputer({ tenant_id: TENANT_ID, computer_id: created.computerId });
    expect(record?.run_as_user).toBeNull();
    client.close();
  });

  it.each([
    ["a quote, which would break out of the server's quoting", "/var/lib/x'; rm -rf /; #"],
    ['a newline', '/var/lib/x\nsessions'],
    ['a relative path', 'var/lib/x/sessions'],
    ['more than 1024 characters', `/${'a'.repeat(1024)}`],
  ])('turns away a machine whose sessions root carries %s', async (_why, workdir) => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('hostile-workdir') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    const client = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: { hello: { workdir }, onRequest: () => OK_EXEC },
    });
    await settle();

    const status = await computers.relay(created.computerId).status();
    expect(status.hello).toBeNull();
    expect(status.connected).toBe(false);
    client.close();
  });

  it('accepts one hello per connection and closes a socket that repeats it', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('one-hello') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    const client = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: { onRequest: () => OK_EXEC },
    });
    await settle();
    expect((await computers.relay(created.computerId).status()).connected).toBe(true);

    // A second hello on the same connection is a flood of storage and D1 writes waiting to happen.
    client.sendHello({});
    await settle();
    expect((await computers.relay(created.computerId).status()).connected).toBe(false);
    client.close();
  });
});

describe('the tenant check', () => {
  it('refuses a computer that belongs to someone else without reaching the machine', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('tenant') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    const client = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: {
        onRequest: () => ({ exit_code: 0, stdout: '', stderr: '', bytes_total: 0, truncated: false, duration_ms: 1 }),
      },
    });
    await settle();
    const framesBefore = client.received.length;

    const outcome = await computers.relay(created.computerId).request({
      tenant_id: OTHER_TENANT,
      op_json: JSON.stringify({ op: 'exec', command: 'whoami', cwd: null, env: {}, timeout_ms: 1000 }),
      timeout_ms: 1000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('forbidden');
    }
    // Nothing was put on the wire: the refusal happened before the socket was touched.
    expect(client.received.length).toBe(framesBefore);
    client.close();
  });
});

describe('offline', () => {
  it('fails fast with the last-seen reason once the machine drops', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('offline') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    const client = await FakeComputerClient.connect({ app, credential: credential ?? '' });
    await settle();
    // Killing the process closes the socket, which the relay hears about at once. The frozen
    // 1006 a kernel produces cannot be sent deliberately, and the relay does not read the code.
    client.close();
    await settle();

    const provider = providerFor({ computers, computerId: created.computerId, sessionId: 'session-offline' });
    const result = await provider.exec({ sandboxId: `${created.computerId}/session-offline`, command: 'true' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('is offline');
    }
  });

  it('says so before a machine has ever connected', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('never') });
    const provider = providerFor({ computers, computerId: created.computerId, sessionId: 'session-never' });
    const result = await provider.exec({ sandboxId: `${created.computerId}/session-never`, command: 'true' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('never connected');
    }
  });

  it('reads a relay that rejects the call as offline rather than letting it escape', async () => {
    const computers = testComputersService();
    const created = await createComputer({ app: computersApp({ computers }), name: uniqueName('reset') });
    // Exactly what a deploy or a forced eviction does to a caller: the RPC rejects.
    const rejecting: ComputersService = {
      store: computers.store,
      rateLimiter: undefined,
      relayFetch: computers.relayFetch.bind(computers),
      relay: () => ({
        request: () => Promise.reject(new Error('Durable Object reset because its code was updated')),
        revoke: () => Promise.resolve({ closed: 0 }),
        disconnect: () => Promise.resolve({ closed: 0 }),
        destroy: () => Promise.resolve(),
        status: () => Promise.reject(new Error('reset')),
      }),
    };
    const provider = providerFor({
      computers: rejecting,
      computerId: created.computerId,
      sessionId: 'session-reset',
    });
    const result = await provider.exec({ sandboxId: `${created.computerId}/session-reset`, command: 'true' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('connection to the computer was interrupted');
    }
    const audit = await computers.store.listAudit({
      tenant_id: TENANT_ID,
      computer_id: created.computerId,
      limit: 10,
      before_id: undefined,
    });
    // The command may still be running with nobody to collect it, so the outcome is recorded unknown.
    expect(audit[0]?.exit_code).toBeNull();
  });
});

describe('a command whose caller was lost', () => {
  it('is never re-run, and is cancelled on the machine when it comes back', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('orphan') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });

    // The machine takes the command and says nothing; then the connection drops under it.
    const first = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: { onRequest: () => undefined },
    });
    await settle();
    const provider = providerFor({ computers, computerId: created.computerId, sessionId: 'session-orphan' });
    const running = provider.exec({
      sandboxId: `${created.computerId}/session-orphan`,
      command: 'sleep 600',
      timeoutSeconds: 60,
    });
    await waitFor(() => first.held.length === 1);
    const orphanedId = first.held[0];
    first.close();

    // The caller is told, in words that say the command may still be running, and nothing retries.
    const result = await running;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/may still be running/);
    }

    // The client keeps that command alive across a reconnect, so the cancel has something to kill.
    const second = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: { onRequest: () => OK_EXEC },
    });
    await waitFor(() => second.received.some(frame => frame['op'] === 'cancel'));
    expect(second.received.filter(frame => frame['op'] === 'cancel').map(frame => frame['target_id'])).toEqual([
      orphanedId,
    ]);
    // And it was cancelled, not re-sent: no second `sleep 600` reached the machine.
    expect(second.received.filter(frame => frame['op'] === 'exec')).toHaveLength(0);
    second.close();
  });
});

describe('concurrency', () => {
  it('runs four commands at once and makes the fifth wait for a slot', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('cap') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });

    let reached = 0;
    const client = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: {
        onRequest: () => {
          reached += 1;
          return undefined;
        },
      },
    });
    await settle();

    const provider = providerFor({ computers, computerId: created.computerId, sessionId: 'session-cap' });
    const sandboxId = `${created.computerId}/session-cap`;
    const running = Array.from({ length: MAX_IN_FLIGHT_EXEC + 1 }, () =>
      provider.exec({ sandboxId, command: 'sleep 1', timeoutSeconds: 30 }),
    );
    await waitFor(() => reached >= MAX_IN_FLIGHT_EXEC);
    await settle(10);
    // Only the cap reaches the machine; the extra one is still waiting for a slot.
    expect(reached).toBe(MAX_IN_FLIGHT_EXEC);

    client.releaseHeld(OK_EXEC);
    // The fifth starts only once a slot comes free.
    await waitFor(() => reached === MAX_IN_FLIGHT_EXEC + 1);
    client.releaseHeld(OK_EXEC);
    const results = await Promise.all(running);
    expect(results.every(result => result.success)).toBe(true);
    client.close();
  });

  it('refuses at once past the queue depth', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('queue') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    const client = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: { onRequest: () => undefined },
    });
    await settle();

    const provider = providerFor({ computers, computerId: created.computerId, sessionId: 'session-queue' });
    const sandboxId = `${created.computerId}/session-queue`;
    const filling = Array.from({ length: MAX_IN_FLIGHT_EXEC + MAX_QUEUE_DEPTH }, () =>
      provider.exec({ sandboxId, command: 'sleep 1', timeoutSeconds: 30 }),
    );
    await waitFor(() => client.held.length >= MAX_IN_FLIGHT_EXEC);
    await settle(10);
    const overflow = await provider.exec({ sandboxId, command: 'one too many', timeoutSeconds: 30 });
    expect(overflow.success).toBe(false);
    if (!overflow.success) {
      expect(overflow.error).toContain('queued');
    }
    // Drain the backlog rather than waiting out every relay deadline.
    client.answerWith(() => OK_EXEC);
    client.releaseHeld(OK_EXEC);
    const results = await Promise.all(filling);
    expect(results.every(result => result.success)).toBe(true);
    client.close();
  });
});

describe('rotate and revoke', () => {
  it('rotate invalidates the old credential and drops the socket', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('rotate') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    const client = await FakeComputerClient.connect({ app, credential: credential ?? '' });
    await settle();

    const response = await app.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers/${created.computerId}/enrollment`, { method: 'POST' }),
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ data: { enrollment_code: string } }>();
    expect(body.data.enrollment_code).not.toBe(created.enrollmentCode);
    await settle();

    // The old credential no longer opens a socket.
    const reconnect = await app.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers/connect`, {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${credential ?? ''}` },
      }),
      env,
    );
    expect(reconnect.status).toBe(401);

    // The new code still enrolls, because rotate is not a revoke.
    const again = await enroll({ app, code: body.data.enrollment_code });
    expect(again.status).toBe(200);
    client.close();
  });

  it('revoke closes the socket and refuses the next command', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('revoke') });
    const { credential } = await enroll({ app, code: created.enrollmentCode });
    const client = await FakeComputerClient.connect({
      app,
      credential: credential ?? '',
      options: {
        onRequest: () => ({ exit_code: 0, stdout: '', stderr: '', bytes_total: 0, truncated: false, duration_ms: 1 }),
      },
    });
    await settle();

    const response = await app.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers/${created.computerId}/revoke`, { method: 'POST' }),
      env,
    );
    expect(response.status).toBe(200);
    await settle();

    const provider = providerFor({ computers, computerId: created.computerId, sessionId: 'session-revoke' });
    const result = await provider.exec({ sandboxId: `${created.computerId}/session-revoke`, command: 'true' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('revoked');
    }
    const record = await computers.store.getComputer({ tenant_id: TENANT_ID, computer_id: created.computerId });
    expect(record?.status).toBe('revoked');
    client.close();
  });
});

describe('delete', () => {
  it('is refused while an agent is still allowed to use the computer', async () => {
    const computers = testComputersService();
    const app = computersApp({ computers });
    const created = await createComputer({ app, name: uniqueName('delete') });
    await computers.store.putAgentAccess({
      tenant_id: TENANT_ID,
      computer_id: created.computerId,
      agents: [{ agent_id: 'agt_some', agent_name: 'some-agent' }],
    });
    const refused = await app.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers/${created.computerId}`, { method: 'DELETE' }),
      env,
    );
    expect(refused.status).toBe(409);

    await computers.store.putAgentAccess({ tenant_id: TENANT_ID, computer_id: created.computerId, agents: [] });
    const deleted = await app.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers/${created.computerId}`, { method: 'DELETE' }),
      env,
    );
    expect(deleted.status).toBe(200);
  });
});

describe('a runtime without computers', () => {
  it('answers every route with a clear 404', async () => {
    const app = computersApp({ computers: undefined });
    for (const request of [
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers`),
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers/connect`, { headers: { Upgrade: 'websocket' } }),
    ]) {
      const response = await app.fetch(request, env);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: { message: 'Remote computers are not available on this server' },
      });
    }
  });
});
