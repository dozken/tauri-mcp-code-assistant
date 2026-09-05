import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from './registry.js';

describe('ProviderRegistry', () => {
  const build = (): ProviderRegistry<string, { suffix: string }> =>
    new ProviderRegistry<string, { suffix: string }>('widget');

  it('creates from the kind a plugin registered', async () => {
    const registry = build();
    registry.register('loud', ({ suffix }) => `LOUD${suffix}`);

    await expect(registry.create('loud', { suffix: '!' })).resolves.toBe('LOUD!');
  });

  it('awaits a provider that needs to do work first', async () => {
    const registry = build();
    registry.register('slow', async ({ suffix }) => `slow${suffix}`);

    await expect(registry.create('slow', { suffix: '.' })).resolves.toBe('slow.');
  });

  it('refuses two plugins claiming the same kind', () => {
    // Silently taking the second means the app runs on whichever loaded last,
    // which is a coin toss nobody can see in a log.
    const registry = build();
    registry.register('same', () => 'first');

    expect(() => registry.register('same', () => 'second')).toThrow(/both provide the widget/);
  });

  it('names what is available when asked for a kind nobody registered', async () => {
    // The usual cause is a typo in config, so the list is the fix.
    const registry = build();
    registry.register('chroma', () => 'c');
    registry.register('memory', () => 'm');

    await expect(registry.create('crhoma', { suffix: '' })).rejects.toThrow(
      /"crhoma".*Available: chroma, memory/s,
    );
  });

  it('says so plainly when nothing is registered at all', async () => {
    await expect(build().create('any', { suffix: '' })).rejects.toThrow(/Available: none/);
  });

  it('reports its kinds in a stable order', () => {
    const registry = build();
    registry.register('zulu', () => 'z');
    registry.register('alpha', () => 'a');

    expect(registry.kinds).toEqual(['alpha', 'zulu']);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.has('nope')).toBe(false);
  });
});
