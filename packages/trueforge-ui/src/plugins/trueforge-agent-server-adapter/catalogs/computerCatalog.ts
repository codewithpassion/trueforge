/**
 * Maps trueforge-ui computer-settings calls onto Harness `/api/v1/computers`.
 *
 * `approvalEnforced` is left unset: this server stores `require_approval` but does not act
 * on it yet, and the UI says so rather than implying a gate that is not there.
 */
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type {
  ComputerAuditEntry,
  ComputerBase,
  ComputerCatalogServer,
  ComputerEnrollment,
} from '../../../server/types.js';
import { toListResult } from '../chatServer.js';

export function toUiComputer(computer: TrueForgeApi.Computer): ComputerBase {
  return {
    id: computer.id,
    name: computer.name,
    status: computer.status,
    hostname: computer.hostname,
    os: computer.os,
    arch: computer.arch,
    agentVersion: computer.agentVersion,
    tools:
      computer.tools === null
        ? null
        : {
            python3: computer.tools.python3,
            git: computer.tools.git,
            // Always sent; the SDK types them optional only because the server gives them defaults.
            desktop: computer.tools.desktop ?? false,
            desktopUnavailableReason: computer.tools.desktopUnavailableReason ?? null,
          },
    runAsUser: computer.runAsUser,
    requireApproval: computer.requireApproval,
    lastSeenAt: computer.lastSeenAt,
    createdAt: computer.createdAt,
    updatedAt: computer.updatedAt,
  };
}

export function toUiEnrollment(enrollment: TrueForgeApi.ComputerEnrollment): ComputerEnrollment {
  return {
    enrollmentCode: enrollment.enrollmentCode,
    installCommand: enrollment.installCommand,
    dockerCommand: enrollment.dockerCommand,
  };
}

export function toUiComputerAuditEntry(entry: TrueForgeApi.ComputerAuditEntry): ComputerAuditEntry {
  return {
    id: entry.id,
    computerId: entry.computerId,
    computerName: entry.computerName,
    sessionId: entry.sessionId,
    turnId: entry.turnId,
    op: entry.op,
    command: entry.command,
    exitCode: entry.exitCode,
    outcome: entry.outcome,
    durationMs: entry.durationMs,
    bytesOut: entry.bytesOut,
    createdAt: entry.createdAt,
  };
}

/** Settings computer-catalog port for `createTrueFoundryServer`. */
export function createComputerCatalog(client: TrueForge): ComputerCatalogServer {
  return {
    listComputers: async () => {
      const body = await client.computers.list();
      return body.data.map(toUiComputer);
    },
    createComputer: async req => {
      const body = await client.computers.create({ name: req.name, requireApproval: req.requireApproval });
      return { computer: toUiComputer(body.data.computer), enrollment: toUiEnrollment(body.data.enrollment) };
    },
    getComputer: async req => {
      const body = await client.computers.get(req.computerId);
      return toUiComputer(body.data);
    },
    updateComputer: async req => {
      const body = await client.computers.update(req.computerId, {
        ...(req.name === undefined ? {} : { name: req.name }),
        ...(req.requireApproval === undefined ? {} : { requireApproval: req.requireApproval }),
      });
      return toUiComputer(body.data);
    },
    deleteComputer: async req => {
      await client.computers.delete(req.computerId);
    },
    getComputerAgentAccess: async req => {
      const body = await client.computers.agents.list(req.computerId);
      return body.data.agentNames;
    },
    putComputerAgentAccess: async req => {
      const body = await client.computers.agents.createOrUpdate(req.computerId, { agentNames: req.agentNames });
      return body.data.agentNames;
    },
    rotateComputerEnrollment: async req => {
      const body = await client.computers.rotateEnrollment(req.computerId);
      return toUiEnrollment(body.data);
    },
    revokeComputer: async req => {
      const body = await client.computers.revoke(req.computerId);
      return toUiComputer(body.data);
    },
    listComputerAudit: async req => {
      const page = await client.computers.audit.list(req.computerId, {
        ...(req.limit === undefined ? {} : { limit: req.limit }),
        ...(req.pageToken === undefined ? {} : { pageToken: req.pageToken }),
      });
      return toListResult(page, toUiComputerAuditEntry);
    },
  };
}
