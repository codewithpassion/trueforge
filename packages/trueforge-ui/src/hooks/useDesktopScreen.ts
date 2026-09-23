'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ComputerDesktopServer, DesktopAction, DesktopStatus } from '../server/types.js';
import { readDesktopFailure, toFrameProblem, type DesktopFrameProblem } from '../utils/desktopFailure.js';
import { packActions } from '../utils/desktopInput.js';

export const FRAME_INTERVAL_MS = 500;
export const HIDDEN_FRAME_INTERVAL_MS = 2000;
export const STATUS_INTERVAL_MS = 3000;
const HIDDEN_STATUS_INTERVAL_MS = 10_000;
export const INPUT_BATCH_MS = 100;
/** Refresh the lease expiry after input once it is this close, so the warning clears promptly. */
const EXPIRY_REFRESH_WINDOW_MS = 90_000;

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export type DesktopScreenTarget = {
  server: ComputerDesktopServer;
  computerId: string;
  /** Omitted only by a tenant admin looking at the computer itself. */
  agentId?: string;
};

export type DesktopFrame = { url: string; receivedAt: number };

/**
 * Polls one desktop's frames and status and sends input while the caller holds control.
 * Frames live only as the one object URL on screen; each replaces and revokes the last.
 */
export function useDesktopScreen({ server, computerId, agentId }: DesktopScreenTarget) {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [frame, setFrame] = useState<DesktopFrame | null>(null);
  const [frameProblem, setFrameProblem] = useState<DesktopFrameProblem | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);

  const scope = agentId === undefined ? {} : { agentId };
  const scopeRef = useRef({ server, computerId, ...scope });
  scopeRef.current = { server, computerId, ...scope };

  const frameUrlRef = useRef<string | null>(null);
  // Frames are applied newest-request-first, so a slow poll never paints over an input's frame.
  const frameSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const statusRef = useRef<DesktopStatus | null>(null);
  const frameProblemRef = useRef<DesktopFrameProblem | null>(null);
  const pollFrameSoonRef = useRef<(delayMs: number) => void>(() => undefined);
  const refreshStatusRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const queueRef = useRef<DesktopAction[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingRef = useRef<Promise<void>>(Promise.resolve());
  const activeRef = useRef(true);

  const applyStatus = useCallback((next: DesktopStatus) => {
    statusRef.current = next;
    setStatus(next);
    setStatusError(null);
  }, []);

  const showFrame = useCallback((blob: Blob, seq: number) => {
    if (!activeRef.current || seq < appliedSeqRef.current) return;
    appliedSeqRef.current = seq;
    const url = URL.createObjectURL(blob);
    const previous = frameUrlRef.current;
    frameUrlRef.current = url;
    if (previous !== null) URL.revokeObjectURL(previous);
    setFrame({ url, receivedAt: Date.now() });
    frameProblemRef.current = null;
    setFrameProblem(null);
  }, []);

  const dropFrame = useCallback(() => {
    const previous = frameUrlRef.current;
    frameUrlRef.current = null;
    if (previous !== null) URL.revokeObjectURL(previous);
    setFrame(null);
  }, []);

  // Status: one request at a time, slower while the tab is hidden.
  useEffect(() => {
    activeRef.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;

    const load = (): Promise<void> => {
      if (inFlight !== null) return inFlight;
      const { server: port, ...req } = scopeRef.current;
      inFlight = port
        .getDesktopStatus(req)
        .then(next => {
          if (!stopped) applyStatus(next);
        })
        .catch((error: unknown) => {
          if (stopped) return;
          const failure = readDesktopFailure(error);
          setStatusError(failure?.message || (error instanceof Error ? error.message : 'Could not read the desktop'));
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    };
    const tick = () => {
      timer = null;
      void load().finally(() => {
        if (!stopped) timer = setTimeout(tick, isHidden() ? HIDDEN_STATUS_INTERVAL_MS : STATUS_INTERVAL_MS);
      });
    };
    refreshStatusRef.current = load;
    tick();
    return () => {
      stopped = true;
      activeRef.current = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [computerId, agentId, applyStatus]);

  // Frames: one request at a time, every 500 ms while visible and every 2 s while hidden.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let controller: AbortController | null = null;

    const interval = () =>
      isHidden() || frameProblemRef.current?.kind === 'human_in_control' ? HIDDEN_FRAME_INTERVAL_MS : FRAME_INTERVAL_MS;
    const schedule = (delayMs: number) => {
      if (stopped || inFlight) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(tick, delayMs);
    };
    const tick = () => {
      timer = null;
      const known = statusRef.current;
      // A machine known to be down has no frame to give; status polling notices when it is back.
      if (known !== null && (!known.online || !known.desktop)) {
        frameProblemRef.current = known.online ? { kind: 'unavailable', message: '' } : { kind: 'offline' };
        setFrameProblem(frameProblemRef.current);
        schedule(interval());
        return;
      }
      inFlight = true;
      controller = new AbortController();
      const seq = ++frameSeqRef.current;
      const { server: port, ...req } = scopeRef.current;
      void port
        .getDesktopScreenshot({ ...req, signal: controller.signal })
        .then(blob => {
          if (!stopped) showFrame(blob, seq);
        })
        .catch((error: unknown) => {
          if (stopped) return;
          const problem = toFrameProblem(error);
          frameProblemRef.current = problem;
          setFrameProblem(problem);
          // Another person's screen is theirs alone, so nothing of it stays on this one.
          if (problem.kind === 'human_in_control') dropFrame();
        })
        .finally(() => {
          inFlight = false;
          controller = null;
          schedule(interval());
        });
    };
    const onVisibilityChange = () => {
      if (!isHidden()) schedule(0);
    };
    pollFrameSoonRef.current = schedule;
    document.addEventListener('visibilitychange', onVisibilityChange);
    tick();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      pollFrameSoonRef.current = () => undefined;
    };
  }, [computerId, agentId, showFrame, dropFrame]);

  // Released frames and queued input belong to this desktop only.
  useEffect(
    () => () => {
      if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
      queueRef.current = [];
      const previous = frameUrlRef.current;
      frameUrlRef.current = null;
      if (previous !== null) URL.revokeObjectURL(previous);
    },
    [computerId, agentId],
  );

  const sendBatches = useCallback(
    async (actions: DesktopAction[]) => {
      for (const batch of packActions(actions)) {
        const seq = ++frameSeqRef.current;
        const { server: port, ...req } = scopeRef.current;
        try {
          const blob = await port.sendDesktopInput({ ...req, actions: batch });
          showFrame(blob, seq);
          setInputError(null);
          pollFrameSoonRef.current(FRAME_INTERVAL_MS);
        } catch (error: unknown) {
          const failure = readDesktopFailure(error);
          setInputError(
            failure?.statusCode === 423
              ? 'You no longer control the desktop.'
              : failure?.message || (error instanceof Error ? error.message : 'Input was not delivered'),
          );
          queueRef.current = [];
          void refreshStatusRef.current();
          return;
        }
      }
      const controller = statusRef.current?.controller;
      if (controller?.kind === 'human' && Date.parse(controller.expiresAt) - Date.now() < EXPIRY_REFRESH_WINDOW_MS) {
        void refreshStatusRef.current();
      }
    },
    [showFrame],
  );

  /** Sends everything queued now; resolves once it and anything before it was delivered. */
  const flushInput = useCallback((): Promise<void> => {
    if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
    const pending = queueRef.current;
    queueRef.current = [];
    if (pending.length > 0) {
      sendingRef.current = sendingRef.current.then(() => sendBatches(pending));
    }
    return sendingRef.current;
  }, [sendBatches]);

  /** Queues input; it goes out in one batch about every 100 ms. */
  const sendInput = useCallback(
    (actions: DesktopAction[]) => {
      if (actions.length === 0) return;
      queueRef.current.push(...actions);
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(() => {
          void flushInput();
        }, INPUT_BATCH_MS);
      }
    },
    [flushInput],
  );

  /** Puts local text on the remote clipboard (CLIPBOARD and PRIMARY) and pastes it with ctrl+v. */
  const pasteText = useCallback(
    async (text: string) => {
      await flushInput();
      const { server: port, ...req } = scopeRef.current;
      await port.setDesktopClipboard({ ...req, text });
      sendInput([{ type: 'key', keys: 'ctrl+v' }]);
      await flushInput();
    },
    [flushInput, sendInput],
  );

  const refreshStatus = useCallback(() => refreshStatusRef.current(), []);

  return {
    status,
    statusError,
    frame,
    frameProblem,
    inputError,
    applyStatus,
    refreshStatus,
    sendInput,
    flushInput,
    pasteText,
  };
}
