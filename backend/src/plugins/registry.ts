/**
 * A named set of alternatives that plugins add to.
 *
 * The difference between this and a `switch` on a config enum is who can extend
 * it. A registry entry is claimed at load time by whoever loaded the plugin, so a
 * third party can add `qdrant` or `ollama` without touching the selection code —
 * which is the whole point of the exercise.
 */
export class ProviderRegistry<Value, Options = void, Meta = void> {
  private readonly providers = new Map<
    string,
    { readonly create: (options: Options) => Value | Promise<Value>; readonly meta: Meta }
  >();

  constructor(private readonly label: string) {}

  /**
   * Duplicate kinds are a load error rather than last-one-wins: two plugins
   * claiming `chroma` is a disagreement someone has to resolve, and picking one
   * silently means the app runs on whichever happened to load second.
   */
  register(kind: string, create: (options: Options) => Value | Promise<Value>, meta: Meta): void {
    if (this.providers.has(kind)) {
      throw new Error(`Two plugins both provide the ${this.label} "${kind}".`);
    }
    this.providers.set(kind, { create, meta });
  }

  has(kind: string): boolean {
    return this.providers.has(kind);
  }

  /** The error names what *is* available, because the usual cause is a typo. */
  async create(kind: string, options: Options): Promise<Value> {
    const provider = this.providers.get(kind);
    if (provider === undefined) {
      throw new Error(
        `No plugin provides the ${this.label} "${kind}". Available: ${this.kinds.join(', ') || 'none'}.`,
      );
    }
    return provider.create(options);
  }

  /**
   * What a kind declared about itself at registration. Facts the app needs before
   * it creates anything — "does this store survive a restart" — have to come from
   * the plugin, because inferring them from the name only works for the two the
   * core happens to know.
   */
  describe(kind: string): Meta | undefined {
    return this.providers.get(kind)?.meta;
  }

  get kinds(): string[] {
    return [...this.providers.keys()].toSorted((a, b) => a.localeCompare(b));
  }
}
