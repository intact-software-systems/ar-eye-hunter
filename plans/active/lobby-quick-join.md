# Slice 1: Quick Join implementation plan

**Goal:** Admit an authenticated caller to a suitable existing room, or return an explicit unavailable
result, through `rallar.rooms.quickJoin()`. Deliver this slice in PR #697, originally stacked on
[PR #696](https://github.com/intact-software-systems/ar-eye-hunter/pull/696), now merged. It includes the planning
foundation from [PR #695](https://github.com/intact-software-systems/ar-eye-hunter/pull/695).

**Architecture:** A scope-owned Quick Join command runs through the existing AppInbox client, handler,
transaction completion, and QueueBox retry owner. Selection composes canonical group membership
admission, snapshot projection, and guarded writes. Browser presence and current-room switching follow
the existing room workflow. Applications retain ownership of activity participation.

**Tech stack:** TypeScript shared contracts/server/browser packages, Deno/Hono API-v1, PostgreSQL,
React AR Eye, Vitest, repository black-box recipes, and Playwright.

**Spec:** [Lobby and matchmaking](lobby-and-matchmaking.md), slice 1 and its entry/participation rules;
[group formation architecture](../../docs/rallar-group-formation-architecture.md), admission policy.
Current repo skills and standards govern implementation, not historical plan conventions.

## Constraints and delivery

- The user explicitly selected slice 1 next and authorized the original stack. PR #696 has merged;
  #697 now targets main. Resolve the real parent-merge conflict before final validation.
  Finish this PR and wait for the maintainer to merge before continuing to another slice. Do not merge
  or enable auto-merge on the user's behalf.
- Use TDD: observe a meaningful failure at the owned behavior boundary before each implementation,
  make it pass, then refactor with that evidence. Prefer existing patterns and implementations.
- Add no legacy path, duplicated implementation, migration code, automatic room creation, approval
  request, matchmaking queue, invitation product, metadata query language, or activity-seat promise.
- Review each changed human-authored file in full. Support files changed by remediation enter the
  same closure recursively. Independent untouched code remains outside the closure. Remove affected
  legacy without an independent requirement or verified consumer; a real compatibility exception
  requires the explicit maintainer decision and focused registry described by the repo standard.
- The PR owns delivery evidence. Keep only these next two increments concrete. Update this plan when
  evidence changes the design; delete it in the delivering PR after completion. Keep the product plan
  as the durable description. No shared progress ledger, catalog, reservation, or governance receipt.

## Operation contract and decisions

`POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/quick-join/requests/:requestId` accepts an authenticated
request and the existing path-only request-ID convention. Route inspection confirmed body/header IDs
are rejected by the canonical API ingress. Sparse caller selection has `kind`, `q`, and
`includeEmpty`; use the directory's normalization and defaults (any kind, no name filter, exclude
empty rooms). Persist a complete normalized command with explicit nulls, actor/session, scope, and
request ID. Reject malformed input and unknown fields. Browser input carries scoped operation options
and `leaveCurrent` in addition to the selection fields; transport and switching options are not server
selection semantics.

The response is `{ status: 'joined', snapshot }` or `{ status: 'unavailable' }`. Both are successful,
durable operation results. An unavailable result has no membership, pending request, or room creation
side effect. Authorization, malformed input, corruption, and exhausted infrastructure retries remain
typed failures, not unavailable. Reusing a request ID with different semantics is a typed conflict;
matching replay returns the stored result even if the directory later changes.

Candidates are in the exact requested scope, business-active and unexpired, `joinMode: open`, match
the application-supplied kind/name/empty criteria, and are not already active memberships of the
caller. Private/code rooms continue to use explicit join/invite surfaces. Do not infer visibility from
an activity phase. Rank by distinct online-member count descending, then group ID ascending, matching
directory ordering. Counts describe online members, never players or expedition hunters.

The final candidate must pass the same credential, effective capacity, lifecycle admission window,
and membership policy as manual join. Use the canonical join computation; accept only a result that
lands the caller active. A result that would park pending is not a Quick Join candidate. Forming rooms
with closed-after-formation policy remain eligible while their admission window is open. Corrupt
stored policy/state fails closed; do not catch corruption as an ineligible room.

The command owns selection across retries. Each delivery verifies the command-bound authenticated
session, reads fresh scope candidates and their admission facts, computes and validates the selected
canonical membership write and result, then commits once. A lost group revision guard rolls back the
whole attempt. QueueBox retries from fresh state, so another room or unavailable can win next time.
There is no handler retry loop, per-scope mutex, nested AppInbox join command, or fictitious group ID.
The collection is a best-effort observation; global snapshot isolation and globally optimal ranking
under concurrent presence changes are not promised.

Capture immutable ingress facts only on a validated command-ledger miss. Hash normalized caller
semantics before clock/random facts. Reuse captured facts through retries. The selected group guard
is the first authoritative domain write; membership, group revision, event, receipt, final outbox,
and AppInbox durable result complete in the same transaction. Precompute deterministic payloads,
hashes, and serialization before that transaction; wake/observe only after commit. The unavailable
result completes through AppInbox without a domain write. Existing reservation completion prevents
two executions of the same command from committing different winners.

The browser invokes this command once per public operation, connects presence only after joined,
accepts the returned room through the existing cache/current-room path, and applies existing
leave-previous-room behavior. Unavailable preserves the current room. Switching/presence failure must
not select another room or conceal a membership already admitted. Preserve the existing partial
switch failure information when leaving the previous room fails.

AR Eye supplies `kind: 'room'` and its existing `eye hunter` name filter. A visible Quick Join action
reports progress, failure, or unavailable and retains the Create arena room action. No automatic
director/match participation promise is added. Validate the same facade using Relic-shaped rooms and
the existing distinction between room membership and joined expedition hunters; this slice does not
add a second application-specific matching algorithm or implicitly enlist a Relic hunter.

## Increment 1: authoritative admission

Primary owners: shared `api/mutation/group-quick-join.ts` contract and group-state Quick Join owner, existing
`group-state/inbox/group-state-inbox-service.ts`, AppInbox type registration, API group route
registration, OpenAPI, and shared-test REST recipes. Keep the exact queue registration, admission
policy, first guard, durable result, and post-commit effect navigable from one concrete entry.

1. Add failing tests for a scope/name match with the most distinct online members, deterministic tie,
   and joined/unavailable result. Add lifecycle forming/closed/approval, default/stored capacity,
   expired/private/already-joined exclusion, multiple sessions, and strict malformed/corrupt cases.
2. Implement normalized contract and a Quick Join owner that composes the existing membership
   computation and write. Settle its construction using the existing group service and AppInbox
   ownership, without a generic mutation framework or duplicated authorization/admission algorithm.
3. Add failing real AppInbox tests for two callers racing for one place, fallback to another room,
   unavailable after the winner, matching replay, conflicting request-ID reuse, fresh policy/session
   reads on retry, retry exhaustion, and rollback on final-effect collision. Use production receipts
   and durable results as evidence; no synthetic post-call proof or mocked transaction rollback.
4. Wire the authenticated REST route, scope quota, validation and OpenAPI. Add black-box recipes for
   successful selection, unavailable with no pending member, and request-ID replay/conflict.
5. Run the focused group/admission/inbox tests, API Deno checks/tests, and relevant REST black-box
   command. Commit a coherent server increment and keep the draft stacked PR current.

Increment 1 evidence: canonical admission and durable AppInbox completion are implemented. Focused
server checks passed (48 tests), real PostgreSQL admission/convergence checks passed (12 tests), API
route/OpenAPI checks passed (46 tests), and the memory-backed REST matrix passed all 64 recipes,
including 17 new Quick Join steps. Review moved the shared contract beside the existing mutation
protocol contracts and tightened persisted-input types. No legacy or migration path was added.

## Increment 2: browser workflow and application

Primary owners: shared-web `rooms` contracts/facade/HTTP workflows and exports, their public API
snapshot and bundle tests, AR Eye session actions/contracts/operations UI, and owned behavior tests.
Use existing examples and room membership tests before editing. Add a focused Relic-shaped consumer
test; change Relic production code only if the common API requires a concrete correction there.

1. Add failing facade/workflow tests: joined connects presence and switches; unavailable preserves
   current room and sends no presence/leave request; replay retains one request identity; partial
   switch failure exposes the admitted room; old/replaced auth cannot publish stale UI state.
2. Implement the public `quickJoin` operation and reuse the admitted-room activation/switch sequence.
   Keep typed return values complete and room/group translation at the existing boundary.
3. Add failing AR Eye UI/action tests, then the visible action and distinct unavailable/error/progress
   feedback. Exercise it through Playwright against the real API and visible controls. Verify the
   Relic-shaped case still requires a separate hunter/expedition participation action.
4. Run the browser/app focused suites, API snapshots and bundle boundary checks, AR Eye and Relic
   builds. Update public documentation and examples where the new surface belongs.

Increment 2 evidence: the browser facade and AR Eye action are implemented. The final browser,
AR Eye, Relic, and public-snapshot run passed 396 tests across 49 files. A real two-browser
Playwright test passed unavailable then joined behavior. The independent review found and
verified fixes for session replacement through cleanup, command-bound durable-result validation,
public HTTP input compatibility, and arena state reset at the subscribed room transition.
The reviewer has no remaining concrete findings. Fixed PostgreSQL medium scale passed all
2,842 steps. The isolated local three-run performance comparison retained correct durable
completion but exceeded the unchanged latency/throughput limits. The pinned hosted A-B-B-A run
[39850482876](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39850482876)
also failed: hot throughput fell from 36.9663 to 34.9170 mutations/second (5.54%), beyond the
unchanged 5% allowance. Every other comparison check passed. The revised hosted comparison below
satisfies performance acceptance while retaining that earlier failure. CI also exposed stale API test
dependencies and a missing route-ownership inventory entry; those are repaired with focused
regressions. Complete final CI and publication checks before deleting this implementation plan at
handoff. The refreshed Branch Release Gate passed on `7d6cc22d1`. On `307ad05f4`, every lane except
unit tests passed; two attempts exhausted the 20-minute unit-job limit after Chromium setup took
almost 14 and 12 minutes. Neither reported an assertion failure. The unit job now allows 30 minutes
including setup, with a separate 20-minute test-step limit. Independent review accepted this narrow
budget correction; a completed green run is still required.

Performance investigation: the unchanged baseline positions ranged from 34.99 to 39.18 hot
mutations/second. The candidate had 20 eighth-attempt conflicts versus 13 for the baseline, with
84.40 versus 51.20 seconds of aggregate planned delay at that attempt. These are observed retry-tail
differences, not proof that the regression is noise. The only newly added dispatch check on every
existing logical command was the Quick Join discriminant. Revision `307ad05f4` moved that strict
block after the three existing stable-command early returns. Independent review, 384 focused tests,
and native API/benchmark checks confirmed preserved command semantics. The fresh hosted A-B-B-A
comparison [39856889387](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39856889387)
passed the unchanged comparator and 5% limits, pooling 18 measured runs per role and workload.
Hot throughput was 31.9418 baseline versus 32.1421 candidate mutations/second, with no exhausted
commands or atomic-completion failures. This satisfies acceptance but does not prove that the
dispatch reorder caused the difference between runs. Full captures and their manifest remain in
the workflow artifacts and ignored local `tmp/perf/`.

## Review focus and completion gates

| Risk                                              | Required evidence                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Selection/admission diverge or overfill           | Canonical policy cases plus last-place AppInbox race and fallback               |
| Replay selects twice or loses atomicity           | Durable replay/conflict, receipt/result/outbox linkage and forced rollback      |
| Invalid authority/corruption becomes unavailable  | Expired/replaced/tampered session, strict decoder and corrupt-policy failures   |
| Browser commits a stale/partial switch            | Presence failure, old session, unavailable preservation and leave-failure tests |
| Room count is mistaken for activity participation | Distinct-principal ranking and AR Eye/Relic consumer behavior                   |

- Focused baseline before edits: 20 tests in the four membership/admission/retry/browser workflow
  files passed at parent `97cdef5e855973ab368dfdedd6a4056629a3f8d2`.
- The parent merge brought #694 queue-budget and benchmark changes. The earlier #696-branch
  baseline is historical; use merged main `5662b410621b464f5b3a60999dafdbfc1c107fd3` for a new
  comparable baseline with the current harness. Retain fresh parent/candidate state-write measurements under ignored `tmp/perf/`, with separate
  freshly migrated databases: `npm run perf:api-v1:state-write -- --backend=postgres --warmup=1
  --runs=3 --concurrency=10 --out=...`. Run the unchanged comparator; use the prescribed balanced
  protocol if noise prevents a defensible verdict. Native-check affected harness consumers.
- Run `npm run pr:delivery -- status` before broad final validation. Repair actual conflicts first;
  being behind alone does not authorize branch refresh. Preserve the fixed Postgres medium-scale
  correctness gate (100 clients, five groups, three API processes, 10+5 lanes).
- Run affected checks selected by `rallar-testing`, including style full/changed, structure, legacy,
  staged-test reachability and coupling checks. Review every touched file, perform the required
  construction/runtime causal navigation probe, and record findings honestly in PR evidence.
- Obtain one fresh whole-branch review after inline implementation; address findings and run
  proportionate regression checks. Run the Branch Release Gate, then `pr:delivery -- ready` once
  without enabling auto-merge. Report exact passed/failed/skipped validation and remaining follow-ups.
- Delete this completed implementation plan, retain the product contract, and wait for the user's
  merge before continuing. Issue #683 remains independent; no new issue is presumed.
