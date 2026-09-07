# Known limitations

What this does not do, stated so nobody has to find out by trying.

- **A downloaded macOS build will not open on a double-click, and cannot be made to.**
  The bundles are unsigned, and macOS reports an unsigned quarantined app as _damaged_ —
  Sequoia 15.1 removed the Control-click → Open escape, so whoever downloads it has to run
  `xattr -dr com.apple.quarantine` first. Only a paid Developer ID plus notarisation removes
  that step; ad-hoc signing does not, since it carries no identity for Gatekeeper to check.
  See the README's install section and [releasing.md](releasing.md#signing-and-what-unsigned-costs).
- Auto-update ships off, because it needs a signing key this repository does not have.
  `npm run updater:enable` turns it on; see [releasing.md](releasing.md).
- Watching uses `fs.watch` with `recursive: true`, which not every platform and filesystem
  supports; where it is missing the app says so and falls back to indexing on request.
- **The entropy rule cannot tell a git SHA from a hex API key.** They are the same forty
  characters, and nothing reading only the value can separate them, so a changelog of commit
  hashes gets redacted. Labelled hashes (`checksum = "…"`, `sha512-…`, `data:…;base64,…`) are
  excluded by the word in front of them; unlabelled ones are not. `SECRET_ENTROPY_SCAN=false`
  turns that rule off without touching the deterministic ones. See
  [design-notes.md](design-notes.md#credentials-inside-ordinary-files-are-redacted).
- Conversations live in the backend's memory: they survive a page reload but not a restart, and
  the oldest is evicted past `MAX_CONVERSATIONS`.
- `generate_snippet` is template-based by design — it is the one deliberately mocked tool.
- Only one indexing job runs at a time (a second request gets `409`).
- The desktop window's CSP is written twice — into `index.html` by the build and into
  `tauri.conf.json` by hand — because both are enforced and static JSON has nowhere to read
  a value from. The build refuses to proceed when the two differ, and prints the string to
  paste, rather than shipping a window that blocks every request.
