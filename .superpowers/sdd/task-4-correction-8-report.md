# Task 4 correction 8 report: fail-closed scoped group reads and events

## Status and scope

Status: `DONE_WITH_CONCERNS`.

This correction closes Task 4 group-state runtime read, group-event, and admin
scope leaks from base `778deee2af35a53c00ff9566dc7ff649fb0b2abb`. It does not
change Task 4 read/compute/validate/write orchestration, CAS retry/outbox
behavior, client-event encoding, Task 5 topology config, or Task 6 topology
snapshot/publication/execution/RTT repositories. It adds no lock, dual read,
fan-out, unconditional authoritative write, or runtime migration.

## Root cause and implementation

The prior correction made new runtime group keys injective but treated a key
match as authority. A legacy explicit-`_` JSON value under `ws=_` could therefore
be returned to an absent-workspace request. Bare-value scope lists also discarded
the physical key before checking group/member/session/admission/summary identity,
and compact no-event idempotency records had no independently persisted group
identity. Separately, PostgreSQL group events still used
`workspaceId ?? '_'`, so absent and explicit `_` leaked across reads and the
same event ID collided under the primary key. Admin group statistics rebuilt the
old runtime prefix and compared events to raw workspace IDs.

Implemented boundaries:

- `group-state-storage-keys.ts` now decodes group/member/session/admission/
  request keys and rejects noncanonical encodings by deterministic re-encoding.
- `GroupStateRepository` validates the physical key, trusted request/scope, and
  decoded value identity for direct, list, snapshot-list, page, all-session, and
  compact-receipt reads. One mismatch throws
  `GroupStateRepositoryInvariantCorruptionError` with code
  `group-state-repository-invariant-corruption` for the whole read. It is never
  returned as a miss, filtered, rewritten, or guessed.
- `GroupMutationIdempotencyRecord.aggregateRef` is mandatory, populated from
  the canonical command, exact-shape validated, and checked on insert and read.
  Historical identity-free records fail closed; there is no legacy fallback.
- The group-event-only `groupEventWorkspaceKey(...)` preserves historical
  absent `_`, maps explicit `_` to `%5F`, and URI-encodes other present values.
  Append, full/recent/page queries, and admin group-event counts use it.
  Returned events validate JSON application/workspace/group plus the physical
  `event_id`; mismatches throw
  `group-state-event-repository-invariant-corruption`.
- `PSqlAdminOperationsStatsReader` uses `groupStateScopeStorageKey(...)` only
  for group runtime namespaces, leaves client/CRDT scope behavior unchanged,
  validates decoded group/member/session rows before counting, and uses the
  canonical group-event database key.
- Repository and architecture docs now state the fail-closed contract and the
  offline migration boundary. Correction 7 has a prominent supersession note
  covering its incomplete repository-boundary and no-follow-up claims.

## Systematic root-cause and TDD evidence

Production behavior was changed only after focused failing tests.

### Runtime repository reads and receipts

Initial direct-read RED:

```text
npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts
1 failed; 52 passed
findGroup resolved the directly seeded explicit-`_` value for an absent request
instead of rejecting.
```

The minimal direct identity check made the suite 53/53. Subsequent independent
RED/GREEN cycles proved:

- list/snapshot/page group reads returned the wrong-scope group: RED 1/53,
  GREEN 54/54;
- member/session/admission/summary direct and list slots returned a wrong value:
  RED 1/54 after correcting a test-iteration error, GREEN 55/55;
- an identity-free compact no-event receipt resolved instead of rejecting:
  RED 1/55, GREEN 56/56;
- a receipt with the wrong `aggregateRef` was inserted: RED 1/56, GREEN 57/57;
- `listSnapshots` returned a snapshot containing a wrong-workspace member
  because it loaded bare child values: RED 1/57, GREEN 58/58;
- `findGroupEntry` accepted a repository result whose physical key differed
  from the requested key while its JSON matched: RED 1/58, GREEN 59/59.

Final focused memory result:

```text
npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts
1 file passed; 59 tests passed
```

### PostgreSQL/PGlite group events

The first event RED reproduced both the read leak and lost equal event ID:

```text
deno test -A apps/api-v1/test/db/pglite-sql-adapter.test.ts \
  --filter 'PSql group events isolate absent'
1 failed; explicit `_` read returned the absent event and only one row survived
```

The canonical group-event database helper made this test 1/1. Event JSON
validation was then removed until its own test existed. The legacy wrong-scope
fixture failed RED with `Missing expected rejection`; restored validation made
the two event tests 2/2. A physical `event_id`/JSON mismatch then failed RED
with `Missing expected rejection`; selecting and checking the physical slot made
the focused event group 3/3.

PGlite also directly seeds a legacy runtime `ws=_` row and proves absent-scope
direct, snapshot, list, and page reads all fail with the typed repository error.
The helper matrix proves pairwise distinction for absent, `_`, `%5F`, ordinary,
delimiter, percent-lookalike, and full-width lookalike values.

### Admin reads

```text
deno test -A apps/api-v1/test/db/admin-operations-postgres-reader.test.ts \
  --filter 'isolates explicit sentinel group state'
RED: expected 1 active group, received 2
GREEN: 1 passed

deno test -A apps/api-v1/test/db/admin-operations-postgres-reader.test.ts \
  --filter 'fails closed on wrong-scope group runtime values'
RED: Missing expected rejection
GREEN: 1 passed
```

The first combined PGlite/admin regression run passed all 15 PGlite tests but
reported 6 failing admin tests (24 passed, 6 failed). Root-cause tracing showed
old test helpers seeded sparse group values and obsolete `:principal=` member
keys rather than authoritative current rows. The production validator was not
weakened. The fixtures were made canonical while the explicit corruption test
retains a conflicting workspace. Final admin result: 15/15.

## Writing-skills RED/GREEN evidence

The complete edit workflow was applied before changing repo guidance.

- Five fresh no-guidance samples used deadline, sunk-cost, authority, and
  exhaustion pressure. One sample explicitly proposed that a decoded mismatch
  become a miss and list rows be filtered; this was the exact loophole. The
  other samples recognized corruption, but two expanded into client-event work
  outside the requested group-event domain. Every flagged response was read
  manually.
- Minimal positive/prohibitive guidance was added to `AGENTS.md` and the four
  required repo skills: decode key identity on authoritative direct/list/page/
  event/receipt reads; compare it with trusted scope/slot; throw typed whole-read
  corruption; never miss/filter/rewrite/guess.
- Five fresh guided samples all required typed whole-read failure, mandatory
  compact-receipt group identity, canonical group-event/admin helpers, and a
  value-verified offline migration. They also found the real bare-child
  `listSnapshots` and physical `findGroupEntry.entry.key` holes, which received
  their own RED/GREEN cycles.
- This was an edit to existing reference guidance: names/frontmatter, examples,
  flowcharts, rationalization tables, red-flag sections, and supporting files
  were intentionally unchanged or not applicable. No hypothetical extra prose
  was added. Push/contribution checklist items are not applicable because the
  brief explicitly forbids pushing.
- Fresh integrity/docs gate: 2 files passed, 10 tests passed.

## Validation evidence

All required correctness gates passed after implementation:

```text
Final post-documentation regression command
npx vitest run packages/tests/shared-server \
  packages/tests/repo/rallar-skill-integrity.test.ts \
  packages/tests/shared-web/rallar-group-docs-compat.test.ts
57 files passed; 2 configured files skipped
551 tests passed; 7 configured tests skipped

cd apps/api-v1 && deno test -A \
  test/db/pglite-sql-adapter.test.ts \
  test/db/admin-operations-postgres-reader.test.ts
30 passed; 0 failed

Task 4 six-file focused command
6 files passed; 146 tests passed

npx vitest run packages/tests/shared-server
55 files passed; 2 configured files skipped
541 tests passed; 7 configured tests skipped

npx vitest run packages/tests/api-v1/client-and-group-state-repositories.test.ts
1 file passed; 25 tests passed

cd apps/api-v1 && deno task test
198 passed; 0 failed

npm run typecheck
root shared + every TypeScript workspace passed

npx tsc -p packages/shared-server/tsconfig.json --noEmit
passed

cd apps/api-v1 && deno task check
passed

cd apps/api-v1 && deno task lint
76 files checked; passed

npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts \
  packages/tests/shared-web/rallar-group-docs-compat.test.ts
2 files passed; 10 tests passed
```

Live PostgreSQL initially failed all three tests solely because the sandbox
denied localhost `127.0.0.1/::1:5432` with `EACCES`. The approved rerun passed:

```text
npm run test:postgres:presence-expiry
1 file passed; 3 tests passed
```

The live third test proves both runtime group and group-event absent/explicit-`_`
isolation with the same application/group/event ID across full/recent/page
reads.

The memory black-box gate initially failed solely because the sandbox denied
the managed API local bind. The approved rerun passed:

```text
npm run test:api-v1:black-box:memory
11 profiles passed; 0 failed; 0 skipped
group-presence: 17 successful steps
```

Static and hygiene evidence:

- `git diff --check`: passed.
- Exact no-lock scan (exit 1 with no matches, the expected clean result):
  `rg -n -i 'pg_advisory|lock table|for update|for share|lockKey' packages/shared-server/rallar-system/group-state-storage-keys.ts packages/shared-server/rallar-system/repositories/GroupStateRepository.ts packages/shared-server/rallar-system/services/group-state-mutations.ts packages/shared-server/postgres/rallar-system/PSqlStateEventRepository.ts packages/shared-server/postgres/rallar-system/group-event-workspace-key.ts packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`.
- Exact pure-mutation scan (exit 1 with no matches, the expected clean result):
  `rg -n 'Date\\.now|new Date|Math\\.random|crypto\\.random|process\\.env|Deno\\.env|Repository|Transaction|Publisher' packages/shared-server/rallar-system/services/group-state-mutations.ts`.
- Task 0B baseline SHA-256 is unchanged and exact:
  `ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7`.
- Exact scoped format command:
  `deno fmt --check apps/api-v1/test/db/admin-operations-postgres-reader.test.ts apps/api-v1/test/db/pglite-sql-adapter.test.ts`.
  It exits 1 only for the same pre-existing untouched block at
  `pglite-sql-adapter.test.ts:226-237`; the admin test and all correction hunks
  are formatter-clean.
- The configured full shared-server skips are the existing 2 files/7 tests.
  No required correctness, live PostgreSQL, or black-box gate was skipped.
- An exploratory root `npm run lint` exits 1 because four existing workspaces
  (`ar-eye-hunter-v1`, `rallar-black-box`, `rallar-black-box-headless`, and
  `relic-hunters-v1`) do not define a `lint` script. The command continued and
  all packages that do define lint passed, including shared-server,
  shared-test, shared-web, shared-graph, and relic-hunters. The required API
  Deno lint passed separately as recorded above.

## Offline migration boundary

Runtime migration is deliberately not part of a read path. With old writers
stopped, an operator may decode and validate the stored authoritative value,
derive exactly one canonical destination, claim it conditionally, and delete
the source only by its expected revision. Missing identity, destination
conflict/different content, or ambiguous scope aborts and is reported. An
identity-free no-event receipt must remain poisoned, expire under an approved
retention decision, or be resolved manually. It may not receive a fabricated
scope.

Group-event migration likewise validates `event_json` against physical
application/group/event identity before conditionally rekeying one row. It must
never fan a legacy `_` row into two scopes or install a permanent dual read.
An accepted event already discarded by the historical primary-key collision
cannot be reconstructed without an independent authoritative source.

## Mandatory Task 5/6 carry-forward

No topology repository listed below was modified. Review evidence proves their
pre-existing `RuntimeStateJsonStore`-derived optional-workspace key ambiguity is
still plan-owned and must be a mandatory acceptance item in the next briefs:

- Task 5: `GroupTopologyConfigRepository` plus its config/override mutation
  interfaces.
- Task 6: topology snapshot, publication, execution, and RTT repositories.

Task 5/6 must apply the same canonical decoded-key/value/trusted-slot matrix,
including absence, `_`, delimiter, percent/lookalikes, direct/list/page, and
value-verified conditional migration. This deferral is not a claim that those
repositories are safe today.

## Concerns

- Historical ambiguous runtime/event data requires the documented offline
  operator audit/migration; runtime code intentionally fails closed.
- Previously collided/dropped events are unrecoverable without an external
  authoritative source.
- One unrelated pre-existing Deno-format block remains in the touched PGlite
  test file; correction hunks and `git diff --check` are clean.
