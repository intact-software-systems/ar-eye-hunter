# Task 8 report: multi-process and API state-write convergence

## Scope and commits

- Base before acceptance work: `9ad88dee`.
- Production topology authority fix consumed by the acceptance gate:
  `459aba94` (`fix: preserve queued topology authority`), documented by
  `13835623`.
- Medium-scale contract-alignment prerequisite: `8dfd92c2`
  (`test: align medium-scale recipe with canonical state contracts`).
- Initial Task 8 acceptance commit: `5a35fe94`
  (`test: prove api state write convergence`).
- Review correction commit: `bdfd2d1f`
  (`test: close task 8 convergence acceptance gaps`).
- Expiry-event provenance assertion correction: `e211f0e4`
  (`test: bind expiry evidence to probe identity`).
- No production files were changed by the Task 8 acceptance or correction
  commits. Public exports and application import paths are unchanged.

## Review correction outcome

The correction closes each acceptance gap found in review:

- The live recipe now exercises the API servers' scheduled
  `expireExpiredPresenceSessions` path. It captures a current timestamp,
  connects an already-logically-expired generation and an independent expired
  probe, reconnects the reused session as generation 2 before maintenance, and
  waits 65 seconds for the real 60-second reconciliation interval.
- The capacity race has an explicit XOR assertion. The final live result is
  exactly `[200, 403]`, proving one successful contender and one forbidden
  contender.
- Durable topology config is read independently from both servers through
  `GET .../topology/config`. The final assertion compares those reads to the
  accepted version and config instead of copying a PUT receipt into both sides.
- All five topology polls record both `groupRevision` and `presenceRevision`.
  Both components are monotonic, and each secondary full tuple is compared to
  the corresponding primary full tuple.
- Independent worker-process coverage now includes client heartbeat plus group
  presence connect, heartbeat, and disconnect. Barrier traces prove distinct
  backend PIDs and one barrier wait per worker.
- Every applied compact worker receipt must contain one nonempty outbox ID.
  IDs are unique and are resolved through paginated canonical
  `StateMutationOutboxRepository.listPendingPage`, including pending delivery
  and expected effect validation.
- The topology worker race is seeded at version 1, deletes version 2, and
  rebases the competing PUT to exact version 3.
- Client, group, and topology workers reject absent, null, non-string, or blank
  request IDs before service dispatch or barrier wait. Compact receipts require
  the durable receipt request ID to equal the submitted request ID.
- The report-dependent Postgres gate now recomputes the expiry event request ID
  with production `groupStateMaintenanceRequestId`. Exact group, principal,
  probe session, generation, expiry timestamps, and maintenance time are bound
  to the sole expired disconnect event; the reused generation-1 identity is
  explicitly rejected as an alternative.

## TDD evidence

Review tests were written and observed red before worker or recipe changes:

- The recipe/schema suite failed on the absent capacity XOR assertion
  (1 failed, 23 passed).
- The client/group missing-request-ID test showed the heartbeat timestamp had
  already advanced before the old post-mutation receipt lookup rejected it.
- The topology missing-request-ID test resolved as an applied version-1 write
  with an outbox instead of rejecting before mutation.
- The first canonical outbox test exposed an unrelated malformed global outbox
  row in the shared `appdb`; all acceptance integration tests were therefore
  rerun on a newly migrated isolated database.
- The first live maintenance attempt rejected epoch-only expiry input because
  connection timestamps were inconsistent. A structural test first required
  all three causal timestamps.
- The next post-scenario gate remained red: epoch `1` also made physical purge
  time historical, allowing generic expired-row cleanup to delete the probe
  before group maintenance. A structural test then required a runtime timestamp
  capture so logical expiry is current while physical purge remains 24 hours in
  the future.

All of those focused tests are green in `bdfd2d1f`.

The provenance correction was also observed red before its one-field fix. The
expected helper-derived request ID used reused session
`746e9757-7dfd-4c5e-a230-e40ffcacc4e1`, while the canonical persisted event
request ID used expiry probe `5d98a086-6df1-4b55-b78c-e6dbb30dbcbf`. All other
semantic fields were identical. Changing the expected session to the probe
made the focused gate green, and a separate helper-derived request ID for the
reused generation-1 session remains unequal to the persisted event ID.

## Deterministic multi-process evidence

Fresh migrated database:
`rallar_task8_review_workers_20260721_0518`.

`DATABASE_URL=postgres://app:app@localhost:5432/rallar_task8_review_workers_20260721_0518 npm run test:postgres:presence-expiry`
passed 11/11 tests in 2.60 seconds. The suite proves:

- independent client heartbeat workers rebase to attempt counts `[1, 2]` and
  preserve the newer timestamp;
- independent client disconnect/reconnect workers preserve generation 2;
- independent group join/ban workers retain both accepted mutations;
- independent group presence connect, heartbeat, and disconnect workers use
  separate Postgres backend PIDs and produce canonical pending outboxes;
- exactly one contender wins the final bounded membership slot;
- 100 independent heartbeats advance without revising the group aggregate;
- missing client/group request IDs fail before mutation or barrier wait.

The full runtime-state command, with the final live report supplied, passed
15/15 tests after the provenance correction in 0.855 seconds:

```text
RALLAR_POSTGRES_INTEGRATION=1 \
DATABASE_URL=postgres://app:app@localhost:5432/rallar_task8_review_workers_20260721_0518 \
RALLAR_TASK8_REPORT_PATH=/private/tmp/ar-eye-hunter-convergent-db-writes/tmp/api-v1-black-box/postgres-task8-correction-final/cluster/api-v1-state-write-convergence/report.json \
deno run -A --unstable-temporal --node-modules-dir=none --no-lock \
  npm:vitest@4.1.10 run \
  --config packages/tests/shared-server/vitest.deno.config.mjs \
  packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts
```

The topology delete/PUT workers finish at exact generation/config version 3.
The rebased worker trace has attempts `[1, 2]`, one conflict, bounded retry, a
2 ms sleep outside the transaction, and distinct backend PIDs. Missing topology
request IDs fail before mutation or barrier wait.

The brief's literal focused command also passed: 3 non-Postgres tests passed and
12 environment-gated tests were skipped by the root Vitest configuration.

## Live two-server acceptance gate

Artifact:
`tmp/api-v1-black-box/postgres-task8-correction-final/cluster/api-v1-state-write-convergence/report.json`.

- Runner run ID: `bb-run-a4ddef54-def1-4d83-aded-9f69a50a71b3`.
- Result: 59/59 successful, 0 failed, 0 observed failures, 0 nonblocking
  failures, 74,290 ms.
- Capacity statuses: `[200, 403]`.
- Expired timestamp captured at runtime: `1784579145246`.
- Reused session `746e9757-7dfd-4c5e-a230-e40ffcacc4e1` remains active as
  `generation-2-task8-correction-20260721-0526` after maintenance.
- Expiry probe `5d98a086-6df1-4b55-b78c-e6dbb30dbcbf` is deleted by maintenance.
  The canonical Postgres group event store contains exactly one
  `session-disconnected` event with `reason: expired` for the scenario. Event
  `847c6e1e-f65a-4a73-9314-29c6a878eabe` occurred at `1784579169864` and has
  the exact scenario group ref plus a nonempty service actor.
- The event request ID exactly equals production
  `groupStateMaintenanceRequestId('expiry', semanticCommand)` for principal
  `alice`, the probe session, generation
  `expiry-probe-generation-1-task8-correction-20260721-0526`, generation and
  expiry timestamp `1784579145246`, and maintenance time `1784579169864`.
  Principal, session, and generation are carried by that canonical request ID,
  not separate fields in the current `GroupEvent` contract.
- The same production helper applied to reused session
  `746e9757-7dfd-4c5e-a230-e40ffcacc4e1` and
  `generation-1-task8-correction-20260721-0526` does not equal the persisted
  event request ID, so generation 1 of the reused session cannot be mistaken
  for the expiry probe.
- Post-expiry group tuple: `{ groupRevision: 4, presenceRevision: 3 }`.
- Final primary and secondary group tuples:
  `{ groupRevision: 7, presenceRevision: 3 }`.
- Final primary and secondary topology source tuples:
  `{ groupRevision: 7, presenceRevision: 3 }`.
- Both independently read durable configs are version 4 with the same final
  mesh config and final request ID.
- Both servers' group and topology histories are monotonic; all five topology
  full tuples are identical across servers.
- Final assertion: `isEqual: true`.

The report-dependent Postgres gate passed 1/1 and binds the actual live receipt
to durable delivery, and the same gate now binds the sole expiry event to the
exact expiry-probe identity described above:

- Outbox ID: `state-mutation-3eti3fu58wd6u`.
- Command/request ID:
  `put-final-config-bounded-convergence-task8-correction-20260721-0526-task8-correction-20260721-0526`.
- Command hash:
  `sha256:0aece007c7480fcdb4bbc68cdba404c12d470c9be1c0f8373e703cd0afcb542d`.
- Accepted durable version: 4.
- Stored aggregate ref exactly equals the live receipt group ref.
- Stored effects are exactly `["rtc-topology-recompute"]`.
- Delivery status is `delivered`, and the ID is absent from the canonical
  pending outbox page scan.

The recipe contains no explicit `/topology/reconfigure` call; topology converges
through committed state-mutation outbox delivery.

## Medium-scale gate preservation

The medium-scale recipe was not changed by the review correction. Its SHA-256
remains:
`0ca57037f6bcc98e9fb390074d8fd9cad13c02310cca18ac2a1d964c6873ade7`.

The earlier fresh-database run remains the acceptance evidence:

- runner `bb-run-272336ef-0001-43b5-aa8c-87b2376a3f2b`;
- 2,721/2,721 successful, with zero blocking, observed, or nonblocking
  failures;
- recipe duration 67,718 ms and matrix duration 82,862 ms;
- final config versions `[30, 30, 30, 30, 30]`;
- final group revisions `[132, 132, 132, 132, 132]`;
- final presence revisions `[147, 144, 146, 145, 138]`.

Task 0A baseline was runner
`bb-run-8d4ba6c1-3809-4200-8090-84bbb2a9469c`: 2,663/2,704 successful,
41 observed failures, recipe duration 67,194 ms, and matrix duration 79,284 ms.
The corrected medium gate removes all 41 failures. Recipe duration changes by
+524 ms (+0.78%); matrix duration changes by +3,578 ms (+4.51%).

## Static validation and known harness limitation

- Recipe/schema tests: 24/24 passed.
- Provenance-correction recipe/schema recheck: 23/23 passed across the recipe
  matrix and composite conformance suites; neither recipe nor schema changed.
- Strict scenario validation: `ok: true`, 59 generated operations, 35
  top-level operations, 14 parallel groups, no issues, and all secret outputs
  registered for redaction.
- `deno check` passed for the worker fixture and both changed Postgres test
  files. It also passed again for the provenance-corrected runtime-state test.
- `git diff --check` passed.
- No live two-server rerun was needed for the assertion-only correction. The
  existing 59/59 artifact and its still-queryable isolated Postgres database
  retained every field required to recompute and distinguish both canonical
  maintenance request IDs.
- `npm run check:repo-style` could not run on this branch because the referenced
  script and the two style-contract documents named by current `AGENTS.md` are
  absent from this Task 8 worktree baseline. The command failed with
  `Missing script: "check:repo-style"`; no style result is claimed.

The matrix wrapper still has a pre-existing live-preflight limitation: generic
probe IDs retain literal `{runId}`, which can cause timeout or idempotency
conflict. The exact scenario was therefore run directly against the same two
managed Postgres API servers with explicitly expanded application, workspace,
group, and run IDs. Fixing matrix preflight expansion remains follow-up work and
is outside Task 8.
