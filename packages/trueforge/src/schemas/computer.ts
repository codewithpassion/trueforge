/**
 * Remote computer wire schemas. Credentials and enrollment codes appear in exactly one response
 * each, at the moment they are minted; everything stored is a sha256 digest.
 */
import { z } from '@hono/zod-openapi';
import { TokenPaginationSchema } from '@truefoundry/trueforge-core/agent-session';
import { ComputerCapabilitiesSchema } from '../computers/protocol';
import { COMPUTER_AUDIT_OPS, COMPUTER_STATUSES } from '../db/computerStore';
import { NameSchema } from './common';

export const ComputerStatusSchema = z.enum(COMPUTER_STATUSES).openapi('ComputerStatus');
export const ComputerAuditOpSchema = z.enum(COMPUTER_AUDIT_OPS).openapi('ComputerAuditOp');

/**
 * The wire name for the capabilities the protocol already owns; the shape is not redeclared.
 * `skills` is left off: it is a derived verdict, not a tool anyone installs, and no client reads it.
 */
export const ComputerToolsSchema = z
  .object(ComputerCapabilitiesSchema.omit({ skills: true }).shape)
  .openapi('ComputerTools');

export const ComputerSchema = z
  .object({
    id: z.string().min(1),
    name: NameSchema,
    status: ComputerStatusSchema,
    hostname: z.string().nullable().describe('Reported by the machine; null before it first connects.'),
    os: z.string().nullable(),
    arch: z.string().nullable(),
    agent_version: z.string().nullable(),
    tools: ComputerToolsSchema.nullable().describe('What the machine reported it has; null before it connects.'),
    run_as_user: z.string().nullable(),
    require_approval: z
      .boolean()
      .describe('Ask a person before each command. Stored now; the gate itself arrives in a later release.'),
    last_seen_at: z.string().nullable().describe('ISO-8601 instant of the last heartbeat, or null.'),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict()
  .openapi('Computer');

/** The one-time secret and the two commands that use it. Returned by create and by rotate only. */
export const ComputerEnrollmentSchema = z
  .object({
    enrollment_code: z.string().min(1).describe('Single-use, valid for 15 minutes. Shown once.'),
    install_command: z.string().describe('Ready to paste on the machine.'),
    docker_command: z
      .string()
      .nullable()
      .describe('Ready to paste, or null when this server has no client image configured.'),
  })
  .strict()
  .openapi('ComputerEnrollment');

export const ComputerWithEnrollmentSchema = z
  .object({
    computer: ComputerSchema,
    enrollment: ComputerEnrollmentSchema,
  })
  .strict()
  .openapi('ComputerWithEnrollment');

export const CreateComputerRequestSchema = z
  .object({
    name: NameSchema,
    require_approval: z.boolean().default(true).describe('Default: true.'),
  })
  .strict()
  .openapi('CreateComputerRequest');

export const UpdateComputerRequestSchema = z
  .object({
    name: NameSchema.optional(),
    require_approval: z.boolean().optional(),
  })
  .strict()
  .openapi('UpdateComputerRequest');

export const ComputerAgentAccessSchema = z
  .object({
    agent_names: z.array(NameSchema).max(200).describe('Saved agents allowed to run on this computer.'),
  })
  .strict()
  .openapi('ComputerAgentAccess');

export const ComputerAuditEntrySchema = z
  .object({
    id: z.string().min(1),
    computer_id: z.string().min(1),
    computer_name: z.string().describe('The name the computer had when this ran; it may since have gone.'),
    session_id: z.string().nullable(),
    turn_id: z.string().nullable(),
    op: ComputerAuditOpSchema,
    command: z
      .string()
      .describe('The command, or the path for a file operation. Truncated at 4 KiB. Kept for 30 days.'),
    exit_code: z.number().int().nullable().describe('Null when the outcome never came back.'),
    outcome: z.string().describe('`ok`, or why it did not finish — offline, revoked, too_large, denied.'),
    duration_ms: z.number().int(),
    bytes_out: z.number().int(),
    created_at: z.string(),
  })
  .strict()
  .openapi('ComputerAuditEntry');

export const ListComputerAuditRequestQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(50).describe('Page size. Max 100.'),
    page_token: z.string().min(1).optional().describe('Opaque cursor from a previous response.'),
  })
  .openapi('ListComputerAuditRequestQuery');

export const EnrollComputerRequestSchema = z
  .object({
    enrollment_code: z.string().min(1),
    hostname: z.string().min(1).max(255),
    os: z.string().min(1).max(32),
    arch: z.string().min(1).max(32),
    version: z.string().min(1).max(64),
  })
  .strict()
  .openapi('EnrollComputerRequest');

export const EnrolledComputerSchema = z
  .object({
    computer_id: z.string().min(1),
    machine_credential: z.string().min(1).describe('Presented as a bearer token on every connect. Shown once.'),
  })
  .strict()
  .openapi('EnrolledComputer');

export const ListComputersResponseSchema = z.object({ data: z.array(ComputerSchema) }).openapi('ListComputersResponse');
export const GetComputerResponseSchema = z.object({ data: ComputerSchema }).openapi('GetComputerResponse');
export const CreateComputerResponseSchema = z
  .object({ data: ComputerWithEnrollmentSchema })
  .openapi('CreateComputerResponse');
export const CreateComputerEnrollmentResponseSchema = z
  .object({ data: ComputerEnrollmentSchema })
  .openapi('CreateComputerEnrollmentResponse');
export const GetComputerAgentAccessResponseSchema = z
  .object({ data: ComputerAgentAccessSchema })
  .openapi('GetComputerAgentAccessResponse');
export const ListComputerAuditResponseSchema = z
  .object({ data: z.array(ComputerAuditEntrySchema), pagination: TokenPaginationSchema })
  .openapi('ListComputerAuditResponse');
export const DeleteComputerResponseSchema = z.object({}).openapi('DeleteComputerResponse');
export const EnrollComputerResponseSchema = z
  .object({ data: EnrolledComputerSchema })
  .openapi('EnrollComputerResponse');

export type Computer = z.infer<typeof ComputerSchema>;
export type ComputerEnrollment = z.infer<typeof ComputerEnrollmentSchema>;
export type CreateComputerRequest = z.infer<typeof CreateComputerRequestSchema>;
export type UpdateComputerRequest = z.infer<typeof UpdateComputerRequestSchema>;
export type ComputerAgentAccess = z.infer<typeof ComputerAgentAccessSchema>;
export type ComputerAuditEntry = z.infer<typeof ComputerAuditEntrySchema>;
export type EnrollComputerRequest = z.infer<typeof EnrollComputerRequestSchema>;
