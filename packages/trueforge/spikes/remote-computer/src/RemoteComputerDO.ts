import { DurableObject } from 'cloudflare:workers';

import type { SpikeEnv } from './env';
import {
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  CLOSE_STALE,
  type ComputerStatus,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  type HelloMessage,
  MAX_IN_FLIGHT_EXEC,
  MAX_QUEUE_DEPTH,
  offlineMessage,
  parseClientReply,
  parseHello,
  RELAY_GRACE_MS,
  type RequestOutcome,
  STALE_AFTER_MS,
  STALENESS_POLL_MS,
} from './protocol';

/** Written by the 60 s alarm rather than per heartbeat, so a connected computer costs no storage churn. */
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

/**
 * One relay per computer, addressed by `idFromName(computer_id)`. Holds a hibernatable WebSocket to the
 * client and answers callers over RPC, failing fast with an offline reason rather than throwing.
 */
export class RemoteComputerDO extends DurableObject<SpikeEnv> {
  readonly #pending = new Map<string, PendingEntry>();
  readonly #queue: QueuedEntry[] = [];
  #inFlightExec = 0;
  #generation = 0;
  #lastSeenAt: number | null = null;
  #revoked = false;
  #hello: HelloMessage | null = null;
  #nextId = 0;
  /** Counts constructor runs, so a hibernation between two calls is visible in `status()`. */
  #boots = 0;

  constructor(ctx: DurableObjectState, env: SpikeEnv) {
    super(ctx, env);
    // Gates every other handler until the stored state is back, so a woken object never
    // dispatches against a stale generation.
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<Record<string, unknown>>('meta');
      if (stored !== undefined) {
        const generation = stored['generation'];
        const lastSeenAt = stored['last_seen_at'];
        const revoked = stored['revoked'];
        this.#generation = typeof generation === 'number' ? generation : 0;
        this.#lastSeenAt = typeof lastSeenAt === 'number' ? lastSeenAt : null;
        this.#revoked = revoked === true;
      }
      // Hello is storage-backed: everything held only in memory is lost when the object hibernates,
      // even though the socket itself survives.
      this.#hello = (await ctx.storage.get<HelloMessage>('hello')) ?? null;
      this.#boots = ((await ctx.storage.get<number>('boots')) ?? 0) + 1;
      await ctx.storage.put('boots', this.#boots);
    });
  }

  async #saveMeta(): Promise<void> {
    await this.ctx.storage.put('meta', {
      generation: this.#generation,
      last_seen_at: this.#lastSeenAt,
      revoked: this.#revoked,
    });
  }

  /** Only the WebSocket upgrade reaches the object over `fetch`; every test path uses RPC. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    if (this.#revoked) {
      return new Response('Revoked', { status: 401 });
    }
    this.#generation += 1;
    this.#lastSeenAt = Date.now();
    await this.#saveMeta();

    // The replaced socket may linger in getWebSockets(), so dispatch matches on the generation instead.
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
    const attachment: SocketAttachment = { generation: this.#generation, connected_at: Date.now() };
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
      if (isSocketAttachment(attachment) && attachment.generation === this.#generation) {
        if (socket.readyState === WebSocket.READY_STATE_OPEN) {
          return socket;
        }
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
    this.#lastSeenAt = Date.now();
    const hello = parseHello(message);
    if (hello !== undefined) {
      this.#hello = hello;
      this.ctx.waitUntil(this.ctx.storage.put('hello', hello));
      return;
    }
    const reply = parseClientReply(message);
    if (reply === undefined) {
      return;
    }
    const entry = this.#pending.get(reply.id);
    if (entry === undefined) {
      return;
    }
    const attachment: unknown = socket.deserializeAttachment();
    // A reply from a superseded socket answers a request that was already failed as `replaced`.
    if (isSocketAttachment(attachment) && attachment.generation !== entry.generation) {
      return;
    }
    this.#pending.delete(reply.id);
    this.#release(entry);
    if (!reply.ok) {
      entry.settle({
        ok: false,
        reason: 'bad_request',
        message: `${reply.error.code}: ${reply.error.message}`,
        last_seen_at: this.#lastSeenAt,
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
    if (isSocketAttachment(attachment) && attachment.generation !== this.#generation) {
      return;
    }
    // The platform's heartbeat stamp is the only accurate last-seen; the stored one is a minute stale.
    this.#lastSeenAt = this.#lastHeartbeatAt(socket) ?? this.#lastSeenAt;
    this.#failPending({
      reason: 'offline',
      message: `${offlineMessage({ computerId: this.#name(), lastSeenAt: this.#lastSeenAt, now: Date.now() })}; socket ${detail}`,
    });
  }

  #name(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
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
        last_seen_at: this.#lastSeenAt,
        waited_ms: now - entry.startedAt,
      });
    }
    for (const queued of this.#queue.splice(0)) {
      queued.reject({ ok: false, reason, message, last_seen_at: this.#lastSeenAt, waited_ms: 0 });
    }
  }

  #release(entry: PendingEntry): void {
    if (!entry.isExec) {
      return;
    }
    this.#inFlightExec = Math.max(0, this.#inFlightExec - 1);
    const next = this.#queue.shift();
    if (next !== undefined) {
      next.run();
    }
  }

  /**
   * Sends one op to the computer and waits for its reply. Fails fast with a reason instead of throwing,
   * because the caller is a turn that must keep going.
   */
  async request(input: { op_json: string; timeout_ms: number }): Promise<RequestOutcome> {
    const startedAt = Date.now();
    const op = parseOpRequest(input.op_json);
    if (op === undefined) {
      return {
        ok: false,
        reason: 'bad_request',
        message: 'op_json must be a JSON object carrying a string `op`',
        last_seen_at: this.#lastSeenAt,
        waited_ms: 0,
      };
    }
    if (this.#revoked) {
      return {
        ok: false,
        reason: 'revoked',
        message: `Computer ${this.#name()} has been revoked`,
        last_seen_at: this.#lastSeenAt,
        waited_ms: 0,
      };
    }
    const isExec = op['op'] === 'exec';
    if (isExec && this.#inFlightExec >= MAX_IN_FLIGHT_EXEC) {
      if (this.#queue.length >= MAX_QUEUE_DEPTH) {
        return {
          ok: false,
          reason: 'queue_full',
          message: `Computer ${this.#name()} has ${String(MAX_QUEUE_DEPTH)} execs queued`,
          last_seen_at: this.#lastSeenAt,
          waited_ms: 0,
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
    const outcome = await this.#dispatch({ op, timeoutMs: input.timeout_ms, isExec, startedAt });
    return outcome;
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
        message: offlineMessage({ computerId: this.#name(), lastSeenAt: this.#lastSeenAt, now: Date.now() }),
        last_seen_at: this.#lastSeenAt,
        waited_ms: Date.now() - startedAt,
      };
    }
    this.#nextId += 1;
    const id = `${String(this.#generation)}-${String(this.#nextId)}`;
    const generation = this.#generation;

    let settle: (outcome: RequestOutcome) => void = () => undefined;
    const answered = new Promise<RequestOutcome>(resolve => {
      settle = resolve;
    });
    // Registered before the write, so a reply that arrives first is never dropped.
    this.#pending.set(id, { settle, generation, startedAt, isExec });
    try {
      socket.send(JSON.stringify({ id, ...op }));
    } catch (error) {
      const entry = this.#pending.get(id);
      if (entry !== undefined) {
        this.#pending.delete(id);
        this.#release(entry);
      }
      return {
        ok: false,
        reason: 'offline',
        message: `Send to computer ${this.#name()} failed: ${error instanceof Error ? error.message : 'unknown'}`,
        last_seen_at: this.#lastSeenAt,
        waited_ms: Date.now() - startedAt,
      };
    }

    const deadline = Date.now() + timeoutMs + RELAY_GRACE_MS;
    const watchdog = this.#watch({ id, deadline, socket, generation });
    return Promise.race([answered, watchdog]);
  }

  /**
   * Polls while a request waits: a socket whose heartbeats stopped is declared offline long before TCP
   * gives up, which is what a killed client looks like.
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
      if (stale || this.#generation !== generation || socket.readyState !== WebSocket.READY_STATE_OPEN) {
        this.#pending.delete(id);
        this.#release(entry);
        if (stale) {
          this.#lastSeenAt = heartbeatAt;
          try {
            socket.close(CLOSE_STALE, 'no heartbeat');
          } catch {
            // Already gone.
          }
        }
        return {
          ok: false,
          reason: 'offline',
          message: offlineMessage({ computerId: this.#name(), lastSeenAt: this.#lastSeenAt, now }),
          last_seen_at: this.#lastSeenAt,
          waited_ms: now - entry.startedAt,
        };
      }
      if (now >= deadline) {
        this.#pending.delete(id);
        this.#release(entry);
        // Best effort: the client kills the process group, so a timed-out exec does not keep running.
        try {
          socket.send(JSON.stringify({ id: `${id}-cancel`, op: 'cancel', target_id: id }));
        } catch {
          // The socket is gone; the client's own deadline ends the command.
        }
        return {
          ok: false,
          reason: 'timeout',
          message: `Computer ${this.#name()} did not answer within ${String(deadline - entry.startedAt)} ms`,
          last_seen_at: this.#lastSeenAt,
          waited_ms: now - entry.startedAt,
        };
      }
    }
  }

  /** Closes the live socket so a revoked credential stops working at once, not at the next connect. */
  async revoke(): Promise<{ closed: number }> {
    this.#revoked = true;
    await this.#saveMeta();
    let closed = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(CLOSE_REVOKED, 'revoked');
        closed += 1;
      } catch {
        // Already closing.
      }
    }
    this.#failPending({ reason: 'revoked', message: `Computer ${this.#name()} has been revoked` });
    return { closed };
  }

  /** Forces the eviction a deploy or a platform reset would cause, to see what a waiting caller gets. */
  abortSelf(): void {
    this.ctx.abort('spike: forced eviction');
  }

  async unrevoke(): Promise<void> {
    this.#revoked = false;
    await this.#saveMeta();
  }

  status(): ComputerStatus {
    const socket = this.#currentSocket();
    return {
      connected: socket !== undefined,
      revoked: this.#revoked,
      generation: this.#generation,
      last_seen_at: socket === undefined ? this.#lastSeenAt : (this.#lastHeartbeatAt(socket) ?? this.#lastSeenAt),
      pending: this.#pending.size,
      in_flight_exec: this.#inFlightExec,
      queued: this.#queue.length,
      hello: this.#hello,
      socket_count: this.ctx.getWebSockets().length,
      boots: this.#boots,
    };
  }

  /** Records last-seen from the platform's heartbeat stamp; one write a minute, not one per heartbeat. */
  override async alarm(): Promise<void> {
    const socket = this.#currentSocket();
    if (socket === undefined) {
      await this.#saveMeta();
      return;
    }
    const heartbeatAt = this.#lastHeartbeatAt(socket);
    if (heartbeatAt !== null && Date.now() - heartbeatAt > STALE_AFTER_MS) {
      this.#lastSeenAt = heartbeatAt;
      socket.close(CLOSE_STALE, 'no heartbeat');
      await this.#saveMeta();
      return;
    }
    this.#lastSeenAt = heartbeatAt ?? Date.now();
    await this.#saveMeta();
    await this.ctx.storage.setAlarm(Date.now() + LAST_SEEN_ALARM_MS);
  }
}
