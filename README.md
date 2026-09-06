# AI Code Companion

A desktop app that indexes a local folder and lets you chat with it. **Tauri v2 + React 19**
on the front, **NestJS 11** on the back, **LangChain** driving a tool-calling agent over a
**ChromaDB** vector store, and the same three tools published over **MCP** so any AI editor
can use them too.

It runs with **zero API keys and zero external services**. There is an offline `StubChatModel`
that implements the real `BaseChatModel` contract — tool binding, tool calls, token streaming —
and deterministic local embeddings, so the entire retrieval → tool-call → stream path is
exercised for real.

For actual answers, point it at a local Ollama and nothing leaves the machine; or set
`OPENAI_API_KEY` and the identical code path runs against a hosted model.

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
> with `INDEX_ALLOWED_ROOTS=/path/one,/path/two`. See [design-notes.md](docs/design-notes.md#security-notes).

> **Calling the API by hand.** The app authenticates by `Origin`; curl has none, so it needs the
> token written to `~/.ai-code-companion/token`. See
> [design-notes.md](docs/design-notes.md#authenticating-the-local-api).

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

---

## How it fits together

```
Tauri window  ──HTTP + Socket.IO──►  NestJS backend  ──►  vector store
React 19, MUI 7, Zustand             indexing, chat,       Chroma or in-memory
                                     MCP tools             + SQLite metadata
```

The desktop bundle carries its own backend as a single executable, starts it on a
port it picks, and stops it with the window. Nothing to install, no Node on the
machine. [architecture.md](docs/architecture.md) has the full picture.

## Documentation

| Document                                | What is in it                                                          |
| --------------------------------------- | ---------------------------------------------------------------------- |
| [architecture.md](docs/architecture.md) | The pieces, the layout, and the HTTP API                               |
| [design-notes.md](docs/design-notes.md) | Why things are shaped this way — including the whole security model    |
| [checks.md](docs/checks.md)             | Every check that runs, and what each one catches                       |
| [testing.md](docs/testing.md)           | How this is tested, and what mutation testing changed about it         |
| [plugins.md](docs/plugins.md)           | The extension points, and how to add a provider without a pull request |
| [mcp.md](docs/mcp.md)                   | Pointing Claude Desktop, Cursor or another MCP client at the index     |
| [releasing.md](docs/releasing.md)       | Tagging, signing, icons, and turning auto-updates on                   |
| [limitations.md](docs/limitations.md)   | What this does not do                                                  |

## Two things worth knowing before you point it at a repository

**It reads your code, and by default it stays on your machine.** With
`LLM_PROVIDER=ollama` and `EMBEDDINGS_PROVIDER=ollama` nothing leaves the
machine at all — no key, no network. With `openai`, both the chunks it indexes
and the questions you ask go to OpenAI.

**Credentials are stripped before anything is indexed.** Files that _are_
credentials are refused by name, and credentials found _inside_ ordinary files
are redacted before they reach the store or the model. The rules, and the cases
they miss, are in
[design-notes.md](docs/design-notes.md#credentials-inside-ordinary-files-are-redacted).
