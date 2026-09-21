/**
 * Remote computers API. The admin surface is mounted at /api/v1/computers; the machine's own
 * enroll exchange and its WebSocket connect are mounted unauthenticated in front of it, because
 * a machine has no session and an upgrade is not an OpenAPI operation.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { Context, Hono } from 'hono';
import type { ResolveRequestContext } from '../auth/identity';
import {
  buildDockerCommand,
  buildInstallCommand,
  ENROLLMENT_CODE_TTL_MS,
  mintSecret,
  sha256Hex,
} from '../computers/enrollment';
import { COMPUTER_NAME_HEADER, COMPUTER_TENANT_HEADER } from '../computers/relayHeaders';
import type { ComputersService } from '../computers/service';
import type { ComputerRecord } from '../db/computerStore';
import { ComputerNameConflictError } from '../db/computerStoreErrors';
import {
  createComputerRoute,
  deleteComputerRoute,
  enrollComputerRoute,
  getComputerAgentAccessRoute,
  getComputerRoute,
  listComputerAuditRoute,
  listComputersRoute,
  patchComputerRoute,
  putComputerAgentAccessRoute,
  revokeComputerRoute,
  rotateComputerEnrollmentRoute,
} from '../routes/computerRoutes';
import type { Computer, ComputerEnrollment } from '../schemas/computer';
import { newId } from '../utils/id';

/** Said for a computer in another tenant too, so a probe cannot tell the two apart. */
const NOT_FOUND = 'No such computer';
const UNSUPPORTED = 'Remote computers are not available on this server';
/** Every enrollment and connect failure answers with exactly this. */
const UNAUTHORIZED = 'Unauthorized';

export interface ComputersRouterDeps {
  /** Undefined on a runtime that cannot reach a machine's relay. */
  computers: ComputersService | undefined;
  resolveRequestContext: ResolveRequestContext;
  publicBaseUrl: () => string;
  releaseBaseUrl: string;
  dockerImage: string;
  logger: Logger;
}

function toWireComputer(record: ComputerRecord): Computer {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    hostname: record.hostname,
    os: record.os,
    arch: record.arch,
    agent_version: record.agent_version,
    tools: record.capabilities,
    run_as_user: record.run_as_user,
    require_approval: record.require_approval,
    last_seen_at: record.last_seen_at,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

export function createComputersRouter(deps: ComputersRouterDeps) {
  const router = new OpenAPIHono();

  function enrollmentFor(code: string): ComputerEnrollment {
    const baseUrl = deps.publicBaseUrl();
    return {
      enrollment_code: code,
      install_command: buildInstallCommand({ baseUrl, code }),
      docker_command: buildDockerCommand({ baseUrl, code, image: deps.dockerImage }),
    };
  }

  /** Every admin handler starts here, so a runtime without computers answers one way. */
  async function withComputer<T>(
    c: Context,
    computerId: string,
    run: (input: { computers: ComputersService; tenantId: string; record: ComputerRecord }) => Promise<T>,
  ): Promise<T | undefined> {
    const { computers } = deps;
    if (computers === undefined) {
      return undefined;
    }
    const tenantId = deps.resolveRequestContext(c).tenant_id;
    const record = await computers.store.getComputer({ tenant_id: tenantId, computer_id: computerId });
    if (record === undefined) {
      return undefined;
    }
    return await run({ computers, tenantId, record });
  }

  const listHandler: RouteHandler<typeof listComputersRoute> = async c => {
    const { computers } = deps;
    if (computers === undefined) {
      return c.json({ error: { message: UNSUPPORTED } }, 404);
    }
    const tenantId = deps.resolveRequestContext(c).tenant_id;
    const records = await computers.store.listComputers(tenantId);
    return c.json({ data: records.map(toWireComputer) }, 200);
  };

  const createHandler: RouteHandler<typeof createComputerRoute> = async c => {
    const { computers } = deps;
    if (computers === undefined) {
      return c.json({ error: { message: UNSUPPORTED } }, 404);
    }
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const code = mintSecret();
    try {
      const record = await computers.store.createComputer({
        id: newId(),
        tenant_id: requestContext.tenant_id,
        name: body.name,
        owner_subject: requestContext.subject.id,
        require_approval: body.require_approval,
        code_hash: await sha256Hex(code),
        code_expires_at: new Date(Date.now() + ENROLLMENT_CODE_TTL_MS).toISOString(),
      });
      return c.json({ data: { computer: toWireComputer(record), enrollment: enrollmentFor(code) } }, 201);
    } catch (error) {
      if (error instanceof ComputerNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const getHandler: RouteHandler<typeof getComputerRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const found = await withComputer(c, computerId, ({ record }) => Promise.resolve(record));
    if (found === undefined) {
      return c.json({ error: { message: NOT_FOUND } }, 404);
    }
    return c.json({ data: toWireComputer(found) }, 200);
  };

  const patchHandler: RouteHandler<typeof patchComputerRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const updated = await withComputer(c, computerId, ({ computers, tenantId }) =>
        computers.store.updateComputer({
          tenant_id: tenantId,
          computer_id: computerId,
          name: body.name,
          require_approval: body.require_approval,
        }),
      );
      if (updated === undefined) {
        return c.json({ error: { message: NOT_FOUND } }, 404);
      }
      return c.json({ data: toWireComputer(updated) }, 200);
    } catch (error) {
      if (error instanceof ComputerNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const deleteHandler: RouteHandler<typeof deleteComputerRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const outcome = await withComputer(c, computerId, async ({ computers, tenantId }) => {
      // An agent still granted this machine would silently lose it, so deleting is refused until
      // an admin has taken the grant away and can see what they are removing.
      const granted = await computers.store.countAgentAccess({ tenant_id: tenantId, computer_id: computerId });
      if (granted > 0) {
        return { deleted: false, granted } as const;
      }
      await computers.store.deleteComputer({ tenant_id: tenantId, computer_id: computerId });
      // The row is gone either way; a relay that cannot be reached is not worth failing the call.
      try {
        await computers.relay(computerId).destroy();
      } catch (error) {
        deps.logger.warn('Could not clear the relay of a deleted computer', {
          ...extractErrorLogFields(error),
          computer_id: computerId,
        });
      }
      return { deleted: true, granted } as const;
    });
    if (outcome === undefined) {
      return c.json({ error: { message: NOT_FOUND } }, 404);
    }
    if (!outcome.deleted) {
      return c.json(
        {
          error: {
            message: `${String(outcome.granted)} agent(s) are still allowed to use this computer — remove their access first`,
          },
        },
        409,
      );
    }
    return c.json({}, 200);
  };

  const getAccessHandler: RouteHandler<typeof getComputerAgentAccessRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const names = await withComputer(c, computerId, ({ computers, tenantId }) =>
      computers.store.listAgentAccess({ tenant_id: tenantId, computer_id: computerId }),
    );
    if (names === undefined) {
      return c.json({ error: { message: NOT_FOUND } }, 404);
    }
    return c.json({ data: { agent_names: names } }, 200);
  };

  const putAccessHandler: RouteHandler<typeof putComputerAgentAccessRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const body = c.req.valid('json');
    const names = await withComputer(c, computerId, ({ computers, tenantId }) =>
      computers.store.putAgentAccess({
        tenant_id: tenantId,
        computer_id: computerId,
        agent_names: body.agent_names,
      }),
    );
    if (names === undefined) {
      return c.json({ error: { message: NOT_FOUND } }, 404);
    }
    return c.json({ data: { agent_names: names } }, 200);
  };

  const rotateHandler: RouteHandler<typeof rotateComputerEnrollmentRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const code = mintSecret();
    const rotated = await withComputer(c, computerId, async ({ computers, tenantId }) => {
      const record = await computers.store.rotateComputer({
        tenant_id: tenantId,
        computer_id: computerId,
        code_hash: await sha256Hex(code),
        code_expires_at: new Date(Date.now() + ENROLLMENT_CODE_TTL_MS).toISOString(),
      });
      if (record === undefined) {
        return undefined;
      }
      // The old credential is already gone from the row; this only stops the socket that still
      // holds it. Not a revoke: the machine is expected back with the new code.
      try {
        await computers.relay(computerId).disconnect();
      } catch (error) {
        deps.logger.warn('Could not disconnect a rotated computer', {
          ...extractErrorLogFields(error),
          computer_id: computerId,
        });
      }
      return record;
    });
    if (rotated === undefined) {
      return c.json({ error: { message: NOT_FOUND } }, 404);
    }
    return c.json({ data: enrollmentFor(code) }, 200);
  };

  const revokeHandler: RouteHandler<typeof revokeComputerRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const revoked = await withComputer(c, computerId, async ({ computers, tenantId }) => {
      const record = await computers.store.revokeComputer({ tenant_id: tenantId, computer_id: computerId });
      if (record === undefined) {
        return undefined;
      }
      try {
        await computers.relay(computerId).revoke();
      } catch (error) {
        deps.logger.warn('Could not close the socket of a revoked computer', {
          ...extractErrorLogFields(error),
          computer_id: computerId,
        });
      }
      return record;
    });
    if (revoked === undefined) {
      return c.json({ error: { message: NOT_FOUND } }, 404);
    }
    return c.json({ data: toWireComputer(revoked) }, 200);
  };

  const auditHandler: RouteHandler<typeof listComputerAuditRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const { limit, page_token: pageToken } = c.req.valid('query');
    const rows = await withComputer(c, computerId, ({ computers, tenantId }) =>
      computers.store.listAudit({
        tenant_id: tenantId,
        computer_id: computerId,
        limit: limit + 1,
        before_id: pageToken,
      }),
    );
    if (rows === undefined) {
      return c.json({ error: { message: NOT_FOUND } }, 404);
    }
    // One row past the page proves there is a next one without a second query. Its id is the
    // cursor, because audit ids are ULIDs and the list is ordered by id descending.
    const page = rows.slice(0, limit);
    const nextToken = rows.length > limit ? page[page.length - 1]?.id : undefined;
    return c.json(
      {
        data: page.map(row => ({
          id: row.id,
          session_id: row.session_id,
          turn_id: row.turn_id,
          op: row.op,
          command: row.command,
          exit_code: row.exit_code,
          duration_ms: row.duration_ms,
          bytes_out: row.bytes_out,
          created_at: row.created_at,
        })),
        pagination: { limit, ...(nextToken === undefined ? {} : { next_page_token: nextToken }) },
      },
      200,
    );
  };

  router.openapi(listComputersRoute, listHandler);
  router.openapi(createComputerRoute, createHandler);
  router.openapi(getComputerRoute, getHandler);
  router.openapi(patchComputerRoute, patchHandler);
  router.openapi(deleteComputerRoute, deleteHandler);
  router.openapi(getComputerAgentAccessRoute, getAccessHandler);
  router.openapi(putComputerAgentAccessRoute, putAccessHandler);
  router.openapi(rotateComputerEnrollmentRoute, rotateHandler);
  router.openapi(revokeComputerRoute, revokeHandler);
  router.openapi(listComputerAuditRoute, auditHandler);
  return router;
}

/**
 * The machine's own two routes. Mounted without an auth shell and in front of the admin router,
 * because a machine carries a credential of its own rather than a session.
 */
export function createComputerMachineRouter(deps: {
  computers: ComputersService | undefined;
  logger: Logger;
}): OpenAPIHono {
  const router = new OpenAPIHono();

  const enrollHandler: RouteHandler<typeof enrollComputerRoute> = async c => {
    const { computers } = deps;
    if (computers === undefined) {
      return c.json({ error: { message: UNSUPPORTED } }, 404);
    }
    const body = c.req.valid('json');
    const credential = mintSecret();
    const record = await computers.store.redeemEnrollment({
      code_hash: await sha256Hex(body.enrollment_code),
      credential_hash: await sha256Hex(credential),
      hostname: body.hostname,
      os: body.os,
      arch: body.arch,
      agent_version: body.version,
      now: new Date().toISOString(),
    });
    // Unknown, expired, already used and revoked all answer identically, so a caller with a code
    // learns nothing about which one it was.
    if (record === undefined) {
      return c.json({ error: { message: UNAUTHORIZED } }, 401);
    }
    return c.json({ data: { computer_id: record.id, machine_credential: credential } }, 200);
  };

  router.openapi(enrollComputerRoute, enrollHandler);
  return router;
}

/**
 * `GET /api/v1/computers/connect`. Not an OpenAPI operation: it answers 101 with a socket, which
 * the typed router cannot describe, so it is registered as a plain route on the app.
 */
export function registerComputerConnectRoute(input: {
  app: Hono;
  path: string;
  computers: ComputersService | undefined;
  logger: Logger;
}): void {
  input.app.get(input.path, async c => {
    const { computers } = input;
    const unauthorized = (): Response => c.json({ error: { message: UNAUTHORIZED } }, 401);
    if (computers === undefined) {
      return c.json({ error: { message: UNSUPPORTED } }, 404);
    }
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: { message: 'Expected a WebSocket upgrade' } }, 426);
    }
    const authorization = c.req.header('Authorization') ?? '';
    const match = /^Bearer (.+)$/i.exec(authorization);
    const presented = match?.[1];
    if (presented === undefined || presented === '') {
      return unauthorized();
    }
    const record = await computers.store.getComputerByCredentialHash(await sha256Hex(presented));
    if (record === undefined) {
      return unauthorized();
    }
    // The relay owns the socket; it is told who this machine is so it can refuse another tenant.
    // Rebuilt rather than mutated, because a request taken off the wire has immutable headers.
    const headers = new Headers(c.req.raw.headers);
    headers.set(COMPUTER_TENANT_HEADER, record.tenant_id);
    headers.set(COMPUTER_NAME_HEADER, record.name);
    const forwarded = new Request(c.req.raw.url, { method: 'GET', headers });
    return await computers.relayFetch({ computerId: record.id, request: forwarded });
  });
}
