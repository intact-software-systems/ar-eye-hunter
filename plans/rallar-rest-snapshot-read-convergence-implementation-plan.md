# Rallar REST Snapshot Read Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Also use the repo-local `rallar-platform`, `rallar-realtime`, `rallar-code-writing`, and `rallar-testing` skills for every task that touches their surfaces. Do not begin implementation until the human review gate in Task 0 is approved.

**Goal:** Give client and group point-snapshot reads an explicit, testable convergence contract: a request without `minStateRevision` reads durable database state, a request with `minStateRevision` may use an eligible process cache only when it is at least that revision, and the Rallar browser periodically omits the token so normal use converges through authoritative reads even if distributed cache observation is delayed or missed.

**Architecture:** Keep `runtime_state_store` as the current durable source while separating four concerns that are presently easy to conflate: snapshot assembly, monotonic observation, freshness, and authorization. Add one shared REST snapshot-read service used symmetrically by client and group cached services. Point reads without a token go directly to the durable repository and then observe the result into the process cache. Point reads with a token may return a presence-eligible cache entry whose entity-local `stateRevision` is greater than or equal to the requested minimum; otherwise they read durable state, observe it, and either return a qualifying snapshot or a typed retryable error. Collection and presence routes remain durable because one scalar token cannot describe several independently revisioned entities. Strict group authorization always evaluates current durable group policy, even when a caller supplies a minimum revision. In the browser, scoped point-read counters use the latest locally observed revision on ordinary reads and force a successful tokenless read every fifth through tenth point read; top-level collection refreshes are already tokenless durable reads.

**Tech Stack:** TypeScript, Deno, Node/npm workspaces, Hono, Vitest, PostgreSQL, PGlite, OpenAPI YAML, Rallar browser facades, runtime-state repositories, Rallar black-box recipes, GitHub Actions.

## Global Constraints

- This plan is a reviewed implementation proposal. Only this plan file is created before approval; application, package, documentation, skill, test, and CI changes start after Task 0 is approved.
- Preserve the current public meaning of `stateRevision`: it is a monotonic storage observation for one scoped client or group snapshot, not a workspace-global sequence and not interchangeable with `snapshotVersion`, `presenceVersion`, or topology `version`.
- Apply `minStateRevision` only to the two point snapshot endpoints:
  - `GET /api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId`
  - `GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId`
- Do not put one `minStateRevision` on collection routes. A list contains independently revisioned entities, so one scalar cannot express a minimum for the whole result without inventing a new workspace revision domain.
- `minStateRevision` means “do not return a snapshot older than this entity-local revision.” It does not mean “return the newest snapshot,” “wait forever,” or “the cache is globally current.”
- Accept only a decimal, non-negative JavaScript safe integer. Reject empty, repeated, signed, fractional, exponential, `NaN`, infinite, negative, or greater-than-`Number.MAX_SAFE_INTEGER` values with HTTP `400` and code `invalid-min-state-revision`.
- A tokenless point read always invokes the durable snapshot repository. It may not be satisfied by a TTL cache or a durable-revision head probe followed by cache lookup.
- A tokened point read may return a cache snapshot only when the existing client/group presence-freshness predicate accepts it and its `stateRevision >= minStateRevision`.
- If no eligible cache entry exists, read durable state. Return `404` when the entity does not exist. If durable state exists but is still below the requested minimum, return HTTP `503`, code `state-snapshot-minimum-revision-unavailable`, and `Retry-After: 1`; never return a snapshot below the requested minimum.
- If a tokenless durable read is below a newer locally observed cache revision, fail closed with HTTP `503`, code `state-snapshot-authoritative-regression`; do not regress the caller or overwrite the process cache. This should be impossible when the repository reads the authoritative primary and is therefore an operational signal for replica lag, scope confusion, or a persistence defect.
- Equal `stateRevision` with different content remains an invariant conflict. Preserve `StateSnapshotRevisionConflictError`; do not hide or merge it.
- Server cache observation and browser cache observation stay monotonic: insert or advance newer data, ignore older data, accept exact duplicates, and reject equal-revision/different-content conflicts.
- Presence freshness is not completeness. A snapshot with no active sessions can pass the time-based predicate while a new session exists elsewhere. The revision token and periodic durable read provide convergence; do not describe the predicate as proof that no session is missing.
- Strict authorization, capacity, lifecycle, ownership, and governance decisions never use a caller's stale-tolerant read preference. In particular, group policy is evaluated from a durable current snapshot. A `minStateRevision` cache hit is a presentation/read optimization, not authority.
- When strict group authorization already required a durable group snapshot, return that durable snapshot instead of doing a second cache lookup. This intentionally favors security and avoids wasting the database read.
- Mutation result hydration introduced by the current API-v1 fix remains as a latency optimization. Correctness must no longer depend on the receiving node, another node, or every future Node C observing that result.
- Browser authoritative probes are request-count based, not timer based: after a successful authoritative point read, choose an inclusive interval from 5 through 10; perform ordinary tokened reads until the chosen interval's next probe slot, then omit the query parameter. Transport failures, `5xx`, authorization failures, and invalid requests do not advance or reset the successful-read counter. An authoritative tokenless `404` is the one exception: it is a successful observation of absence, so it evicts the scoped entry and resets the cadence before the browser rethrows the HTTP error.
- Keep browser probe state per fully scoped entity key: entity kind, `applicationId`, `workspaceId`, and `principalId` or `groupId`. Never share a counter between workspaces or entities.
- Top-level `rallar.rooms.refresh()` and `rallar.people.refresh()` continue to use collection routes and therefore always read durable state. The new 5–10 call cadence applies initially to `rallar.rooms.room(ref).refresh()`. Low-level point snapshot functions expose `minStateRevision` but remain stateless; callers that want automatic cadence must own or reuse a `StateSnapshotReadProbePolicy` instead of relying on hidden module-global state.
- An authoritative caller can always omit `minStateRevision` explicitly. Do not add a second query flag such as `force`, `fresh`, `bypassCache`, or `authoritative` to the REST API.
- Add `Cache-Control: private, no-store`, `Rallar-State-Source: durable|cache`, and `Rallar-State-Revision: <integer>` to successful point snapshot responses. The source header is diagnostic and testable; it must describe the actual selected response.
- Expose `Rallar-State-Source`, `Rallar-State-Revision`, `Retry-After`, and `Server-Timing` through API-v1 CORS. Do not expose authorization credentials or cache keys.
- Record read-source, requested minimum, returned revision, fallback reason, entity kind, scope, and duration through `RallarTimingSink`. Timing failures must never affect the read.
- Coordinate with `plans/api-v1-convergent-database-writing-remediation-plan.md`. This plan does not introduce dedicated `client_latest_snapshot` or `group_latest_snapshot` tables, split group/presence causal revisions, or a durable mutation outbox ahead of that plan.
- Preserve existing public exports and import paths. Public browser additions are additive.
- Follow TDD for each behavior: add one focused failing test, run it and confirm the expected failure, implement the smallest passing behavior, then run the focused regression set.
- Preserve unrelated working-tree changes. Stage only files named by the active task.
- Keep generated black-box artifacts under `.artifacts/` and disposable performance or diagnostic output under `tmp/`; do not commit them.

---

## Current-State Findings And Bug Classification

| ID | Current evidence | Finding | Plan outcome |
| --- | --- | --- | --- |
| READ-01 | `ClientStateSnapshotReadThroughCache.findOrLoadByRef(...)` and `GroupStateSnapshotReadThroughCache.findOrLoadByRef(...)` already accept `minStateRevision`. | The internal cache primitive can enforce an at-least revision, but REST does not expose the contract and an omitted minimum currently permits a warm cache. | Add a REST-specific read path instead of changing all internal read-through semantics. |
| READ-02 | `CachedGroupStateService.readCurrentSnapshot(...)` reads the durable group revision and then asks the cache for at least that revision. | It prevents a known stale group cache but still performs a database read on every call, and it does not satisfy the requested tokenless “read the full durable snapshot” rule. | Keep it for internal authorization compatibility, but make tokenless REST reads call `durable.readSnapshot(...)` directly. |
| READ-03 | `CachedClientStateService.readSnapshot(...)` uses cache read-through and has no `readCurrentSnapshot` parity method. | Client and group REST behavior is asymmetric. | Add the same REST snapshot-read method to both cached services. |
| READ-04 | Group cache presence freshness validates only sessions already present in the snapshot. | Empty or incomplete session lists can appear fresh because the cache cannot know that a new remote session is missing. | State this limit explicitly; use revision floors plus periodic durable probes for anti-entropy. |
| READ-05 | The failing API-v1 cluster run returned a successful remote mutation revision, then the receiving node's immediate cached GET returned an older revision. | This was a real contract bug if the system promises monotonic/read-your-write behavior. Calling it eventual consistency does not make returning below an acknowledged revision safe. | Keep mutation-result hydration, add an explicit at-least token, and make tokenless reads durable so correctness does not depend on hydration. |
| READ-06 | The merged route hardening test proves receiving-node hydration. | Hydration fixes Node A after a mutation processed elsewhere, but does not prove an unrelated Node C observed the mutation. | Reclassify this as an optimization test and add three-logical-node plus multi-process convergence tests. |
| READ-07 | `runtime_state_store` stores group aggregate, members, and presence sessions under separate namespaces and assembles a snapshot with an aggregate-before/children/aggregate-after stable-read loop. | A group snapshot is a self-consistent observation of several rows, not a single physical snapshot row and not guaranteed to remain latest after it is assembled. | Document the snapshot mental model and keep stable assembly as the durable read primitive. |
| READ-08 | Browser repositories already decide `inserted`, `advanced`, `duplicate`, or `stale` by `stateRevision`. | The browser has the monotonic observation half of convergence but no explicit periodic REST anti-entropy policy. | Add a reusable scoped probe-cadence controller and wire point room refresh through it. |
| READ-09 | State-sync WS and PostgreSQL wakeups improve delivery but are not a lossless, cursor-replayed invalidation stream for every snapshot cache. | Cache warmth is opportunistic. Missed publication or a newly started process can remain behind until TTL/read-through activity. | Treat durable reads as the correctness backstop; retain durable invalidation/replay as a follow-up proposal. |
| READ-10 | `apps/api-v1/resources/api-v1-openapi.yaml` omits required `stateRevision` properties from `ClientSnapshot` and `GroupSnapshot`. | Swagger cannot explain or exercise the new causal read contract correctly until the schemas are aligned. | Add the query parameter, response/error/header contracts, and required snapshot fields in the same API change. |
| READ-11 | Group point reads authorize against the snapshot selected for the response. | If the selected snapshot is intentionally stale, a later ban/removal could be missed. | Read strict auth context first and force a durable group snapshot whenever group policy is evaluated. |
| READ-12 | `rallar.rooms.room(ref).refresh()` currently delegates to the full collection refresh. | A scoped session refresh cannot benefit from a point-read token and needlessly reads every group/client snapshot. | Change only the room-session refresh to the point group route; keep top-level collection refresh authoritative. |

### Current runtime-state key and update map

All rows use `(store_namespace, store_key)` as the physical primary key. `RuntimeStateJsonStore` builds keys as encoded segments such as `app=<applicationId>:ws=<workspaceId>`. A missing workspace is currently encoded from `_`, which is why the target key proposal requires a mandatory typed workspace instead of preserving that sentinel.

There is no physical `group_snapshot` table in the current design. `GroupSnapshot` is assembled on read from mutable latest-value rows in the three `group-state:*` namespaces. `group_state_events` is the separate append-oriented history; it is not the source returned by the normal snapshot GET.

| Namespace | Key suffix after scope | Updated today when |
| --- | --- | --- |
| `client-state:principals` | `principal=<principalId>` | Principal/profile changes and client instance/session lifecycle changes touch the principal snapshot/presence versions and last-seen state. Its storage revision is the current client snapshot `stateRevision`. |
| `client-state:instances` | `principal=<principalId>:instance=<clientInstanceId>` | An instance is registered, updated, revoked, or retired. |
| `client-state:sessions` | `principal=<principalId>:instance=<clientInstanceId>:session=<sessionId>` | A client session connects, heartbeats, disconnects, or expires. |
| `client-state:idempotent` | principal key plus `request=<requestId>` | A client mutation result is recorded for idempotency. |
| `group-state:groups` | `group=<groupId>` | Group metadata/lifecycle, membership/governance, and currently presence connect/heartbeat/disconnect paths touch the group aggregate. Its storage revision is the current group snapshot `stateRevision`. |
| `group-state:members` | group key plus `member=<principalId>` | A member is invited, joins, leaves, is removed/banned/unbanned, or changes role/ownership state. |
| `group-state:sessions` | group key plus `session=<sessionId>` | A group presence session connects, heartbeats, disconnects, or expires. |
| `group-state:idempotent` | group key plus `request=<requestId>` | A group mutation result is recorded for idempotency. |
| `group-state:join-code-idempotent` | group key plus `request=<requestId>` | A join-code mutation result is recorded separately. |

The catch in “always update `group_latest_snapshot`” is visible here: today every group presence heartbeat advances the shared group aggregate revision. Replacing the assembled read with one projection row would make reads cheaper, but synchronously rewriting one large row on every heartbeat would concentrate contention and JSON write amplification. The companion plan's independent presence generation plus coalesced summary/outbox is the prerequisite that makes a latest projection safe to evaluate.

### Is the API-v1 failure a bug or eventual consistency?

It is both a distributed-consistency symptom and a real API bug under the behavior the client needed. The mutation response acknowledged a committed revision. An immediate later GET returned a lower revision because the node answered from a stale local cache. Eventual consistency explains how that state arose; it does not define whether the API is allowed to expose it.

After this plan:

- A GET without `minStateRevision` must read durable state, so the old failure is a correctness failure.
- A GET with the committed mutation revision must never return below it, so the old failure is also a correctness failure.
- A GET with an older minimum may legally return a stale cache snapshot at or above that minimum. That outcome is intentional eventual consistency.
- Mutation receiver hydration still reduces the chance of a database fallback, but a third Node C can be cold or stale without violating correctness: it must use the database when its cache cannot satisfy the caller's minimum, and tokenless probes eventually bypass it.

---

## Snapshot Mental Model

Use four separate questions when reasoning about a snapshot:

1. **Internal consistency:** Were the aggregate and child rows assembled without a detected concurrent aggregate change? `readStableStateSnapshot(...)` answers this for the current storage model.
2. **Causal monotonicity:** Is this observation at least as new as the entity revision already known by the caller? `minStateRevision` and monotonic cache observation answer this.
3. **Freshness:** Could a newer committed mutation exist even though this snapshot is internally consistent and monotonic for the caller? Yes, unless this request performed a durable authoritative read at the relevant commit boundary.
4. **Authority:** Is this data safe for authorization, capacity, ownership, lifecycle, or governance decisions? Only current durable policy state is authoritative.

### Client snapshot

- Identity is `(applicationId, workspaceId, principalId)`.
- `ClientSnapshot.stateRevision` is local to that client aggregate.
- `principal.snapshotVersion` is a domain snapshot version; `presenceVersion` is a domain presence counter. Neither replaces `stateRevision` for cache monotonicity.
- Sessions are leased. A snapshot can become presentation-stale as `expiresAtEpochMs` passes even without another stored revision.

### Group snapshot

- Identity is `(applicationId, workspaceId, groupId)`.
- Today `GroupSnapshot.stateRevision` is derived from the `group-state:groups` aggregate row while members and sessions live under `group-state:members` and `group-state:sessions`.
- The repository reads aggregate, children, aggregate and retries if the aggregate revision changed. The result is a stable observation, not a promise that no commit occurs immediately afterward.
- Today routine presence updates touch the shared group row. The companion database-write plan proposes separating group and presence causal components; this read plan must not pre-empt that coordinated contract migration.

### Topology snapshot/publication

- Topology `version` belongs to the topology output stream.
- `sourceGroupStateRevision` identifies the group observation used as topology input.
- A topology payload can be newer in topology version while based on a different group causal input; consumers compare the documented causal fields, not timestamps or arrival order.
- When the companion plan introduces `{ groupRevision, presenceRevision }`, this REST plan must be amended atomically rather than treating one scalar as sufficient.

### “Latest” wording

- **Latest observed:** highest revision currently in one process or browser cache.
- **At least revision N:** snapshot revision is `>= N`; a newer commit may still exist.
- **Authoritative read:** full durable snapshot read at the database boundary used by API-v1.
- **Globally latest at response receipt:** not promised, because a new commit can occur after the database read and before the client receives the response.

---

## Proposal Review Register

### P1 — Tokenless durable reads plus tokened at-least cache reads

**Status:** Selected for implementation.

**Contract:** Omit `minStateRevision` to read durable state. Supply it to permit an eligible cache result at or above the caller's floor; fall back to durable state otherwise.

**Why selected:** It is simple for clients, gives read-your-revision behavior without pretending that cache invalidation is perfect, and provides a deterministic escape hatch from all process-cache states. It reuses current monotonic repositories and existing `stateRevision` fields.

**Cost:** Tokenless traffic reaches the database. Tokened reads can remain stale above the caller's floor. A strict group read remains durable because authorization overrides the cache optimization.

### P2 — Durable revision-head probe on every read

**Status:** Rejected as the default; retain only where an internal caller explicitly needs it.

**Shape:** Read a narrow durable revision first, then return cache only if the cache is at least that revision.

**Benefit:** Transfers fewer bytes than a full durable snapshot when the cache is current and prevents returning behind the durable head.

**Catch:** It still performs a database round trip for every read, adds a second cache/database decision path, and requires the head to represent every snapshot component correctly. With future split group/presence revisions, one scalar head becomes insufficient. For strict group authorization, the server needs current policy data, not only a revision number.

### P3 — Dedicated `client_latest_snapshot` and `group_latest_snapshot` projection tables

**Status:** Deferred to the companion database-write architecture review.

**Shape:** Maintain one latest projection row per scoped client/group, plus append-only event/snapshot history, and evict projections by last-seen/retention policy.

**Benefit:** One indexed row read can be extremely fast and avoids multi-row assembly on the hot read path.

**Catch:** The projection becomes another authoritative write target. It must be committed atomically with domain state or populated by an outbox with explicit lag semantics; otherwise it simply relocates the stale-cache problem into a table. Group presence heartbeats can create heavy contention and write amplification if every heartbeat rewrites a large JSON snapshot. Deletes, bans, expiry, tombstones, and split group/presence revisions require careful causal handling.

**Review dependency:** `plans/api-v1-convergent-database-writing-remediation-plan.md` already proposes CAS writes, mutation outboxes, independent presence generations, and a future group/presence causal tuple. Decide the projection table only after measuring that target write path.

**Key/update organization to carry into that review:**

- Use mandatory typed scope tuples `(applicationId, workspaceId, entityId)` at repository boundaries. Do not keep `_` as an implicit missing-workspace sentinel and do not depend on delimiter-concatenated strings that can collide with user ids; encode tuples canonically at the storage adapter.
- Keep aggregate metadata/policy, membership, presence leases, idempotency receipts, and publication intents in distinct causal/write domains. A convenient read projection must not make every heartbeat rewrite the policy/roster aggregate.
- Give membership rows keys `(groupRef, principalId)` and presence rows keys `(groupRef, sessionId, generation)` with explicit expected revisions. Give client instances/sessions the equivalent principal-scoped keys.
- Put `lastSeenAt`, `expiresAt`, deletion/tombstone state, and projection update time in indexed database columns when they drive eviction or scans. Do not parse JSON keys or values to find expiry candidates.
- If a latest projection is adopted, identify it by the same canonical scoped ref, include its causal input revision(s), and update it atomically with the authoritative mutation or from an idempotent mutation-outbox cursor. Never update it as an untracked best-effort side effect.
- Keep append-only event/history keys separate from latest projections. A replay/history id is not the cache key and a cache revision is not an event cursor.

### P4 — Durable invalidation/replay stream for server caches

**Status:** Recommended follow-up; not required for P1 correctness.

**Shape:** Write snapshot-change intents atomically with mutations, assign a durable ordered cursor per scope or entity partition, let every API process replay from its stored cursor, and perform periodic anti-entropy scans for gaps.

**Benefit:** Keeps Node A/B/C caches warm with bounded measurable lag, supports restart catch-up, and reduces durable fallback traffic.

**Catch:** Requires cursor ownership, retention, compaction, tombstones, idempotent replay, poison-event handling, and observability. PostgreSQL notifications alone are wakeups, not the durable source.

**Plan link:** Implement with the transaction-local mutation outbox from the companion database-write plan; do not create a second publication truth in this plan.

### P5 — Browser periodic authoritative probes

**Status:** Selected for implementation.

**Shape:** Normal scoped point reads carry the browser's latest observed `stateRevision`. Every fifth through tenth successful point read omits it. The interval is sampled per entity after each successful authoritative read and is injectable in tests.

**Benefit:** Provides bounded request-count anti-entropy even if the browser keeps presenting data that satisfies its old minimum and no invalidation reaches it.

**Catch:** It converges only while the application performs reads. It is not a background liveness guarantee and should not create hidden timers or traffic.

### P6 — Structured causal revision for groups

**Status:** Future coordinated migration, not part of this implementation.

**Shape:** Replace one group state floor with `{ groupRevision, presenceRevision }` and componentwise comparison. Incomparable tuples require reread/rebase, not numeric max.

**Benefit:** Stops routine presence churn from serializing through the group aggregate and accurately expresses roster/policy versus presence causality.

**Catch:** It is a breaking contract across persistence, REST, OpenAPI, WS publications, topology, browser caches, and tests. Implement atomically under the companion database-write plan.

### P7 — Tombstones and negative-cache convergence

**Status:** Required by the durable invalidation/projection follow-up; limited handling in this plan.

**Shape:** A deleted entity has a causal tombstone revision so stale positive cache entries cannot resurrect it.

**Current-plan handling:** Tokenless reads return durable `404` and evict the server's positive cache entry. A browser room-session probe that receives that authoritative `404` removes the corresponding scoped browser snapshot before returning the error to the caller. Tokened reads whose cache still holds an eligible positive entry may return it only where authorization permits; periodic tokenless probes remove it. Strict group policy never authorizes from that stale entry.

### P8 — Convergence observability and service-level targets

**Status:** Selected for implementation.

**Signals:** Count/cache-source and durable-source reads, fallback reasons, requested/returned revisions, revision shortfall errors, authoritative regressions, browser forced probes, and time from acknowledged mutation revision to first observation on another process in black-box artifacts.

**Initial acceptance target:** Any point read with an acknowledged revision floor returns that floor or newer, or a typed retryable error; normal browser point activity performs a durable probe within at most ten successful reads; no strict authorization decision is made from a stale-tolerant cache response.

---

## REST Contract Matrix

| Route | Query | Data source | Authorization | Result |
| --- | --- | --- | --- | --- |
| Client collection | unsupported | durable list/read | current self/list policy | Collection is authoritative as read; no shared scalar revision. |
| Client point | omitted | durable full snapshot | self policy is request identity based | `200`, `404`, or authoritative-regression `503`. |
| Client point | valid minimum | eligible cache if `revision >= minimum`, else durable | self policy is request identity based | Never below minimum; `503` if durable state is below it. |
| Client presence | unsupported | durable presence read | self policy | Existing presence payload; no new query until it has an explicit causal contract. |
| Group collection | unsupported | durable list | filter from durable snapshots under strict auth | Collection is authoritative as read. |
| Group point, strict auth inactive | omitted | durable full snapshot | existing non-strict behavior | `200`, `404`, or authoritative-regression `503`. |
| Group point, strict auth inactive | valid minimum | eligible cache, else durable | existing non-strict behavior | Stale-at-or-above-minimum is allowed. |
| Group point, strict auth active | any | durable full snapshot | evaluate current durable group policy | The supplied minimum is validated but cannot downgrade authorization freshness. |
| Group events/topology/admin reads | unsupported by this plan | current route-specific durable/causal contract | always durable policy decision | Do not infer this point-snapshot cache contract for other resources. |

Successful point response headers:

```http
Cache-Control: private, no-store
Rallar-State-Source: cache
Rallar-State-Revision: 42
```

Minimum not yet available response:

```json
{
  "error": "Client snapshot has not reached requested state revision 42; durable revision is 41",
  "code": "state-snapshot-minimum-revision-unavailable",
  "message": "The requested state revision is not yet available from durable state.",
  "details": {
    "entity": "client",
    "requestedMinStateRevision": 42,
    "observedStateRevision": 41
  }
}
```

---

## Target Interfaces

Create `packages/shared/api/state-snapshot-read.ts` with the transport-neutral request contract:

```ts
export type StateSnapshotReadOptions = Readonly<{
    minStateRevision?: number;
}>;

export type StateSnapshotReadSource = 'cache' | 'durable';

export type StateSnapshotEntityKind = 'client' | 'group';

export type StateSnapshotReadResult<T> = Readonly<{
    snapshot: T | undefined;
    source: StateSnapshotReadSource;
    requestedMinStateRevision?: number;
}>;
```

Create `packages/shared-server/rallar-system/services/rest-state-snapshot-reader.ts` with the shared selection algorithm and typed errors:

```ts
export class StateSnapshotMinimumRevisionUnavailableError extends Error {
    readonly status = 503;
    readonly code = 'state-snapshot-minimum-revision-unavailable';

    constructor(
        readonly entity: StateSnapshotEntityKind,
        readonly requestedMinStateRevision: number,
        readonly observedStateRevision: number,
    ) {
        super(
            `${entity} snapshot has not reached requested state revision ` +
                `${requestedMinStateRevision}; durable revision is ` +
                `${observedStateRevision}`,
        );
        this.name = 'StateSnapshotMinimumRevisionUnavailableError';
    }
}

export class StateSnapshotAuthoritativeRegressionError extends Error {
    readonly status = 503;
    readonly code = 'state-snapshot-authoritative-regression';

    constructor(
        readonly entity: StateSnapshotEntityKind,
        readonly durableStateRevision: number,
        readonly cachedStateRevision: number,
    ) {
        super(
            `${entity} durable snapshot revision ${durableStateRevision} ` +
                `is behind observed cache revision ${cachedStateRevision}`,
        );
        this.name = 'StateSnapshotAuthoritativeRegressionError';
    }
}

export async function readRestStateSnapshot<Ref, Snapshot>(
    input: Readonly<{
        entity: StateSnapshotEntityKind;
        ref: Ref;
        options: StateSnapshotReadOptions;
        peekCache(ref: Ref): Snapshot | undefined;
        readDurable(ref: Ref): Promise<Snapshot | undefined>;
        evictCache(ref: Ref): void;
        observe(snapshot: Snapshot): StateSnapshotObservation;
        readStateRevision(snapshot: Snapshot): number;
        timing?: RallarTimingSink;
        timingContext?: Readonly<{
            serviceId?: string;
            applicationId: string;
            workspaceId: string;
            groupId?: string;
            principalId?: string;
        }>;
    }>,
): Promise<StateSnapshotReadResult<Snapshot>>;
```

The algorithm is fixed:

```ts
const cached = input.peekCache(input.ref);
const cachedRevision = cached && input.readStateRevision(cached);
const minimum = input.options.minStateRevision;

if (minimum !== undefined && cached && cachedRevision! >= minimum) {
    return { snapshot: cached, source: 'cache', requestedMinStateRevision: minimum };
}

const durable = await input.readDurable(input.ref);
if (!durable) {
    input.evictCache(input.ref);
    return {
        snapshot: undefined,
        source: 'durable',
        ...(minimum === undefined ? {} : { requestedMinStateRevision: minimum }),
    };
}

const durableRevision = input.readStateRevision(durable);
if (minimum !== undefined && durableRevision < minimum) {
    throw new StateSnapshotMinimumRevisionUnavailableError(
        input.entity,
        minimum,
        durableRevision,
    );
}
if (cachedRevision !== undefined && durableRevision < cachedRevision) {
    throw new StateSnapshotAuthoritativeRegressionError(
        input.entity,
        durableRevision,
        cachedRevision,
    );
}

input.observe(durable);
return {
    snapshot: durable,
    source: 'durable',
    ...(minimum === undefined ? {} : { requestedMinStateRevision: minimum }),
};
```

Extend both cached services additively:

```ts
readRestSnapshot(
    ref: ClientPrincipalRef,
    options?: StateSnapshotReadOptions,
): Promise<StateSnapshotReadResult<ClientSnapshot>>;

readRestSnapshot(
    ref: GroupRef,
    options?: StateSnapshotReadOptions,
): Promise<StateSnapshotReadResult<GroupSnapshot>>;
```

Keep `readSnapshot`, `readCurrentSnapshot`, and `readSnapshotAtLeast` for existing internal consumers. Do not silently change their semantics in this plan.

Create `packages/shared-web/browser/state-snapshot-read-convergence.ts`:

```ts
export type StateSnapshotReadProbeKey = Readonly<{
    entity: 'client' | 'group';
    applicationId: string;
    workspaceId: string;
    entityId: string;
}>;

export type StateSnapshotReadProbeDecision = Readonly<{
    minStateRevision?: number;
    authoritativeProbe: boolean;
}>;

export type StateSnapshotReadProbePolicy = Readonly<{
    decide(key: StateSnapshotReadProbeKey, localStateRevision?: number):
        StateSnapshotReadProbeDecision;
    recordSuccess(key: StateSnapshotReadProbeKey, decision: StateSnapshotReadProbeDecision):
        void;
}>;
```

Default policy:

- Initial or locally unknown revision: omit the minimum.
- After a successful authoritative read, sample an interval `N` inclusively from 5 through 10.
- For `N = 5`, four subsequent successful reads carry the local minimum and the fifth omits it.
- For `N = 10`, nine subsequent successful reads carry the local minimum and the tenth omits it.
- A transport, `5xx`, authorization, or invalid-request failure does not call `recordSuccess`. A planned authoritative read that returns `404` records authoritative absence after scoped eviction, then rethrows the API error.
- A successful decision with `authoritativeProbe: false` advances the per-key successful read count, even if the server happened to fall back from cache to durable state.
- A successful decision with `authoritativeProbe: true` resets the count and samples the next interval. This keeps the browser policy independent from response-envelope changes while remaining conservative: an unplanned durable fallback can only cause the next forced probe to happen sooner.
- Inject `sampleProbeInterval(min, max)` in tests; production uses `crypto.getRandomValues`, not `Math.random`, so the facade does not depend on mutable global random state.

---

### Task 0: Human architecture review gate

**Files:**

- Review: `plans/rallar-rest-snapshot-read-convergence-implementation-plan.md`
- Review companion: `plans/api-v1-convergent-database-writing-remediation-plan.md`

- [ ] Confirm P1: tokenless point reads always read the full durable snapshot.
- [ ] Confirm tokened reads may return a cache value at or above the minimum even when a newer value exists.
- [ ] Confirm collection and client-presence routes do not accept one scalar `minStateRevision`.
- [ ] Confirm strict group authorization forces a durable snapshot and may ignore the caller's cache optimization.
- [ ] Confirm invalid minimum is `400`; durable revision below the requested minimum is retryable `503` with `Retry-After: 1`.
- [ ] Confirm browser forced probes occur every 5–10 successful scoped point reads, with no timer/background traffic.
- [ ] Confirm `rallar.rooms.room(ref).refresh()` changes from collection refresh to point group refresh while top-level refresh behavior stays unchanged.
- [ ] Confirm dedicated latest tables, durable invalidation replay, and structured group/presence causal revisions remain separately reviewed follow-ups.
- [ ] Record approval in the implementation task before Task 1 begins.

**Review checkpoint:** Stop here until all nine decisions are approved or the plan is amended.

---

### Task 1: Add the shared REST snapshot selection contract

**Files:**

- Create: `packages/shared/api/state-snapshot-read.ts`
- Create: `packages/shared-server/rallar-system/services/rest-state-snapshot-reader.ts`
- Create: `packages/tests/shared-server/rest-state-snapshot-reader.test.ts`
- Modify: `packages/shared-server/mod.ts`

- [ ] Add a failing test: omitted minimum does not call `peekCache` as a return path, calls `readDurable` once, observes the returned snapshot once, and reports source `durable`.
- [ ] Run `npx vitest run packages/tests/shared-server/rest-state-snapshot-reader.test.ts`; expect failure because the module does not exist.
- [ ] Add `StateSnapshotReadOptions`, `StateSnapshotReadSource`, `StateSnapshotEntityKind`, and `StateSnapshotReadResult<T>` exactly as defined in Target Interfaces.
- [ ] Implement the smallest tokenless durable path and export the server helper from `packages/shared-server/mod.ts`.
- [ ] Run the focused test; expect the tokenless test to pass.
- [ ] Add a failing test: a presence-eligible cached revision `7` with minimum `6` returns source `cache`, does not call durable storage, and does not observe again.
- [ ] Implement the cache-hit branch and run the focused test.
- [ ] Add failing tests for cache below minimum, cache absent, and durable fallback. Each must read durable exactly once and observe the qualifying durable result.
- [ ] Implement fallback and run the focused test.
- [ ] Add a failing test for durable revision below the requested minimum. Assert class, status `503`, code, entity, requested revision, and observed revision.
- [ ] Implement `StateSnapshotMinimumRevisionUnavailableError` and run the focused test.
- [ ] Add a failing test for durable revision below an already observed cache revision on both tokenless and tokened fallback paths.
- [ ] Implement `StateSnapshotAuthoritativeRegressionError`; assert the lower durable value is not observed or returned.
- [ ] Add tests for not-found durable state, equal duplicate observation, newer durable observation, and propagation of equal-revision/different-content conflicts from `observe`. Not-found must call `evictCache(ref)` exactly once; every found result and every cache hit must call it zero times.
- [ ] Add timing tests with a spy `RallarTimingSink`: assert `entity`, `source`, requested minimum, cached revision, returned revision, fallback reason, status, and duration fields; assert a throwing sink cannot fail the read.
- [ ] Run `npx vitest run packages/tests/shared-server/rest-state-snapshot-reader.test.ts`; expect all tests to pass.
- [ ] Run `npx tsc -p packages/shared-server/tsconfig.json --noEmit`; expect exit code `0`.
- [ ] Commit: `git add packages/shared/api/state-snapshot-read.ts packages/shared-server/rallar-system/services/rest-state-snapshot-reader.ts packages/shared-server/mod.ts packages/tests/shared-server/rest-state-snapshot-reader.test.ts && git commit -m "feat: define convergent REST snapshot reads"`.

---

### Task 2: Give cached client and group services symmetric REST reads

**Files:**

- Modify: `packages/shared-server/rallar-system/services/cached-client-state-service.ts`
- Modify: `packages/shared-server/rallar-system/services/cached-group-state-service.ts`
- Modify: `packages/shared-server/rallar-system/services/client-state-snapshot-read-through-cache.ts`
- Modify: `packages/shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts`
- Modify: `packages/shared/repository/client-state-snapshots-repository.ts`
- Modify: `apps/api-v1/src/middleware.ts`
- Modify: `packages/tests/shared-server/cached-state-services.test.ts`
- Verify: `packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts`
- Verify: `packages/tests/shared-server/group-state-snapshot-read-through-cache.test.ts`

- [ ] Extend the test cache fakes with `peek(ref)` and keep existing `findOrLoadByRef(...)` behavior unchanged.
- [ ] Add failing client tests for `readRestSnapshot(ref)` and `readRestSnapshot(ref, { minStateRevision: 2 })`: tokenless calls durable; qualifying token calls cache; stale cache falls back to durable.
- [ ] Add the same failing group tests. Use one table-driven expectation so client/group behavior cannot drift.
- [ ] Run `npx vitest run packages/tests/shared-server/cached-state-services.test.ts`; expect missing-method failures.
- [ ] Add `peek` to `CachedClientStateServiceCache` and `CachedGroupStateServiceCache` dependency types. Do not expose the underlying repository manager.
- [ ] Add `evict(ref)` to both read-through caches. It must delete the loaned entry and the shared latest-observed repository entry; add scoped `removeClientStateSnapshotByRef(...)` parity with the existing group removal helper.
- [ ] Add failing read-through-cache tests showing eviction affects only the exact application/workspace/entity key and preserves same-id entries in other workspaces.
- [ ] Add `readRestSnapshot` to `CachedClientStateService` and `CachedGroupStateService` and delegate to `readRestStateSnapshot(...)` with `readClientStateRevision` or `readGroupStateRevision`.
- [ ] Add an optional `timing?: RallarTimingSink` factory option to both cached services and pass the sink plus scoped identifiers into the helper.
- [ ] Pass API-v1's existing `timing` sink into both cached-service factories in `apps/api-v1/src/middleware.ts`; leave test and library callers source compatible when it is omitted.
- [ ] Keep `readSnapshot`, `readCurrentSnapshot`, and `readSnapshotAtLeast` byte-for-byte semantically compatible.
- [ ] Run `npx vitest run packages/tests/shared-server/cached-state-services.test.ts`; expect all new and existing tests to pass.
- [ ] Add a three-logical-node test: Node A, Node B, and Node C have independent cache fakes over one durable fake; warm all at revision `2`; return a committed revision `3` mutation through B; hydrate A and B only; assert C with minimum `3` reads durable and reaches `3`, C with minimum `2` may return cached revision `2`, and C tokenless always reads durable revision `3`.
- [ ] Add a negative test: C durable fallback at revision `2` for minimum `3` throws the typed `503` instead of returning revision `2`.
- [ ] Add a service test that a tokenless durable not-found result evicts a stale positive cache entry before returning source `durable` with `snapshot: undefined`.
- [ ] Run `npx vitest run packages/tests/shared-server/cached-state-services.test.ts packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts packages/tests/shared-server/group-state-snapshot-read-through-cache.test.ts`; expect all tests to pass.
- [ ] Run `npx tsc -p packages/shared-server/tsconfig.json --noEmit`; expect exit code `0`.
- [ ] Commit: `git add packages/shared-server/rallar-system/services/cached-client-state-service.ts packages/shared-server/rallar-system/services/cached-group-state-service.ts packages/shared-server/rallar-system/services/client-state-snapshot-read-through-cache.ts packages/shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts packages/shared/repository/client-state-snapshots-repository.ts apps/api-v1/src/middleware.ts packages/tests/shared-server/cached-state-services.test.ts packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts packages/tests/shared-server/group-state-snapshot-read-through-cache.test.ts && git commit -m "feat: add symmetric REST snapshot readers"`.

---

### Task 3: Expose `minStateRevision` safely in API-v1 routes

**Files:**

- Create: `apps/api-v1/src/routes/state-snapshot-read.ts`
- Create: `apps/api-v1/test/routes/state-snapshot-read.test.ts`
- Modify: `apps/api-v1/src/routes/client-state-routes.ts`
- Modify: `apps/api-v1/src/routes/group-state-routes.ts`
- Modify: `apps/api-v1/src/routes/graph-topology-routes.ts`
- Modify: `apps/api-v1/src/main.ts`
- Modify: `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- Modify: `apps/api-v1/test/routes/graph-topology-routes.test.ts`

- [ ] Add table-driven failing parser tests for absence and valid values `0`, `1`, and `Number.MAX_SAFE_INTEGER`.
- [ ] Add table-driven failing parser tests for `?minStateRevision=`, whitespace, `-1`, `+1`, `1.0`, `1e3`, `NaN`, `Infinity`, unsafe integers, and repeated parameters. Assert HTTP-facing code `invalid-min-state-revision` and the rejected raw values.
- [ ] Run `cd apps/api-v1 && deno test --allow-env --allow-read test/routes/state-snapshot-read.test.ts`; expect module-not-found failure.
- [ ] Implement `readMinStateRevision(searchParams)` using an exact decimal regex plus `Number.isSafeInteger`; do not silently coerce malformed input.
- [ ] Implement helpers that set successful point-read headers and map the two typed `503` errors plus the invalid-query error into the existing `StateErrorResponse` shape.
- [ ] Run the parser/helper test; expect it to pass.
- [ ] Change `ClientStateRouteService` and `GroupStateRouteService` to require `readRestSnapshot` from their cached service types.
- [ ] Add a failing client point route test: no query forwards `{}` and receives a durable result; `?minStateRevision=7` forwards `{ minStateRevision: 7 }`; headers match the returned source and revision.
- [ ] Add a failing strict client collection test: the authenticated self-only collection uses `readRestSnapshot(ref, {})`, not cached `readSnapshot`.
- [ ] Implement client collection and point routing. Keep client presence durable and reject no new parameters there.
- [ ] Add `Cache-Control: private, no-store` to client snapshot collection, point, and presence responses.
- [ ] Run the client route tests; expect them to pass.
- [ ] Add failing non-strict group tests: tokenless uses REST durable selection; tokened forwards the parsed minimum and can report source `cache`.
- [ ] Add a failing strict group test with cached revision `4`, durable revision `5`, and actor banned only in revision `5`: a request with `minStateRevision=4` must return `403` after exactly one durable read and zero response-cache reads.
- [ ] Refactor the group route to read strict-auth context before selecting a response. Under strict auth, call `readRestSnapshot(ref, {})`, authorize that durable snapshot, and return it. Under non-strict behavior, forward the caller's options.
- [ ] Keep event-route authorization on `readCurrentSnapshot`; do not route policy checks through stale-tolerant reads.
- [ ] Update graph/topology group-policy lookup to use `readCurrentSnapshot` or the tokenless REST durable method instead of cached `readSnapshot`.
- [ ] Add `Cache-Control: private, no-store` to group collection and point responses.
- [ ] Add route tests for invalid query `400`, unavailable minimum `503` plus `Retry-After: 1`, authoritative regression `503`, not found `404`, and successful source/revision headers.
- [ ] Update the existing mutation hydration test name and assertions to say it optimizes the receiving node cache; add a separate assertion that a later tokenless client GET invokes durable REST selection even when hydration succeeded.
- [ ] Extend CORS `exposeHeaders` in `apps/api-v1/src/main.ts` with `Rallar-State-Source`, `Rallar-State-Revision`, and `Retry-After` while preserving current headers.
- [ ] Run `cd apps/api-v1 && deno test --allow-env --allow-read test/routes/state-snapshot-read.test.ts test/routes/state-api-routes-hardening.test.ts test/routes/graph-topology-routes.test.ts`; expect all tests to pass.
- [ ] Run `cd apps/api-v1 && deno task check`; expect exit code `0`.
- [ ] Commit: `git add apps/api-v1/src/routes/state-snapshot-read.ts apps/api-v1/src/routes/client-state-routes.ts apps/api-v1/src/routes/group-state-routes.ts apps/api-v1/src/routes/graph-topology-routes.ts apps/api-v1/src/main.ts apps/api-v1/test/routes/state-snapshot-read.test.ts apps/api-v1/test/routes/state-api-routes-hardening.test.ts apps/api-v1/test/routes/graph-topology-routes.test.ts && git commit -m "feat: expose causal snapshot reads in API v1"`.

---

### Task 4: Add browser point-read tokens and bounded anti-entropy probes

**Files:**

- Create: `packages/shared-web/browser/state-snapshot-read-convergence.ts`
- Create: `packages/tests/shared-web/api-integration-state-snapshot-read.test.ts`
- Create: `packages/tests/shared-web/state-snapshot-read-convergence.test.ts`
- Modify: `packages/shared-web/browser/api-integration.ts`
- Modify: `packages/shared-web/browser/api-workflows.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/contracts.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/state-store.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/rooms.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/composition.ts`
- Modify: `packages/shared-web/mod.ts`
- Modify: `packages/tests/shared-web/api-workflows.test.ts`
- Modify: `packages/tests/shared-web/rallar-rooms-facade.test.ts`
- Modify: `packages/tests/shared-web/rallar-rooms-people-state.test.ts`
- Modify: `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
- Modify: `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`

- [ ] Create `packages/tests/shared-web/api-integration-state-snapshot-read.test.ts` with failing tests that `findStateGroup(..., { minStateRevision: 7 })` and new `findStateClient(..., { minStateRevision: 7 })` append the encoded query, while omission produces no query string.
- [ ] Add `StateSnapshotReadRequestOptions = ApiRequestOptions & StateSnapshotReadOptions`, add `findStateClient`, and update `findStateGroup` to call a shared `withStateSnapshotReadQuery(...)` helper.
- [ ] Validate browser-supplied minimums before building URLs using the shared non-negative safe-integer rule; fail locally rather than sending malformed values.
- [ ] Run the focused API integration/workflow tests; expect them to pass.
- [ ] Add failing cadence tests for a deterministic interval of `5`: initial unknown revision is tokenless; after success, four reads carry the current local revision; the fifth is tokenless; a failed fifth request does not reset the schedule.
- [ ] Add the same boundary test for interval `10`, plus separate-key tests for two groups with the same id in different workspaces and a client/group with the same entity id.
- [ ] Add tests showing a newer locally observed revision is used on the next tokened read and an older local observation is never selected.
- [ ] Implement `createStateSnapshotReadProbePolicy(...)` with injected interval sampling and per-key successful-read state. Do not add timers, storage persistence, or module-global mutable counters.
- [ ] Export the factory and types from `packages/shared-web/mod.ts` and run `npx vitest run packages/tests/shared-web/state-snapshot-read-convergence.test.ts`; expect all cadence tests to pass.
- [ ] Update the shared-web public API snapshot for the additive point-read options, client point function, probe-policy factory, and types. Extend the browser bundle-boundary test to prove the new convergence module imports no server, Deno, PostgreSQL, or Node runtime code.
- [ ] Add `findClientSnapshotByRef(ref)` and `readGroupStateRevision(ref)`/`readClientStateRevision(ref)` accessors to `RallarStatePort`; keep the existing convenience lookups compatible.
- [ ] Add `removeGroupSnapshot(ref)` to `RallarStatePort` using `removeGroupStateSnapshotByRef(...)`, including its session-index cleanup.
- [ ] Add `refreshStateGroupSnapshot(...)` to `api-workflows.ts`. It performs exactly one point group GET under existing command/retry policies and returns one snapshot.
- [ ] Keep `refreshStateSnapshots(...)` unchanged: it continues parallel durable collection reads.
- [ ] Inject one probe-policy instance from `rallar-runtime/composition.ts` into the rooms controller.
- [ ] Change only `RallarRoomSession.refresh(...)`: resolve the cached local group revision, ask the policy for a decision, call `refreshStateGroupSnapshot(...)`, call `recordSuccess(...)` only after the HTTP request succeeds, accept the returned group snapshot, and return a new session wrapper.
- [ ] For an authoritative room-session decision that receives `ApiHttpError` status `404`, remove the exact scoped group snapshot, record the successful authoritative observation of absence, emit the state change, and rethrow the `404`. For tokened/non-authoritative `404`, rethrow without eviction because it does not carry the forced durable-read guarantee.
- [ ] Ensure top-level `RallarRoomsFacade.refresh(...)` and `RallarPeopleFacade.refresh(...)` still use collection refresh and never attach a scalar minimum.
- [ ] Ensure update-before-write workflows such as `updateStateGroupMetadata(...)` omit the minimum and read durable state; mutation correctness must not merge a deliberately stale cached snapshot.
- [ ] Add room facade tests for local revision propagation, fifth/tenth forced omission, request failure not advancing cadence, per-room isolation, and monotonic acceptance of returned snapshots.
- [ ] Add a room facade deletion test: the forced tokenless probe receives `404`, evicts only the exact scoped room, resets the probe cadence as an authoritative observation, and still rejects the refresh promise with the original `ApiHttpError`.
- [ ] Add a regression test that top-level rooms/people refresh still calls list endpoints and that room-session refresh no longer fetches all clients/groups.
- [ ] Run `npx vitest run packages/tests/shared-web/api-integration-state-snapshot-read.test.ts packages/tests/shared-web/state-snapshot-read-convergence.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/rallar-rooms-facade.test.ts packages/tests/shared-web/rallar-rooms-people-state.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`; expect all tests to pass.
- [ ] Run `npx tsc -p packages/shared-web/tsconfig.json --noEmit`; expect exit code `0`.
- [ ] Run `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`; expect the browser boundary check to pass and no server-only module in the bundle.
- [ ] Commit: `git add packages/shared-web/browser/state-snapshot-read-convergence.ts packages/shared-web/browser/api-integration.ts packages/shared-web/browser/api-workflows.ts packages/shared-web/browser/rallar-runtime/contracts.ts packages/shared-web/browser/rallar-runtime/state-store.ts packages/shared-web/browser/rallar-runtime/rooms.ts packages/shared-web/browser/rallar-runtime/composition.ts packages/shared-web/mod.ts packages/tests/shared-web/api-integration-state-snapshot-read.test.ts packages/tests/shared-web/state-snapshot-read-convergence.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/rallar-rooms-facade.test.ts packages/tests/shared-web/rallar-rooms-people-state.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts && git commit -m "feat: add browser snapshot anti-entropy probes"`.

---

### Task 5: Align OpenAPI and Swagger with the read contract

**Files:**

- Modify: `apps/api-v1/resources/api-v1-openapi.yaml`
- Modify: `apps/api-v1/test/swagger-routes.test.ts`
- Modify: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-openapi-topology-auth.json`

- [ ] Add a failing Swagger test that the client and group point GET operations reference a shared `MinStateRevision` query parameter with `type: integer`, `format: int64`, and `minimum: 0`.
- [ ] Add failing assertions that both point operations document `400`, `404`, and `503`, the two state response headers, and the `Retry-After` header on `503`.
- [ ] Add failing assertions that `ClientSnapshot.required` and `GroupSnapshot.required` include `stateRevision`, and both schemas expose it as a non-negative integer.
- [ ] Run `cd apps/api-v1 && deno test --allow-env --allow-read test/swagger-routes.test.ts`; expect the new assertions to fail.
- [ ] Add the shared parameter with a description that explicitly distinguishes “at least” from “latest” and says omission forces a durable read.
- [ ] Add a reusable `StateSnapshotMinimumRevisionUnavailable` response and document the error codes/details without changing the generic error schema for unrelated routes.
- [ ] Add `stateRevision` to both snapshot schemas' required lists and properties.
- [ ] Add point-response header schemas and `Cache-Control` documentation.
- [ ] State in collection route descriptions that collections read durable state and do not accept one entity revision floor.
- [ ] Update the OpenAPI black-box recipe to assert the parameter, response codes, headers, and required snapshot fields from `/api/openapi.json`.
- [ ] Run `cd apps/api-v1 && deno test --allow-env --allow-read test/swagger-routes.test.ts`; expect all tests to pass.
- [ ] Run `npm run test:api-v1:black-box:recipes`; expect OpenAPI and recipe preflight to pass against the configured service, or record it as skipped when no API service is available.
- [ ] Run `cd apps/api-v1 && deno task check`; expect exit code `0`.
- [ ] Commit: `git add apps/api-v1/resources/api-v1-openapi.yaml apps/api-v1/test/swagger-routes.test.ts packages/shared-test/black-box-runner/tests/api-v1/api-v1-openapi-topology-auth.json && git commit -m "docs: specify causal snapshot reads in OpenAPI"`.

---

### Task 6: Prove the old API-v1 failure under the new explicit semantics

**Files:**

- Modify: `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- Modify: `packages/tests/shared-server/state-sync-cache-hydration.test.ts`
- Modify: `packages/tests/shared-server/cached-state-services.test.ts`
- Modify: `packages/tests/shared-server/state-sync-publish-failure-characterization.test.ts`

- [ ] Preserve the existing test that a successful remotely processed mutation hydrates the HTTP-receiving node. Rename its description to identify cache hydration as latency optimization.
- [ ] Add a failing scenario with logical nodes A, B, and C over one durable repository: A receives the HTTP mutation response, B commits it, and C receives neither local hydration nor a state-sync observation.
- [ ] Assert the mutation response exposes committed revision `N` and that all logical caches remain monotonic when they later observe it.
- [ ] Assert `GET` semantics through A and C separately:
  - no minimum reads durable revision `N`;
  - minimum `N` returns revision `>= N` and falls back if needed;
  - minimum `N - 1` may return cached `N - 1`;
  - impossible minimum `N + 1` returns the typed retryable error.
- [ ] Add a publication-failure test showing that loss/failure of state-sync observation does not break tokenless or at-least REST reads because they fall back to durable state.
- [ ] Add a strict group authorization scenario: cache says member active at `N - 1`, durable state says banned at `N`, and a request with minimum `N - 1` is denied from durable policy state.
- [ ] Run `npx vitest run packages/tests/shared-server/cached-state-services.test.ts packages/tests/shared-server/state-sync-cache-hydration.test.ts packages/tests/shared-server/state-sync-publish-failure-characterization.test.ts`; expect all tests to pass.
- [ ] Run `cd apps/api-v1 && deno test --allow-env --allow-read test/routes/state-api-routes-hardening.test.ts`; expect all tests to pass.
- [ ] Commit: `git add apps/api-v1/test/routes/state-api-routes-hardening.test.ts packages/tests/shared-server/state-sync-cache-hydration.test.ts packages/tests/shared-server/cached-state-services.test.ts packages/tests/shared-server/state-sync-publish-failure-characterization.test.ts && git commit -m "test: prove multi-node snapshot convergence semantics"`.

---

### Task 7: Add a three-process API-v1 convergence black-box gate

**Files:**

- Create: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-read-convergence.json`
- Modify: `packages/shared-test/black-box-runner/recipe-matrix.json`
- Modify: `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`
- Modify: `packages/shared-test/package.json`
- Modify: `package.json`
- Modify: `packages/tests/shared-test/api-v1-black-box-run.test.ts`
- Modify: `packages/tests/shared-test/recipe-matrix.test.ts`
- Modify: `.github/actions/api-v1-black-box-test/action.yml`
- Modify: `.github/workflows/api-v1-black-box.yml`
- Modify: `.github/workflows/release-gate.yml`
- Modify: `packages/tests/repo/api-v1-black-box-workflow.test.ts`

- [ ] Add failing runner tests for optional `--tertiary-port`: Postgres only, requires a secondary port, all three ports must be distinct, and environment exports `RALLAR_API_BASE_URL_TERTIARY`/`RALLAR_WS_BASE_URL_TERTIARY`.
- [ ] Add a failing server-plan test expecting three managed server plans and a separate bounded log path for each process.
- [ ] Run `npx vitest run packages/tests/shared-test/api-v1-black-box-run.test.ts`; expect the tertiary assertions to fail.
- [ ] Extend the runner options, argument parser, environment builder, server-plan builder, readiness/start/stop handling, secret redaction coverage, and diagnostics to support a third managed API process.
- [ ] Keep memory mode single-process and preserve the existing two-process invocation when no tertiary port is supplied.
- [ ] Add `tertiary-api-port` to the composite action and pass it only when non-empty.
- [ ] Configure the Postgres workflow and release gate with ports `18080`, `18081`, and `18082`; leave the memory workflow without secondary/tertiary ports.
- [ ] Update repository workflow tests to assert three Postgres APIs and one memory API.
- [ ] Run `npx vitest run packages/tests/shared-test/api-v1-black-box-run.test.ts packages/tests/repo/api-v1-black-box-workflow.test.ts`; expect all tests to pass.
- [ ] Add the cluster-only recipe `api-v1-state-read-convergence` requiring primary, secondary, and tertiary HTTP services.
- [ ] In the recipe, create/login an owner and member, establish client sessions and group presence, and capture every mutation response's `stateRevision`.
- [ ] Warm point client/group reads on all three servers before a later mutation. Record response source/revision headers in artifacts but permit cache or durable source for tokened reads.
- [ ] Mutate through the secondary server, capture committed revision `N`, and immediately read through the unrelated tertiary server:
  - tokenless client GET must report source `durable` and revision `>= N`;
  - client GET with minimum `N` must return revision `>= N` from cache or durable;
  - no response may return below the supplied minimum.
- [ ] Exercise invalid minimum and impossible minimum, asserting `400 invalid-min-state-revision` and `503 state-snapshot-minimum-revision-unavailable` with `Retry-After: 1`.
- [ ] Warm a group snapshot on tertiary, ban the member through secondary, then have the banned member GET the group through tertiary with the old minimum. Assert `403`, proving strict policy did not trust the stale-tolerant cache.
- [ ] Add bounded fixed-count reads instead of fixed sleeps: alternate mutations across primary/secondary, read each acknowledged minimum through tertiary, and assert every successful response is monotonic and at least the supplied floor. Record revision gaps and first-observation call count.
- [ ] Add tokenless reads at positions 5 and 10 to mirror the browser policy and assert source `durable`; the browser unit test remains the proof that those positions are selected automatically.
- [ ] Capture final group revision, then wait for topology publications whose `sourceGroupStateRevision` reaches the expected input using the existing bounded WS wait pattern. Accept publication arrival reordering, but never a regression after a newer causal revision has been observed.
- [ ] Register the recipe in the `api-v1-black-box-cluster` profile and add recipe-matrix contract tests for all three required services.
- [ ] Add `bb:api-v1:postgres` tertiary port `18082`; keep recipe-only and memory scripts unchanged.
- [ ] Run `npx vitest run packages/tests/shared-test/api-v1-black-box-run.test.ts packages/tests/shared-test/recipe-matrix.test.ts packages/tests/repo/api-v1-black-box-workflow.test.ts`; expect all tests to pass.
- [ ] Run `npm run test:api-v1:black-box:postgres`; expect the three-process convergence recipe and existing Postgres recipes to pass. If PostgreSQL is unavailable locally, record the command as skipped and require CI evidence before merge.
- [ ] Commit: `git add packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-read-convergence.json packages/shared-test/black-box-runner/recipe-matrix.json packages/shared-test/black-box-runner/api-v1-black-box-run.mts packages/shared-test/package.json package.json packages/tests/shared-test/api-v1-black-box-run.test.ts packages/tests/shared-test/recipe-matrix.test.ts .github/actions/api-v1-black-box-test/action.yml .github/workflows/api-v1-black-box.yml .github/workflows/release-gate.yml packages/tests/repo/api-v1-black-box-workflow.test.ts && git commit -m "test: add three-node state read convergence gate"`.

---

### Task 8: Publish the client/group/topology snapshot mental model

**Files:**

- Create: `docs/rallar-state-snapshot-consistency.md`
- Modify: `docs/README.md`
- Modify: `docs/rallar-convergent-state-and-rtc-topology.md`
- Modify: `docs/rallar-api-reference.md`
- Modify: `docs/rallar-groups-report.md`
- Modify: `docs/rallar-troubleshooting-checklist.md`
- Modify: `packages/shared-server/rallar-server-repositories.md`
- Modify: `packages/shared-server/rallar-server-repositories-improvements.md`

- [ ] Write `docs/rallar-state-snapshot-consistency.md` from the Snapshot Mental Model and REST Contract Matrix in this plan. Include client, group, presence lease, topology, server-cache, browser-cache, and authorization sections.
- [ ] Include concrete Node A/B/C sequences for:
  - tokenless durable convergence;
  - tokened cache hit above an older floor;
  - cache miss and durable fallback at the acknowledged floor;
  - strict group authorization after a remote ban;
  - periodic browser forced probe.
- [ ] State explicitly that “latest observed,” “at least N,” “authoritative read,” and “globally latest at receipt” are different claims.
- [ ] Document `minStateRevision` only for point routes, its validation/error behavior, response headers, and the security exception.
- [ ] Document browser cadence and clarify that top-level collection refresh is already durable.
- [ ] Document the current `runtime_state_store` namespaces and key identities without presenting `_` workspace fallback or shared group-row heartbeat contention as the target design.
- [ ] Cross-link the dedicated latest-table/outbox/causal-tuple discussion to `plans/api-v1-convergent-database-writing-remediation-plan.md`.
- [ ] Update `docs/rallar-convergent-state-and-rtc-topology.md` causal revisions, process cache, browser convergence, guarantees/limits, and source-map sections to reference the new contract.
- [ ] Update `docs/rallar-api-reference.md` rooms refresh, point snapshot REST, people/collection behavior, response headers, and middleware cache descriptions.
- [ ] Update `docs/rallar-groups-report.md` read visibility and server authorization sections so stale-tolerant snapshots are never described as policy authority.
- [ ] Update `docs/rallar-troubleshooting-checklist.md` with checks for query omission, response source/revision, requested/observed gaps, strict-auth behavior, browser probe count, and Node C fallback.
- [ ] Update `packages/shared-server/rallar-server-repositories.md` REST data flow, caching summary, and operational semantics to distinguish the current physical store from response selection.
- [ ] Reframe the mutation hydration entry in `rallar-server-repositories-improvements.md` as latency optimization and link to the durable/at-least correctness contract.
- [ ] Add the new document to `docs/README.md` under the architecture/state documents.
- [ ] Run `rg -n "minStateRevision|Rallar-State-Source|authoritative|latest observed|Node C" docs packages/shared-server/*.md`; manually verify every documented term uses the same semantics.
- [ ] Run `rg -n "always current|globally latest|cache is authoritative" docs packages/shared-server/*.md`; inspect every match and remove contradictory claims.
- [ ] Commit: `git add docs/rallar-state-snapshot-consistency.md docs/README.md docs/rallar-convergent-state-and-rtc-topology.md docs/rallar-api-reference.md docs/rallar-groups-report.md docs/rallar-troubleshooting-checklist.md packages/shared-server/rallar-server-repositories.md packages/shared-server/rallar-server-repositories-improvements.md && git commit -m "docs: explain Rallar snapshot consistency"`.

---

### Task 9: Teach repo skills the convergence contract

**Files:**

- Modify: `.agents/skills/rallar-realtime/SKILL.md`
- Modify: `.agents/skills/rallar-platform/SKILL.md`
- Modify: `.agents/skills/rallar-code-writing/SKILL.md`
- Modify: `.agents/skills/rallar-testing/SKILL.md`
- Create: `.agents/skills/rallar-realtime/references/state-snapshot-consistency-checklist.md`
- Modify: `.agents/skills/rallar-testing/references/test-commands.md`
- Modify: `.agents/skills/rallar-code-writing/references/repo-code-style.md`
- Verify: `packages/tests/repo/rallar-skill-integrity.test.ts`

- [ ] Update `rallar-realtime` rules of thumb: cache is latest observed, point REST without minimum is durable, point REST with minimum is at-least, presence freshness is not completeness, and policy authority is durable.
- [ ] Add `.agents/skills/rallar-realtime/references/state-snapshot-consistency-checklist.md` with the client/group/topology revision domains, REST matrix, authorization rule, and browser probe boundaries; link both it and `docs/rallar-state-snapshot-consistency.md` from the skill.
- [ ] Update `rallar-platform` public-surface rules: one scalar minimum is entity-local and must not be added to collection contracts; structured causal tuples require coordinated cross-package migration.
- [ ] Update `rallar-code-writing` contract defaults: centralize query parsing and read selection, preserve monotonic observation, fail closed on authoritative regression, and never reuse stale-tolerant response data for authorization or mutation validation.
- [ ] Update `rallar-testing` selection rules: every state point-read change requires both tokenless and tokened behavior, invalid/unavailable minimums, multi-node cache isolation, strict-auth stale-cache denial, and browser probe-boundary tests.
- [ ] Add exact commands from Tasks 1–7 to `rallar-testing/references/test-commands.md`, including when the three-process PostgreSQL gate may be skipped locally but is mandatory in CI.
- [ ] Add scoped entity-key and mandatory-output guidance to `repo-code-style.md`; query/request omission remains optional by meaningful absence.
- [ ] Run `npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts`; expect all skill links, frontmatter, and references to pass.
- [ ] Read every modified `SKILL.md` completely after editing and verify it does not contradict the new documentation or the companion database-write plan.
- [ ] Commit: `git add .agents/skills/rallar-realtime .agents/skills/rallar-platform/SKILL.md .agents/skills/rallar-code-writing .agents/skills/rallar-testing && git commit -m "docs: teach snapshot convergence in Rallar skills"`.

---

### Task 10: Final verification and review handoff

**Files:**

- Verify all files from Tasks 1–9
- Update only if evidence requires correction: `plans/rallar-rest-snapshot-read-convergence-implementation-plan.md`

- [ ] Run focused server selection tests:
  - `npx vitest run packages/tests/shared-server/rest-state-snapshot-reader.test.ts packages/tests/shared-server/cached-state-services.test.ts packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts packages/tests/shared-server/group-state-snapshot-read-through-cache.test.ts packages/tests/shared-server/state-sync-cache-hydration.test.ts packages/tests/shared-server/state-sync-publish-failure-characterization.test.ts`
- [ ] Run focused browser tests:
  - `npx vitest run packages/tests/shared-web/api-integration-state-snapshot-read.test.ts packages/tests/shared-web/state-snapshot-read-convergence.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/rallar-rooms-facade.test.ts packages/tests/shared-web/rallar-rooms-people-state.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
- [ ] Run focused API-v1 route/Swagger tests:
  - `cd apps/api-v1 && deno test --allow-env --allow-read test/routes/state-snapshot-read.test.ts test/routes/state-api-routes-hardening.test.ts test/routes/graph-topology-routes.test.ts test/swagger-routes.test.ts`
- [ ] Run runner/workflow/skill tests:
  - `npx vitest run packages/tests/shared-test/api-v1-black-box-run.test.ts packages/tests/shared-test/recipe-matrix.test.ts packages/tests/repo/api-v1-black-box-workflow.test.ts packages/tests/repo/rallar-skill-integrity.test.ts`
- [ ] Run type and package gates:
  - `cd apps/api-v1 && deno task check`
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
  - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
- [ ] Run `npm run test:api-v1:black-box:memory`; expect all single-process memory recipes to pass and no cluster recipe to run.
- [ ] Run `npm run test:api-v1:black-box:postgres`; expect all three API processes to become ready and every default/cluster recipe, including `api-v1-state-read-convergence`, to pass.
- [ ] Inspect black-box artifacts and record:
  - mutation revision acknowledged by each server;
  - tertiary first-observation revision and source;
  - all requested minimum/returned revision pairs;
  - impossible-minimum error;
  - strict ban authorization result;
  - final topology source revision;
  - server logs for authoritative regression or equal-revision conflict.
- [ ] Run `git diff --check`; expect no whitespace errors.
- [ ] Run `git status --short`; verify only intentional changes remain.
- [ ] Request code review with special attention to off-by-one probe cadence, strict group authorization, invalid query coercion, Node C isolation, CORS headers, and OpenAPI parity.
- [ ] Do not claim completion if the three-process Postgres gate is skipped or failing; obtain CI evidence first.
- [ ] Prepare the AI handoff required by `AGENTS.md`: files and behavior changed, rationale and compatibility, exact pass/fail/skip evidence, black-box artifact location, and follow-up proposals P3/P4/P6/P7.

---

## Acceptance Criteria

- Tokenless client/group point GETs always invoke durable full-snapshot reads and report `Rallar-State-Source: durable`.
- Tokened point GETs never return below the requested `minStateRevision`.
- An eligible cache at or above the minimum can answer without a database read in non-policy-sensitive paths.
- A stale or absent cache falls back to durable state and observes the result monotonically.
- Invalid minimums are `400`; durable state below the floor is retryable `503`; authoritative regression is fail-closed `503`.
- Client/group collection and client-presence behavior remains durable and does not pretend one scalar covers multiple entities.
- Strict group reads and graph/topology policy checks use current durable group policy even when the caller supplies an older minimum.
- A logical or real Node C that missed mutation hydration still satisfies tokenless and at-least reads.
- Browser room-session point reads force a successful tokenless durable read every fifth through tenth read per scoped entity; transport, `5xx`, authorization, and invalid-request failures do not advance the schedule, while an authoritative `404` evicts absence and resets it.
- Top-level rooms/people collection refresh remains authoritative and backward compatible.
- Browser and server caches never regress and still reject equal-revision/different-content conflicts.
- OpenAPI/Swagger exposes the query, headers, errors, and required snapshot revision fields.
- The dedicated consistency document and repo skills distinguish internal consistency, monotonicity, freshness, and authority.
- Focused tests, type checks, bundle checks, memory black-box, and three-process PostgreSQL black-box all pass with recorded evidence.

## Explicit Non-Goals

- Replacing `runtime_state_store` with dedicated latest snapshot tables.
- Implementing the CAS/outbox database-write remediation plan.
- Splitting group and presence into a structured causal revision in this change.
- Claiming globally latest state at response receipt time.
- Making WebSocket notifications a lossless durable invalidation stream.
- Background browser polling or timers.
- Applying one scalar minimum to collection, event, topology, stats, admin, or presence payloads without a separately designed causal contract.
- Weakening strict read authorization, group policy, capacity, lifecycle, or governance checks to improve cache hit rate.

## Follow-Up Decision Points

After this implementation has production measurements, review:

1. Cache-hit rate and durable fallback rate for tokened point reads.
2. p50/p95/p99 durable snapshot assembly latency and row/JSON size by group size.
3. Frequency of browser forced probes finding a newer revision.
4. Cross-node time/call-count to first observation after an acknowledged mutation.
5. Whether the transaction-local mutation outbox from the companion plan is sufficient for durable cache invalidation/replay.
6. Whether measured read cost justifies dedicated latest projection tables, and whether their write amplification is acceptable under hot presence churn.
7. Whether group/presence causal decomposition must land before any latest group projection.
8. Tombstone retention and negative-cache semantics after durable invalidation exists.
