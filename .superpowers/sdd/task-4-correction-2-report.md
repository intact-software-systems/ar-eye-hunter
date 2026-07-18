# Task 4 second fresh-review correction report

## Scope

This correction reviews Task 4 after `f9b4afee` and remains limited to API-v1
group/member/presence mutation boundaries and their shared-server implementation.
It does not add topology-configuration behavior and does not introduce database
row, table, or advisory locks.

## Findings corrected

- API-v1 group mutations now carry the complete issued auth session only to the
  trusted enqueue boundary. The queued command contains a versioned HMAC proof
  bound to the trusted mutation descriptor, session identity, issue/expiry time,
  and stored access-token secret; the bearer token is never placed on the queue.
- Actor, creator, and presence identity fields are caller assertions rather than
  authority. They must agree with the stored authenticated session and are then
  replaced with the trusted principal/session. Direct service calls through an
  auth-enabled composition have the same check as REST/inbox calls.
- Auth is re-read before enqueue, after dequeue, and on every optimistic retry.
  Revocation, expiry, credential mismatch, and forged/replayed proof data deny
  the mutation. Completed-result lookup is also preceded by fresh authentication.
- Queue coalescing is causal and bounded: it hashes the request/session proof plus
  only the targeted entries already required by the mutation read. It performs no
  roster or presence scans. Identical concurrent commands against the same causal
  state coalesce, while a denied/no-op request is evaluated again after authority
  or aggregate state changes.
- All 14 non-presence REST mutation operations now run operation-specific runtime
  validation after trusted actor injection and before inbox enqueue. Presence
  operations retain their generation/lifecycle validator.
- Persisted mutation reads and computed outputs are validated as exact runtime
  contracts. Entry envelopes, parsed JSON/value correspondence, scope, revisions,
  timestamps, group/member/presence/admission/summary/idempotency fields, roles,
  statuses, causal tuples, guards, receipts, events, and outbox effects are checked
  before any conditional write.
- Heartbeats cannot derive an expiry earlier than their heartbeat timestamp, and
  an existing presence session cannot be reassigned to another principal.
- Repository fixtures now provide the mandatory `activeMemberCount` and
  `ownerPrincipalId` fields with a matching owner row, preserving the authoritative
  mandatory persisted group contract.
- The cached group-state wrapper now forwards authenticated authority through all
  user-facing mutations. This closed a production-only composition gap found by
  the managed memory black-box gate.
- Presence-summary convergence now emits only the explicit `GroupRef` scope fields.
  It no longer spreads a structurally wider `Group` object into persisted summary
  state. The strict validator remains unchanged and rejects unexpected fields.
- Timing instrumentation finds the request argument explicitly and therefore does
  not inspect or record the appended authority proof as mutation request details.

## TDD evidence

The correction began with failing focused tests before each production change:

- five authority-boundary assertions initially showed forged actor/creator and
  presence identities reaching the service, missing retry-time reauthentication,
  and unsafe queue authority behavior;
- a 14-operation REST table showed every malformed non-presence body reaching the
  inbox before boundary validation;
- heartbeat-expiry and cross-principal session-reassignment tests both mutated
  state before their lifecycle guards were added;
- malformed persisted-entry and computed-output tests were accepted before the
  exact contract validators were implemented;
- the final presence-summary regression received the full group shape, including
  `displayName`, `status`, version, ownership, and membership fields, instead of
  the exact summary shape. After the producer fix, the stored key set is exact.

The final authority suite proves forged identities are denied both through the
inbox and direct auth-enabled service, same-request commands are re-evaluated after
state/authority changes, revoked sessions cannot replay completed results, queued
proofs contain a MAC but no bearer token, revocation between enqueue and dequeue
denies execution, and concurrent identical commands coalesce to one queue/event.

## Final validation

```text
npx vitest run <8 focused group/repository/authority files>
6 selected projects/files reported; 111 tests passed

deno test --allow-env --allow-read \
  apps/api-v1/test/services/group-state-service.test.ts \
  apps/api-v1/test/routes/state-api-routes-hardening.test.ts
51 passed; 0 failed

npx vitest run packages/tests/shared-test/recipe-matrix.test.ts \
  packages/tests/shared-test/rallar-bb-test-schema.test.ts \
  packages/tests/shared-test/api-v1-black-box-run.test.ts
3 files passed; 71 tests passed

npm run test:postgres:presence-expiry
1 file passed; 2 tests passed

npm run test:api-v1:black-box:memory
11 profiles passed; 0 failed; 0 skipped

npm run typecheck
all workspace TypeScript checks passed

cd apps/api-v1 && deno task check
passed

deno lint <9 changed production TypeScript files>
passed

deno lint --rules-exclude=require-await <5 changed test files>
passed

git diff --check
passed
```

The test-only lint exclusion is the repository's established async-mock
convention. The PostgreSQL and managed-memory gates used approved localhost
access. No required validation was skipped.

The no-lock scan found no row/advisory/table lock or lock-key use in the changed
production paths. The deterministic mutation module still has no clock, random,
transaction, publisher, or environment access; its only repository text is a
type import. The performance baseline remains unchanged at SHA-256
`ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7`.
