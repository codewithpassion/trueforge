/**
 * A remote computer's desktop, for the people who use its agents: watch it, take control, type,
 * share the clipboard, and hand it back. Every relay op carries the signed-in user as its principal,
 * so the relay decides the lease on who is calling, never on anything the client sent.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { Context } from 'hono';
import type { Authorizer } from '../auth/authorizer';
import { hasAdminRole, type ResolveRequestContext } from '../auth/identity';
import { readBearerToken } from '../auth/token';
import {
  CLIENT_ERROR_DESKTOP_UNAVAILABLE,
  DESKTOP_CLIPBOARD_TIMEOUT_MS,
  DESKTOP_SCREENSHOT_TIMEOUT_MS,
  desktopInputTimeoutMs,
  parseDesktopClipboardGetResult,
  parseDesktopOkResult,
  parseDesktopScreenshotResult,
  type ClientOpRequest,
  type RelayPrincipal,
  type RequestOutcome,
} from '../computers/protocol';
import type { ComputerRelayPort, ComputersService } from '../computers/service';
import { recordDesktopControl, type HumanTakeoverService } from '../computers/takeover';
import type { IAgentStore } from '../db/agentStore';
import {
  cancelDesktopTakeoverRoute,
  getDesktopClipboardRoute,
  getDesktopScreenshotRoute,
  getDesktopStatusRoute,
  handBackDesktopRoute,
  sendDesktopInputRoute,
  setDesktopClipboardRoute,
  takeDesktopControlRoute,
} from '../routes/computerDesktopRoutes';
import type { DesktopController, DesktopStatus } from '../schemas/computerDesktop';
import { fromBase64, toArrayBuffer } from '../utils/bytes';
import { agentIfAccessible } from './agentAccess';
import { COMPUTERS_UNSUPPORTED } from './computers';

/** Said for a computer in another tenant too, so a probe cannot tell the two apart. */
const NO_SUCH_COMPUTER = 'No such computer';
const NO_SUCH_AGENT = 'No such agent';
const LEASE_REQUIRED_MESSAGE = 'Take control of the desktop first';
const ANSWER_REFUSED = {
  not_pending: 'No takeover is pending for that session',
  takeover_already_answered: 'The takeover was already answered',
} as const;

export interface ComputerDesktopsRouterDeps {
  /** Undefined on a runtime that cannot reach a machine's relay; every route then answers 404. */
  computers: ComputersService | undefined;
  /** Undefined where takeovers cannot be answered: none are listed, and answering one is refused. */
  humanTakeovers: HumanTakeoverService | undefined;
  resolveRequestContext: ResolveRequestContext;
  resolveAgentStore: (c: Context) => IAgentStore;
  authorizer: Authorizer;
  /** Undefined when unconfigured, which refuses every browser write rather than trusting any origin. */
  publicBaseUrl: () => string | undefined;
  logger: Logger;
}

/** A caller cleared to use one computer's desktop. */
interface DesktopAccess {
  computerId: string;
  tenantId: string;
  relay: ComputerRelayPort;
  store: ComputersService['store'];
  principal: Extract<RelayPrincipal, { kind: 'human' }>;
  /** Scopes the takeovers the caller sees and answers; undefined only for a tenant admin who named none. */
  agentId: string | undefined;
}

type AccessResult =
  | { readonly ok: true; readonly access: DesktopAccess }
  | { readonly ok: false; readonly status: 403 | 404; readonly message: string };

/** Why a relay op did not happen, as the HTTP answer the UI branches on. */
interface DesktopFailure {
  readonly status: 409 | 423 | 502 | 503;
  readonly code: string;
  readonly message: string;
}

type RelayResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: DesktopFailure };

function relayFailure(outcome: Extract<RequestOutcome, { ok: false }>): DesktopFailure {
  switch (outcome.reason) {
    case 'human_in_control':
      return { status: 423, code: 'human_in_control', message: outcome.message };
    // After the tenant check, a person is only refused this way for not holding control.
    case 'forbidden':
      return { status: 423, code: 'lease_required', message: LEASE_REQUIRED_MESSAGE };
    // A person is only ever told busy while the last person's clipboard is being cleared.
    case 'desktop_busy':
      return { status: 409, code: 'clearing', message: outcome.message };
    case 'desktop_unavailable':
      return { status: 503, code: 'desktop_unavailable', message: outcome.message };
    case 'bad_request':
      // A daemon whose desktop went down says so with its own code in front of the message.
      if (outcome.message.startsWith(`${CLIENT_ERROR_DESKTOP_UNAVAILABLE}:`)) {
        return { status: 503, code: 'desktop_unavailable', message: outcome.message };
      }
      return { status: 502, code: 'desktop_failed', message: outcome.message };
    default:
      return { status: 503, code: 'offline', message: outcome.message };
  }
}

export function createComputerDesktopsRouter(deps: ComputerDesktopsRouterDeps) {
  const router = new OpenAPIHono();

  /**
   * Cookies ride along on a request another site makes the browser send; an explicit bearer header
   * cannot. So a write without one must come from this server's own origin.
   */
  function isForeignOriginWrite(c: Context): boolean {
    if (readBearerToken(c) !== undefined) {
      return false;
    }
    const origin = c.req.header('Origin');
    const baseUrl = deps.publicBaseUrl();
    if (origin === undefined || baseUrl === undefined) {
      return true;
    }
    try {
      return new URL(origin).origin !== new URL(baseUrl).origin;
    } catch {
      return true;
    }
  }

  /**
   * Tenant first, then the agent: the caller may use it, its current spec puts its desktop on this
   * computer, and an admin has granted it the computer. Tenant admins may skip naming an agent.
   */
  async function resolveAccess(
    c: Context,
    { computerId, agentId }: { computerId: string; agentId: string | undefined },
  ): Promise<AccessResult> {
    const { computers } = deps;
    if (computers === undefined) {
      return { ok: false, status: 404, message: COMPUTERS_UNSUPPORTED };
    }
    const context = deps.resolveRequestContext(c);
    const tenantId = context.tenant_id;
    const computer = await computers.store.getComputer({ tenant_id: tenantId, computer_id: computerId });
    if (computer === undefined) {
      return { ok: false, status: 404, message: NO_SUCH_COMPUTER };
    }
    const granted: AccessResult = {
      ok: true,
      access: {
        computerId,
        tenantId,
        relay: computers.relay(computerId),
        store: computers.store,
        principal: { kind: 'human', user_id: context.subject.id },
        agentId,
      },
    };
    if (hasAdminRole(context)) {
      return granted;
    }
    // An inline session agent has no id to grant a computer to, so there is nothing to check against.
    if (agentId === undefined) {
      return { ok: false, status: 403, message: 'Name the saved agent whose desktop this is in `agent_id`' };
    }
    const agent = await agentIfAccessible({
      authorizer: deps.authorizer,
      context,
      action: 'use',
      agent: await deps.resolveAgentStore(c).getAgent({ tenant_id: tenantId, id: agentId }),
    });
    if (agent === undefined) {
      return { ok: false, status: 404, message: NO_SUCH_AGENT };
    }
    const { sandbox } = agent.manifest.config;
    const allowed =
      sandbox.computer_id === computerId &&
      sandbox.desktop &&
      (await computers.store.isAgentAllowed({ tenant_id: tenantId, computer_id: computerId, agent_id: agent.id }));
    if (!allowed) {
      return { ok: false, status: 403, message: 'This agent does not use the desktop of this computer' };
    }
    return granted;
  }

  async function sendOp<T>({
    access,
    op,
    timeoutMs,
    parse,
  }: {
    access: DesktopAccess;
    op: ClientOpRequest;
    timeoutMs: number;
    parse: (json: string) => T | undefined;
  }): Promise<RelayResult<T>> {
    const outcome = await access.relay.request({
      tenant_id: access.tenantId,
      op_json: JSON.stringify(op),
      timeout_ms: timeoutMs,
      principal: access.principal,
    });
    if (!outcome.ok) {
      return { ok: false, failure: relayFailure(outcome) };
    }
    const value = parse(outcome.result_json);
    if (value === undefined) {
      return {
        ok: false,
        failure: { status: 502, code: 'desktop_failed', message: 'The computer sent a reply this server cannot read' },
      };
    }
    return { ok: true, value };
  }

  async function screenshot(access: DesktopAccess): Promise<RelayResult<ArrayBuffer>> {
    const frame = await sendOp({
      access,
      op: { op: 'desktop_screenshot', quality: null },
      timeoutMs: DESKTOP_SCREENSHOT_TIMEOUT_MS,
      parse: parseDesktopScreenshotResult,
    });
    return frame.ok ? { ok: true, value: toArrayBuffer(fromBase64(frame.value.data_b64)) } : frame;
  }

  async function desktopStatus(access: DesktopAccess): Promise<DesktopStatus> {
    const [live, pending] = await Promise.all([
      access.relay.status(),
      deps.humanTakeovers?.listPendingTakeovers({
        tenant_id: access.tenantId,
        computer_id: access.computerId,
        ...(access.agentId === undefined ? {} : { agent_id: access.agentId }),
      }) ?? [],
    ]);
    const control = live.desktop_control;
    let controller: DesktopController;
    switch (control.kind) {
      case 'none':
      case 'clearing':
        controller = { kind: control.kind };
        break;
      case 'agent':
        controller = { kind: 'agent', session_id: control.session_id };
        break;
      case 'human':
        controller = {
          kind: 'human',
          user_id: control.user_id,
          is_me: control.user_id === access.principal.user_id,
          expires_at: new Date(control.expires_at).toISOString(),
        };
        break;
    }
    return {
      computer_id: access.computerId,
      online: live.connected,
      desktop: live.hello?.capabilities.desktop ?? false,
      controller,
      pending_takeovers: pending,
    };
  }

  /** Whether the session is waiting on a person for this caller's agent; always true for an unscoped admin. */
  async function isScopedTakeover({ access, sessionId }: { access: DesktopAccess; sessionId: string }) {
    if (access.agentId === undefined || deps.humanTakeovers === undefined) {
      return true;
    }
    const pending = await deps.humanTakeovers.listPendingTakeovers({
      tenant_id: access.tenantId,
      computer_id: access.computerId,
      agent_id: access.agentId,
    });
    return pending.some(takeover => takeover.session_id === sessionId);
  }

  const recordControl = ({ access, action }: { access: DesktopAccess; action: 'take_control' | 'hand_back' }) =>
    recordDesktopControl({
      store: access.store,
      logger: deps.logger,
      tenant_id: access.tenantId,
      computer_id: access.computerId,
      session_id: null,
      turn_id: null,
      action,
      acting_user_id: access.principal.user_id,
    });

  const jpeg = (c: Context, frame: ArrayBuffer) =>
    c.body(frame, 200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(frame.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });

  const getStatusHandler: RouteHandler<typeof getDesktopStatusRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const { agent_id: agentId } = c.req.valid('query');
    const resolved = await resolveAccess(c, { computerId, agentId });
    if (!resolved.ok) {
      return c.json({ error: { message: resolved.message } }, resolved.status);
    }
    return c.json({ data: await desktopStatus(resolved.access) }, 200);
  };

  const getScreenshotHandler: RouteHandler<typeof getDesktopScreenshotRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const { agent_id: agentId } = c.req.valid('query');
    const resolved = await resolveAccess(c, { computerId, agentId });
    if (!resolved.ok) {
      return c.json({ error: { message: resolved.message } }, resolved.status);
    }
    const frame = await screenshot(resolved.access);
    if (!frame.ok) {
      return c.json({ error: { message: frame.failure.message, code: frame.failure.code } }, frame.failure.status);
    }
    return jpeg(c, frame.value);
  };

  const sendInputHandler: RouteHandler<typeof sendDesktopInputRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const { agent_id: agentId } = c.req.valid('query');
    const { actions } = c.req.valid('json');
    if (isForeignOriginWrite(c)) {
      return c.json({ error: { message: 'Cross-origin request refused' } }, 403);
    }
    const resolved = await resolveAccess(c, { computerId, agentId });
    if (!resolved.ok) {
      return c.json({ error: { message: resolved.message } }, resolved.status);
    }
    // What a person types may be a password: only the shape of the batch is ever logged.
    deps.logger.info('Desktop input', {
      computer_id: computerId,
      action_count: actions.length,
      action_types: [...new Set(actions.map(action => action.type))],
    });
    const sent = await sendOp({
      access: resolved.access,
      op: { op: 'desktop_input', actions },
      timeoutMs: desktopInputTimeoutMs(actions),
      parse: parseDesktopOkResult,
    });
    if (!sent.ok) {
      return c.json({ error: { message: sent.failure.message, code: sent.failure.code } }, sent.failure.status);
    }
    const frame = await screenshot(resolved.access);
    if (!frame.ok) {
      return c.json({ error: { message: frame.failure.message, code: frame.failure.code } }, frame.failure.status);
    }
    return jpeg(c, frame.value);
  };

  const getClipboardHandler: RouteHandler<typeof getDesktopClipboardRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const { agent_id: agentId } = c.req.valid('query');
    const resolved = await resolveAccess(c, { computerId, agentId });
    if (!resolved.ok) {
      return c.json({ error: { message: resolved.message } }, resolved.status);
    }
    const read = await sendOp({
      access: resolved.access,
      op: { op: 'desktop_clipboard_get' },
      timeoutMs: DESKTOP_CLIPBOARD_TIMEOUT_MS,
      parse: parseDesktopClipboardGetResult,
    });
    if (!read.ok) {
      return c.json({ error: { message: read.failure.message, code: read.failure.code } }, read.failure.status);
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { text: read.value.text } }, 200);
  };

  const setClipboardHandler: RouteHandler<typeof setDesktopClipboardRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const { agent_id: agentId } = c.req.valid('query');
    const { text } = c.req.valid('json');
    if (isForeignOriginWrite(c)) {
      return c.json({ error: { message: 'Cross-origin request refused' } }, 403);
    }
    const resolved = await resolveAccess(c, { computerId, agentId });
    if (!resolved.ok) {
      return c.json({ error: { message: resolved.message } }, resolved.status);
    }
    const written = await sendOp({
      access: resolved.access,
      op: { op: 'desktop_clipboard_set', text, selections: ['clipboard', 'primary'] },
      timeoutMs: DESKTOP_CLIPBOARD_TIMEOUT_MS,
      parse: parseDesktopOkResult,
    });
    if (!written.ok) {
      return c.json(
        { error: { message: written.failure.message, code: written.failure.code } },
        written.failure.status,
      );
    }
    return c.body(null, 204);
  };

  const takeControlHandler: RouteHandler<typeof takeDesktopControlRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const { agent_id: agentId } = c.req.valid('query');
    if (isForeignOriginWrite(c)) {
      return c.json({ error: { message: 'Cross-origin request refused' } }, 403);
    }
    const resolved = await resolveAccess(c, { computerId, agentId });
    if (!resolved.ok) {
      return c.json({ error: { message: resolved.message } }, resolved.status);
    }
    const { access } = resolved;
    // The relay would hand out control of a machine that is not there, pausing every agent on it
    // for five minutes while nobody can drive anything.
    if (!(await access.relay.status()).connected) {
      return c.json({ error: { message: 'The computer is offline', code: 'offline' } }, 503);
    }
    const taken = await access.relay.takeHumanLease({
      tenant_id: access.tenantId,
      user_id: access.principal.user_id,
    });
    if (!taken.ok) {
      switch (taken.reason) {
        case 'desktop_busy':
          return c.json({ error: { message: taken.message, code: 'clearing' } }, 409);
        case 'forbidden':
          return c.json({ error: { message: NO_SUCH_COMPUTER } }, 404);
        case 'desktop_unavailable':
          return c.json({ error: { message: taken.message, code: 'desktop_unavailable' } }, 503);
        case 'revoked':
          return c.json({ error: { message: taken.message, code: 'offline' } }, 503);
      }
    }
    await recordControl({ access, action: 'take_control' });
    return c.json({ data: await desktopStatus(access) }, 200);
  };

  const handBackHandler: RouteHandler<typeof handBackDesktopRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const { agent_id: agentId } = c.req.valid('query');
    const { session_id: sessionId, note } = c.req.valid('json');
    if (isForeignOriginWrite(c)) {
      return c.json({ error: { message: 'Cross-origin request refused' } }, 403);
    }
    const resolved = await resolveAccess(c, { computerId, agentId });
    if (!resolved.ok) {
      return c.json({ error: { message: resolved.message } }, resolved.status);
    }
    const { access } = resolved;
    const takeovers = deps.humanTakeovers;
    if (sessionId !== undefined && takeovers === undefined) {
      return c.json({ error: { message: 'Takeovers cannot be answered on this server' } }, 503);
    }
    if (sessionId !== undefined && !(await isScopedTakeover({ access, sessionId }))) {
      return c.json(
        { error: { message: ANSWER_REFUSED.not_pending, code: 'not_pending' }, data: await desktopStatus(access) },
        409,
      );
    }
    // Released before the answer, so the resumed turn does not find a person still in control.
    const released = await access.relay.releaseHumanLease({
      tenant_id: access.tenantId,
      user_id: access.principal.user_id,
    });
    if (!released.released) {
      return c.json({ error: { message: LEASE_REQUIRED_MESSAGE, code: 'lease_required' } }, 423);
    }
    if (sessionId === undefined || takeovers === undefined) {
      await recordControl({ access, action: 'hand_back' });
      return c.json({ data: await desktopStatus(access) }, 200);
    }
    const answered = await takeovers.resolveTakeover({
      tenant_id: access.tenantId,
      computer_id: computerId,
      session_id: sessionId,
      outcome: 'completed',
      note: note ?? null,
      acting_user_id: access.principal.user_id,
    });
    if (!answered.ok) {
      // Control went back all the same; only an answered takeover is recorded by the service.
      await recordControl({ access, action: 'hand_back' });
      return c.json(
        {
          error: { message: ANSWER_REFUSED[answered.code], code: answered.code },
          data: await desktopStatus(access),
        },
        409,
      );
    }
    return c.json({ data: await desktopStatus(access) }, 200);
  };

  const cancelTakeoverHandler: RouteHandler<typeof cancelDesktopTakeoverRoute> = async c => {
    const { computer_id: computerId } = c.req.valid('param');
    const { agent_id: agentId } = c.req.valid('query');
    const { session_id: sessionId, note } = c.req.valid('json');
    if (isForeignOriginWrite(c)) {
      return c.json({ error: { message: 'Cross-origin request refused' } }, 403);
    }
    const resolved = await resolveAccess(c, { computerId, agentId });
    if (!resolved.ok) {
      return c.json({ error: { message: resolved.message } }, resolved.status);
    }
    const { access } = resolved;
    const takeovers = deps.humanTakeovers;
    if (takeovers === undefined) {
      return c.json({ error: { message: 'Takeovers cannot be answered on this server' } }, 503);
    }
    if (!(await isScopedTakeover({ access, sessionId }))) {
      return c.json({ error: { message: ANSWER_REFUSED.not_pending, code: 'not_pending' } }, 409);
    }
    // Anyone who may use the agent may cancel; the caller's own control, if any, ends with it.
    await access.relay.releaseHumanLease({ tenant_id: access.tenantId, user_id: access.principal.user_id });
    const answered = await takeovers.resolveTakeover({
      tenant_id: access.tenantId,
      computer_id: computerId,
      session_id: sessionId,
      outcome: 'cancelled',
      note: note ?? null,
      acting_user_id: access.principal.user_id,
    });
    if (!answered.ok) {
      return c.json({ error: { message: ANSWER_REFUSED[answered.code], code: answered.code } }, 409);
    }
    return c.json({ data: await desktopStatus(access) }, 200);
  };

  router.openapi(getDesktopStatusRoute, getStatusHandler);
  router.openapi(getDesktopScreenshotRoute, getScreenshotHandler);
  router.openapi(sendDesktopInputRoute, sendInputHandler);
  router.openapi(getDesktopClipboardRoute, getClipboardHandler);
  router.openapi(setDesktopClipboardRoute, setClipboardHandler);
  router.openapi(takeDesktopControlRoute, takeControlHandler);
  router.openapi(handBackDesktopRoute, handBackHandler);
  router.openapi(cancelDesktopTakeoverRoute, cancelTakeoverHandler);
  return router;
}
