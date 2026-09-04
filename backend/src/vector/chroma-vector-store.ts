import { ChromaClient, type Collection, type Metadata } from 'chromadb';
import type { Embeddings } from '@langchain/core/embeddings';
import type {
  CodeChunk,
  CodeChunkMetadata,
  ScoredChunk,
  SearchOptions,
  VectorStore,
} from './vector-store.types.js';

export interface ChromaVectorStoreOptions {
  readonly url: string;
  readonly collection: string;
  /** Chroma rejects oversized payloads; upserts are sent in batches of this size. */
  readonly batchSize?: number;
}

/**
 * `http://localhost:8000` -> `{ host, port, ssl }`, the shape chromadb 3 wants.
 *
 * The scheme check is not ceremony: `new URL('localhost:8000')` *succeeds*, with
 * `localhost:` as the protocol and an empty hostname, so a perfectly natural
 * `CHROMA_URL=localhost:8000` would otherwise connect to nowhere in silence.
 */
export const parseChromaUrl = (url: string): { host: string; port: number; ssl: boolean } => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`CHROMA_URL is not a URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`CHROMA_URL must start with http:// or https://, received: ${url}`);
  }

  const ssl = parsed.protocol === 'https:';
  const defaultPort = ssl ? 443 : 8000;
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? defaultPort : Number(parsed.port),
    ssl,
  };
};

export class ChromaVectorStore implements VectorStore {
  readonly kind = 'chroma' as const;

  private readonly client: ChromaClient;
  private readonly batchSize: number;
  private collection?: Promise<Collection>;

  constructor(
    private readonly embeddings: Embeddings,
    private readonly options: ChromaVectorStoreOptions,
  ) {
    this.client = new ChromaClient(parseChromaUrl(options.url));
    this.batchSize = options.batchSize ?? 100;
  }

  /** Throws if the server is unreachable — the caller decides whether to fall back. */
  async healthCheck(): Promise<void> {
    await this.client.heartbeat();
  }

  private getCollection(): Promise<Collection> {
    // Memoised so concurrent indexing jobs don't race to create the collection.
    this.collection ??= this.client
      .getOrCreateCollection({
        name: this.options.collection,
        // We embed with LangChain and always pass vectors explicitly, so Chroma
        // must not try to download a default embedding model.
        embeddingFunction: null,
        configuration: {
          hnsw: { space: 'cosine', ef_construction: 200, max_neighbors: 16 },
        },
      })
      .catch((error: unknown) => {
        this.collection = undefined;
        throw error;
      });
    return this.collection;
  }

  async upsert(chunks: readonly CodeChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const collection = await this.getCollection();

    for (let offset = 0; offset < chunks.length; offset += this.batchSize) {
      const batch = chunks.slice(offset, offset + this.batchSize);
      const embeddings = await this.embeddings.embedDocuments(batch.map((chunk) => chunk.text));
      await collection.upsert({
        ids: batch.map((chunk) => chunk.id),
        documents: batch.map((chunk) => chunk.text),
        metadatas: batch.map((chunk) => chunk.metadata as unknown as Metadata),
        embeddings,
      });
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<ScoredChunk[]> {
    const limit = options.limit ?? 5;
    if (limit <= 0) return [];

    const collection = await this.getCollection();
    const queryEmbeddings = [await this.embeddings.embedQuery(query)];
    const result = await collection.query({
      queryEmbeddings,
      nResults: limit,
      where: options.root ? { root: { $eq: options.root } } : undefined,
      include: ['documents', 'metadatas', 'distances'],
    });

    return (result.rows()[0] ?? []).map((row) => ({
      id: row.id,
      text: row.document ?? '',
      metadata: (row.metadata ?? {}) as unknown as CodeChunkMetadata,
      // The collection uses cosine space, where distance = 1 - similarity.
      score: 1 - (row.distance ?? 1),
    }));
  }

  async deleteByRoot(root: string): Promise<void> {
    const collection = await this.getCollection();
    await collection.delete({ where: { root: { $eq: root } } });
  }

  async count(): Promise<number> {
    const collection = await this.getCollection();
    return collection.count();
  }
}
