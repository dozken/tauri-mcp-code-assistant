import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type LlmProvider = 'stub' | 'openai';
export type EmbeddingsProvider = 'hashing' | 'openai';

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
  readonly embeddings: {
    readonly provider: EmbeddingsProvider;
    readonly dimensions: number;
    readonly model: string;
  };
  readonly llm: {
    readonly provider: LlmProvider;
    readonly model: string;
    readonly apiKey?: string;
    readonly baseUrl?: string;
    readonly temperature: number;
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
  };
  readonly mcp: {
    /** Route agent tool calls through a real MCP stdio round-trip. */
    readonly clientEnabled: boolean;
    readonly serverCommand: string;
    readonly serverArgs: string[];
  };
  readonly metadataDb: string;
}

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const list = (value: string | undefined, fallback: string[]): string[] => {
  const items = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const apiKey = env.OPENAI_API_KEY?.trim() || undefined;

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
    embeddings: {
      // Without an API key we fall back to deterministic local embeddings so the
      // whole retrieval pipeline still works offline.
      provider: (env.EMBEDDINGS_PROVIDER as EmbeddingsProvider) ?? (apiKey ? 'openai' : 'hashing'),
      dimensions: num(env.EMBEDDINGS_DIMENSIONS, 384),
      model: env.EMBEDDINGS_MODEL ?? 'text-embedding-3-small',
    },
    llm: {
      provider: (env.LLM_PROVIDER as LlmProvider) ?? (apiKey ? 'openai' : 'stub'),
      model: env.LLM_MODEL ?? 'gpt-4o-mini',
      apiKey,
      baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
      temperature: Number(env.LLM_TEMPERATURE ?? 0),
    },
    indexing: {
      chunkSize: num(env.CHUNK_SIZE, 1200),
      chunkOverlap: num(env.CHUNK_OVERLAP, 200),
      maxFileBytes: num(env.MAX_FILE_BYTES, 512 * 1024),
      concurrency: num(env.INDEX_CONCURRENCY, 8),
      allowedRoots: list(env.INDEX_ALLOWED_ROOTS, [homedir()]).map((entry) => resolve(entry)),
    },
    mcp: {
      clientEnabled: bool(env.MCP_CLIENT_ENABLED, false),
      serverCommand: env.MCP_SERVER_COMMAND ?? process.execPath,
      serverArgs: list(env.MCP_SERVER_ARGS, [resolve(process.cwd(), 'dist/mcp-server.js')]),
    },
    metadataDb: env.METADATA_DB ?? resolve(process.cwd(), '.data/metadata.sqlite'),
  };
};

export const APP_CONFIG = 'APP_CONFIG';
