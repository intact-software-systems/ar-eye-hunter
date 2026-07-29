# Task 1 Report: Browser Room Characterization

## What changed

- Added `packages/tests/shared-web/rooms/rallar-rooms-facade.test.ts`.
  It uses the current public facade path and compile-time assertions to lock the
  exact return types for state, events, mutation operations, sessions, presence,
  current selection, and subscriptions.
- Created the planned bounded `rooms/` test root without modifying production
  TypeScript or the active over-400-line compatibility and snapshot suites.
- Recorded this task's evidence in the local structure-branch progress ledger.

The characterization fails if a facade member is changed from its current
authoritative compatibility type, for example if `create` stops returning
`Promise<GroupSnapshot>`, event paging stops returning
`Promise<StateEventPage<GroupEvent>>`, or `leave` loses its `undefined`
partial-result case. It imports the existing public path deliberately; owning
path assertions remain for the extraction task that creates that path.

## Baseline layout and size evidence

`node scripts/repo-style-check.mjs --root packages/shared-web/browser --layout-only --layout-details`
exited `0` and reported the planned 15 warning-only findings:

```text
layout.browser-room-boundary=2
layout.directory-density=2
layout.feature-prefix-cluster=1
layout.filename-style=0
layout.generic-filename=2
layout.generic-route-init=0
layout.primary-export-name=8
layout.server-group-state-vocabulary=0
layout.unapproved-mod=0
```

The full Section 2.1--2.2 `wc -l` inventory totaled 25,502 lines. The current
hard-tier source files remain `api-workflows.ts` (1,061), `rooms.ts` (1,069),
and `state-events.ts` (804); no production file changed. The new bounded test
is 43 lines. Its sole test function is 43 physical lines, which is in the
40--49 review-warning tier but remains cohesive: it contains only independent
compile-time checks for the single public facade contract, with no setup,
mocking, or branching. No changed function reaches the 50 or 60 line tiers.

## Validation

- `npx vitest run packages/tests/shared-web/rooms` — passed: 1 file, 1 test.
- The required eight-file focused baseline command — passed: 8 files, 100
  tests.
- `git diff --check` — passed with no whitespace errors.
- The detailed layout command above — passed with its expected warning-only
  inventory unchanged.

## Self-review and concerns

- Verified no production TypeScript, request literal, workflow compatibility,
  public snapshot, or mixed room/people suite was edited.
- The existing focused compatibility baseline continues to exercise
  create/join/leave ordering, create-and-switch partial failure, state/event
  behavior, presence timeout/abort, workflow options, and current request
  literals. The plan assigns the new bounded workflow-literal fixtures to Task
  3 and mixed state/event assertion migration to Task 5; neither owning-path
  RED coverage nor production extraction was introduced here.
- `rallar-rooms-facade.test.ts` was reformatted as an in-scope file by the
  configured formatter while adding no behavioral assertions there. This is
  formatting-only scope noise and should be reviewed before the task commit.
