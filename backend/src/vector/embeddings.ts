import { Embeddings, type EmbeddingsParams } from '@langchain/core/embeddings';

export interface HashingEmbeddingsParams extends EmbeddingsParams {
  dimensions?: number;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a. Stable across processes, which matters for a persisted index. */
export const fnv1a = (input: string, seed = FNV_OFFSET): number => {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    // Code units, not code points: FNV-1a is defined over bytes, and folding a
    // surrogate pair into one value would change every hash for no benefit.
    // eslint-disable-next-line unicorn/prefer-code-point
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
};

/**
 * Splits source text into identifier-ish tokens: `getUserById` and `get_user_by_id`
 * both collapse to `get user by id`, so a natural-language query can match code.
 */
export const tokenize = (text: string): string[] =>
  text
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && token.length < 40);

/**
 * Deterministic local embeddings using the hashing trick (signed, sublinear TF,
 * L2-normalised). Not semantic, but it is a real lexical vector space: the whole
 * retrieval pipeline works offline and tests stay deterministic. Swap for
 * `OpenAIEmbeddings` by setting `EMBEDDINGS_PROVIDER=openai`.
 */
export class HashingEmbeddings extends Embeddings {
  readonly dimensions: number;

  constructor(params: HashingEmbeddingsParams = {}) {
    super(params);
    this.dimensions = params.dimensions ?? 384;
    if (!Number.isInteger(this.dimensions) || this.dimensions < 8) {
      throw new Error(`dimensions must be an integer >= 8, received ${this.dimensions}`);
    }
  }

  embed(text: string): number[] {
    const counts = new Map<number, number>();
    for (const token of tokenize(text)) {
      const bucket = fnv1a(token) % this.dimensions;
      // A second hash decides the sign so unrelated tokens colliding in the same
      // bucket cancel out instead of always reinforcing each other.
      const sign = fnv1a(token, 0x9dc5811c) % 2 === 0 ? 1 : -1;
      counts.set(bucket, (counts.get(bucket) ?? 0) + sign);
    }

    const vector = new Array<number>(this.dimensions).fill(0);
    let sumOfSquares = 0;
    for (const [bucket, count] of counts) {
      // Signed counts can cancel to exactly zero; `log(0)` would poison the vector.
      if (count === 0) continue;
      // Sublinear scaling keeps a repeated token from dominating the vector.
      const weight = Math.sign(count) * (1 + Math.log(Math.abs(count)));
      vector[bucket] = weight;
      sumOfSquares += weight * weight;
    }

    if (sumOfSquares === 0) return vector;
    const norm = Math.sqrt(sumOfSquares);
    return vector.map((value) => value / norm);
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    return documents.map((document) => this.embed(document));
  }

  async embedQuery(document: string): Promise<number[]> {
    return this.embed(document);
  }
}

export const cosineSimilarity = (a: readonly number[], b: readonly number[]): number => {
  if (a.length !== b.length) {
    throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [index, left] of a.entries()) {
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};
