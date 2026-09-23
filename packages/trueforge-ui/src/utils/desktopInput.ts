import type { DesktopAction, DesktopMouseButton } from '../server/types.js';

/** The remote desktop is always this size; every coordinate sent is a pixel on it. */
export const DESKTOP_SCREEN: { readonly width: number; readonly height: number } = { width: 1280, height: 800 };

// Mirrors the server's input limits so a batch is never refused for its shape.
const MAX_ACTIONS_PER_BATCH = 64;
const MAX_SCROLL_CLICKS_PER_BATCH = 60;
const MAX_SCROLL_CLICKS_PER_ACTION = 50;
const MAX_TYPE_CHARS = 512;
const MAX_KEYS_CHARS = 64;
const KEYS_PATTERN = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;

/** Marks the element that takes desktop keyboard input, so page-level shortcuts leave its keys alone. */
export const DESKTOP_KEYBOARD_ATTRIBUTE = 'data-desktop-keyboard';

export function isDesktopKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${DESKTOP_KEYBOARD_ATTRIBUTE}]`) !== null;
}

function clamp({ value, max }: { value: number; max: number }): number {
  return Math.min(max, Math.max(0, value));
}

type Rect = { left: number; top: number; width: number; height: number };

/** Where a frame drawn with `object-fit: contain` actually sits inside its box. */
export function containedFrameRect(box: Rect): Rect {
  const ratio = DESKTOP_SCREEN.width / DESKTOP_SCREEN.height;
  if (box.height <= 0 || box.width <= 0) return box;
  if (box.width / box.height > ratio) {
    const width = box.height * ratio;
    return { left: box.left + (box.width - width) / 2, top: box.top, width, height: box.height };
  }
  const height = box.width / ratio;
  return { left: box.left, top: box.top + (box.height - height) / 2, width: box.width, height };
}

/** Maps a pointer position over the frame's box to a desktop pixel, allowing for letterboxing. */
export function toDesktopPoint({ clientX, clientY, box }: { clientX: number; clientY: number; box: Rect }): {
  x: number;
  y: number;
} {
  const rect = containedFrameRect(box);
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp({
      value: Math.floor(((clientX - rect.left) / rect.width) * DESKTOP_SCREEN.width),
      max: DESKTOP_SCREEN.width - 1,
    }),
    y: clamp({
      value: Math.floor(((clientY - rect.top) / rect.height) * DESKTOP_SCREEN.height),
      max: DESKTOP_SCREEN.height - 1,
    }),
  };
}

/** DOM `MouseEvent.button` to the desktop's button; the back and forward buttons have no match. */
export function toDesktopButton(button: number): DesktopMouseButton | null {
  switch (button) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    default:
      return null;
  }
}

/** DOM `KeyboardEvent.key` values that type nothing, as X keysym names. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: 'Return',
  Backspace: 'BackSpace',
  Tab: 'Tab',
  Escape: 'Escape',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page_Up',
  PageDown: 'Page_Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ContextMenu: 'Menu',
  PrintScreen: 'Print',
  Pause: 'Pause',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
};

/** Printable characters that need a keysym name inside a chord. */
const SYMBOL_KEYSYMS: Readonly<Record<string, string>> = {
  ' ': 'space',
  '-': 'minus',
  '=': 'equal',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  ';': 'semicolon',
  "'": 'apostrophe',
  '[': 'bracketleft',
  ']': 'bracketright',
  '\\': 'backslash',
  '`': 'grave',
};

/** `KeyboardEvent.code` of the same keys, for chords where shift changed `key` (ctrl+shift+-). */
const CODE_KEYSYMS: Readonly<Record<string, string>> = {
  Space: 'space',
  Minus: 'minus',
  Equal: 'equal',
  Comma: 'comma',
  Period: 'period',
  Slash: 'slash',
  Semicolon: 'semicolon',
  Quote: 'apostrophe',
  BracketLeft: 'bracketleft',
  BracketRight: 'bracketright',
  Backslash: 'backslash',
  Backquote: 'grave',
};

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS', 'Super', 'Hyper', 'CapsLock']);

export type DesktopKeyEvent = {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  /** AltGr on layouts that type characters with it; the input event carries those. */
  altGraph: boolean;
  /** A Mac keyboard: Cmd stands for Ctrl on the Linux desktop, and Option composes characters. */
  mac: boolean;
};

/** Cmd chords a Mac user means as the Ctrl chords the Linux desktop knows. */
const MAC_COMMAND_KEYS = new Set(['c', 'x', 'v', 'a', 'z', 'l']);

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** Ctrl+Alt+Shift gives the keyboard back to the page; it types nothing on the desktop. */
export function isReleaseChord(event: Pick<DesktopKeyEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  return (
    event.ctrlKey &&
    event.altKey &&
    event.shiftKey &&
    (event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift')
  );
}

function chordBase(event: DesktopKeyEvent): string | null {
  if (/^[A-Za-z0-9]$/.test(event.key)) return event.key.toLowerCase();
  const symbol = SYMBOL_KEYSYMS[event.key];
  if (symbol !== undefined) return symbol;
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
  if (letter !== undefined) return letter.toLowerCase();
  const digit = /^Digit([0-9])$/.exec(event.code)?.[1];
  if (digit !== undefined) return digit;
  return CODE_KEYSYMS[event.code] ?? null;
}

/**
 * The xdotool chord a keydown should send, or null when it types text (the input event sends
 * that, so layouts and dead keys work) or maps to nothing the desktop understands.
 */
export function keydownToKeys(event: DesktopKeyEvent): string | null {
  if (event.isComposing || event.key === 'Dead' || event.key === 'Process' || MODIFIER_KEYS.has(event.key)) {
    return null;
  }
  const named = NAMED_KEYS[event.key];
  // Option+letter on a Mac is a character (ø, é via a dead key), so the input event carries it.
  const altChord = event.altKey && !event.altGraph && !event.mac;
  const chorded = event.ctrlKey || event.metaKey || altChord;
  let base: string | null;
  if (named !== undefined) {
    base = named;
  } else if (chorded && !event.altGraph) {
    base = chordBase(event);
  } else {
    return null;
  }
  if (base === null) return null;
  const macCommand = event.mac && event.metaKey && MAC_COMMAND_KEYS.has(base);
  const modifiers = [
    (event.ctrlKey && !event.altGraph) || macCommand ? 'ctrl' : undefined,
    event.altKey && !event.altGraph ? 'alt' : undefined,
    event.shiftKey ? 'shift' : undefined,
    event.metaKey && !macCommand ? 'super' : undefined,
  ].filter((modifier): modifier is string => modifier !== undefined);
  const keys = [...modifiers, base].join('+');
  return isSendableKeys(keys) ? keys : null;
}

/** Ctrl+V, Cmd+V and Shift+Insert: left to the browser so its paste event can carry the local clipboard. */
export function isPasteChord(
  event: Pick<DesktopKeyEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
): boolean {
  const isV = event.key === 'v' || event.key === 'V' || event.code === 'KeyV';
  if (isV && (event.ctrlKey || event.metaKey) && !event.altKey) return true;
  return event.key === 'Insert' && event.shiftKey && !event.ctrlKey && !event.metaKey;
}

export function isSendableKeys(keys: string): boolean {
  return keys.length > 0 && keys.length <= MAX_KEYS_CHARS && KEYS_PATTERN.test(keys);
}

/** Text to type, split so no action exceeds the per-action limit. */
export function typeActions(text: string): DesktopAction[] {
  const actions: DesktopAction[] = [];
  const characters = Array.from(text);
  for (let start = 0; start < characters.length; start += MAX_TYPE_CHARS) {
    actions.push({ type: 'type', text: characters.slice(start, start + MAX_TYPE_CHARS).join('') });
  }
  return actions;
}

/** Wheel deltas carried between events so slow trackpad scrolls still add up to clicks. */
export type WheelRemainder = { dx: number; dy: number };

const PIXELS_PER_CLICK = 100;
const LINES_PER_CLICK = 3;

/** Converts a wheel event to whole wheel clicks, keeping the fraction for the next event. */
export function wheelToClicks({
  deltaX,
  deltaY,
  deltaMode,
  remainder,
}: {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  remainder: WheelRemainder;
}): { dx: number; dy: number; remainder: WheelRemainder } {
  const perClick = deltaMode === 1 ? LINES_PER_CLICK : deltaMode === 2 ? 1 / 3 : PIXELS_PER_CLICK;
  const totalX = remainder.dx + deltaX / perClick;
  const totalY = remainder.dy + deltaY / perClick;
  const dx = Math.trunc(totalX);
  const dy = Math.trunc(totalY);
  const bound = (value: number) =>
    Math.max(-MAX_SCROLL_CLICKS_PER_ACTION, Math.min(MAX_SCROLL_CLICKS_PER_ACTION, value));
  return { dx: bound(dx), dy: bound(dy), remainder: { dx: totalX - dx, dy: totalY - dy } };
}

function scrollClicks(action: DesktopAction): number {
  return action.type === 'scroll' ? Math.abs(action.dx) + Math.abs(action.dy) : 0;
}

/** `value` moved toward zero until its size is at most `limit`. */
function capMagnitude({ value, limit }: { value: number; limit: number }): number {
  const size = Math.min(Math.abs(value), limit);
  return value < 0 && size > 0 ? -size : size;
}

/** One scroll split into steps that each fit a batch's wheel-click budget, at the same point. */
function splitScroll(action: DesktopAction): DesktopAction[] {
  if (action.type !== 'scroll' || scrollClicks(action) <= MAX_SCROLL_CLICKS_PER_BATCH) return [action];
  const steps: DesktopAction[] = [];
  let { dx, dy } = action;
  while (dx !== 0 || dy !== 0) {
    const stepY = capMagnitude({ value: dy, limit: MAX_SCROLL_CLICKS_PER_ACTION });
    const stepX = capMagnitude({
      value: dx,
      limit: Math.min(MAX_SCROLL_CLICKS_PER_ACTION, MAX_SCROLL_CLICKS_PER_BATCH - Math.abs(stepY)),
    });
    steps.push({ ...action, dx: stepX, dy: stepY });
    dx -= stepX;
    dy -= stepY;
  }
  return steps;
}

/** Merges what can be merged: runs of pointer moves keep the last, adjacent typing joins up. */
function coalesce(actions: readonly DesktopAction[]): DesktopAction[] {
  const merged: DesktopAction[] = [];
  for (const action of actions) {
    const previous = merged.at(-1);
    if (previous?.type === 'mouse_move' && action.type === 'mouse_move') {
      merged[merged.length - 1] = action;
    } else if (
      previous?.type === 'type' &&
      action.type === 'type' &&
      Array.from(previous.text).length + Array.from(action.text).length <= MAX_TYPE_CHARS
    ) {
      merged[merged.length - 1] = { type: 'type', text: previous.text + action.text };
    } else {
      merged.push(action);
    }
  }
  return merged;
}

/**
 * Packs queued actions into batches the server accepts: at most 64 actions and 60 wheel clicks
 * each, in the order they happened. A scroll bigger than one batch's budget is split.
 */
export function packActions(actions: readonly DesktopAction[]): DesktopAction[][] {
  const batches: DesktopAction[][] = [];
  let current: DesktopAction[] = [];
  let clicks = 0;
  for (const action of coalesce(actions).flatMap(splitScroll)) {
    const actionClicks = scrollClicks(action);
    if (
      current.length > 0 &&
      (current.length >= MAX_ACTIONS_PER_BATCH || clicks + actionClicks > MAX_SCROLL_CLICKS_PER_BATCH)
    ) {
      batches.push(current);
      current = [];
      clicks = 0;
    }
    current.push(action);
    clicks += actionClicks;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
