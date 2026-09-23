import type { DesktopRequestFailure } from '../server/types.js';

/** The refusal a desktop call rejected with, or null for anything else (network, abort, bug). */
export function readDesktopFailure(error: unknown): DesktopRequestFailure | null {
  if (typeof error !== 'object' || error === null) return null;
  const statusCode: unknown = Reflect.get(error, 'statusCode');
  if (typeof statusCode !== 'number') return null;
  const code: unknown = Reflect.get(error, 'code');
  const message: unknown = Reflect.get(error, 'message');
  return {
    statusCode,
    code: typeof code === 'string' ? code : null,
    message: typeof message === 'string' ? message : '',
  };
}

/** Why the live frame is not showing, as the view explains it. */
export type DesktopFrameProblem =
  | { kind: 'human_in_control' }
  | { kind: 'clearing' }
  | { kind: 'offline' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'failed'; message: string };

export function toFrameProblem(error: unknown): DesktopFrameProblem {
  const failure = readDesktopFailure(error);
  if (failure === null) {
    return { kind: 'failed', message: error instanceof Error ? error.message : 'The frame could not be loaded' };
  }
  if (failure.statusCode === 423) return { kind: 'human_in_control' };
  if (failure.statusCode === 409 && failure.code === 'clearing') return { kind: 'clearing' };
  if (failure.statusCode === 503 && failure.code === 'offline') return { kind: 'offline' };
  if (failure.statusCode === 503) return { kind: 'unavailable', message: failure.message };
  return { kind: 'failed', message: failure.message || `Request failed (${String(failure.statusCode)})` };
}
