import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface IndexedRootRecord {
  readonly path: string;
  readonly fileCount: number;
  readonly chunkCount: number;
  readonly lastIndexedAt: string;
  /** Which vector store held the chunks — `memory` does not survive a restart. */
  readonly store: string;
}

/**
 * What one file looked like the last time it was indexed.
 *
 * `size` and `mtimeMs` are the cheap comparison — matching both means the file
 * can be skipped without even being read. `contentHash` is the honest one, and
 * settles the cases where mtime lies: a fresh clone, a checkout, a touch.
 */
export interface IndexedFileRecord {
  readonly root: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly contentHash: string;
  readonly chunkCount: number;
}

export interface MetadataStore {
  readonly kind: 'sqlite' | 'memory';
  upsertRoot(record: IndexedRootRecord): Promise<void>;
  listRoots(): Promise<IndexedRootRecord[]>;
  removeRoot(path: string): Promise<void>;

  /** Per-file state for one root, keyed by absolute path. */
  listFiles(root: string): Promise<IndexedFileRecord[]>;
  upsertFiles(records: readonly IndexedFileRecord[]): Promise<void>;
  removeFiles(paths: readonly string[]): Promise<void>;

  close(): Promise<void>;
}

export class MemoryMetadataStore implements MetadataStore {
  readonly kind = 'memory' as const;
  private readonly roots = new Map<string, IndexedRootRecord>();
  private readonly files = new Map<string, IndexedFileRecord>();

  async upsertRoot(record: IndexedRootRecord): Promise<void> {
    this.roots.set(record.path, record);
  }

  async listRoots(): Promise<IndexedRootRecord[]> {
    return [...this.roots.values()].toSorted((a, b) => a.path.localeCompare(b.path));
  }

  async removeRoot(path: string): Promise<void> {
    this.roots.delete(path);
    for (const [key, record] of this.files) {
      if (record.root === path) this.files.delete(key);
    }
  }

  async listFiles(root: string): Promise<IndexedFileRecord[]> {
    return [...this.files.values()].filter((record) => record.root === root);
  }

  async upsertFiles(records: readonly IndexedFileRecord[]): Promise<void> {
    for (const record of records) this.files.set(record.path, record);
  }

  async removeFiles(paths: readonly string[]): Promise<void> {
    for (const path of paths) this.files.delete(path);
  }

  // Nothing to release: the map dies with the process.
  async close(): Promise<void> {
    return undefined;
  }
}

/** Minimal promise wrapper over the callback-based `sqlite3` driver. */
interface SqliteDatabase {
  run(sql: string, params: unknown[], callback: (error: Error | null) => void): void;
  all(
    sql: string,
    params: unknown[],
    callback: (error: Error | null, rows: unknown[]) => void,
  ): void;
  close(callback: (error: Error | null) => void): void;
}

class SqliteMetadataStore implements MetadataStore {
  readonly kind = 'sqlite' as const;

  constructor(private readonly db: SqliteDatabase) {}

  private run(sql: string, params: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (error) => (error ? reject(error) : resolve()));
    });
  }

  private all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows as T[])));
    });
  }

  async migrate(): Promise<void> {
    await this.run(`
      CREATE TABLE IF NOT EXISTS indexed_roots (
        path            TEXT PRIMARY KEY,
        file_count      INTEGER NOT NULL DEFAULT 0,
        chunk_count     INTEGER NOT NULL DEFAULT 0,
        last_indexed_at TEXT    NOT NULL,
        store           TEXT    NOT NULL
      )
    `);
    await this.run(`
      CREATE TABLE IF NOT EXISTS indexed_files (
        path         TEXT PRIMARY KEY,
        root         TEXT    NOT NULL,
        size         INTEGER NOT NULL,
        mtime_ms     REAL    NOT NULL,
        content_hash TEXT    NOT NULL,
        chunk_count  INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Every re-index reads one root's worth of rows; without this that is a scan.
    await this.run('CREATE INDEX IF NOT EXISTS indexed_files_root ON indexed_files (root)');
  }

  async upsertRoot(record: IndexedRootRecord): Promise<void> {
    await this.run(
      `INSERT INTO indexed_roots (path, file_count, chunk_count, last_indexed_at, store)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         file_count = excluded.file_count,
         chunk_count = excluded.chunk_count,
         last_indexed_at = excluded.last_indexed_at,
         store = excluded.store`,
      [record.path, record.fileCount, record.chunkCount, record.lastIndexedAt, record.store],
    );
  }

  async listRoots(): Promise<IndexedRootRecord[]> {
    const rows = await this.all<{
      path: string;
      file_count: number;
      chunk_count: number;
      last_indexed_at: string;
      store: string;
    }>('SELECT * FROM indexed_roots ORDER BY path');
    return rows.map((row) => ({
      path: row.path,
      fileCount: row.file_count,
      chunkCount: row.chunk_count,
      lastIndexedAt: row.last_indexed_at,
      store: row.store,
    }));
  }

  async removeRoot(path: string): Promise<void> {
    await this.run('DELETE FROM indexed_roots WHERE path = ?', [path]);
    await this.run('DELETE FROM indexed_files WHERE root = ?', [path]);
  }

  async listFiles(root: string): Promise<IndexedFileRecord[]> {
    const rows = await this.all<{
      path: string;
      root: string;
      size: number;
      mtime_ms: number;
      content_hash: string;
      chunk_count: number;
    }>('SELECT * FROM indexed_files WHERE root = ?', [root]);
    return rows.map((row) => ({
      path: row.path,
      root: row.root,
      size: row.size,
      mtimeMs: row.mtime_ms,
      contentHash: row.content_hash,
      chunkCount: row.chunk_count,
    }));
  }

  async upsertFiles(records: readonly IndexedFileRecord[]): Promise<void> {
    for (const record of records) {
      await this.run(
        `INSERT INTO indexed_files (path, root, size, mtime_ms, content_hash, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           root = excluded.root,
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           content_hash = excluded.content_hash,
           chunk_count = excluded.chunk_count`,
        [
          record.path,
          record.root,
          record.size,
          record.mtimeMs,
          record.contentHash,
          record.chunkCount,
        ],
      );
    }
  }

  async removeFiles(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      await this.run('DELETE FROM indexed_files WHERE path = ?', [path]);
    }
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

/**
 * `sqlite3` is an optional dependency: it is a native module and a failed build on
 * an exotic platform must not take the whole app down. We degrade to an in-memory
 * store, which only costs the list of indexed folders across restarts.
 */
type DatabaseConstructor = new (
  file: string,
  callback: (error: Error | null) => void,
) => SqliteDatabase;

/**
 * `new Database(file)` reports a failed open asynchronously. Without the callback
 * that failure surfaces as an *uncaught exception* and takes the process down —
 * which is exactly what the fallback below exists to prevent.
 */
const openDatabase = (Database: DatabaseConstructor, file: string): Promise<SqliteDatabase> =>
  new Promise((resolve, reject) => {
    const db: SqliteDatabase = new Database(file, (error) => {
      if (error) reject(error);
      else resolve(db);
    });
  });

/** The synchronous shape `node:sqlite` offers, which is the whole of what is used. */
interface NodeSqliteDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

/**
 * `node:sqlite` behind the same three methods the callback driver offers.
 *
 * Synchronous underneath, which is fine here: every call is a single statement
 * against a local file, and the alternative is a native module that has to be
 * compiled on the user's machine — the one thing standing between this backend
 * and a single-file build.
 */
const adaptNodeSqlite = (db: NodeSqliteDatabase): SqliteDatabase => ({
  run(sql, params, callback) {
    try {
      db.prepare(sql).run(...params);
      callback(null);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  },
  all(sql, params, callback) {
    try {
      callback(null, db.prepare(sql).all(...params));
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)), []);
    }
  },
  close(callback) {
    try {
      db.close();
      callback(null);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  },
});

/** Node's own SQLite, when this runtime has it. Present and unflagged from Node 22.5. */
const openBuiltIn = async (filename: string): Promise<SqliteDatabase> => {
  const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (path: string) => NodeSqliteDatabase;
  };

  return adaptNodeSqlite(new DatabaseSync(filename));
};

const openDriver = async (filename: string): Promise<SqliteDatabase> => {
  const imported = (await import('sqlite3')) as unknown as {
    default?: { Database: DatabaseConstructor };
    Database?: DatabaseConstructor;
  };
  const Database = imported.default?.Database ?? imported.Database;
  if (!Database) throw new Error('sqlite3 module did not export a Database constructor');

  return openDatabase(Database, filename);
};

/**
 * Node's built-in SQLite first, the native `sqlite3` package second, and an
 * in-memory store if neither works — which costs only the list of indexed folders
 * across restarts, and is better than refusing to start.
 */
export const createMetadataStore = async (
  filename: string,
  onFallback?: (reason: string) => void,
): Promise<MetadataStore> => {
  try {
    await mkdir(dirname(filename), { recursive: true });

    const database = await openBuiltIn(filename).catch(() => openDriver(filename));
    const store = new SqliteMetadataStore(database);
    await store.migrate();
    return store;
  } catch (error) {
    onFallback?.(error instanceof Error ? error.message : String(error));
    return new MemoryMetadataStore();
  }
};

export const METADATA_STORE = 'METADATA_STORE';
