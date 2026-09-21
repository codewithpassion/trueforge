import type { CallerSpec } from './CallerDO';
import type { SpikeEnv } from './env';

export { CallerDO } from './CallerDO';
export { RemoteComputerDO } from './RemoteComputerDO';

function constantTimeEquals(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(left, right);
}

function readString(body: Record<string, unknown>, key: string, fallback: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : fallback;
}

function readNumber(body: Record<string, unknown>, key: string, fallback: number): number {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    out[key] = value;
  }
  return out;
}

function specFromBody(body: Record<string, unknown>): CallerSpec {
  const kind = readString(body, 'kind', 'single');
  return {
    kind: kind === 'exec_series' || kind === 'concurrent' || kind === 'roundtrip' ? kind : 'single',
    computer_id: readString(body, 'computer_id', 'spike'),
    command: readString(body, 'command', 'uname -a'),
    timeout_ms: readNumber(body, 'timeout_ms', 30_000),
    count: readNumber(body, 'count', 1),
    size_bytes: readNumber(body, 'size_bytes', 5 * 1024 * 1024),
    chunk_bytes: readNumber(body, 'chunk_bytes', 256 * 1024),
    remote_path: readString(body, 'remote_path', '/tmp/trueforge-spike/payload.bin'),
  };
}

function relayFor({ env, computerId }: { env: SpikeEnv; computerId: string }) {
  return env.REMOTE_COMPUTER_DO.get(env.REMOTE_COMPUTER_DO.idFromName(computerId));
}

/** The client dials here; everything else is a secret-guarded test route. */
async function handleConnect({ request, env }: { request: Request; env: SpikeEnv }): Promise<Response> {
  const url = new URL(request.url);
  const computerId = url.searchParams.get('computer_id');
  const presented = request.headers.get('Authorization')?.replace(/^Bearer /i, '') ?? '';
  if (computerId === null || !constantTimeEquals(presented, env.SPIKE_CLIENT_TOKEN)) {
    return new Response('Unauthorized', { status: 401 });
  }
  return relayFor({ env, computerId }).fetch(request);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      return handleConnect({ request, env });
    }
    if (!url.pathname.startsWith('/t/')) {
      return new Response('Not found', { status: 404 });
    }
    const presented = request.headers.get('x-spike-secret') ?? '';
    if (!constantTimeEquals(presented, env.SPIKE_SECRET)) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (url.pathname === '/t/status') {
      const computerId = url.searchParams.get('computer_id') ?? 'spike';
      return Response.json(await relayFor({ env, computerId }).status());
    }

    const body = await readJsonBody(request);
    const computerId = readString(body, 'computer_id', url.searchParams.get('computer_id') ?? 'spike');

    switch (url.pathname) {
      // Calls the relay straight from the Worker, so the alarm-held caller's overhead can be compared.
      case '/t/exec': {
        const startedAt = Date.now();
        const outcome = await relayFor({ env, computerId }).request({
          op_json: JSON.stringify({
            op: 'exec',
            command: readString(body, 'command', 'uname -a'),
            cwd: readString(body, 'cwd', '') === '' ? null : readString(body, 'cwd', ''),
            env: {},
            timeout_ms: readNumber(body, 'timeout_ms', 30_000),
          }),
          timeout_ms: readNumber(body, 'timeout_ms', 30_000),
        });
        return Response.json({ wall_ms: Date.now() - startedAt, outcome });
      }
      case '/t/probe': {
        const downBytes = readNumber(body, 'down_bytes', 1024);
        const upBytes = readNumber(body, 'up_bytes', 1024);
        const startedAt = Date.now();
        const outcome = await relayFor({ env, computerId }).request({
          op_json: JSON.stringify({
            op: 'probe',
            payload_b64: btoa('x'.repeat(downBytes)),
            echo_bytes: upBytes,
          }),
          timeout_ms: readNumber(body, 'timeout_ms', 30_000),
        });
        // The echoed payload is large; report only its size so the response stays readable.
        return Response.json({
          wall_ms: Date.now() - startedAt,
          down_bytes: downBytes,
          up_bytes: upBytes,
          ok: outcome.ok,
          detail: outcome.ok ? outcome.result_json.length : `${outcome.reason}: ${outcome.message}`,
        });
      }
      case '/t/revoke':
        return Response.json(await relayFor({ env, computerId }).revoke());
      case '/t/unrevoke': {
        await relayFor({ env, computerId }).unrevoke();
        return Response.json({ ok: true });
      }
      case '/t/run': {
        const runId = readString(body, 'run_id', crypto.randomUUID());
        await env.CALLER_DO.get(env.CALLER_DO.idFromName(runId)).startRun(specFromBody(body));
        return Response.json({ run_id: runId });
      }
      case '/t/result': {
        const runId = readString(body, 'run_id', url.searchParams.get('run_id') ?? '');
        if (runId === '') {
          return Response.json({ error: 'run_id is required' }, { status: 400 });
        }
        const raw = await env.CALLER_DO.get(env.CALLER_DO.idFromName(runId)).readRun();
        return new Response(raw, { headers: { 'content-type': 'application/json' } });
      }
      default:
        return new Response('Not found', { status: 404 });
    }
  },
} satisfies ExportedHandler<SpikeEnv>;
