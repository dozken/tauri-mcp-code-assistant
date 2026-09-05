import { useEffect, useRef } from 'react';

/**
 * `⌘` on a Mac, `Ctrl` everywhere else — the same key in muscle memory, a
 * different one in the event. Read once: it cannot change while the app runs.
 */
export const IS_APPLE =
  typeof navigator === 'undefined' ? false : /mac|iphone|ipad|ipod/i.test(navigator.userAgent);

const MOD_KEY = IS_APPLE ? '⌘' : 'Ctrl';
const SHIFT_KEY = IS_APPLE ? '⇧' : 'Shift';

/** Keys whose name is a word: "Esc", not "ESCAPE". */
const KEY_NAMES: Readonly<Record<string, string>> = {
  escape: 'Esc',
  enter: 'Enter',
  backspace: 'Backspace',
  ' ': 'Space',
};

export interface Hotkey {
  /** The key as `KeyboardEvent.key` reports it, lower-cased. */
  readonly key: string;
  /** Requires ⌘ on a Mac and Ctrl elsewhere. */
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly run: () => void;
  /** Skipped entirely while false, so a handler cannot fire for a state that has passed. */
  readonly enabled?: boolean;
}

/**
 * How this hotkey is written on a button or in a hint — `⌘⇧O` on a Mac, `Ctrl+Shift+O`
 * elsewhere, because that is how each platform's own menus write it.
 */
export const hotkeyLabel = (hotkey: Pick<Hotkey, 'key' | 'mod' | 'shift'>): string =>
  [
    hotkey.mod === true ? MOD_KEY : '',
    hotkey.shift === true ? SHIFT_KEY : '',
    KEY_NAMES[hotkey.key] ?? hotkey.key.toUpperCase(),
  ]
    .filter(Boolean)
    .join(IS_APPLE ? '' : '+');

const matches = (event: KeyboardEvent, hotkey: Hotkey): boolean => {
  const mod = IS_APPLE ? event.metaKey : event.ctrlKey;
  // The other modifier must be *up*: Ctrl+K on a Mac is a different shortcut
  // (delete to end of line), and firing on both would steal it.
  const otherMod = IS_APPLE ? event.ctrlKey : event.metaKey;

  return (
    event.key.toLowerCase() === hotkey.key &&
    mod === (hotkey.mod ?? false) &&
    !otherMod &&
    event.shiftKey === (hotkey.shift ?? false) &&
    !event.altKey
  );
};

/**
 * Window-level shortcuts.
 *
 * On `window` rather than on a container because the point of ⌘K is that it works
 * wherever the caret happens to be — including inside the transcript, which is
 * focusable. `Escape` is deliberately allowed to fire from inside the composer:
 * stopping a runaway answer is exactly what a user reaches for while typing the
 * next question.
 */
export const useHotkeys = (hotkeys: readonly Hotkey[]): void => {
  // Read through a ref so the listener is attached once. The caller builds this
  // array during a render that happens on every streamed token, and a hook that
  // re-subscribed each time would make correctness depend on the caller
  // remembering to memoise it.
  const latest = useRef(hotkeys);
  useEffect(() => {
    latest.current = hotkeys;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Held keys and half-typed IME input are not shortcuts.
      if (event.repeat || event.isComposing) return;

      for (const hotkey of latest.current) {
        if (hotkey.enabled === false || !matches(event, hotkey)) continue;
        event.preventDefault();
        hotkey.run();
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
};
