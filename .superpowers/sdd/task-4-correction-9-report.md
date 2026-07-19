# Task 4 correction 9 report: canonical child keys and explicit write phases

> **Superseded by correction 10.** This report's claim that typed event/outbox
> collisions were nonretryable was incomplete: the errors had stable codes but
> no terminal HTTP status, so AppInbox still retried them. Correction 10 adds
> explicit 409 semantics and is the final acceptance record for these paths.

## Status and scope

Status: `DONE_WITH_CONCERNS`.

This correction closes every Important finding in the fresh review of
`551e283a..d9be44b2` from clean base
`d9be44b23eeedf284941170f0dc301d6b82742ae`. It does not start Task 5/6,
change progress tracking, add locks, add a migration/dual read, or push.
Correction 8 is explicitly superseded for final Task 4 acceptance.

The only concerns are inherited tooling facts: one untouched formatter block in
`pglite-sql-adapter.test.ts:228-239`, four workspaces without a root `lint`
script, and the existing configured two-file/seven-test shared-server skips.
All correction-owned format, lint, type, correctness, live PostgreSQL, and
black-box gates pass.

## Root causes and implementation

### Canonical full child keys

`decodeChildStorageKey` decoded suffixes but never reconstructed the complete
physical key. Percent aliases such as `%61lice` therefore reached repositories
as canonical `alice`. The decoder now accepts the authoritative full-key
builder and requires byte-for-byte equality for member, session, admission, and
request/idempotency keys. Existing repository corruption translation makes any
alias fail the entire direct/list/snapshot/page/admin read; it is never
normalized, missed, filtered, rewritten, or partially paginated.

### Exact idempotency boundary

`GroupStateRepository` previously checked only physical request/ref identity,
while the exact validator was private to mutation code. The pure domain module
now exports one deterministic
`validateGroupMutationIdempotencyRecord(...)` validator. It requires exact
top-level and `aggregateRef` keys, tagged lowercase SHA-256, complete compact
receipt shape, receipt/hash/command agreement, and event request/scope/snapshot
identity. Repository insert, direct read, and entry read call that exact
validator and then separately bind the trusted physical ref/request slot.
Malformed and legacy identity-free records fail with the existing typed
repository-corruption boundary.

### Group-event collision rollback

PostgreSQL group-event append used `ON CONFLICT DO NOTHING` and ignored the
result, allowing an accepted state/receipt/outbox transition to lose its event.
Append now executes one conditional insert with `RETURNING event_id`. Zero
returned rows throw `GroupStateEventCollisionError` with code
`group-state-event-collision`; exact and different-content duplicates both fail
and no existing event is read. Because append remains in the authoritative
transaction, the typed failure rolls back state, dependent writes, receipt,
outbox, and attempted event while preserving the original event.

### Visible phases and write-only transactions

Group, presence-summary, and client authoritative orchestration now uses direct
named statements: `const read = await readX(...)`, direct compute, direct
validate, and `const written = await writeX(...)`. Phase timing records surround
those statements without owning their work in callbacks; transaction timing is
separate. Central phase state records success/error without Promise `.then`
wrappers. Group replay still validates the ledger before clock/random/verifier
materialization, facts remain immutable over `[0,2,8]`/three attempts, and every
CAS retry re-reads, recomputes, revalidates, and reauthorizes.

`GroupPresenceSummaryWork` now has explicit `readGroupPresenceSummary`, existing
pure compute/validate calls, and `writeGroupPresenceSummary`; write alone opens
the transaction. The complete validated summary outbox record is built before
the first database write. Backoff, read, compute, validate, write, transaction,
and conflict timing are independently observable.

`StateMutationOutboxRepository.insertForAuthoritativeWrite(...)` validates the
initial exact record and performs one conditional insert. A collision throws
`StateMutationOutboxCollisionError` with code
`state-mutation-outbox-collision`, never loads a winner, and is non-retryable.
Group, summary, and client callers use it inside the same authoritative
transaction as their guarded state/receipt/event writes. `putOrLoad` remains
available only for explicitly non-authoritative Task 2B winner-loading paths;
no authoritative service calls it.

## Strict RED/GREEN evidence

Production behavior changed only after focused failure evidence:

- Child aliases: `group-state-concurrency.test.ts` RED 1 failed/59 passed when
  `%61lice` resolved; canonical full-key reconstruction GREEN 60/60. The final
  matrix covers member/session/admission/request direct and list reads,
  all-session reads, snapshot/list/page paths, and all accepted
  absence/`_`/`%5F`/delimiter/percent/lookalike values.
- Admin alias: a directly seeded scoped `%61lice`/`%73ession` row produced
  `Missing expected rejection`; restored canonical validation passed 1/1.
- Exact receipt: malformed SHA insert applied in RED (1 failed/60 passed).
  Exact insert/direct/entry validation passed 61/61 and rejects malformed SHA,
  empty receipt, extra top/ref fields, missing hash, receipt/hash mismatch,
  receipt command mismatch, and legacy identity-free no-event records.
- Event append: the old page test produced `Missing expected rejection` for
  duplicate IDs; typed collision passed 1/1. The PGlite service transaction
  test passed 1/1 and, with the throw temporarily suppressed, failed with
  `Missing expected rejection`, proving the rollback assertion observes the
  collision rather than unrelated setup.
- Insert-only outbox repository: RED was
  `insertForAuthoritativeWrite is not a function`; GREEN 1/1 proves identical
  collision throws the typed error, performs zero `findEntry` winner reads, and
  preserves one original row.
- Group/client/summary rollback: each RED received the old generic
  `conflicted without a winner` result from `putOrLoad`; after migration each
  focused test passed 1/1 with typed non-retryable collision. Group state,
  receipt, event, and outbox; client principal, receipt, event, and outbox; and
  summary plus outbox all remain unchanged. Each writer makes one guard
  attempt, records write/transaction error, emits no conflict/retry, and does
  not wake the drainer.
- Phase shape: source-integrity RED found `timeMutationPhase` callback wrappers
  and combined summary `plan`; GREEN 1/1 requires direct group/summary/client
  statements and no phase timing helper. Runtime group timing/replay and summary
  timing/retry tests passed 3/3; client timing/replay/collision passed 2/2.

Final focused command:

```text
npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts \
  packages/tests/shared-server/client-state-concurrency.test.ts \
  packages/tests/shared-server/state-mutation-outbox.test.ts \
  packages/tests/repo/rallar-skill-integrity.test.ts
4 files passed; 130 tests passed
```

## Writing-skills RED/GREEN evidence

The complete pressure workflow ran before repo guidance changed.

- Five fresh no-guidance samples were manually read. Three gave the required
  direct/insert-only answer. Two exposed the loophole: one explicitly retained
  callback-owned timing plus `putOrLoad`, calling callbacks “named phases” and
  winner loading necessary for convergence; another kept callback timing and
  `ON CONFLICT DO NOTHING`/winner loading as the smallest release hotfix.
- Minimal counter-guidance was added only to `AGENTS.md` and the four applicable
  repo skills: direct named read/compute/validate/write statements; timing
  before/after rather than callback-owned work; separate transaction timing;
  and an insert-only authoritative outbox call whose collision rolls back and
  never loads a winner.
- Five fresh guided samples all rejected timing-owned work and authoritative
  winner loading. They required typed rollback/no retry and found two real draft
  holes: Promise `.then` timing around direct reads and summary outbox planning
  inside the transaction. Both were corrected. A final guided sample rejected
  `timePhase('write', () => transaction(...))` and post-conflict winner reads
  even under release pressure.
- This edits existing guidance only. Skill names/frontmatter, examples,
  flowcharts, rationalization tables, red-flag sections, supporting files,
  contribution/push steps, and new skill creation are not applicable.
- Integrity/docs gate: 2 files passed; 11 tests passed.

## Verification evidence

All required correctness gates passed:

```text
Final post-report regression
57 files passed; 2 configured files skipped
559 tests passed; 7 configured tests skipped

Task 4 six-file focused command
6 files passed; 152 tests passed

npx vitest run packages/tests/api-v1/client-and-group-state-repositories.test.ts
1 file passed; 25 tests passed

npx vitest run packages/tests/shared-server
55 files passed; 2 configured files skipped
548 tests passed; 7 configured tests skipped

cd apps/api-v1 && deno task test
200 passed; 0 failed

npm run typecheck
root shared and every TypeScript workspace passed

npm run typecheck --workspace @ar-eye-hunter/shared-server
passed

cd apps/api-v1 && deno task check
passed

cd apps/api-v1 && deno task lint
Checked 76 files; passed

npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts \
  packages/tests/shared-web/rallar-group-docs-compat.test.ts
2 files passed; 11 tests passed
```

Affected PGlite/admin focused checks passed 1/1 each. Their final combined
post-report rerun passed 32/32: 16 PGlite plus 16 admin tests.

Live PostgreSQL initially failed all three tests solely because the sandbox
denied `127.0.0.1/::1:5432` with `EACCES`. The approved rerun passed:

```text
npm run test:postgres:presence-expiry
1 file passed; 3 tests passed
```

The memory black-box gate initially failed solely because the sandbox denied
the managed API local bind. The approved rerun passed:

```text
npm run test:api-v1:black-box:memory
11 profiles passed; 0 failed; 0 skipped
api-v1-group-presence: 17 successful steps
```

Static and hygiene evidence:

- `git diff --check`: passed.
- No-lock scan across every touched production path exited 1 with no matches for
  `pg_advisory|lock table|for update|for share|lockKey`, the expected clean
  result.
- Pure mutation scan exited 1 with no matches for direct clock/random/env,
  repository, transaction, or publisher dependencies.
- Authoritative-service scan found no `putOrLoad`, `timeMutationPhase`, or
  `timePhase`; the only state-mutation `putOrLoad` is the retained repository
  method, and the unrelated topology repository has its own method.
- Task 0B baseline remains exact at SHA-256
  `ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7`.
- Scoped `deno fmt --check` reports only the same untouched inherited block at
  `pglite-sql-adapter.test.ts:228-239`; the admin file and every correction-9
  hunk are formatter-clean.
- Exploratory root `npm run lint` exits nonzero only because
  `ar-eye-hunter-v1`, `rallar-black-box`, `rallar-black-box-headless`, and
  `relic-hunters-v1` have no `lint` script. Every workspace with a lint script
  passed, including shared-server/test/web/graph and relic-hunters; required API
  Deno lint passed independently.

## Compatibility and handoff

Public exports/import paths remain compatible except for the intentional new
exported pure validator and typed collision classes. Existing successful
outbox/event writes are unchanged; only collisions that previously became
silent success or winner-loaded success now fail closed and roll back. No
runtime migration is introduced. Follow-up is limited to the existing Task 5/6
plan and eventual cleanup of the inherited formatter/root-lint configuration;
neither belongs to this correction.
