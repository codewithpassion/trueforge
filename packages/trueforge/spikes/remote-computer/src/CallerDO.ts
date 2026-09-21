import { DurableObject } from 'cloudflare:workers';

import type { SpikeEnv } from './env';
import { parseFileGetResult, parseFilePutResult, type RequestOutcome } from './protocol';
import type { RemoteComputerDO } from './RemoteComputerDO';

/** 256 KiB of payload per frame, which base64 widens to about 341 KiB on the wire. */
const CHUNK_BYTES = 256 * 1024;

export interface CallerSpec {
  readonly kind: 'exec_series' | 'concurrent' | 'roundtrip' | 'single';
  readonly computer_id: string;
  readonly command: string;
  readonly timeout_ms: number;
  readonly count: number;
  /** `roundtrip` only: payload size and the remote path to write. */
  readonly size_bytes: number;
  readonly chunk_bytes: number;
  readonly remote_path: string;
}

interface StepRecord {
  readonly label: string;
  readonly ms: number;
  readonly ok: boolean;
  readonly detail: string;
}

interface RunRecord {
  readonly state: 'started' | 'done';
  readonly spec: CallerSpec;
  readonly started_at: number;
  readonly finished_at: number | null;
  /** Counts alarm entries so a Durable Object reset that replays the alarm is visible in the result. */
  readonly alarm_entries: number;
  readonly steps: readonly StepRecord[];
  readonly summary: Record<string, number | string | boolean>;
  readonly error: string | null;
}

function describe(outcome: RequestOutcome): string {
  return outcome.ok ? outcome.result_json.slice(0, 400) : `${outcome.reason}: ${outcome.message}`;
}

/** Deterministic bytes, so the same run can be reproduced and hashed on both sides. */
function pseudoRandomBytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = (state >>> 24) & 0xff;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Stands in for `SessionDO`: it runs the measurement inside `alarm()` and calls the relay over RPC from
 * there, which is exactly how a turn reaches a computer.
 */
export class CallerDO extends DurableObject<SpikeEnv> {
  /** Stores the spec and arms an immediate alarm; the work itself never runs in this invocation. */
  async startRun(spec: CallerSpec): Promise<void> {
    const run: RunRecord = {
      state: 'started',
      spec,
      started_at: Date.now(),
      finished_at: null,
      alarm_entries: 0,
      steps: [],
      summary: {},
      error: null,
    };
    await this.ctx.storage.put('run', run);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async readRun(): Promise<string> {
    const run = await this.ctx.storage.get<RunRecord>('run');
    return JSON.stringify(run ?? null);
  }

  override async alarm(): Promise<void> {
    const run = await this.ctx.storage.get<RunRecord>('run');
    if (run === undefined || run.state === 'done') {
      return;
    }
    const entries = run.alarm_entries + 1;
    if (entries > 1) {
      // A second entry means the object was reset or the alarm was retried; the work is not replayed.
      await this.ctx.storage.put('run', {
        ...run,
        state: 'done',
        alarm_entries: entries,
        finished_at: Date.now(),
        error: 'alarm re-entered after a Durable Object reset; the run was not replayed',
      });
      return;
    }
    await this.ctx.storage.put('run', { ...run, alarm_entries: entries });

    const relay = this.env.REMOTE_COMPUTER_DO.get(this.env.REMOTE_COMPUTER_DO.idFromName(run.spec.computer_id));
    const steps: StepRecord[] = [];
    let summary: Record<string, number | string | boolean> = {};
    let error: string | null = null;
    try {
      summary = await this.#runSpec({ spec: run.spec, relay, steps });
    } catch (caught) {
      error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
    }
    await this.ctx.storage.put('run', {
      ...run,
      state: 'done',
      alarm_entries: entries,
      finished_at: Date.now(),
      steps,
      summary,
      error,
    });
  }

  async #runSpec({
    spec,
    relay,
    steps,
  }: {
    spec: CallerSpec;
    relay: DurableObjectStub<RemoteComputerDO>;
    steps: StepRecord[];
  }): Promise<Record<string, number | string | boolean>> {
    switch (spec.kind) {
      case 'single':
        return this.#runSingle({ spec, relay, steps });
      case 'exec_series':
        return this.#runSeries({ spec, relay, steps });
      case 'concurrent':
        return this.#runConcurrent({ spec, relay, steps });
      case 'roundtrip':
        return this.#runRoundtrip({ spec, relay, steps });
    }
  }

  async #exec({
    relay,
    spec,
    command,
  }: {
    relay: DurableObjectStub<RemoteComputerDO>;
    spec: CallerSpec;
    command: string;
  }): Promise<RequestOutcome> {
    return relay.request({
      op_json: JSON.stringify({ op: 'exec', command, cwd: null, env: {}, timeout_ms: spec.timeout_ms }),
      timeout_ms: spec.timeout_ms,
    });
  }

  async #runSingle({
    spec,
    relay,
    steps,
  }: {
    spec: CallerSpec;
    relay: DurableObjectStub<RemoteComputerDO>;
    steps: StepRecord[];
  }): Promise<Record<string, number | string | boolean>> {
    const startedAt = Date.now();
    const outcome = await this.#exec({ relay, spec, command: spec.command });
    const ms = Date.now() - startedAt;
    steps.push({ label: 'single', ms, ok: outcome.ok, detail: describe(outcome) });
    return { ms, ok: outcome.ok };
  }

  /** Twenty consecutive execs through one alarm, which is the warm-overhead measurement. */
  async #runSeries({
    spec,
    relay,
    steps,
  }: {
    spec: CallerSpec;
    relay: DurableObjectStub<RemoteComputerDO>;
    steps: StepRecord[];
  }): Promise<Record<string, number | string | boolean>> {
    const durations: number[] = [];
    let failures = 0;
    for (let index = 0; index < spec.count; index += 1) {
      const startedAt = Date.now();
      const outcome = await this.#exec({ relay, spec, command: spec.command });
      const ms = Date.now() - startedAt;
      durations.push(ms);
      if (!outcome.ok) {
        failures += 1;
      }
      steps.push({ label: `exec ${String(index + 1)}`, ms, ok: outcome.ok, detail: describe(outcome) });
    }
    const sorted = [...durations].sort((a, b) => a - b);
    return {
      count: durations.length,
      failures,
      min_ms: sorted[0] ?? 0,
      median_ms: sorted[Math.floor(sorted.length / 2)] ?? 0,
      max_ms: sorted[sorted.length - 1] ?? 0,
      mean_ms: Math.round(durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length)),
      over_1s: durations.filter(value => value > 1000).length,
    };
  }

  /** `count` slow execs issued together plus one more, to show the cap queue the extra one. */
  async #runConcurrent({
    spec,
    relay,
    steps,
  }: {
    spec: CallerSpec;
    relay: DurableObjectStub<RemoteComputerDO>;
    steps: StepRecord[];
  }): Promise<Record<string, number | string | boolean>> {
    const startedAt = Date.now();
    const slow = Array.from({ length: spec.count }, (_unused, index) =>
      this.#exec({ relay, spec, command: spec.command }).then(outcome => ({ index, outcome, at: Date.now() })),
    );
    const extra = this.#exec({ relay, spec, command: 'uname -a' }).then(outcome => ({
      index: -1,
      outcome,
      at: Date.now(),
    }));
    const settled = await Promise.all([...slow, extra]);
    for (const entry of settled) {
      steps.push({
        label: entry.index === -1 ? 'queued extra' : `concurrent ${String(entry.index + 1)}`,
        ms: entry.at - startedAt,
        ok: entry.outcome.ok,
        detail: describe(entry.outcome),
      });
    }
    const extraEntry = settled.find(entry => entry.index === -1);
    const slowFinishes = settled.filter(entry => entry.index !== -1).map(entry => entry.at - startedAt);
    return {
      slow_max_ms: Math.max(...slowFinishes),
      slow_min_ms: Math.min(...slowFinishes),
      extra_ms: extraEntry === undefined ? -1 : extraEntry.at - startedAt,
      extra_ok: extraEntry?.outcome.ok ?? false,
      all_ok: settled.every(entry => entry.outcome.ok),
    };
  }

  /** Chunked upload then download of the same bytes, with a digest check at both ends. */
  async #runRoundtrip({
    spec,
    relay,
    steps,
  }: {
    spec: CallerSpec;
    relay: DurableObjectStub<RemoteComputerDO>;
    steps: StepRecord[];
  }): Promise<Record<string, number | string | boolean>> {
    const chunkBytes = spec.chunk_bytes > 0 ? spec.chunk_bytes : CHUNK_BYTES;
    const payload = pseudoRandomBytes(spec.size_bytes, 0x5eed);
    const expected = await sha256Hex(payload);
    const transferId = crypto.randomUUID();

    const uploadStartedAt = Date.now();
    let seq = 0;
    let clientDigest: string | null = null;
    for (let offset = 0; offset < payload.length; offset += chunkBytes) {
      const slice = payload.subarray(offset, Math.min(offset + chunkBytes, payload.length));
      const final = offset + chunkBytes >= payload.length;
      const outcome = await relay.request({
        op_json: JSON.stringify({
          op: 'file_put',
          transfer_id: transferId,
          path: spec.remote_path,
          seq,
          data_b64: toBase64(slice),
          final,
          sha256: final ? expected : null,
        }),
        timeout_ms: spec.timeout_ms,
      });
      if (!outcome.ok) {
        steps.push({
          label: `file_put ${String(seq)}`,
          ms: Date.now() - uploadStartedAt,
          ok: false,
          detail: describe(outcome),
        });
        return { uploaded: false, detail: describe(outcome) };
      }
      if (final) {
        clientDigest = parseFilePutResult(outcome.result_json)?.sha256 ?? null;
      }
      seq += 1;
    }
    const uploadMs = Date.now() - uploadStartedAt;
    steps.push({ label: 'upload', ms: uploadMs, ok: true, detail: `${String(seq)} chunks` });

    const downloadStartedAt = Date.now();
    const received = new Uint8Array(payload.length);
    let offset = 0;
    let remoteDigest: string | null = null;
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 4096) {
        return { uploaded: true, downloaded: false, detail: 'chunk guard tripped' };
      }
      const outcome = await relay.request({
        op_json: JSON.stringify({ op: 'file_get', path: spec.remote_path, offset, max_bytes: chunkBytes }),
        timeout_ms: spec.timeout_ms,
      });
      if (!outcome.ok) {
        steps.push({
          label: `file_get ${String(offset)}`,
          ms: Date.now() - downloadStartedAt,
          ok: false,
          detail: describe(outcome),
        });
        return { uploaded: true, downloaded: false, detail: describe(outcome) };
      }
      const chunk = parseFileGetResult(outcome.result_json);
      if (chunk === undefined) {
        return { uploaded: true, downloaded: false, detail: 'file_get returned an unreadable result' };
      }
      if (offset === 0) {
        remoteDigest = chunk.sha256;
      }
      const bytes = fromBase64(chunk.data_b64);
      if (offset + bytes.length <= received.length) {
        received.set(bytes, offset);
      }
      offset += bytes.length;
      if (chunk.eof || bytes.length === 0) {
        break;
      }
    }
    const downloadMs = Date.now() - downloadStartedAt;
    const roundTripDigest = await sha256Hex(received.subarray(0, Math.min(offset, received.length)));
    steps.push({ label: 'download', ms: downloadMs, ok: true, detail: `${String(offset)} bytes` });

    const megabytes = payload.length / (1024 * 1024);
    return {
      size_bytes: payload.length,
      chunk_bytes: chunkBytes,
      chunks: seq,
      upload_ms: uploadMs,
      download_ms: downloadMs,
      upload_mib_s: Number((megabytes / (uploadMs / 1000)).toFixed(3)),
      download_mib_s: Number((megabytes / (downloadMs / 1000)).toFixed(3)),
      expected_sha256: expected,
      client_sha256: clientDigest ?? 'none',
      remote_sha256: remoteDigest ?? 'none',
      roundtrip_sha256: roundTripDigest,
      sha256_match: clientDigest === expected && remoteDigest === expected && roundTripDigest === expected,
      bytes_downloaded: offset,
    };
  }
}
