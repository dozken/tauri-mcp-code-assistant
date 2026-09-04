import '@testing-library/jest-dom/vitest';

// jsdom has no ResizeObserver, which several MUI components construct on mount.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

globalThis.scrollTo ??= (() => undefined) as typeof globalThis.scrollTo;
// eslint-disable-next-line @typescript-eslint/unbound-method -- assigning a prototype stub.
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {
  return undefined;
};
