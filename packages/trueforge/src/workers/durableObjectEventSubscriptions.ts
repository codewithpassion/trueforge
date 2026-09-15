import {
  StreamGoneError,
  SUBSCRIBE_STREAM_THRESHOLD_MS,
  type EventSubscription,
  type EventSubscriptionPollOptions,
  type EventSubscriptionPutOptions,
  type SequencedEvent,
} from '../runtime/event-subscription';

const POLL_BATCH_SIZE = 100;

interface StreamTip {
  seq: number;
  expires_at: number | null;
}

/** Wakes parked pollers in this Durable Object when their stream gains an event. */
class StreamChangeNotifier {
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #livePolls = new Map<string, number>();

  notify(streamId: string): void {
    const waiters = this.#waiters.get(streamId);
    this.#waiters.delete(streamId);
    for (const wake of [...(waiters ?? [])]) {
      wake();
    }
  }

  /** Parked pollers on one stream; exposed for tests through `waitingPollers`. */
  waiterCount(streamId: string): number {
    return this.#waiters.get(streamId)?.size ?? 0;
  }

  /** Counts a poll generator from its first pull until its body exits; returns the release. */
  trackPoll(streamId: string): () => void {
    this.#livePolls.set(streamId, this.livePollCount(streamId) + 1);
    return () => {
      const remaining = this.livePollCount(streamId) - 1;
      if (remaining > 0) {
        this.#livePolls.set(streamId, remaining);
      } else {
        this.#livePolls.delete(streamId);
      }
    };
  }

  /** Poll generators on one stream that have not finished; exposed for tests through `livePolls`. */
  livePollCount(streamId: string): number {
    return this.#livePolls.get(streamId) ?? 0;
  }

  /** Resolves on the next change, when `signal` aborts, or after `timeoutMs`. */
  wait({
    streamId,
    signal,
    timeoutMs,
  }: {
    streamId: string;
    signal: AbortSignal | undefined;
    timeoutMs: number | undefined;
  }): Promise<void> {
    return new Promise(resolve => {
      const waiters = this.#waiters.get(streamId) ?? new Set<() => void>();
      this.#waiters.set(streamId, waiters);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = (): void => {
        waiters.delete(wake);
        if (waiters.size === 0 && this.#waiters.get(streamId) === waiters) {
          this.#waiters.delete(streamId);
        }
        clearTimeout(timer);
        signal?.removeEventListener('abort', wake);
        resolve();
      };
      waiters.add(wake);
      signal?.addEventListener('abort', wake, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(wake, Math.max(0, timeoutMs));
      }
    });
  }
}

/**
 * One turn's event log in Durable Object SQLite, with the Redis backend's semantics: dense 1-indexed
 * sequences read from storage, a whole-stream absolute TTL, and poll-forever generators.
 */
class DurableObjectEventSubscription<T extends object> implements EventSubscription<T> {
  readonly #sql: SqlStorage;
  readonly #streamId: string;
  readonly #notifier: StreamChangeNotifier;
  readonly #isEvent: (value: unknown) => value is SequencedEvent<T>;

  constructor(input: {
    sql: SqlStorage;
    streamId: string;
    notifier: StreamChangeNotifier;
    isEvent: (value: unknown) => value is SequencedEvent<T>;
  }) {
    this.#sql = input.sql;
    this.#streamId = input.streamId;
    this.#notifier = input.notifier;
    this.#isEvent = input.isEvent;
  }

  put(event: T, options?: EventSubscriptionPutOptions): Promise<number> {
    const now = Date.now();
    const tip = this.#liveTip(now);
    const sequenceNumber = (tip?.seq ?? 0) + 1;
    const ttlSeconds = options?.streamTTLSeconds;
    const resetsTTL = ttlSeconds !== undefined && ttlSeconds > 0;
    const expiresAt = resetsTTL ? now + ttlSeconds * 1_000 : (tip?.expires_at ?? null);
    const sequencedEvent: SequencedEvent<T> = { ...event, sequence_number: sequenceNumber };
    this.#sql.exec(
      'INSERT INTO turn_events (stream_id, seq, data, expires_at) VALUES (?, ?, ?, ?)',
      this.#streamId,
      sequenceNumber,
      JSON.stringify(sequencedEvent),
      expiresAt,
    );
    if (resetsTTL) {
      this.#sql.exec('UPDATE turn_events SET expires_at = ? WHERE stream_id = ?', expiresAt, this.#streamId);
    }
    this.#notifier.notify(this.#streamId);
    return Promise.resolve(sequenceNumber);
  }

  /** Whether the stream has an event and has not expired, without subscribe's admission threshold. */
  hasLiveTip(): boolean {
    return this.#liveTip(Date.now()) !== undefined;
  }

  assertSubscribable(): Promise<void> {
    const now = Date.now();
    const tip = this.#liveTip(now);
    // Expiring within the threshold is treated as already gone, mirroring the Redis backend.
    if (tip === undefined || (tip.expires_at !== null && tip.expires_at - now < SUBSCRIBE_STREAM_THRESHOLD_MS)) {
      return Promise.reject(new StreamGoneError(this.#streamId));
    }
    return Promise.resolve();
  }

  async *poll(
    afterSequenceNumber?: number,
    options?: EventSubscriptionPollOptions,
  ): AsyncGenerator<SequencedEvent<T>, void, unknown> {
    const signal = options?.signal;
    let cursor = afterSequenceNumber ?? 0;
    const release = this.#notifier.trackPoll(this.#streamId);
    try {
      for (;;) {
        if (signal?.aborted) {
          return;
        }
        const now = Date.now();
        const tip = this.#liveTip(now);
        if (tip === undefined) {
          throw new StreamGoneError(this.#streamId);
        }
        const rows = this.#sql
          .exec<{ seq: number; data: string }>(
            'SELECT seq, data FROM turn_events WHERE stream_id = ? AND seq > ? ORDER BY seq LIMIT ?',
            this.#streamId,
            cursor,
            POLL_BATCH_SIZE,
          )
          .toArray();
        if (rows.length === 0) {
          // Also wake at expiry, so a parked poller observes the stream as gone.
          await this.#notifier.wait({
            streamId: this.#streamId,
            signal,
            timeoutMs: tip.expires_at === null ? undefined : tip.expires_at - now,
          });
          continue;
        }
        for (const row of rows) {
          cursor = row.seq;
          const event: unknown = JSON.parse(row.data);
          if (!this.#isEvent(event)) {
            throw new Error(`Corrupt stream entry ${String(row.seq)} on ${this.#streamId}`);
          }
          yield event;
        }
      }
    } finally {
      release();
    }
  }

  /** Latest row of a live stream; an expired stream is deleted and reads as absent. */
  #liveTip(now: number): StreamTip | undefined {
    const [tip] = this.#sql
      .exec<{
        seq: number;
        expires_at: number | null;
      }>('SELECT seq, expires_at FROM turn_events WHERE stream_id = ? ORDER BY seq DESC LIMIT 1', this.#streamId)
      .toArray();
    if (tip !== undefined && tip.expires_at !== null && tip.expires_at <= now) {
      this.#sql.exec('DELETE FROM turn_events WHERE stream_id = ?', this.#streamId);
      return undefined;
    }
    return tip;
  }
}

/** Hands out turn event streams stored in one Durable Object's SQLite database. */
export class DurableObjectEventSubscriptions<T extends object> {
  readonly #sql: SqlStorage;
  readonly #isEvent: (value: unknown) => value is SequencedEvent<T>;
  readonly #notifier = new StreamChangeNotifier();

  constructor(input: { sql: SqlStorage; isEvent: (value: unknown) => value is SequencedEvent<T> }) {
    this.#sql = input.sql;
    this.#isEvent = input.isEvent;
  }

  /** Idempotent; run from the Durable Object constructor under `blockConcurrencyWhile`. */
  static createSchema(sql: SqlStorage): void {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS turn_events (
        stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data TEXT NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (stream_id, seq)
      )`,
    );
  }

  get(streamId: string): DurableObjectEventSubscription<T> {
    return new DurableObjectEventSubscription({
      sql: this.#sql,
      streamId,
      notifier: this.#notifier,
      isEvent: this.#isEvent,
    });
  }

  /**
   * Pollers parked until the stream's next event. Tests use it to show that a reader cancelled inside the
   * object releases its poll at once, while one cancelled across RPC stays parked until the next event.
   */
  waitingPollers(streamId: string): number {
    return this.#notifier.waiterCount(streamId);
  }

  /**
   * Poll generators on the stream whose body has not exited, parked or suspended at `yield`. Tests use it
   * to show that a poll cancelled across RPC finishes at the next event rather than staying suspended.
   */
  livePolls(streamId: string): number {
    return this.#notifier.livePollCount(streamId);
  }

  deleteExpired(now: number): void {
    this.#sql.exec('DELETE FROM turn_events WHERE expires_at IS NOT NULL AND expires_at <= ?', now);
  }

  /** Earliest future expiry among stored streams; undefined when none will expire. */
  nextExpiry(now: number): number | undefined {
    const [row] = this.#sql
      .exec<{ next: number | null }>('SELECT MIN(expires_at) AS next FROM turn_events WHERE expires_at > ?', now)
      .toArray();
    return row?.next ?? undefined;
  }
}
