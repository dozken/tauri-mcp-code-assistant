# AI Code Companion

A desktop app that indexes a local folder and lets you chat with it. **Tauri v2 + React 19**
on the front, **NestJS 11** on the back, **LangChain** driving a tool-calling agent over a
**ChromaDB** vector store, and the same three tools published over **MCP** so any AI editor
can use them too.

It runs with **zero API keys and zero external services**. There is an offline `StubChatModel`
that implements the real `BaseChatModel` contract — tool binding, tool calls, token streaming —
and deterministic local embeddings, so the entire retrieval → tool-call → stream path is
exercised for real. Set `OPENAI_API_KEY` and the identical code path runs against a hosted model.

---

## Quick start

```bash
npm install          # or: bun install

npm run dev          # backend on :3001 + web UI on :1420
# or
npm run dev:tauri    # the same UI inside the Tauri desktop window
```

Open <http://127.0.0.1:1420>, click **Add folder**, point it at a repository, and ask a
question. `npm run dev:tauri` additionally needs the
[Tauri v2 system prerequisites](https://v2.tauri.app/start/prerequisites/) (Rust + WebView).

> **Path allow-list.** By default the backend will only index paths under `$HOME`. Widen it
> with `INDEX_ALLOWED_ROOTS=/path/one,/path/two`. See [Security](#security-notes).

### Optional: real ChromaDB

```bash
docker run -p 8000:8000 chromadb/chroma
```

With no server reachable the app logs a warning and falls back to an in-memory store —
usable immediately, but the index is lost on restart (folders are then flagged
*needs re-index* in the sidebar).

### Optional: a real model

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1   # or any OpenAI-compatible gateway
```

Copy `.env.example` for the full list of settings.

---

## Architecture

```
┌──────────────────────────── Tauri v2 window ────────────────────────────┐
│  React 19 · MUI 7 · Zustand                                             │
│    Sidebar (folders, progress)      ChatPanel (messages, streaming)     │
│    └─ @tauri-apps/plugin-dialog: native folder picker                   │
└───────────────┬──────────────────────────────────┬──────────────────────┘
       HTTP     │  POST /index · GET /status       │  Socket.IO
                │  POST /chat  · DELETE /index     │  index:progress
                │                                  │  chat:token|tool|done|error
┌───────────────▼──────────────────────────────────▼──────────────────────┐
│  NestJS 11 (ESM, Node 22, SWC in dev)                                   │
│                                                                          │
│  IndexingService ──► walk ──► chunk ──► embed ──► VectorStoreService     │
│                                                     ├─ ChromaVectorStore │
│                                                     └─ MemoryVectorStore │
│                                                        (fallback)        │
│  ChatService (agent loop)                                                │
│    model.bindTools(tools) ─► stream ─► tool_calls? ─► run ─► feed back   │
│                                    └─ no ─► stream tokens to the client  │
│                                                                          │
│  McpToolsService ──┬─ in-process LangChain tools            (default)    │
│                    └─ @langchain/mcp-adapters over stdio   (opt-in)      │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ same CodeToolsService
┌──────────────────────────────▼───────────────────────────────────────────┐
│  backend/src/mcp-server.ts — MCP server on stdio                         │
│    search_code · explain_file · generate_snippet                         │
│    ← Claude Code, Cursor, or any MCP client                              │
└──────────────────────────────────────────────────────────────────────────┘
```

### Layout

```
.
├── app/                            # Tauri v2 + React 19 client
│   ├── src/
│   │   ├── api/                    # http.ts, socket.ts, tauri.ts (guarded IPC)
│   │   ├── components/             # Sidebar, ChatPanel, MessageBubble
│   │   ├── hooks/useBackend.ts     # socket ⇄ store wiring, send/index actions
│   │   ├── store/appStore.ts       # Zustand: pure state + synchronous mutators
│   │   └── types.ts                # wire contract shared with the backend
│   ├── src-tauri/                  # Rust shell: tauri.conf.json, capabilities, app_info
│   ├── e2e/chat.spec.ts            # Playwright
│   ├── playwright.config.ts
│   ├── vite.config.ts
│   └── vitest.config.ts
│
└── backend/                        # NestJS 11
    ├── src/
    │   ├── chat/                   # controller, gateway, agent loop
    │   ├── indexing/               # controller, service, chunker, file walker
    │   ├── vector/                 # embeddings, Chroma + in-memory stores
    │   ├── tools/                  # CodeToolsService + schemas + LangChain wrappers
    │   ├── mcp/                    # MCP registration + @langchain/mcp-adapters client
    │   ├── llm/                    # StubChatModel + provider factory
    │   ├── common/                 # pino logging, SQLite metadata, path guard
    │   └── mcp-server.ts           # MCP stdio entry point
    ├── stryker.config.json
    └── vitest.config.ts
```

### HTTP API

| Method   | Path            | Body / Query        | Notes                                        |
| -------- | --------------- | ------------------- | -------------------------------------------- |
| `POST`   | `/index`        | `{ "path": "..." }` | `202` — returns the job; progress via socket  |
| `POST`   | `/index/cancel` | –                   | Aborts the running job                        |
| `DELETE` | `/index`        | `?path=...`         | `204` — drops the folder's chunks             |
| `GET`    | `/status`       | –                   | Active job, folders, store kinds, chunk count |
| `GET`    | `/health`       | –                   | Liveness                                      |
| `POST`   | `/chat`         | `ChatRequestDto`    | Blocking; the UI streams over Socket.IO       |

Socket.IO events — client→server: `chat:send`, `chat:cancel`; server→client:
`index:progress`, `chat:token`, `chat:tool`, `chat:done`, `chat:error`.

---

## Connecting an AI editor to the MCP server

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

| Tool               | Input                                | Returns                                                   |
| ------------------ | ------------------------------------ | --------------------------------------------------------- |
| `search_code`      | `query`, `limit?`, `root?`           | Ranked snippets with `path:startLine-endLine` and scores   |
| `explain_file`     | `path`                               | Language, size, imports, top-level symbols, a summary      |
| `generate_snippet` | `prompt`, `language?`                | A starter scaffold (template-generated, clearly labelled)  |

Each returns both human-readable text **and** `structuredContent` validated against a declared
output schema.

Two things worth knowing:

- **stdio is the protocol channel.** All logging in `mcp-server.ts` is pinned to stderr
  (`stderrLoggerParams`); one stray `console.log` would corrupt the JSON-RPC stream.
- **A stdio child does not inherit your environment.** The MCP SDK starts it from a small safe
  default set, so pass `env` explicitly in the editor config (as above). `McpToolsService` does
  the same when it spawns the server itself.

### Sharing an index with the editor

`search_code` reads whatever vector store the process can reach. The MCP server is a *separate
process* from the backend, so they only share an index when both talk to a running ChromaDB.
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

## Testing

```bash
npm test                  # Vitest: backend + app
npm run test:e2e          # Playwright (boots backend + Vite automatically)
npm run mutation          # Stryker on the backend
npm run typecheck         # tsc --noEmit in both workspaces
```

| Suite                                     | Covers                                                            |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `backend/src/indexing/*.spec.ts`          | Chunker edge cases, walk/gitignore/binary skipping, job lifecycle, path allow-list |
| `backend/src/vector/embeddings.spec.ts`   | Hashing embeddings, cosine ranking, in-memory store semantics      |
| `backend/src/tools/*.spec.ts`             | All three tools, including the "nothing indexed" and refusal paths |
| `backend/src/chat/chat.service.spec.ts`   | The agent loop: retrieve → observe → stream, and tool-failure recovery |
| `backend/test/mcp-server.spec.ts`         | Real MCP `initialize`/`tools/list`/`tools/call` over an in-memory transport |
| `app/src/store/appStore.test.ts`          | Streaming state machine, late-event handling, status reconciliation |
| `app/src/components/ChatPanel.test.tsx`   | Composer behaviour, fence rendering, tool chips, error surfacing    |
| `app/e2e/chat.spec.ts`                    | Ask → answer, index → cite, and a rejected path                     |

Playwright uses the browser build of the same React app (Tauri's webview is not automatable);
the desktop shell is covered by `npm run tauri:build`. On a machine with a preinstalled
Chromium, set `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome` instead of `npx playwright install`.

---

## Design notes

**Why a stub model instead of a mock.** `StubChatModel` extends `BaseChatModel` and implements
`bindTools`, `_generate` and `_streamResponseChunks`. It emits a genuine `tool_call` on the
first turn and prose on the second, so `ChatService`'s loop, the Socket.IO stream and the UI
state machine are all exercised end to end without a network. Swapping in `ChatOpenAI` changes
one factory function.

**Why the hashing embedder.** `HashingEmbeddings` splits `getUserById` and `get_user_by_id` into
the same tokens, hashes them into a signed, L2-normalised vector, and implements LangChain's
`Embeddings` interface. It is lexical rather than semantic, but it is a real vector space:
retrieval quality is honest, tests are deterministic, and `EMBEDDINGS_PROVIDER=openai` upgrades it.

**Why the tools live in a plain service.** `CodeToolsService` has no MCP or LangChain types.
`langchain-tools.ts` wraps it for the agent and `mcp/register-tools.ts` publishes it over MCP,
so both surfaces cannot drift, and the unit tests target the service directly.

**Graceful degradation is chosen once, at startup.** Chroma → memory, SQLite → memory, MCP → in
process. Each fallback is logged and reported through `GET /status` and the UI header, because a
store that silently changes identity mid-session is worse than one that is clearly named.

### Security notes

The backend reads local files, so:

- it binds to `127.0.0.1` and allows only the Tauri/Vite origins through CORS;
- every user-supplied path goes through `resolveWithinRoots`, which calls `realpath` **before**
  the containment check — a symlink inside an allowed folder cannot escape to `/etc/shadow`;
- the walker skips symlinks, honours `.gitignore`, and caps file size;
- pino redacts `authorization`, `cookie` and `apiKey` fields.

### Known limitations

- Re-indexing a folder rewrites it wholesale; there is no incremental/watch mode.
- `.gitignore` is read from the folder root only, not from nested directories.
- Chat history is held by the client and replayed on each turn; there is no server-side session.
- `generate_snippet` is template-based by design — it is the one deliberately mocked tool.
- Only one indexing job runs at a time (a second request gets `409`).
