import { WorkerEntrypoint } from 'cloudflare:workers';
import configuration from '../../config';
import { createConsoleLogger } from '../logger';

/**
 * Egress for one sandbox container.
 *
 * Cloudflare intercepts every outbound HTTP and HTTPS request the container makes and delivers it
 * here with its original URL, so this is the one place that decides what a sandbox may reach.
 */
export class SandboxEgressGateway extends WorkerEntrypoint {
  readonly #logger = createConsoleLogger({
    level: configuration.LOG_LEVEL,
    bindings: { component: 'SandboxEgressGateway' },
  });

  override fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.#logger.info('Sandbox egress', { host: url.host, protocol: url.protocol, method: request.method });
    return fetch(request);
  }
}
