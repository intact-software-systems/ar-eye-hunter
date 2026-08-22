# Group Activation — Implementation Plan (2026-08-22)

Status: **planning — slices drafted, ten corrections awaiting the product owner, nine questions to
settle at slice planning.** Implements
`2026-08-22-group-activation-product-plan.md` (decisions 1–23, approved). That document owns the
product surface; this one owns how it lands. It does not restate the product decisions — it records
what the code says about them, what has to change, in what order, and which gate proves each step.

Every claim below was verified against the tree on 2026-08-22 by a ten-surface code census
(455 touch points, 152 hazards). Where a claim is load-bearing it carries its `file:line`.

## The property that makes this shippable

**`formation: 'immediate'` creates the group `active`, so the absent policy and the `optimistic`
preset behave exactly as they do today** (decision 17). One line carries it —
`create-initial-group-mutation.ts:40`, `lifecycleState: command.input.lifecyclePolicy?.formation
=== 'phased' ? 'forming' : 'active'` — and every slice below preserves it. The `absent-policy-parity`
scenario and `api-v1-group-lifecycle-policy.json` steps 8–9 pin it.

This matters more than it looks: **70 checked-in Hetzner manifests and 58 RTC recipes create groups
with no `lifecyclePolicy`** (`create-hetzner-group-assertions-recipe.ts:48-54` sends
`{groupId, displayName, kind, joinMode}` only). All of them depend on absent policy → `optimistic`
→ `immediate` → the browser's bootstrap dial. Any slice that suppresses bootstrap dialing without
keeping that path intact breaks the entire distributed lane silently.

**The second invariant, inherited from the control-plane workstream:** membership, presence,
admission and WS connectivity work in every stage, including `planned` and `paused`. Its test
constant `EVERY_LIFECYCLE_STATE`
(`packages/tests/shared-server/group-state/group-lifecycle-safety-baseline.test.ts:16`) is a
hand-written four-element literal — it will silently keep covering four of seven unless slice 1b
makes it compiler-derived.

Every slice's PR description states how it preserves both. A slice that cannot is wrong.

## Corrections to the product plan

Ten things in the product plan do not hold as written. Six are additions the plan simply did not
cover; **four change a recorded decision and need the product owner's call before the slice that
implements them.**

### Changing a recorded decision — please rule

| #  | What the plan says                                                                    | What the code says                                                                                                                                                                                                                                                                                                                                                                                                              | Proposed                                                                                                                                                                                                                                          |
| -- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | "every transition advances the formation epoch, re-pins the electorate" (stage model) | `computeGroupLifecycleTransition` returns `formationEpoch + 1` for every accepted transition (`group-lifecycle-transitions.ts:56-60`) and `compute-lifecycle-transition.ts:124` unconditionally re-pins `formationElectorate`. Manager election is epoch-keyed, and every FORMATION_TIMER entry is epoch-keyed. So **`pause` would re-elect the manager and orphan every armed timer**, and `resume` would do it again.         | `pause` and `resume` advance neither the epoch nor the electorate: neither changes the member set the layout was planned for. The stage table becomes "epoch-advancing" and "non-epoch-advancing" transitions.                                    |
| C2 | `fail-formation: connecting \| reconnecting → forming` (command table)                | Read against the stage table, a failed _reconfiguration_ of a live group would lose its applied layout, re-open a `closed` lobby (`compute-group-admission-decision.ts:57` admits in `forming`), and re-block application data — while `appliedLayoutVersion` still holds a non-zero value. The retry leg then re-enters `planned` and dead-ends, because the automatic `start-establishment` retry has no `connect` successor. | `fail-formation` lands in the reconfiguration's recorded origin stage (symmetrical with decision 23), and only a failed _first_ establishment lands in `forming`. The retry leg re-issues `plan` and the connect trigger.                         |
| C3 | `topology.evolution: 'auto' \| 'debounced' \| 'commanded'` (decision 2)               | `evolvePlannedTopology` already owns the word one directory away (`topology/planning/evolve-planned-topology.ts`) and means something else entirely — incremental graph evolution by membership delta versus full rebuild. Two "evolution" concepts in adjacent namespaces is the vocabulary hop the code standard forbids.                                                                                                     | Rename the policy field to `topology.replanning: 'auto' \| 'debounced' \| 'commanded'`. Same semantics, no collision. (`GroupTopologyManagementView.pending` already means "reconfigure queued" and collides with "pending layout" too — see Q8.) |
| C4 | The stage table's admission column is `Admission (closed)`                            | `computeGroupAdmissionDecision` evaluates the windows first and applies `manager-approval` parking in **every** stage (`compute-group-admission-decision.ts:31-63`). So `open` (optimistic), `manager-approval` (managed) and `untilMemberCount: 50` (drop-in-social) all keep admitting through `planned`, `paused` and a held reconfiguration — undefined by the plan.                                                        | Extend the stage table to all four admission modes and both windows, and state what a mid-hold join means for the pending layout (it makes the applied layout stale; under `commanded` replanning it does not move the layout).                   |

### Additions the plan did not cover

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                                                        | Owning slice |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| C5  | **Business status × stage is undefined.** `updateGroup` archives and deletes without touching `lifecycleState` (`compute-group-aggregate-mutation.ts:110-162`), while every transition asserts `assertActive` first. An archived, deleted or expired group in `planned` or `paused` has no defined observed status and no defined applied layout.                                                          | 1b, 2        |
| C6  | **Five stage-blind topology write paths bypass the held layout**: `POST …/topology/reconfigure`, `PUT`/`DELETE …/topology/config`, `PUT`/`DELETE …/topology/override` (`graph-topology-routes.ts:211,237,283,293,342`) all enqueue recompute work with `publish: true` and check only business status. Under `commanded` replanning they would publish and apply a layout nobody asked for.                | 4b           |
| C7  | **Departures are not defined under held/commanded replanning.** Presence expiry and session cleanup always flow into a replan today (`group-presence-summary-work.ts:198-208`). A `match` group whose player crashes must not sit on a layout naming a dead session.                                                                                                                                       | 4c, 10a      |
| C8  | **`apps/relic-hunter-server-v1` is a second full Rallar server**, not one extra call site: it calls `createDefaultRallarServer` (`main.ts:30`) and reads the same group rows through the same exact-key validator. Every required `Group` field and every stage-derived halt reaches it.                                                                                                                   | 2, 7         |
| C9  | **The operator surface is stage-blind.** `AdminSupportService.explainGroup` emits no lifecycle fact (`AdminSupportService.ts:700-750`), the formation metrics family has no bucket for stage commands or status writes (`group-formation-metrics.ts:1-9` — they all fall through to `other`), and the black-box workbench has no lifecycle collection. A stuck `planned` group is currently undiagnosable. | 13           |
| C10 | **The two shipped games mis-handle a halt.** `relic-hunters-v1/src/game/scene/networking.ts:340-372` sends per render frame and treats anything but `sent`/`partial` as failure with no back-off; `ar-eye-hunter-v1`'s arena helper maps unknown statuses through a `default` arm. A new `halted` status makes both spin.                                                                                  | 7 or 8c      |

## Decisions taken at planning (2026-08-22)

| #  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1 | **The rename lands first, alone, and mechanically.** `establishing → connecting` is one PR keyed on the _field name_ (`lifecycleState` / `GroupLifecycleState` / the `"lifecycleState"` JSON key), never on the value. `'active'` has 1,330 occurrences across seven meanings; `establishing` (the stage, 103) and `establishment` (the policy namespace, 388) are different words. Decision 14 forbids the shim that would stage it.                                                                                                                                                                                         |
| I2 | **Exhaustiveness becomes compiler-enforced before any new stage is reachable.** There is not one exhaustive `switch` and not one `Record<GroupLifecycleState, …>` in the repository; every consumer is a negative or equality comparison, so _adding_ three stages produces zero compiler errors and silently routes them down whichever branch the predicate picks. Slice 1b introduces one stage registry, derives the three untyped runtime validator arrays and `EVERY_LIFECYCLE_STATE` from it, and converts every stage predicate into a stage-keyed pure function returning exactly what the comparison returns today. |
| I3 | **Causal fences land early, not late.** `expectedFormationEpoch` and `expectedLayoutVersion` (decision 19) are retrofitted onto the existing criterion commands in slice 3, so every later internal family — triggers, status writes — is fenced from birth rather than twice.                                                                                                                                                                                                                                                                                                                                                |
| I4 | **The observed-status fields do not ride slice 2's field edit.** A status pinned at `inactive` on a live group for eight slices is a lie on the wire. The five-list edit is paid twice; new fields go last and wire order stays stable, so the second edit is cheap.                                                                                                                                                                                                                                                                                                                                                          |
| I5 | **The unit of PR is the lettered sub-slice; the unit of shippable capability is the numbered slice.** Thirteen slices deliver as roughly 22 PRs — the same granularity as the control-plane workstream's 6 slices in 14 PRs, at 1.5× the scope. Each sub-slice records its delivery PR number here as it lands.                                                                                                                                                                                                                                                                                                               |
| I6 | **Every slice's gates are named in its own section, not in an appendix.** Three gates are not in branch CI and are therefore invisible unless named per slice: `test:rallar:full-stack:memory:live-rtc-3`, the local medium-scale run, and **Run Hetzner Supported Distributed Manifests** (push-to-main only, required before the plan may be marked complete).                                                                                                                                                                                                                                                              |

## Slice 0 — Rebase and re-baseline (prerequisite)

This branch is three commits behind main: `197d5cad1` (admin mutation ownership explicit),
`211755a19` (semantic test design gate), `6078bc972`. Both named commits change the rules this
workstream must obey.

- `211755a19` makes a high-signal structural finding blocking for the **whole touched test file**,
  not only its changed lines. This workstream edits `webrtc-group-manager.test.ts` (945 lines), both
  mutation-route-owner test files (31 registered location-hashed exceptions between them), and
  `recipe-matrix.test.ts`. Escaping a block needs a registry entry with disposition
  `durable-boundary`, boundary `interaction`, and a linked contract carrying a five-key
  `interactionRequirement` (`scripts/test-structure-coupling-interaction-requirement.mjs`).
- `197d5cad1` adds `to-group-mutation-descriptor.ts` with `never`-guarded exhaustive switches every
  new stage command must enter — which is good news, and changes slice 5's plumbing shape.
- The state-write artifact schema moved v5 → v6, invalidating any baseline captured before it.

**Lands:** the rebase; a re-read of the new Semantic Test Design Gate; a fresh main-vs-main
state-write control run under v6 (the perf comparator fails main-vs-main on this machine without
one — the ±5% band is narrower than the observed drift).

**Gates:** `test:unit`, `test:deno`, `typecheck`, `typecheck:tests`, `test:repo-governance`,
`node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`, the state-write control.

**Risk:** skipping this is the largest schedule risk in the workstream. Also note: ~50
location-hashed registry entries sit on files this workstream must edit, they re-key on any line
shift, and the checker reads the registry from the head revision — the registry fix must be
committed before re-running it.

## Slice 1 — Contract closure (decision 21's first slice)

### 1a — The `establishing → connecting` rename

**Lands:** the single rename everywhere in one commit — the enum
(`group-lifecycle-policy.ts:3-7`); ~20 production comparison literals; the three untyped runtime
validators (`authoritative-state-validation.ts:441`, `group-state-delta.ts:193`,
`validate-persisted-group.ts:110`, each holding `['forming','establishing','active','reconfiguring']`
as a bare `readonly string[]`); both OpenAPI enum lines (`api-v1-openapi.yaml:4594`, `:4631`); 23
recipe assertions across 8 files; ~72 typed test literals; and the stage-derived identifiers in
recipes and routes (`/lifecycle/establish/`, `start-establishment-{runId}`).

**Dark:** nothing. The value is on the wire the moment a group establishes. That is why it goes
first and alone.

**Risk:** a value-keyed sweep damages unrelated code. Two legitimate English uses must survive
(`docs/test-structure-coupling-exceptions.md:1099`, `:1737`).

**Gates:** baseline + both black-box profiles (a partial landing fails at runtime in the recipes,
not at build time). No medium-scale — no mutation semantics change.

### 1b — Stage widening and the pure function library (dark)

**Lands:** `GroupLifecycleState` widened with `planned | paused | reconnecting`; the transition
table reshaped; and the pure library with its matrices, called by nothing.

`TRANSITION_TARGETS` (`group-lifecycle-transitions.ts:25-30`) is
`Readonly<Record<GroupLifecycleTransition, GroupLifecycleState>>` — one target per transition. It
cannot express `connect` landing in either `connecting` or `reconnecting`, nor `activate` landing in
the recorded return stage. **The table shape changes, not just its entries.**

The library: the 7-stage transition table with the return stage, the `connect` precondition
(decision 16), and C1/C2's epoch and landing rules; `resolveLayoutRole(publication, applied) →
applied | pending | superseded | incomparable`; `computeGroupDataGate(stage, returnStage,
preActivationAppData) → flows | blocked | halted` (decision 22); the total precedence-ordered status
function and the dwell/hysteresis evaluator (decisions 7, 9, 19) — total over business status ×
stage × expiry per C5; `computeLayoutStale(storedFingerprint, currentFingerprint)` (decision 11);
the in-flight axis on `computeOutboundDialPlan`; trigger evaluation (decision 8);
`validateExpectedFence` (decision 19); and the extended admission × stage table (C4).

**Dark:** all of it. Adding union members is unobservable while no transition produces them.

**Risk:** the highest-value, most easily missed work in the plan — see I2. Concretely,
`group-policy.ts:504` (`!== 'active'`) would keep application data flowing in a `paused` group under
the `allowed` policy: a decision-22 violation that compiles, typechecks and passes every existing
test. I2's conversion is what turns that class of bug into a compile error.

**Gates:** baseline + the headless bundle boundary (203 KiB brotli — this is a `packages/shared`
change even though it touches no browser file).

### 1c — Policy contract widening (dark)

**Lands:** `topology.replanning` (C3) and `topology.reconfigureLanding` on `GroupLifecyclePolicy`;
the establishment trigger config; the `Partial<>` input keys; the four preset values per decision 6;
clamps, issue codes, cross-field rules, the OpenAPI blocks, and the extended matrix test.

**Dark:** yes — there is no policy read-back HTTP surface and `updateGroup` excludes
`lifecyclePolicy` from both key registries, so preset values are inert until slice 10.

**Also close here:** the pre-existing hole the census found — `formation: 'phased'` with
`establishment.initiator: 'server-auto'` validates clean today and produces a permanently stuck
group. The trigger config closes it for automatic groups; the validator must still reject a phased
`server-auto` policy carrying no trigger, and `replanning: 'commanded'` with `server-auto` is the
new equivalent deadlock.

**Settle here**, so no later slice invents one under pressure: the debounce window, minimum layout
age, `after` settle time, presence fallback timer, per-preset `maxConcurrentEdgeSetups`, RTC setup
timeout, status dwell, and the `active ↔ degraded` hysteresis width — as clamped constants with
matrices.

**Gates:** baseline + `npx vitest run packages/tests/shared/group-lifecycle-policy.test.ts`.

## Slice 2 — Aggregate ownership fields (dark)

**Lands:** `appliedLayoutVersion` and the reconfiguration return stage as required `Group` fields
with creation values that are pure functions of what exists (`0`, `null`), threaded through **five
hand-maintained key allowlists that no compiler links and no test cross-checks**:
`authoritative-state-validation.ts:65`, `group-state-delta.ts:46`, `validate-persisted-group.ts:16`,
`group-state-persistence-codec.ts:25`, and the OpenAPI `Group.required` at `api-v1-openapi.yaml:4465`.
Plus `packages/tests/create-test-group.ts` (new fields go last, per its own comment), the exact
serialized-JSON pin at `group-state-inbox-transaction-result.test.ts:24`, and eight hand-written
full-`Group` literals under `packages/shared-rtc-bench/**` and `scripts/perf/`.

**Dark:** yes. Nothing reads or moves them; `compute-lifecycle-transition` carries them through via
`...stored.value`; the topology input fingerprint hashes an explicit allowlist so it does not
invalidate; and there is no DB migration — groups live as a JSON blob in
`runtime_state_store.store_value`.

**Risk:** (a) a half-finished list edit is a runtime throw on the group write path **and a silent
browser failure** — `group-state-delta-application.ts:38-45` swallows validation throws and degrades
to "ignore the delta"; (b) full `GroupSnapshot`s are embedded in durable queue rows and re-validated
with exact-key strictness on decode, so rows queued in a reused local Postgres throw on replay —
drop the database; (c) every persisted byte is counted by the state-write gate's
`sql.serializedResultBytes`, whose headroom over the ±5% band is ~2.3% given the recorded ±2.7%
drift.

**Also here:** a `keyof Group`-derived cross-check test for the four TypeScript lists — the only
structural record the aggregate has, since Prisma shows nothing. And C5's business-status × stage
rule.

**Gates:** baseline + both black-box profiles + **medium-scale** + state-write vs the slice-0
control. Add `apps/relic-hunter-server-v1` to the verification list (C8) and state the deploy order
for the two servers.

## Slice 3 — Causal fences on internal commands (decision 19)

**Lands:** `expectedFormationEpoch` and `expectedLayoutVersion` as required input on every internal
command, validated in `compute` against the durable group row, returning a typed stale outcome.
Retrofits the three criterion builders (`group-formation-mutation-command.ts:12,40,71`) and their
request id (`:95-101`).

**Dark:** no — and that is the point: today's silently-applied stale petition becomes a typed
rejection.

**Two traps.** (1) `requestId = commandId` in all three builders, so a record is stored and
`probeGroupMutationIdempotency` turns a same-id/different-hash petition into a 409. **Any field
added to `input` must also enter the id** — give it a version namespace (`formation-criterion:v2:…`)
including the layout version. (2) The existing fence in `create-formation-timer-work-handler.ts:55-58`
reads a _cached_ snapshot and is advisory; decision 19's fence belongs in `compute`.

Also needed: `assertExactKeys` on `GroupMutationFacts` (`compute-group-mutation.ts:128-145`),
`GROUP_MUTATION_INPUT_KEYS` and `GROUP_MUTATION_REQUEST_KEYS` rows — all three are exact-key
asserts, so a missing entry throws on every attempt and on replay of durable rows.

**Gates:** baseline + both profiles + **medium-scale** + state-write.
`api-v1-group-formation-criterion.json` is the only end-to-end pin of the arm-and-fire path and gains
a `stale-petition-fenced` leg. Write the first unit tests this path has ever had.

## Slice 4 — Server applied/pending layout ownership (the held-layout foundation)

The structural blocker, verified: `RtcTopologySnapshotRepository.snapshotKey(ref)` is
`groupStateGroupStorageKey(ref)` alone (`:205-207`) — **one never-expiring row per group**.
Publications are retention-bounded copies (24 h), not an archive. The accepted row _is_ what every
path converges on: replay returns `deliver-current`, the reconnect hydrator sends only
`findSnapshot(groupRef)`, and the criterion is petitioned against the just-planned candidate
(`create-rtc-topology-work-handler.ts:260`). All three would repair members onto the **pending**
layout and measure coverage on a layout nobody dials.

The identity trap, verified: **`appliedLayoutVersion` compared against `overlay.version` is not a
safe test.** `plan-rallar-rtc-topology-snapshot.ts:45` bumps version only when the hop map, kind,
name or degree changes, and `group-topology-planning-service.ts:337` gives the removed tombstone
`version: previous?.version ?? 0` — so an active layout at version N and its tombstone at version N
coexist with different content. The predicate is the causal tuple
`(sourceGroupStateCausalRevision, version)` plus `state`, and it must handle `incomparable`.
Publication delivery is also **not monotonic**: `computeStaleTopologyPublication` returns
`publish-superseded`, so a dominated candidate's publication can be broadcast after a newer one.

- **4a — the applied-layout store.** A second durable row mirrored on every acceptance, plus the
  layout-role classifier behind a read-only accessor. Dark. Copy the applied layout's input
  fingerprint here (slice 10 needs it). Carries the state-write gate for the extra write.
- **4b — the stage-keyed planning gate** replacing `isGroupTopologyPlannableAt`: `forming` publishes
  nothing, `planned` plans and publishes a **held** layout. Observable. Owns C6's five stage-blind
  topology write paths. Settle Q7 first (does `forming` keep publishing today's removed tombstone —
  `api-v1-group-lifecycle-transitions.json:197` pins that it does).
- **4c — delivery correctness:** replay's `deliver-current`, the reconnect hydrator, and the
  criterion petition all pinned to the applied layout; `GroupTopologyManagementView` carrying both.
  Owns C7's departure rule.

**Note** `select-group-topology-planning-snapshot.ts` is under a git-history-pinned 100-column cap
(`group-topology-capability-source-style-snapshot.test.ts`), and no topology test file under that
root may be renamed, merged or deleted.

**Gates:** baseline, both profiles, **medium-scale**, `topology-replay`, state-write,
`test:integration:postgres`.

## Slice 5 — The stage command family: `plan`, `connect`, `pause`, `resume`

Per-command cost is the ~15-registry census: a new `AppInboxType`; a payload type and an
`AUTHENTICATED_GROUP_INBOX_TYPES` entry; a `GroupMutationCommand` union member; a
`to-lifecycle-mutation-command` case; the `toDescriptorCommand` and `toGroupMutationDescriptor`
switches; the `GROUP_APP_INBOX_OPERATIONS` Map; `GROUP_MUTATION_OPERATIONS` and
`AGGREGATE_GROUP_MUTATION_OPERATIONS` Sets; `GROUP_MUTATION_INPUT_KEYS` and
`GROUP_MUTATION_REQUEST_KEYS` rows; `LIFECYCLE_TRANSITION_BY_OPERATION`;
`GroupLifecycleTransitionOperation` (an `Extract` over four literal names at
`group-mutation-contracts.ts:395`, feeding six behavioural registries); an HTTP route and its
OpenAPI path; a `mutation-routing-owner-inventory.ts` row with verbatim AST markers; and the ordered
Hono route-table assertion.

**Roughly half is compiler-caught** (`LIFECYCLE_TRANSITION_BY_OPERATION` is `satisfies Record<…>`,
`toGroupMutationDescriptor` now has `never` guards after `197d5cad1`, `GROUP_MUTATION_INPUT_KEYS` is
a `Record`). **The other half is silent:** `GROUP_APP_INBOX_OPERATIONS` is a `Map` whose miss makes
`toStableGroupCommand` return `undefined` and silently change the canonical command hash;
`toDescriptorCommand` has a `default:` arm that misroutes an unlisted operation into the _membership_
builder; `GROUP_MUTATION_OPERATIONS` is an untyped `Set` of bare strings.

- **5a — all four commands' plumbing, dark**: registered on no route, emitted by no producer.
- **5b — `plan` and `connect` on HTTP**, with the applied-layout write and the typed
  no-pending-layout denial (needs 4b). Extend `api-v1-recipe-idempotency-cutover.test.ts`'s
  `mutationRoutes` here — until then recipes on the new paths are silently outside the strict
  request-identity gate.
- **5c — `pause` and `resume` on HTTP**, plus the recorded return stage and C1's epoch rule.

Decision 12 keeps one initiator policy, so `canCommandGroupLifecycleTransition` needs no per-command
branch. Every new stage command inherits the slow sequential read path
(`read-group-mutation.ts:27-29`), and the read step and its validator apply that predicate
independently — a one-sided edit throws at compute.

**Gates:** baseline, both profiles, **medium-scale**, state-write, and the hard-coded counters:
`mutation-routing-inventory.ts:71-76` (`!== 56`, `!== 52`),
`api-mutation-openapi-contract.test.ts` (`length, 47`), `api-v1-recipe-idempotency-cutover.test.ts`
(`toHaveLength(47)`), and the route-count strings inside `register-group-state-routes.test.ts` test
titles.

## Slice 6 — `reconfigure` as a stage command with `landing` (decisions 5, 23)

**The sharpest hazard in the plan:** two mutations already exist for one product "reconfigure".
`GroupTopologyReconfigureMutation` advances the group authority fence and writes an APP_OUTBOX entry
— and never touches `lifecycleState`. Lifecycle transitions live in `compute-lifecycle-transition.ts`.
The stage-level `reconfigure` must set the stage, the landing and the recorded origin **atomically
with** the outbox enqueue, or a crash between them leaves a group in `reconfiguring` with no topology
work queued and no way out. **Q4 blocks this slice.**

Secondary: `validate-computed-group-mutation-write.ts:332` asserts
`outboxEntries.length === 1 + expectedTimerEntries.length` and `jsonEquals` each entry against a
re-derivation; `validate-group-mutation-result.ts:199` requires every outbox id after the first to
start with `ft-`. A merged mutation widens both.

Split 6a (merge-or-sequence, landing always `hold`) from 6b (`landing: 'apply'` and the return
stage) — 6a is where the atomicity argument lives.

**Gates:** baseline, both profiles, **medium-scale**, state-write, `topology-replay`.

## Slice 7 — The data gate: one rule, two cases (decisions 22, 23)

Two lines invert together: `group-policy.ts:502-510`
(`preActivationAppData === 'blocked-until-active' && lifecycleState !== 'active'`) and
`ws-topic-room-authorizer.ts:132` (`lifecycleState === 'active' || !readPreActivationAppData` →
skip the policy read). Under decision 22 the policy read set actually **shrinks**: `paused` halts
under every policy so needs no read, and a `reconfiguring` of active origin needs none either.

**Q3 blocks this slice.** `canSendRoomMessage` has a second, non-WS caller —
`apps/relic-hunter-server-v1/src/relic-rest-auth.ts:56-69` — passing no `preActivationAppData`, so
the gate branch never fires there today. Folding a policy-independent halt into the shared predicate
makes every Relic Hunters REST command on a paused group return 403 (C8). **Recommended:** keep
`canSendRoomMessage` as the policy predicate and put the stage-derived halt at the relay's own choke
point.

The halt is exactly as complete as `isRoomScopedALMessage`: reserved system topics bypass the
authorizer entirely and `AppTopics.chat` broadcasts application payloads with zero authorization
(`ws-system-topics.ts:380-391`). And `forwardsRoomScopedMessages` defaults **true** with exactly one
disabling site — the permissive-by-default boolean that already caused this bug class once
(control-plane decision 5.9). Extend `packages/tests/shared/ws-server-qos-policy.test.ts:553` to
assert a halted room-scoped message is not forwarded by the ALM path either.

C10's game handling lands here or in 8c — decide which, and do not ship a status the games map to
`failed`.

**Gates:** baseline, both profiles, **medium-scale**, `test:deno` (the api-v1 authorizer test is
Deno-only), and `api-v1-group-data-policy.json` extended with `pause-resume` and
`reconfigure-while-paused`.

## Slice 8 — The browser: applied/pending layouts, the dial gate, the facade

**This is greenfield, not modification.** `rg lifecycleState packages/shared-web` returns nothing;
`rg lifecyclePolicy packages/shared-web` returns nothing; there is no `room.formation` surface.

Four verified facts shape it:

1. The overlay repository is a **single-slot** TTL'd latest-value store, and `setOverlayById`
   **throws** `OverlayRevisionConflictError` on `incomparable` and on equal-tuple-different-content
   — called from the WS handler with no try/catch (`data-caches.ts:264-271`).
2. **The facade does not use the overlay at all.** `resolveRoomPeerIds` is
   `resolveActiveRoomPeerIds(session, snapshot)` over `snapshot.activeSessions`
   (`packages/shared-web/browser/rallar-runtime/realtime.ts:792`, bound at
   `rallar-runtime/composition/browser-runtime-composition.ts:142`), and `realtime.room().send()`
   defaults `connect: true` and calls `ensurePeerLaneOpen` on every active session — dialing
   straight past `WebRtcGroupManager` and `computeOutboundDialPlan`. There are **five outbound dial
   entry points** plus inbound `acceptPeerIfAbsent`, so "dialing is a pure function of the stage" is
   unenforceable at one place today.
3. `targetPeerIdsForGroup` falls back to the full active-session bootstrap whenever no overlay
   exists (`WebRtcGroupManager.ts:461-470`).
4. **Inbound admission currently accepts peers in no layout**: `toBrowserRtcInboundPeerCreationDecision`
   returns `tentative` when _not_ owned by any group, so an empty applied layout **permits** peer
   creation rather than blocking it.

- **8a — the two-slot overlay cache** and `layoutReceived` / `layoutApplied`, with every existing
  reader explicitly pinned to the applied slot so behaviour is identical; wrap `setOverlayById` so an
  `incomparable` pending arrival is a drop, not a throw on the WS handler.
- **8b — the dial gate and bootstrap suppression**, including the inbound admission deny keyed on
  the stage. Without that, a lagging peer's offer still creates connections and
  `discovery-holds-dials` fails.
- **8c — the room facade:** readiness on the applied layout, the local halt with its typed status,
  and `game/match.ts`'s exhaustive mapping and `sendJson` fallback updated together.

**Blast radius:** repointing readiness from active sessions to the applied layout changes
`waitForRoomLane`'s `{exact: peerIds.length}` expectation for ar-eye-hunter-v1, relic-hunters-v1,
rallar-black-box and `shared-web/game/match.ts`. And `match.ts:514-517` falls back to
`realtime.sendJson` with explicit peer ids, routing around any room-level halt.

**Gates:** baseline + the shared-web trio (`shared-web-public-api-snapshots.test.ts`,
`shared-web-browser-bundle-boundaries.test.ts`, `check:browser-bundles`), the headless bundle
boundary, `test:e2e`, `test:full-stack:memory`, and **`test:rallar:full-stack:memory:live-rtc-3`**,
which branch CI does not run.

## Slice 9 — In-flight pacing (decision 18, R7)

Three prerequisites are missing: (1) `ensurePeerConnectionStarted` returns `Either.ofRight(peerDto)`
whether or not it decided to connect — `shouldConnect` is private, so `connectAttemptCount` already
counts idempotent ensures; (2) there is **no success callback** — `OnRtcPeerLifecycleCallback` has
`onCreated`/`onDeleted`/`onConnectTimeout?`/`onConnectExhausted?` and nothing for established;
(3) there is **no wire path for the bound** — `GroupSnapshot` carries no policy (**Q2**).

A fourth structural gap: `runReconcilePass` flattens all groups into one desired-peer set via
`peerOwners()`, so there is no per-group loop for a per-group bound, and a peer owned by two groups
needs an ownership tie-break the code does not have.

- **9a — truthful RTC lifecycle signals** (surface attempt-started, add an established callback).
  Dark, additive, independently valuable. Settle Q2 here.
- **9b — the per-group bound, wake-on-completion, and the 6/20/50 sweep.**

**Pacing is literally unobservable until the harnesses change:**
`group-formation-simulation-clients.ts:52-58` and `createRtcQBoxHarness` both stub
`ensurePeerConnectionStarted` as immediately successful. Rewrite them with a completable
asynchronous dial **before** 9b. Also `DEFAULT_WEB_RTC_PEER_ESTABLISHMENT_TIMEOUT_POLICY` is
`enabled: false` by default, so "timeout ends an attempt" is off in any directly-constructed service.

**Gates:** baseline, shared-web trio, headless bundle boundary, `test:full-stack`, the live-RTC
suite; and for `pacing-sweep`, the Hetzner manifest family — generated code with a byte-exactness
test, literal path lists, participant-count-in-filename validation and an explicit RTC-readiness
requirement.

## Slice 10 — Replanning modes and landing go live (decisions 2, 5, 6)

The two footings are asymmetric. `debounced` has real machinery —
`computeCoalescedRtcTopologyGroupRevisionWork`, `DEFAULT_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS = 500`, a
generation-CAS merge — but its window is a server option, not per-group policy. **`commanded` has no
suppression point at all**: `group-presence-summary-work.ts:198-208` unconditionally enqueues
coalesced topology work on every accepted group revision.

`layoutStale` needs a new dependency edge: the input fingerprint computes exactly decision 11's
authority, but it is reachable only through `RtcTopologyExecutionRepository`, and
`GroupTopologyManagementServiceOptions` has no such dependency. Copy the applied layout's fingerprint
at apply time in 4a rather than reconstructing it here.

Split 10a (`commanded` + `layoutStale` on the formation view = the `commanded-evolution` scenario)
from 10b (`debounced` per-group windows and minimum layout age). This is where decision 6's preset
values become behavioural and silently re-aim `api-v1-match-preset.json` and both managed-burst
recipes.

**Gates:** baseline, both profiles, **medium-scale**, state-write (possibly a registered regression
reason — `api-v1-state-write-regression-reasons.ts` throws on any unknown profile),
`topology-replay`, `formation-large`.

## Slice 11 — Automation triggers (decisions 4, 8)

The timer work is larger than the product plan's costing. `GroupFormationTimerWork` carries
`kind: 'deadline' | 'retry'` only; the resource id is
`ft-${kind}-${formationEpoch}-${fnv1a64(contextId)}` with **no layout version and a 36-char cap that
silently truncates**; `computeExpectedFormationTimerEntries` in the write validator is a byte-exact
recomputation mirror. Each new trigger kind needs a union member, a decoder literal, an arming site,
a consumer branch, a petition builder, a fence, and a mirror entry.

**A timer entry key is not re-armable**: `writeIfAbsentOrMatch` throws
`ResourceInboxInvariantCorruptionError` unless resource, creator, created and expire timestamps all
match byte-for-byte — so a trigger whose due time moves must use the coalesced replacement path, not
the formation-timer shape. And an outbox entry whose typeId has no registered handler throws on every
dequeue and burns to FAILED, while the FORMATION_TIMER handler registration is _conditional_
(`ws-system-topics.ts:162`) and its entries are written unconditionally.

The `presence` trigger is a different problem: `GroupPresenceSummaryWork` has no policy read and no
submit port, and is constructed _before_ the `AppGroupInboxService` that owns
`enqueueFormationCriterionCommand` (`create-api-v1-mutation-runtime.ts:292` vs `:307`). Under the
visible-construction rule that is a restructure, not plumbing. Its `compute` is validated by a
byte-exact mirror, so nothing it adds may capture wall-clock.

A new internal authority mode is mandatory: `validateTrustedAuthorityMode` limits
`formation-criterion` to three operations and throws for anything unlisted.

Split 11a (`immediate`/`after` via the durable timer path) from 11b (the `presence` trigger with its
construction restructure and its own state-write verdict). **Write the first unit tests this surface
has ever had in 11a.**

**Gates:** baseline, both profiles, **medium-scale**, **state-write**, `formation-large`.

## Slice 12 — The living observed status (decisions 3, 7, 9, 13, 19)

**This goes last because of write amplification, and the arithmetic is verified.** A 50-session
group produces up to ~3,000 accepted RTT mutations per minute (50 sessions × degree limit 5 ÷ 5 s
ping). Between evidence and a petition sit exactly two dampers — the RTT refinement gate (30 s) and
the criterion petitioner's 1 s window — and **both are process-local `Map`s**, so an N-node cluster
multiplies both ceilings by N (**Q6**).

Each status write is not one row: it CASes the group, writes a durable event, enqueues a
presence-summary expansion, and fans a delta to every connected session. And the group row is
currently **quiet** during `active` — presence guards on `kind: 'presence'` and never CASes it — so
a status writer at 60/min contends with exactly the two things a lobby does most: joins and the
operator's own stage commands.

The guard that must not be casually removed: `compute-formation-criterion-command.ts:43` and `:199`
refuse outside establishment, which is why there are zero evaluations per minute in `active` today.
Widening them is what turns zero into the ceilings above.

The idempotency trap: `groupFormationCriterionRequestId` keys on `(decision, groupRef,
formationEpoch)` _deliberately_, so a race resolves to one transition. A status command keyed the
same way makes `active → degraded → active` within one epoch a replay of the first write, leaving
the group permanently `degraded`. Give the status command id a monotonic component.

- **12a — the field, the event, and read-derived reporting**: the status and its basis added to the
  five key lists (I4's second edit), `group-activation-status-changed` registered at its six sites
  (only `persisted-group-event.ts`'s `Record<GroupEventType, true>` is compiler-checked), and the
  status reported on the formation view **derived at read** — written only by transitions that
  already CAS the row. No new writer, no amplification.
- **12b — the internal status writer** with dwell, hysteresis and durable clocks. Design its damping
  to survive a multi-node cluster before writing it.

**Keep the fingerprint skip at `create-rtc-topology-work-handler.ts:246-254` intact** — it is the
only thing stopping status → topology work → petition → status from becoming a self-sustaining loop.

**Gates:** baseline, both profiles, **medium-scale**, **state-write**, `formation-large`, plus the
`status-lifecycle` and `status-on-connect` recipes.

## Slice 13 — Operator and observability surfaces (C9)

**Lands:** the stage, epoch, applied/pending layout versions, observed status and data-gate verdict
in `AdminSupportService.explainGroup`'s `groupFacts` / `groupWarnings` / `groupLikelyCauses`; new
`GROUP_FORMATION_OPERATION_KINDS` buckets (`stageTransition`, `activationStatus`) so the new write
volume is visible in the burst artifacts instead of hiding in `other`; and a
`group-lifecycle-stages` workbench collection plus a stage column in the black-box rooms diagnostic.

**Order:** the metrics buckets must land **before** slice 11 or 12 enables any automatic writer.
The diagnostic surfaces are also the cheapest way to drive pause/resume and held reconfiguration
manually before the live-RTC specs exist.

**Gates:** baseline, `test:e2e`, `test:repo-governance`.

## Slice 14 — Finalisation (decision 14)

**Lands** the state decision 14 defines completion by. Specifically: the architecture doc rewritten
(`docs/rallar-group-formation-architecture.md`, 852 lines, linked from `docs/README.md:81` and
`docs/rallar-rtc-rtt-reporting.md:46`); `docs/rallar-api-reference.md` and
`docs/rallar-quickstart-and-recipes.md`, both **machine-checked** by
`packages/tests/shared-web/rallar-group-docs-compat.test.ts` for exact backticked phrases including
every `GROUP_POLICY_REASON_CODE`; the `examples/**` READMEs and the `building-rallar-apps` /
`rallar-realtime` skills, pinned by `rallar-skill-app-examples-integrity.test.ts`; the OpenAPI
`GroupPolicyReasonCode` enum (already **6 codes behind** the TypeScript const, with no test coupling
them); and the fourteen acceptance scenarios registered in `recipe-matrix.json` plus both
hand-maintained sorted id lists in `recipe-matrix.test.ts`.

**Split the behavioural half out:** the reader-default removal at
`group-state-persistence-codec.ts:88-99` — where six formation fields go through `persistedOrDefault`
with legacy fallbacks, exactly what decision 14 forbids — is a behaviour change and belongs in
whichever earlier slice last touches that codec (2 or 12a), with its gates. Finalisation must not be
where an untested behaviour change hides.

**Gates:** the plan-completion set — `test:unit`, `test:ci`, `build`, the **Branch Release Gate** on
the final feature-branch commit, and **Run Hetzner Supported Distributed Manifests** on the resulting
default-branch commit.

## Gate assignment

Every slice carries the baseline: `format:check`, `check:repo-style:changed -- origin/main HEAD`,
`typecheck`, `typecheck:tests`, `test:unit`, `test:deno`, `build`.

| Gate                                                              | Slices                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| **medium-scale** (`test:api-v1:black-box:postgres:medium-scale`)  | 2, 3, 4b, 4c, 5a, 5b, 5c, 6, 7, 10, 11a, 11b, 12a, 12b |
| **state-write** (`perf:api-v1:state-write` + comparator)          | the same fourteen                                      |
| shared-web trio + `check:browser-bundles`                         | 8a, 8b, 8c, 9a, 9b                                     |
| headless bundle boundary (203 KiB brotli)                         | every `packages/shared` change — including 1b          |
| `topology-replay`                                                 | 4a, 4b, 4c, 6, 10                                      |
| `formation-large`                                                 | 10, 11, 12                                             |
| **`test:rallar:full-stack:memory:live-rtc-3`** (not in branch CI) | 8b, 8c, 9b — and it is where five plan scenarios live  |
| Hetzner distributed manifests (push-to-main only)                 | before the plan may be marked complete                 |

The medium-scale gate also **auto-triggers** on PRs touching `apps/api-v1/**`,
`packages/shared/**`, `packages/shared-server/**` or the black-box runner — which is nearly every
slice — so it runs whether or not a slice names it. Never weaken its constants or assertions.

Also standing, and named by no lens until now: `npm run pr:delivery -- status` before broad final
validation, `npm run check:repo-structure`, and `npm run check:retained-legacy` — if any slice needs
a temporary dual-read or dual-write, that is a retained-legacy decision requiring a registry entry
and human approval, not an implementation detail.

The distributed-validation risk classifier is **path-based**
(`scripts/distributed-validation-risk/distributed-validation-risk.mjs:212-244`) and matches
`packages/shared/rtc`, `packages/shared/webrtc`, `rallar-system/topology/**` and browser rtc/realtime
files. Sequence merges deliberately so the Hetzner run is paid once per foundation, not once per file
touch.

## Questions to settle at slice planning

Each becomes a numbered decision here the moment it is taken, with its alternatives — the way the
control-plane plan's decisions 4.1, 5.1 and 5.9 remain the only written record of why that code looks
as it does. **Q1, Q3 and Q4 block their slices.**

| #  | Question                                                                                                                                                                  | Slice   |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Q1 | Where the applied layout's **content** lives — a second never-expiring row, or a pointer into publications that expire at 24 h and cannot survive a thousand-session hold | 4a      |
| Q2 | How `maxConcurrentEdgeSetups` reaches the browser: a required `Group` field mirroring the policy, a formation-view read, or the policy on the snapshot                    | 9a      |
| Q3 | Whether the halt lives in the shared `canSendRoomMessage` or only at the WS relay (Relic Hunters REST is the difference)                                                  | 7       |
| Q4 | Whether the two `reconfigure` mutations merge or sequence, and how the lifecycle write and the outbox enqueue stay atomic                                                 | 6a      |
| Q5 | ~~Whether the status fields ride slice 2's edit~~ — settled as I4: they do not                                                                                            | settled |
| Q6 | How the status writer damps across a multi-node cluster, given both existing dampers are process-local                                                                    | 12b     |
| Q7 | Whether `forming` keeps publishing a removed tombstone to every session (it does today, and a recipe pins it)                                                             | 4b      |
| Q8 | The `pending` name collision on `GroupTopologyManagementView`, which already means "reconfigure queued"                                                                   | 10      |
| Q9 | `mutationDescriptor` already takes six positional parameters against a three-parameter standard; a seventh needs a ~22-call-site refactor instead                         | 5a      |

## Validation

Per slice: focused unit matrices first, then the surface's own tests, then the recipes, then the
gates named in that slice's section. Report every command as passed, failed or skipped.

Whole-workstream acceptance is the product plan's fourteen named scenarios, plus the two invariants
asserted at every slice boundary. The plan may be marked complete only after the final working tree
passes `test:unit`, `test:ci` and `build`, plus the Branch Release Gate on the final feature-branch
commit and Run Hetzner Supported Distributed Manifests on the resulting default-branch commit — and
any change after a passing gate invalidates it.

## Deferred, explicitly

- Per-edge confirm-or-fail establishment (`strictConfirmation`), `group_batch`,
  `ASYNC_REMOTE_QUEUE`, commanded-edge retention, command-origin validation — the product plan's
  own deferral, unchanged.
- The `elected-by-rank` rank source, inherited unresolved from the control-plane workstream.
- Typed policy-validity rejections over HTTP and typed WS NACK reasons — both still deferred; the
  halted case adds a third reason code that is HTTP-only for the same reason.
- A policy-update surface. Every field remains write-once at creation.
