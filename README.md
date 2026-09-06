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

> **npm 11+ for a fresh install.** npm 10's dependency resolver crashes on
> Vitest 4's peer set (`Cannot read properties of null (reading 'edgesOut')`).
> `npm ci` — what CI runs — works on either. Use `npx npm@11 install` if your
> npm is older.

```bash
npm install          # or: bun install — builds packages/contracts via `prepare`

npm run dev          # contracts watcher + backend on :3001 + web UI on :1420
# or
npm run dev:tauri    # the same UI inside the Tauri desktop window
npm run build:tauri  # installers, with the backend bundled in

npm run check        # the whole gate: format, lint, types, dead code, boundaries, tests
```

Open <http://127.0.0.1:1420>, click **Add folder**, point it at a repository, and ask a
question. `npm run dev:tauri` additionally needs the
[Tauri v2 system prerequisites](https://v2.tauri.app/start/prerequisites/) (Rust + WebView).

> **Path allow-list.** By default the backend will only index paths under `$HOME`. Widen it
> with `INDEX_ALLOWED_ROOTS=/path/one,/path/two`. See [Security](#security-notes).

> **Calling the API by hand.** The app authenticates by `Origin`; curl has none, so it needs the
> token written to `~/.ai-code-companion/token`. See
> [Authenticating the local API](#authenticating-the-local-api).

### Optional: real ChromaDB

```bash
docker run -p 8000:8000 chromadb/chroma
```

With no server reachable the app logs a warning and falls back to an in-memory store —
usable immediately, but the index is lost on restart (folders are then flagged
_needs re-index_ in the sidebar).

### Optional: keeping the index live

```bash
export INDEX_WATCH=true                # off by default
export INDEX_WATCH_DEBOUNCE_MS=1500    # quiet period before a re-index
```

Each indexed folder is then watched, and edits re-index the files that actually changed —
re-indexing has been incremental for a while; this is what makes it automatic. A burst of
saves costs one pass, not one per file, and changes under `node_modules`, `dist`, `.git` and
the rest of the skip list are ignored before they ever wake the indexer. Watched folders are
marked _live_ in the sidebar.

It is off by default because it holds an OS watch handle per folder for as long as the app
runs, and recursive watching is unsupported on some platforms and filesystems — where it is,
the app logs a warning and carries on indexing on demand.

### Optional: a real model

A local one, which needs no key and sends nothing off the machine — for a tool that
reads your source, that is the difference between "try it" and "ask your employer
first":

```bash
ollama pull qwen2.5-coder:7b
export LLM_PROVIDER=ollama
```

The model has to **support tools**. Every turn binds `search_code` and friends, and a
model without tool support answers from nothing at all — fluently, and with no error to
say so. `qwen2.5-coder:7b` is the default because it has them and knows code;
`LLM_MODEL` picks another, `OLLAMA_BASE_URL` an Ollama somewhere other than
`127.0.0.1:11434`.

Chat is only half of it: indexing embeds every chunk, so leaving embeddings on
`openai` sends the code out anyway. `EMBEDDINGS_PROVIDER=ollama` closes that —
and note that changing embedder invalidates an existing index, because vectors
are only comparable with others from the same model.

```bash
ollama pull nomic-embed-text
export EMBEDDINGS_PROVIDER=ollama
```

Or a hosted one:

```bash
export LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export LLM_BASE_URL=https://api.openai.com/v1   # or any OpenAI-compatible gateway
export EMBEDDINGS_PROVIDER=openai
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
| `npm test`              | Vitest                                     | 916 unit, container and MCP-protocol tests                         |
| `npm run test:cov`      | Vitest + v8                                | Coverage thresholds, enforced per workspace                        |
| `npm run test:e2e`      | Playwright                                 | The real browser build against the real backend                    |
| `npm run mutation`      | Stryker                                    | Whether the tests would actually notice a bug                      |
| `npm run rust:fmt/lint` | rustfmt, clippy (`-D warnings`)            | The Tauri shell                                                    |

A second workflow (`.github/workflows/security.yml`) runs npm and cargo advisories,
gitleaks over the full history, and CodeQL — weekly as well as per-PR, because an
advisory lands on its own schedule rather than yours.

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

What goes in which suite, which mutants are deliberately not chased and why, and the two
rules that keep finding real bugs, are in [docs/testing.md](docs/testing.md).

| Suite                                      | Covers                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `packages/contracts/src/contracts.spec.ts` | Every wire schema: what it accepts, and what it must reject                           |
| `backend/src/indexing/*.spec.ts`           | Chunker edge cases, walk/gitignore/symlink/binary skipping, job lifecycle, allow-list |
| `backend/src/vector/*.spec.ts`             | Hashing embeddings, cosine ranking, store fallback, `CHROMA_URL` parsing              |
| `backend/src/tools/*.spec.ts`              | All three tools, the outline tokenizer, fence widening, refusal paths                 |
| `backend/src/llm/*.spec.ts`                | The stub model's tool-calling and streaming contract, provider selection              |
| `backend/src/chat/chat.service.spec.ts`    | The agent loop: retrieve → observe → stream, and tool-failure recovery                |
| `backend/src/common/*.spec.ts`             | Zod pipe error shape, both metadata stores against one shared contract                |
| `backend/src/security/*.spec.ts`           | The access decision matrix, loopback parsing, and the credential deny-list            |
| `backend/test/api.e2e.spec.ts`             | The real Nest app over HTTP: routing, validation errors, contract conformance         |
| `backend/test/gateway.e2e.spec.ts`         | A real Socket.IO client: streamed turns, malformed payloads, progress broadcast       |
| `backend/test/mcp-server.spec.ts`          | Real MCP `initialize`/`tools/list`/`tools/call` over an in-memory transport           |
| `app/src/api/*.test.ts`                    | HTTP error mapping, contract rejection, the Tauri bridge in both environments         |
| `app/src/hooks/useBackend.test.ts`         | Socket wiring, payload validation, listener teardown, send/index actions              |
| `app/src/components/*.test.tsx`            | Composer behaviour, folder list, progress and cancel                                  |
| `app/src/markdown/parse.test.ts`           | The Markdown subset: nesting, snake_case and dunder safety, streaming fences          |
| `app/src/markdown/highlight.test.ts`       | The highlighter, fuzzed: no input ever loses, gains or reorders a character           |
| `app/src/{theme,markdown}/*.test.ts`       | Every palette and syntax colour measured against its own surface at WCAG AA           |
| `app/e2e/chat.spec.ts`                     | Ask → answer, index → cite, and a rejected path, in a real browser                    |

Playwright drives the browser build of the same React app (Tauri's webview is not
automatable); the desktop shell is covered by `npm run tauri:build`. On a machine with a
preinstalled Chromium, set `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome` instead of
`npx playwright install`.

`e2e/a11y.spec.ts` runs axe-core against the rendered app. `jsx-a11y` only sees the
source; axe sees contrast against the real theme, focus order and names computed from
MUI's own markup. It earned its place immediately: opening the folder dialog left focus
on the dialog paper rather than the input, because MUI's `Modal` focuses its own
container and beats a child's `autoFocus`.

A **`webkit`** project is configured but opt-in
(`npx playwright install webkit && E2E_ALL_BROWSERS=1 npm run test:e2e`). It is worth
running before a desktop release: Tauri's webview _is_ WebKit on macOS and Linux, so it
is the only engine here that matches what the shipped app renders in.

**Vitest and Nest.** `backend/vitest.config.ts` transforms with SWC rather than esbuild.
esbuild does not emit `design:paramtypes`, so any test that boots the Nest container
fails to resolve constructor dependencies — the same reason `nest start` uses the SWC
builder. That one plugin is what makes `test/*.e2e.spec.ts` possible.

**Mutation testing** runs on demand and weekly, never on a PR — it takes tens of
minutes. It is the check that grades the other checks: coverage says a line ran,
Stryker says a test would have _noticed_. Every number below moved because reading the
survivor list produced work worth doing.

| Workspace   | First run | Now | What the survivors turned out to be                                       |
| ----------- | --------- | --- | ------------------------------------------------------------------------- |
| `contracts` | 32%       | 90% | Stream-event literals, then a query schema nobody parsed a real path with |
| `app`       | 62%       | 91% | Branches the component tests skipped; later, styles worth separating      |
| `backend`   | 65%       | 86% | Lookup tables, two untested modules, and every file added since           |

The backend's five weakest files carried most of that move:

| File                    | Before | After |
| ----------------------- | ------ | ----- |
| `logging.ts`            | 15%    | 76%   |
| `file-walker.ts`        | 50%    | 77%   |
| `mcp-tools.service.ts`  | 35%    | 59%   |
| `outline.ts`            | 73%    | 78%   |
| `code-tools.service.ts` | 67%    | 68%   |

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

The latest round covered the five changes that shipped the desktop bundle, and its
survivor list held three findings. `Authorization: Bearer ` with a trailing space parsed
to the empty string as a credential — harmless against the token `loadConfig` actually
produces, and one config change from not being. The `sqlite3` fallback under
`node:sqlite` had never executed on any machine, so a safety net was untested code
claiming to be one. And every nested-`.gitignore` test used a bare filename, which
matches whether or not the path is made relative to the file declaring it, leaving the
whole point of the layer unverified. `file-walker.ts` finished at 98%, and
`metadata-store.ts`, `local-access.ts` and `conversation.store.ts` at 100%.

Three of the survivors were answered by deleting code rather than testing it. `isIgnored`
walked an index backwards behind a guard against an element that could not be missing —
and the guard was masking an off-by-one in the loop that produced it. `toReversed()` has
neither. A pair of mutants that mask each other is usually a sign that one of the two
lines should not be there.

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

- it binds to `127.0.0.1` and authenticates every request and socket (below);
- every user-supplied path goes through `resolveWithinRoots`, which calls `realpath` **before**
  the containment check — a symlink inside an allowed folder cannot escape to `/etc/shadow`;
- the walker skips symlinks, honours every `.gitignore` in the tree the way git reads them, and caps file size;
- pino redacts `authorization`, `cookie` and `apiKey` fields.

#### Authenticating the local API

Binding to loopback is not a security boundary. Two attackers reach `127.0.0.1:3001` with no
network access at all, and `backend/src/security/local-access.ts` answers both:

| Attacker                        | Why CORS alone fails                                                                                          | What stops it                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A page the user has open        | CORS blocks _reading_ the response, not _sending_ the request; a `text/plain` `POST` skips preflight entirely | `Origin` is set by the browser and cannot be forged, so it is checked server-side |
| Another local process           | It can send any header it likes, an allowed `Origin` included                                                 | No `Origin` means "not a browser", which must present the bearer token            |
| A domain rebound to `127.0.0.1` | It arrives with an `Origin` that is valid from its own point of view                                          | `Host` must be loopback                                                           |

`LocalAccessGuard` is registered as an `APP_GUARD`, so a new endpoint is protected because it
exists rather than because someone remembered a decorator, and `ConfiguredIoAdapter` applies the
same policy in `allowRequest` — a rejected client never completes the Socket.IO handshake, which
matters because broadcasts reach every connected socket without passing a message handler.

The desktop app needs no token: its webview sends `Origin: tauri://localhost` (or
`http://localhost:1420` in dev). Everything else reads the token, which is regenerated per run and
written `0600` to `~/.ai-code-companion/token`:

```bash
TOKEN=$(cat ~/.ai-code-companion/token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3001/status
```

`/health` is the one `@Public()` route, so a launcher can poll for the port. Set `AUTH_ENABLED=false`
to switch the guard off, or `COMPANION_TOKEN` to pin the token; the backend logs `auth=on|off` at
startup and warns loudly when it is off.

#### A fuse on the two routes that cost something

`POST /chat` spends money against a real `OPENAI_API_KEY` and `POST /index` walks a
filesystem. Both are capped per window (60 and 30 a minute by default, `RATE_LIMIT_*` to
change, `RATE_LIMIT_ENABLED=false` to remove), and a request past the cap gets a `429` that
names the setting and says how long to wait.

This is not anti-abuse: a request that gets that far already carried the token, and every
caller is the same machine. It is there because a script in a loop is a plausible accident
and the bill lands on the user. Reads are never limited — the UI polls `/status` and a
launcher polls `/health` — and the limiter sits _after_ the access guard, so a local process
without the token cannot spend the budget and lock the real client out.

The fuse is **per caller**, so a runaway script blows its own and the desktop window keeps
working. A browser cannot forge `Origin`, so the app and any trusted page are separated for
free; everything else is cooperative — send `X-Client-Id: my-tool` and get your own budget,
send nothing and share one with every other anonymous script, which is exactly where a
runaway one belongs. None of that is authentication, and it does not pretend to be: a local
process holding the token can claim any identity it likes, and one that holds the token
already has everything.

#### Credentials are refused, whoever asks

The allow-list answers "may this process touch that folder". It does not answer "is this file the
kind of thing nobody meant to share" — and it cannot, because the default allowed root is `$HOME`,
which already contains `~/.ssh` and `~/.aws`. `backend/src/security/secret-files.ts` answers the
second question, and **three** readers consult it, because blocking only the obvious one moves the
leak rather than closing it:

| Reader         | Was leaking                                                                    |
| -------------- | ------------------------------------------------------------------------------ |
| `explain_file` | Returned any file's contents to an MCP client, `.env` and `id_rsa` included    |
| The indexer    | `DEFAULT_EXTENSIONS` contains `env`, so `prod.env` was embedded into the store |
| `search_code`  | An index built before this existed could still serve those chunks              |

Blocked: `.env` and friends, key material (`.pem`, `.key`, `.p12`, `.tfvars`, …), credential files
(`.npmrc`, `.netrc`, `.git-credentials`, `kubeconfig`, `terraform.tfstate`) and everything under a
credential directory (`.ssh`, `.aws`, `.kube`, `.gnupg`, …). `explain_file` checks the _resolved_
path, so a symlink cannot launder `~/.ssh/id_rsa` into an innocent name inside the repo.

Deliberately allowed: `.env.example`, `.env.sample`, `.env.template` — they exist to be read. And
deliberately not configurable: a deny-list with an off switch is one that ends up switched off.

#### Re-indexing only re-embeds what changed

A re-index used to re-read, re-chunk and re-embed every file. It now diffs the walk
against per-file state in SQLite, using two escalating comparisons:

| Check                   | Cost                                 | Catches                                            |
| ----------------------- | ------------------------------------ | -------------------------------------------------- |
| `size` + `mtime` match  | one `stat`, the file is never opened | the common case on a large repo                    |
| `sha256` of the content | a read, but no embedding             | mtime lying — a fresh clone, a checkout, a `touch` |

Only a genuine content change is re-embedded, and files the walk no longer finds
have their chunks dropped. Embedding is the expensive step — a network round trip
per batch with a hosted provider — so the saving scales with how little actually
changed. With the offline hashing embedder the wall-clock difference is small,
because there is nothing expensive to skip.

One rule keeps this honest: per-file state is trusted **only while the chunks it
describes still exist**. A `stale` root means they do not — the previous run wrote
to the in-memory store and the process has restarted — so that case re-indexes from
scratch. Without it a restart produced a folder reporting 298 indexed files and
zero searchable chunks, which is exactly what the live check caught.

#### Credentials inside ordinary files are redacted

The deny-list refuses files that _are_ credentials. This is the other half: a live token pasted
into `notes.md`, in a file the indexer is right to read.

Two narrow rules, because the obvious one does not work. **Shapes** — `AKIA…`, `ghp_…`, `sk-…`, a
PEM block, a JWT, credentials in a URL — are caught anywhere, including pasted bare into prose,
which is how they usually arrive. **Context** catches a long value assigned to something named
`password`, `token`, `client_secret` and so on. Entropy appears only as a floor to throw out
`changeme`, never as the test: see [Known limitations](#known-limitations) for the measurements
that rule it out.

Redaction replaces the value with `[redacted: possible secret]` and leaves the code around it, so
the assistant can still answer about the file. It happens where text enters the index — the store
outlives the file and is what gets quoted — and again on the way out of `search_code`, because an
index built before this existed still holds whatever it held. A file with any is logged with a
count, and never with the value.

Over-redacting has a real cost: the assistant then answers about code it cannot see. So the rules
are narrow enough to name, and the test suite spends as much effort on `authUrl`, `Content-Type`
and subresource hashes staying intact as on the credentials being caught.

#### Chat turns have a deadline

`LLM_TIMEOUT_MS` (default 120s) caps a whole turn, tool calls included. Past it the turn is
cancelled, the socket gets a `chat:error` naming the timeout, and `POST /chat` answers **504**
rather than holding the connection open. A user pressing Stop is reported as a cancellation, not
as a timeout — the two are distinguished by the abort reason, not by matching error text.

"Tool calls included" is load-bearing, and it is the part that is easy to get wrong. Tools are
handed the same signal, but an MCP tool is a separate process and is free to ignore it, so the
turn also races the signal against the call: a wedged tool ends the turn on time and its eventual
result is discarded. Without that race a tool that never returned held both the deadline and the
Stop button open indefinitely.

What it does **not** do yet, and would need before shipping:

- **A caller's identity is cooperative.** The rate limit is a fuse per caller, and `Origin` is the
  only part of that a client cannot forge. Anything else can claim any `X-Client-Id` it likes — a
  local process holding the token already has everything, so this separates well-behaved clients
  from a runaway one rather than deciding who may call.
- **Secret detection inside files is shapes and context, not entropy.** A credential with a
  recognisable format is caught anywhere; one assigned to a credential-shaped name is caught if it
  is long enough. A high-entropy string that is neither — a bare base64 blob in a comment — is not.
  That limit is deliberate: measured against real values, a 40-character hex API key scores 3.96
  bits per character and `application/json; charset=utf-8` scores 4.26, so a threshold that catches
  the key redacts the header. gitleaks covers the committed history separately.
- **Nothing is signed by default.** The release workflow builds installers, but code signing and
  notarisation only happen where the certificates are configured — so out of the box there is no
  supply chain from this repo to a user's machine.

## Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`: the full gate first — a tag can
be pushed at any commit, including one CI never saw — then desktop bundles on all three
platforms, attached to a **draft** release for a human to look over before anyone
downloads them. macOS builds twice, once per architecture: the sidecar is a copy of the
build machine's own `node`, so a bundle can only be the architecture it was built on, and
a universal one would need an x86_64 runtime produced on an arm64 runner.

Signing is by secret, and every one of them is optional: a missing secret produces an
unsigned bundle rather than a failed release. That takes a step to arrange rather than
being free — an absent secret reaches the runner as an empty string, not as an absent
variable, and Tauri reads a defined `APPLE_CERTIFICATE` as "sign with this", so the
workflow exports the Apple group only when there is a certificate in it.

| Secret                                                                      | Gives you                          |
| --------------------------------------------------------------------------- | ---------------------------------- |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | A macOS build Gatekeeper will open |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`                               | Notarisation on top of that        |

### Auto-updates are one command away, and off

Updates are verified against a public key baked into the bundle and signed with a private
key that must not be in the repository — so this is the one feature that cannot be
committed on your behalf. Everything else already is: `tauri-plugin-updater` is compiled
in and registers itself only when `plugins.updater` is present, so a build without it is
untouched — including the check. The window asks once at launch, and when there is
something to install the sidebar offers it by version, with one button that downloads,
installs and restarts. A failed install says why rather than leaving a button that did
nothing; a failed _check_ says nothing at all, because it is background work nobody asked
for.

```bash
npm run updater:enable
```

That generates a keypair, writes the public half and the release endpoint into
`tauri.conf.json`, and prints the two steps left: store the private half as
`TAURI_SIGNING_PRIVATE_KEY`, then cut a release. It refuses to overwrite an existing key,
because a new one cannot verify updates the old one signed — that would strand every copy
already installed.

Installed apps read the **latest published** release, so a draft reaches nobody until a
human has looked at it. And note the shape of the password: a key generated without one
still needs `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to be _set_ and empty, or the build stops
at a prompt nobody can answer. The workflow does that for you.

### Icons

`app/src-tauri/icon.svg` is the source, and `npm run icons` regenerates the platform set
from it — including the `.icns` and `.ico` that the macOS and Windows bundlers require and
that a PNG-only icon directory silently lacks. The mobile assets it also writes are
git-ignored; this app has no mobile target.

### The bundle carries its own backend

`npm run package -w @ai-code-companion/backend` builds the backend into one executable:
esbuild flattens it and its dependencies into a single CommonJS file, Node's own SEA
support turns that into a blob, and `postject` writes the blob into a copy of `node`.
Nothing to install on the user's machine, and nothing to compile — the metadata store
uses `node:sqlite` precisely so this step has no native module to worry about. It is
~130 MB, which is the Node runtime.

The desktop shell starts it on launch on a port it picks (a fixed one is the port a
developer already has something on), points the window at it, and stops it on quit. The
backend also exits when its stdin closes, so a crash or a `kill -9` does not leave a
process holding a port with no window to show for it — verified by killing the packaged
app and watching the backend go with it.

`COMPANION_BACKEND_URL` points the window at a backend you are already running, and skips
the sidecar entirely. A development build never spawns one either — but Tauri will not
compile the shell while a declared sidecar is missing from disk, so `npm run dev:tauri`
builds it the first time and skips it on every run after that. `npm run build:tauri`
always rebuilds it, because a bundle carrying yesterday's backend is a worse outcome
than a slower build.

## Plugins

Extension points are named services in a small runtime under `backend/src/plugins/`,
and everything the app ships is loaded through them — a seam only stays honest while
the built-ins use it too.

A plugin is an object with a `name`, an optional `inject` list, and an `apply`:

```js
// my-store.mjs
export default {
  name: 'qdrant-store',
  inject: ['vectorStores'],
  apply: (ctx) => {
    ctx
      .require('vectorStores')
      .register('qdrant', ({ config, embeddings }) => new QdrantStore(config, embeddings), {
        persistent: true,
      });
  },
};
```

```bash
PLUGINS=/abs/path/my-store.mjs VECTOR_STORE=qdrant npm run dev --workspace backend
```

| Service        | Registers                                               | Selected by                                                    |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| `vectorStores` | A vector store kind, plus whether it survives a restart | `VECTOR_STORE` (`auto` keeps the Chroma-then-memory behaviour) |
| `chatModels`   | A chat model kind                                       | `LLM_PROVIDER`                                                 |

Three rules the runtime enforces, and one it does not:

- **`inject` waits.** A plugin naming a service it needs runs when that service
  exists and unloads again if it goes away, so load order is never something an
  outside author has to guess.
- **Two providers for one name is an error.** Silently taking the second means the
  app runs on whichever loaded last, which is a coin toss nobody can see in a log.
- **A name nothing provides stops the app**, listing what does exist. Store
  resolution is lazy, so without that check a typo boots happily and then answers
  every query with nothing.
- **No sandbox.** `PLUGINS` runs third-party code in the backend process, with
  everything that implies. It is opt-in and never discovered by scanning — no
  different in kind from installing an npm package, but worth being explicit about.

### Known limitations

- Auto-update ships off, because it needs a signing key this repository does not have.
  `npm run updater:enable` turns it on; see [Releasing](#releasing).
- Watching uses `fs.watch` with `recursive: true`, which not every platform and filesystem
  supports; where it is missing the app says so and falls back to indexing on request.
- The secret deny-list is name-based; it will not spot a token pasted into `notes.md`.
- Conversations live in the backend's memory: they survive a page reload but not a restart, and
  the oldest is evicted past `MAX_CONVERSATIONS`.
- `generate_snippet` is template-based by design — it is the one deliberately mocked tool.
- Only one indexing job runs at a time (a second request gets `409`).
- The desktop window's CSP is written twice — into `index.html` by the build and into
  `tauri.conf.json` by hand — because both are enforced and static JSON has nowhere to read
  a value from. The build refuses to proceed when the two differ, and prints the string to
  paste, rather than shipping a window that blocks every request.
