import { describe, expect, it, vi } from 'vitest';
import { Context, type Plugin } from './context.js';
import { importPlugin, loadPlugins } from './loader.js';

describe('loadPlugins', () => {
  it('loads every entry it is given', async () => {
    const applied: string[] = [];
    const make = (name: string): Plugin => ({
      name,
      apply: () => {
        applied.push(name);
      },
    });

    await loadPlugins(Context.create(), [
      { plugin: make('one'), config: undefined as never },
      { plugin: make('two'), config: undefined as never },
    ]);

    expect(applied).toEqual(['one', 'two']);
  });

  it('stops at a plugin that throws rather than booting half-configured', async () => {
    const later = vi.fn();

    await expect(
      loadPlugins(Context.create(), [
        {
          plugin: {
            name: 'broken',
            apply: () => {
              throw new Error('bad config');
            },
          },
          config: undefined as never,
        },
        { plugin: { name: 'later', apply: later }, config: undefined as never },
      ]),
    ).rejects.toThrow('bad config');

    expect(later).not.toHaveBeenCalled();
  });
});

describe('importPlugin', () => {
  it('rejects a module that is not a plugin, naming what was expected', async () => {
    // The common mistake is exporting the factory instead of the plugin object,
    // and the failure would otherwise be a `TypeError` deep inside the runtime.
    await expect(importPlugin('node:path')).rejects.toThrow(/does not export a plugin/);
  });

  it('surfaces a specifier that cannot be resolved', async () => {
    await expect(importPlugin('nowhere-at-all')).rejects.toThrow();
  });
});
