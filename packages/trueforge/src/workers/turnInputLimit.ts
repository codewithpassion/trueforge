import type { TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { D1_MAX_VALUE_BYTES } from '../db/d1/client';
import type { TurnExecutorFailure } from '../runtime/turnExecutor';

/** Turn input too large for D1 to store as one value; undefined when it fits. */
export function turnInputTooLarge(input: TurnInputItem[] | undefined): TurnExecutorFailure | undefined {
  const inputBytes = new TextEncoder().encode(JSON.stringify(input ?? [])).byteLength;
  if (inputBytes <= D1_MAX_VALUE_BYTES) {
    return undefined;
  }
  return {
    ok: false,
    status: 413,
    code: 'turn_input_too_large',
    message: `Turn input is ${String(inputBytes)} bytes; the limit is ${String(D1_MAX_VALUE_BYTES)} bytes`,
  };
}
