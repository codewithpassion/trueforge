import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

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
