# Design notes

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

Three rules. **Shapes** — `AKIA…`, `ghp_…`, `sk-…`, a PEM block, a JWT, credentials in a URL — are
caught anywhere, including pasted bare into prose, which is how they usually arrive. **Context**
catches a long value assigned to something named `password`, `token`, `client_secret`. **Entropy**
catches the rest: a high-entropy token with neither a recognisable prefix nor a credential-shaped
name, which is the one the other two cannot see.

Entropy works here because it is measured over _candidates_, not prose — token-shaped runs with no
space and no punctuation outside base64's alphabet. Measured whole, `application/json;
charset=utf-8` scores 4.26 bits per character and a real 40-character hex key scores 3.96, and no
threshold separates them; measured as candidates, the header is never one, because it contains a
space, a semicolon and a slash. Thresholds are per charset, since hex has sixteen symbols and so
cannot exceed 4 bits where base64 reaches nearly 6.

Over this repository — 204 files — the entropy rule adds four redactions beyond the other two:
one real credential they both missed, and three false positives (two alphabet constants and a hex
sentinel). Labelled hashes are excluded by the word before them, which is what keeps `Cargo.lock`
from contributing 495 on its own.

It is the only heuristic rule and the only one that can be switched off, with
`SECRET_ENTROPY_SCAN=false`. It cannot tell a git SHA from a hex API key — nothing that reads only
the value can — so a repository full of commit hashes should turn it off. The deny-list and the
shapes stay on regardless: a file named `id_rsa` is never not a key, and a deny-list with an off
switch is one that ends up switched off.

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
- **The entropy rule cannot tell a git SHA from a hex API key.** They are the same forty
  characters, and nothing reading only the value can separate them, so a changelog of commit hashes
  gets redacted. Labelled hashes (`checksum = "…"`, `sha512-…`, `data:…;base64,…`) are excluded by
  the word in front of them; unlabelled ones are not. `SECRET_ENTROPY_SCAN=false` turns that rule
  off without touching the other two. gitleaks covers the committed history separately.
- **Nothing is signed by default.** The release workflow builds installers, but code signing and
  notarisation only happen where the certificates are configured — so out of the box there is no
  supply chain from this repo to a user's machine.
