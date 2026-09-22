/** How often an invocation that parks for a long time re-checks that it still owns the object. */
export const INSTANCE_LIVENESS_PROBE_MS = 5_000;

/**
 * Throws when this instance no longer owns the object. A superseded instance keeps running whatever
 * it was parked on and is told nothing; the first storage access is where it finds out, so the check
 * is a storage read rather than a flag.
 */
export function probeInstanceAlive(storage: DurableObjectStorage): Promise<number | null> {
  return storage.getAlarm();
}
