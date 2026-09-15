import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

function severity(level: string): number {
  const index = LEVELS.findIndex(candidate => candidate === level);
  return index === -1 ? LEVELS.indexOf('info') : index;
}

/** `JSON.stringify` drops an Error's message, stack, and cause, so errors become plain fields first. */
function errorFields({ error, seen }: { error: Error; seen: Set<Error> }): Record<string, unknown> {
  seen.add(error);
  const fields = { name: error.name, ...extractErrorLogFields(error) };
  const { cause } = error;
  if (cause === undefined) {
    return fields;
  }
  if (!(cause instanceof Error)) {
    return { ...fields, cause };
  }
  return { ...fields, cause: seen.has(cause) ? '[circular cause]' : errorFields({ error: cause, seen }) };
}

function logValue(value: unknown): unknown {
  return value instanceof Error ? errorFields({ error: value, seen: new Set() }) : value;
}

function metaFields(meta: unknown): Record<string, unknown> {
  if (meta === undefined) {
    return {};
  }
  if (meta instanceof Error) {
    return errorFields({ error: meta, seen: new Set() });
  }
  if (typeof meta !== 'object' || meta === null) {
    return { meta };
  }
  return Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, logValue(value)]));
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
      console[entryLevel](JSON.stringify({ level: entryLevel, message, ...bindings, ...metaFields(meta) }));
    };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: extra => createConsoleLogger({ level, bindings: { ...bindings, ...extra } }),
  };
}
