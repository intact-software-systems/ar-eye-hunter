# Task 4 correction 11 report: snapshot liveness fences, complete admin validation, and live PostgreSQL proofs

## Status and scope

Status: `DONE`.

This correction starts from clean Task 4 head
`5de21158222230bbadf2543c78929a3c285f76f7` and resolves all three Important
findings in correction brief 11. It does not start Task 5/6, update progress,
push, add a lock or migration, or modify the ignored Task 0B baseline.

Correction 11 supersedes correction 10 for final Task 4 acceptance. A note was
added to the correction-10 report limiting its overclaim: its canonical admin
validation covered keys and slot identity, not complete persisted row contracts.
Its receipt, terminal-collision, and expected-revision expiry-delete evidence
remains valid.

## Root causes and corrections

### 1. Snapshot liveness trusted stale summary copies

`GroupStateRepository` assembled direct/list/page snapshots from optimistic
summary sessions without checking the latest authoritative session row. A
disconnect, expected-revision deletion, or replacement generation could
therefore leave stale live presence in a snapshot and room authority.

All three snapshot APIs now capture one observation time and feed the same
assembler with latest authoritative sessions. A summary session remains live
only when:

- group lifecycle and expiry allow live presence;
- the latest member is active;
- summary and authoritative rows have complete, exact
  `sessionId`/`principalId`/`generationId`/`generationVersion` identity; and
- the authoritative row is connected and unexpired at the captured time.

The assembler returns the summary copy and preserves the summary causal tuple;
it never substitutes a newer generation. Direct reads and page reads fetch
authoritative sessions with the other child reads; list reads bulk-load and
group them once per scope.

Review of the first GREEN found a second root cause: `readCurrentSnapshot`
probed only group plus summary causal revision, which does not advance for a
session-only disconnect/delete. A warm monotonic cache could therefore bypass
the repository fence. Current authority now always performs the durable fenced
snapshot read and deliberately does not observe that equal-causal-revision,
liveness-filtered projection into the monotonic summary cache. Room authority
is current while asynchronous summary convergence retains its existing causal
model.

Tests cover same-generation CAS heartbeat (visible), same-generation
disconnect, expected-revision deletion, replacement generation under the same
session ID, group lifecycle and membership filtering, direct/list/page parity,
and a room send through a primed warm cache.

### 2. Admin summaries validated identity, not the persisted contract

The admin reader decoded canonical keys and matched key/value identities but
did not validate exact persisted Group, GroupMember, or GroupPresenceSession
shape and lifecycle. Canonically keyed incomplete/corrupt rows could be counted
or silently treated as inactive.

Three narrow pure assertion exports now delegate to the existing canonical
persisted validators in `group-state-mutations.ts`. Scoped and global admin
reads parse each row, reuse the matching complete validator, retain child slot
checks, and translate every failure to
`admin-operations-state-invariant-corruption` before counting or joining.
There is no second admin-specific contract definition.

The old malformed-expiry test was replaced with whole-read fail-closed cases
for missing mandatory data, wrong discriminants/primitives, null expiry, and
heartbeat-after-expiry across scoped and global reads. Canonical complete
no-expiry/future-expiry/expired values prove valid optional expiry behavior.
Existing noncanonical, wrong-slot, sentinel-scope, and valid count coverage
remains green. Test fixture hydration now creates complete canonical domain rows;
raw corruption cases bypass hydration explicitly.

### 3. Real PostgreSQL acceptance proofs were absent

The base live suite had four expiry/rollback/key-isolation cases and no
last-slot or 100-heartbeat case. Two opt-in tests were added before any
production change for this finding:

- Three independent `max: 1` PostgreSQL clients seed and race two services at a
  two-participant group-read barrier with `maxMembers = 2`. Exactly one join
  succeeds, the rebased loser is rejected for capacity, the final roster has
  owner plus one contender, and only the winner owns a `member-joined` event
  and outbox intent.
- One hundred canonical admitted sessions are seeded. Two independent
  PostgreSQL-backed services split 100 heartbeats behind a bounded 100-read
  barrier. Every target session storage revision advances exactly once; the
  group aggregate storage revision is unchanged; and 100 unique heartbeat
  events/outbox records have the exact aggregate owner and deterministic
  `group-state-sync`/`group-presence-summary` effects.

The first approved live run proved both new cases immediately. Three older
global-maintenance cases then encountered unrelated legacy black-box rows in
the shared local database with missing generation identity. A read-only query
confirmed `api-v1-black-box-*` and `api-v1-medium-scale-*` residue. The live
test harness now filters maintenance enumeration to each test's unique
application prefix; it does not delete or reinterpret unrelated rows and does
not change production behavior. Final live result: 6/6 passed, including the
100-heartbeat case in 1.133 seconds.

## Strict RED/GREEN evidence

- Snapshot RED:
  `npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts
  -t "intersects summary presence with the latest exact session generation"`
  failed because the disconnected summary session remained visible. GREEN:
  1 passed, 66 skipped; final complete file: 67 passed.
- Warm-cache authority RED:
  `npx vitest run packages/tests/shared-server/ws-topic-room-authorizer.test.ts
  -t "stale behind an authoritative disconnect"` failed on the old causal
  probe path. After the first fix it exposed the expected equal-revision cache
  conflict, leading to the final durable/no-observe boundary. GREEN with cache
  service coverage: 2 files, 14 passed. API room-authorizer coverage: 3 passed.
- Admin RED:
  `deno test --allow-env --allow-read
  test/db/admin-operations-postgres-reader.test.ts --filter
  "complete-contract violations"` failed with `Missing expected rejection:
  missing mandatory group field`. GREEN: 1 passed; final file: 20 passed.
- Live-proof coverage RED:
  `git show 5de21158:packages/tests/shared-server/postgres-presence-expiry-concurrency.test.ts
  | rg "last group member slot|100 independent session heartbeats"` produced
  no matches. The finding was missing acceptance coverage, not a production
  defect: both new real-PostgreSQL tests passed on their first reachable run.
  Final complete live suite: 6 passed.

The initial non-escalated live command was sandbox-blocked by `EACCES` on
localhost:5432; the approved run reached PostgreSQL. No failed production
behavior is hidden by that environmental failure.

## Writing-skill pressure evidence

The writing-skills RED/GREEN process ran before guidance was edited. Five local
fresh unguided samples all chose the complete persisted validator under varied
deadline, authority, performance, and incident pressure. The parent campaign
contained additional controls that still interpreted “canonical row” as
key/identity-only and gave the binding determination that the aggregate
evidence confirmed ambiguity.

The minimal clarification in `rallar-code-writing/SKILL.md` says authoritative
admin/domain summaries reuse the complete persisted contract (exact shape,
mandatory fields, identity, and cross-field lifecycle invariants) and tests
must include canonically keyed shape-invalid rows.

Five fresh guided samples then read the edited skill completely. All five chose
whole-read fail-closed shared validation and rejected local subsets, silent
skips, identity-plus-warning, and approximate-authority alternatives. Skill
integrity passed 8/8.

## Files and behavior changed

- `.agents/skills/rallar-code-writing/SKILL.md`: minimal complete-contract
  clarification.
- `.superpowers/sdd/task-4-correction-10-report.md`: correction-11 supersession
  note for the invalidated final-acceptance/admin claim.
- `GroupStateRepository.ts`: authoritative-session intersection for all
  snapshot APIs.
- `cached-group-state-service.ts`: durable current-authority reads that do not
  pollute equal-revision monotonic summary cache state.
- `group-state-mutations.ts`: narrow reusable complete persisted validators.
- `PSqlAdminOperationsStatsReader.ts`: complete scoped/global row validation.
- Focused snapshot/cache/room/admin tests and canonical admin fixtures.
- Live PostgreSQL capacity/heartbeat tests, application-isolated maintenance
  enumeration, and application-owned outbox cleanup.

No existing public import path was removed. The validator exports remain a
narrow internal shared-server module surface; no barrel/public product API was
expanded.

## Final validation evidence

```text
npx vitest run packages/tests/shared-server
55 files passed; 2 configured files skipped
554 tests passed; 7 configured tests skipped

cd apps/api-v1 && deno task test
204 passed; 0 failed

npm run typecheck
root shared plus every TypeScript workspace passed

npm run test:postgres:presence-expiry
1 file passed; 6 tests passed
100-heartbeat case: 1.133s

npm run test:api-v1:black-box:memory
11 profiles passed; 0 failed; 0 skipped
api-v1-group-presence: 17 successful steps

cd apps/api-v1 && deno task check
passed

cd apps/api-v1 && deno task lint
Checked 76 files; passed

npm run lint --workspace @ar-eye-hunter/shared-server
passed

npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
8 passed

deno fmt --check [touched Deno-formatted admin production/test files]
Checked 2 files; passed

git diff --check
passed
```

The existing double-quote live test and package four-space files remain outside
the Deno formatter baseline; touched Deno-formatted files are clean and
`git diff --check` passes. No-lock scans found no `pg_advisory`, row/table lock,
`FOR UPDATE`/`FOR SHARE`, or `lockKey` usage in the changed group/admin/live
flows. (The generic PostgreSQL repository still exposes its pre-existing lock
API; these flows do not call it.) Pure mutation scans found no clock, random,
env, runtime repository, transaction, or publication dependency. Direct
publication/timing-wrapper scans found no regression. Group online-member
joining continues to use explicit workspace presence tags rather than a lossy
sentinel projection.

Task 0B baseline SHA-256 is unchanged and exact:

```text
ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7  tmp/perf/api-v1-state-write-baseline.json
```

## Review and remaining tradeoff

The completion code review found the warm-cache bypass described above. After
its RED/GREEN fix and rerun, the reviewer reported no Critical, Important, or
Minor issues and assessed the correction ready to merge.

The intentional tradeoff is that a session-only liveness projection may differ
while retaining the optimistic summary causal tuple. Current authorization
therefore reads durable state and does not overwrite the monotonic summary cache
at an equal tuple. The cache may retain its prior summary until asynchronous
summary convergence advances presence revision, but current room/policy
authority never relies on it.

No follow-up is required for correction 11. Task 5 remains blocked until the
parent explicitly advances it.
