# Releasing

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
