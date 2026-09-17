import { WorkerEntrypoint } from 'cloudflare:workers';
import configuration from '../../config';
import type { Env } from '../env';
import { createConsoleLogger } from '../logger';
import { CODE_MODE_BRIDGE_HOST, type CodeModeDispatchOutcome } from './codeModeBridge';

export interface SandboxEgressProps {
  /**
   * Session Durable Object this container belongs to. It is the workspace's own name, so the
   * session a sandbox can reach is fixed when the workspace is built, not chosen per request.
   * Undefined when the workspace object cannot name itself, and Code Mode is then refused.
   */
  sessionDurableObjectName: string | undefined;
}

function bearerToken(header: string | null): string | undefined {
  const match = /^Bearer (.+)$/i.exec(header ?? '');
  return match?.[1];
}

function traceCarrier(headers: Headers): Record<string, string> {
  const carrier: Record<string, string> = {};
  const traceparent = headers.get('traceparent');
  const tracestate = headers.get('tracestate');
  if (traceparent !== null) {
    carrier['traceparent'] = traceparent;
  }
  if (tracestate !== null) {
    carrier['tracestate'] = tracestate;
  }
  return carrier;
}

/**
 * Egress for one sandbox container.
 *
 * Cloudflare intercepts every outbound HTTP and HTTPS request the container makes and delivers it
 * here with its original URL, so this is the one place that decides what a sandbox may reach. One
 * hostname is Code Mode and goes to this session's dispatcher; everything else goes where it asked.
 */
export class SandboxEgressGateway extends WorkerEntrypoint<Env, SandboxEgressProps> {
  readonly #logger = createConsoleLogger({
    level: configuration.LOG_LEVEL,
    bindings: { component: 'SandboxEgressGateway' },
  });

  override fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.host === CODE_MODE_BRIDGE_HOST) {
      return this.#answerCodeMode(request);
    }
    this.#logger.info('Sandbox egress', { host: url.host, protocol: url.protocol, method: request.method });
    return fetch(request);
  }

  async #answerCodeMode(request: Request): Promise<Response> {
    const { sessionDurableObjectName } = this.ctx.props;
    if (sessionDurableObjectName === undefined) {
      // Refused rather than read from the request: a session named by the sandbox is one it picked.
      this.#logger.error('A sandbox asked for Code Mode from a workspace that cannot name its session');
      return new Response('Code Mode is unavailable for this sandbox', { status: 503 });
    }
    if (request.method !== 'POST') {
      return new Response('Code Mode accepts POST', { status: 405 });
    }
    const token = bearerToken(request.headers.get('authorization'));
    if (token === undefined) {
      return new Response('Code Mode needs a bearer token', { status: 401 });
    }
    const namespace = this.env.SESSION_DO;
    // Annotated, because the RPC stub intersects each union member with `Disposable`, which stops
    // `ok` from discriminating.
    const outcome: CodeModeDispatchOutcome = await namespace
      .get(namespace.idFromName(sessionDurableObjectName))
      .dispatchCodeMode({
        token,
        // Forwarded as text: the session owns the wire shape, and a body that is not a Code Mode
        // request comes back as a reply blaming the caller rather than as a transport failure.
        requestJson: await request.text(),
        traceCarrier: traceCarrier(request.headers),
      });
    if (outcome.ok) {
      return new Response(outcome.replyJson, { headers: { 'content-type': 'application/json' } });
    }
    this.#logger.warn('Refused a Code Mode request', { status: outcome.status, sessionDurableObjectName });
    return new Response(outcome.message, { status: outcome.status });
  }
}
