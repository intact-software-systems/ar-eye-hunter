# Task 4 correction 10 report: validated receipts, canonical global summaries, terminal collisions, and expiry deletion

## Status and scope

Status: `DONE`.

This correction resolves all four Important findings in the correction-10
brief from clean Task 4 head `db10055c616c33704c75b8f40738cb2a5f2e4936`.
It does not start Task 5/6, update progress tracking, add locks, add a migration,
push, or modify the ignored performance baseline.

Correction 10 supersedes correction 9 for final Task 4 acceptance. Correction
9 correctly introduced typed collision codes, but its claim that event/outbox
collisions were already nonretryable was incomplete: neither error exposed the
4xx status that AppInbox uses for terminal classification. A prominent note was
added to the correction-9 report.

## Root causes and corrections

### 1. Persisted receipt derived invariants

`validateMutationReceipt` checked exact fields and primitive shapes, but did not
recompute the scalar revision or bind the receipt outcome to event presence.
Consequently a shape-valid, causally impossible compact receipt could be
inserted and replayed.

The validator now requires:

- `stateRevision` to equal `toGroupSnapshotStateRevision(groupRevision,
  presenceRevision)`;
- `outcome === 'applied'` exactly when `event.kind === 'group'`;
- the existing join-code, rejection, request, hash, ref, event, and snapshot
  invariants remain unchanged.

Repository insertion and both compact read APIs already share this validator,
so every persisted boundary fails closed with the existing typed repository
corruption error. Valid service receipts and deterministic replays remain
unchanged.

### 2. Canonical global admin group summaries

`readGlobalState` counted group-domain rows with permissive aggregate SQL. Its
online-member join used `coalesce(workspaceId, '_')`, which aliased an absent
workspace with the valid explicit workspace `_`; aggregate reads also bypassed
canonical key/value validation.

Global group-domain counts now read the three live authoritative row families
(`groups`, `members`, and `sessions`), run the generalized canonical scoped-row
validator without an expected scope, and count in TypeScript. The group-member
join key is a structured JSON identity with an explicit workspace
presence/present tag. Scoped reads use the same collision-safe identity. The
old group aggregate SQL and lossy group join were removed; client aggregate
queries and separately modeled raw storage statistics are unchanged.

Tests cover global wrong-slot values, noncanonical group/member/session keys,
absent versus explicit `_`, cross-scope non-pairing, and canonical intended
counts.

### 3. Terminal AppInbox collision semantics

`GroupStateEventCollisionError` and `StateMutationOutboxCollisionError` had
stable codes but no `status`. `AppInboxService` intentionally classifies only
typed 400-499 domain errors as terminal, so both authoritative collisions were
rescheduled as transient failures.

Both collision types now expose `readonly status = 409`. AppInbox records a
terminal failed result, completes the queue entry in one attempt, and does not
invoke the handler again. Typed collision detection and transaction rollback
behavior are otherwise unchanged.

### 4. Expected-revision expiry deletion

Internal group presence expiry reused public `disconnectPresence`, which
constructed a disconnected-session CAS update. That made liveness appear
correct but violated the binding create/insert, update/CAS, delete/conditional-
delete architecture.

The pure mutation guard now has a presence `delete` operation carrying the
validated predecessor value and expected storage revision. Internal expiry
computes that delete guard; public/manual disconnect continues to compute an
update with `disconnectedAtEpochMs` and `disconnectReason`. The transaction's
first authoritative statement dispatches the expiry guard to
`GroupStateRepository.deletePresence(value, expectedRevision)`. Admission,
receipt, insert-only outbox, and event writes occur only after it succeeds.

Missing presence is a no-op only for the narrow internal expiry authority, so
concurrent/repeated scans converge after a fresh read. Public late heartbeat or
disconnect still rejects a missing session. Delete conflicts use the existing
three-attempt `[0,2,8]` loop, which re-reads and reruns computation, authority,
lifecycle, policy, and validation before every attempt. Exhaustion is explicit.

Focused tests prove physical deletion, delete-first ordering, stale generation
fencing, duplicate/different-time convergence, three delete attempts with
`[2,8]` sleeps on exhaustion, no dependent writes after failed guards, and
rollback of delete/receipt/event/outbox after a dependent outbox collision.
The live PostgreSQL suite proves real conditional deletion and real transaction
rollback.

## Strict RED/GREEN evidence

Production changes followed focused failures:

- Receipt RED:
  `npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts
  -t "enforces the exact compact idempotency contract"` failed because the
  impossible record insert resolved `{ status: 'applied' }` instead of
  rejecting. GREEN: 1 passed, 63 skipped.
- Global admin RED:
  `deno test --allow-env --allow-read
  test/db/admin-operations-postgres-reader.test.ts --filter "corrupt global
  group rows"` failed with `AssertionError: Missing expected rejection`.
  GREEN: 1 passed; final admin file: 19 passed.
- AppInbox RED:
  `npx vitest run packages/tests/shared-server/app-inbox-service.test.ts -t
  "stores .* collision as terminal"` retried both errors and both cases timed
  out at 5 seconds. GREEN: 2 passed, 22 skipped; each handler ran once, queue
  status became completed at attempt 1, and the stored result carried its code
  plus status 409.
- Expiry RED:
  `npx vitest run
  packages/tests/shared-server/group-state-service-idempotency.test.ts -t
  "eventually expires a session"` received the disconnected tombstone where
  the test required `undefined`. GREEN: 1 passed, 15 skipped. The final focused
  expiry/concurrency and atomicity cases also pass.

## Writing-skill pressure evidence

The `superpowers:writing-skills` pressure workflow completed before guidance
was edited.

Five fresh, independent, no-guidance controls were manually inspected:

- controls 1 and 2 enforced all four requirements;
- control 3 kept global aggregate SQL, bounded collision retries with a fresh
  candidate, and expiry tombstones while fixing only receipt semantics;
- control 4 proposed an exhaustion-style collision retry test rather than
  immediate terminal behavior;
- control 5 deferred global canonical validation as a performance tradeoff.

Thus three of five controls exposed the exact durable loopholes. Minimal wording
was added only to `rallar-code-writing/SKILL.md`: persisted validators enforce
derived cross-field invariants; authoritative global domain summaries validate
every row and preserve scope presence (while separately labeled raw telemetry
may remain aggregate); fail-closed immutable collisions carry terminal 4xx
semantics at queues; and expiry is an expected-revision delete, not a tombstone
shortcut.

Five fresh guided samples were then manually inspected. All five rejected the
unsafe alternatives, including the combined release-pressure premise that only
two fixes could ship. They correctly allowed only separately labeled raw
telemetry and unrelated refactoring to wait. Skill/docs integrity remained
green.

## Files and behavior changed

- `.agents/skills/rallar-code-writing/SKILL.md`: durable guidance for the four
  escaped principles.
- `packages/shared-server/rallar-system/services/group-state-mutations.ts`:
  receipt derived validation and the pure expiry delete guard.
- `packages/shared-server/rallar-system/services/group-state-service.ts`:
  transactional presence-delete dispatch.
- `packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`:
  canonical global group row reads/counts and injective identities.
- `packages/shared-server/postgres/rallar-system/PSqlStateEventRepository.ts`
  and `packages/shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts`:
  explicit terminal 409 collision contracts.
- Focused Vitest, Deno/PGlite, and live PostgreSQL tests under
  `packages/tests/shared-server/**` and `apps/api-v1/test/db/**`.
- `.superpowers/sdd/task-4-correction-9-report.md`: explicit supersession note.

No public import path was removed. The only behavior changes are fail-closed
receipt/global-row validation, terminal collision classification, and physical
deletion for internal group presence expiry.

## Verification evidence

Correctness and integration gates:

```text
npx vitest run [7 focused files]
7 files passed; 187 tests passed

npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts \
  packages/tests/shared-server/group-state-service-idempotency.test.ts \
  packages/tests/shared-server/app-inbox-service.test.ts
3 files passed; 106 tests passed

npx vitest run packages/tests/shared-server
55 files passed; 2 configured files skipped
552 tests passed; 7 configured tests skipped

cd apps/api-v1 && deno task test
203 passed; 0 failed

cd apps/api-v1 && deno test --allow-env --allow-read \
  test/db/admin-operations-postgres-reader.test.ts
19 passed; 0 failed

cd apps/api-v1 && deno test --allow-env --allow-read \
  test/db/pglite-sql-adapter.test.ts --filter collision
1 passed; 15 filtered out

npm run test:postgres:presence-expiry
1 file passed; 4 tests passed

npm run test:api-v1:black-box:memory
11 profiles passed; 0 failed; 0 skipped
api-v1-group-presence: 17 successful steps
```

The first live PostgreSQL attempt was sandbox-blocked with `EACCES` for
`127.0.0.1/::1:5432`; the approved rerun reached PostgreSQL. One new fixture
then exposed an invalid `Number.MAX_SAFE_INTEGER` JavaScript date, which was
corrected to the repository's `NEVER_EXPIRE_AT_TIMESTAMP`; the final approved
run passed 4/4. The first memory black-box attempt was sandbox-blocked from
binding the managed local API port; the approved rerun passed all profiles.

Type, lint, format, docs, and static gates:

```text
npm run typecheck
root shared plus every TypeScript workspace passed

cd apps/api-v1 && deno task check
passed

cd apps/api-v1 && deno task lint
Checked 76 files; passed

npm run lint --workspace @ar-eye-hunter/shared-server
passed

npm run lint --workspace @ar-eye-hunter/shared-test
passed

deno fmt --check [touched admin production/test files]
Checked 2 files; passed

git diff --check
passed
```

Root `npm run lint` still reports the four inherited workspaces with no `lint`
script (`ar-eye-hunter-v1`, `rallar-black-box`,
`rallar-black-box-headless`, and `relic-hunters-v1`); every workspace that has
a lint script passed. The existing live PostgreSQL test file remains outside
the Deno formatter baseline (its pre-existing double-quote style causes a
whole-file `deno fmt --check` diff); correction-10 additions follow that file's
style. The two touched admin files are formatter-clean.

No-lock scans found no `pg_advisory`, `lock table`, `for update`, `for share`,
or `lockKey` in the touched authoritative production paths. The pure group
mutation scan found no direct clock/random/env, transaction, publisher, or
runtime repository dependency (only the existing pure `jsonEquals` utility
import path contains the word `repository`). Authoritative service scans found
no `putOrLoad`, `timeMutationPhase`, or `timePhase` regression.

The ignored Task 0B artifact remains unchanged at:

```text
ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7  tmp/perf/api-v1-state-write-baseline.json
```

## Tradeoffs and follow-up

Global authoritative group-domain summaries now materialize and validate live
group/member/session rows before counting, which is intentionally more work
than permissive aggregate SQL. If raw storage-volume telemetry is needed later,
it should be added as a separately labeled metric rather than weakening
`AdminOperationsStateResponse.groups`.

No Task 4 follow-up is required. The existing missing root lint scripts and the
pre-existing live-test formatter baseline are repository tooling concerns, not
correctness exceptions for this correction.
