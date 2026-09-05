import { z } from 'zod';

export const indexJobStateSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);

export const indexProgressEventSchema = z.object({
  jobId: z.string(),
  root: z.string(),
  state: indexJobStateSchema,
  filesDiscovered: z.number().int().nonnegative(),
  filesIndexed: z.number().int().nonnegative(),
  /**
   * Files whose content was unchanged since the last run, so they were neither
   * re-chunked nor re-embedded. Counted within `filesIndexed`.
   */
  filesSkipped: z.number().int().nonnegative(),
  chunksIndexed: z.number().int().nonnegative(),
  currentFile: z.string().optional(),
  error: z.string().optional(),
  /** 0-100; stays at 0 while discovery is still running. */
  percent: z.number().int().min(0).max(100),
});

export const indexedRootSchema = z.object({
  path: z.string(),
  fileCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  lastIndexedAt: z.string(),
  /**
   * True when the chunks were written to a non-persistent store and the process
   * has restarted since — the folder is listed but no longer searchable.
   */
  stale: z.boolean(),
});

export const vectorStoreKindSchema = z.enum(['chroma', 'memory']);
export const metadataStoreKindSchema = z.enum(['sqlite', 'memory']);

export const indexStatusSchema = z.object({
  activeJob: indexProgressEventSchema.nullable(),
  roots: z.array(indexedRootSchema),
  vectorStore: vectorStoreKindSchema,
  metadataStore: metadataStoreKindSchema,
  totalChunks: z.number().int().nonnegative(),
});

export const indexJobSchema = z.object({
  id: z.string(),
  root: z.string(),
  state: indexJobStateSchema,
  filesDiscovered: z.number().int().nonnegative(),
  filesIndexed: z.number().int().nonnegative(),
  filesSkipped: z.number().int().nonnegative(),
  chunksIndexed: z.number().int().nonnegative(),
  currentFile: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
});

/** `POST /index` body. */
export const indexRequestSchema = z.object({
  path: z.string().trim().min(1, 'path is required'),
});

/** `DELETE /index` query string. */
export const removeRootQuerySchema = z.object({
  path: z.string().trim().min(1, 'path is required'),
});

export const cancelIndexingResponseSchema = z.object({ cancelled: z.boolean() });

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  uptime: z.number().nonnegative(),
});

export type IndexJobState = z.infer<typeof indexJobStateSchema>;
export type IndexProgressEvent = z.infer<typeof indexProgressEventSchema>;
export type IndexedRoot = z.infer<typeof indexedRootSchema>;
export type VectorStoreKind = z.infer<typeof vectorStoreKindSchema>;
export type MetadataStoreKind = z.infer<typeof metadataStoreKindSchema>;
export type IndexStatus = z.infer<typeof indexStatusSchema>;
export type IndexJob = z.infer<typeof indexJobSchema>;
export type IndexRequest = z.infer<typeof indexRequestSchema>;
export type RemoveRootQuery = z.infer<typeof removeRootQuerySchema>;
export type CancelIndexingResponse = z.infer<typeof cancelIndexingResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
