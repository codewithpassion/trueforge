import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { CODE_MODE_BRIDGE_URL } from '../../src/workers/sandbox/codeModeBridge';
import { CODE_MODE_REQUEST_MAX_BYTES } from '../../src/workers/sandbox/sandboxEgressGateway';

/**
 * The gateway is reached the way the container backend reaches it: from inside `ComputerDO`, through
 * `ctx.exports`. Miniflare's outbound service answers every subrequest with the URL it was given, so
 * the reply is a readback of what the gateway forwarded.
 */
function inComputerDO<R>(name: string, callback: (state: DurableObjectState) => R | Promise<R>): Promise<R> {
  const stub = env.COMPUTER_DO.get(env.COMPUTER_DO.idFromName(name));
  return runInDurableObject(stub, (_instance, state) => callback(state));
}

describe('SandboxEgressGateway', () => {
  it('passes a container request through with its original host and path', async () => {
    const forwarded = await inComputerDO('tenant-1:egress-passthrough', async state => {
      const response = await state.exports.SandboxEgressGateway.fetch(
        new Request('https://skills.example.test/anthropics/skills/info?ref=main'),
      );
      return { status: response.status, body: await response.text() };
    });

    // 599 is the mock outbound service saying "not a model call", and it echoes the URL it received.
    expect(forwarded.status).toBe(599);
    expect(forwarded.body).toContain('https://skills.example.test/anthropics/skills/info?ref=main');
  });

  it('keeps the method and the body of a request it forwards', async () => {
    const forwarded = await inComputerDO('tenant-1:egress-method', async state => {
      const response = await state.exports.SandboxEgressGateway.fetch(
        new Request('http://plain.example.test/upload', { method: 'POST', body: 'payload' }),
      );
      return { status: response.status, body: await response.text() };
    });

    expect(forwarded.status).toBe(599);
    expect(forwarded.body).toContain('POST http://plain.example.test/upload');
  });

  it('routes a model call through unchanged, which is what an ordinary HTTPS egress looks like', async () => {
    const answered = await inComputerDO('tenant-1:egress-https', async state => {
      const response = await state.exports.SandboxEgressGateway.fetch(
        new Request('https://llm.test/text/v1/chat/completions', { method: 'POST', body: '{}' }),
      );
      return { status: response.status, body: await response.text() };
    });

    expect(answered.status).toBe(200);
    expect(answered.body).toContain('Hello from the mock model.');
  });
});

describe('the workspace Durable Object identity the gateway routes on', () => {
  it('carries the tenant:session name it was addressed by', async () => {
    const name = await inComputerDO('tenant-7:session-42', state => state.id.name);
    expect(name).toBe('tenant-7:session-42');
  });

  it('carries the same name when a cold object is woken by its id string instead', async () => {
    const namespace = env.COMPUTER_DO;
    const named = namespace.get(namespace.idFromName('tenant-7:session-43'));
    const idString = await runInDurableObject(named, (_instance, state) => state.id.toString());
    // Evicted first, so the name cannot be left over from the activation that was addressed by name.
    await evictDurableObject(named);

    const reached = await runInDurableObject(
      namespace.get(namespace.idFromString(idString)),
      (_instance, state) => state.id.name,
    );
    // `WorkspaceProxy` wakes this object by id string, so routing must not depend on how it woke.
    expect(reached).toBe('tenant-7:session-43');
  });
});

describe('the Code Mode hostname', () => {
  function gateway(state: DurableObjectState, sessionDurableObjectName: string | undefined) {
    return state.exports.SandboxEgressGateway({ props: { sessionDurableObjectName } });
  }

  function dispatchRequest(init?: RequestInit): Request {
    return new Request(CODE_MODE_BRIDGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'list_tools', server: 'demo' }),
      ...init,
    });
  }

  it('never leaves the machine, even with no token on it', async () => {
    const answered = await inComputerDO('tenant-1:code-mode-anon', async state => {
      const response = await gateway(state, 'tenant-1:code-mode-anon').fetch(dispatchRequest());
      return { status: response.status, body: await response.text() };
    });

    // 599 would mean it reached the outbound service, which stands in for the internet here.
    expect(answered.status).toBe(401);
    expect(answered.body).toContain('bearer token');
  });

  it('refuses a token no turn of that session opened', async () => {
    const answered = await inComputerDO('tenant-1:code-mode-token', async state => {
      const response = await gateway(state, 'tenant-1:code-mode-token').fetch(
        dispatchRequest({ headers: { authorization: 'Bearer not-a-real-token' } }),
      );
      return { status: response.status, body: await response.text() };
    });

    expect(answered.status).toBe(401);
    expect(answered.body).toContain('not open for this session');
  });

  it('refuses a body over the cap by its declared length, before reading it', async () => {
    const status = await inComputerDO('tenant-1:code-mode-declared', async state => {
      const response = await gateway(state, 'tenant-1:code-mode-declared').fetch(
        dispatchRequest({
          headers: {
            authorization: 'Bearer anything',
            'content-length': String(CODE_MODE_REQUEST_MAX_BYTES + 1),
          },
          body: 'x',
        }),
      );
      return response.status;
    });

    expect(status).toBe(413);
  });

  it('refuses a streamed body once it passes the cap, whatever length it declared', async () => {
    const status = await inComputerDO('tenant-1:code-mode-streamed', async state => {
      const chunk = new Uint8Array(256 * 1024);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > CODE_MODE_REQUEST_MAX_BYTES) {
            controller.close();
            return;
          }
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      const response = await gateway(state, 'tenant-1:code-mode-streamed').fetch(
        new Request(CODE_MODE_BRIDGE_URL, {
          method: 'POST',
          headers: { authorization: 'Bearer anything' },
          body,
          duplex: 'half',
        }),
      );
      return response.status;
    });

    expect(status).toBe(413);
  });

  it('refuses anything but a POST', async () => {
    const status = await inComputerDO('tenant-1:code-mode-get', async state => {
      const response = await gateway(state, 'tenant-1:code-mode-get').fetch(new Request(CODE_MODE_BRIDGE_URL));
      return response.status;
    });

    expect(status).toBe(405);
  });

  it('answers for the session its workspace is named after, whatever the request claims', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const status = await inComputerDO('tenant-a:session-1', async state => {
        const named = new Request(`http://${new URL(CODE_MODE_BRIDGE_URL).host}/dispatch/tenant-b:session-2`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer a-token-of-another-session',
            'x-session-id': 'tenant-b:session-2',
            'x-tenant-id': 'tenant-b',
          },
          body: JSON.stringify({ op: 'list_tools', server: 'demo', session_id: 'tenant-b:session-2' }),
        });
        const response = await gateway(state, 'tenant-a:session-1').fetch(named);
        return response.status;
      });

      expect(status).toBe(401);
      const refusals = warned.mock.calls.map(([line]) => String(line)).filter(line => line.includes('Refused'));
      expect(refusals).not.toHaveLength(0);
      for (const line of refusals) {
        expect(line).toContain('tenant-a:session-1');
        expect(line).not.toContain('tenant-b');
      }
    } finally {
      warned.mockRestore();
    }
  });

  it('refuses outright when the workspace cannot name its session', async () => {
    const status = await inComputerDO('tenant-1:code-mode-nameless', async state => {
      const response = await gateway(state, undefined).fetch(
        dispatchRequest({ headers: { authorization: 'Bearer anything' } }),
      );
      return response.status;
    });

    expect(status).toBe(503);
  });
});
