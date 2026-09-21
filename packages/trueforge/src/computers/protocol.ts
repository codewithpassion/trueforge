/**
 * Frozen v1 wire contract between a remote computer client and the relay.
 * One JSON text frame per message, snake_case fields. Heartbeats are the bare literals below so
 * `setWebSocketAutoResponse` can answer them without waking the Durable Object.
 * Changing anything here breaks deployed clients; add a new `protocol_version` instead.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

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

/** Close codes. 4401 is terminal for the client: it stops retrying and exits. */
export const CLOSE_REVOKED = 4401;
export const CLOSE_REPLACED = 4409;
export const CLOSE_STALE = 4408;

/**
 * The platform closes the whole socket on an oversized frame, so every path guards against it well
 * under the measured 33,554,432-byte ceiling rather than letting one write drop every request.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** File transfers move in chunks this size so a frame never approaches MAX_FRAME_BYTES. */
export const FILE_CHUNK_BYTES = 256 * 1024;

export const ComputerCapabilitiesSchema = z.object({
  python3: z.boolean(),
  git: z.boolean(),
});
export type ComputerCapabilities = z.infer<typeof ComputerCapabilitiesSchema>;

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  protocol_version: z.literal(PROTOCOL_VERSION),
  hostname: z.string(),
  os: z.string(),
  arch: z.string(),
  version: z.string(),
  run_as_user: z.string(),
  capabilities: ComputerCapabilitiesSchema,
});
export type HelloMessage = z.infer<typeof HelloMessageSchema>;

export const ExecRequestSchema = z.object({
  op: z.literal('exec'),
  command: z.string(),
  cwd: z.string().nullable(),
  env: z.record(z.string(), z.string()),
  timeout_ms: z.number(),
});
export type ExecRequest = z.infer<typeof ExecRequestSchema>;

export const CancelRequestSchema = z.object({
  op: z.literal('cancel'),
  target_id: z.string(),
});
export type CancelRequest = z.infer<typeof CancelRequestSchema>;

export const FilePutRequestSchema = z.object({
  op: z.literal('file_put'),
  transfer_id: z.string(),
  path: z.string(),
  seq: z.number(),
  data_b64: z.string(),
  final: z.boolean(),
  /** Hex sha256 of the whole file, sent on the final chunk only. */
  sha256: z.string().nullable(),
});
export type FilePutRequest = z.infer<typeof FilePutRequestSchema>;

export const FileGetRequestSchema = z.object({
  op: z.literal('file_get'),
  path: z.string(),
  offset: z.number(),
  max_bytes: z.number(),
});
export type FileGetRequest = z.infer<typeof FileGetRequestSchema>;

export const ClientOpRequestSchema = z.discriminatedUnion('op', [
  ExecRequestSchema,
  CancelRequestSchema,
  FilePutRequestSchema,
  FileGetRequestSchema,
]);
export type ClientOpRequest = z.infer<typeof ClientOpRequestSchema>;

export const ExecResultPayloadSchema = z.object({
  exit_code: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  bytes_total: z.number(),
  truncated: z.boolean(),
  duration_ms: z.number(),
});
export type ExecResultPayload = z.infer<typeof ExecResultPayloadSchema>;

export const CancelResultPayloadSchema = z.object({
  cancelled: z.boolean(),
});
export type CancelResultPayload = z.infer<typeof CancelResultPayloadSchema>;

export const FilePutResultPayloadSchema = z.object({
  bytes_written: z.number(),
  /** Present on the final chunk once the client has verified the whole-file digest. */
  sha256: z.string().nullable(),
});
export type FilePutResultPayload = z.infer<typeof FilePutResultPayloadSchema>;

export const FileGetResultPayloadSchema = z.object({
  data_b64: z.string(),
  eof: z.boolean(),
  size: z.number(),
  /** Whole-file digest, returned with the first chunk (offset 0) only. */
  sha256: z.string().nullable(),
});
export type FileGetResultPayload = z.infer<typeof FileGetResultPayloadSchema>;

export const ReplyErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type ReplyError = z.infer<typeof ReplyErrorSchema>;

/**
 * A reply carries `result` or `error`, with no shared literal to discriminate on, so the two members
 * are told apart by which key is present. The relay forwards `result` verbatim and the caller narrows
 * it with the op's own payload schema, so only one side owns each op's shape.
 */
export const RawClientReplySchema = z.union([
  z.object({ id: z.string(), error: ReplyErrorSchema }),
  z.object({ id: z.string(), result: z.record(z.string(), z.unknown()) }),
]);

export type ClientReply =
  | { readonly ok: true; readonly id: string; readonly result_json: string }
  | { readonly ok: false; readonly id: string; readonly error: ReplyError };

/** Why a request could not be answered. Never thrown across RPC. */
export const RequestFailureReasonSchema = z.enum([
  'offline',
  'timeout',
  'revoked',
  'queue_full',
  'replaced',
  'bad_request',
  'forbidden',
  'interrupted',
]);
export type RequestFailureReason = z.infer<typeof RequestFailureReasonSchema>;

export const RequestOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result_json: z.string(), waited_ms: z.number() }),
  z.object({
    ok: z.literal(false),
    reason: RequestFailureReasonSchema,
    message: z.string(),
    last_seen_at: z.number().nullable(),
    waited_ms: z.number(),
  }),
]);
export type RequestOutcome = z.infer<typeof RequestOutcomeSchema>;

export const ComputerRelayStatusSchema = z.object({
  connected: z.boolean(),
  revoked: z.boolean(),
  generation: z.number(),
  last_seen_at: z.number().nullable(),
  pending: z.number(),
  in_flight_exec: z.number(),
  queued: z.number(),
  hello: HelloMessageSchema.nullable(),
});
export type ComputerRelayStatus = z.infer<typeof ComputerRelayStatusSchema>;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * What arrived on the socket. A frame that claims to be a hello is never mistaken for a reply, even
 * when this version cannot read it, so an unknown `protocol_version` is ignored rather than settling
 * some request by accident.
 */
export type ClientFrame =
  | { readonly kind: 'hello'; readonly hello: HelloMessage }
  | { readonly kind: 'unreadable_hello' }
  | { readonly kind: 'reply'; readonly reply: ClientReply }
  | { readonly kind: 'ignore' };

export function classifyClientFrame(raw: string): ClientFrame {
  const parsed = parseJson(raw);
  if (typeof parsed === 'object' && parsed !== null && 'type' in parsed && parsed.type === 'hello') {
    const hello = HelloMessageSchema.safeParse(parsed);
    return hello.success ? { kind: 'hello', hello: hello.data } : { kind: 'unreadable_hello' };
  }
  const reply = RawClientReplySchema.safeParse(parsed);
  if (!reply.success) {
    return { kind: 'ignore' };
  }
  if ('error' in reply.data) {
    return { kind: 'reply', reply: { ok: false, id: reply.data.id, error: reply.data.error } };
  }
  return { kind: 'reply', reply: { ok: true, id: reply.data.id, result_json: JSON.stringify(reply.data.result) } };
}

export function parseExecResult(json: string): ExecResultPayload | undefined {
  const parsed = ExecResultPayloadSchema.safeParse(parseJson(json));
  return parsed.success ? parsed.data : undefined;
}

export function parseFilePutResult(json: string): FilePutResultPayload | undefined {
  const parsed = FilePutResultPayloadSchema.safeParse(parseJson(json));
  return parsed.success ? parsed.data : undefined;
}

export function parseFileGetResult(json: string): FileGetResultPayload | undefined {
  const parsed = FileGetResultPayloadSchema.safeParse(parseJson(json));
  return parsed.success ? parsed.data : undefined;
}

export function describeAge(ms: number): string {
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

export function offlineMessage({
  computerName,
  lastSeenAt,
  now,
}: {
  computerName: string;
  lastSeenAt: number | null;
  now: number;
}): string {
  if (lastSeenAt === null) {
    return `Computer ${computerName} is offline (never connected)`;
  }
  return `Computer ${computerName} is offline (last seen ${describeAge(now - lastSeenAt)} ago)`;
}
