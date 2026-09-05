import { describe, expect, it, vi } from 'vitest';
import { Context, type Plugin } from './context.js';

declare module './context.js' {
  interface Services {
    alpha: { readonly tag: string };
    beta: { readonly tag: string };
  }
}

const providing = (name: 'alpha' | 'beta', tag: string = name): Plugin => ({
  name: `provide-${name}`,
  apply: async (ctx) => ctx.provide(name, { tag }),
});

describe('Context services', () => {
  it('hands a provided service to anyone who asks by name', async () => {
    const root = Context.create();

    await root.plugin(providing('alpha'), undefined);

    expect(root.get('alpha')).toEqual({ tag: 'alpha' });
  });

  it('reports nothing for a service no plugin provides', () => {
    expect(Context.create().get('alpha')).toBeUndefined();
  });

  it('names the missing service when a caller requires one', () => {
    expect(() => Context.create().require('alpha')).toThrow(/"alpha"/);
  });

  it('refuses a second provider rather than silently replacing the first', async () => {
    // Two vector stores answering the same name is a split index that nothing
    // reports; better to fail at load than to serve half the answers.
    const root = Context.create();
    await root.plugin(providing('alpha'), undefined);

    await expect(root.plugin(providing('alpha', 'other'), undefined)).rejects.toThrow(
      /already provided/,
    );
  });

  it('lists what is currently provided, in a stable order', async () => {
    const root = Context.create();
    await root.plugin(providing('beta'), undefined);
    await root.plugin(providing('alpha'), undefined);

    expect(root.provided).toEqual(['alpha', 'beta']);
  });
});

describe('Context injection', () => {
  it('waits for a dependency instead of failing when it is loaded second', async () => {
    // The whole point: a third-party plugin cannot be asked to know where it sits
    // in someone else's boot order.
    const root = Context.create();
    const seen: string[] = [];

    await root.plugin(
      {
        name: 'consumer',
        inject: ['alpha'],
        apply: (ctx) => {
          seen.push(ctx.require('alpha').tag);
        },
      },
      undefined,
    );
    expect(seen).toEqual([]);

    await root.plugin(providing('alpha'), undefined);

    expect(seen).toEqual(['alpha']);
  });

  it('waits for every dependency, not merely the first', async () => {
    const root = Context.create();
    const apply = vi.fn();

    await root.plugin({ name: 'consumer', inject: ['alpha', 'beta'], apply }, undefined);
    await root.plugin(providing('alpha'), undefined);
    expect(apply).not.toHaveBeenCalled();

    await root.plugin(providing('beta'), undefined);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('unloads a consumer when its dependency goes away, and loads it again when it returns', async () => {
    const root = Context.create();
    const log: string[] = [];

    await root.plugin(
      {
        name: 'consumer',
        inject: ['alpha'],
        apply: (ctx) => {
          log.push('load');
          ctx.effect(() => {
            log.push('unload');
          });
        },
      },
      undefined,
    );

    const first = await root.plugin(providing('alpha'), undefined);
    expect(log).toEqual(['load']);

    await first.dispose();
    expect(log).toEqual(['load', 'unload']);

    await root.plugin(providing('alpha'), undefined);
    expect(log).toEqual(['load', 'unload', 'load']);
  });
});

describe('Context disposal', () => {
  it('runs a plugin effects in reverse, so teardown mirrors setup', async () => {
    const root = Context.create();
    const log: string[] = [];

    const fork = await root.plugin(
      {
        name: 'ordered',
        apply: (ctx) => {
          ctx.effect(() => {
            log.push('first');
          });
          ctx.effect(() => {
            log.push('second');
          });
        },
      },
      undefined,
    );

    await fork.dispose();

    expect(log).toEqual(['second', 'first']);
  });

  it('takes the services a plugin registered away with it', async () => {
    const root = Context.create();
    const fork = await root.plugin(providing('alpha'), undefined);
    expect(root.get('alpha')).toEqual({ tag: 'alpha' });

    await fork.dispose();

    // And the name is free again, so a replacement can claim it.
    expect(root.get('alpha')).toBeUndefined();
    await expect(root.plugin(providing('alpha', 'replacement'), undefined)).resolves.toBeDefined();
  });

  it('unloads what a plugin loaded, so a subtree leaves nothing behind', async () => {
    const root = Context.create();
    const log: string[] = [];

    const fork = await root.plugin(
      {
        name: 'parent',
        apply: async (ctx) => {
          await ctx.plugin(
            {
              name: 'child',
              apply: (inner) => {
                inner.effect(() => {
                  log.push('child');
                });
              },
            },
            undefined,
          );
          ctx.effect(() => {
            log.push('parent');
          });
        },
      },
      undefined,
    );

    await fork.dispose();

    // Depth first: a parent's own teardown may rely on its children being gone.
    expect(log).toEqual(['child', 'parent']);
  });

  it('is idempotent, so a double unload is not a double teardown', async () => {
    const root = Context.create();
    const dispose = vi.fn();
    const fork = await root.plugin(
      {
        name: 'once',
        apply: (ctx) => {
          ctx.effect(dispose);
        },
      },
      undefined,
    );

    await fork.dispose();
    await fork.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
