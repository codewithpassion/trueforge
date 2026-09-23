import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDesktopScreen } from '@/hooks/useDesktopScreen.js';
import type { ComputerDesktopServer, DesktopStatus } from '@/server/types.js';

const onlineStatus: DesktopStatus = {
  computerId: 'computer-1',
  online: true,
  desktop: true,
  controller: { kind: 'none' },
  pendingTakeovers: [],
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function lockedError(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error('Another person controls the desktop'), { statusCode: 423, code: 'human_in_control' });
}

function createServer(overrides: Partial<ComputerDesktopServer> = {}): ComputerDesktopServer {
  return {
    getDesktopStatus: vi.fn(async () => onlineStatus),
    getDesktopScreenshot: vi.fn(async () => new Blob(['frame'])),
    sendDesktopInput: vi.fn(async () => new Blob(['after-input'])),
    getDesktopClipboard: vi.fn(async () => ({ text: '' })),
    setDesktopClipboard: vi.fn(async () => undefined),
    takeDesktopControl: vi.fn(async () => onlineStatus),
    handBackDesktop: vi.fn(async () => ({ status: onlineStatus, takeover: null })),
    cancelDesktopTakeover: vi.fn(async () => ({ status: onlineStatus, takeover: null })),
    ...overrides,
  };
}

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  let next = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:frame-${String(++next)}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useDesktopScreen frame polling', () => {
  it('keeps one frame request in flight and polls again 500 ms after it lands', async () => {
    const first = deferred<Blob>();
    const getDesktopScreenshot = vi.fn(() => first.promise);
    const server = createServer({ getDesktopScreenshot });
    renderHook(() => useDesktopScreen({ server, computerId: 'computer-1', agentId: 'agent-1' }));

    await advance(0);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(1);
    expect(getDesktopScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ computerId: 'computer-1', agentId: 'agent-1' }),
    );

    // A slow frame holds back the next one however long it takes.
    await advance(5000);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(1);

    getDesktopScreenshot.mockImplementation(async () => new Blob(['next']));
    await act(async () => {
      first.resolve(new Blob(['first']));
      await Promise.resolve();
    });
    await advance(499);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(2);
  });

  it('shows each frame and revokes the one it replaces', async () => {
    const server = createServer();
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);
    expect(result.current.frame?.url).toBe('blob:frame-1');
    await advance(500);
    expect(result.current.frame?.url).toBe('blob:frame-2');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame-1');
  });

  it('backs off to 2 s while the tab is hidden and catches up when it is shown', async () => {
    const getDesktopScreenshot = vi.fn(async () => new Blob(['frame']));
    const server = createServer({ getDesktopScreenshot });
    renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(1);

    act(() => setVisibility('hidden'));
    await advance(500);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(2);
    // The frame that came back while hidden schedules the next one 2 s out.
    await advance(1999);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(3);

    act(() => setVisibility('visible'));
    await advance(0);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(4);
  });

  it('drops the frame and slows down while another person controls the desktop', async () => {
    const getDesktopScreenshot = vi.fn(async (): Promise<Blob> => new Blob(['frame']));
    const server = createServer({ getDesktopScreenshot });
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);
    expect(result.current.frame).not.toBeNull();

    getDesktopScreenshot.mockRejectedValue(lockedError());
    await advance(500);
    expect(result.current.frameProblem).toEqual({ kind: 'human_in_control' });
    expect(result.current.frame).toBeNull();
    await advance(1999);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(3);
  });

  it('does not ask an offline computer for frames', async () => {
    const getDesktopScreenshot = vi.fn(async () => new Blob(['frame']));
    const server = createServer({
      getDesktopStatus: vi.fn(async () => ({ ...onlineStatus, online: false })),
      getDesktopScreenshot,
    });
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);
    const callsAfterBoot = getDesktopScreenshot.mock.calls.length;
    await advance(3000);
    expect(getDesktopScreenshot.mock.calls.length).toBe(callsAfterBoot);
    expect(result.current.frameProblem).toEqual({ kind: 'offline' });
  });

  it('stops polling on unmount', async () => {
    const getDesktopScreenshot = vi.fn(async () => new Blob(['frame']));
    const server = createServer({ getDesktopScreenshot });
    const { unmount } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);
    unmount();
    await advance(5000);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(1);
  });
});

describe('useDesktopScreen status', () => {
  it('keeps the status an action returned over a poll that started before it', async () => {
    const stale = deferred<DesktopStatus>();
    const getDesktopStatus = vi.fn(() => stale.promise);
    const server = createServer({ getDesktopStatus });
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);

    const mine: DesktopStatus = {
      ...onlineStatus,
      controller: { kind: 'human', userId: 'me', isMe: true, expiresAt: '2026-09-24T10:05:00.000Z' },
    };
    act(() => result.current.applyStatus(mine));
    await act(async () => {
      stale.resolve(onlineStatus);
      await Promise.resolve();
    });
    expect(result.current.status).toEqual(mine);
  });
});

describe('useDesktopScreen input', () => {
  it('batches input about every 100 ms and shows the frame the input returns', async () => {
    const sendDesktopInput = vi.fn(async () => new Blob(['after-input']));
    const getDesktopScreenshot = vi.fn(() => new Promise<Blob>(() => undefined));
    const server = createServer({ sendDesktopInput, getDesktopScreenshot });
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1', agentId: 'agent-1' }));
    await advance(0);

    act(() => {
      result.current.sendInput([{ type: 'mouse_move', x: 1, y: 1 }]);
      result.current.sendInput([{ type: 'mouse_move', x: 5, y: 5 }]);
      result.current.sendInput([{ type: 'type', text: 'hi' }]);
    });
    await advance(99);
    expect(sendDesktopInput).not.toHaveBeenCalled();
    await advance(1);
    expect(sendDesktopInput).toHaveBeenCalledTimes(1);
    expect(sendDesktopInput).toHaveBeenCalledWith({
      computerId: 'computer-1',
      agentId: 'agent-1',
      actions: [
        { type: 'mouse_move', x: 5, y: 5 },
        { type: 'type', text: 'hi' },
      ],
    });
    expect(result.current.frame?.url).toBe('blob:frame-1');
  });

  it('pastes by setting the remote clipboard and then pressing ctrl+v', async () => {
    const calls: string[] = [];
    const server = createServer({
      setDesktopClipboard: vi.fn(async ({ text }: { text: string }) => {
        calls.push(`clipboard:${text}`);
      }),
      sendDesktopInput: vi.fn(async ({ actions }) => {
        calls.push(`input:${JSON.stringify(actions)}`);
        return new Blob(['after-input']);
      }),
    });
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);

    await act(async () => {
      await result.current.pasteText('hunter2');
    });
    expect(calls).toEqual(['clipboard:hunter2', 'input:[{"type":"key","keys":"ctrl+v"}]']);
  });

  it('reports lost control and drops what was queued', async () => {
    const sendDesktopInput = vi.fn(async (): Promise<Blob> => {
      throw Object.assign(new Error('Take control of the desktop first'), { statusCode: 423, code: 'lease_required' });
    });
    const server = createServer({ sendDesktopInput });
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);
    act(() => result.current.sendInput([{ type: 'key', keys: 'Return' }]));
    await advance(100);
    expect(result.current.inputError).toBe('You no longer control the desktop.');
  });
});
