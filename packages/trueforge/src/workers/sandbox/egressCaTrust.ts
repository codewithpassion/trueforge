import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';

/** What trusting the egress CA needs from the workspace, so the policy can be tested without one. */
export interface EgressCaTrustDeps {
  /** Runs the install helper in the container; a non-zero exit code means the CA is not trusted. */
  runHelper(): Promise<{ exitCode: number; output: string }>;
  /** True when the container host has recorded an exit, which it clears when a container starts. */
  containerHasExited(): Promise<boolean>;
  logger: Logger;
}

/**
 * Decides when to run the CA helper: once per container. A container that has trusted the CA, or
 * failed to, is not asked again until it exits, because a missing CA costs a wait and an exec on
 * every retry and a restart is the only thing that brings a new one.
 */
export class EgressCaTrust {
  readonly #deps: EgressCaTrustDeps;
  #checkedThisContainer = false;

  constructor(deps: EgressCaTrustDeps) {
    this.#deps = deps;
  }

  async ensure(): Promise<void> {
    if (this.#checkedThisContainer) {
      if (!(await this.#deps.containerHasExited())) {
        return;
      }
      this.#checkedThisContainer = false;
    }
    try {
      const result = await this.#deps.runHelper();
      this.#checkedThisContainer = true;
      if (result.exitCode !== 0) {
        this.#deps.logger.error('The sandbox does not trust the Cloudflare egress CA; its HTTPS requests will fail', {
          exitCode: result.exitCode,
          output: result.output.slice(0, 500),
        });
      }
    } catch (error) {
      // The exec itself failed, so nothing ran in a container yet; the next command tries again.
      this.#deps.logger.error(
        'Could not check that the sandbox trusts the Cloudflare egress CA',
        extractErrorLogFields(error),
      );
    }
  }
}
