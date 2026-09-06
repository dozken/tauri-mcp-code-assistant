import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly corsOrigins: string[];
  readonly chroma: {
    readonly url: string;
    readonly collection: string;
    /** When false the app never contacts Chroma and uses the in-memory store. */
    readonly enabled: boolean;
  };
  readonly vector: {
    /**
     * `auto` keeps the historical behaviour — Chroma when enabled, falling back to
     * memory when no server answers. Any other value names a registry kind and is
     * used as given, with no fallback: someone who asked for `qdrant` wants to know
     * it is missing, not to be quietly downgraded.
     */
    readonly store: string;
  };
  readonly plugins: {
    /** Module specifiers to load at startup. Runs third-party code in this process. */
    readonly load: readonly string[];
  };
  readonly embeddings: {
    /**
     * A registry kind, like `llm.provider`. Naming one no plugin provides stops
     * the app at startup — an embedder chosen by typo would otherwise write an
     * index nothing can search, and say nothing about it.
     */
    readonly provider: string;
    readonly dimensions: number;
    /** Unset unless `EMBEDDINGS_MODEL` names one; the default belongs to the provider. */
    readonly model?: string;
  };
  /** Where a local Ollama listens. Used by both the chat model and the embedder. */
  readonly ollama: {
    readonly baseUrl: string;
  };
  readonly llm: {
    /**
     * A registry kind, not a fixed union: `stub` and `openai` ship with the app,
     * and a plugin can register another. An unknown name fails at startup with
     * the registered kinds listed, which is a better error than a type would give.
     */
    readonly provider: string;
    /**
     * Unset unless `LLM_MODEL` names one. The default belongs to the provider,
     * which is the only thing that knows what models it has — `gpt-4o-mini` is a
     * fine default for OpenAI and a name Ollama would try to pull and fail on.
     */
    readonly model?: string;
    readonly apiKey?: string;
    /** Where the provider lives, for one that is not at its own default. */
    readonly baseUrl?: string;
    readonly temperature: number;
    /**
     * Ceiling on a whole chat turn, tool calls included. A hung upstream model
     * otherwise holds the connection — and a gateway slot — open forever.
     */
    readonly timeoutMs: number;
    /** How many conversations the server remembers before evicting the oldest. */
    readonly maxConversations: number;
    /** Per-token delay for the stub model. Only meaningful when provider is `stub`. */
    readonly stubTokenDelayMs: number;
  };
  readonly auth: {
    /**
     * When false the guard is bypassed entirely. Only sensible for a throwaway
     * container; on a developer's machine it re-opens the hole below.
     */
    readonly enabled: boolean;
    /**
     * Bearer token for clients that send no `Origin` — scripts, the MCP server,
     * a packaged shell. Generated per run unless `COMPANION_TOKEN` pins it.
     */
    readonly token: string;
    /** Where the token is written so local tooling can find it. */
    readonly tokenFile: string;
  };
  readonly indexing: {
    readonly chunkSize: number;
    readonly chunkOverlap: number;
    readonly maxFileBytes: number;
    readonly concurrency: number;
    /**
     * Absolute directories the API is allowed to index. The backend binds to
     * loopback, but any local process can still reach it, so indexing is
     * confined to an explicit allow-list (defaults to the user's home dir).
     */
    readonly allowedRoots: string[];
    /**
     * Re-index a root when its files change on disk. Off by default: it holds an
     * OS watch handle per indexed root for as long as the app runs, which is a
     * cost the user should opt into rather than discover.
     */
    readonly watch: boolean;
    /** How long a root must be quiet before it is re-indexed. */
    readonly watchDebounceMs: number;
  };
  readonly mcp: {
    /** Route agent tool calls through a real MCP stdio round-trip. */
    readonly clientEnabled: boolean;
    readonly serverCommand: string;
    readonly serverArgs: string[];
  };
  /**
   * A fuse against a runaway local script, not a quota. See `rate-limit.ts`.
   */
  readonly rateLimit: {
    readonly enabled: boolean;
    readonly windowMs: number;
    readonly chatPerWindow: number;
    readonly indexPerWindow: number;
  };
  readonly metadataDb: string;
}

/** Treats an empty or whitespace-only variable as unset, which `??` would not. */
const text = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

/** Accepts a value only if it is one of `allowed`; anything else takes the fallback. */
const list = (value: string | undefined, fallback: string[]): string[] => {
  const items = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const apiKey = text(env.OPENAI_API_KEY);

  return {
    host: env.HOST ?? '127.0.0.1',
    port: num(env.PORT, 3001),
    corsOrigins: list(env.CORS_ORIGINS, [
      'http://localhost:1420',
      'http://127.0.0.1:1420',
      'tauri://localhost',
      'http://tauri.localhost',
    ]),
    chroma: {
      url: env.CHROMA_URL ?? 'http://localhost:8000',
      collection: env.CHROMA_COLLECTION ?? 'code-companion',
      enabled: bool(env.CHROMA_ENABLED, true),
    },
    vector: { store: text(env.VECTOR_STORE) ?? 'auto' },
    plugins: {
      load: (text(env.PLUGINS) ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    },
    embeddings: {
      // Without an API key we fall back to deterministic local embeddings so the
      // whole retrieval pipeline still works offline.
      provider: text(env.EMBEDDINGS_PROVIDER) ?? (apiKey ? 'openai' : 'hashing'),
      dimensions: num(env.EMBEDDINGS_DIMENSIONS, 384),
      model: text(env.EMBEDDINGS_MODEL),
    },
    ollama: { baseUrl: text(env.OLLAMA_BASE_URL) ?? 'http://127.0.0.1:11434' },
    llm: {
      provider: text(env.LLM_PROVIDER) ?? (apiKey ? 'openai' : 'stub'),
      model: text(env.LLM_MODEL),
      apiKey,
      // `OPENAI_BASE_URL` still works, but the setting is not OpenAI's: an Ollama
      // on another host needs the same field.
      baseUrl: text(env.LLM_BASE_URL) ?? text(env.OPENAI_BASE_URL),
      temperature: Number(env.LLM_TEMPERATURE ?? 0),
      timeoutMs: num(env.LLM_TIMEOUT_MS, 120_000),
      maxConversations: num(env.MAX_CONVERSATIONS, 200),
      stubTokenDelayMs: num(env.STUB_TOKEN_DELAY_MS, 8),
    },
    auth: {
      enabled: bool(env.AUTH_ENABLED, true),
      // A fresh token per run: a leaked one stops working when the app restarts.
      token: text(env.COMPANION_TOKEN) ?? randomBytes(24).toString('base64url'),
      tokenFile: env.COMPANION_TOKEN_FILE ?? join(homedir(), '.ai-code-companion', 'token'),
    },
    indexing: {
      chunkSize: num(env.CHUNK_SIZE, 1200),
      chunkOverlap: num(env.CHUNK_OVERLAP, 200),
      maxFileBytes: num(env.MAX_FILE_BYTES, 512 * 1024),
      concurrency: num(env.INDEX_CONCURRENCY, 8),
      allowedRoots: list(env.INDEX_ALLOWED_ROOTS, [homedir()]).map((entry) => resolve(entry)),
      watch: bool(env.INDEX_WATCH, false),
      watchDebounceMs: num(env.INDEX_WATCH_DEBOUNCE_MS, 1500),
    },
    mcp: {
      clientEnabled: bool(env.MCP_CLIENT_ENABLED, false),
      serverCommand: env.MCP_SERVER_COMMAND ?? process.execPath,
      serverArgs: list(env.MCP_SERVER_ARGS, [resolve(process.cwd(), 'dist/mcp-server.js')]),
    },
    rateLimit: {
      enabled: bool(env.RATE_LIMIT_ENABLED, true),
      windowMs: num(env.RATE_LIMIT_WINDOW_MS, 60_000),
      chatPerWindow: num(env.RATE_LIMIT_CHAT, 60),
      indexPerWindow: num(env.RATE_LIMIT_INDEX, 30),
    },
    metadataDb: env.METADATA_DB ?? resolve(process.cwd(), '.data/metadata.sqlite'),
  };
};

export const APP_CONFIG = 'APP_CONFIG';
