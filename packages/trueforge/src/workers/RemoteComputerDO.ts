import { DurableObject } from 'cloudflare:workers';
import {
  classifyClientFrame,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  CLOSE_STALE,
  type ComputerRelayStatus,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  type HelloMessage,
  MAX_FRAME_BYTES,
  MAX_IN_FLIGHT_EXEC,
  MAX_QUEUE_DEPTH,
  offlineMessage,
  RELAY_GRACE_MS,
  type RequestOutcome,
  STALE_AFTER_MS,
  STALENESS_POLL_MS,
} from '../computers/protocol';
import { COMPUTER_NAME_HEADER, COMPUTER_TENANT_HEADER } from '../computers/relayHeaders';
import type { IComputerStore } from '../db/computerStore';
import { workersComputerStore } from './computersService';
import type { Env } from './env';

/** Written by the alarm rather than per heartbeat, so a connected computer costs no D1 churn. */
const LAST_SEEN_ALARM_MS = 60_000;

interface SocketAttachment {
  readonly generation: number;
  readonly connected_at: number;
}

interface PendingEntry {
  readonly settle: (outcome: RequestOutcome) => void;
  readonly generation: number;
  readonly startedAt: number;
  readonly isExec: boolean;
}

interface QueuedEntry {
  readonly run: () => void;
  readonly reject: (outcome: RequestOutcome) => void;
}

/** Everything the relay must still know after an idle minute. A field would not survive hibernation. */
interface StoredMeta {
  readonly generation: number;
  readonly last_seen_at: number | null;
  readonly revoked: boolean;
  readonly tenant_id: string | null;
  readonly computer_name: string | null;
}

const EMPTY_META: StoredMeta = {
  generation: 0,
  last_seen_at: null,
  revoked: false,
  tenant_id: null,
  computer_name: null,
};

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    'generation' in value &&
    typeof value.generation === 'number' &&
    'connected_at' in value &&
    typeof value.connected_at === 'number'
  );
}

function readMeta(stored: Record<string, unknown> | undefined): StoredMeta {
  if (stored === undefined) {
    return EMPTY_META;
  }
  const generation = stored['generation'];
  const lastSeenAt = stored['last_seen_at'];
  const tenantId = stored['tenant_id'];
  const computerName = stored['computer_name'];
  return {
    generation: typeof generation === 'number' ? generation : 0,
    last_seen_at: typeof lastSeenAt === 'number' ? lastSeenAt : null,
    revoked: stored['revoked'] === true,
    tenant_id: typeof tenantId === 'string' ? tenantId : null,
    computer_name: typeof computerName === 'string' ? computerName : null,
  };
}

/** The relay only needs the `op` discriminator; the rest of the frame is forwarded verbatim. */
function parseOpRequest(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  if (!('op' in parsed) || typeof parsed.op !== 'string') {
    return undefined;
  }
  const forwarded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    forwarded[key] = value;
  }
  return forwarded;
}

/** What `request()` needs from its caller so the relay can refuse another tenant's computer. */
export interface RelayRequestInput {
  tenant_id: string;
  op_json: string;
  timeout_ms: number;
}

/**
 * One relay per computer, addressed by `idFromName(computer_id)`. Holds a hibernatable WebSocket to the
 * machine and answers callers over RPC, failing fast with a reason rather than throwing, because the
 * caller is a turn that must keep going.
 */
export class RemoteComputerDO extends DurableObject {
  readonly #pending = new Map<string, PendingEntry>();
  readonly #queue: QueuedEntry[] = [];
  #inFlightExec = 0;
  #meta: StoredMeta = EMPTY_META;
  #hello: HelloMessage | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Gates every other handler until the stored state is back, so a woken object never dispatches
    // against a stale generation or a forgotten tenant.
    void ctx.blockConcurrencyWhile(async () => {
      this.#meta = readMeta(await ctx.storage.get<Record<string, unknown>>('meta'));
      this.#hello = (await ctx.storage.get<HelloMessage>('hello')) ?? null;
    });
  }

  async #saveMeta(next: Partial<StoredMeta>): Promise<void> {
    this.#meta = { ...this.#meta, ...next };
    await this.ctx.storage.put('meta', { ...this.#meta });
  }

  #name(): string {
    return this.#meta.computer_name ?? this.ctx.id.name ?? this.ctx.id.toString();
  }

  /** Only the WebSocket upgrade reaches the object over `fetch`; every other path is RPC. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const tenantId = request.headers.get(COMPUTER_TENANT_HEADER);
    const computerName = request.headers.get(COMPUTER_NAME_HEADER);
    if (tenantId === null || computerName === null) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (this.#meta.revoked) {
      return new Response('Unauthorized', { status: 401 });
    }
    // A computer never changes hands, so the tenant this object first saw outranks the header.
    if (this.#meta.tenant_id !== null && this.#meta.tenant_id !== tenantId) {
      return new Response('Unauthorized', { status: 401 });
    }
    const generation = this.#meta.generation + 1;
    await this.#saveMeta({
      generation,
      last_seen_at: Date.now(),
      tenant_id: tenantId,
      computer_name: computerName,
    });

    // A replaced socket lingers in getWebSockets() long enough to be picked for dispatch, so the
    // generation in the attachment — not identity — decides which one is current.
    for (const existing of this.ctx.getWebSockets()) {
      try {
        existing.close(CLOSE_REPLACED, 'replaced by a newer connection');
      } catch {
        // Already closing; the generation check keeps it out of dispatch either way.
      }
    }
    this.#failPending({ reason: 'replaced', message: 'The computer reconnected while this request was in flight' });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const attachment: SocketAttachment = { generation, connected_at: Date.now() };
    server.serializeAttachment(attachment);
    // Answered by the platform without waking this object, so heartbeats cost nothing.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG));
    await this.ctx.storage.setAlarm(Date.now() + LAST_SEEN_ALARM_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Returns the socket of the current generation, ignoring one that is closing or superseded. */
  #currentSocket(): WebSocket | undefined {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment: unknown = socket.deserializeAttachment();
      if (
        isSocketAttachment(attachment) &&
        attachment.generation === this.#meta.generation &&
        socket.readyState === WebSocket.READY_STATE_OPEN
      ) {
        return socket;
      }
    }
    return undefined;
  }

  /**
   * The platform records every auto-answered heartbeat, so liveness survives hibernation without the
   * object waking. A socket whose peer was killed has a stale timestamp long before TCP notices.
   */
  #lastHeartbeatAt(socket: WebSocket): number | null {
    const stamp = this.ctx.getWebSocketAutoResponseTimestamp(socket);
    if (stamp !== null) {
      return stamp.getTime();
    }
    const attachment: unknown = socket.deserializeAttachment();
    return isSocketAttachment(attachment) ? attachment.connected_at : null;
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') {
      return;
    }
    const frame = classifyClientFrame(message);
    if (frame.kind === 'hello') {
      this.#hello = frame.hello;
      this.ctx.waitUntil(this.ctx.storage.put('hello', frame.hello));
      // One write per connect, not per heartbeat: without it the row has no run_as_user or
      // capabilities for up to a minute, and the provider cannot derive the session directory.
      this.ctx.waitUntil(this.#persistPresence({ status: 'online', lastSeenAt: Date.now() }));
      return;
    }
    // An unreadable hello is ignored rather than closed: the frozen contract has no code for it.
    if (frame.kind !== 'reply') {
      return;
    }
    const { reply } = frame;
    const entry = this.#pending.get(reply.id);
    if (entry === undefined) {
      return;
    }
    const attachment: unknown = socket.deserializeAttachment();
    // A reply from a superseded socket answers a request that was already failed as `replaced`.
    if (!isSocketAttachment(attachment) || attachment.generation !== entry.generation) {
      return;
    }
    this.#pending.delete(reply.id);
    this.#release(entry);
    if (!reply.ok) {
      entry.settle({
        ok: false,
        reason: 'bad_request',
        message: `${reply.error.code}: ${reply.error.message}`,
        last_seen_at: this.#meta.last_seen_at,
        waited_ms: Date.now() - entry.startedAt,
      });
      return;
    }
    entry.settle({ ok: true, result_json: reply.result_json, waited_ms: Date.now() - entry.startedAt });
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    this.#onSocketGone({ socket, detail: `closed with ${String(code)} ${reason}` });
  }

  override webSocketError(socket: WebSocket, error: unknown): void {
    this.#onSocketGone({ socket, detail: error instanceof Error ? error.message : 'socket error' });
  }

  #onSocketGone({ socket, detail }: { socket: WebSocket; detail: string }): void {
    const attachment: unknown = socket.deserializeAttachment();
    if (isSocketAttachment(attachment) && attachment.generation !== this.#meta.generation) {
      return;
    }
    // The platform's heartbeat stamp is the only accurate last-seen; the stored one is a minute stale.
    const lastSeenAt = this.#lastHeartbeatAt(socket) ?? this.#meta.last_seen_at;
    this.#meta = { ...this.#meta, last_seen_at: lastSeenAt };
    this.#failPending({
      reason: 'offline',
      message: `${offlineMessage({ computerName: this.#name(), lastSeenAt, now: Date.now() })}; socket ${detail}`,
    });
    this.ctx.waitUntil(this.#persistPresence({ status: 'offline', lastSeenAt }));
  }

  #failPending({ reason, message }: { reason: 'offline' | 'revoked' | 'replaced'; message: string }): void {
    const now = Date.now();
    for (const [id, entry] of [...this.#pending]) {
      this.#pending.delete(id);
      this.#release(entry);
      entry.settle({
        ok: false,
        reason,
        message,
        last_seen_at: this.#meta.last_seen_at,
        waited_ms: now - entry.startedAt,
      });
    }
    for (const queued of this.#queue.splice(0)) {
      queued.reject({ ok: false, reason, message, last_seen_at: this.#meta.last_seen_at, waited_ms: 0 });
    }
  }

  #release(entry: PendingEntry): void {
    if (!entry.isExec) {
      return;
    }
    this.#inFlightExec = Math.max(0, this.#inFlightExec - 1);
    this.#queue.shift()?.run();
  }

  /**
   * Sends one op to the computer and waits for its reply. Fails fast with a reason instead of throwing,
   * so a turn that reaches an offline machine keeps going.
   */
  async request(input: RelayRequestInput): Promise<RequestOutcome> {
    const startedAt = Date.now();
    const refuse = (reason: 'bad_request' | 'revoked' | 'forbidden' | 'offline', message: string): RequestOutcome => ({
      ok: false,
      reason,
      message,
      last_seen_at: this.#meta.last_seen_at,
      waited_ms: Date.now() - startedAt,
    });

    const op = parseOpRequest(input.op_json);
    if (op === undefined) {
      return refuse('bad_request', 'op_json must be a JSON object carrying a string `op`');
    }
    // An oversized frame closes the socket and kills every other request on it, so it never leaves
    // here. Counted in UTF-16 units, which only over-counts against a byte ceiling eight times larger.
    if (input.op_json.length > MAX_FRAME_BYTES) {
      return refuse('bad_request', `A request frame of ${String(input.op_json.length)} units is too large to send`);
    }
    if (this.#meta.revoked) {
      return refuse('revoked', `Computer ${this.#name()} has been revoked`);
    }
    // A computer that has never connected has no stored tenant, so there is nothing to serve yet.
    if (this.#meta.tenant_id === null) {
      return refuse('offline', offlineMessage({ computerName: this.#name(), lastSeenAt: null, now: Date.now() }));
    }
    if (this.#meta.tenant_id !== input.tenant_id) {
      return refuse('forbidden', 'This computer belongs to another tenant');
    }

    const isExec = op['op'] === 'exec';
    if (isExec && this.#inFlightExec >= MAX_IN_FLIGHT_EXEC) {
      if (this.#queue.length >= MAX_QUEUE_DEPTH) {
        return {
          ok: false,
          reason: 'queue_full',
          message: `Computer ${this.#name()} already has ${String(MAX_QUEUE_DEPTH)} commands queued`,
          last_seen_at: this.#meta.last_seen_at,
          waited_ms: Date.now() - startedAt,
        };
      }
      const admitted = await new Promise<RequestOutcome | undefined>(resolve => {
        this.#queue.push({
          run: () => {
            resolve(undefined);
          },
          reject: outcome => {
            resolve(outcome);
          },
        });
      });
      if (admitted !== undefined) {
        return admitted;
      }
    }
    if (isExec) {
      this.#inFlightExec += 1;
    }
    return this.#dispatch({ op, timeoutMs: input.timeout_ms, isExec, startedAt });
  }

  async #dispatch({
    op,
    timeoutMs,
    isExec,
    startedAt,
  }: {
    op: Record<string, unknown>;
    timeoutMs: number;
    isExec: boolean;
    startedAt: number;
  }): Promise<RequestOutcome> {
    const socket = this.#currentSocket();
    if (socket === undefined) {
      if (isExec) {
        this.#inFlightExec = Math.max(0, this.#inFlightExec - 1);
        this.#queue.shift()?.run();
      }
      return {
        ok: false,
        reason: 'offline',
        message: offlineMessage({
          computerName: this.#name(),
          lastSeenAt: this.#meta.last_seen_at,
          now: Date.now(),
        }),
        last_seen_at: this.#meta.last_seen_at,
        waited_ms: Date.now() - startedAt,
      };
    }
    // Never a counter: after a hibernation an in-memory counter restarts and a late reply from an
    // orphaned command would settle an unrelated request with the wrong output.
    const id = crypto.randomUUID();
    const generation = this.#meta.generation;

    let settle: (outcome: RequestOutcome) => void = () => undefined;
    const answered = new Promise<RequestOutcome>(resolve => {
      settle = resolve;
    });
    // Registered before the write, so a reply that arrives first is never dropped.
    this.#pending.set(id, { settle, generation, startedAt, isExec });
    const frame = JSON.stringify({ id, ...op });
    if (frame.length > MAX_FRAME_BYTES) {
      this.#discard(id);
      return {
        ok: false,
        reason: 'bad_request',
        message: `A request frame of ${String(frame.length)} units is too large to send`,
        last_seen_at: this.#meta.last_seen_at,
        waited_ms: Date.now() - startedAt,
      };
    }
    try {
      socket.send(frame);
    } catch (error) {
      this.#discard(id);
      return {
        ok: false,
        reason: 'offline',
        message: `Send to computer ${this.#name()} failed: ${error instanceof Error ? error.message : 'unknown'}`,
        last_seen_at: this.#meta.last_seen_at,
        waited_ms: Date.now() - startedAt,
      };
    }

    const deadline = Date.now() + timeoutMs + RELAY_GRACE_MS;
    return Promise.race([answered, this.#watch({ id, deadline, socket, generation })]);
  }

  #discard(id: string): void {
    const entry = this.#pending.get(id);
    if (entry !== undefined) {
      this.#pending.delete(id);
      this.#release(entry);
    }
  }

  /**
   * Polls while a request waits: a socket whose heartbeats stopped is declared offline long before TCP
   * gives up, which is what a suspended laptop looks like. No alarm is needed, because the object is
   * awake for the whole of a pending request.
   */
  async #watch({
    id,
    deadline,
    socket,
    generation,
  }: {
    id: string;
    deadline: number;
    socket: WebSocket;
    generation: number;
  }): Promise<RequestOutcome> {
    for (;;) {
      await scheduler.wait(STALENESS_POLL_MS);
      const entry = this.#pending.get(id);
      if (entry === undefined) {
        // Answered, or failed by a close handler; the race is already settled.
        return new Promise<RequestOutcome>(() => undefined);
      }
      const now = Date.now();
      const heartbeatAt = this.#lastHeartbeatAt(socket);
      const stale = heartbeatAt !== null && now - heartbeatAt > STALE_AFTER_MS;
      if (stale || this.#meta.generation !== generation || socket.readyState !== WebSocket.READY_STATE_OPEN) {
        this.#discard(id);
        if (stale) {
          this.#meta = { ...this.#meta, last_seen_at: heartbeatAt };
          try {
            socket.close(CLOSE_STALE, 'no heartbeat');
          } catch {
            // Already gone.
          }
        }
        return {
          ok: false,
          reason: 'offline',
          message: offlineMessage({
            computerName: this.#name(),
            lastSeenAt: this.#meta.last_seen_at,
            now,
          }),
          last_seen_at: this.#meta.last_seen_at,
          waited_ms: now - entry.startedAt,
        };
      }
      if (now >= deadline) {
        this.#discard(id);
        // Best effort: the client kills the process group, so a timed-out exec does not keep running.
        try {
          socket.send(JSON.stringify({ id: crypto.randomUUID(), op: 'cancel', target_id: id }));
        } catch {
          // The socket is gone; the client's own deadline ends the command.
        }
        return {
          ok: false,
          reason: 'timeout',
          message: `Computer ${this.#name()} did not answer within ${String(deadline - entry.startedAt)} ms`,
          last_seen_at: this.#meta.last_seen_at,
          waited_ms: now - entry.startedAt,
        };
      }
    }
  }

  /** Closes the live socket so a revoked credential stops working at once, not at the next connect. */
  async revoke(): Promise<{ closed: number }> {
    await this.#saveMeta({ revoked: true });
    const closed = this.#closeSockets('revoked');
    this.#failPending({ reason: 'revoked', message: `Computer ${this.#name()} has been revoked` });
    return { closed };
  }

  /**
   * Drops the live socket without marking the computer revoked, which is what a rotate needs: the old
   * credential is gone, but the machine may enroll again with the new code and reconnect.
   */
  async disconnect(): Promise<{ closed: number }> {
    await this.#saveMeta({ generation: this.#meta.generation + 1 });
    const closed = this.#closeSockets('credential rotated');
    this.#failPending({ reason: 'revoked', message: `Computer ${this.#name()} had its credential rotated` });
    return { closed };
  }

  #closeSockets(reason: string): number {
    let closed = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(CLOSE_REVOKED, reason);
        closed += 1;
      } catch {
        // Already closing.
      }
    }
    return closed;
  }

  /** Called after the computer row is deleted, so no relay state outlives the machine. */
  async destroy(): Promise<void> {
    this.#closeSockets('deleted');
    this.#failPending({ reason: 'revoked', message: `Computer ${this.#name()} has been deleted` });
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.#meta = EMPTY_META;
    this.#hello = null;
  }

  status(): ComputerRelayStatus {
    const socket = this.#currentSocket();
    return {
      connected: socket !== undefined,
      revoked: this.#meta.revoked,
      generation: this.#meta.generation,
      last_seen_at:
        socket === undefined ? this.#meta.last_seen_at : (this.#lastHeartbeatAt(socket) ?? this.#meta.last_seen_at),
      pending: this.#pending.size,
      in_flight_exec: this.#inFlightExec,
      queued: this.#queue.length,
      hello: this.#hello,
    };
  }

  /** Records last-seen from the platform's heartbeat stamp; one write a minute, not one per heartbeat. */
  override async alarm(): Promise<void> {
    const socket = this.#currentSocket();
    if (socket === undefined) {
      await this.#saveMeta({});
      await this.#persistPresence({ status: 'offline', lastSeenAt: this.#meta.last_seen_at });
      return;
    }
    const heartbeatAt = this.#lastHeartbeatAt(socket);
    if (heartbeatAt !== null && Date.now() - heartbeatAt > STALE_AFTER_MS) {
      await this.#saveMeta({ last_seen_at: heartbeatAt });
      socket.close(CLOSE_STALE, 'no heartbeat');
      await this.#persistPresence({ status: 'offline', lastSeenAt: heartbeatAt });
      return;
    }
    await this.#saveMeta({ last_seen_at: heartbeatAt ?? Date.now() });
    await this.#persistPresence({ status: 'online', lastSeenAt: this.#meta.last_seen_at });
    await this.ctx.storage.setAlarm(Date.now() + LAST_SEEN_ALARM_MS);
  }

  /**
   * Mirrors liveness into the row the settings list reads. A failure here must not fail the request
   * that triggered it: the relay is still the truth about the socket.
   */
  async #persistPresence({
    status,
    lastSeenAt,
  }: {
    status: 'online' | 'offline';
    lastSeenAt: number | null;
  }): Promise<void> {
    const computerId = this.ctx.id.name;
    if (computerId === undefined) {
      return;
    }
    const hello = this.#hello;
    try {
      await this.#presenceStore().recordPresence({
        computer_id: computerId,
        status,
        last_seen_at: lastSeenAt === null ? null : new Date(lastSeenAt).toISOString(),
        hello:
          hello === null
            ? undefined
            : {
                hostname: hello.hostname,
                os: hello.os,
                arch: hello.arch,
                agent_version: hello.version,
                run_as_user: hello.run_as_user,
                capabilities: hello.capabilities,
              },
      });
    } catch (error) {
      console.error('Failed to record remote computer presence', error);
    }
  }

  #presenceStore(): IComputerStore {
    return workersComputerStore(this.env);
  }
}
