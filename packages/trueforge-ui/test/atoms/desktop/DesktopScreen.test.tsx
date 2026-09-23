import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopScreen } from '@/atoms/desktop/DesktopScreen.js';
import type {
  ComputerDesktopServer,
  DesktopController,
  DesktopStatus,
  DesktopTakeoverAnswer,
  PendingDesktopTakeover,
} from '@/server/types.js';

const takeover: PendingDesktopTakeover = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'call-1',
  reason: 'Log into the supplier portal as accounts@example.com',
  requestedAt: '2026-09-24T10:00:00.000Z',
  agentId: 'agent-1',
};

function status(controller: DesktopController, pendingTakeovers: PendingDesktopTakeover[] = []): DesktopStatus {
  return { computerId: 'computer-1', online: true, desktop: true, controller, pendingTakeovers };
}

const mine = (expiresInMs = 5 * 60_000): DesktopController => ({
  kind: 'human',
  userId: 'user-me',
  isMe: true,
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
});

function createServer(overrides: Partial<ComputerDesktopServer> = {}): ComputerDesktopServer {
  return {
    getDesktopStatus: vi.fn(async () => status({ kind: 'none' })),
    getDesktopScreenshot: vi.fn(async () => new Blob(['frame'])),
    sendDesktopInput: vi.fn(async () => new Blob(['after-input'])),
    getDesktopClipboard: vi.fn(async () => ({ text: 'copied text' })),
    setDesktopClipboard: vi.fn(async () => undefined),
    takeDesktopControl: vi.fn(async () => status(mine())),
    handBackDesktop: vi.fn(async () => ({ status: status({ kind: 'none' }), takeover: null })),
    cancelDesktopTakeover: vi.fn(async () => ({ status: status({ kind: 'none' }), takeover: null })),
    ...overrides,
  };
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// jsdom has no PointerEvent, so pointer events would arrive without coordinates or button.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

beforeEach(() => {
  if (!('PointerEvent' in window)) {
    Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent });
  }
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:frame');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function renderInControl(server: ComputerDesktopServer) {
  render(<DesktopScreen server={server} computerId="computer-1" agentId="agent-1" />);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
  await settle();
}

describe('DesktopScreen', () => {
  it('shows a placeholder instead of the frame while another person has control', async () => {
    const server = createServer({
      getDesktopStatus: vi.fn(async () =>
        status({ kind: 'human', userId: 'someone', isMe: false, expiresAt: new Date().toISOString() }),
      ),
      getDesktopScreenshot: vi.fn(async (): Promise<Blob> => {
        throw Object.assign(new Error('Another person controls the desktop'), {
          statusCode: 423,
          code: 'human_in_control',
        });
      }),
    });
    render(<DesktopScreen server={server} computerId="computer-1" agentId="agent-1" />);
    await settle();

    expect(screen.getByTestId('desktop-placeholder')).toHaveTextContent('Another person is controlling the desktop');
    expect(screen.queryByRole('img', { name: 'Remote desktop' })).toBeNull();
    expect(screen.getByText(/Another person is in control/)).toBeInTheDocument();
  });

  it('shows the live frame to a viewer and keeps input off until they take control', async () => {
    const server = createServer();
    render(<DesktopScreen server={server} computerId="computer-1" agentId="agent-1" />);
    await settle();
    expect(screen.getByRole('img', { name: 'Remote desktop' })).toHaveAttribute('src', 'blob:frame');

    fireEvent.keyDown(screen.getByLabelText('Desktop keyboard'), { key: 'Enter' });
    await settle(200);
    expect(server.sendDesktopInput).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Copy from remote' })).toBeDisabled();
  });

  it('types printable text from input events and sends chords from keydown', async () => {
    const server = createServer();
    await renderInControl(server);
    expect(server.takeDesktopControl).toHaveBeenCalledWith({ computerId: 'computer-1', agentId: 'agent-1' });
    const keyboard = screen.getByLabelText('Desktop keyboard');

    // A plain letter is left to the input event, so it is not sent twice.
    fireEvent.keyDown(keyboard, { key: 'é', code: 'Digit2' });
    keyboard.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'é', cancelable: true }));
    fireEvent.keyDown(keyboard, { key: 'l', code: 'KeyL', ctrlKey: true });
    fireEvent.keyDown(keyboard, { key: 'Enter' });
    await settle(100);

    expect(server.sendDesktopInput).toHaveBeenCalledWith({
      computerId: 'computer-1',
      agentId: 'agent-1',
      actions: [
        { type: 'type', text: 'é' },
        { type: 'key', keys: 'ctrl+l' },
        { type: 'key', keys: 'Return' },
      ],
    });
  });

  it('maps pointer presses onto desktop pixels', async () => {
    const server = createServer();
    await renderInControl(server);
    const frame = screen.getByTestId('desktop-frame');
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 640, height: 400 }));

    fireEvent.pointerDown(frame, { clientX: 320, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(frame, { clientX: 320, clientY: 100, button: 0, pointerId: 1 });
    await settle(100);

    expect(server.sendDesktopInput).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [
          { type: 'mouse_move', x: 640, y: 200 },
          { type: 'mouse_down', button: 'left' },
          { type: 'mouse_move', x: 640, y: 200 },
          { type: 'mouse_up', button: 'left' },
        ],
      }),
    );
  });

  it('sends the browser-reserved chords from the toolbar', async () => {
    const server = createServer();
    await renderInControl(server);
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+W' }));
    await settle(100);
    expect(server.sendDesktopInput).toHaveBeenCalledWith(
      expect.objectContaining({ actions: [{ type: 'key', keys: 'ctrl+w' }] }),
    );
  });

  it('hands back to the selected request with the note and says when the agent already had an answer', async () => {
    const handBackDesktop = vi.fn(async (): Promise<DesktopTakeoverAnswer> => ({
      status: status({ kind: 'none' }),
      takeover: {
        sessionId: 'session-1',
        result: 'already_answered',
        message: 'The agent already got an answer in chat',
      },
    }));
    const server = createServer({
      getDesktopStatus: vi.fn(async () => status({ kind: 'none' }, [takeover])),
      takeDesktopControl: vi.fn(async () => status(mine(), [takeover])),
      handBackDesktop,
    });
    await renderInControl(server);

    expect(screen.getByText(takeover.reason)).toBeInTheDocument();
    // The only pending request is chosen for the person.
    expect(screen.getByRole('radio')).toBeChecked();
    fireEvent.change(screen.getByLabelText('Note for the agent (optional)'), { target: { value: 'Logged in' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hand back to agent' }));
    await settle();

    expect(handBackDesktop).toHaveBeenCalledWith({
      computerId: 'computer-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      note: 'Logged in',
    });
    expect(screen.getByText('The agent already got an answer in chat')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take control' })).toBeInTheDocument();
  });

  it('lets a viewer cancel a pending request without taking control', async () => {
    const cancelDesktopTakeover = vi.fn(async (): Promise<DesktopTakeoverAnswer> => ({
      status: status({ kind: 'none' }),
      takeover: { sessionId: 'session-1', result: 'resumed', message: 'The agent continues' },
    }));
    const server = createServer({
      getDesktopStatus: vi.fn(async () => status({ kind: 'agent', sessionId: 'session-2' }, [takeover])),
      cancelDesktopTakeover,
    });
    render(<DesktopScreen server={server} computerId="computer-1" agentId="agent-1" />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await settle();
    expect(cancelDesktopTakeover).toHaveBeenCalledWith({
      computerId: 'computer-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
    });
    expect(screen.getByText('The agent continues')).toBeInTheDocument();
  });

  it('warns in the last minute of control', async () => {
    const server = createServer({ takeDesktopControl: vi.fn(async () => status(mine(45_000))) });
    await renderInControl(server);
    expect(screen.getByRole('alert')).toHaveTextContent(/Control ends in 4\ds unless you use the desktop/);
  });

  it('pastes the local clipboard onto the desktop', async () => {
    const server = createServer();
    await renderInControl(server);
    fireEvent.paste(screen.getByLabelText('Desktop keyboard'), {
      clipboardData: { getData: (type: string) => (type === 'text/plain' ? 's3cret' : '') },
    });
    await settle(100);
    expect(server.setDesktopClipboard).toHaveBeenCalledWith({
      computerId: 'computer-1',
      agentId: 'agent-1',
      text: 's3cret',
    });
    expect(server.sendDesktopInput).toHaveBeenCalledWith(
      expect.objectContaining({ actions: [{ type: 'key', keys: 'ctrl+v' }] }),
    );
  });

  it('ignores typing and pasting that reach the keyboard while not in control', async () => {
    const server = createServer();
    render(<DesktopScreen server={server} computerId="computer-1" agentId="agent-1" />);
    await settle();
    const keyboard = screen.getByLabelText('Desktop keyboard');

    keyboard.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', cancelable: true }));
    keyboard.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', cancelable: true }));
    fireEvent.paste(keyboard, { clipboardData: { getData: () => 's3cret' } });
    await settle(500);

    expect(server.sendDesktopInput).not.toHaveBeenCalled();
    expect(server.setDesktopClipboard).not.toHaveBeenCalled();
  });

  it('types text once when the browser lets the text land despite beforeinput', async () => {
    const server = createServer();
    await renderInControl(server);
    const keyboard = screen.getByLabelText<HTMLTextAreaElement>('Desktop keyboard');

    // An uncancellable beforeinput already sent the text, which then lands in the field anyway.
    keyboard.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'a', cancelable: false }));
    keyboard.value = 'a';
    fireEvent.input(keyboard);
    await settle(100);

    expect(server.sendDesktopInput).toHaveBeenCalledTimes(1);
    expect(server.sendDesktopInput).toHaveBeenCalledWith(
      expect.objectContaining({ actions: [{ type: 'type', text: 'a' }] }),
    );
    expect(keyboard.value).toBe('');
  });

  it('types from input events in a browser without beforeinput', async () => {
    const server = createServer();
    await renderInControl(server);
    const keyboard = screen.getByLabelText<HTMLTextAreaElement>('Desktop keyboard');
    keyboard.value = 'b';
    fireEvent.input(keyboard);
    await settle(100);
    expect(server.sendDesktopInput).toHaveBeenCalledWith(
      expect.objectContaining({ actions: [{ type: 'type', text: 'b' }] }),
    );
  });

  it('lets go of held buttons when the pointer is cancelled, loses capture or the window loses focus', async () => {
    const server = createServer();
    await renderInControl(server);
    const frame = screen.getByTestId('desktop-frame');
    expect(frame).toHaveClass('touch-none');
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 640, height: 400 }));
    const sentActions = () => vi.mocked(server.sendDesktopInput).mock.calls.flatMap(([req]) => req.actions);

    fireEvent.pointerDown(frame, { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
    fireEvent.pointerCancel(frame, { pointerId: 1 });
    fireEvent.pointerDown(frame, { clientX: 10, clientY: 10, button: 2, pointerId: 1 });
    fireEvent.lostPointerCapture(frame, { pointerId: 1 });
    fireEvent.pointerDown(frame, { clientX: 10, clientY: 10, button: 1, pointerId: 1 });
    fireEvent(window, new Event('blur'));
    await settle(100);

    expect(sentActions().filter(action => action.type !== 'mouse_move')).toEqual([
      { type: 'mouse_down', button: 'left' },
      { type: 'mouse_up', button: 'left' },
      { type: 'mouse_down', button: 'right' },
      { type: 'mouse_up', button: 'right' },
      { type: 'mouse_down', button: 'middle' },
      { type: 'mouse_up', button: 'middle' },
    ]);
  });

  it('does not release a button twice when capture ends after a normal release', async () => {
    const server = createServer();
    await renderInControl(server);
    const frame = screen.getByTestId('desktop-frame');
    fireEvent.pointerDown(frame, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(frame, { button: 0, pointerId: 1 });
    fireEvent.lostPointerCapture(frame, { pointerId: 1 });
    await settle(100);
    const ups = vi
      .mocked(server.sendDesktopInput)
      .mock.calls.flatMap(([req]) => req.actions)
      .filter(action => action.type === 'mouse_up');
    expect(ups).toHaveLength(1);
  });

  it('releases a held button before handing back', async () => {
    const calls: string[] = [];
    const server = createServer({
      sendDesktopInput: vi.fn(async ({ actions }) => {
        calls.push(`input:${actions.map(action => action.type).join(',')}`);
        return new Blob(['after-input']);
      }),
      handBackDesktop: vi.fn(async () => {
        calls.push('hand-back');
        return { status: status({ kind: 'none' }), takeover: null };
      }),
    });
    await renderInControl(server);
    const frame = screen.getByTestId('desktop-frame');
    fireEvent.pointerDown(frame, { button: 0, pointerId: 1 });
    await settle(100);
    fireEvent.pointerMove(frame, { pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Hand back' }));
    await settle();

    // The pending move is dropped; the release still goes, and before the hand back.
    expect(calls).toEqual(['input:mouse_move,mouse_down', 'input:mouse_up', 'hand-back']);
  });

  it('gives the keyboard back to the page on Ctrl+Alt+Shift and shows when it is captured', async () => {
    const server = createServer();
    await renderInControl(server);
    const keyboard = screen.getByLabelText('Desktop keyboard');
    const view = screen.getByTestId('desktop-view');
    expect(keyboard).toHaveFocus();
    expect(view).toHaveClass('ring-2');
    expect(screen.getByText(/press Ctrl\+Alt\+Shift to give the keyboard back/)).toBeInTheDocument();

    fireEvent.keyDown(keyboard, { key: 'Control', ctrlKey: true });
    fireEvent.keyDown(keyboard, { key: 'Alt', ctrlKey: true, altKey: true });
    fireEvent.keyDown(keyboard, { key: 'Shift', ctrlKey: true, altKey: true, shiftKey: true });
    await settle(100);

    expect(keyboard).not.toHaveFocus();
    expect(view).not.toHaveClass('ring-2');
    expect(server.sendDesktopInput).not.toHaveBeenCalled();
  });

  it('dims the last frame and says why once the computer goes offline', async () => {
    const getDesktopStatus = vi.fn(async () => status({ kind: 'none' }));
    const server = createServer({ getDesktopStatus });
    render(<DesktopScreen server={server} computerId="computer-1" agentId="agent-1" />);
    await settle();
    expect(screen.getByRole('img', { name: 'Remote desktop' })).not.toHaveClass('opacity-40');
    expect(screen.queryByTestId('desktop-stale-label')).toBeNull();

    getDesktopStatus.mockResolvedValue({ ...status({ kind: 'none' }), online: false });
    await settle(3000);
    expect(screen.getByRole('img', { name: 'Remote desktop' })).toHaveClass('opacity-40');
    expect(screen.getByTestId('desktop-stale-label')).toHaveTextContent('The computer is offline.');
  });

  it('labels a stale frame while the last person’s clipboard is being cleared', async () => {
    const getDesktopScreenshot = vi.fn(async (): Promise<Blob> => new Blob(['frame']));
    const server = createServer({ getDesktopScreenshot });
    render(<DesktopScreen server={server} computerId="computer-1" agentId="agent-1" />);
    await settle();
    getDesktopScreenshot.mockRejectedValue(Object.assign(new Error('Clearing'), { statusCode: 409, code: 'clearing' }));
    await settle(500);
    expect(screen.getByRole('img', { name: 'Remote desktop' })).toHaveClass('opacity-40');
    expect(screen.getByTestId('desktop-stale-label')).toHaveTextContent('Clearing the last person’s clipboard…');
  });

  it('clears clipboard text left to copy by hand once control ends', async () => {
    const server = createServer();
    await renderInControl(server);
    fireEvent.click(screen.getByRole('button', { name: 'Copy from remote' }));
    await settle();
    expect(screen.getByDisplayValue('copied text')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hand back' }));
    await settle();
    expect(screen.queryByDisplayValue('copied text')).toBeNull();
  });
});
