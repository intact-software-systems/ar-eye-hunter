# Latency-ranked discovery design and implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` and the repository's
> `adaptive-plan-execution` skill. Resolve the measurement prerequisite below before
> implementing ranking, then implement the two increments test first.

**Goal:** Let a caller explicitly prefer lower-latency rooms while keeping discovery
useful when latency is unknown. Preserve eligibility and occupancy priority until
participation evidence supports changing it.

**Spec:** [Lobby and matchmaking, slice 2](lobby-and-matchmaking.md#slice-2-latency-ranked-discovery),
the current product and architecture documents. This work starts from main after
the Quick Join delivery. The maintainer owns merge of the completing PR.

## Constraints

- No legacy path, duplicate implementation or migration code. Prefer existing
  repository patterns and keep code, tests, documentation and plans consistent.
- Every changed human-authored file is reviewed and remediated in full. Every
  support file modified by that remediation enters closure recursively. Independent
  untouched code remains outside closure.
- TDD requires an observed behavioral failure before the corresponding production
  change. Missing imports and broken fixtures do not establish the required red.
- Directory visibility, admission, membership and activity participation remain
  separate. Discovery does not itself grant membership or application authority.
- Unknown latency never means zero or exclusion. Default ordering remains online
  member count descending, then group ID ascending. Quick Join's committed selection
  and replay contract remain independent of an optional directory preference.
- Public directory entries must not expose peer/session identifiers, coordinates,
  private room membership, or raw signaling data.
- Any new authoritative measurement or probe authorization write uses AppInbox,
  visible read → compute → validate → write phases, guarded optimistic writes, and
  durable idempotent results. Reuse the existing transaction and retry owners.
- Keep only the next two useful increments concrete. Publish one current PR, keep
  it current, and wait for the maintainer's merge before the next product slice.
  Delete this implementation plan in its completing PR; Git history is the archive.

## Measurement prerequisite

The first proposed implementation used the maximum direct RTT to every online
session in a discovered room. Repository inspection and a fresh builder review
identified reasons that this cannot yet be treated as a useful general discovery
score. Do not implement that formula solely because its comparator can be tested.

### Established from current code

- `packages/shared-server/rallar-system/rtc-rtt/policy/rtc-rtt-measurement-policy.ts`
  accepts a report only for sessions sharing a live, active group and an eligible
  reporting edge. Endpoint admission also enforces a degree bound. The default in
  `packages/shared/rtc/rtt-reporting-policy.ts` is five peers; configuration can
  change it. Complete direct coverage of larger rooms cannot be presumed.
- `apps/api-v1/src/composition/create-api-v1-topology-services.ts` obtains candidate
  groups from the reporting sessions' shared live presence. An unfamiliar peer
  cannot supply an accepted measurement through the existing reporting path merely
  because its room is listed in the directory.
- The directory excludes rooms the caller can already read in full. Reusable RTT
  evidence therefore requires another shared group or sufficiently recent earlier
  contact with the same sessions. A new authenticated session has no such evidence.
- `RtcRttRepository` provides an endpoint batch read suitable for reusing existing
  observations. Its default storage TTL is 60 seconds from acceptance. Persisted
  sample validation checks the creation timestamp's shape, not its age. Storage
  expiry alone must not be presented as proof of a recent network observation.
- Vivaldi nodes contain coordinates and error estimates, but their exported data
  does not establish a common observation component or sample freshness. Unrelated
  coordinate systems do not establish comparable cross-room distances.
- AR Eye's director transport is RTC with WebSocket fallback; its peer motion and
  effects also use RTC. Relic's authoritative commands use WebSocket. Peer RTT is
  not a measurement of either game's full command completion time.

The current directory and WebSocket runtime inspection did not identify an
existing server RTT source that would resolve the missing peer observations.
This is a source finding, not a measured production coverage statistic.

### Scope decision

Two materially different implementations are available:

| Choice                                | Useful outcome                                                                                     | Required boundary                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Bounded, opt-in pre-join measurements | Can acquire evidence for unfamiliar rooms before selecting one.                                    | A separate explicit probe authorization and target participation policy; it must not weaken ordinary membership or RTT admission. |
| Existing measurements only            | Can compare rooms when the same sessions were already measured through an authorized shared group. | Explicitly limited coverage, unknown results for unfamiliar rooms, and no claim of general pre-join measurement.                  |

The maintainer must select the intended scope before dependent production work.
The recommendation is pre-join measurements if ranking unfamiliar rooms is the
intended experience. Existing measurements remain a valid narrower option only
with that limitation accepted. The exact target, aggregation, freshness rule and
public label follow the chosen path and its evidence; the earlier all-peer maximum
is not a settled contract.

### Evidence required for the selected path

Use AR Eye and Relic as distinct consumers. Identify the user-visible outcome the
measurement predicts: peer update delivery, director command receipt, or server
command completion. Run a controlled transport experiment with different delays
and capture both the proposed signal and that outcome. Include cold sessions,
expired samples, room membership churn, and the reporting degree bound.

Report what was measured, its environment and limitations. Seeded RTT values can
prove ordering and missing-data behavior; they cannot establish network prediction
quality or participation improvement. Keep generated traces under `tmp/perf/`.

## Increment 1: usable, authorized latency evidence

**Deliverable:** A defined measurement contract and a reproducible demonstration
that its signal tracks the selected application path, with explicit unknown states.

- [ ] Resolve existing-only versus pre-join scope and the target experience.
- [ ] Define sample age, confidence/coverage, endpoint ownership, cancellation,
      timeouts and unknown behavior. Derive the room score from the chosen target.
- [ ] Reuse existing RTT readers and transport owners where their contracts apply.
      If probes are selected, define bounded requester and recipient consent, room
      visibility, session replacement and expiry before implementing authorization.
- [ ] Write behavioral tests for the selected contract and observe the required red.
- [ ] Implement only the selected path. New authoritative writes must prove
      compare-and-set conflicts re-read and recompute, exact replay returns the
      recorded result, changed requests conflict, and state/outbox/completion commit
      atomically. Do not add a second store or retry loop for existing evidence.
- [ ] Run the controlled transport experiment and its affected package checks.
      Document an inconclusive result honestly and adapt before dependent ranking.

## Increment 2: directory and browser opt-in

**Deliverable:** Safe, paginated opt-in ranking using the validated signal, with
useful default ordering and usable unknown results in both games.

Existing owners are the shared directory contract, server directory query/computation,
API read-route composition, browser state-snapshot HTTP API and rooms facade, and
AR Eye's directory action/state/UI. Keep the score and comparator pure. Do not
duplicate them in application consumers or change Quick Join's selection policy.

- [ ] Define the public request, safe nullable summary and order-aware cursor from
      the validated measurement contract. Bind reads to authenticated scope/session.
- [ ] Add failing direct computation and native directory-route tests for literal
      ordering, unknowns, ties, pagination, hidden rooms, auth changes and ETags.
- [ ] Implement opt-in ranking after occupancy. Retain default behavior and fail
      closed for corrupt persisted data. Update OpenAPI and black-box recipes with
      the REST change.
- [ ] Add failing browser request and visible control tests, then implement the
      preference through existing directory generation fencing. Reject stale results
      after order or session changes and retain actionable loading/error states.
- [ ] Validate AR Eye and Relic without confusing peer traffic with authoritative
      command latency. Operate the visible controls in Playwright; prove that rooms
      with unknown latency remain usable.
- [ ] Update public documentation and the continuing product plan with the actual
      contract, evidence and limits. Review the full changed-file closure and remove
      this implementation plan only when the requested outcome is complete.

## Validation and delivery

Direct behavior validation is the chosen measurement experiment plus directory
route/computation tests. Affected application/package validation includes native
API checking, shared/browser type checks, browser bundle boundaries, and both game
builds. Add measurement/probe-specific tests once its owner is selected:

```sh
npm exec -- vitest run packages/tests/shared-server/rallar-system/rtc-rtt/rtc-rtt-mutation.test.ts packages/tests/shared-server/rallar-system/rtc-rtt/rtc-rtt-incident-measurement-read.test.ts packages/tests/shared/rtc-rtt-reporting-policy.test.ts
npm exec -- vitest run packages/tests/shared-web/state-group-directory-request.test.ts packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts
deno test --config apps/api-v1/deno.json --allow-env --allow-read apps/api-v1/test/group-state/group-state-directory-route.test.ts apps/api-v1/test/group-state/group-state-openapi-contract.test.ts
deno check --config apps/api-v1/deno.json apps/api-v1/src/main.ts apps/api-v1/test/
npm exec -- tsc -p packages/shared/tsconfig.json --noEmit
npm exec -- tsc -p packages/shared-web/tsconfig.json --noEmit
npm --workspace ar-eye-hunter-v1 run build
npm --workspace relic-hunters-v1 run build
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
npm run check:repo-style
npm run check:repo-structure
npm run check:test-reachability
npm run test:repo-governance
```

Run focused checks before broad validation. A production API mutation or concurrency
change additionally requires the state-write performance comparison; preserve the
medium-scale correctness workload. Run `npm run pr:delivery -- status` before final
broad validation and repair real conflicts first. Require Branch Release Gate. Run
`npm run pr:delivery -- ready` at completed handoff and leave merge to the maintainer.
Report passed, failed and skipped checks without treating baseline tests as feature
completion evidence. The live PR owns delivery status and validation results.
