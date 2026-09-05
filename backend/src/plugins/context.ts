/**
 * A small plugin runtime, shaped after Cordis.
 *
 * Three ideas, and nothing else:
 *
 * - **Services are named, not imported.** A plugin publishes `vectorStore`; another
 *   asks for `vectorStore`. Neither knows the other's module, which is what lets a
 *   third party replace one.
 * - **Dependencies are reactive.** `inject` does not fail when a service is missing,
 *   it waits — and unloads again if the service goes away. Load order stops being
 *   something anyone has to get right.
 * - **Effects are revertible.** Everything a plugin registers is owned by its scope,
 *   so unloading it is exact rather than best-effort.
 *
 * There is deliberately no event bus yet. A lifecycle hook is a real plugin need,
 * but an API with no caller is a guess about what that need will look like; it
 * lands with its first emitter.
 *
 * Written here rather than taken as a dependency: the upstream API is explicitly
 * unstable, and this is the whole surface the app needs.
 */

/** Augmented by whoever provides a service — see `vector/vector-store.plugin.ts`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the point is that plugins fill it.
export interface Services {}

export type ServiceName = Extract<keyof Services, string>;

export interface Plugin<Config = void> {
  /** Only for diagnostics: a failing plugin should be nameable in a log line. */
  readonly name: string;
  /** Services that must exist before `apply` runs, and whose loss unloads it again. */
  readonly inject?: readonly ServiceName[];
  readonly apply: (ctx: Context, config: Config) => void | Promise<void>;
}

/** What `ctx.plugin()` hands back: the one thing a caller can do is take it away. */
export interface Fork {
  readonly dispose: () => Promise<void>;
}

interface Waiter {
  readonly names: readonly ServiceName[];
  readonly apply: (ctx: Context) => void | Promise<void>;
  readonly owner: Scope;
  readonly label: string;
  /** Set while satisfied; disposing it is how a lost dependency unloads the work. */
  scope?: Scope;
}

/** One plugin's slice of the world: what it registered, and what to undo. */
class Scope {
  readonly children = new Set<Scope>();
  readonly effects: (() => void | Promise<void>)[] = [];
  readonly provided = new Set<ServiceName>();
  readonly waiters = new Set<Waiter>();
  disposed = false;

  constructor(readonly parent?: Scope) {
    parent?.children.add(this);
  }
}

interface ServiceEntry {
  readonly value: unknown;
  readonly owner: Scope;
}

/** Shared by every context in one application. */
class Registry {
  readonly services = new Map<ServiceName, ServiceEntry>();
  readonly waiters = new Set<Waiter>();
  /** Guards against a `settle` that starts while one is already running. */
  settling = false;
  dirty = false;
}

export class Context {
  private constructor(
    private readonly registry: Registry,
    private readonly scope: Scope,
  ) {}

  /** The application root. Everything else descends from a plugin load. */
  static create(): Context {
    return new Context(new Registry(), new Scope());
  }

  /** `undefined` until something provides it — callers inside `inject` never see that. */
  get<K extends ServiceName>(name: K): Services[K] | undefined {
    return this.registry.services.get(name)?.value as Services[K] | undefined;
  }

  /** Throws rather than returning undefined, for code that already declared the need. */
  require<K extends ServiceName>(name: K): Services[K] {
    const value = this.get(name);
    if (value === undefined) {
      throw new Error(`No plugin provides the service "${name}".`);
    }
    return value;
  }

  async provide<K extends ServiceName>(name: K, value: Services[K]): Promise<void> {
    const existing = this.registry.services.get(name);
    if (existing !== undefined) {
      throw new Error(`The service "${name}" is already provided; unload the other plugin first.`);
    }
    this.registry.services.set(name, { value, owner: this.scope });
    this.scope.provided.add(name);
    await this.settle();
  }

  /**
   * Runs `apply` once every named service exists, and unloads it again if any of
   * them goes away. The callback gets its own scope, so that unload is exact.
   */
  async inject(
    names: readonly ServiceName[],
    apply: (ctx: Context) => void | Promise<void>,
    label = 'inject',
  ): Promise<void> {
    const waiter: Waiter = { names, apply, owner: this.scope, label };
    this.registry.waiters.add(waiter);
    this.scope.waiters.add(waiter);
    await this.settle();
  }

  async plugin<Config>(plugin: Plugin<Config>, config: Config): Promise<Fork> {
    const scope = new Scope(this.scope);
    const child = new Context(this.registry, scope);
    const run = async (ctx: Context): Promise<void> => {
      await plugin.apply(ctx, config);
    };

    await (plugin.inject === undefined || plugin.inject.length === 0
      ? run(child)
      : child.inject(plugin.inject, run, plugin.name));

    return { dispose: async () => this.disposeScope(scope) };
  }

  /** Undone, in reverse order, when this plugin unloads. */
  effect(dispose: () => void | Promise<void>): void {
    this.scope.effects.push(dispose);
  }

  /** Unloads this context's plugin and everything it loaded. */
  async dispose(): Promise<void> {
    await this.disposeScope(this.scope);
  }

  /** Every service currently published, for `/status` and for diagnostics. */
  get provided(): ServiceName[] {
    return [...this.registry.services.keys()].toSorted((a, b) => a.localeCompare(b));
  }

  private async settle(): Promise<void> {
    // A nested call would interleave two passes over the same waiter set; let the
    // outer loop notice instead.
    if (this.registry.settling) {
      this.registry.dirty = true;
      return;
    }

    this.registry.settling = true;
    try {
      this.registry.dirty = false;
      do {
        await this.unloadUnsatisfied();
        await this.loadSatisfied();
      } while (this.takeDirty());
    } finally {
      this.registry.settling = false;
    }
  }

  /** Read-and-clear, so a change made during the pass schedules exactly one more. */
  private takeDirty(): boolean {
    const { dirty } = this.registry;
    this.registry.dirty = false;
    return dirty;
  }

  private satisfied(waiter: Waiter): boolean {
    return waiter.names.every((name) => this.registry.services.has(name));
  }

  private async unloadUnsatisfied(): Promise<void> {
    const loaded = [...this.registry.waiters];
    for (const waiter of loaded) {
      if (waiter.scope && !this.satisfied(waiter)) {
        const { scope } = waiter;
        waiter.scope = undefined;
        await this.disposeScope(scope, { keepWaiter: waiter });
      }
    }
  }

  private async loadSatisfied(): Promise<void> {
    const pending = [...this.registry.waiters];
    for (const waiter of pending) {
      if (!waiter.scope && this.satisfied(waiter)) {
        const scope = new Scope(waiter.owner);
        waiter.scope = scope;
        await waiter.apply(new Context(this.registry, scope));
      }
    }
  }

  /**
   * Depth first, then effects in reverse: a plugin tears down in the opposite
   * order to the one it built in, which is the only order its own effects can
   * assume.
   */
  private async disposeScope(scope: Scope, options: { keepWaiter?: Waiter } = {}): Promise<void> {
    if (scope.disposed) return;
    scope.disposed = true;

    const children = [...scope.children];
    for (const child of children) {
      await this.disposeScope(child, options);
    }

    for (const effect of scope.effects.toReversed()) {
      await effect();
    }
    scope.effects.length = 0;

    this.revokeServices(scope);
    this.forgetWaiters(scope, options.keepWaiter);

    scope.parent?.children.delete(scope);
    await this.settle();
  }

  private revokeServices(scope: Scope): void {
    for (const name of scope.provided) {
      if (this.registry.services.get(name)?.owner === scope) {
        this.registry.services.delete(name);
      }
    }
    scope.provided.clear();
  }

  /**
   * A waiter unloaded because it lost a dependency stays registered, so it can load
   * again when the dependency comes back. One whose owner is going away does not.
   */
  private forgetWaiters(scope: Scope, keep?: Waiter): void {
    for (const waiter of scope.waiters) {
      if (waiter !== keep) this.registry.waiters.delete(waiter);
    }
    scope.waiters.clear();
  }
}
