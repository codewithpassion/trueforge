import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDesktopScreen } from '@/hooks/useDesktopScreen.js';
import type { ComputerDesktopServer, DesktopAction, DesktopStatus } from '@/server/types.js';

const onlineStatus: DesktopStatus = {
  computerId: 'computer-1',
  online: true,
  desktop: true,
  controller: { kind: 'none' },
  pendingTakeovers: [],
};

const mineStatus: DesktopStatus = {
  ...onlineStatus,
  controller: { kind: 'human', userId: 'me', isMe: true, expiresAt: '2099-01-01T00:00:00.000Z' },
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

  it("refreshes status at once when a frame is refused as another person's while status says nobody controls", async () => {
    const getDesktopStatus = vi.fn(async () => onlineStatus);
    const getDesktopScreenshot = vi.fn(async (): Promise<Blob> => new Blob(['frame']));
    const server = createServer({ getDesktopStatus, getDesktopScreenshot });
    renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);
    expect(getDesktopStatus).toHaveBeenCalledTimes(1);

    getDesktopScreenshot.mockRejectedValue(lockedError());
    // The refusal lands at 500 ms, well before the next 3 s status tick.
    await advance(500);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(2);
    expect(getDesktopStatus).toHaveBeenCalledTimes(2);
  });

  it('stops asking for frames while status says another person controls, and resumes when they let go', async () => {
    const otherStatus: DesktopStatus = {
      ...onlineStatus,
      controller: { kind: 'human', userId: 'someone', isMe: false, expiresAt: '2099-01-01T00:00:00.000Z' },
    };
    const getDesktopStatus = vi.fn(async () => otherStatus);
    const getDesktopScreenshot = vi.fn(async (): Promise<Blob> => {
      throw lockedError();
    });
    const server = createServer({ getDesktopStatus, getDesktopScreenshot });
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);
    // Only the frame asked before any status arrived is refused.
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(1);
    expect(result.current.frameProblem).toEqual({ kind: 'human_in_control' });
    const statusCalls = getDesktopStatus.mock.calls.length;

    await advance(10_000);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(1);
    // Status is watched every 2 s instead.
    expect(getDesktopStatus.mock.calls.length - statusCalls).toBe(5);
    expect(result.current.frame).toBeNull();

    getDesktopStatus.mockResolvedValue(onlineStatus);
    getDesktopScreenshot.mockResolvedValue(new Blob(['frame']));
    // The next status shows them gone, and a frame is asked for straight away.
    await advance(2000);
    await advance(1);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(2);
    expect(result.current.frame).not.toBeNull();
    expect(result.current.frameProblem).toBeNull();
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

describe('useDesktopScreen frame guards', () => {
  it('never starts a second frame request while one is pending, whatever asks for it', async () => {
    const first = deferred<Blob>();
    const getDesktopScreenshot = vi.fn(() => first.promise);
    const server = createServer({ getDesktopScreenshot });
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(1);

    // Coming back to the tab and a delivered input both ask for a frame soon.
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    act(() => result.current.sendInput([{ type: 'key', keys: 'Return' }]));
    await advance(2000);
    expect(server.sendDesktopInput).toHaveBeenCalledTimes(1);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(1);
  });

  it('keeps the frame an input returned over a slower poll that started before it', async () => {
    const poll = deferred<Blob>();
    const getDesktopScreenshot = vi.fn(() => poll.promise);
    const server = createServer({ getDesktopScreenshot });
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);

    act(() => result.current.sendInput([{ type: 'key', keys: 'Return' }]));
    await advance(100);
    expect(result.current.frame?.url).toBe('blob:frame-1');

    await act(async () => {
      poll.resolve(new Blob(['older']));
      await Promise.resolve();
    });
    expect(result.current.frame?.url).toBe('blob:frame-1');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('revokes the shown frame and aborts the pending request on unmount', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const getDesktopScreenshot = vi.fn((req: { signal?: AbortSignal }): Promise<Blob> => {
      signals.push(req.signal);
      return signals.length === 1 ? Promise.resolve(new Blob(['first'])) : new Promise<Blob>(() => undefined);
    });
    const server = createServer({ getDesktopScreenshot });
    const { result, unmount } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);
    expect(result.current.frame?.url).toBe('blob:frame-1');
    await advance(500);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame-1');
    expect(signals[1]?.aborted).toBe(true);
  });

  it('reports a machine that stays down once rather than every tick', async () => {
    const server = createServer({ getDesktopStatus: vi.fn(async () => ({ ...onlineStatus, online: false })) });
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(600);
    const reported = result.current.frameProblem;
    expect(reported).toEqual({ kind: 'offline' });
    await advance(3000);
    expect(result.current.frameProblem).toBe(reported);
  });
});

describe('useDesktopScreen input pacing', () => {
  const RTT_MS = 400;

  function slowServer() {
    const sent: DesktopAction[][] = [];
    const load = { inFlight: 0, max: 0 };
    const server = createServer({
      // The pending frame poll keeps screenshots out of the way.
      getDesktopScreenshot: vi.fn(() => new Promise<Blob>(() => undefined)),
      sendDesktopInput: vi.fn(
        ({ actions }: { actions: DesktopAction[] }) =>
          new Promise<Blob>(resolve => {
            sent.push(actions);
            load.inFlight += 1;
            load.max = Math.max(load.max, load.inFlight);
            setTimeout(() => {
              load.inFlight -= 1;
              resolve(new Blob(['after-input']));
            }, RTT_MS);
          }),
      ),
    });
    return { server, sent, load };
  }

  it('sends one request at a time, merging moves queued during a slow round trip, clicks in order', async () => {
    const { server, sent, load } = slowServer();
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);

    const buttons = ['left', 'right', 'left', 'middle', 'left'] as const;
    // 10 s of pointer moves every 16 ms, with a press and a release every 2 s.
    for (let t = 0; t < 10_000; t += 16) {
      const x = t % 1280;
      act(() => result.current.sendInput([{ type: 'mouse_move', x, y: 10 }]));
      const button = t % 2000 < 16 ? buttons[Math.floor(t / 2000)] : undefined;
      if (button !== undefined) {
        act(() => result.current.sendInput([{ type: 'mouse_down', button }]));
        act(() => result.current.sendInput([{ type: 'mouse_up', button }]));
      }
      await advance(16);
    }
    // The last move reaches the desktop within two round trips, with no backlog still to send.
    await advance(2 * RTT_MS);
    const lastMove = sent.flat().findLast(action => action.type === 'mouse_move');
    expect(lastMove).toEqual({ type: 'mouse_move', x: 9984 % 1280, y: 10 });
    const settled = sent.length;
    await advance(60_000);
    expect(sent).toHaveLength(settled);

    expect(load.max).toBe(1);
    expect(sent.length).toBeLessThanOrEqual(26);
    const presses = sent.flat().filter(action => action.type === 'mouse_down' || action.type === 'mouse_up');
    expect(presses).toEqual(
      buttons.flatMap(button => [
        { type: 'mouse_down', button },
        { type: 'mouse_up', button },
      ]),
    );
    // Only the last move of each run survives, so nothing piles up behind the round trips.
    for (const batch of sent) expect(batch.length).toBeLessThanOrEqual(4);
  });

  it('still sends about ten requests a second on a fast link', async () => {
    // 30 ms round trips, shorter than the batch window but longer than the gap between moves.
    const sendDesktopInput = vi.fn(
      () => new Promise<Blob>(resolve => setTimeout(() => resolve(new Blob(['after-input'])), 30)),
    );
    const server = createServer({
      sendDesktopInput,
      getDesktopScreenshot: vi.fn(() => new Promise<Blob>(() => undefined)),
    });
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);

    for (let t = 0; t < 1000; t += 16) {
      act(() => result.current.sendInput([{ type: 'mouse_move', x: t, y: 10 }]));
      await advance(16);
    }
    await advance(200);
    expect(sendDesktopInput.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it('flushes for hand back without the queued moves, keeping presses and keys', async () => {
    const { server, sent } = slowServer();
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);

    act(() => result.current.sendInput([{ type: 'mouse_move', x: 1, y: 1 }]));
    await advance(100);
    expect(sent).toHaveLength(1);

    act(() =>
      result.current.sendInput([
        { type: 'mouse_move', x: 2, y: 2 },
        { type: 'mouse_up', button: 'left' },
        { type: 'mouse_move', x: 3, y: 3 },
        { type: 'key', keys: 'Return' },
        { type: 'mouse_move', x: 4, y: 4 },
      ]),
    );
    let flushed = false;
    act(() => {
      void result.current.flushInput({ dropMoves: true }).then(() => {
        flushed = true;
      });
    });
    await advance(RTT_MS);
    expect(sent[1]).toEqual([
      { type: 'mouse_up', button: 'left' },
      { type: 'key', keys: 'Return' },
    ]);
    expect(flushed).toBe(false);
    await advance(RTT_MS);
    expect(flushed).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('drops input queued behind a refused request, so none of it lands after control is taken again', async () => {
    const refused = deferred<Blob>();
    const sendDesktopInput = vi.fn((_req: { actions: DesktopAction[] }): Promise<Blob> => refused.promise);
    const server = createServer({
      sendDesktopInput,
      getDesktopScreenshot: vi.fn(() => new Promise<Blob>(() => undefined)),
    });
    const { result } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);

    act(() => result.current.sendInput([{ type: 'type', text: 'first' }]));
    await advance(100);
    act(() => result.current.sendInput([{ type: 'type', text: 'queued' }]));
    await act(async () => {
      refused.reject(Object.assign(new Error('Take control first'), { statusCode: 423, code: 'lease_required' }));
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(sendDesktopInput).toHaveBeenCalledTimes(1);
    expect(result.current.inputError).toBe('You no longer control the desktop.');

    sendDesktopInput.mockImplementation(async () => new Blob(['after-input']));
    act(() => result.current.sendInput([{ type: 'type', text: 'after' }]));
    await advance(100);
    expect(sendDesktopInput).toHaveBeenCalledTimes(2);
    expect(sendDesktopInput.mock.calls[1]?.[0].actions).toEqual([{ type: 'type', text: 'after' }]);
  });
});

describe('useDesktopScreen leaving', () => {
  it('hands control back and sends nothing more when unmounted while in control', async () => {
    const sent: DesktopAction[][] = [];
    const first = deferred<Blob>();
    const sendDesktopInput = vi.fn(({ actions }: { actions: DesktopAction[] }) => {
      sent.push(actions);
      return first.promise;
    });
    const server = createServer({ sendDesktopInput });
    const { result, unmount } = renderHook(() =>
      useDesktopScreen({ server, computerId: 'computer-1', agentId: 'agent-1' }),
    );
    await advance(0);
    act(() => result.current.applyStatus(mineStatus));

    // Three batches' worth of keys; the first is in flight when the view goes away.
    act(() => result.current.sendInput(Array.from({ length: 130 }, (): DesktopAction => ({ type: 'key', keys: 'a' }))));
    await advance(100);
    expect(sent).toHaveLength(1);
    act(() => result.current.sendInput([{ type: 'key', keys: 'b' }]));

    unmount();
    expect(server.handBackDesktop).toHaveBeenCalledWith({ computerId: 'computer-1', agentId: 'agent-1' });
    await act(async () => {
      first.resolve(new Blob(['after-input']));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(sent).toHaveLength(1);
  });

  it('pauses without handing back while in control, and resumes polling when unpaused', async () => {
    const getDesktopScreenshot = vi.fn(async () => new Blob(['frame']));
    const getDesktopStatus = vi.fn(async () => mineStatus);
    const server = createServer({ getDesktopScreenshot, getDesktopStatus });
    const { result, rerender } = renderHook(
      ({ paused }: { paused: boolean }) => useDesktopScreen({ server, computerId: 'computer-1', paused }),
      { initialProps: { paused: false } },
    );
    await advance(0);
    act(() => result.current.applyStatus(mineStatus));

    rerender({ paused: true });
    const frames = getDesktopScreenshot.mock.calls.length;
    const statuses = getDesktopStatus.mock.calls.length;
    await advance(10_000);
    expect(server.handBackDesktop).not.toHaveBeenCalled();
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(frames);
    expect(getDesktopStatus).toHaveBeenCalledTimes(statuses);

    rerender({ paused: false });
    await advance(0);
    expect(getDesktopScreenshot).toHaveBeenCalledTimes(frames + 1);
    expect(getDesktopStatus).toHaveBeenCalledTimes(statuses + 1);
    expect(server.handBackDesktop).not.toHaveBeenCalled();
  });

  it('does not hand back a desktop it was only watching', async () => {
    const server = createServer();
    const { unmount } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);
    unmount();
    expect(server.handBackDesktop).not.toHaveBeenCalled();
  });

  it('ignores a failed best-effort hand back', async () => {
    const server = createServer({
      handBackDesktop: vi.fn(async () => {
        throw Object.assign(new Error('Take control first'), { statusCode: 423, code: 'lease_required' });
      }),
    });
    const { result, unmount } = renderHook(() => useDesktopScreen({ server, computerId: 'computer-1' }));
    await advance(0);
    act(() => result.current.applyStatus(mineStatus));
    unmount();
    await advance(0);
    expect(server.handBackDesktop).toHaveBeenCalledWith({ computerId: 'computer-1' });
  });
});
