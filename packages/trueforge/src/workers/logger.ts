import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

function severity(level: string): number {
  const index = LEVELS.findIndex(candidate => candidate === level);
  return index === -1 ? LEVELS.indexOf('info') : index;
}

/** One JSON line per entry on the console, which Workers Logs indexes; drops entries below `level`. */
export function createConsoleLogger({ level, bindings }: { level: string; bindings: Record<string, unknown> }): Logger {
  const minimum = severity(level);
  const write =
    (entryLevel: Level) =>
    (message: string, meta?: unknown): void => {
      if (severity(entryLevel) < minimum) {
        return;
      }
      const fields = typeof meta === 'object' && meta !== null ? meta : meta === undefined ? {} : { meta };
      console[entryLevel](JSON.stringify({ level: entryLevel, message, ...bindings, ...fields }));
    };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: extra => createConsoleLogger({ level, bindings: { ...bindings, ...extra } }),
  };
}
