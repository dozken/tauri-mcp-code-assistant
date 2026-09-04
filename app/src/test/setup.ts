import '@testing-library/jest-dom/vitest';

// jsdom has no ResizeObserver, which several MUI components construct on mount.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

globalThis.scrollTo ??= (() => {}) as typeof globalThis.scrollTo;
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};
