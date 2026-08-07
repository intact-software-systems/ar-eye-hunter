# Revised REST Snapshot Read Convergence Plan

## Summary

Implement scalar client and two-component group point-read floors without using
stale state for authorization. Tokenless point reads observe durable state;
eligible tokened reads may use cache. Browser repair uses race-fenced physical
cleanup and explicitly does not claim tombstone or resurrection safety.

Deliver the work as three stacked PRs. Persisted client-key migration, durable
invalidation replay, projection tables, tombstones, and numeric latency SLOs
remain separate work.

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
- Add a two-process convergence recipe to `api-v1-black-box-cluster`; retain
  the existing medium-scale profile unchanged.
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

| Guarantee | Implementation owner | Required proof |
|---|---|---|
| Tokenless client reads are durable | PR1 selector; PR2 route | Selector durable-call count, client route test, two-process recipe |
| Tokened client reads never return below the scalar floor | PR1 client selector | Eligible hit, below-floor fallback, durable shortfall `409`, three-cache test |
| Group reads use the complete causal pair | PR1 group selector; PR2 parser | Equality/dominance success; domination/incomparability fallback or `409`; partial pair `400` |
| Strict authorization never trusts cache | PR2 client/group/graph routes | Strict self, member, banned/nonmember, graph/manage tests; one durable read assertion |
| Authoritative absence cannot delete a newer observation | PR1 conditional deletion; PR3 repair | Latest/loaned CAS-delete races, session-index tests, targeted/heartbeat/collection races |
| Physical deletion is not a tombstone | PR3 documentation/tests | Delayed stale publication may reinsert; no resurrection-safety assertion |
| Snapshot cache keys are injective in scope | PR1 snapshot repositories | Presence/value/delimiter/percent/round-trip/scope-isolation tests |
| REST contract is compatible and visible to browsers | PR2 routes/OpenAPI/CORS | Parser matrix, statuses, no-store, CORS, authoritative headers, Swagger tests |
| Browser API is additive | PR3 transport/public exports | Existing `findStateGroup` shape, new envelopes, malformed body/header rejection, API snapshots |
| Multi-process contract holds | PR2 runner/recipe | Warm A, mutate B, read A/B; cache source and body revisions agree; no result below floor |
| Diagnostics are usable and safe | PR1/PR3 sinks | Exact event names and bounded dimensions; no tenant/entity labels |
| Added durable I/O is bounded | PR1 selectors; PR2 benchmark | Cache hit = 0 durable reads; tokenless/miss/strict group = one full durable read |
| Publication evidence matches code | All PRs | Exact SHA/tree, focused tests, completion gates, medium-scale artifact, Branch Release Gate |

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
- Persisted client-key migration is separate remediation.
- Final-outbox collision-policy remediation remains separate.
- Causal tombstones, durable replay, projection tables, a third API process,
  collection-wide revisions, and numeric latency SLOs are deferred.
