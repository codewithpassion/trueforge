import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Respond = (
  response: { toolCallId: string; content: string },
  options?: { onSendError?: (error: unknown) => boolean },
) => void;

const mocks = vi.hoisted(() => ({
  respond: vi.fn<Respond>(),
  running: false,
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));

vi.mock('@assistant-ui/core/react', () => ({ useThreadIsRunning: () => mocks.running }));
vi.mock('@truefoundry/trueforge-assistant-ui-runtime', () => ({
  useTrueForgeToolResponses: () => ({
    pending: [{ toolCallId: 'call-1', threadId: 'main', toolName: 'request_human_takeover', args: {}, argsText: '{}' }],
    respond: mocks.respond,
  }),
}));
vi.mock('@/containers/ToasterContainer.js', () => ({
  useToasterOptional: () => ({ showSuccess: mocks.showSuccess, showError: mocks.showError }),
}));

import { TakeoverPauseContainer } from '@/containers/TakeoverPauseContainer.js';

beforeEach(() => {
  mocks.respond.mockReset();
  mocks.showSuccess.mockReset();
  mocks.running = false;
});

function conflict(code: string) {
  return Object.assign(new Error('ConflictError'), {
    statusCode: 409,
    body: { error: { code, message: 'Turn t-1 is still running; answer its tool calls once it has finished' } },
  });
}

/** The send-error handler the last answer passed to the runtime. */
function lastSendErrorHandler(): (error: unknown) => boolean {
  const handler = mocks.respond.mock.lastCall?.[1]?.onSendError;
  if (handler === undefined) throw new Error('respond was not given onSendError');
  return handler;
}

describe('TakeoverPauseContainer', () => {
  it('answers the takeover as done with the note, in the Screen page shape', () => {
    render(<TakeoverPauseContainer />);
    fireEvent.change(screen.getByLabelText('Note for the agent'), { target: { value: 'Logged in' } });
    fireEvent.click(screen.getByRole('button', { name: 'It’s done' }));

    expect(mocks.respond).toHaveBeenCalledWith(
      { toolCallId: 'call-1', content: '{"outcome":"completed","note":"Logged in"}' },
      { onSendError: expect.any(Function) },
    );
  });

  it('cancels without a note', () => {
    render(<TakeoverPauseContainer />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    expect(mocks.respond).toHaveBeenCalledWith(
      { toolCallId: 'call-1', content: '{"outcome":"cancelled","note":null}' },
      { onSendError: expect.any(Function) },
    );
  });

  it.each(['tip_running', 'already_answered'])(
    'says someone else already answered when the send is refused with 409 %s',
    code => {
      render(<TakeoverPauseContainer />);
      fireEvent.click(screen.getByRole('button', { name: 'It’s done' }));

      expect(lastSendErrorHandler()(conflict(code))).toBe(true);
      expect(mocks.showSuccess).toHaveBeenCalledWith({
        title: 'Someone else already answered this request; the agent is continuing.',
      });
    },
  );

  it('leaves other failures to the usual error report', () => {
    render(<TakeoverPauseContainer />);
    fireEvent.click(screen.getByRole('button', { name: 'It’s done' }));
    const handle = lastSendErrorHandler();

    expect(handle(conflict('fork_conflict'))).toBe(false);
    expect(handle(Object.assign(new Error('boom'), { statusCode: 500 }))).toBe(false);
    expect(mocks.showSuccess).not.toHaveBeenCalled();
  });

  it('is read-only for someone who cannot answer in this session', () => {
    render(<TakeoverPauseContainer disabled />);
    expect(screen.getByRole('button', { name: 'It’s done' })).toBeDisabled();
  });
});
