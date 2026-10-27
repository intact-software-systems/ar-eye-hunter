# Playwright Suite Map

Playwright configs are app-owned. Run suites through the app config so the
right tests, dev server, ports, and browser options are selected. The ALM
durable-send harness serves no app, so its config sits beside its suite. It
measures two plans, the ledger's minimal send and a receipted command the server
acknowledges; its CPU profile covers the minimal plan only.

| App                                                           | Tests                                                    | Config                                                  | Command                                                                   | Ports                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Rallar Black Box                                              | `tests/playwright/rallar-black-box`                      | `apps/rallar-black-box/playwright.config.ts`            | `npm run test:rallar`                                                     | SPA `5176`, control `5180`                                 |
| Rallar Black Box full stack                                   | `tests/playwright/rallar-black-box/full-stack-*.spec.ts` | `apps/rallar-black-box/playwright.full-stack.config.ts` | `npm run test:rallar:full-stack`                                          | SPA from env/default, API from env/default, control `5180` |
| Rallar Black Box exhaustive                                   | `tests/playwright/rallar-black-box/exhaustive-*.spec.ts` | `apps/rallar-black-box/playwright.exhaustive.config.ts` | `npm run test:rallar:exhaustive:postgres`                                 | SPA `5176`, API from env/default, control `5180`           |
| Relic Hunters                                                 | `tests/playwright/relic-hunters`                         | `apps/relic-hunters-v1/playwright.config.ts`            | `npm run test:playwright:relic`                                           | SPA `5175`                                                 |
| Relic Hunters full stack                                      | `tests/playwright/relic-hunters/full-stack-*.spec.ts`    | `apps/relic-hunters-v1/playwright.full-stack.config.ts` | `npm run test:playwright:relic:full-stack`                                | SPA `5175`, API `8090`                                     |
| AR Eye Hunter                                                 | `tests/playwright/ar-eye-hunter`                         | `apps/ar-eye-hunter-v1/playwright.config.ts`            | `npx playwright test --config apps/ar-eye-hunter-v1/playwright.config.ts` | SPA `5186`                                                 |
| ALM durable-send harness, minimal and receipted-command plans | `tests/playwright/alm`                                   | `tests/playwright/alm/playwright.config.ts`             | `npm run perf:alm:durable-send`                                           | none: the page is served by a route                        |

Avoid bare `npx playwright test` from the repository root. There is no root
config because a root default can silently start the wrong app for a test path.

## Room journey measurements

The full-stack AR Eye and Relic configs use the shared room journey reporter.
Existing clickable tests declare `room-journey` annotations and delimit each
phase with a native `test.step('room-journey:<phase>', ...)`. Assertions inside
the step establish the user-visible outcome; an HTTP admission alone is not
participation.

| Phase       | AR Eye                                                                                                  | Relic                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Entry       | Open a code invitation, sign in, enter the arena, and observe the shared running match.                 | Open a code invitation, register, join the expedition, and submit both plans through round two.                                        |
| Recovery    | Reload the guest and observe the same arena's running match.                                            | Reload the guest at round two and submit a plan successfully.                                                                          |
| Repeat play | After matching results, both players continue and the host starts another timed match in the same room. | After the two-player finale, reset, rejoin with the same accounts, start with Search selected, and advance the same room to round two. |

Collect three serial repetitions from a clean committed checkout. Run the two
commands sequentially so their renderers do not compete. Each command retains
all attempts in one artifact; `repeatEachIndex` distinguishes repetitions.

```sh
RALLAR_ROOM_JOURNEY_REVISION=$(git rev-parse HEAD) RALLAR_ARENA_FULL_STACK=1 \
  npx playwright test --config apps/ar-eye-hunter-v1/playwright.config.ts \
  tests/playwright/ar-eye-hunter/private-room-entry.spec.ts \
  tests/playwright/ar-eye-hunter/quick-join.spec.ts \
  --project=desktop-delivery --grep 'shares a code arena|Quick Joined peers keep' \
  --workers=1 --repeat-each=3 --trace=on --output=tmp/perf/room-journeys/ar-eye

RALLAR_ROOM_JOURNEY_REVISION=$(git rev-parse HEAD) RELIC_HUNTERS_FULL_STACK=1 \
  npx playwright test --config apps/relic-hunters-v1/playwright.full-stack.config.ts \
  tests/playwright/relic-hunters/full-stack-private-room-entry.spec.ts \
  --grep 'shares a code expedition|plays a two-hunter expedition' \
  --workers=1 --repeat-each=3 --trace=on --output=tmp/perf/room-journeys/relic
```

`room-journeys.json` is written in the selected output directory. It records the
application, environment, explicit source revision (null if not supplied),
worker count, native run status, and each phase's attempt status and duration.
Retries retain earlier failures. Skipped or unreached phases have null duration;
invalid or missing evidence after a passed test fails the runner, as does an
artifact write failure. Inspect both `issues` and attempt/phase statuses before
summarizing successful durations. Report sample counts, failures, and descriptive
medians/ranges together; do not calculate latency percentiles from three samples.
An empty selection supplies no coverage evidence. Raw errors, credentials,
room links, and room identifiers are excluded from this JSON.

The release workflow uploads `game-room-journeys-<game>` on success or failure
before component tests clear the output directory. Existing failure traces and
screenshots remain separate. Local output belongs under ignored `tmp/perf/`.
Repeat-play checks account and exact active-room identity after the second activity
starts. AR Eye exposes that identity on its existing room rows with `data-room-id`,
matching the existing Relic pattern. This does not change gameplay behavior.

Record OS, runtime/browser versions, server profile, renderer and source revision
with any comparison. AR Eye uses a built SPA and local memory API; Relic uses a
Vite development SPA and local server. Both use Chromium software rendering.
These timings include automated interactions and assertion waits: they measure
the defined synthetic journeys, not production latency or user adoption. The
reload checks do not establish operating-system suspension recovery. No numeric
performance threshold or gameplay policy is introduced.

Relic repeat play verifies that accepted Reset clears the previous Escape draft
for both hunters and selects Search before either submits. It includes explicit
rejoining and starting the expedition; it does not measure a one-click replay flow.
Older observations that explicitly selected Search cover a different interaction
sequence and must not be presented as directly comparable timings. Controlled
browser regressions in `relic-hunters/turn-reset.spec.ts` also cover ordinary
snapshot updates, refused Reset, automatic submission across expedition resets,
and recovery that first observes an already-expired new round.


## Chromium room timing diagnostics

Set `RALLAR_BROWSER_TIMING=1` to capture both players in cases using
`roomBrowserTest` (the two-player AR Eye private entry and Quick Join cases, and
Relic full-stack private entry cases). Each test attempt writes `browser-timing-host.jsonl`
and, when a guest is used, `browser-timing-guest.jsonl` in its output directory.
The flag is off by default; the hosted AR Eye room lane enables it. It does not
change rendering, workflow assertions, browser topology or deadlines.

Each file begins with runtime, renderer, machine and explicit source revision
metadata. Renderer metrics use CDP's `timeTicks` domain (elapsed time, not CPU
utilization); process `cpuTimeSeconds` is cumulative CPU time from Chromium.
Each channel reads independently with one second between completed reads. Every
record has the runner wall-clock request/response bounds: a slow renderer read
must not be assigned to an instantaneous point. Use deltas within one PID and
metric lifetime, and account for navigation resets. An unfinished read at stop
is `incomplete`, and a protocol failure is `failed`, never a zero measurement.
A final `stopped` record proves capture teardown ran; its absence means the
artifact is partial. The test outcome still comes from Playwright.
Metrics include task/script/layout durations, JS heap and DOM counts. They do
not identify JS hot functions, allocation sites, GC pauses or a GPU driver stall.

The release lane also retains `runner-processes.log`: epoch milliseconds,
`ps` PID/parent/cumulative CPU-percent/RSS-KiB/command-name rows, and Linux aggregate
`/proc/stat` CPU counters. Command arguments and environment are excluded. Use
CPU counter deltas for interval utilization; `ps` CPU percentage is a lifetime
average. These system samples continue if a renderer stops responding. Match
Chromium process IDs with the browser samples; unrelated runner processes are
context, not attribution to the game. The timing artifact is uploaded on pass or
failure before component tests clear the output directory.

For a local diagnostic, use the normal app command with this extra flag and an
ignored output directory, for example:

```sh
RALLAR_ROOM_JOURNEY_REVISION=$(git rev-parse HEAD) RALLAR_BROWSER_TIMING=1 \
  RALLAR_ARENA_FULL_STACK=1 npx playwright test \
  --config apps/ar-eye-hunter-v1/playwright.config.ts \
  tests/playwright/ar-eye-hunter/private-room-entry.spec.ts \
  tests/playwright/ar-eye-hunter/quick-join.spec.ts \
  --project=desktop-delivery --workers=1 --trace=on \
  --output=tmp/perf/ar-eye-browser
```

These numeric artifacts exclude page URLs, request contents and raw protocol
errors. Native Playwright traces have a broader data surface: retain them only
for synthetic test accounts. Correlate their action and non-WebSocket request
times with the numeric samples. The timing capture adds protocol and file I/O
work, so compare repeated equivalent runs and report its presence. A passing
retry is not proof of a fixed root cause.
