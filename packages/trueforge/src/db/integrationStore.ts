/**
 * DB-backed integrations: one `integration` row per connected channel account, plus the
 * `integration_event` dedupe log and the `integration_delivery` outbox.
 *
 * One store covers the three tables because they are never used apart — ingress records
 * an event and enqueues a delivery against the same integration, and both children
 * cascade with it.
 *
 * Transactions are route-owned (see `WithTransaction`): a store method never opens one.
 *
 * Implementations: PostgresIntegrationStore and SqliteIntegrationStore.
 */
import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { IntegrationManifestSchema, type IntegrationManifest, type IntegrationType } from '../schemas/integration';

export interface IntegrationRecord {
  /** Application-generated (ULID); FK target for the child tables. */
  id: string;
  tenant_id: string;
  type: IntegrationType;
  /** Channel-side account (for Slack, the `team_id`); unique per tenant and type. */
  external_account_id: string;
  manifest: IntegrationManifest;
  created_by_subject: CreatedBySubject;
  /** ISO-8601 UTC instant. */
  created_at: string;
  /** ISO-8601 UTC instant. */
  updated_at: string;
}

/** One accepted inbound channel event, kept so a channel retry does not start a second turn. */
export interface IntegrationEventRecord {
  id: string;
  tenant_id: string;
  integration_id: string;
  /** Channel-supplied event id, unique within the integration. */
  event_id: string;
  /** ISO-8601 UTC instant. */
  received_at: string;
}

/**
 * `pending` is owed, `sending` is claimed by one caller, `sent` and `failed` are terminal.
 * The `pending` -> `sending` transition is the exactly-once gate: two callers can both read a
 * pending row, but only one claim changes a row.
 */
export type IntegrationDeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed';

/** Outbox row: the reply owed to one conversation for one terminal turn. */
export interface IntegrationDeliveryRecord {
  id: string;
  tenant_id: string;
  integration_id: string;
  conversation_key: string;
  /** Unique across the table, so a turn delivers at most once. */
  turn_id: string;
  status: IntegrationDeliveryStatus;
  attempts: number;
  last_error: string | null;
  /** ISO-8601 UTC instant. */
  created_at: string;
  /** ISO-8601 UTC instant. */
  updated_at: string;
}

/**
 * Re-parse persisted manifest JSON so schema defaults materialize. Rows written
 * before a manifest field existed omit it on disk; readers must not assume presence.
 */
export function parseStoredIntegrationManifest(manifest: unknown): IntegrationManifest {
  return IntegrationManifestSchema.parse(manifest);
}

/** The `(tenant_id, type, external_account_id)` key is already taken. */
export class IntegrationConflictError extends Error {
  readonly tenant_id: string;
  readonly integration_type: IntegrationType;
  readonly external_account_id: string;

  constructor(
    { tenant_id, type, external_account_id }: { tenant_id: string; type: IntegrationType; external_account_id: string },
    options?: ErrorOptions,
  ) {
    super(`Integration already connected for ${type} account ${external_account_id}`, options);
    this.name = 'IntegrationConflictError';
    this.tenant_id = tenant_id;
    this.integration_type = type;
    this.external_account_id = external_account_id;
  }
}

export interface ListIntegrationsInput {
  tenant_id: string;
}

export interface GetIntegrationInput {
  tenant_id: string;
  id: string;
}

/** Ingress lookup: the integration id in the URL is the only trusted input, so there is no tenant to scope by. */
export interface GetIntegrationByIdInput {
  id: string;
}

export interface CreateIntegrationInput {
  id: string;
  tenant_id: string;
  type: IntegrationType;
  external_account_id: string;
  manifest: IntegrationManifest;
  created_by_subject: CreatedBySubject;
}

/** Replaces the whole manifest of an existing integration keyed by immutable id. */
export interface UpdateIntegrationInput {
  tenant_id: string;
  id: string;
  external_account_id: string;
  manifest: IntegrationManifest;
}

export interface DeleteIntegrationInput {
  tenant_id: string;
  id: string;
}

export interface RecordIntegrationEventInput {
  /** Minted by the caller: a batch cannot read one statement's RETURNING. */
  id: string;
  tenant_id: string;
  integration_id: string;
  event_id: string;
}

export interface PruneIntegrationEventsInput {
  /** Rows received strictly before this instant are removed. */
  before: Date;
}

export interface EnqueueIntegrationDeliveryInput {
  id: string;
  tenant_id: string;
  integration_id: string;
  conversation_key: string;
  turn_id: string;
}

export interface GetPendingDeliveryInput {
  turn_id: string;
}

export interface ClaimDeliveryInput {
  turn_id: string;
}

export interface DeleteIntegrationEventInput {
  id: string;
}

export interface MarkDeliverySentInput {
  id: string;
  /** The attempt this caller claimed; a row that moved on is another caller's and stays untouched. */
  attempts: number;
}

export interface MarkDeliveryFailedInput {
  id: string;
  attempts: number;
  /** Short reason kept on the row for operators. */
  error: string;
}

export interface ListRetryableDeliveriesInput {
  /** Only rows untouched since this instant; the partial index on `updated_at` serves it. */
  before: Date;
  limit: number;
}

/** A retry claim is guarded by `attempts` rather than `status`, so a stranded `sending` row is reachable. */
export interface ClaimDeliveryForRetryInput {
  id: string;
  /** Version stamp: the claim lands only while the row is still on this attempt count. */
  attempts: number;
}

export interface ReleaseDeliveryInput {
  id: string;
  attempts: number;
  /** Short reason kept on the row until the next attempt settles it. */
  error: string;
}

export interface IIntegrationStore<TTransaction = never> {
  // --- integration ---
  listIntegrations(input: ListIntegrationsInput, transaction?: TTransaction): Promise<IntegrationRecord[]>;
  getIntegration(input: GetIntegrationInput, transaction?: TTransaction): Promise<IntegrationRecord | undefined>;
  /** Ingress lookup by immutable id alone; the tenant comes from the row, never from the request. */
  getIntegrationById(
    input: GetIntegrationByIdInput,
    transaction?: TTransaction,
  ): Promise<IntegrationRecord | undefined>;
  /** Throws `IntegrationConflictError` when the channel account is already connected. */
  createIntegration(input: CreateIntegrationInput, transaction?: TTransaction): Promise<IntegrationRecord>;
  /**
   * Replaces the manifest of an existing integration. Returns undefined when it is gone.
   * Throws `IntegrationConflictError` when the new account key is already taken.
   */
  updateIntegration(input: UpdateIntegrationInput, transaction?: TTransaction): Promise<IntegrationRecord | undefined>;
  /** Deletes by immutable id; events and deliveries cascade. Idempotent if already missing. */
  deleteIntegration(input: DeleteIntegrationInput, transaction?: TTransaction): Promise<void>;

  // --- integration_event ---
  /**
   * Records an inbound event id once. `recorded` is false when the same event id was already
   * accepted for this integration, or when the integration no longer exists — the caller
   * drops the event either way.
   */
  recordEvent(input: RecordIntegrationEventInput, transaction?: TTransaction): Promise<{ recorded: boolean }>;
  /**
   * Releases an accepted event id so the channel's own retry can run it again. The caller uses
   * this when nothing ran after the row was written, for example a turn that would not start.
   */
  deleteEvent(input: DeleteIntegrationEventInput, transaction?: TTransaction): Promise<void>;
  /** Drops dedupe rows past their retention window. Returns how many were removed. */
  pruneEvents(input: PruneIntegrationEventsInput, transaction?: TTransaction): Promise<number>;

  // --- integration_delivery ---
  /**
   * Adds the outbox row owed for one terminal turn. `enqueued` is false when the turn
   * already has a row, or when the integration no longer exists.
   */
  enqueueDelivery(input: EnqueueIntegrationDeliveryInput, transaction?: TTransaction): Promise<{ enqueued: boolean }>;
  /** The turn's outbox row while it is still owed; undefined once it is claimed, sent or failed. */
  getPendingDelivery(
    input: GetPendingDeliveryInput,
    transaction?: TTransaction,
  ): Promise<IntegrationDeliveryRecord | undefined>;
  /**
   * Takes the turn's reply for delivery: one guarded `pending` -> `sending` write that counts the
   * attempt. Exactly one concurrent caller gets the row; the losers get undefined and post nothing.
   */
  claimDelivery(input: ClaimDeliveryInput, transaction?: TTransaction): Promise<IntegrationDeliveryRecord | undefined>;
  /**
   * Terminal transition out of `sending`, returning the settled row. A row this caller no longer
   * holds — the sweep reclaimed it and the attempt count moved on — is untouched and reported as
   * undefined, so a reclaimed reply is never settled by the caller it was taken from.
   */
  markDeliverySent(
    input: MarkDeliverySentInput,
    transaction?: TTransaction,
  ): Promise<IntegrationDeliveryRecord | undefined>;
  /** Terminal transition out of `sending` that records the reason. */
  markDeliveryFailed(
    input: MarkDeliveryFailedInput,
    transaction?: TTransaction,
  ): Promise<IntegrationDeliveryRecord | undefined>;
  /**
   * Unsettled rows the retry sweep may own: `pending` ones owed a further attempt and `sending`
   * ones stranded by a process that stopped between the claim and the post. Oldest first.
   */
  listRetryableDeliveries(
    input: ListRetryableDeliveriesInput,
    transaction?: TTransaction,
  ): Promise<IntegrationDeliveryRecord[]>;
  /**
   * Takes an unsettled row for another attempt, guarded on the attempt count the sweep read. A row
   * another caller has already moved is untouched and reported as undefined.
   */
  claimDeliveryForRetry(
    input: ClaimDeliveryForRetryInput,
    transaction?: TTransaction,
  ): Promise<IntegrationDeliveryRecord | undefined>;
  /** Puts a claimed row back in `pending` so the sweep can retry it after its backoff. */
  releaseDelivery(
    input: ReleaseDeliveryInput,
    transaction?: TTransaction,
  ): Promise<IntegrationDeliveryRecord | undefined>;
}
