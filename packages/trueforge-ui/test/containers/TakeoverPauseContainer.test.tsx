import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ respond: vi.fn(), running: false }));

vi.mock('@assistant-ui/core/react', () => ({ useThreadIsRunning: () => mocks.running }));
vi.mock('@truefoundry/trueforge-assistant-ui-runtime', () => ({
  useTrueForgeToolResponses: () => ({
    pending: [{ toolCallId: 'call-1', threadId: 'main', toolName: 'request_human_takeover', args: {}, argsText: '{}' }],
    respond: mocks.respond,
  }),
}));

import { TakeoverPauseContainer } from '@/containers/TakeoverPauseContainer.js';

beforeEach(() => {
  mocks.respond.mockReset();
  mocks.running = false;
});

describe('TakeoverPauseContainer', () => {
  it('answers the takeover as done with the note, in the Screen page shape', () => {
    render(<TakeoverPauseContainer />);
    fireEvent.change(screen.getByLabelText('Note for the agent'), { target: { value: 'Logged in' } });
    fireEvent.click(screen.getByRole('button', { name: 'It’s done' }));

    expect(mocks.respond).toHaveBeenCalledWith({
      toolCallId: 'call-1',
      content: '{"outcome":"completed","note":"Logged in"}',
    });
  });

  it('cancels without a note', () => {
    render(<TakeoverPauseContainer />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    expect(mocks.respond).toHaveBeenCalledWith({
      toolCallId: 'call-1',
      content: '{"outcome":"cancelled","note":null}',
    });
  });

  it('is read-only for someone who cannot answer in this session', () => {
    render(<TakeoverPauseContainer disabled />);
    expect(screen.getByRole('button', { name: 'It’s done' })).toBeDisabled();
  });
});
