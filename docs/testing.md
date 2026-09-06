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

Project-wide, last measured: contracts 90%, backend 85%, app 91%, in about forty minutes.
The `break` threshold in each `stryker.config.json` sits a few points under that, so ordinary
churn passes and a real regression fails the weekly job.

The app started at 72%, and the gap was not where it looked. Sorting its survivors put 199 of
308 in logic and only 109 in `sx` props — the Markdown parser alone accounted for 69, with no
styling among them. Testing that logic took it to 80%.

The last eight points came from separating the two rather than testing harder. Style objects
now live in `<Component>.styles.ts`, which `mutate` excludes, and the components hold logic.
That is worth doing on its own account: an inline `sx={{…}}` allocates a new object every
render, so emotion re-serialises rules it has already cached, and the message bubble re-renders
on every streamed token. The mutation score is the side effect, not the reason — a design token
can only be "killed" by a test that restates its value, which freezes the design against
ordinary edits and catches no defect.

Two rules keep the split honest. The palette stays _in_ the mutated half, because a colour can
be genuinely wrong — too light to read — and `theme.test.ts` measures every one. And a style
that carries meaning is tested: `MessageBubble` paints the two speakers differently, checked
against the palette, because both bubbles rendering the same is a real defect no role-based
assertion can see.

The refactor was verified rather than asserted. The pre-refactor components were checked out,
the same three views re-shot against the same stubbed backend, and the images diffed: light and
compact came back pixel-identical, and dark differed by 71 pixels in a 9×9 box — one digit of a
measured tool-call duration.

A floor, because **Stryker reports some mutants as survived that the suite does kill.** Two
were verified by hand — `filesSkipped += 1` flipped to `-=`, and `.digest('hex')` to
`.digest("")` — and each fails two existing tests the moment it is injected, under both
vitest configs. The report calls them survivors.

The JSON says why: those mutants carry `testsCompleted: 2` and stop, while killed mutants on
the adjacent line show 1, 9, 12 and 28. The runner is not reaching the tests that would kill
them. It is not the coverage-analysis setting — `perTest`, `all` and `off` all produce a
byte-identical result, which is worth knowing before someone spends an afternoon on it, as
one of us already has.

A third kind is easier to explain. `highlight.ts` builds its grammar table at module load,
and the mutant that empties `forEach`'s callback makes `Object.fromEntries` throw before a
single test runs. Injected, the file reports "no tests" and every one of its 53 tests errors —
about as killed as a mutant can be. The report calls it survived, because no test completed to
be counted.

The contracts package's five remaining survivors are all that shape: emptying any member of
`chatStreamEventSchema` leaves a discriminated union with no discriminator, which zod rejects
while the module is still loading. Injected, the suite reports "no tests". They are the reason
that package reads 90% rather than 100%, and they are not a gap.

One more mechanical trap, worth knowing before it costs an hour: `// Stryker disable
next-line` reaches the line after the comment, and for a mutant deep inside a call's
arguments — a `useEffect` dependency array, say — that is not where Stryker records the
mutant. The directive is accepted, does nothing, and the mutant is reported as survived.
The region form (`// Stryker disable X` … `// Stryker restore X`) around the whole
statement works. Also: with a wrapped comment, put the directive on its **last** line,
because each `//` line is its own comment node.

One trap that is not Stryker's fault at all: **the test runner's module interop is not
Node's.** `await import('sqlite3')` hands Node `{ default }` and nothing else, while
vite-node helpfully adds the named exports on top of it. So `imported.default?.Database ??
imported.Database` and the same line with `&&` behave identically under the runner and
differently in production — the mutant reads as equivalent when what it actually is is a
crash on every real machine. Testing against a module shaped the way the runtime shapes
one, rather than the way the runner does, is what tells them apart.

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

#### Shapes with nothing to observe

Three kinds recur across the backend, and none of them is a gap.

- **An optimisation.** `withLocalRules` opens a `.gitignore` only when the entry list it
  already holds says there is one. Widening that test costs a failed `open` per directory
  and then returns exactly what the shortcut returns, so the mutants that widen it change
  nothing but syscalls. The one that _narrows_ it does change an answer — a directory whose
  only file is the `.gitignore` loses its rules — so the disable names two mutators rather
  than `all`, and that mutant is killed by a test.
- **A catch that returns undefined.** `measure` swallows a failed `stat` — a file deleted
  between `readdir` and here — and returns `undefined`. So does an empty catch. The
  behaviour is real; the mutant is the function.
- **A value nothing compares.** `SKIP` and `ANONYMOUS_CALLER` each meet one `===`: against
  `'descend'` and `'consider'`, and against nothing at all. Any other distinct value
  behaves identically, and a test that pinned the spelling would be a test of the spelling.

The counterpart is worth stating too, because two of these were _not_ equivalent when
looked at properly. `isIgnored` guarded against a `layers[index]` that could not be
undefined, and the guard masked an off-by-one in the loop that produced it; `evictOldest`
did the same with `keys().next().value`. Both disappeared into `toReversed()` and a plain
`for…of` — the mutants went with them, and the code got shorter. A pair of mutants that
mask each other is usually a sign that one of the two lines is not needed.

#### Equivalent arithmetic in the highlighter

`highlight.ts` scans a string one character at a time, and three of its bounds cannot be
killed because they cannot matter:

- `while (cursor < code.length)` in the string and number scanners. One extra pass reads a
  character that is not there, `charAt` hands back `''`, and every branch that follows
  rejects it — so `<=` behaves identically.
- `while (end < code.length && isIdentifierPart(...))`. The bound is belt and braces:
  `isIdentifierPart('')` already stops the walk.
- The `^` in the hex-prefix guard. It only matters for a numeric literal that contains `0x`
  after its first character, which no language in the table has.

The past-the-end read itself is spelled once, in `charAt`, so the disable that covers it is
one line rather than nine. That was worth doing for the code before it was worth doing for
the score: nine copies of the same unreachable fallback is nine chances to write a different
one.

## Where each kind of test belongs

| Concern                          | Lives in                                     | Why not elsewhere                                                |
| -------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| Pure logic, one unit             | `*.spec.ts` / `*.test.ts` next to the source | Fast, and the failure names the function                         |
| Contrast and palette             | `app/src/theme/theme.test.ts`                | A browser is the slowest place to learn a hex value is too light |
| Syntax colours                   | `app/src/markdown/syntax.test.ts`            | Same measurement, against the code block's own surface           |
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
