'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { useDesktopScreen, type DesktopFrame } from '../../hooks/useDesktopScreen.js';
import { Icon } from '../../icons/Icon.js';
import type {
  ComputerDesktopServer,
  DesktopAction,
  DesktopController,
  DesktopMouseButton,
  DesktopStatus,
  DesktopTakeoverResult,
  PendingDesktopTakeover,
} from '../../server/types.js';
import { readDesktopFailure, type DesktopFrameProblem } from '../../utils/desktopFailure.js';
import {
  DESKTOP_SCREEN,
  isMacPlatform,
  isPasteChord,
  isReleaseChord,
  keydownToKeys,
  toDesktopButton,
  toDesktopPoint,
  typeActions,
  wheelToClicks,
  type WheelRemainder,
} from '../../utils/desktopInput.js';
import { cn } from '../lib/cn.js';
import { auiInputClass } from '../lib/inputClasses.js';
import { Button } from '../primitives/Button.js';

/** A human lease lasts 5 minutes without input; warn in its last minute. */
const LEASE_WARNING_MS = 60_000;
const NOTE_MAX_CHARS = 2000;

/** Chords the local browser keeps for itself, so they can only reach the desktop from here. */
const RESERVED_CHORDS: { label: string; keys: string }[] = [
  { label: 'Ctrl+W', keys: 'ctrl+w' },
  { label: 'Ctrl+T', keys: 'ctrl+t' },
  { label: 'Ctrl+L', keys: 'ctrl+l' },
  { label: 'Super', keys: 'super' },
];

export type DesktopScreenProps = {
  server: ComputerDesktopServer;
  computerId: string;
  /** The saved agent whose desktop this is; omitted only by a tenant admin. */
  agentId?: string;
  /** Preselects this session's pending takeover, as the session panel does. */
  sessionId?: string;
  /** Stacks the controls for a narrow panel. */
  compact?: boolean;
  className?: string;
};

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function isMine(controller: DesktopController | undefined): boolean {
  return controller?.kind === 'human' && controller.isMe;
}

function controllerLabel(controller: DesktopController): string {
  switch (controller.kind) {
    case 'none':
      return 'Nobody is in control';
    case 'agent':
      return 'The agent is in control';
    case 'human':
      return controller.isMe ? 'You are in control' : 'Another person is in control';
    case 'clearing':
      return 'Clearing the last person’s clipboard';
  }
}

function frameAgeLabel({ frame, now }: { frame: DesktopFrame | null; now: number }): string {
  if (frame === null) return 'No frame yet';
  const seconds = Math.max(0, Math.round((now - frame.receivedAt) / 1000));
  return seconds <= 1 ? 'Live' : `Frame ${String(seconds)}s old`;
}

/** Why the view is not live, or null while it is. */
function problemText({
  problem,
  status,
}: {
  problem: DesktopFrameProblem | null;
  status: DesktopStatus | null;
}): string | null {
  if (status !== null && !status.online) return 'The computer is offline.';
  if (status !== null && !status.desktop) return 'The computer is not running a desktop.';
  if (problem === null) return null;
  switch (problem.kind) {
    case 'human_in_control':
      return 'Another person is controlling the desktop. The view comes back when they hand it back.';
    case 'clearing':
      return 'Clearing the last person’s clipboard…';
    case 'offline':
      return 'The computer is offline.';
    case 'unavailable':
      return problem.message || 'The desktop is not available right now.';
    case 'failed':
      return problem.message;
  }
}

function Placeholder({ text }: { text: string }) {
  return (
    <div
      role="status"
      className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-text-secondary"
      data-testid="desktop-placeholder"
    >
      {text}
    </div>
  );
}

/** The server words the outcome; only the tone is decided here. */
function takeoverOutcomeText(takeover: DesktopTakeoverResult): { tone: 'success' | 'warning'; text: string } {
  return { tone: takeover.result === 'resumed' ? 'success' : 'warning', text: takeover.message };
}

function PendingTakeovers({
  takeovers,
  selected,
  onSelect,
}: {
  takeovers: PendingDesktopTakeover[];
  selected: string | null;
  onSelect: (sessionId: string) => void;
}) {
  return (
    <fieldset className="rounded-lg border border-warning-bg/40 bg-warning-bg/10 p-3">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
        {takeovers.length === 1 ? 'An agent is waiting for you' : `${String(takeovers.length)} agents are waiting`}
      </legend>
      <ul className="flex flex-col gap-2">
        {takeovers.map(takeover => (
          <li key={takeover.sessionId}>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-text-primary">
              <input
                type="radio"
                name="desktop-takeover"
                className="mt-1"
                checked={selected === takeover.sessionId}
                onChange={() => onSelect(takeover.sessionId)}
              />
              <span className="min-w-0">
                <span className="block break-words">{takeover.reason}</span>
                <span className="block text-xs text-text-secondary">
                  Session {takeover.sessionId} · asked {new Date(takeover.requestedAt).toLocaleTimeString()}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/**
 * The live view of a computer's shared desktop, with take control, hand back, pending takeovers
 * and clipboard. Keyboard and pointer input reach the desktop only while the viewer holds control.
 */
export function DesktopScreen({
  server,
  computerId,
  agentId,
  sessionId,
  compact = false,
  className,
}: DesktopScreenProps) {
  const screen = useDesktopScreen({ server, computerId, ...(agentId === undefined ? {} : { agentId }) });
  const { status, frame, frameProblem } = screen;
  const now = useNow(1000);
  const scope = { computerId, ...(agentId === undefined ? {} : { agentId }) };

  const [selectedTakeover, setSelectedTakeover] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'error'; text: string } | null>(null);
  const [sendText, setSendText] = useState('');
  const [manualCopy, setManualCopy] = useState<string | null>(null);

  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const wheelRemainderRef = useRef<WheelRemainder>({ dx: 0, dy: 0 });
  const composingRef = useRef(false);
  // Once a beforeinput has arrived, it carries all typing and input events only clean up.
  const beforeInputSeenRef = useRef(false);
  const pressedRef = useRef(new Set<DesktopMouseButton>());
  const [keyboardFocused, setKeyboardFocused] = useState(false);

  const controller = status?.controller;
  const inControl = isMine(controller);
  const inControlRef = useRef(inControl);
  inControlRef.current = inControl;
  const pending = status?.pendingTakeovers ?? [];

  // Keep the selection on a request that still exists; one request, or this session's, is chosen for you.
  const pendingKey = pending.map(takeover => takeover.sessionId).join(',');
  useEffect(() => {
    const ids = pendingKey === '' ? [] : pendingKey.split(',');
    setSelectedTakeover(current => {
      if (current !== null && ids.includes(current)) return current;
      if (sessionId !== undefined && ids.includes(sessionId)) return sessionId;
      return ids.length === 1 ? (ids[0] ?? null) : null;
    });
  }, [pendingKey, sessionId]);

  const { sendInput, pasteText } = screen;

  /** Lets go of every button still held on the desktop, so none stays pressed there. */
  const releaseButtons = useCallback(() => {
    const pressed = [...pressedRef.current];
    pressedRef.current.clear();
    if (pressed.length === 0 || !inControlRef.current) return;
    sendInput(pressed.map((button): DesktopAction => ({ type: 'mouse_up', button })));
  }, [sendInput]);

  useEffect(() => {
    window.addEventListener('blur', releaseButtons);
    return () => window.removeEventListener('blur', releaseButtons);
  }, [releaseButtons]);

  // Nothing of a control session outlives it: held buttons and clipboard text left to copy.
  useEffect(() => {
    if (inControl) return;
    pressedRef.current.clear();
    setManualCopy(null);
  }, [inControl]);

  // Native listeners: React's beforeinput carries no inputType, and wheel must not be passive.
  useEffect(() => {
    const keyboard = keyboardRef.current;
    const surface = frameRef.current;
    if (keyboard === null || surface === null) return;
    const onBeforeInput = (event: InputEvent) => {
      beforeInputSeenRef.current = true;
      if (!inControlRef.current) return;
      if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') {
        event.preventDefault();
        if (event.data) sendInput(typeActions(event.data));
      } else if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
        event.preventDefault();
        sendInput([{ type: 'key', keys: 'Return' }]);
      }
    };
    // Composed text (IME, some dead keys) cannot be cancelled while it is being built, so it goes when done.
    const onCompositionStart = () => {
      composingRef.current = true;
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      composingRef.current = false;
      if (inControlRef.current && event.data) sendInput(typeActions(event.data));
      keyboard.value = '';
    };
    const onInput = () => {
      if (composingRef.current) return;
      // Only a browser without beforeinput types through here; elsewhere that event already sent it.
      if (!beforeInputSeenRef.current && inControlRef.current && keyboard.value !== '') {
        sendInput(typeActions(keyboard.value));
      }
      keyboard.value = '';
    };
    const onWheel = (event: WheelEvent) => {
      if (!inControlRef.current) return;
      event.preventDefault();
      const clicks = wheelToClicks({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        remainder: wheelRemainderRef.current,
      });
      wheelRemainderRef.current = clicks.remainder;
      if (clicks.dx === 0 && clicks.dy === 0) return;
      const point = toDesktopPoint({
        clientX: event.clientX,
        clientY: event.clientY,
        box: surface.getBoundingClientRect(),
      });
      sendInput([{ type: 'scroll', ...point, dx: clicks.dx, dy: clicks.dy }]);
    };
    keyboard.addEventListener('beforeinput', onBeforeInput);
    keyboard.addEventListener('compositionstart', onCompositionStart);
    keyboard.addEventListener('compositionend', onCompositionEnd);
    keyboard.addEventListener('input', onInput);
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      keyboard.removeEventListener('beforeinput', onBeforeInput);
      keyboard.removeEventListener('compositionstart', onCompositionStart);
      keyboard.removeEventListener('compositionend', onCompositionEnd);
      keyboard.removeEventListener('input', onInput);
      surface.removeEventListener('wheel', onWheel);
    };
  }, [sendInput]);

  const pointerActions = (
    event: ReactPointerEvent<HTMLDivElement>,
    action: 'down' | 'up' | 'move',
  ): DesktopAction[] => {
    const surface = frameRef.current;
    if (surface === null) return [];
    const point = toDesktopPoint({
      clientX: event.clientX,
      clientY: event.clientY,
      box: surface.getBoundingClientRect(),
    });
    const move: DesktopAction = { type: 'mouse_move', ...point };
    if (action === 'move') return [move];
    const button = toDesktopButton(event.button);
    if (button === null) return [];
    return [move, action === 'down' ? { type: 'mouse_down', button } : { type: 'mouse_up', button }];
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await task();
    } catch (error: unknown) {
      const failure = readDesktopFailure(error);
      setNotice({
        tone: 'error',
        text: failure?.message || (error instanceof Error ? error.message : 'The request failed'),
      });
      void screen.refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  const takeControl = () =>
    run(async () => {
      screen.applyStatus(await server.takeDesktopControl(scope));
      keyboardRef.current?.focus();
    });

  const handBack = () =>
    run(async () => {
      releaseButtons();
      await screen.flushInput({ dropMoves: true });
      const answer = await server.handBackDesktop({
        ...scope,
        ...(selectedTakeover === null ? {} : { sessionId: selectedTakeover }),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      screen.applyStatus(answer.status);
      setNote('');
      setNotice(
        answer.takeover === null
          ? { tone: 'success', text: 'Control handed back.' }
          : takeoverOutcomeText(answer.takeover),
      );
    });

  const cancelRequest = () =>
    run(async () => {
      if (selectedTakeover === null) return;
      const answer = await server.cancelDesktopTakeover({
        ...scope,
        sessionId: selectedTakeover,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      screen.applyStatus(answer.status);
      setNote('');
      setNotice(
        answer.takeover === null
          ? { tone: 'success', text: 'Request cancelled.' }
          : takeoverOutcomeText(answer.takeover),
      );
    });

  // Clipboard writes must start inside the click, so the text is handed over as a pending blob.
  const copyFromRemote = () => {
    setManualCopy(null);
    const read = server.getDesktopClipboard(scope).then(result => result.text);
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    const write = async () => {
      if (clipboard === undefined) throw new Error('No clipboard access');
      if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
        await clipboard.write([
          new ClipboardItem({ 'text/plain': read.then(text => new Blob([text], { type: 'text/plain' })) }),
        ]);
        return;
      }
      await clipboard.writeText(await read);
    };
    void run(async () => {
      try {
        await write();
        setNotice({ tone: 'success', text: 'Copied from the desktop.' });
      } catch (error: unknown) {
        // A refused read is the server's answer; a refused write leaves the text here to copy by hand.
        if (readDesktopFailure(error) !== null) throw error;
        setManualCopy(await read);
      }
    });
  };

  const submitSendText = () => {
    const text = sendText;
    if (text === '') return;
    setSendText('');
    void run(() => pasteText(text));
  };

  const humanExpiresAt = controller?.kind === 'human' && controller.isMe ? Date.parse(controller.expiresAt) : NaN;
  const leaseLeftMs = humanExpiresAt - now;
  const showLeaseWarning = inControl && Number.isFinite(leaseLeftMs) && leaseLeftMs <= LEASE_WARNING_MS;
  const canTakeControl = status !== null && status.online && status.desktop && controller?.kind !== 'clearing';
  const notLive = problemText({ problem: frameProblem, status });

  const toolbarButton = ({ label, keys }: { label: string; keys: string }) => (
    <Button.Secondary
      key={keys}
      type="button"
      size="small"
      disabled={!inControl}
      onClick={() => {
        sendInput([{ type: 'key', keys }]);
        keyboardRef.current?.focus();
      }}
    >
      {label}
    </Button.Secondary>
  );

  let noticeNode: ReactNode = null;
  if (notice !== null) {
    noticeNode = (
      <p
        role={notice.tone === 'error' ? 'alert' : 'status'}
        className={cn(
          'rounded-md border px-3 py-2 text-sm',
          notice.tone === 'success' && 'border-success-bg/30 bg-success-bg/10 text-text-primary',
          notice.tone === 'warning' && 'border-warning-bg/30 bg-warning-bg/10 text-text-primary',
          notice.tone === 'error' && 'border-failure-bg/30 bg-failure-bg/10 text-failure-bg',
        )}
      >
        {notice.text}
      </p>
    );
  }

  return (
    <section aria-label="Desktop" className={cn('flex min-h-0 flex-col gap-3', className)}>
      {pending.length > 0 ? (
        <PendingTakeovers takeovers={pending} selected={selectedTakeover} onSelect={setSelectedTakeover} />
      ) : null}

      <div className={cn('flex flex-wrap items-center gap-2', compact && 'flex-col items-stretch')}>
        <p className="min-w-0 flex-1 text-xs text-text-secondary" aria-live="polite">
          {status === null ? (screen.statusError ?? 'Loading…') : controllerLabel(status.controller)} ·{' '}
          {frameAgeLabel({ frame, now })}
        </p>
        <div className="flex flex-wrap gap-2">
          {inControl ? (
            <Button.Primary type="button" size="small" disabled={busy} onClick={() => void handBack()}>
              {selectedTakeover === null ? 'Hand back' : 'Hand back to agent'}
            </Button.Primary>
          ) : (
            <Button.Primary
              type="button"
              size="small"
              disabled={busy || !canTakeControl}
              onClick={() => void takeControl()}
            >
              Take control
            </Button.Primary>
          )}
          {selectedTakeover === null ? null : (
            <Button.Secondary type="button" size="small" disabled={busy} onClick={() => void cancelRequest()}>
              Cancel request
            </Button.Secondary>
          )}
        </div>
      </div>

      {inControl || selectedTakeover !== null ? (
        <label className="flex flex-col gap-1 text-xs text-text-secondary">
          Note for the agent (optional)
          <textarea
            value={note}
            maxLength={NOTE_MAX_CHARS}
            rows={2}
            onChange={event => setNote(event.target.value)}
            className={auiInputClass('py-2')}
            placeholder="Logged in as accounts@…"
          />
        </label>
      ) : null}

      {noticeNode}
      {screen.inputError === null ? null : (
        <p role="alert" className="text-sm text-failure-bg">
          {screen.inputError}
        </p>
      )}
      {showLeaseWarning ? (
        <p role="alert" className="flex items-center gap-2 text-sm text-warning-bg">
          <Icon name="triangle-exclamation" className="size-4 shrink-0" />
          Control ends in {String(Math.max(0, Math.ceil(leaseLeftMs / 1000)))}s unless you use the desktop.
        </p>
      ) : null}

      <div
        className={cn(
          'relative max-h-[75vh] w-full shrink-0 overflow-hidden rounded-lg border border-border bg-secondary-bg',
          inControl && keyboardFocused && 'ring-2 ring-focus-ring',
        )}
        data-testid="desktop-view"
        style={{ aspectRatio: `${String(DESKTOP_SCREEN.width)} / ${String(DESKTOP_SCREEN.height)}` }}
      >
        <div
          ref={frameRef}
          data-testid="desktop-frame"
          className={cn('absolute inset-0 touch-none select-none', inControl ? 'cursor-default' : 'cursor-not-allowed')}
          onPointerDown={event => {
            if (!inControlRef.current) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            keyboardRef.current?.focus();
            const button = toDesktopButton(event.button);
            if (button !== null) pressedRef.current.add(button);
            sendInput(pointerActions(event, 'down'));
          }}
          onPointerMove={event => {
            if (!inControlRef.current) return;
            sendInput(pointerActions(event, 'move'));
          }}
          onPointerUp={event => {
            if (!inControlRef.current) return;
            const button = toDesktopButton(event.button);
            if (button !== null) pressedRef.current.delete(button);
            sendInput(pointerActions(event, 'up'));
          }}
          onPointerCancel={releaseButtons}
          onLostPointerCapture={releaseButtons}
          onContextMenu={event => {
            if (inControlRef.current) event.preventDefault();
          }}
        >
          {frame !== null && frameProblem?.kind !== 'human_in_control' ? (
            <>
              <img
                src={frame.url}
                alt="Remote desktop"
                draggable={false}
                className={cn('pointer-events-none h-full w-full object-contain', notLive !== null && 'opacity-40')}
              />
              {notLive === null ? null : (
                <div
                  role="status"
                  data-testid="desktop-stale-label"
                  className="absolute inset-0 flex items-center justify-center p-6"
                >
                  <span className="rounded-md bg-primary-bg/90 px-3 py-2 text-center text-sm text-text-primary">
                    {notLive}
                  </span>
                </div>
              )}
            </>
          ) : (
            <Placeholder text={notLive ?? 'Connecting to the desktop…'} />
          )}
        </div>
        <textarea
          ref={keyboardRef}
          data-desktop-keyboard=""
          aria-label="Desktop keyboard"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          readOnly={!inControl}
          className="absolute left-0 top-0 size-[0.0625rem] resize-none overflow-hidden border-0 p-0 opacity-0"
          onFocus={() => setKeyboardFocused(true)}
          onBlur={() => setKeyboardFocused(false)}
          onKeyDown={event => {
            const native = event.nativeEvent;
            if (isReleaseChord(native)) {
              event.preventDefault();
              event.currentTarget.blur();
              return;
            }
            if (!inControlRef.current) return;
            if (isPasteChord(native)) return;
            const keys = keydownToKeys({
              key: native.key,
              code: native.code,
              ctrlKey: native.ctrlKey,
              altKey: native.altKey,
              shiftKey: native.shiftKey,
              metaKey: native.metaKey,
              isComposing: native.isComposing,
              altGraph: native.getModifierState('AltGraph'),
              mac: isMacPlatform(),
            });
            if (keys === null) return;
            event.preventDefault();
            event.stopPropagation();
            sendInput([{ type: 'key', keys }]);
          }}
          onPaste={event => {
            if (!inControlRef.current) return;
            event.preventDefault();
            const text = event.clipboardData.getData('text/plain');
            if (text !== '') void run(() => pasteText(text));
          }}
        />
      </div>

      {inControl ? (
        <p className="text-xs text-text-secondary">
          Click the screen to type into it; press Ctrl+Alt+Shift to give the keyboard back to this page. Pasting sends
          your clipboard to the desktop and presses Ctrl+V.
        </p>
      ) : (
        <p className="text-xs text-text-secondary">Take control to use the mouse and keyboard on this desktop.</p>
      )}

      <div className={cn('flex flex-wrap items-center gap-2', compact && 'flex-col items-stretch')}>
        <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Keys the browser keeps">
          {RESERVED_CHORDS.map(toolbarButton)}
        </div>
        <Button.Secondary type="button" size="small" disabled={!inControl || busy} onClick={copyFromRemote}>
          <Icon name="copy" size="1rem" className="mr-1" />
          Copy from remote
        </Button.Secondary>
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={event => {
            event.preventDefault();
            submitSendText();
          }}
        >
          <input
            aria-label="Text to send"
            value={sendText}
            disabled={!inControl}
            onChange={event => setSendText(event.target.value)}
            placeholder="Paste here if pasting on the screen is blocked"
            className={auiInputClass('h-8 min-w-0 flex-1')}
          />
          <Button.Secondary type="submit" size="small" disabled={!inControl || busy || sendText === ''}>
            Send text
          </Button.Secondary>
        </form>
      </div>
      {manualCopy === null ? null : (
        <label className="flex flex-col gap-1 text-xs text-text-secondary">
          This browser blocked the copy. Select the text and copy it yourself:
          <textarea readOnly value={manualCopy} rows={3} className={auiInputClass('py-2')} />
        </label>
      )}
    </section>
  );
}
