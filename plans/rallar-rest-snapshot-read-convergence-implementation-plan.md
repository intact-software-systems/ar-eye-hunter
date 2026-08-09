# Revised REST Snapshot Read Convergence Plan

## Summary

Implement scalar client and two-component group point-read floors without using
stale state for authorization. Tokenless point reads observe durable state;
eligible tokened reads may use cache. Browser repair uses race-fenced physical
cleanup and explicitly does not claim tombstone or resurrection safety.

The original work shipped as three stacked PRs. Durable invalidation replay,
projection tables, tombstones, and numeric latency SLOs remain separate work.

## Status And Publication Record

The original implementation is merged:

- PR #86, Foundations: `ca224783ac410a8419a02c60d380d2ae63e58425`.
- PR #87, Server/API contract and proof:
  `e3cc3ab05f77f2de5d14bd7b5f53b7b8924fc10d`.
- PR #88, Browser convergence and documentation:
  `d607972b8edb960fe61aa0e0e8bc6ce11c1cfce5`.
- The resulting plan reconciliation commit is
  `a66b0b02e162b1027478a397fb1ebfe74e7a0a30`.

This record preserves historical final-tree outcomes rather than relabeling
them. On exact main `a66b0b02e162b1027478a397fb1ebfe74e7a0a30`, Deploy Web +
API run `31242298057` failed because two temporary auth-governance ratchets
failed and Cloudflare branch-control returned an external 404. Run Hetzner
Supported Distributed Manifests `31242298053` failed on a provider-parity RTC
readiness timeout while its other jobs succeeded. Neither outcome is called
transient, and this follow-up cannot retroactively make PR #87, PR #88, or
those historical gates green.

The follow-up changed only black-box topology, governance evidence, and active
guidance; it did not change the production REST contract. PR #94 published
feature SHA `ed3c75c1b948ff6f4c827d6adddc11d81277a452`, passed Branch Release
Gate `31257450232` and API v1 Medium-Scale Gate `31257452581`, and merged as
exact main `20020977507c3104949da07d27b95e89d3b91c96`. On that resulting main,
the required Release Gate job `93111803475` in Deploy Web + API run
`31258963298` attempt 2 passed and Run Hetzner Supported Distributed Manifests
`31258963308` passed. The parent Deploy Web + API workflow remained red only
because the separately owned Cloudflare branch-control job failed; issue #98
owns that provider account/API configuration work.

Issue #120 is addressed by open PR #124 as a direct repository correction:
client workspace identities are mandatory and nonempty, and semantic `_` uses
the canonical physical encoding `%5F`. Disposable development and test
client-state persistence is reset, not migrated. PR #124 remains unmerged; this
record makes no publication completion claim for that correction.

The local checkpoint also exposed a pre-existing PostgreSQL admin-prune defect:
postgres.js encoded the row-ID array as a JSON scalar, so deleting two expired
inbox results failed with PostgreSQL `22023`. PR #97 corrected all four
admin-prune page-deletion paths without changing the REST convergence contract.
It published feature SHA `a7219a7b0592f7c9796d72f5b190c10e18ef1387`,
passed Branch Release Gate `31262942800` and API v1 Medium-Scale Gate
`31262944466`, and merged as exact main
`1ec386f12735203daf928ca56e6b21d3b089c196`.

On that exact resulting main, required Release Gate job `93124715021` in Deploy
Web + API run `31266237752` passed root CI, deployable builds, Deno checks,
migrations, the three-server API v1 black-box recipes, artifact upload, and
Postgres full-stack smoke tests. The parent workflow conclusion is still red
only because Cloudflare branch-control job `93124714925` failed at its provider
API/configuration step; the application web build jobs passed and deployment
jobs were skipped. Run Hetzner Supported Distributed Manifests `31266237746`
passed all five supported manifests on the same exact SHA, including provider
parity without changing its readiness timeout or minimum-ready-peer
requirement.

This exact-main evidence closes the REST convergence implementation and the
three-server follow-up. It does not retroactively turn the historical PR #87,
PR #88, or `a66b0b02e162b1027478a397fb1ebfe74e7a0a30` gates green. This
plan-only record is the closure publication; its own future merge SHA and
resulting-main external evidence cannot be recorded before those events occur
and remain the publication envelope rather than a production implementation
blocker.

The completed local checkpoint recorded:

- Postgres standard profile: 11/11 standard recipes and 5/5 cluster recipes.
- Postgres CRDT profile: 1/1 recipe with 22 successes.
- Postgres medium-scale profile: 1/1 recipe with 2,748 successes and zero
  failures.
- Memory profile: 11/11 recipes.

The first local Postgres attempt failed before recipe proof because stale
persisted legacy auth rows exceeded the bounded 128-row compatibility scan and
a stale group lacked its required `slug`; it was not a three-process startup or
readiness failure. After explicit authorization to reset local test data, all
four checkpoint commands passed. The runner automatically clears prior
`fairness-proof.json` before every invocation, and regression coverage proves
that lifecycle.

The exact-main Hetzner artifacts for `31266237746` provide a current operational
baseline rather than a numeric SLO. Health and composite-evidence completed with
100% pass rates and command maxima of 363 ms and 603 ms. RTC smoke and provider
parity completed with 100% pass rates and command maxima of 7,293 ms and 7,838
ms. The five-second RTC stability run completed all 50 attempted stream
operations with zero failed, dropped, in-flight, or backpressure operations;
its maximum command duration was 12,531 ms and maximum stream drift was 5 ms.
Every manifest reported zero reconnects and no failed, missing, stale, or flaky
agents. Raw analyzer inventories retained 6 RTC-smoke, 11 provider-parity, and
7 stability diagnostic events, but the correlated SPA runtime reports had no
diagnostics or warning signals and no recipe failed. Those nonzero raw
inventories remain visible baseline evidence rather than being silently
discarded.

Residual work has explicit ownership:

- Issue #98 owns the external Cloudflare/Deno branch-deployment account and API
  configuration. No provider configuration is changed by this plan.
- Issue #99 preserves the historical provider-parity peer-discovery timeout for
  root-cause classification. Two later exact-main successes are clean current
  evidence, not proof that the historical failure was transient.
- Issue #100 tracks the deliberately deferred REST convergence hardening listed
  below.
- Issue #102 tracks repeatable isolation for the reused-database Postgres
  presence-expiry suite; it is separate from the fixed admin-prune defect.
- Issue #104 tracks migration away from deprecated Node.js 20 GitHub Action
  runtimes observed in the successful exact-main workflows.

## Public Contracts

- Client point query: optional `minStateRevision`, parsed as one canonical
  non-negative safe integer.
- Group point query: `minGroupRevision` and `minPresenceRevision`, either both
  absent or both present.
- Valid unsatisfied floors return typed
  `409 state-revision-floor-not-satisfied`; malformed floors return typed
  `400`.
- Successful client responses expose source and scalar revision; successful
  group responses expose source, group revision, and presence revision. Group
  scalar revision remains body-only compatibility data.
- Add metadata-bearing `readStateClientSnapshot` and
  `readStateGroupSnapshot` shared-web functions. Preserve
  `findStateGroup(): Promise<GroupSnapshot>` as a wrapper.
- Successful browser responses must pass authoritative body validation and
  header/body agreement before return.
- Add an optional low-cardinality browser state-read diagnostics sink. No
  application, workspace, principal, group, session, or request IDs may become
  metric labels.

## PR 1 — Foundations

Base `codex/rallar-rest-snapshot-foundations` on the freshly revalidated
default branch.

- Replace absent/empty aliases in client and group in-memory snapshot repository
  keys with a tagged typed projection. Do not modify persisted storage keys.
- Add identity-based conditional deletion to latest and loaned repositories;
  expose conditional client/group snapshot removal while preserving observers
  and the group session index.
- Add race-fenced `evictIfUnchanged` behavior to canonical client/group
  snapshot caches.
- Add separate feature-owned client-scalar and group-causal REST selectors
  under their canonical snapshot trees. Share transport/result contracts only;
  do not create a generic cross-feature service owner.
- Add client durable-current parity; preserve the existing group
  durable-current implementation.
- Add server diagnostic events for source, result, floor outcome, cleanup
  outcome, strict mode, and duration.
- Unit-test scalar eligibility, causal equality/dominance/domination/
  incomparability, presence freshness, not-found races, exact durable-read
  counts, and three logical caches over one durable fake.

## PR 2 — Server/API Contract and Proof

Base `codex/rallar-rest-snapshot-server-api` on PR 1.

- Add strict reusable floor parsers and wire the selectors through current
  client routes and canonical group read registration.
- Keep client self-auth durable and strict group authorization durable. Reuse
  the same durable group snapshot for floor validation, authorization, and
  response.
- Replace graph/topology cache-permitting authority reads with one durable
  current snapshot per request. Mutation prechecks remain advisory; AppInbox
  revalidates.
- Return `409` for authorized durable shortfall/incomparability. Ensure repeated
  `409`s do not affect the circuit breaker.
- Emit `Cache-Control: no-store` and authoritative source/revision headers.
  Expose the Rallar headers through CORS.
- Update OpenAPI for `400/401/403/404/409/429` and infrastructure `503`,
  keeping floor conflicts distinct from service unavailability.
- Extend black-box recipe schemas, normalized results, reports, redaction, and
  assertions with an allow-listed lowercase response-header map.
- Add a three-process convergence recipe to `api-v1-black-box-cluster`: warm
  A, mutate B, and verify client/group floors through C while retaining source
  and header/body revision assertions. Retain the existing medium-scale
  workload unchanged.
- Add `scripts/perf/api-v1-state-snapshot-read-bench.ts` with tokenless,
  eligible-cache, fallback, strict-auth, and concurrency scenarios. Record
  operation counts and p50/p95/p99 artifacts under `tmp/perf/`; set no numeric
  SLO.
- Add a path-scoped/manual **API v1 Medium-Scale Gate** workflow using the
  existing composite action and profile, with exact-SHA artifact upload.

## PR 3 — Browser Convergence and Documentation

Base `codex/rallar-rest-snapshot-browser` on PR 2.

- Extract focused point-response transport/validation code instead of enlarging
  `api-integration.ts`.
- Implement additive metadata-bearing point readers and preserve body-only
  compatibility wrappers.
- Change `rallar.rooms.room(ref).refresh()` to one tokenless durable group point
  read. Keep top-level rooms and people refresh on complete durable collections.
- Capture scoped observations before targeted, heartbeat, and collection
  requests. Conditionally remove only unchanged identities after authoritative
  `404` or complete successful omission.
- Do not reconcile after failed, aborted, malformed, or partial collection
  reads. Rethrow the original targeted `ApiHttpError` after conditional `404`
  cleanup.
- Preserve group causal monotonicity and existing incomparable recovery.
  Characterize delayed stale-publication reinsertion as allowed until tombstones
  exist.
- Emit browser refresh/reconciliation diagnostics through the optional sink.
- Update public API snapshots, browser bundle boundaries, feature READMEs, API
  reference, consistency guide, troubleshooting guidance, and only the affected
  skills.

## Verification and Traceability

| Guarantee                                                | Implementation owner                 | Required proof                                                                                                              |
| -------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Tokenless client reads are durable                       | PR1 selector; PR2 route              | Selector durable-call count, client route test, three-process recipe                                                        |
| Tokened client reads never return below the scalar floor | PR1 client selector                  | Eligible hit, below-floor fallback, durable shortfall `409`, three-cache test                                               |
| Group reads use the complete causal pair                 | PR1 group selector; PR2 parser       | Equality/dominance success; domination/incomparability fallback or `409`; partial pair `400`                                |
| Strict authorization never trusts cache                  | PR2 client/group/graph routes        | Strict self, member, banned/nonmember, graph/manage tests; one durable read assertion                                       |
| Authoritative absence cannot delete a newer observation  | PR1 conditional deletion; PR3 repair | Latest/loaned CAS-delete races, session-index tests, targeted/heartbeat/collection races                                    |
| Physical deletion is not a tombstone                     | PR3 documentation/tests              | Delayed stale publication may reinsert; no resurrection-safety assertion                                                    |
| Snapshot cache keys are injective in scope               | PR1 snapshot repositories            | Presence/value/delimiter/percent/round-trip/scope-isolation tests                                                           |
| REST contract is compatible and visible to browsers      | PR2 routes/OpenAPI/CORS              | Parser matrix, statuses, no-store, CORS, authoritative headers, Swagger tests                                               |
| Browser API is additive                                  | PR3 transport/public exports         | Existing `findStateGroup` shape, new envelopes, malformed body/header rejection, API snapshots                              |
| Multi-process contract holds                             | PR2 runner/recipe                    | Warm A, mutate B, verify client/group floors through C; cache source and header/body revisions agree; no result below floor |
| Diagnostics are usable and safe                          | PR1/PR3 sinks                        | Exact event names and bounded dimensions; no tenant/entity labels                                                           |
| Added durable I/O is bounded                             | PR1 selectors; PR2 benchmark         | Cache hit = 0 durable reads; tokenless/miss/strict group = one full durable read                                            |
| Publication evidence matches code                        | All PRs                              | Exact SHA/tree, focused tests, completion gates, medium-scale artifact, Branch Release Gate                                 |

Focused verification must use current paths, including:

- Snapshot repository/cache and three-logical-cache Vitest suites.
- `apps/api-v1/test/client-state/client-state-read-routes.test.ts`.
- `apps/api-v1/test/group-state/group-state-read-routes.test.ts`.
- Graph/topology, resilience middleware, Swagger, and new parser/contract Deno
  tests.
- Browser heartbeat, data-cache, room-session, rooms facade, public API
  snapshot, and bundle-boundary tests.
- Shared-test runner schema/report/redaction and API black-box runner tests.
- `npm run test:api-v1:black-box:memory`.
- `npm run test:api-v1:black-box:postgres`.
- Exact-SHA **API v1 Medium-Scale Gate**.
- `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`.
- `npm run test:repo-governance` after docs/skill routing changes.

For every stacked PR, record focused results, then run from its final tree:

- `npm run check:repo-style`
- `npm run test:unit`
- `npm run test:ci`
- `npm run build`
- `git diff --check`
- Branch Release Gate on the exact final PR SHA

Rebases invalidate prior evidence. Merge only in stack order. After each
separately authorized default-branch integration, record the resulting full SHA
and require Run Hetzner Supported Distributed Manifests for that SHA.

## Assumptions and Deferred Work

- Runtime REST scopes continue to require nonempty workspace IDs.
- Strict-read policy behavior and its default remain unchanged.
- Final-outbox collision-policy remediation remains separate.
- Causal tombstones, durable replay, projection tables, collection-wide
  revisions, and numeric latency SLOs are deferred.
