import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';
import { CodeToolsService } from '../tools/code-tools.service.js';
import { createLangChainTools } from '../tools/langchain-tools.js';

const MCP_SERVER_NAME = 'ai-code-companion';

/**
 * The environment for the spawned MCP server.
 *
 * A stdio MCP child does NOT inherit the parent environment: the SDK starts it
 * from a small safe default set. Without this the subprocess would silently run
 * on default settings — different allow-list, different Chroma target — so the
 * effective configuration is forwarded explicitly.
 *
 * Exported because it is the whole contract between the two processes, and a
 * missing key here is invisible until someone notices the child searching an
 * empty index.
 */
export const mcpChildEnv = (config: AppConfig): Record<string, string> => {
  const { chroma, embeddings, indexing, llm, ollama } = config;
  const env: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    NODE_ENV: process.env.NODE_ENV,
    LOG_LEVEL: process.env.LOG_LEVEL,
    CHROMA_ENABLED: String(chroma.enabled),
    CHROMA_URL: chroma.url,
    CHROMA_COLLECTION: chroma.collection,
    EMBEDDINGS_PROVIDER: embeddings.provider,
    EMBEDDINGS_DIMENSIONS: String(embeddings.dimensions),
    EMBEDDINGS_MODEL: embeddings.model,
    INDEX_ALLOWED_ROOTS: indexing.allowedRoots.join(','),
    MAX_FILE_BYTES: String(indexing.maxFileBytes),
    METADATA_DB: config.metadataDb,
    OPENAI_API_KEY: llm.apiKey,
    LLM_BASE_URL: llm.baseUrl,
    // The child embeds too, so a local Ollama on a non-default address has to
    // reach it — otherwise it quietly falls back to loopback and finds nothing.
    OLLAMA_BASE_URL: ollama.baseUrl,
    // Guard against recursion: the child must never spawn another MCP server.
    MCP_CLIENT_ENABLED: 'false',
  };

  // An unset key must be absent, not the string "undefined".
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
};

/**
 * Supplies the agent's toolbelt.
 *
 * By default the tools are called in-process — one object hop, no subprocess.
 * With `MCP_CLIENT_ENABLED=true` the very same tools are loaded through
 * `@langchain/mcp-adapters`, which spawns `dist/mcp-server.js` and speaks JSON-RPC
 * over stdio, proving the MCP surface works end to end. A failed connection
 * degrades to the in-process tools rather than breaking chat.
 *
 * Caveat worth knowing: the spawned server is a separate process with its own
 * vector store. That is only equivalent when Chroma is running — with the
 * in-memory fallback the subprocess sees an empty index.
 */
@Injectable()
export class McpToolsService implements OnModuleDestroy {
  private client?: MultiServerMCPClient;
  private tools?: Promise<StructuredToolInterface[]>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly codeTools: CodeToolsService,
    @InjectPinoLogger(McpToolsService.name) private readonly logger: PinoLogger,
  ) {}

  getTools(): Promise<StructuredToolInterface[]> {
    this.tools ??= this.load();
    return this.tools;
  }

  private async load(): Promise<StructuredToolInterface[]> {
    const local = createLangChainTools(this.codeTools);
    if (!this.config.mcp.clientEnabled) {
      this.logger.info(
        { tools: local.map((tool) => tool.name) },
        'Using in-process LangChain tools',
      );
      return local;
    }

    try {
      this.client = new MultiServerMCPClient({
        mcpServers: {
          [MCP_SERVER_NAME]: {
            transport: 'stdio',
            command: this.config.mcp.serverCommand,
            args: [...this.config.mcp.serverArgs],
            env: mcpChildEnv(this.config),
            cwd: process.cwd(),
            // The child logs to stderr; inheriting keeps it in the backend's output.
            stderr: 'inherit',
          },
        },
        onConnectionError: 'throw',
      });

      const tools = (await this.client.getTools()) as unknown as StructuredToolInterface[];
      this.logger.info(
        { tools: tools.map((tool) => tool.name), command: this.config.mcp.serverCommand },
        'Loaded tools over MCP stdio',
      );
      return tools;
    } catch (error) {
      this.logger.warn(
        { err: error },
        'MCP client failed to start (did you run `npm run build`?), using in-process tools',
      );
      await this.close();
      return local;
    }
  }

  private async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
