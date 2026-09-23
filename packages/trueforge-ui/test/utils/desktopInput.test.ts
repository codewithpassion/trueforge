import { describe, expect, it } from 'vitest';

import type { DesktopAction } from '@/server/types.js';
import {
  containedFrameRect,
  isPasteChord,
  keydownToKeys,
  packActions,
  toDesktopButton,
  toDesktopPoint,
  typeActions,
  wheelToClicks,
  type DesktopKeyEvent,
} from '@/utils/desktopInput.js';

function key(overrides: Partial<DesktopKeyEvent> & Pick<DesktopKeyEvent, 'key'>): DesktopKeyEvent {
  return {
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    altGraph: false,
    ...overrides,
  };
}

describe('toDesktopPoint', () => {
  it('scales the displayed frame to the 1280x800 desktop', () => {
    const box = { left: 100, top: 50, width: 640, height: 400 };
    expect(toDesktopPoint({ clientX: 100, clientY: 50, box })).toEqual({ x: 0, y: 0 });
    expect(toDesktopPoint({ clientX: 420, clientY: 250, box })).toEqual({ x: 640, y: 400 });
    expect(toDesktopPoint({ clientX: 739.9, clientY: 449.9, box })).toEqual({ x: 1279, y: 799 });
  });

  it('clamps points outside the frame to its edge', () => {
    const box = { left: 0, top: 0, width: 640, height: 400 };
    expect(toDesktopPoint({ clientX: -20, clientY: 900, box })).toEqual({ x: 0, y: 799 });
    expect(toDesktopPoint({ clientX: 5000, clientY: -1, box })).toEqual({ x: 1279, y: 0 });
  });

  it('allows for the letterbox when the box is wider than the frame', () => {
    // 1000x400 box: the 16:10 frame is 640 wide, centred with 180 on each side.
    const box = { left: 0, top: 0, width: 1000, height: 400 };
    expect(containedFrameRect(box)).toEqual({ left: 180, top: 0, width: 640, height: 400 });
    expect(toDesktopPoint({ clientX: 180, clientY: 0, box })).toEqual({ x: 0, y: 0 });
    expect(toDesktopPoint({ clientX: 500, clientY: 200, box })).toEqual({ x: 640, y: 400 });
  });

  it('allows for the letterbox when the box is taller than the frame', () => {
    const box = { left: 0, top: 0, width: 640, height: 600 };
    expect(containedFrameRect(box)).toEqual({ left: 0, top: 100, width: 640, height: 400 });
    expect(toDesktopPoint({ clientX: 320, clientY: 300, box })).toEqual({ x: 640, y: 400 });
  });

  it('maps DOM buttons and ignores back and forward', () => {
    expect(toDesktopButton(0)).toBe('left');
    expect(toDesktopButton(1)).toBe('middle');
    expect(toDesktopButton(2)).toBe('right');
    expect(toDesktopButton(3)).toBeNull();
  });
});

describe('keydownToKeys', () => {
  it('leaves printable keys to the input event', () => {
    expect(keydownToKeys(key({ key: 'a', code: 'KeyA' }))).toBeNull();
    expect(keydownToKeys(key({ key: 'A', code: 'KeyA', shiftKey: true }))).toBeNull();
    expect(keydownToKeys(key({ key: ' ', code: 'Space' }))).toBeNull();
    expect(keydownToKeys(key({ key: 'é', code: 'Digit2' }))).toBeNull();
  });

  it('leaves dead keys, composition and lone modifiers alone', () => {
    expect(keydownToKeys(key({ key: 'Dead', code: 'Quote' }))).toBeNull();
    expect(keydownToKeys(key({ key: 'Process', isComposing: true }))).toBeNull();
    expect(keydownToKeys(key({ key: 'Control', ctrlKey: true }))).toBeNull();
    expect(keydownToKeys(key({ key: 'Shift', shiftKey: true }))).toBeNull();
  });

  it('names keys that type nothing with X keysyms', () => {
    expect(keydownToKeys(key({ key: 'Enter' }))).toBe('Return');
    expect(keydownToKeys(key({ key: 'Backspace' }))).toBe('BackSpace');
    expect(keydownToKeys(key({ key: 'ArrowLeft' }))).toBe('Left');
    expect(keydownToKeys(key({ key: 'PageDown' }))).toBe('Page_Down');
    expect(keydownToKeys(key({ key: 'Tab', shiftKey: true }))).toBe('shift+Tab');
    expect(keydownToKeys(key({ key: 'F5' }))).toBe('F5');
    expect(keydownToKeys(key({ key: 'Escape' }))).toBe('Escape');
  });

  it('sends chords as modifier+key in xdotool form', () => {
    expect(keydownToKeys(key({ key: 'l', code: 'KeyL', ctrlKey: true }))).toBe('ctrl+l');
    expect(keydownToKeys(key({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+c');
    expect(keydownToKeys(key({ key: 'Tab', altKey: true }))).toBe('alt+Tab');
    expect(keydownToKeys(key({ key: 'Enter', ctrlKey: true }))).toBe('ctrl+Return');
    expect(keydownToKeys(key({ key: 'd', code: 'KeyD', metaKey: true }))).toBe('super+d');
  });

  it('names punctuation in chords, falling back to the physical key when shift changed it', () => {
    expect(keydownToKeys(key({ key: '-', code: 'Minus', ctrlKey: true }))).toBe('ctrl+minus');
    expect(keydownToKeys(key({ key: '_', code: 'Minus', ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+minus');
    expect(keydownToKeys(key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+1');
    expect(keydownToKeys(key({ key: ' ', code: 'Space', ctrlKey: true }))).toBe('ctrl+space');
  });

  it('only produces chords the server pattern accepts', () => {
    for (const keys of [
      keydownToKeys(key({ key: '/', code: 'Slash', ctrlKey: true })),
      keydownToKeys(key({ key: 'Home', ctrlKey: true, shiftKey: true })),
    ]) {
      expect(keys).toMatch(/^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/);
    }
    expect(keydownToKeys(key({ key: '§', code: 'IntlBackslash', ctrlKey: true }))).toBeNull();
  });

  it('lets AltGr characters through to the input event', () => {
    expect(keydownToKeys(key({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true, altGraph: true }))).toBeNull();
  });

  it('recognises the paste chords', () => {
    expect(isPasteChord(key({ key: 'v', code: 'KeyV', ctrlKey: true }))).toBe(true);
    expect(isPasteChord(key({ key: 'v', code: 'KeyV', metaKey: true }))).toBe(true);
    expect(isPasteChord(key({ key: 'Insert', shiftKey: true }))).toBe(true);
    expect(isPasteChord(key({ key: 'v', code: 'KeyV' }))).toBe(false);
    expect(isPasteChord(key({ key: 'c', code: 'KeyC', ctrlKey: true }))).toBe(false);
  });
});

describe('typeActions', () => {
  it('splits long text so no action exceeds 512 characters', () => {
    const actions = typeActions('x'.repeat(1030));
    expect(actions.map(action => (action.type === 'type' ? action.text.length : 0))).toEqual([512, 512, 6]);
  });
});

describe('wheelToClicks', () => {
  it('turns pixel deltas into clicks and carries the fraction', () => {
    const first = wheelToClicks({ deltaX: 0, deltaY: 150, deltaMode: 0, remainder: { dx: 0, dy: 0 } });
    expect(first).toMatchObject({ dx: 0, dy: 1 });
    const second = wheelToClicks({ deltaX: 0, deltaY: 50, deltaMode: 0, remainder: first.remainder });
    expect(second).toMatchObject({ dx: 0, dy: 1 });
  });

  it('treats three lines as one click and scrolls up for negative deltas', () => {
    expect(wheelToClicks({ deltaX: 0, deltaY: -6, deltaMode: 1, remainder: { dx: 0, dy: 0 } })).toMatchObject({
      dy: -2,
    });
  });

  it('caps one action at 50 clicks', () => {
    expect(wheelToClicks({ deltaX: 0, deltaY: 100_000, deltaMode: 0, remainder: { dx: 0, dy: 0 } }).dy).toBe(50);
  });
});

describe('packActions', () => {
  it('keeps only the last of consecutive pointer moves and joins adjacent typing', () => {
    const actions: DesktopAction[] = [
      { type: 'mouse_move', x: 1, y: 1 },
      { type: 'mouse_move', x: 2, y: 2 },
      { type: 'mouse_down', button: 'left' },
      { type: 'type', text: 'ab' },
      { type: 'type', text: 'c' },
    ];
    expect(packActions(actions)).toEqual([
      [
        { type: 'mouse_move', x: 2, y: 2 },
        { type: 'mouse_down', button: 'left' },
        { type: 'type', text: 'abc' },
      ],
    ]);
  });

  it('splits batches at 64 actions', () => {
    const actions: DesktopAction[] = Array.from({ length: 130 }, () => ({ type: 'key', keys: 'a' }));
    expect(packActions(actions).map(batch => batch.length)).toEqual([64, 64, 2]);
  });

  it('splits batches before they scroll more than 60 clicks', () => {
    const scroll: DesktopAction = { type: 'scroll', x: 0, y: 0, dx: 0, dy: 25 };
    expect(packActions([scroll, scroll, scroll]).map(batch => batch.length)).toEqual([2, 1]);
  });
});
