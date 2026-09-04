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
npm install          # or: bun install — builds packages/contracts via `prepare`

npm run dev          # contracts watcher + backend on :3001 + web UI on :1420
# or
npm run dev:tauri    # the same UI inside the Tauri desktop window

npm run check        # the whole gate: format, lint, types, dead code, boundaries, tests
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
_needs re-index_ in the sidebar).

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
│   │   ├── store/appStore.ts       # Zustand: pure state + synchronous mutators
│   │   └── types.ts                # UI-only types (everything else is a contract)
│   ├── src-tauri/                  # Rust shell: tauri.conf.json, capabilities, app_info
│   ├── e2e/chat.spec.ts            # Playwright
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
    │   ├── common/                 # pino, SQLite metadata, path guard, zod pipe
    │   └── mcp-server.ts           # MCP stdio entry point
    ├── test/                       # Nest container tests (HTTP + Socket.IO) and MCP
    └── {vitest,stryker}.config.*
```

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

## Checks

One command runs the whole gate:

```bash
npm run check      # format:check → lint → typecheck → knip → deps → test
```

| Command                 | Tool                                       | What it protects                                                   |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `npm run lint`          | ESLint 9 + typescript-eslint (typed)       | Floating promises, unsafe `any`, unbound methods, React hook rules |
| `npm run format:check`  | Prettier                                   | One style, zero style discussion                                   |
| `npm run typecheck`     | tsc, `strict` + `noUncheckedIndexedAccess` | Every index access is `T \| undefined` until you narrow it         |
| `npm run knip`          | Knip                                       | Unused files, exports and dependencies                             |
| `npm run deps`          | dependency-cruiser                         | Module boundaries and cycles (see below)                           |
| `npm test`              | Vitest                                     | 320 unit, container and MCP-protocol tests                         |
| `npm run test:cov`      | Vitest + v8                                | Coverage thresholds, enforced per workspace                        |
| `npm run test:e2e`      | Playwright                                 | The real browser build against the real backend                    |
| `npm run mutation`      | Stryker                                    | Whether the tests would actually notice a bug                      |
| `npm run rust:fmt/lint` | rustfmt, clippy (`-D warnings`)            | The Tauri shell                                                    |

`.husky/pre-commit` runs `lint-staged` (ESLint + Prettier on staged files only); the
full gate runs in CI. A hook that takes a minute is a hook people learn to bypass.

The linter is configured to argue. It found, among others: a ref written during
render, `{...init?.headers}` silently turning a `HeadersInit` tuple list into
`{0: [...]}`, LangChain's deprecated `message.getType()`, content blocks
stringifying to `[object Object]`, and seven super-linear regexes running over
every line of every file in a user's repository.

### Architecture, as executable rules

`dependency-cruiser` encodes the layering, so a bad _shape_ fails CI rather than
review. Each rule carries the reason in `.dependency-cruiser.cjs`:

- `store-stays-pure` — the Zustand store may not import components, hooks or the API layer.
- `api-layer-has-no-ui` — the transport layer must not know what renders its results.
- `tools-do-not-depend-on-transport` — `CodeToolsService` is published over both HTTP and
  MCP; if it knew about either, the two surfaces could drift.
- `shared-layers-stay-shared` / `vector-is-a-leaf` — no back-edges into the features.
- `contracts-depend-on-nothing` — the contracts package is consumed by a Node service _and_
  a browser bundle, so anything beyond zod would break one of them.
- `no-circular`, `no-orphans`, `no-dev-dep-in-src`.

## Testing

```bash
npm test                  # Vitest across all three workspaces
npm run test:cov          # …with coverage thresholds
npm run test:e2e          # Playwright (boots the backend and Vite itself)
npm run mutation          # Stryker across all three workspaces
```

| Suite                                      | Covers                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `packages/contracts/src/contracts.spec.ts` | Every wire schema: what it accepts, and what it must reject                           |
| `backend/src/indexing/*.spec.ts`           | Chunker edge cases, walk/gitignore/symlink/binary skipping, job lifecycle, allow-list |
| `backend/src/vector/*.spec.ts`             | Hashing embeddings, cosine ranking, store fallback, `CHROMA_URL` parsing              |
| `backend/src/tools/*.spec.ts`              | All three tools, the outline tokenizer, fence widening, refusal paths                 |
| `backend/src/llm/*.spec.ts`                | The stub model's tool-calling and streaming contract, provider selection              |
| `backend/src/chat/chat.service.spec.ts`    | The agent loop: retrieve → observe → stream, and tool-failure recovery                |
| `backend/src/common/*.spec.ts`             | Zod pipe error shape, both metadata stores against one shared contract                |
| `backend/test/api.e2e.spec.ts`             | The real Nest app over HTTP: routing, validation errors, contract conformance         |
| `backend/test/gateway.e2e.spec.ts`         | A real Socket.IO client: streamed turns, malformed payloads, progress broadcast       |
| `backend/test/mcp-server.spec.ts`          | Real MCP `initialize`/`tools/list`/`tools/call` over an in-memory transport           |
| `app/src/api/*.test.ts`                    | HTTP error mapping, contract rejection, the Tauri bridge in both environments         |
| `app/src/hooks/useBackend.test.ts`         | Socket wiring, payload validation, listener teardown, send/index actions              |
| `app/src/components/*.test.tsx`            | Composer behaviour, fence rendering, folder list, progress and cancel                 |
| `app/e2e/chat.spec.ts`                     | Ask → answer, index → cite, and a rejected path, in a real browser                    |

Playwright drives the browser build of the same React app (Tauri's webview is not
automatable); the desktop shell is covered by `npm run tauri:build`. On a machine with a
preinstalled Chromium, set `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome` instead of
`npx playwright install`.

**Vitest and Nest.** `backend/vitest.config.ts` transforms with SWC rather than esbuild.
esbuild does not emit `design:paramtypes`, so any test that boots the Nest container
fails to resolve constructor dependencies — the same reason `nest start` uses the SWC
builder. That one plugin is what makes `test/*.e2e.spec.ts` possible.

**Mutation testing** runs on demand and nightly, never on a PR — it takes tens of
minutes. It is the check that grades the other checks: coverage says a line ran,
Stryker says a test would have _noticed_. Every number below moved because reading the
survivor list produced work worth doing.

| Workspace   | First run | After acting on it | What the survivors were                            |
| ----------- | --------- | ------------------ | -------------------------------------------------- |
| `contracts` | 32%       | 81%                | Nothing pinned the stream-event literals           |
| `app`       | 62%       | 69%+               | Branches the component tests skipped               |
| `backend`   | 65%       | see below          | Lookup tables, plus two genuinely untested modules |

The app round found the `Clear chat` chip, the offline placeholder, the scoped/unscoped
caption and the tool accordion's empty state were all unasserted — and `MessageBubble`
had no spec at all. Writing those tests turned up two real bugs: `initialState` omitted
its optional keys, so `setState(initialState)` was not a reset (Zustand merges), and the
folder dialog's Cancel kept the abandoned path.

The backend round found `logging.ts` at 15% and `mcp-tools.service.ts` at 35% — the two
files holding properties that matter most and are easiest to forget: credentials are
_removed_ rather than masked, the MCP logger writes to fd 2 because stdout is the
JSON-RPC channel, and the spawned MCP child gets its configuration explicitly because a
stdio child does not inherit the parent environment.

Deliberate exclusions, because a mutant that no sensible test would kill only dilutes
the signal:

- Lookup tables are fenced with `// Stryker disable all`: `EXTENSION_LANGUAGES`,
  `DEFAULT_EXTENSIONS`, `DEFAULT_IGNORED_DIRECTORIES`, `MODIFIERS`, `KEYWORD_KINDS`,
  `SNIPPET_TEMPLATES`. Data, not logic — excluding `EXTENSION_LANGUAGES` alone moved
  `chunker.ts` from 53% to 67%.
- `backend/vitest.mutation.config.ts` drops the container tests. Stryker re-runs the
  suite once per mutant, and booting a Nest app 1,500 times measures the framework, not
  the branch logic. The cost is that `chat.gateway.ts` and `events.gateway.ts` score
  low here despite being covered — by `test/gateway.e2e.spec.ts`, which this config
  excludes.
- The app's score is capped by JSX: Stryker mutates `sx={{ px: 2 }}` to `sx={{}}` and
  counts a survivor. Roughly 60% of the app's remaining survivors are styling props.
  The threshold is set to reflect that rather than moving styles around to flatter a
  number.

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

**One schema, four consumers.** `packages/contracts` is not a types folder — it is zod at
runtime. The Nest pipe parses requests with it, the MCP server publishes it as tool
input/output schemas, the LangChain tools are built from it, and the React client parses
every response and socket payload against it. A contract change is a compile error in
three places and a visible warning in the fourth.

### Security notes

The backend reads local files, so:

- it binds to `127.0.0.1` and allows only the Tauri/Vite origins through CORS;
- every user-supplied path goes through `resolveWithinRoots`, which calls `realpath` **before**
  the containment check — a symlink inside an allowed folder cannot escape to `/etc/shadow`;
- the walker skips symlinks, honours `.gitignore`, and caps file size;
- pino redacts `authorization`, `cookie` and `apiKey` fields.

What it does **not** do yet, and would need before shipping:

- **No authentication on the local API.** CORS stops another origin from _reading_ responses, but
  not from _sending_ a simple cross-origin `POST`. A shared secret in a header (issued by the
  Tauri shell) or an `Origin` allow-list middleware would close it.
- **`explain_file` will read any file inside an allowed root**, `.env` included. Indexing honours
  `.gitignore`; this tool deliberately does not, because you may want to explain an ignored file.
  Adding a secret-file deny-list is the obvious hardening step.
- **No request timeout on `POST /chat`.** A hung upstream model holds the connection open.

### Known limitations

- Re-indexing a folder rewrites it wholesale; there is no incremental/watch mode.
- `.gitignore` is read from the folder root only, not from nested directories.
- Chat history is held by the client and replayed on each turn; there is no server-side session.
- `generate_snippet` is template-based by design — it is the one deliberately mocked tool.
- Only one indexing job runs at a time (a second request gets `409`).
- `index.html` pins a CSP to `127.0.0.1:3001`, so changing `VITE_BACKEND_URL` means changing the
  CSP too.
