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
  tenant_id: string;
  session_id: string | null;
  turn_id: string | null;
  op: ComputerAuditOp;
  /** Truncated to COMMAND_MAX_BYTES; the path for a file op. */
  command: string;
  /** Null when the outcome is unknown, for example after the relay was reset mid-request. */
  exit_code: number | null;
  duration_ms: number;
  bytes_out: number;
  /** ISO-8601 UTC instant. */
  created_at: string;
}

export type AppendComputerAuditInput = Omit<ComputerAuditRecord, 'created_at'> & { created_at: string };

export interface ListComputerAuditInput {
  tenant_id: string;
  computer_id: string;
  limit: number;
  /** Exclusive upper bound: return rows strictly older than this id. Undefined starts at the newest. */
  before_id: string | undefined;
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
  /** Looks a machine up by the sha256 of the credential it presented. Revoked rows never match. */
  getComputerByCredentialHash(credentialHash: string, transaction?: TTransaction): Promise<ComputerRecord | undefined>;
  /** Written by the relay's alarm while a machine is connected, not once per heartbeat. */
  recordPresence(input: ComputerPresenceInput, transaction?: TTransaction): Promise<void>;

  listAgentAccess(input: { tenant_id: string; computer_id: string }, transaction?: TTransaction): Promise<string[]>;
  /** Replaces the whole allowlist for one computer. */
  putAgentAccess(
    input: { tenant_id: string; computer_id: string; agent_names: readonly string[] },
    transaction?: TTransaction,
  ): Promise<string[] | undefined>;
  isAgentAllowed(
    input: { tenant_id: string; computer_id: string; agent_name: string },
    transaction?: TTransaction,
  ): Promise<boolean>;
  /** How many agents this computer allows, so delete can refuse while one is still granted. */
  countAgentAccess(input: { tenant_id: string; computer_id: string }, transaction?: TTransaction): Promise<number>;

  appendAudit(input: AppendComputerAuditInput, transaction?: TTransaction): Promise<void>;
  listAudit(input: ListComputerAuditInput, transaction?: TTransaction): Promise<ComputerAuditRecord[]>;
  /** Drops audit rows created before `before`. Returns how many went. */
  deleteAuditBefore(input: { before: string }, transaction?: TTransaction): Promise<number>;
}
