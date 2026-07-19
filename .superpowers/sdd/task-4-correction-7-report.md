# Task 4 seventh fresh-review correction report

## Scope

This correction closes the final fresh-review findings for Task 4 only:

- make the group-state runtime storage-key family injective for absent
  `workspaceId` versus the valid explicit identifier `_`; and
- make the always-populated join-code expiry mandatory in the shared successful
  response and OpenAPI contract.

It does not start Task 5, update `.superpowers/sdd/progress.md`, add a database
lock, or change group mutation concurrency and retry behavior.

## Findings corrected

### Injective scoped group-state keys

The previous helper used `encodeURIComponent(value ?? '_')`. Both an absent
workspace and the valid explicit value `_` therefore produced `ws=_` because
URI encoding leaves `_` unchanged. Distinct group, member, session, admission,
presence-summary, and idempotency rows could share one CAS namespace. Group
scope listings also inherited the same ambiguous generic scope encoding instead
of delegating to the group-state key helper.

The corrected projection keeps mandatory key parts separate from the optional
workspace part. It preserves the historical absent key `ws=_`, maps only a
present `_` to `ws=%5F`, and continues URI encoding all other present values.
Consequently a literal `%5F` identifier maps to `%255F`, while delimiter and
percent lookalikes remain distinct. Existing non-sentinel workspace keys and
all absent-workspace keys remain byte-for-byte compatible.

`GroupStateRepository` now delegates `listGroups`, `listSnapshots`, and
`listSnapshotsPage` prefixes to `groupStateScopeStorageKey`, so direct keys and
prefix scans cannot drift. Exact tests cover scope, group, member, session,
admission, summary, and idempotency helpers; absent/sentinel/delimiter/percent
lookalikes; memory repository reads and listings; and the real Postgres
repository boundary.

### Mandatory successful join-code expiry

Every successful join-code rotation already rejects a missing materialized
expiry and returns `expiresAtEpochMs`. `GroupJoinCodeResponse` now requires the
field in shared TypeScript. `GroupJoinCodeMutationWritten` inherits that
contract. The OpenAPI `GroupJoinCodeResponse.required` array now contains
`joinCode`, `expiresAtEpochMs`, and `snapshot`; its JSON route has a schema
assertion. `RotateGroupJoinCodeRequest.expiresAtEpochMs` remains optional because
request omission intentionally asks the server to materialize a default.

## Compatibility and migration truth

This change deliberately does not rename every group-state namespace:

- absent workspace continues using `ws=_`;
- every established explicit workspace other than `_` keeps its old key; and
- new explicit `_` data uses `ws=%5F`.

Rows historically written for explicit `_` under `ws=_` are intrinsically
ambiguous by key. Earlier overwrites cannot be reconstructed. New explicit `_`
reads do not fall back to the legacy key, because a generic fallback would let
one row cross scopes and idempotency receipts do not always contain enough
domain identity to disambiguate them. Until an operator audit completes, an old
explicit-`_` row remains at the namespace now reserved for absent workspace and
will not be returned by a new explicit-`_` lookup.

An offline migration may move only a row whose decoded domain value proves
`workspaceId: "_"`. It must claim the `ws=%5F` destination conditionally and
delete the source by expected revision. A destination conflict or missing scope
evidence fails closed; no ambiguous row may be copied to both namespaces. Some
no-event idempotency receipts must be expired or resolved manually. There is no
runtime dual-read or automatic fan-out.

## Guidance pressure evidence

The writing-skills RED pressure run used the previous `AGENTS.md` and repo
skills. It found that a time-pressured agent could plausibly add only the
one-line `_` escape, one unit test, and the response type change. Existing
guidance did not require injectivity over field/type-or-presence/value, warn
that escaping leaves sentinel-looking values unchanged, require a complete
helper/prefix/repository matrix, define fail-closed migration, or inventory all
successful-response contract layers.

After editing `AGENTS.md`, `rallar-platform`, `rallar-realtime`,
`rallar-code-writing`, and `rallar-testing`, the same pressure scenario was
GREEN. The agent required:

- injectivity over field name, presence/type, and value rather than escaping
  alone;
- sentinel, delimiter, percent/lookalike, every derived helper, prefix/list,
  memory repository, and live Postgres proofs;
- value-verified conditional migration with no guessing, fan-out, or permanent
  dual reads; and
- shared TypeScript, derived response, OpenAPI, serializer, consumer, and
  schema/type compatibility agreement for always-populated successful fields.

The sixth correction report now has a prominent supersession note. The active
convergent architecture guide and server repository docs describe the key
contract and the unavoidable legacy migration boundary.

## TDD evidence

Tests were changed before production code.

```text
npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts
2 failed; 50 passed
```

The exact failures proved that explicit `_` still produced
`app=app%2Fone:ws=_` instead of `app=app%2Fone:ws=%5F`, and that writing the
explicit-sentinel group overwrote the absent-workspace group at the repository
boundary. After the minimal encoder change, one test remained RED because
`GroupStateRepository.listGroups(...)` still used the inherited ambiguous scope
prefix. Delegating all group scope-list paths to the canonical helper made the
focused suite GREEN at 52/52.

```text
cd apps/api-v1 &&
  deno test --allow-env --allow-read test/swagger-routes.test.ts
1 failed; 11 passed
```

The failure showed `GroupJoinCodeResponse.required` was `[joinCode, snapshot]`.
After the contract change, Swagger passed 12/12. The shared test also contains
an `expectTypeOf` assertion that the expiry is `number`, not
`number | undefined`; all root/workspace TypeScript checks pass.

Final focused guidance/domain checkpoint:

```text
npx vitest run <6 focused Task 4 group/inbox/cache/publish files> \
  packages/tests/repo/rallar-skill-integrity.test.ts \
  packages/tests/shared-web/rallar-group-docs-compat.test.ts
8 files passed; 121 tests passed
```

## Full validation

```text
npx vitest run packages/tests/shared-server
55 files passed; 2 configured files skipped
534 tests passed; 7 configured tests skipped

npx vitest run packages/tests/api-v1/client-and-group-state-repositories.test.ts
1 file passed; 25 tests passed

deno test -A apps/api-v1/test/services/group-state-service.test.ts
31 passed; 0 failed

cd apps/api-v1 && deno task test
191 passed; 0 failed

npm run typecheck
all root and workspace TypeScript checks passed

cd apps/api-v1 && deno task check
passed

cd apps/api-v1 && deno task lint
76 files checked

cd apps/api-v1 && deno fmt --check test/swagger-routes.test.ts
1 file checked

npm run test:postgres:presence-expiry
1 file passed; 3 tests passed

npm run test:api-v1:black-box:memory
11 profiles passed; 0 failed; 0 skipped
group-presence profile: 17 successful steps

git diff --check
passed
```

The first live PostgreSQL run received sandbox `EACCES` for localhost:5432; the
approved reruns passed, including the new absent-versus-explicit-sentinel
Postgres repository/list isolation test. The first memory black-box run received
a sandbox bind denial; its approved rerun passed all profiles. No live gate was
skipped.

The full API-v1 `deno fmt --check` still reports the same 13 existing unformatted
files out of 101. Neither changed API file is in that list, and the changed
Swagger test passes its focused formatter check. An exploratory Deno formatter
check including the existing shared-server Postgres integration file would
rewrite that entire established double-quote file; the new test matches its
local style, no bulk reformat was applied, and `git diff --check` is clean.

Static scans found no row, table, or advisory lock primitive in the changed
production paths and no clock, random, environment, runtime repository,
publisher, or transaction dependency in the pure group mutation module. The
performance baseline is unchanged at SHA-256
`ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7`.

## Residual risk and handoff

The unavoidable residual is historical explicit-`_` data in the ambiguous old
namespace. Deployment owners must audit it before relying on absent workspace
and explicit `_` simultaneously; the runtime intentionally does not guess.

No follow-up is required inside Task 4 after fresh review accepts this
correction. Task 5 remains outside this commit.
