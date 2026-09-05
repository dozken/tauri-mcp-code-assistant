# Testing policy

The mechanics — how to run each suite, what CI enforces — are in the
[README](../README.md#checks). This file is for the judgement calls: what gets
tested, what deliberately does not, and why. It exists so those decisions are argued once
and reviewed like code, rather than re-litigated in every pull request.

## Mutation testing

Stryker runs over both workspaces. A surviving mutant is a claim that some line could be
changed without any test noticing, so each one is either a missing test or a statement
about the code that ought to be written down.

Three things came out of the last full run, and they are the pattern to follow:

- **A survivor is usually a real gap.** The `!signal.aborted` guard before `forgetMissing`
  could be removed with the whole suite still green — while deleting the user's index.
  The mutant found it; nothing else had.
- **An "equivalent" mutant is a claim that needs enforcing.** Saying "this can't be killed"
  in a review comment decays. `// Stryker disable next-line all: <reason>` puts the claim
  next to the code, in the diff, where the next person can disagree with it.
- **Sometimes the right fix is deleting the line.** `toPosix` had a `sep === '/'` fast path
  whose other branch could never run on a POSIX runner. Splitting and re-joining is already
  the identity in that case, so the branch bought a mutant and nothing else.

### The score is a floor, not a measurement

Project-wide, last measured: contracts 81%, backend 84%, app 72%, in about forty minutes.
The `break` threshold in each `stryker.config.json` sits a few points under that, so ordinary
churn passes and a real regression fails the nightly job.

A floor, because **Stryker reports some mutants as survived that the suite does kill.** Two
were verified by hand — `filesSkipped += 1` flipped to `-=`, and `.digest('hex')` to
`.digest("")` — and each fails two existing tests the moment it is injected, under both
vitest configs. The report calls them survivors.

The JSON says why: those mutants carry `testsCompleted: 2` and stop, while killed mutants on
the adjacent line show 1, 9, 12 and 28. The runner is not reaching the tests that would kill
them. It is not the coverage-analysis setting — `perTest`, `all` and `off` all produce a
byte-identical result, which is worth knowing before someone spends an afternoon on it, as
one of us already has.

So: **triage a survivor by injecting it, not by trusting the row.** Assert the injection
actually matched the source first — a `replace` that silently finds nothing produces a
passing suite that looks exactly like "the mutant survived", which is how the wrong
conclusion gets reached twice.

### What we do not chase

Mutation score is a means, not a target. Two categories are deliberately excluded rather
than tested, both with a disable comment naming the reason at the site.

#### Logging

Anchor: `#logging`

Log payloads are diagnostics, and pinning their wording in tests freezes them against
exactly the edits that keep logs useful — adding a field, sharpening a message. So
`logger.*` payloads carry a disable.

The exception is any log line that is an **operational contract**: the thing somebody greps
when something looks wrong. `Indexing finished` is one, and it is asserted in
`indexing.service.spec.ts` through `recordingLogger()` — root, state, file count and chunk
count, because an empty payload there turns a diagnosis into guesswork. If another log line
becomes load-bearing in that way, assert it and drop the disable.

#### Unreachable guards

Two checks in the file walker cannot be killed because they cannot be reached:

- `entry.isSymbolicLink()` — `readdir` with file types already reports a symlink as neither
  file nor directory, so the later checks reject it anyway.
- `relativePath === '' || relativePath.startsWith('..')` — `directory` only ever comes from
  the walk's own queue, which starts at the root and grows by joining onto it.

Both stay. They are the assertions that keep those invariants true if the queue ever gains
another source, and the symlink one is what stops a link to `~/.ssh` being walked the day an
entry arrives from `stat` rather than `lstat`. Deleting them to gain two points of mutation
score would trade a security guard for a number.

## Where each kind of test belongs

| Concern                          | Lives in                                     | Why not elsewhere                                                |
| -------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| Pure logic, one unit             | `*.spec.ts` / `*.test.ts` next to the source | Fast, and the failure names the function                         |
| Contrast and palette             | `app/src/theme/theme.test.ts`                | A browser is the slowest place to learn a hex value is too light |
| Rendered accessibility           | `app/e2e/a11y.spec.ts`                       | Contrast and computed names only exist once something renders    |
| HTTP and socket contracts        | `backend/test/api.e2e.spec.ts`               | Needs the real Nest container, guards and pipes                  |
| Anything involving a real folder | `backend/src/indexing/*.spec.ts`             | The indexer's bugs live in the filesystem, not in mocks          |

## Two rules that keep paying off

**Reproduce before fixing.** Every non-obvious bug in this repository was proved first —
with a throwaway spec, a `git stash`, or a live run against the built binary — and the
proof then became the regression test. The indexing race, the React render loop and the
restart-empties-the-index bug were all invisible to the suite as it stood; two of them were
invisible to any unit test at all.

**A test that passes on the mutant is not a test.** When a test is written to close a
specific gap, re-inject the mutant and watch that test fail before keeping it. It costs one
minute and it is the difference between covering a line and testing it.
