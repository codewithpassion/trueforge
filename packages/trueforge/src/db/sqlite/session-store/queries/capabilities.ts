import type { PatchThreadCapabilityStateInput } from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import { sql, type Kysely } from 'kysely';
import { jsonbBind, nowIso } from '../../sqlExpressions';
import type { Database } from '../../types';
import { turnRunning } from '../sqlExpressions';
import { classifyTurnFenceWriteFailure } from './turns';

/**
 * patchThreadCapabilityState — single-statement fenced upsert on the PER-TURN PK.
 * Does NOT bump turn.updated_at.
 * State is bound as SQL NULL when input.state is null (matches Postgres contract).
 */
export async function patchThreadCapabilityState(
  db: Kysely<Database>,
  input: PatchThreadCapabilityStateInput,
): Promise<void> {
  const now = nowIso();
  const stateValue = input.state !== null ? jsonbBind(input.state) : null;

  // The WHERE also disambiguates SQLite's INSERT ... SELECT ... ON CONFLICT parse.
  const result = await db
    .insertInto('thread_capability_state')
    .columns(['session_id', 'turn_id', 'thread_id', 'key', 'state', 'updated_at'])
    .expression(
      sql`SELECT ${input.session_id}, ${input.turn_id}, ${input.thread_id}, ${input.key}, ${stateValue}, ${now}
        WHERE ${turnRunning(input)}`,
    )
    .onConflict(oc =>
      oc.columns(['session_id', 'turn_id', 'thread_id', 'key']).doUpdateSet({
        state: sql`excluded.state`,
        updated_at: sql`excluded.updated_at`,
      }),
    )
    .executeTakeFirst();

  if (Number(result.numInsertedOrUpdatedRows ?? 0n) === 0) {
    await classifyTurnFenceWriteFailure(db, input);
  }
}
