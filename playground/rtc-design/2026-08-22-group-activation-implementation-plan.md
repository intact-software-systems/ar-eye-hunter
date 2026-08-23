# Group Activation — Implementation Plan (2026-08-22)

Status: **planning — re-baselined 2026-08-23 against `main` at `f26f65685`. All ten corrections are
resolved: C1–C4 became product decisions 25, 28, 2 and the admission table; C5–C10 remain as
additions with owning slices. Six questions remain, of which Q3 and Q4 block their slices.**
Implements `2026-08-22-group-activation-product-plan.md` (decisions 1–34). That document owns the
product surface; this one owns how it lands. It does not restate the product decisions — it records
what the code says about them, what has to change, in what order, and which gate proves each step.

Every claim below was verified against the tree by a ten-surface code census on 2026-08-22 and
re-verified against `f26f65685` on 2026-08-23. **Citations name a symbol wherever a symbol will do,
and a `file:line` only where the line itself is load-bearing.** That is a deliberate change: between
the two passes, `main` moved five commits and two of them were large refactors, which invalidated 18
of 64 line citations while leaving almost every symbol name intact.

## The properties that make this shippable

**First — `formation: 'immediate'` creates the group `active`, so the absent policy and the
`optimistic` preset behave exactly as they do today** (product decision 17). One line carries it,
`create-initial-group-mutation.ts:40`:

```ts
lifecycleState: command.input.lifecyclePolicy?.formation === 'phased' ? 'forming' : 'active',
```

**70 checked-in Hetzner manifests and 58 RTC recipes create groups with no `lifecyclePolicy`**, and
no application, game or manifest passes one at all — the lifecycle's entire live user base is nine
black-box recipes. All of them depend on absent policy → `optimistic` → `immediate` → the browser's
bootstrap dial. Any slice that suppresses bootstrap dialing without keeping that path intact breaks
the entire distributed lane silently.

Product decision 27 is what makes this structural rather than something a recipe must police: an
`apply` landing performs no lifecycle transition, so an `optimistic` group never leaves `active` in
the first place. The alternative was verified to break parity outright — `optimistic` is
`activation.mode: 'manual'`, and `evaluateGroupActivationCriterion` returns `wait` unconditionally
for manual before evaluating anything, so a group pushed out of `active` by its first join could
never return.

**Second, inherited from the control-plane workstream:** membership, presence, admission and WS
connectivity work in every stage, including `planned`. Its test constant `EVERY_LIFECYCLE_STATE`
(`group-lifecycle-safety-baseline.test.ts:17`) is a hand-written four-element literal — it will
silently keep covering four of six unless slice 1b makes it compiler-derived.

**Third, new in this pass:** no stage command is reachable over HTTP until the browser honours its
dial and data consequences. This is what slice 8d exists to enforce.

Every slice's PR description states how it preserves all three. A slice that cannot is wrong.

## Slice 0 — Rebase and re-baseline (prerequisite)

This branch was three commits behind when the plan was written and is now **five**:

| Commit      | What it did                                                       | Consequence for this plan                                                                   |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `211755a19` | semantic test design gate                                         | structural findings are blocking for the whole touched test file                            |
| `197d5cad1` | admin mutation ownership explicit                                 | adds `never`-guarded exhaustive switches every stage command must enter                     |
| `6078bc972` | test fix                                                          | —                                                                                           |
| `c9fc2ce9b` | **#319 — rallar-system ownership traceable (889 files)**          | moved 4 cited paths, deleted 5, renamed 3 load-bearing symbols                              |
| `f26f65685` | **#317 — API-v1 operational configuration ownership (255 files)** | restructured the configuration surface; `formationDebounceMs` is now `topology.recompute.n` |

`211755a19` makes a high-signal structural finding blocking for the **whole touched test file**, not
only its changed lines. This workstream edits `webrtc-group-manager.test.ts`, both mutation-route-owner
test files, and `recipe-matrix.test.ts`. Escaping a block needs a registry entry with disposition
`durable-boundary`, boundary `interaction`, and a linked contract carrying a five-key
`interactionRequirement`.

**Three renamed symbols matter more than any moved path**, because a moved file is found by basename
search while a renamed symbol silently reads as still-present:

| Was                                | Is                                                                     | Owning slice |
| ---------------------------------- | ---------------------------------------------------------------------- | ------------ |
| `canSendRoomMessage`               | `canSendGroupMessage`, in `group-state/policy/group-message-policy.ts` | 7            |
| `AppGroupInboxService`             | `GroupStateInboxService`, in `group-state/inbox/`                      | 11           |
| `AdminSupportService.explainGroup` | `GroupAdminSupport.explainGroup`, in `admin-support/`                  | 13           |

Two items **evaporated** and their slices get cheaper: `PERSISTED_GROUP_KEYS` was deleted, so
`group-state-persistence-codec.ts` is 49 lines rather than 328 and carries no `persistedOrDefault`
legacy path at all — which removes slice 14's only behavioural item and one of slice 2's five key
lists. And #319 deleted the git-history-pinned 100-column guard test slice 4b was budgeted against.

**Lands:** the rebase; a re-read of the Semantic Test Design Gate; a fresh main-vs-main state-write
control run captured **after** the rebase onto `f26f65685`, not before.

**Also note:** `main` currently fails `format:check` — `f26f65685` landed seven unformatted files.
Until that is repaired on `main`, every branch gate in this workstream is red for a reason that has
nothing to do with the branch. Do not "fix" it inside a slice: a repository-wide reformat is the one
thing that earns the `skip-changed-gates` label, and mixing it into a feature slice forfeits that.

**Gates:** `test:unit`, `test:deno`, `typecheck`, `typecheck:tests`, `test:repo-governance`,
`node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`, the state-write control.

**Risk:** skipping this is the largest schedule risk in the workstream. ~50 location-hashed registry
entries sit on files this workstream must edit, they re-key on any line shift, and the checker reads
the registry from the head revision — the registry fix must be committed before re-running it.

## Corrections — resolved

Four corrections changed a recorded product decision and have been ruled on. They are recorded here
only so the reasoning survives; the product plan is now the authority.

| #  | What the code said                                                                                                                                                                                                                                            | Ruling                                                                                                                                                                                |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | Every accepted transition returns `formationEpoch + 1` and unconditionally re-pins `formationElectorate`. Manager election is epoch-keyed and every formation timer entry is epoch-keyed, so `pause` would re-elect the manager and orphan every armed timer. | **Moot.** Product decision 25 takes halting off the routing plane entirely, so `pause`/`resume` are not transitions and advance nothing.                                              |
| C2 | `fail-formation → forming` from a live group would drop its accepted layout, re-open a `closed` lobby and re-block application data, and the retry leg would dead-end in `planned`.                                                                           | **Product decision 28.** Failure discards the planned layout and returns to `active`; only a failed first establishment lands in `forming`. `plan` becomes idempotent from `planned`. |
| C3 | `evolvePlannedTopology` already owns "evolution" one directory away and means incremental graph update.                                                                                                                                                       | **Product decision 2**, renamed to `topology.replanning`.                                                                                                                             |
| C4 | `computeGroupAdmissionDecision` evaluates windows first and applies `manager-approval` parking in every stage, so all four modes keep admitting through a hold.                                                                                               | **Product plan admission table**, extended to all four modes, plus the stage-current staleness rule.                                                                                  |

## Additions the plan did not cover

| #   | Gap                                                                                                                                                                                                                                                                                                                                          | Owning slice |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| C5  | **Business status × stage is undefined.** `updateGroup` archives and deletes without touching `lifecycleState`, while every transition asserts active business status first. An archived, deleted or expired group in `planned` has no defined condition and no defined accepted layout.                                                     | 1b, 2        |
| C6  | **Five stage-blind topology write paths bypass the held layout**: the topology `reconfigure` route and the config and override `PUT`/`DELETE` pairs in `graph-topology-routes.ts` all enqueue recompute work with `publish: true` and check only business status. Under `commanded` replanning they would publish a layout nobody asked for. | 4b           |
| C7  | **Departures are not defined under held and `commanded` replanning.** Presence expiry and session cleanup always flow into a replan today. A `match` group whose player crashes must not sit silently on a layout naming a dead session — under product decision 30 it reads `degraded` / `awaiting-application`.                            | 4c, 10a      |
| C8  | **`apps/relic-hunter-server-v1` is a second full Rallar server**, not one extra call site: it calls `createDefaultRallarServer` and reads the same group rows through the same exact-key validator. Every required `Group` field and every stage-derived halt reaches it.                                                                    | 2, 7         |
| C9  | **The operator surface is stage-blind.** `GroupAdminSupport.explainGroup` emits no lifecycle fact, the formation metrics family has no bucket for stage commands or status writes, and the black-box workbench has no lifecycle collection. A stuck `planned` group is currently undiagnosable.                                              | 13           |
| C10 | **The two shipped games mis-handle a halt.** Relic Hunters' networking sends per render frame and treats anything but `sent`/`partial` as failure with no back-off; AR Eye Hunter's arena helper maps unknown statuses through a `default` arm. A new halted status makes both spin.                                                         | 8c           |

## Decisions taken at planning

| #  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1 | **The rename lands first, alone, and mechanically.** `establishing → connecting` is one PR keyed on the _field name_ (`lifecycleState` / `GroupLifecycleState` / the `"lifecycleState"` JSON key), never on the value. `'active'` has 1,330 occurrences across seven meanings; `establishing` (the stage) and `establishment` (the policy namespace) are different words. Product decision 14 forbids the shim that would stage it.                                                                                                                                                                                         |
| I2 | **Exhaustiveness becomes compiler-enforced before any new stage is reachable.** There is not one exhaustive `switch` and not one `Record<GroupLifecycleState, …>` in the repository; every consumer is a negative or equality comparison, so _adding_ two stages produces zero compiler errors and silently routes them down whichever branch the predicate picks. Slice 1b introduces one stage registry, derives the three untyped runtime validator arrays and `EVERY_LIFECYCLE_STATE` from it, and converts every stage predicate into a stage-keyed pure function returning exactly what the comparison returns today. |
| I3 | **Causal fences land early, not late.** `expectedFormationEpoch` and `expectedLayout` (product decision 19) are retrofitted onto the existing criterion commands in slice 3, so every later internal family — triggers, status writes, the internal `connect` — is fenced from birth rather than twice.                                                                                                                                                                                                                                                                                                                     |
| I4 | **The status axes do not ride the aggregate's first field edit.** A condition pinned at `inactive` on a live group for eight slices is a lie on the wire. The key-list edit is paid twice; new fields go last and wire order stays stable, so the second edit is cheap.                                                                                                                                                                                                                                                                                                                                                     |
| I5 | **The unit of PR is the lettered sub-slice; the unit of shippable capability is the numbered slice.** Thirteen numbered slices plus finalisation deliver as **26 PRs** for slices 1–13, or **28** including slice 0 and slice 14 — a numbered slice that carries no letters is itself one PR, which is where the earlier figure of 22 went wrong. Each sub-slice records its delivery PR number here as it lands.                                                                                                                                                                                                           |
| I6 | **Every slice's gates are named in its own section, not in an appendix.** Three gates are not in branch CI and are therefore invisible unless named per slice: `test:rallar:full-stack:memory:live-rtc-3`, the local medium-scale run, and **Run Hetzner Supported Distributed Manifests** (push-to-main only, required before the plan may be marked complete).                                                                                                                                                                                                                                                            |
| I7 | **A persisted field lands with its first reader.** The control-plane workstream recorded this as its own slice-1 lesson: _"Persisting a document nothing reads would put an AppInbox mutation-path change into a slice that otherwise carries no risk. It lands with its first reader."_ So slice 2's aggregate fields merge in the **same PR as slice 4a**, which is what first reads them. That pays medium-scale and state-write once instead of twice, and removes the only dark-plumbing hazard in the plan.                                                                                                           |
| I8 | **Route mounting is its own sub-slice, and it comes last.** The stage commands' plumbing, persistence and semantics land dark across slices 5 and 6; slice 8d mounts all five HTTP routes in one PR, after slice 7's halt and slice 8b's dial gate and inbound-admission deny exist. In parallel, `validateGroupLifecyclePolicy` returns a typed issue for the new policy fields until the vertical passes live-RTC-3 — one issue code, one file, the same shape the repository already ships for `strictConfirmation`.                                                                                                     |
| I9 | **Citations name symbols, not lines.** Between the two census passes `main` moved five commits and invalidated 18 of 64 line citations while leaving nearly every symbol name intact. Exported symbols and test constants (`EVERY_LIFECYCLE_STATE`, `TRANSITION_TARGETS`, `COVERED_API_MUTATIONS`) are the durable anchors; `file:line` is reserved for the handful of lines whose exact position is the point.                                                                                                                                                                                                             |

## Slice 1 — Contract closure

### 1a — The `establishing → connecting` rename

**Lands:** the single rename everywhere in one commit — the enum in `group-lifecycle-policy.ts`;
~20 production comparison literals; the three untyped runtime validators, each holding
`['forming', 'establishing', 'active', 'reconfiguring']` as a bare `readonly string[]`
(`authoritative-state-validation.ts:433`, `group-state-delta.ts:193`,
`validate-persisted-group.ts:110`); both OpenAPI enum lines; 23 recipe assertions across 8 files;
~72 typed test literals; and the stage-derived identifiers in recipes and routes
(`/lifecycle/establish/`, `start-establishment-{runId}`).

**Dark:** nothing. The value is on the wire the moment a group establishes. That is why it goes first
and alone.

**Risk:** a value-keyed sweep damages unrelated code. Two legitimate English uses must survive in
`docs/test-structure-coupling-exceptions.md`.

**Gates:** baseline + both black-box profiles — a partial landing fails at runtime in the recipes, not
at build time. No medium-scale; no mutation semantics change.

### 1b — Stage widening and the pure function library (dark)

**Lands:** `GroupLifecycleState` widened with `planned | reconnecting` — **two** members, not three,
since product decision 25 keeps halting off this enum; the transition table reshaped; and the pure
library with its matrices, called by nothing.

`TRANSITION_TARGETS` is `Readonly<Record<GroupLifecycleTransition, GroupLifecycleState>>` — one target
per transition. It cannot express `connect` landing in either `connecting` or `reconnecting`, nor
`fail-formation` landing in either `forming` or `active` (product decision 28). **The table shape
changes, not just its entries.**

The library: the six-stage transition table with C2's landing rule and the `connect` precondition;
`resolveLayoutRole(publication, accepted) → accepted | planned | superseded | incomparable`, keyed on
the causal tuple plus `state` and handling `incomparable` explicitly; `computeGroupDataGate(stage,
transportState, preActivationAppData) → flows | blocked | halted`; the total precedence-ordered
condition function and the remediation function (product decision 30) — total over business status ×
stage × expiry per C5; `computeLayoutStale(storedFingerprint, currentFingerprint)`; the in-flight axis
on the outbound dial plan; trigger evaluation; `validateExpectedFence`; and the admission × stage
table.

**Dark:** all of it. Adding union members is unobservable while no transition produces them.

**Risk:** the highest-value, most easily missed work in the plan — see I2. Concretely, the
`lifecycleState !== 'active'` comparison inside `canSendGroupMessage` is a decision-25 violation that
compiles, typechecks and passes every existing test once `reconfiguring` can be reached with data
flowing. I2's conversion is what turns that class of bug into a compile error.

**Gates:** baseline + the headless bundle boundary — this is a `packages/shared` change even though
it touches no browser file.

### 1c — Policy contract widening (dark)

**Lands:** `topology.replanning` and `topology.reconfigureLanding` on `GroupLifecyclePolicy`; the
per-group debounce window and its clamped maximum wait (product decision 31); the establishment
trigger config; the `Partial<>` input keys; the four preset values; the initiator's move to the
group-authority tier (product decision 26); clamps, issue codes, cross-field rules, the OpenAPI
blocks, and the extended matrix test. Also lands I8's typed issue code gating the new fields.

**Dark:** yes — there is no policy read-back HTTP surface and `updateGroup` excludes `lifecyclePolicy`
from both key registries, so preset values are inert until slice 10.

**Also close here:** the pre-existing hole the census found — `formation: 'phased'` with a
`server-auto` initiator validates clean today and produces a permanently stuck group. The trigger
config closes it for automatic groups; the validator must still reject a phased `server-auto` policy
carrying no trigger, and `replanning: 'commanded'` with `server-auto` is the new equivalent deadlock.

**Settle here**, so no later slice invents one under pressure: the debounce window and maximum wait,
minimum layout age, `after` settle time, presence fallback timer, per-preset
`maxConcurrentEdgeSetups`, RTC setup timeout, status dwell, and the `active ↔ degraded` hysteresis
width — as clamped constants with matrices. Note that the live debounce value now arrives as
`topology.recompute.n` from the api-v1 configuration defaults, not from the exported
`DEFAULT_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS`, which has no references at all and should be deleted.

**Gates:** baseline + the policy matrix test.

## Slice 2 — Aggregate ownership fields

**Delivers in the same PR as slice 4a** (I7), which is their first reader.

**Lands:** the accepted layout identity `{groupRevision, presenceRevision, version, state}` (product
decision 29) and `transportState` as required `Group` fields with creation values that are pure
functions of what exists, threaded through **four hand-maintained key allowlists that no compiler
links and no test cross-checks**: `AUTHORITATIVE_STATE` group keys, `GROUP_KEYS` in
`group-state-delta.ts:46`, `STORED_GROUP_KEYS` in `validate-persisted-group.ts:16`, and the OpenAPI
`Group.required` block. It was five before #319 deleted `PERSISTED_GROUP_KEYS`. Plus
`packages/tests/create-test-group.ts` (new fields go last, per its own comment), the exact
serialized-JSON pin in `group-state-inbox-transaction-result.test.ts`, and eight hand-written
full-`Group` literals under `packages/shared-rtc-bench/**` and `scripts/perf/`.

The accepted layout identity is a nested object, so it needs its own field validator beside the key
list — the `FORMATION_OUTCOME_KEYS` pattern in `validate-persisted-group.ts:50` is the shape to copy.

**Risk:** (a) a half-finished list edit is a runtime throw on the group write path **and a silent
browser failure**, because group delta application swallows validation throws and degrades to "ignore
the delta"; (b) full `GroupSnapshot`s are embedded in durable queue rows and re-validated with
exact-key strictness on decode, so rows queued in a reused local Postgres throw on replay — drop the
database; (c) every persisted byte is counted by the state-write gate's `sql.serializedResultBytes`,
whose headroom over the ±5% band is ~2.3% given the recorded ±2.7% drift. The identity tuple is four
fields where the first draft had one number, but the recorded return stage is gone, so the net is
close to a wash — measure it, do not assume it.

**Also here:** a `keyof Group`-derived cross-check test for the three TypeScript lists — the only
structural record the aggregate has, since Prisma shows nothing. And C5's business-status × stage
rule.

**Gates:** baseline + both black-box profiles + **medium-scale** + state-write vs the slice-0 control.
Add `apps/relic-hunter-server-v1` to the verification list (C8) and state the deploy order for the two
servers.

## Slice 3 — Causal fences on internal commands

**Lands:** `expectedFormationEpoch` and `expectedLayout` as required input on every internal command,
validated in `compute` against the durable group row, returning a typed stale outcome. Retrofits the
three criterion builders and their request id.

**Dark:** no — and that is the point: today's silently-applied stale petition becomes a typed
rejection.

**Three traps.** (1) `requestId = commandId` in all three builders, so a record is stored and the
idempotency probe turns a same-id/different-hash petition into a 409. **Any field added to `input`
must also enter the id** — give it a version namespace (`formation-criterion:v2:…`) including the
layout identity. (2) The existing fence in the formation timer work handler reads a _cached_ snapshot
and is advisory; product decision 19's fence belongs in `compute`. (3) **Queue resource ids cap at 36
characters** (`AppQueueIdentity.ts:4`), and `formation-timer-outbox-entry.ts:53` already spends its
budget on `ft-${kind}-${epoch}-${fnv1a64(contextId)}`. A composite layout identity must be **hashed**
into the id, never spelled — this is the one place a tuple genuinely will not fit, and it was
unbudgeted before this pass.

Also needed: `assertExactKeys` on `GroupMutationFacts`, plus `GROUP_MUTATION_INPUT_KEYS` and
`GROUP_MUTATION_REQUEST_KEYS` rows — all three are exact-key asserts, so a missing entry throws on
every attempt and on replay of durable rows.

**Also move here:** the criterion petition currently fires **before** the publication write in the
topology work handler, not after it. Any petition whose fence names a layout identity must move to
the post-commit hook, or it will fence against a layout that has not been written yet.

**Gates:** baseline + both profiles + **medium-scale** + state-write.
`api-v1-group-formation-criterion.json` is the only end-to-end pin of the arm-and-fire path and gains
a `stale-petition-fenced` leg. Write the first unit tests this path has ever had.

## Slice 4 — Accepted and planned layout ownership (the held-layout foundation)

The structural blocker, verified: `RtcTopologySnapshotRepository.snapshotKey(ref)` is the group
storage key alone (`rtc-topology-snapshot-repository.ts:206`) — **one never-expiring row per group**.
Publications are retention-bounded copies (24 h), not an archive. The stored row _is_ what every path
converges on: replay returns `deliver-current`, the reconnect hydrator sends only the current
snapshot, and the criterion is petitioned against the just-planned candidate. All three would repair
members onto the **planned** layout and measure coverage on a layout nobody dials.

**Q1 is answered by product decision 24**: the row that exists today is the **planned** layout — it is
already what the criterion measures, and it is already overwritten on every replan. The **accepted**
layout gets the second never-expiring row, written only by `activate`. That is why it must be a row
and not a pointer into publications: a thousand-session group may serve one accepted layout for hours,
well past the 24 h publication retention, and a hold has no upper bound at all.

The identity trap, verified: **a version comparison is not a safe test.** The planner bumps the
version only when the hop map, kind, name or degree changes, and the removed tombstone is written with
`version: previous?.version ?? 0` — so an active layout at version N and its tombstone at version N
coexist with different content. Product decision 29's tuple plus `state` is the predicate, and it must
handle `incomparable`. Publication delivery is also **not monotonic**: the stale-publication computation
returns `publish-superseded`, so a dominated candidate's publication can be broadcast after a newer one.

- **4a — the accepted-layout store**, delivered with slice 2's aggregate fields (I7). A second durable
  row written on `activate`, plus the layout-role classifier behind a read-only accessor. Copy the
  accepted layout's input fingerprint here — slice 10 needs it, and reconstructing it later would need
  a dependency edge the formation view does not have. **Two fingerprints are stored, not one**: the row
  that exists today holds the _planned_ layout's fingerprint, written at publication accept time, so
  reusing it for `layoutStale` would report false while the browser is still serving the previous
  layout — the exact inverse of the field's meaning.
- **4b — the stage-keyed planning gate** replacing `isGroupTopologyPlannableAt`: `forming` publishes
  nothing, `planned` plans and publishes a **held** layout. Observable. Owns C6's five stage-blind
  topology write paths. Settle Q7 first (does `forming` keep publishing today's removed tombstone).
  Cheaper than budgeted: #319 deleted the git-history-pinned 100-column guard test on the planning
  snapshot selector.
- **4c — delivery correctness:** replay's `deliver-current`, the reconnect hydrator, and the criterion
  petition all pinned to the right layout — the accepted one for repair and hydration, the planned one
  for the criterion; `GroupTopologyManagementView` carrying both, and its inert `pending` field finally
  populated from the coalesced row's `dueAtEpochMs` (product decision 11). Owns C7's departure rule.

**Gates:** baseline, both profiles, **medium-scale**, `topology-replay`, state-write,
`test:integration:postgres`.

## Slice 5 — The stage command family: `plan`, `connect` (dark)

Per-command cost is the ~15-registry census: a new `AppInboxType`; a payload type and an
`AUTHENTICATED_GROUP_INBOX_TYPES` entry; a `GroupMutationCommand` union member; a
`to-lifecycle-mutation-command` case; the `toDescriptorCommand` and `toGroupMutationDescriptor`
switches; the `GROUP_APP_INBOX_OPERATIONS` Map; `GROUP_MUTATION_OPERATIONS` and
`AGGREGATE_GROUP_MUTATION_OPERATIONS` Sets; `GROUP_MUTATION_INPUT_KEYS` and
`GROUP_MUTATION_REQUEST_KEYS` rows; `LIFECYCLE_TRANSITION_BY_OPERATION`; and
`GroupLifecycleTransitionOperation`, an `Extract` over four literal names feeding six behavioural
registries.

**Roughly half is compiler-caught** (`LIFECYCLE_TRANSITION_BY_OPERATION` is `satisfies Record<…>`,
`toGroupMutationDescriptor` has `never` guards after `197d5cad1`, `GROUP_MUTATION_INPUT_KEYS` is a
`Record`). **The other half is silent:** `GROUP_APP_INBOX_OPERATIONS` is a `Map` whose miss makes the
stable-command translation return `undefined` and silently change the canonical command hash;
`toDescriptorCommand` has a `default:` arm that misroutes an unlisted operation into the _membership_
builder; `GROUP_MUTATION_OPERATIONS` is an untyped `Set` of bare strings.

- **5a — `plan` and `connect` plumbing, dark**: registered on no route, emitted by no producer.
- **5b — `connect` semantics, dark**: the accepted-layout write, the expected-layout fence and the two
  typed denials `no-planned-layout` / `planned-layout-superseded` (product decision 32), and `plan`'s
  idempotence from `planned` (product decision 28). Needs 4b. The caller-supplied-expected-state shape
  already ships in `disconnectPresence`, and the compute-value-to-409 conversion already exists —
  but unlike `disconnectPresence` this must **not** degrade to `noOp`, which is exactly the failure the
  fence exists to prevent.
- **5c — `pause` and `resume`, dark.** These write `transportState`, not `lifecycleState`, so they are
  **not** lifecycle transitions: they do not enter `LIFECYCLE_TRANSITION_BY_OPERATION`,
  `GroupLifecycleTransitionOperation` or its six downstream registries, and they advance neither the
  formation epoch nor the electorate. That is product decision 25's whole payoff, and it makes this the
  cheapest of the three sub-slices rather than the most dangerous.
- **5d — legacy removal**: `start-establishment` goes with its route, `AppInboxType`, operation,
  OpenAPI block and 22 recipe call sites across 10 files, once `plan` + `connect` cover it (product
  decision 34). Each `POST …/lifecycle/establish/…` becomes two calls, so the recipe edit is a rewrite,
  not a path substitution. The automatic retry leg is re-expressed as `plan` plus the connect trigger.

Product decision 12 keeps one initiator policy, so the command predicate needs no per-command branch.
Every new command inherits the slow sequential read path, and the read step and its validator apply
that predicate independently — a one-sided edit throws at compute.

**Gates:** baseline, both profiles, **medium-scale**, state-write, and the hard-coded counters, which
are **net, not additive**, because 5d removes two operations as 5a/5c add four:
`mutation-routing-inventory.ts:71` (`!== 56`) and `:74` (`!== 52`);
`api-mutation-openapi-contract.test.ts:139` (`COVERED_API_MUTATIONS.length, 47`);
`api-v1-recipe-idempotency-cutover.test.ts:268` (`toHaveLength(47)`); and the route-count strings
inside `register-group-state-routes.test.ts` test titles. Extend that file's `mutationRoutes` here —
until then recipes on the new paths are silently outside the strict request-identity gate.

## Slice 6 — `reconfigure` as a stage command (dark)

**The sharpest hazard in the plan:** two mutations already exist for one product "reconfigure".
`GroupTopologyReconfigureMutation` advances the group authority fence and writes an APP_OUTBOX entry —
and never touches `lifecycleState`. Lifecycle transitions live elsewhere. The stage-level `reconfigure`
must set the stage **atomically with** the outbox enqueue, or a crash between them leaves a group in
`reconfiguring` with no topology work queued. **Q4 blocks this slice.**

Product decision 27 removes half the original difficulty: an `apply` landing performs no transition at
all, so there is no "publish and apply in one step" to make atomic. Only `hold` reaches this slice, and
only `hold` needs the merge-or-sequence argument.

Secondary: the computed-write validator asserts `outboxEntries.length === 1 + expectedTimerEntries.length`
and `jsonEquals` each entry against a re-derivation, and the result validator requires every outbox id
after the first to start with `ft-`. A merged mutation widens both.

- **6a — merge-or-sequence, and the atomicity argument.** Owns Q4. Also removes `reopen-establishment`
  with its route, type, operation, OpenAPI block and recipe call sites (product decision 34).
- **6b — the `landing` field** and its interaction with the replanning policy, still dark.

**Gates:** baseline, both profiles, **medium-scale**, state-write, `topology-replay`.

## Slice 7 — The transport valve and the forward gate

Two predicates change together. `canSendGroupMessage` — renamed from `canSendRoomMessage` by #319 and
now in `group-state/policy/group-message-policy.ts:53` — tests
`preActivationAppData === 'blocked-until-active' && lifecycleState !== 'active'`, and
`ws-topic-room-authorizer.ts:132` skips the policy read entirely when
`lifecycleState === 'active' || !readPreActivationAppData`.

Under product decision 25 the forward gate is derived from the stage and the halt is a separate group
field, so the two cases compose instead of nesting. Note the direction of the change: the forward gate
must now close for `planned` and `connecting` as well, and it must **open** for `reconfiguring` and
`reconnecting`, which today's `!== 'active'` comparison would wrongly block.

**Q3 blocks this slice.** `canSendGroupMessage` has a second, non-WS caller —
`apps/relic-hunter-server-v1/src/relic-rest-auth.ts` — passing no `preActivationAppData`, so the gate
branch never fires there today. Folding a policy-independent halt into the shared predicate makes every
Relic Hunters REST command on a halted group return 403 (C8). **Recommended:** keep
`canSendGroupMessage` as the policy predicate and put the transport halt at the relay's own choke point.

The halt is exactly as complete as `isRoomScopedALMessage`: reserved system topics bypass the
authorizer entirely and the chat app topic broadcasts application payloads with zero authorization. And
`forwardsRoomScopedMessages` defaults **true** with exactly one disabling site — the
permissive-by-default boolean that already caused this bug class once (control-plane decision 5.9).
Extend `ws-server-qos-policy.test.ts` to assert a halted room-scoped message is not forwarded by the
ALM path either.

**Gates:** baseline, both profiles, **medium-scale**, `test:deno` (the api-v1 authorizer test is
Deno-only), and `api-v1-group-data-policy.json` extended with `pause-resume` and
`reconfigure-while-halted`.

## Slice 8 — The browser, and the routes

**This is greenfield, not modification.** `rg lifecycleState packages/shared-web` returns nothing;
`rg lifecyclePolicy packages/shared-web` returns nothing; there is no `room.formation` surface.

Four verified facts shape it:

1. The overlay repository is a **single-slot** TTL'd latest-value store, and `setOverlayById`
   **throws** on `incomparable` and on equal-tuple-different-content — called from the WS handler with
   no try/catch.
2. **The facade does not use the overlay at all.** Room peer resolution runs over `snapshot.activeSessions`,
   and `realtime.room().send()` defaults `connect: true` and opens a lane to every active session —
   dialing straight past the group manager and the outbound dial plan. There are **five outbound dial
   entry points** plus inbound peer acceptance, so "dialing is a pure function of the stage" is
   unenforceable at one place today.
3. `targetPeerIdsForGroup` falls back to the full active-session bootstrap whenever no overlay exists
   (`WebRtcGroupManager.ts:459-468`).
4. **Inbound admission currently accepts peers in no layout**: the inbound decision returns `tentative`
   when _not_ owned by any group, so an empty accepted layout **permits** peer creation rather than
   blocking it.

- **8a — the two-slot overlay cache** and `layoutPlanned` / `layoutAccepted`, with every existing reader
  explicitly pinned to the accepted slot so behaviour is identical; wrap `setOverlayById` so an
  `incomparable` arrival is a drop, not a throw on the WS handler.
- **8b — the dial gate and bootstrap suppression**, including the inbound admission deny keyed on the
  stage, and the `reconnecting` union — the accepted layout's edges plus the planned layout's, which is
  the first time the browser dials two layouts at once. Without the inbound deny, a lagging peer's offer
  still creates connections and `discovery-holds-dials` fails.
- **8c — the room facade:** readiness on the accepted layout, the local halt with its typed status, the
  browser's own repair reporting (aggregate the per-peer `reconnecting` / `reconnectAttempts` pair the
  RTC layer already computes — no server change and no wire change), and C10's two games updated in the
  same PR: the exhaustive status mapping and the `sendJson` fallback together.
- **8d — mount the routes** (I8): `plan`, `connect`, `pause`, `resume` and `reconfigure` on HTTP with
  their OpenAPI paths, in one PR, now that the halt and the dial gate exist.

**Blast radius:** repointing readiness from active sessions to the accepted layout changes
`waitForRoomLane`'s `{exact: peerIds.length}` expectation for ar-eye-hunter-v1, relic-hunters-v1,
rallar-black-box and `shared-web/game/match.ts`. And `match.ts` falls back to `realtime.sendJson` with
explicit peer ids, routing around any room-level halt.

**Gates:** baseline + the shared-web trio (`shared-web-public-api-snapshots.test.ts`,
`shared-web-browser-bundle-boundaries.test.ts`, `check:browser-bundles`), the headless bundle boundary,
`test:e2e`, `test:full-stack:memory`, and **`test:rallar:full-stack:memory:live-rtc-3`**, which branch
CI does not run. 8d additionally carries both black-box profiles, medium-scale and state-write.

## Slice 9 — In-flight pacing

Three prerequisites are missing: (1) `ensurePeerConnectionStarted` returns a right value whether or not
it decided to connect, so the attempt counter already counts idempotent ensures; (2) there is **no
success callback** — the peer lifecycle callback has `onCreated`/`onDeleted`/`onConnectTimeout?`/
`onConnectExhausted?` and nothing for established; (3) there is **no wire path for the bound** —
`GroupSnapshot` carries no policy (**Q2**).

A fourth structural gap: the reconcile pass flattens all groups into one desired-peer set, so there is
no per-group loop for a per-group bound. **Product decision 18 answers the ownership question without a
tie-break**: a peer two groups both want is one connection charged to each group's in-flight count,
under the member's own session-wide cap. No cross-group arbitration is promised, and the repository
explicitly refuses to promise cross-group connection budgeting.

- **9a — truthful RTC lifecycle signals** (surface attempt-started, add an established callback). Dark,
  additive, independently valuable. Settle Q2 here.
- **9b — the per-group bound, wake-on-completion, and the 6/20/50 sweep.**

**Pacing is literally unobservable until the harnesses change:** the formation simulation clients and
the RTC QBox harness both stub `ensurePeerConnectionStarted` as immediately successful. Rewrite them
with a completable asynchronous dial **before** 9b. Also the peer establishment timeout policy is
`enabled: false` by default, so "timeout ends an attempt" is off in any directly-constructed service.

**Gates:** baseline, shared-web trio, headless bundle boundary, `test:full-stack`, the live-RTC suite;
and for `pacing-sweep`, the Hetzner manifest family — generated code with a byte-exactness test,
literal path lists, participant-count-in-filename validation and an explicit RTC-readiness requirement.

## Slice 10 — Replanning modes and landing go live

The two footings are asymmetric, and one of them is thinner than the first draft assumed. `debounced`
has real machinery — a coalesced group-revision row with a generation-CAS merge — but **its window is
server configuration, not per-group policy, and it applies to every group already**, which is why
`auto` and `debounced` are indistinguishable on main today. It is also an _extending_ window with no
maximum wait: `dueAtEpochMs` takes `Math.max` and every event resets it, so sustained sub-window churn
defers a replan indefinitely. Product decision 31 makes both the window and a clamped maximum wait
per-group policy, which is what finally separates the two modes.

**`commanded` has no suppression point at all**: the presence-summary path enqueues coalesced topology
work on every accepted group revision, unconditionally — the write sits outside the
`outcome === 'write'` guard, in `group-presence-summary-worker.ts` with its computation in
`group-presence-summary-effects.ts`. One suppression does exist a layer above: a pure lease-renewal
heartbeat enqueues no presence-summary work at all, which is what makes product decision 11's "a
heartbeat is not stale" true from a second direction.

`layoutStale` needs the accepted layout's fingerprint, copied at `activate` time in 4a rather than
reconstructed here — the formation view read already holds the planning authority, but its dependency
contract has no execution repository. One non-obvious mover neither plan named: the fingerprint hashes
the **effective** topology config, which resolves a TTL'd temporary override, so an expiring override
flips `layoutStale` on wall-clock time alone with no group event to explain it. Say so on the read
surface or exclude overrides from the fingerprint.

Split 10a (`commanded` + `layoutStale` + `pending` on the formation view = the `commanded-replanning`
scenario) from 10b (per-group windows, the maximum wait, and minimum layout age). This is where the
preset values become behavioural and silently re-aim `api-v1-match-preset.json` and both managed-burst
recipes — though note that none of those three recipes asserts on topology, staleness or `pending`
today, so there is no existing regression barrier here at all.

**Gates:** baseline, both profiles, **medium-scale**, state-write (possibly a registered regression
reason — the state-write reasons module throws on any unknown profile), `topology-replay`,
`formation-large`.

## Slice 11 — Automation triggers

The timer work is larger than the product plan's costing. `GroupFormationTimerWork` carries
`kind: 'deadline' | 'retry'` only; the resource id is `ft-${kind}-${formationEpoch}-${fnv1a64(contextId)}`
under the 36-character cap; and the write validator recomputes the expected timer entries byte-exactly.
Each new trigger kind needs a union member, a decoder literal, an arming site, a consumer branch, a
petition builder, a fence, and a mirror entry.

**A timer entry key is not re-armable**: the write throws unless resource, creator, created and expire
timestamps all match byte-for-byte, so a trigger whose due time moves must use the coalesced replacement
path, not the formation-timer shape. And an outbox entry whose typeId has no registered handler throws
on every dequeue and burns to FAILED, while the formation-timer handler registration is _conditional_
and its entries are written unconditionally.

**Repair the pre-existing deadline hole here.** The formation timer handler returns early when nothing
has been published yet, and the retry leg is armed only by `fail-formation` and gated on `forming` — so
an establishing group whose deadline expires before its first publication is never failed out. That bug
exists on main today; the new stages do not create it, but the connect trigger reproduces its shape.

The `presence` trigger is a different problem: the presence summary has no policy read and no submit
port, and is constructed _before_ the `GroupStateInboxService` that owns the criterion enqueue. Under
the visible-construction rule that is a restructure, not plumbing. Its compute is validated by a
byte-exact mirror, so nothing it adds may capture wall-clock.

A new internal authority mode is mandatory: the trusted-authority validator limits `formation-criterion`
to three operations and throws for anything unlisted. Slice 6b's internal path needs the same widening,
so land the allowlist change once, in slice 3.

Split 11a (`immediate`/`after` via the durable timer path) from 11b (the `presence` trigger with its
construction restructure and its own state-write verdict). **Write the first unit tests this surface has
ever had in 11a.**

**Gates:** baseline, both profiles, **medium-scale**, **state-write**, `formation-large`.

## Slice 12 — The living observed status

**This goes last because of write amplification, and the arithmetic is verified.** A 50-session group
produces up to ~3,000 accepted RTT mutations per minute. Between evidence and a petition sit exactly two
dampers — the RTT refinement gate (30 s) and the criterion petitioner's 1 s window — and **both are
process-local `Map`s**, so an N-node cluster multiplies both ceilings by N (**Q6**).

Each status write is not one row: it CASes the group, writes a durable event, enqueues a presence-summary
expansion, and fans a delta to every connected session. And the group row is currently **quiet** during
`active` — presence guards on its own kind and never CASes it — so a status writer contends with exactly
the two things a lobby does most: joins and the operator's own stage commands.

The guard that must not be casually removed: the criterion refuses to run outside establishment, which
is why there are zero evaluations per minute in `active` today. Widening it is what turns zero into the
ceilings above. It is also why the **browser**, not the server, reports repair work during a live match
(product decision 30) — the repairs that matter there are browser-local, and the server neither performs
nor observes them.

Two ordering traps, not one. (a) The criterion request id keys on `(decision, groupRef, formationEpoch)`
_deliberately_, so a race resolves to one transition; a status command keyed the same way makes
`active → degraded → active` within one epoch a replay of the first write, leaving the group permanently
`degraded`. Give the status command id a monotonic component. (b) **A monotonic id prevents collisions
but does not order evidence.** The group row's only write guard is the opaque runtime-state revision, not
a causal one, and an AppInbox conflict retry recomputes from the same durable command — so the loser's
older evidence lands on top of the winner's newer evidence. Product decision 33's evidence watermark is
what fixes that; the pattern to copy is `validateGroupPresenceSummaryCausalRevision`. Note the watermark
must be **evidence-derived**: RTT writes do not advance the group causal revision, so the group tuple is
not a valid recency signal for coverage. `computeGroupFormationReadiness` currently discards each
measurement's monotonic version and timestamp and must return the watermark.

- **12a — the fields, the event, and read-derived reporting**: condition and remediation with their basis
  added to the key lists (I4's second edit), `group-activation-status-changed` registered at its six
  sites (only the `Record<GroupEventType, true>` one is compiler-checked), and both axes reported on the
  formation view **derived at read** — written only by transitions that already CAS the row. No new
  writer, no amplification.
- **12b — the internal status writer** with dwell, hysteresis and durable clocks. Design its damping to
  survive a multi-node cluster before writing it.

**Keep the fingerprint skip in the topology work handler intact** — it is the only thing stopping
status → topology work → petition → status from becoming a self-sustaining loop.

**Gates:** baseline, both profiles, **medium-scale**, **state-write**, `formation-large`, plus the
`status-lifecycle`, `status-convergence` and `status-on-connect` recipes.

## Slice 13 — Operator and observability surfaces (C9)

**Lands:** the stage, epoch, accepted and planned layout identities, `transportState`, both status axes
and the data-gate verdict in `GroupAdminSupport.explainGroup`'s facts / warnings / likely-causes — note
the builders now live under `admin-support/narratives/`; new formation-metrics buckets (`stageTransition`,
`activationStatus`) so the new write volume is visible in the burst artifacts instead of falling through
to `other`; and a `group-lifecycle-stages` workbench collection plus a stage column in the black-box
rooms diagnostic.

**Order:** the metrics buckets must land **before** slice 11 or 12 enables any automatic writer. The
diagnostic surfaces are also the cheapest way to drive pause/resume and a held reconfiguration manually
before the live-RTC specs exist.

**Gates:** baseline, `test:e2e`, `test:repo-governance`.

## Slice 14 — Finalisation

**Lands** the state product decision 14 defines completion by: the architecture doc rewritten
(`docs/rallar-group-formation-architecture.md`, linked from `docs/README.md` and the RTT reporting doc);
`docs/rallar-api-reference.md` and `docs/rallar-quickstart-and-recipes.md`, both **machine-checked** by
`rallar-group-docs-compat.test.ts` for exact backticked phrases including every `GROUP_POLICY_REASON_CODE`;
the `examples/**` READMEs and the `building-rallar-apps` / `rallar-realtime` skills, pinned by
`rallar-skill-app-examples-integrity.test.ts`; the OpenAPI `GroupPolicyReasonCode` enum (already **6
codes behind** the TypeScript const, with no test coupling them); and the sixteen acceptance scenarios
registered in `recipe-matrix.json` plus both hand-maintained sorted id lists in `recipe-matrix.test.ts`.
It also verifies that `start-establishment` and `reopen-establishment` are gone everywhere, which
slices 5d and 6a removed.

**Nothing behavioural hides here.** The reader-default removal the first draft placed in this slice is
already done: #319 cut `group-state-persistence-codec.ts` from 328 lines to 49 and removed
`persistedOrDefault` entirely.

**Gates:** the plan-completion set — `test:unit`, `test:ci`, `build`, the **Branch Release Gate** on the
final feature-branch commit, and **Run Hetzner Supported Distributed Manifests** on the resulting
default-branch commit.

## Gate assignment

Every slice carries the baseline: `format:check`, `check:repo-style:changed -- origin/main HEAD`,
`typecheck`, `typecheck:tests`, `test:unit`, `test:deno`, `build`.

| Gate                                                              | Slices                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **medium-scale** (`test:api-v1:black-box:postgres:medium-scale`)  | 2/4a, 3, 4b, 4c, 5a, 5b, 5c, 5d, 6a, 6b, 7, 8d, 10, 11a, 11b, 12a, 12b |
| **state-write** (`perf:api-v1:state-write` + comparator)          | the same set                                                           |
| shared-web trio + `check:browser-bundles`                         | 8a, 8b, 8c, 9a, 9b                                                     |
| headless bundle boundary                                          | every `packages/shared` change — including 1b                          |
| `topology-replay`                                                 | 4a, 4b, 4c, 6a, 10                                                     |
| `formation-large`                                                 | 10, 11, 12                                                             |
| **`test:rallar:full-stack:memory:live-rtc-3`** (not in branch CI) | 8b, 8c, 8d, 9b — and it is where six plan scenarios live               |
| Hetzner distributed manifests (push-to-main only)                 | before the plan may be marked complete                                 |

The medium-scale gate also **auto-triggers** on PRs touching `apps/api-v1/**`, `packages/shared/**`,
`packages/shared-server/**` or the black-box runner — which is nearly every slice — so it runs whether
or not a slice names it. Never weaken its constants or assertions.

Also standing: `npm run pr:delivery -- status` before broad final validation, `npm run check:repo-structure`,
and `npm run check:retained-legacy` — if any slice needs a temporary dual-read or dual-write, that is a
retained-legacy decision requiring a registry entry and human approval, not an implementation detail.

The distributed-validation risk classifier is **path-based** and matches `packages/shared/rtc`,
`packages/shared/webrtc`, `rallar-system/topology/**` and browser rtc/realtime files. Sequence merges
deliberately so the Hetzner run is paid once per foundation, not once per file touch.

## Questions remaining

Each becomes a numbered decision here the moment it is taken, with its alternatives. **Q3 and Q4 block
their slices.**

| #   | Question                                                                                                                                               | Slice |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| Q2  | How `maxConcurrentEdgeSetups` reaches the browser: a required `Group` field mirroring the policy, a formation-view read, or the policy on the snapshot | 9a    |
| Q3  | Whether the halt lives in the shared `canSendGroupMessage` or only at the WS relay (Relic Hunters REST is the difference)                              | 7     |
| Q4  | Whether the two `reconfigure` mutations merge or sequence, and how the lifecycle write and the outbox enqueue stay atomic under a `hold` landing       | 6a    |
| Q6  | How the status writer damps across a multi-node cluster, given both existing dampers are process-local                                                 | 12b   |
| Q7  | Whether `forming` keeps publishing a removed tombstone to every session (it does today, and a recipe tolerates both)                                   | 4b    |
| Q9  | `mutationDescriptor` already takes six positional parameters against a three-parameter standard; a seventh needs a ~22-call-site refactor instead      | 5a    |
| Q10 | The public shape of the browser's own repair reporting on `roomStatus()` — a `shared-web` public API addition, so it needs a snapshot decision         | 8c    |

Settled and closed: **Q1** — the existing topology row is the planned layout, the accepted layout gets
the second never-expiring row (product decision 24). **Q5** — the status fields do not ride the first
field edit (I4). **Q8** — the `pending` name collision dissolves, because the plan's "pending layout" is
now the _planned_ layout and `pending` goes back to meaning "a replan is queued, due at T", which is
what it has always declared and never done.

## Validation

Per slice: focused unit matrices first, then the surface's own tests, then the recipes, then the gates
named in that slice's section. Report every command as passed, failed or skipped.

Whole-workstream acceptance is the product plan's sixteen named scenarios, plus the three invariants
asserted at every slice boundary. The plan may be marked complete only after the final working tree
passes `test:unit`, `test:ci` and `build`, plus the Branch Release Gate on the final feature-branch
commit and Run Hetzner Supported Distributed Manifests on the resulting default-branch commit — and any
change after a passing gate invalidates it.

## Deferred, explicitly

- Per-edge confirm-or-fail establishment (`strictConfirmation`), `group_batch`, `ASYNC_REMOTE_QUEUE`,
  commanded-edge retention, command-origin validation — the product plan's own deferral, unchanged.
- Enforcement of `establishment.transports`. The transport plane in this workstream carries only the
  halt; transport kind stays a declared, unread field.
- Cross-group connection budgeting — explicitly not promised (product decision 18).
- The `elected-by-rank` rank source, inherited unresolved from the control-plane workstream.
- Typed policy-validity rejections over HTTP and typed WS NACK reasons — both still deferred; the halted
  case adds a third reason code that is HTTP-only for the same reason.
- A policy-update surface. Every field remains write-once at creation.
