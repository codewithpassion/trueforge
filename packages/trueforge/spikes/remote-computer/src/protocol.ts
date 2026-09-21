/**
 * Spike wire protocol. One JSON text frame per message, snake_case fields.
 * Heartbeats are the bare literals below so `setWebSocketAutoResponse` can answer them
 * without waking the Durable Object.
 */

export const HEARTBEAT_PING = 'ping';
export const HEARTBEAT_PONG = 'pong';

/** Client heartbeat period; the relay treats a socket with no ping for STALE_AFTER_MS as gone. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const STALE_AFTER_MS = 25_000;
/** How often a waiting request re-checks the socket's last heartbeat. */
export const STALENESS_POLL_MS = 2_000;
/** Added to a request's own timeout so the client's exit 124 wins the race. */
export const RELAY_GRACE_MS = 10_000;
export const MAX_IN_FLIGHT_EXEC = 4;
export const MAX_QUEUE_DEPTH = 32;

/** Close codes. 4401 is revocation and is terminal for the client. */
export const CLOSE_REVOKED = 4401;
export const CLOSE_REPLACED = 4409;
export const CLOSE_STALE = 4408;

export interface HelloMessage {
  readonly type: 'hello';
  readonly hostname: string;
  readonly os: string;
  readonly arch: string;
  readonly version: string;
  readonly run_as_user: string;
  readonly capabilities: { readonly python3: boolean; readonly git: boolean };
}

export interface ExecRequest {
  readonly op: 'exec';
  readonly command: string;
  readonly cwd: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly timeout_ms: number;
}

export interface CancelRequest {
  readonly op: 'cancel';
  readonly target_id: string;
}

export interface FilePutRequest {
  readonly op: 'file_put';
  readonly transfer_id: string;
  readonly path: string;
  readonly seq: number;
  readonly data_b64: string;
  readonly final: boolean;
  /** Hex sha256 of the whole file, sent on the final chunk only. */
  readonly sha256: string | null;
}

export interface FileGetRequest {
  readonly op: 'file_get';
  readonly path: string;
  readonly offset: number;
  readonly max_bytes: number;
}

/** Measures the frame-size ceiling in both directions without touching the filesystem. */
export interface ProbeRequest {
  readonly op: 'probe';
  readonly payload_b64: string;
  readonly echo_bytes: number;
}

export type ClientOpRequest = ExecRequest | CancelRequest | FilePutRequest | FileGetRequest | ProbeRequest;

export type Envelope = ClientOpRequest & { readonly id: string };

export interface ExecResultPayload {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly bytes_total: number;
  readonly truncated: boolean;
  readonly duration_ms: number;
}

export interface CancelResultPayload {
  readonly cancelled: boolean;
}

export interface FilePutResultPayload {
  readonly bytes_written: number;
  /** Present on the final chunk once the client has verified the whole-file digest. */
  readonly sha256: string | null;
}

export interface FileGetResultPayload {
  readonly data_b64: string;
  readonly eof: boolean;
  readonly size: number;
  /** Whole-file digest, returned with the first chunk (offset 0) only. */
  readonly sha256: string | null;
}

export interface ProbeResultPayload {
  readonly received_bytes: number;
  readonly echo_b64: string;
}

/**
 * The relay never inspects a result: it forwards the payload verbatim and the caller narrows it with the
 * parsers below, so only one side owns each op's shape.
 */
export type ClientReply =
  | { readonly ok: true; readonly id: string; readonly result_json: string }
  | { readonly ok: false; readonly id: string; readonly error: { readonly code: string; readonly message: string } };

/** Why a request could not be answered. Never thrown across RPC. */
export type RequestFailureReason = 'offline' | 'timeout' | 'revoked' | 'queue_full' | 'replaced' | 'bad_request';

export type RequestOutcome =
  | { readonly ok: true; readonly result_json: string; readonly waited_ms: number }
  | {
      readonly ok: false;
      readonly reason: RequestFailureReason;
      readonly message: string;
      readonly last_seen_at: number | null;
      readonly waited_ms: number;
    };

export interface ComputerStatus {
  readonly connected: boolean;
  readonly revoked: boolean;
  readonly generation: number;
  readonly last_seen_at: number | null;
  readonly pending: number;
  readonly in_flight_exec: number;
  readonly queued: number;
  readonly hello: HelloMessage | null;
  readonly socket_count: number;
  /** How many times the object was constructed; a rise between calls means it hibernated. */
  readonly boots: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseClientReply(raw: string): ClientReply | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed['id'] !== 'string') {
    return undefined;
  }
  const error = parsed['error'];
  if (isRecord(error) && typeof error['code'] === 'string' && typeof error['message'] === 'string') {
    return { ok: false, id: parsed['id'], error: { code: error['code'], message: error['message'] } };
  }
  const result = parsed['result'];
  if (!isRecord(result)) {
    return undefined;
  }
  return { ok: true, id: parsed['id'], result_json: JSON.stringify(result) };
}

function parseResultRecord(json: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

export function parseExecResult(json: string): ExecResultPayload | undefined {
  const value = parseResultRecord(json);
  if (value === undefined) {
    return undefined;
  }
  const { exit_code, stdout, stderr, bytes_total, truncated, duration_ms } = value;
  if (
    typeof exit_code !== 'number' ||
    typeof stdout !== 'string' ||
    typeof stderr !== 'string' ||
    typeof bytes_total !== 'number' ||
    typeof truncated !== 'boolean' ||
    typeof duration_ms !== 'number'
  ) {
    return undefined;
  }
  return { exit_code, stdout, stderr, bytes_total, truncated, duration_ms };
}

export function parseFilePutResult(json: string): FilePutResultPayload | undefined {
  const value = parseResultRecord(json);
  if (value === undefined || typeof value['bytes_written'] !== 'number') {
    return undefined;
  }
  const sha = value['sha256'];
  return { bytes_written: value['bytes_written'], sha256: typeof sha === 'string' ? sha : null };
}

export function parseFileGetResult(json: string): FileGetResultPayload | undefined {
  const value = parseResultRecord(json);
  if (value === undefined || typeof value['data_b64'] !== 'string' || typeof value['eof'] !== 'boolean') {
    return undefined;
  }
  const sha = value['sha256'];
  const size = value['size'];
  return {
    data_b64: value['data_b64'],
    eof: value['eof'],
    size: typeof size === 'number' ? size : 0,
    sha256: typeof sha === 'string' ? sha : null,
  };
}

export function parseHello(raw: string): HelloMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed['type'] !== 'hello') {
    return undefined;
  }
  const { hostname, os, arch, version, run_as_user, capabilities } = parsed;
  if (
    typeof hostname !== 'string' ||
    typeof os !== 'string' ||
    typeof arch !== 'string' ||
    typeof version !== 'string' ||
    typeof run_as_user !== 'string' ||
    !isRecord(capabilities) ||
    typeof capabilities['python3'] !== 'boolean' ||
    typeof capabilities['git'] !== 'boolean'
  ) {
    return undefined;
  }
  return {
    type: 'hello',
    hostname,
    os,
    arch,
    version,
    run_as_user,
    capabilities: { python3: capabilities['python3'], git: capabilities['git'] },
  };
}

export function offlineMessage({
  computerId,
  lastSeenAt,
  now,
}: {
  computerId: string;
  lastSeenAt: number | null;
  now: number;
}): string {
  if (lastSeenAt === null) {
    return `Computer ${computerId} is offline (never connected)`;
  }
  return `Computer ${computerId} is offline (last seen ${describeAge(now - lastSeenAt)} ago)`;
}

function describeAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) {
    return `${String(seconds)} seconds`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${String(minutes)} minutes`;
  }
  return `${String(Math.round(minutes / 60))} hours`;
}
