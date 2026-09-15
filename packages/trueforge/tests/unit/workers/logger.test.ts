import { createConsoleLogger } from '../../../src/workers/logger';

function loggedEntries(spy: jest.SpyInstance): unknown[] {
  return spy.mock.calls.map(([line]: unknown[]) => JSON.parse(String(line)));
}

describe('createConsoleLogger', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('logs the message and stack of an Error passed as meta', () => {
    const logger = createConsoleLogger({ level: 'info', bindings: { component: 'test' } });

    logger.error('Pass failed', new Error('D1 is unavailable'));

    expect(loggedEntries(consoleError)).toEqual([
      expect.objectContaining({
        level: 'error',
        message: 'Pass failed',
        component: 'test',
        name: 'Error',
        error: 'D1 is unavailable',
        stack: expect.stringContaining('D1 is unavailable'),
      }),
    ]);
  });

  it('logs an Error field with its cause chain and keeps other fields as they are', () => {
    const logger = createConsoleLogger({ level: 'info', bindings: {} });
    const inner = new Error('UNIQUE constraint failed: schedule_run.name');
    inner.name = 'D1Error';
    const outer = new Error('Schedule run already exists', { cause: inner });
    outer.name = 'ScheduleRunConflictError';

    logger.error('Failed to process scheduled run', { run_id: 'run-1', error: outer });

    expect(loggedEntries(consoleError)).toEqual([
      expect.objectContaining({
        run_id: 'run-1',
        error: {
          name: 'ScheduleRunConflictError',
          error: 'Schedule run already exists',
          stack: expect.any(String),
          cause: {
            name: 'D1Error',
            error: 'UNIQUE constraint failed: schedule_run.name',
            stack: expect.any(String),
          },
        },
      }),
    ]);
  });

  it('stops at a circular cause chain', () => {
    const logger = createConsoleLogger({ level: 'info', bindings: {} });
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;

    logger.error('Circular', { error: first });

    expect(loggedEntries(consoleError)).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          error: 'first',
          cause: expect.objectContaining({ error: 'second', cause: '[circular cause]' }),
        }),
      }),
    ]);
  });
});
