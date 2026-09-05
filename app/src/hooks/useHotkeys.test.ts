import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { hotkeyLabel, useHotkeys, IS_APPLE, type Hotkey } from './useHotkeys';

/** The modifier this platform actually sends, so the tests read the same on both. */
const mod = IS_APPLE ? { metaKey: true } : { ctrlKey: true };
const otherMod = IS_APPLE ? { ctrlKey: true } : { metaKey: true };

const press = (init: KeyboardEventInit): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
};

describe('useHotkeys', () => {
  const run = vi.fn();

  beforeEach(() => {
    run.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the handler for its combination and swallows the keystroke', () => {
    renderHook(() => {
      useHotkeys([{ key: 'k', mod: true, run }]);
    });

    const event = press({ key: 'k', ...mod });

    expect(run).toHaveBeenCalledOnce();
    // Unswallowed, the browser's own ⌘K wins and the app looks broken.
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores the same key without its modifier, so typing still works', () => {
    renderHook(() => {
      useHotkeys([{ key: 'k', mod: true, run }]);
    });

    press({ key: 'k' });

    expect(run).not.toHaveBeenCalled();
  });

  it('leaves the platform’s other modifier alone', () => {
    // Ctrl+K on a Mac deletes to the end of the line. Answering to both would
    // steal a shortcut the OS already has.
    renderHook(() => {
      useHotkeys([{ key: 'k', mod: true, run }]);
    });

    press({ key: 'k', ...otherMod });

    expect(run).not.toHaveBeenCalled();
  });

  it('distinguishes a shifted combination from an unshifted one', () => {
    renderHook(() => {
      useHotkeys([{ key: 'o', mod: true, shift: true, run }]);
    });

    press({ key: 'o', ...mod });
    expect(run).not.toHaveBeenCalled();

    press({ key: 'O', ...mod, shiftKey: true });
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not fire while disabled', () => {
    renderHook(() => {
      useHotkeys([{ key: 'escape', enabled: false, run }]);
    });

    press({ key: 'Escape' });

    expect(run).not.toHaveBeenCalled();
  });

  it('sees the latest handler without being re-subscribed', () => {
    // The caller rebuilds this array on every streamed token. A hook that read a
    // captured copy would keep calling the handler from the first render.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ handler }: { handler: () => void }) => {
        useHotkeys([{ key: 'escape', run: handler }]);
      },
      { initialProps: { handler: first } },
    );

    rerender({ handler: second });
    press({ key: 'Escape' });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('ignores a held key and half-typed IME input', () => {
    renderHook(() => {
      useHotkeys([{ key: 'escape', run }]);
    });

    press({ key: 'Escape', repeat: true });
    press({ key: 'Escape', isComposing: true });

    expect(run).not.toHaveBeenCalled();
  });

  it('runs only the first match, so two bindings cannot both fire', () => {
    const second = vi.fn();
    renderHook(() => {
      useHotkeys([
        { key: 'escape', run },
        { key: 'escape', run: second },
      ] satisfies Hotkey[]);
    });

    press({ key: 'Escape' });

    expect(run).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it('stops listening once the component is gone', () => {
    const { unmount } = renderHook(() => {
      useHotkeys([{ key: 'escape', run }]);
    });

    unmount();
    press({ key: 'Escape' });

    expect(run).not.toHaveBeenCalled();
  });
});

describe('hotkeyLabel', () => {
  it('writes the platform’s own modifier', () => {
    expect(hotkeyLabel({ key: 'k', mod: true })).toBe(IS_APPLE ? '⌘K' : 'Ctrl+K');
  });

  it('includes shift, written the way the platform writes it', () => {
    expect(hotkeyLabel({ key: 'o', mod: true, shift: true })).toBe(
      IS_APPLE ? '⌘⇧O' : 'Ctrl+Shift+O',
    );
  });

  it('names a key that has a name, rather than shouting it', () => {
    // "Stop generating (ESCAPE)" is not how any application writes it.
    expect(hotkeyLabel({ key: 'escape' })).toBe('Esc');
    expect(hotkeyLabel({ key: 'k' })).toBe('K');
  });
});
