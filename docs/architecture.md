# Architecture

How the pieces fit, what lives where, and the HTTP surface between them.
For why the pieces are shaped this way, see [design-notes.md](design-notes.md).

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
├── packages/contracts/             # The only place a wire type is defined
│   └── src/
│       ├── chat.ts                 # chat request/response + stream events
│       ├── indexing.ts             # index request, job, progress, status
│       ├── tools.ts                # MCP tool input/output schemas
│       └── events.ts               # Socket.IO event names, REST route paths
│
├── app/                            # Tauri v2 + React 19 client
│   ├── src/
│   │   ├── api/                    # http.ts, socket.ts, tauri.ts (guarded IPC)
│   │   ├── components/             # Sidebar, ChatPanel, MessageBubble
│   │   ├── hooks/useBackend.ts     # socket ⇄ store wiring, send/index actions
│   │   ├── markdown/               # the rendered subset and the highlighter, both
│   │   │                           #   parsed to data rather than to HTML
│   │   ├── store/appStore.ts       # Zustand: pure state + synchronous mutators
│   │   ├── theme/                  # both palettes + the OS-preference provider
│   │   └── types.ts                # UI-only types (everything else is a contract)
│   ├── src-tauri/                  # Rust shell: tauri.conf.json, capabilities, app_info
│   ├── e2e/                        # Playwright: chat + axe in both themes
│   └── {vite,vitest,playwright,stryker}.config.*
│
└── backend/                        # NestJS 11
    ├── src/
    │   ├── chat/                   # controller, gateway, agent loop
    │   ├── indexing/               # controller, service, chunker, walker, progress
    │   ├── vector/                 # embeddings, Chroma + in-memory stores
    │   ├── tools/                  # CodeToolsService, outline tokenizer, formatters
    │   ├── mcp/                    # MCP registration + @langchain/mcp-adapters client
    │   ├── llm/                    # StubChatModel + provider factory
    │   ├── security/               # the whole threat model: access policy, guard,
    │   │                           #   path allow-list, credential deny-list
    │   ├── common/                 # pino, SQLite metadata, zod pipe, socket adapter
    │   └── mcp-server.ts           # MCP stdio entry point
    ├── test/                       # Nest container tests (HTTP + Socket.IO) and MCP
    └── {vitest,stryker}.config.*
```

`security/` is its own layer rather than a corner of `common/`, and an executable
dependency-cruiser rule (`security-depends-on-nothing-local`) holds it there: the
access policy, the path allow-list and the credential deny-list may read `config/`
and nothing else in the app. A rule that decides what the process may read stays
reviewable only while its inputs stay that small.

`packages/contracts` is the load-bearing piece. One zod schema per type that crosses
a process boundary, and four consumers of each: the Nest request pipe, the LangChain
tool definitions, the MCP `registerTool` input/output schemas, and the React client —
which _parses_ every response and socket payload rather than casting it, so version
skew shows up as one warning instead of `undefined` deep inside a component.

Extracting it immediately caught a live bug: `GET /status` returned an `IndexJob`
while the frontend declared `IndexProgressEvent`, so `activeJob.percent` was always
`undefined` and a reload mid-index rendered a stuck progress bar.

### HTTP API

| Method   | Path            | Body / Query        | Notes                                         |
| -------- | --------------- | ------------------- | --------------------------------------------- |
| `POST`   | `/index`        | `{ "path": "..." }` | `202` — returns the job; progress via socket  |
| `POST`   | `/index/cancel` | –                   | Aborts the running job                        |
| `DELETE` | `/index`        | `?path=...`         | `204` — drops the folder's chunks             |
| `GET`    | `/status`       | –                   | Active job, folders, store kinds, chunk count |
| `GET`    | `/health`       | –                   | Liveness                                      |
| `POST`   | `/chat`         | `chatRequestSchema` | Blocking; the UI streams over Socket.IO       |

A chat request carries a message and, to continue a conversation, its id — never a
transcript. The backend keeps the turns, so the payload does not grow with the
conversation and a caller cannot put words in the assistant's mouth to steer the next
answer. Omit the id for a one-shot question; send an unexpected field and the request is
refused rather than quietly stripped.

Socket.IO events — client→server: `chat:send`, `chat:cancel`; server→client:
`index:progress`, `chat:token`, `chat:tool`, `chat:done`, `chat:error`.

---
