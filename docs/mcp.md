# The MCP server

Build once, then point any MCP client at `node dist/mcp-server.js`:

```bash
npm run build --workspace backend
```

**Claude Code** — `claude mcp add ai-code-companion --env INDEX_ALLOWED_ROOTS=$HOME/projects -- node /absolute/path/to/backend/dist/mcp-server.js`

**Cursor / Claude Desktop / Windsurf** — add to the client's MCP config
(`~/.cursor/mcp.json`, `claude_desktop_config.json`, …):

```json
{
  "mcpServers": {
    "ai-code-companion": {
      "command": "node",
      "args": ["/absolute/path/to/backend/dist/mcp-server.js"],
      "env": {
        "INDEX_ALLOWED_ROOTS": "/Users/you/projects",
        "CHROMA_URL": "http://localhost:8000"
      }
    }
  }
}
```

Tools exposed:

| Tool               | Input                      | Returns                                                   |
| ------------------ | -------------------------- | --------------------------------------------------------- |
| `search_code`      | `query`, `limit?`, `root?` | Ranked snippets with `path:startLine-endLine` and scores  |
| `explain_file`     | `path`                     | Language, size, imports, top-level symbols, a summary     |
| `generate_snippet` | `prompt`, `language?`      | A starter scaffold (template-generated, clearly labelled) |

Each returns both human-readable text **and** `structuredContent` validated against a declared
output schema.

Two things worth knowing:

- **stdio is the protocol channel.** All logging in `mcp-server.ts` is pinned to stderr
  (`stderrLoggerParams`); one stray `console.log` would corrupt the JSON-RPC stream.
- **A stdio child does not inherit your environment.** The MCP SDK starts it from a small safe
  default set, so pass `env` explicitly in the editor config (as above). `McpToolsService` does
  the same when it spawns the server itself.

### Sharing an index with the editor

`search_code` reads whatever vector store the process can reach. The MCP server is a _separate
process_ from the backend, so they only share an index when both talk to a running ChromaDB.
With the in-memory fallback each process has its own (empty) index. Start Chroma if you want
your editor to search what the app indexed.

### Routing the app's own agent through MCP

```bash
MCP_CLIENT_ENABLED=true npm run start --workspace backend
```

`McpToolsService` then loads its tools with `@langchain/mcp-adapters` — a real stdio round-trip
per tool call instead of an in-process call. It falls back to the in-process tools (with a
warning) if the server cannot start.

---
