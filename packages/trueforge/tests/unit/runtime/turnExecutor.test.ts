import { CancellationReason, TurnNotFoundError } from '@truefoundry/trueforge-core/agent-session';
import { AgentHarnessError, McpConnectionError } from '@truefoundry/trueforge-core/core/errors';
import { HTTPException } from 'hono/http-exception';
import { freezeTurnIgnoringMissing, turnStartFailure } from '../../../src/runtime/turnExecutor';

describe('turnStartFailure', () => {
  it.each([
    [400, 'bad_request'],
    [404, 'not_found'],
    [422, 'unprocessable_entity'],
  ] as const)('maps HTTPException %i to a %s failure', (status, code) => {
    expect(turnStartFailure(new HTTPException(status, { message: 'nope' }))).toEqual({
      ok: false,
      status,
      code,
      message: 'nope',
    });
  });

  it('leaves other HTTP statuses to the caller', () => {
    expect(turnStartFailure(new HTTPException(500, { message: 'boom' }))).toBeUndefined();
    expect(turnStartFailure(new HTTPException(403, { message: 'forbidden' }))).toBeUndefined();
  });

  it('maps a missing session or turn to 404', () => {
    const error = new TurnNotFoundError('t1');
    expect(turnStartFailure(error)).toEqual({ ok: false, status: 404, code: 'not_found', message: error.message });
  });

  it.each([
    ['invalid_file_input', 400],
    ['invalid_send_input', 422],
    ['agent_sandbox_required', 422],
    ['tool_name_collision', 422],
  ] as const)('maps harness code %s to %i and keeps the code', (code, status) => {
    expect(turnStartFailure(new AgentHarnessError(code, 'rejected'))).toEqual({
      ok: false,
      status,
      code,
      message: 'rejected',
    });
  });

  it('treats capability state, MCP connection, and unknown errors as unexpected', () => {
    expect(turnStartFailure(new AgentHarnessError('capability_state_error', 'x'))).toBeUndefined();
    expect(turnStartFailure(new McpConnectionError('down', 502))).toBeUndefined();
    expect(turnStartFailure(new Error('unexpected'))).toBeUndefined();
  });
});

describe('freezeTurnIgnoringMissing', () => {
  it('swallows a missing turn and rethrows anything else', async () => {
    await expect(
      freezeTurnIgnoringMissing(
        { freezeTurn: () => Promise.reject(new TurnNotFoundError('t1')) },
        { turnId: 't1', reason: CancellationReason.ClientCancelled },
      ),
    ).resolves.toBeUndefined();
    await expect(
      freezeTurnIgnoringMissing(
        { freezeTurn: () => Promise.reject(new Error('db down')) },
        { turnId: 't1', reason: CancellationReason.ClientCancelled },
      ),
    ).rejects.toThrow('db down');
  });
});
