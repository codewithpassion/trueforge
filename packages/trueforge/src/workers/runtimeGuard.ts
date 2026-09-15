import type { ServerConfiguration, WorkersServerConfiguration } from '../config';

/**
 * An unset `TRUEFORGE_RUNTIME` resolves to standalone, where every caller is an admin, so the Worker
 * refuses any configuration that is not explicitly `workers`.
 */
export function assertWorkersRuntime(
  configuration: ServerConfiguration,
): asserts configuration is WorkersServerConfiguration {
  if (configuration.RUNTIME !== 'workers') {
    throw new Error(
      `TRUEFORGE_RUNTIME must be "workers" in the Workers entry, got "${configuration.RUNTIME}"; refusing to serve.`,
    );
  }
}
