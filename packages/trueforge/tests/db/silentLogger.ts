import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';

/** No-op logger for store suites that run under both Jest (Node) and vitest-pool-workers (workerd). */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
