/**
 * DB-backed remote computers: the machines a tenant has enrolled, who may use them, and what they ran.
 * Credentials and enrollment codes are only ever stored as sha256 hex, never in plaintext.
 * Implementations: PostgresComputerStore and SqliteComputerStore (the latter also runs on D1).
 */
import type { ComputerCapabilities } from '../computers/protocol';

export const COMPUTER_STATUSES = ['pending', 'online', 'offline', 'revoked'] as const;
export type ComputerStatus = (typeof COMPUTER_STATUSES)[number];

export const COMPUTER_AUDIT_OPS = ['exec', 'file_put', 'file_get'] as const;
export type ComputerAuditOp = (typeof COMPUTER_AUDIT_OPS)[number];

export interface ComputerRecord {
  id: string;
  tenant_id: string;
  name: string;
  owner_subject: string;
  status: ComputerStatus;
  /** Null until the machine enrolls; every value is a sha256 hex digest. */
  credential_hash: string | null;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  agent_version: string | null;
  /** What the machine reported in `hello`; null before the first connection. */
  capabilities: ComputerCapabilities | null;
  run_as_user: string | null;
  /** Stored now, enforced from phase 8d; new computers default to true. */
  require_approval: boolean;
  /** ISO-8601 UTC instant, or null when the machine has never connected. */
  last_seen_at: string | null;
  /** ISO-8601 UTC instant. */
  created_at: string;
  /** ISO-8601 UTC instant. */
  updated_at: string;
}

export interface CreateComputerInput {
  id: string;
  tenant_id: string;
  name: string;
  owner_subject: string;
  require_approval: boolean;
  /** sha256 hex of the one-time enrollment code. */
  code_hash: string;
  /** ISO-8601 UTC instant. */
  code_expires_at: string;
}

export interface RotateComputerInput {
  tenant_id: string;
  computer_id: string;
  code_hash: string;
  /** ISO-8601 UTC instant. */
  code_expires_at: string;
}

export interface UpdateComputerInput {
  tenant_id: string;
  computer_id: string;
  /** Undefined leaves the value alone. */
  name: string | undefined;
  require_approval: boolean | undefined;
}

export interface RedeemEnrollmentInput {
  /** sha256 hex of the code the machine presented. */
  code_hash: string;
  /** sha256 hex of the credential minted for it. */
  credential_hash: string;
  hostname: string;
  os: string;
  arch: string;
  agent_version: string;
  /** ISO-8601 UTC instant; a code whose `expires_at` is at or before this is dead. */
  now: string;
}

export interface ComputerPresenceInput {
  computer_id: string;
  status: ComputerStatus;
  /** ISO-8601 UTC instant, or null to leave the stored value alone. */
  last_seen_at: string | null;
  /** Reported by `hello`; undefined leaves the stored machine facts alone. */
  hello:
    | {
        hostname: string;
        os: string;
        arch: string;
        agent_version: string;
        run_as_user: string;
        capabilities: ComputerCapabilities;
      }
    | undefined;
}

export interface ComputerAuditRecord {
  id: string;
  computer_id: string;
  /**
   * The computer's name as it was when the row was written. Denormalised because the row outlives
   * the computer: deleting a machine must not erase the record of what ran on it.
   */
  computer_name: string;
  tenant_id: string;
  session_id: string | null;
  turn_id: string | null;
  op: ComputerAuditOp;
  /** Truncated to COMMAND_MAX_BYTES; the path for a file op. */
  command: string;
  /** Null when the outcome is unknown, for example after the relay was reset mid-request. */
  exit_code: number | null;
  /**
   * `ok`, or why the operation did not finish — offline, revoked, too_large, a client error code.
   * Recorded so a refused read is as visible in the log as a successful one.
   */
  outcome: string;
  duration_ms: number;
  bytes_out: number;
  /** ISO-8601 UTC instant. */
  created_at: string;
}

export type AppendComputerAuditInput = Omit<ComputerAuditRecord, 'created_at'> & { created_at: string };

export interface ListComputerAuditInput {
  tenant_id: string;
  /** Undefined lists the whole tenant, including machines that have since been deleted. */
  computer_id: string | undefined;
  limit: number;
  /** Exclusive upper bound: return rows strictly older than this id. Undefined starts at the newest. */
  before_id: string | undefined;
}

/** A saved agent allowed on a computer. The id is what grants access; the name is for display. */
export interface ComputerAgentGrant {
  agent_id: string;
  agent_name: string;
}

export interface IComputerStore<TTransaction = never> {
  listComputers(tenantId: string, transaction?: TTransaction): Promise<ComputerRecord[]>;
  getComputer(
    input: { tenant_id: string; computer_id: string },
    transaction?: TTransaction,
  ): Promise<ComputerRecord | undefined>;
  /** The relay and the enroll route have no tenant yet, so they look a machine up without one. */
  getComputerById(computerId: string, transaction?: TTransaction): Promise<ComputerRecord | undefined>;
  /** Creates the computer and its first enrollment code in one atomic write. */
  createComputer(input: CreateComputerInput, transaction?: TTransaction): Promise<ComputerRecord>;
  updateComputer(input: UpdateComputerInput, transaction?: TTransaction): Promise<ComputerRecord | undefined>;
  /**
   * Issues a fresh enrollment code and drops the current credential, so the machine that holds it can
   * no longer connect. Returns undefined when the computer is not in the tenant.
   */
  rotateComputer(input: RotateComputerInput, transaction?: TTransaction): Promise<ComputerRecord | undefined>;
  /** Marks the computer revoked and drops its credential. Returns undefined when it is not in the tenant. */
  revokeComputer(
    input: { tenant_id: string; computer_id: string },
    transaction?: TTransaction,
  ): Promise<ComputerRecord | undefined>;
  deleteComputer(input: { tenant_id: string; computer_id: string }, transaction?: TTransaction): Promise<boolean>;
  /**
   * Burns a single-use code and binds the credential to its computer in one atomic write.
   * Returns undefined for a code that is unknown, already used or expired — the caller must answer
   * all three identically.
   */
  redeemEnrollment(input: RedeemEnrollmentInput, transaction?: TTransaction): Promise<ComputerRecord | undefined>;
  /**
   * Whether a code could still be redeemed. A read, so a wrong guess costs no write: going
   * straight to the redeem batch would make every brute-force attempt a billable write.
   * Advisory only — `redeemEnrollment` is still what decides, atomically.
   */
  hasRedeemableEnrollment(input: { code_hash: string; now: string }, transaction?: TTransaction): Promise<boolean>;
  /** Looks a machine up by the sha256 of the credential it presented. Revoked rows never match. */
  getComputerByCredentialHash(credentialHash: string, transaction?: TTransaction): Promise<ComputerRecord | undefined>;
  /** Written by the relay's alarm while a machine is connected, not once per heartbeat. */
  recordPresence(input: ComputerPresenceInput, transaction?: TTransaction): Promise<void>;

  listAgentAccess(
    input: { tenant_id: string; computer_id: string },
    transaction?: TTransaction,
  ): Promise<ComputerAgentGrant[]>;
  /** Replaces the whole allowlist for one computer. Callers resolve names to ids first. */
  putAgentAccess(
    input: { tenant_id: string; computer_id: string; agents: readonly ComputerAgentGrant[] },
    transaction?: TTransaction,
  ): Promise<ComputerAgentGrant[] | undefined>;
  /**
   * Keyed by the agent's immutable id, never its name. A name can be taken again by a different
   * agent after a delete, and an agent can be created by any tenant user, so a name would let a
   * stale or guessed grant hand someone else's machine to a new agent.
   */
  isAgentAllowed(
    input: { tenant_id: string; computer_id: string; agent_id: string },
    transaction?: TTransaction,
  ): Promise<boolean>;
  /**
   * Drops every grant an agent holds across the tenant, called when the agent is deleted. Access is
   * keyed by id, so a leaked row grants nothing; this keeps the list honest rather than safe.
   */
  deleteAgentAccessForAgent(
    input: { tenant_id: string; agent_id: string },
    transaction?: TTransaction,
  ): Promise<number>;
  /** How many agents this computer allows, so delete can refuse while one is still granted. */
  countAgentAccess(input: { tenant_id: string; computer_id: string }, transaction?: TTransaction): Promise<number>;

  appendAudit(input: AppendComputerAuditInput, transaction?: TTransaction): Promise<void>;
  listAudit(input: ListComputerAuditInput, transaction?: TTransaction): Promise<ComputerAuditRecord[]>;
  /** Drops audit rows created before `before`. Returns how many went. */
  deleteAuditBefore(input: { before: string }, transaction?: TTransaction): Promise<number>;
}
