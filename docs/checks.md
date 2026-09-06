# Checks

What runs, what each one catches, and why it is worth its runtime. The reasoning
behind the test suite itself is in [testing.md](testing.md).

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
