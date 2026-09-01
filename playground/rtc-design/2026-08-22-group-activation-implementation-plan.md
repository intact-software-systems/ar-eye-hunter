# Group Activation — Implementation Plan (2026-08-22)

Status: **implementation in progress — Slice 8b is under review in #390; the existing
Slice 8c and 8d PRs follow it in review order. Re-baselined against product decisions 1–42. The product decisions are settled;
the implementation decisions record current reasoning, while ownership, decomposition, file and
symbol inventories, dependencies and gates must be refreshed against the actual delivery head before
the first implementation PR and whenever later changes to `main` materially affect the plan.**
Implements `2026-08-22-group-activation-product-plan.md` (decisions 1–42). That document owns the
product surface; this one owns how it lands.

The earlier code census predates #323's state-event ownership, #324's QueueBox persistence ownership
and #325's shared-server AppInbox protocol ownership. Those changes directly affect promotion,
internal authority, transaction, retry, durable latch and after-commit paths. They demonstrate why a
code census is evidence for one planning checkpoint, not permanent authority. Slice 0 initially
re-recovers every current owner; decision I20 requires the same material-change review throughout
delivery. Symbol names remain navigation hints; historical line numbers, counts and commit hashes are
not implementation authority.

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
silently keep covering four of seven unless slice 1b makes it compiler-derived.

**Third, new in this pass:** no stage command is reachable over HTTP until the browser honours its
dial and data consequences. This is what slice 8d exists to enforce.

Every slice's PR description states how it preserves all three. A slice that cannot is wrong.

## What is new, and what is reuse

This workstream is expected to build on existing code and existing patterns. A four-area audit against
`main` classified 74 deliverables: **8 reuse, 45 extend, 21 new** — and most of the new ones are small.
The server command surface is almost entirely template-filling: adding an AppInbox group mutation end
to end was executed twice in five weeks, and route-less dark commands are precedented. **The genuinely
new machinery is concentrated in the browser and in slice 12**, and that is where review effort belongs.

| Rank | Genuinely new                                       | Size        | Slice | Why it has no precedent                                                                              |
| ---- | --------------------------------------------------- | ----------- | ----- | ---------------------------------------------------------------------------------------------------- |
| 1    | The causally fenced readiness barrier               | LARGE       | 8c    | Readiness resolves peer ids once and never re-evaluates; `whenIdle()` is quiescence, not a predicate |
| 2    | The status writer and its evidence watermark        | LARGE       | 12b   | No writer CASes the group row on arriving evidence, and `dwell` appears nowhere in the repository    |
| 3    | The two-slot overlay cache                          | MED / LARGE | 8a    | The repository is free functions over one module token, generic over nothing                         |
| 4    | The `reconnecting` two-layout dial union            | MEDIUM      | 8b    | Nothing dials from two sources for one group                                                         |
| 5    | The accepted-layout durable slot                    | MEDIUM      | 4a    | The cost is the hydrator's paged-CAS reader, not the row                                             |
| 6    | A typed **conflict** outcome in group-state compute | SMALL       | 3     | Compute yields 403 denials and one generic 400; the nearest fence degrades to `noOp`                 |
| 7    | A transition table whose landing depends on policy  | SMALL       | 1b    | No `(state, command) → state` table exists to copy, and it moves every caller                        |

Everything else builds on something named. The anchors worth knowing, because a slice that reaches for
a new mechanism instead of one of these should be challenged in review:

| Need                               | Existing anchor                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| a new group command                | `grantGroupAdmission` (#297) and `failGroupFormation` (#282), both worked end to end            |
| a dark, route-less command         | `failGroupFormation`, carried as `transport: 'MAINTENANCE'` in the routing-owner inventory      |
| a caller-supplied expected value   | `computeDisconnectPresence`, and the topology reconfigure read's causal-revision compare        |
| a compute-side 409                 | `RtcRttMutationIdempotencyConflictError`, `GroupTopologyConfigIdempotencyConflictError`         |
| comparing layout revisions         | `compareGroupCausalRevision` → `compareOverlayTopologyCausalTuple` → `decideTopologySnapshot`   |
| retiring a layout without a delete | `removedTopologyResult` and the `state: 'removed'` tombstone every reader already filters       |
| a second durable topology store    | `RtcTopologySnapshotRepository` parameterised by namespace, or its `childKey` idiom             |
| cross-node damping                 | the coalesced APP_OUTBOX row and its generation CAS                                             |
| hysteresis banding                 | `resolveTopologyKindWithHysteresis`                                                             |
| gating peer creation               | `setInboundPeerCreationPolicy` + `toBrowserRtcInboundPeerCreationDecision` (mirror it outbound) |
| two repository slots               | `configureSharedStateRepositories`, which already configures two independent tokens             |
| a non-lifecycle group field        | `appointDirector`, `rotateGroupJoinCode`                                                        |
| per-group durable policy           | `GroupLifecyclePolicy` with its nested sub-policies, presets, issue codes and repository        |

## Slice 0 — Re-plan against current `main` (initial prerequisite and standing checkpoint)

Git synchronisation and planning currency are separate decisions. Do not rebase or merge merely
because the branch is behind. Run `npm run pr:delivery -- status`; a real conflict is repaired, while
`BEHIND` with a mergeable PR creates no integration work. Independently, before selecting the first
two delivery PRs and before selecting each later one or two, inspect the changes on the latest
available `main` since the previous planning pass. Reading and reasoning from current `main` does not
require moving the feature branch.

A `main` change materially affects this plan when it changes or invalidates any product or protocol
constraint; owner, entry point, dataflow, side-effect or failure boundary; public, persisted or queued
contract; package or runtime composition; compatibility or migration assumption; acceptance
scenario; or validation risk used by the affected work. A new commit id, line movement, unrelated
change or base movement that leaves those facts intact is not material.

When a material change exists, stop before implementing the affected work. Re-recover the affected
owners and paths from current repository truth, then revise this plan's implementation decisions,
capability decomposition, dependencies, risks, gates and next one or two concrete PRs before work
continues. Update the semantic PR explanation as well. If new evidence invalidates a numbered
implementation decision, supersede it with a numbered decision and its rejected alternatives rather
than silently rewriting the reason. If it conflicts with a settled product decision, return that
conflict for a product ruling.

The initial re-census must recover these current owners by symbol. This table is a dated evidence
snapshot, not a closed inventory for later checkpoints:

| Changed ownership                      | Re-census consequence                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| #323 — state-event ownership           | locate event append, transaction and after-commit owners before promotion and status work                                                        |
| #324 — QueueBox persistence ownership  | locate durable timer, coalesced work, retry and wake owners before trigger, landing and status work                                              |
| #325 — shared-server AppInbox protocol | locate command decode, preparation, narrow internal authority, transaction writer, result, completion and replay owners before every new command |

For the initial pass, re-run the ten-surface census over the seven-stage registry; public and internal
command inventories; GroupState read/compute/validate/write; accepted/planned topology slots and
fingerprints; topology publication and replay; browser cache, inbound and outbound dialing; policy
persistence; status timers; routes/OpenAPI/recipes; and both server compositions. At later checkpoints,
re-run every affected surface rather than assuming the initial map still holds. Produce an owner map
and concrete descriptions for only the next two independently reviewable PRs.

**Lands:** no implementation and no governance ledger. When evidence materially changes this plan,
amend this document and the semantic PR explanation before implementation continues.

**Gates:** current-main `format:check`, `typecheck`, `typecheck:tests`, `test:unit`, `test:deno`,
`build`, `test:repo-governance`, repository structure, and a fresh state-write control when the
selected work changes a mutation path.

### Initial checkpoint — executed 2026-08-27 against `main` @ `9c8069be4`

The ten-surface census re-ran as six parallel surface censuses plus a current-main gate run. `main`
moved ~33 commits past this plan's last amendment (#327), including the shared-server ownership
series (#329–#350). Verdict: **one numbered decision is superseded (I16 → I25) and nothing else is
invalidated; PR 1 (slice 1a)
and PR 2 (slice 1b + 1c) stand as selected.** Corrected evidence for 1a/1b/1c is folded into those
sections directly. Corrections affecting later slices are recorded here and must be folded into
those slices at their own I20 checkpoints:

- **The group-mutation spine did not move in #344–#350; the AppInbox plumbing under it did.**
  Handler execution split into `app-inbox/handler/` (#348: `AppInboxHandlerRegistry`,
  `AppInboxHandlerExecutor`, `AppInboxTransactionWriter`, `createAppInboxHandlerRuntime`) and
  client execution into `app-inbox/client/` (#349: `AppInboxCommandClient` replacing the deleted
  `AppInboxQueueClient`, `AppInboxQueueEntryWriter`, `createAppInboxClientRuntime`,
  `AppInboxResultWaiter`). Generic JSON-wire command decode is `decodeAppInboxEnqueue` /
  `decodePersistedAppInboxEnqueue` in `app-inbox/app-inbox-command-decoding.ts` (#346).
- **I16 is superseded by I25.** `mutationDescriptor` takes one named
  `MutationDescriptorInput` since #338 (`7f530fdbd`, one day after this plan's last edit); the call
  census (36 sites / 9 files / 22 in `to-group-mutation-descriptor.ts`) matches the plan.
  `toGroupMutationDescriptor` itself has always taken one parameter. 5a no longer carries a
  refactor.
- **Slice 3's named owner `validateTrustedAuthorityMode` does not exist.** The capability is split:
  mode validity sits in `validateGroupMutationFacts` (an untyped string list), and the
  mode × operation matrix sits in `validateGroupMutationAuthority` →
  `validateInternalMutationAuthority` → `validateFormationCriterionAuthority`
  (`command-validation/validate-group-mutation-authority.ts`). Slice 3 extends both, not one
  function. The current internal-mode union is
  `'none' | 'expiry' | 'session-cleanup' | 'formation-criterion'` on
  `GroupMutationFacts.internalAuthority` (`group-mutation-contracts.ts`).
- **Slice 5's registry census is 18 files / ~23 sites**, not ~15 registries; the recovered list
  adds `GROUP_MUTATION_INBOX_TYPES`, `AuthenticatedGroupMutationPayloadByType`,
  `TARGET_GROUP_MUTATION_OPERATIONS`, `PRESENCE_GROUP_MUTATION_OPERATIONS`, the
  `decodeGroupMutationOperation` 23-arm switch, the member result-validation switch, the route
  contracts, and the black-box causal-evidence census
  (`state-write-evidence/api-v1-state-write-group-causal-evidence.ts`).
- **Slice 2 naming**: the aggregate allowlist is `GROUP_KEYS` in
  `authoritative-state-validation.ts` (no symbol named `AUTHORITATIVE_STATE` exists). All four
  hand-maintained lists sit at 31 keys with the same six-key formation tail. The serialized-JSON
  pin lives at `group-state/inbox/group-state-inbox-transaction-result.test.ts`, and its key order
  differs from `createTestGroup`'s — both need the append-at-end discipline independently.
- **Slice 4a**: `RtcTopologySnapshotRepository` is **not** namespace/childKey-parameterisable on
  current main — `RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE` is a module constant, the constructor takes
  only the runtime repository, and `childKey` exists only on the publication repository. The
  accepted-layout slot is a small new surface (parameterise the namespace or add a sibling), not a
  config flip. `DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS` no longer exists; retention is
  `RTC_TOPOLOGY_REPLAY_RETENTION_MS` (#345).
- **Slice 4b / C6**: the five stage-blind topology write paths verify exactly (all in
  `graph-topology-routes.ts`, all via `assertCanManageGroupRef` → business status only), plus a
  sixth non-route path: `apps/api-v1/src/admin-operations/recompute-api-admin-topology.ts` issuing
  `reconfigureTopology`. `isGroupTopologyPlannableAt` has exactly one production call site.
- **Slice 8c**: `match.ts` is now a thin composition file; the readiness wait and the `sendJson`
  fallback moved to `game/match/rallar-game-match-egress-runtime.ts`, with a second `sendJson` in
  `game/transport/rallar-game-presence-egress-runtime.ts`. The five outbound dial entry points
  verify and all converge on `ensurePeerConnectionStarted` → `computeRtcPeerDtoIfAbsent` (single
  call site).
- **Slice 11**: the deadline-hole premise changed on main. `e6a2faef6` flipped the formation-timer
  handler's missing-plan path from silent early return to a thrown retry, so the pre-existing gap
  is now unbounded retry while the planned read stays null, not a silently never-failed group. The
  repair is still owed; its shape changed. The earlier timer-id headroom worry was wrong twice over
  (review sweep): the id's `<epoch>` is the small per-group formation counter, not a timestamp, and
  `toQueueKeyPart` rewrites an over-long id deterministically — there is no truncation hazard to
  design around.
- **Slice 12**: `GroupEventType` is a 16-member string-literal union, not a `Record` — 12a's
  "only the `Record<GroupEventType, true>` one is compiler-checked" claim must be re-derived when
  that slice is selected. `validateGroupPresenceSummaryCausalRevision` (the watermark pattern to
  copy) is module-private in `compute-group-presence-summary.ts`. The coalesced-work ownership is
  split across three files (`rtc-topology-coalesced-group-revision-work.ts` computation/merge,
  `coalesced-app-outbox-work-service.ts` generation CAS, `coalesced-app-outbox-work-envelope.ts`
  metadata shape) — the #341/#343 shape; its exact-key metadata list lives in
  `rtc-topology-work-codec.ts`.
- **Pre-existing latent asymmetry, recorded for 1b**: `compute-formation-criterion-command.ts`
  gates the criterion at line 43 on `establishing | reconfiguring` but the debounced petition path
  at line 199 on `establishing` alone, so a `reconfiguring` group reaches the criterion only
  through the timer path. 1b's total stage functions make this class of divergence impossible; 1a
  renames both literals without changing the asymmetry.

Current-main gates: `check:repo-structure`, `typecheck`, `typecheck:tests`, `test:repo-governance`,
`test:deno`, `build`, `test:unit` pass on `9c8069be4` (the one `test:unit` failure was a
machine-local Deno-rewired `node_modules/.bin/playwright` link, repaired and re-verified — not a
repository fact). `format:check` fails on 25 files of pre-existing dprint drift from the #344–#350
series — none in slice 1a's file set; branch CI does not run `format:check`, and the drift belongs
to a maintainer formatting commit on `main`, not to a delivery PR. No state-write control was run:
the selected work changes no mutation path.

### Second checkpoint — executed 2026-08-27, after PR 1 (#351) and PR 2 (#353) with their review

Both PRs were reviewed at maximum effort (ten finder angles plus a gap sweep each). PR 1's rename
verified complete five independent ways; every finding against it was documentation and is repaired
at this tip. PR 2 received a hardening commit from its findings: the sparse `lifecyclePolicy`
boundary gate (`requireGroupLifecyclePolicyInputShape` — the pre-move `establishment.initiator`
input now fails loudly instead of silently widening authority to `any-member`), the
dormant-gated exhaustion condition, epoch preservation on the idempotent replan, fail-closed
stage-map lookups behind `blocksGroupPreActivationData`, an exhaustive initiator switch, the
`server-auto-requires-automatic-activation` rule, and two nets the sweep lacked (the OpenAPI
`lifecycleState` enum pin and the stored-stage acceptance matrix).

`main` moved two commits since the initial checkpoint (#352 deploy configuration and docs, #354 the
test-script path repair); neither touches a plan surface — no material change. Two review
dispositions worth durably recording: the stored-value and stored-policy hard cutovers and the
rolling-window client skew are product decision 14's posture, now restated in 1a's Risk; and
because the stored-policy codec re-runs `validateGroupLifecyclePolicy` on read, the issue-code set
is part of the storage contract — a later slice adding a rule must weigh already-stored rows, and
slice 14's runbook owns that cutover ordering.

**Next two PRs (I5, I20):**

- **PR 3 = slice 3 — causal fences and the narrow internal authority capabilities.** The fence
  primitives already exist dark from PR 2 (`GroupLayoutIdentity`, `computeExpectedLayoutFence`);
  this PR makes the existing criterion commands carry and validate them, versions the criterion
  request ids to include the layout identity (hashed under the 36-character cap via `fnv1a64`), and
  extends the split authority owners named in slice 3's section with the five-mode capability
  matrix. The criterion builders live in `group-formation-mutation-command.ts`; the semantic test
  list in slice 3's section stands, and `api-v1-group-formation-criterion.json` gains the
  `stale-petition-fenced` leg. Gates: baseline, both black-box profiles, medium-scale, state-write
  — run the fresh state-write control at PR start, before the first mutation-path edit.
- **PR 4 = slices 2 + 4a — the aggregate fields with their first reader** (I7). Unchanged from
  their sections, with the checkpoint corrections in force: the allowlists are the two distinct
  `GROUP_KEYS` plus `STORED_GROUP_KEYS` plus the OpenAPI `Group.required` block, all at 31 keys
  today; the accepted-layout slot is new repository surface (parameterise
  `RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE` or add a sibling), not a config flip; and the OpenAPI
  `lifecycleState` response enums stay at four values until a stage becomes producible — the pin
  test added at this review is the reminder.

### Third checkpoint — executed 2026-08-27, after PR 3 (#356) with its review

PR 3 landed slice 3 with a max-effort review (ten finder angles, five themed verifiers, a gap
sweep; fifteen confirmed findings, all repaired in the PR — the delivery record in slice 3's
section carries them). `main` moved three commits since the second checkpoint: #353 itself, #355
(RTC observation tooling and delivery scripts — no plan surface), and #357 (the formation-large
managed-burst fixes: the RTT-reporting degree-limit clamp and a new `api-v1-formation-gate.yml`
workflow). Checkpoint facts verified against that main:

- The four Group allowlists stand at 31 keys (both `GROUP_KEYS`, `STORED_GROUP_KEYS`, OpenAPI
  `Group.required`) — the second checkpoint's PR 4 numbers hold.
- `RtcTopologySnapshotRepository` and group-state persistence are untouched by #355/#357; slice
  4's structural facts (one never-expiring row per group, publication retention copies) stand.
- **Superseded plan fact:** formation-large now runs in CI as the "API v1 Formation Gate" — 1a's
  "no workflow executes that profile" note is historical. The gate is green on PR 3's head.
- **Known main regression:** #357's clamp broke the pre-existing Deno test
  `pglite-topology-command.test.ts` "filters RTTs outside recomputed group reporting edges"
  (expects filtering below the now-clamped reporting limit); reproduced at `origin/main`
  95dabd1cf and filed as its own follow-up. `test:deno` verdicts are read net of it until fixed.

**Next PR (I5, I20): PR 4 = slices 2 + 4a — the aggregate fields with their first reader**, as the
second checkpoint selected, now with the review-added acceptance criterion in 4a's section: the
promotion's conditional guard must re-validate the planned identity inside the guarded write,
closing the read-to-commit fence window slice 3 documented as interim. The petition boundary is
already at post-commit (the review moved it), so 4a consumes that ordering rather than
re-establishing it.

### Fourth checkpoint — executed 2026-08-27, after PR 4 (#359) with its review

PR 4 landed slices 2 + 4a with a max-effort review (ten finder angles, cross-verified; fifteen
confirmed findings, all repaired in the PR — the review-repairs record in slice 4a's delivery notes
carries them; the headline was the promotion mint gate reading enqueue-time state, now fresh and
self-reconciling). No plan-surface change arrived on `main` beyond this workstream's own PRs.

**Next two PRs (I5, I20):**

- **PR 5 = slices 4b + 4c — slice 4 completes.** 5b's connect fence explicitly needs 4b, so the
  stage-keyed planning gate (replacing `isGroupTopologyPlannableAt` across every topology write
  path) and delivery correctness (repair and hydration pinned to the accepted row, the criterion to
  the planned one, `GroupTopologyManagementView` carrying both with `pending` populated) come
  before the command family. Gates per slice 4's line: baseline, both profiles, medium-scale,
  topology-replay, state-write, `test:integration:postgres`.
- **PR 6 = slices 5a + 5b — `plan` and `connect`, dark**, with the connect fence and the two typed
  denials; 5c's `pause`/`resume` follows separately (cheapest, `transportState`'s first writers),
  then 5d/5e per their stated needs.

### Fifth checkpoint — executed 2026-08-28, after PR 5 (#362) with its review

PR 5 merged to `main` as `cae0c07ae` after the ten-angle review cycle (fifteen confirmed findings,
all repaired in-PR; the delivery and review-repair records live in slice 4's section). `main` also
carries `5dfd2161a` from a parallel session — the browser-cache pre-connect read fix, no overlap
with this plan's surfaces. Slice 4 is complete: the stage-keyed gate, the accepted-first delivery
rule with its tombstone and member-aware qualifiers, the populated management view, and the frozen
path's counter and real-Postgres coverage are all live and gated.

**PR 6 = slices 5a + 5b as the fourth checkpoint selected — confirmed.** 5b's stated need (4b) is
satisfied and verified end-to-end; 4a's promotion outcome vocabulary
(`no-planned-layout`/`planned-layout-superseded`/`stale-fence`) is already the fence language
decision 32 asks connect to speak, so 5b builds on an existing compute rather than a new one. Both
commands land dark — registered through the full census, mounted on no route, emitted by no
producer — so the tree's live behavior is unchanged and the inventory counts move only where
semantics say they must (AppInbox types and trusted vocabulary, not routing entrypoints).

**Resolved at the sixth checkpoint (2026-08-28): no routes move early, and 5d does not rewrite the
recipes.** The question was when `plan`/`connect` get HTTP routes, because a recipe rewrite needs
reachable paths. This is a **ruling between two entries that disagree**, not a reading the 5d text
settles on its own: the 5d bullet lists the `AppInboxType`, the operation and the recipe call sites
under 5d and carves out only "the route and OpenAPI path" for 8d, which reads as 5d retiring them.
Three other entries say the opposite and are more explicit, so they win — 8d's entry ends "**No
earlier slice removes them**", 6a's parallel entry says "**Nothing leaves before the route
cutover**", and slice 9 verifies the commands are gone "after 5d and 6a **inventoried** them and 8d
**removed** them". The rewrite is therefore 8d's, no route mounts early, and I8's atomic cutover is
preserved. The 5d bullet above now says so in its own text rather than being left to contradict this.

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

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                           | Owning slice |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| C5  | **Business status × stage is undefined.** `updateGroup` archives and deletes without touching `lifecycleState`, while every transition asserts active business status first. An archived, deleted or expired group in `planned` has no defined condition and no defined accepted layout.                                                                                      | 1b, 2        |
| C6  | **Six stage-blind topology write paths bypass the held layout**: the topology `reconfigure` route and the config and override `PUT`/`DELETE` pairs in `graph-topology-routes.ts`, plus the admin `recompute-api-admin-topology.ts` path, all enqueue recompute work checking only business status. Under `commanded` replanning they would publish a layout nobody asked for. | 4b           |
| C7  | **Departures are not defined under held and `commanded` replanning.** Presence expiry and session cleanup always flow into a replan today. A `match` group whose player crashes must not sit silently on a layout naming a dead session — under product decision 30 it reads `degraded` / `awaiting-application`.                                                             | 4c, 10a      |
| C8  | **`apps/relic-hunter-server-v1` is a second full Rallar server**, not one extra call site: it calls `createDefaultRallarServer` and reads the same group rows through the same exact-key validator. Every required `Group` field and every stage-derived halt reaches it.                                                                                                     | 2, 7         |
| C9  | **The operator surface is stage-blind.** `GroupAdminSupport.explainGroup` emits no lifecycle fact, the formation metrics family has no bucket for stage commands or status writes, and the black-box workbench has no lifecycle collection. A stuck `planned` group is currently undiagnosable.                                                                               | 13           |
| C10 | **The two shipped games mis-handle a halt.** Relic Hunters' networking sends per render frame and treats anything but `sent`/`partial` as failure with no back-off; AR Eye Hunter's arena helper maps unknown statuses through a `default` arm. A new halted status makes both spin.                                                                                          | 8c           |

## Decisions taken at planning

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | **The rename lands first, alone, and mechanically.** `establishing → connecting` is one PR keyed on the _field name_ (`lifecycleState` / `GroupLifecycleState` / the `"lifecycleState"` JSON key), never on the value. `'active'` has 1,330 occurrences across seven meanings; `establishing` (the stage) and `establishment` (the policy namespace) are different words. Product decision 14 forbids the shim that would stage it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| I2  | **Exhaustiveness becomes compiler-enforced before any new stage is reachable.** There is not one exhaustive `switch` and not one `Record<GroupLifecycleState, …>` in the repository; every consumer is a negative or equality comparison, so _adding_ three stages produces zero compiler errors and silently routes them down whichever branch the predicate picks. Slice 1b introduces one stage registry, derives the three untyped runtime validator arrays and `EVERY_LIFECYCLE_STATE` from it, and converts every stage predicate into a stage-keyed pure function returning exactly what the comparison returns today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| I3  | **Causal fences and narrow internal capabilities land early, not late.** Slice 3 adds required `expectedFormationEpoch` and `expectedLayout` to existing criterion commands and owns the new internal authority modes in I19, so `applyPlannedLayout`, triggers, status writes and internal `connect` are fenced and least-privileged from birth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| I4  | **The status axes do not ride the aggregate's first field edit.** A condition pinned at `inactive` on a live group for eight slices is a lie on the wire. The key-list edit is paid twice; new fields go last and wire order stays stable, so the second edit is cheap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| I5  | **Only the next two delivery PRs selected from current evidence are concrete.** At this planning pass, PR 1 is the mechanical `establishing → connecting` rename (1a) and PR 2 is dark contract closure (1b + 1c); both must be revalidated at the initial Slice 0 checkpoint. Each later checkpoint selects the next one or two under I20. Every later numbered or lettered label is a capability-analysis anchor whose owners, hazards and acceptance survive regrouping; it is not a PR count or merge-order commitment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| I6  | **Every slice's gates are named in its own section, not in an appendix.** Three gates are not in branch CI and are therefore invisible unless named per slice: `test:rallar:full-stack:memory:live-rtc-3`, the local medium-scale run, and **Run Hetzner Supported Distributed Manifests** (push-to-main only, required before the plan may be marked complete).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| I7  | **A persisted field lands with its first reader.** The control-plane workstream recorded this as its own slice-1 lesson: _"Persisting a document nothing reads would put an AppInbox mutation-path change into a slice that otherwise carries no risk. It lands with its first reader."_ So slice 2's aggregate fields merge in the **same PR as slice 4a**, which is what first reads them. That pays medium-scale and state-write once instead of twice, and removes the only dark-plumbing hazard in the plan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| I8  | **Route mounting is one atomic cutover and comes last.** Seven new public routes (`plan`, `connect`, `reconfigure`, `pause`, `resume`, `reset`, `start`) join the already-mounted `activate` route, producing eight application-facing commands; both legacy routes leave in the same PR. Until then new commands remain route-less and policy validation reports inert behavior-changing fields rather than storing them as though they worked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| I9  | **Citations name symbols, not lines.** Between the two census passes `main` moved five commits and invalidated 18 of 64 line citations while leaving nearly every symbol name intact. Exported symbols and test constants (`EVERY_LIFECYCLE_STATE`, `TRANSITION_TARGETS`, `COVERED_API_MUTATIONS`) are the durable anchors; `file:line` is reserved for the handful of lines whose exact position is the point.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| I10 | **Decision 41's three mechanical rules are slice 1b's acceptance criteria, not aspirations.** The transition table is keyed on `(stage, command) → stage`; every stage-keyed decision is a total function over the stage registry; every status function is total over the business plane. Each is checkable: no `Record<GroupLifecycleTransition, GroupLifecycleState>` survives, no bare `lifecycleState !==` comparison survives outside the registry, and the condition matrix has a row for archived, deleted and expired. Without these, adding the eighth stage costs what adding the seventh cost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| I11 | **The transport halt lives at the WS relay, not in the shared message predicate** (was Q3). `canSendGroupMessage` stays the _policy_ predicate. `pause` is defined on the transport plane — it stops data crossing edges in the room — and a REST command to a game server is not that. Relic Hunters reads `transportState` from the snapshot and decides for itself, which is the stated division of responsibility. _Alternative rejected:_ folding the halt into the shared predicate, which would make every Relic Hunters REST command on a halted group return 403 and ships with game work attached (C10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| I12 | **Neither reconfigure mutation merges or sequences — the stage transition already drives the replan** (was Q4). `compute-lifecycle-transition` sets `presenceSummaryWork: 'enqueue'` unconditionally, the presence-summary worker writes coalesced topology work, and all of it commits with the group row, so entering `reconfiguring` already enqueues a replan atomically. The only work is that a _commanded_ reconfigure must not be change-gated, or the fingerprint gate skips it when membership has not moved; `isChangeGatedGroupRevisionWork` already distinguishes kinds, so that is one flag. _Alternatives rejected:_ merging (widens two byte-exact write validators for a guarantee the existing path already gives) and sequencing (which is what already happens, with extra ceremony).                                                                                                                                                                                                                                                                                                                                                |
| I13 | **The in-flight bound reaches the browser as a nested member-policy object on the `Group`** (was Q2). The resolved member-tier values ride the snapshot/delta/hydration path the reconciler already reads, and `transports` gets a home without a second five-list edit. Costs a field validator now — the `FORMATION_OUTCOME_KEYS` pattern in `validate-persisted-group.ts` is the shape to copy. _Alternatives rejected:_ a bare number (cheaper now, but the next member-policy field pays the whole edit again) and a formation-view read (not pushed, so the browser needs a round trip before its first dial).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| I14 | **The status writer damps on a coalesced APP_OUTBOX row** (was Q6). The per-group coalesced row with its generation CAS is already the repository's cross-node coalescing primitive — it is what damps topology replanning today — so cluster-wide damping needs no new durable shape, and its `dueAtEpochMs` doubles as the read surface's "when will this settle". _Alternatives rejected:_ leader-only writing (couples a non-authoritative projection to manager election, so a re-election gap becomes a status gap) and accepting N× (bounds changes, not attempts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| I15 | **The `removed` tombstone publication stays, and extends to `dormant`** (was Q7). It is the teardown signal: it is how a browser learns to drop its layout and evict peers, and `reset` depends on it or members sit holding a layout for a group that has been turned off. It is also reversible — publication can stop later once the browser is stage-aware, but a member that already missed the signal cannot be told retroactively. _Alternative rejected:_ dropping on stage alone, which couples slice 4b's correctness to slice 8b.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| I16 | _Superseded 2026-08-27 by I25 — the refactor had already landed via #338._ ~~**`mutationDescriptor` is refactored to a named input interface in slice 5a**~~ (was Q9), before the new commands arrive rather than after. Six positional parameters already violate the three-parameter standard. _Correction to an earlier draft:_ the justification given there — that this workstream adds a seventh parameter — is wrong; the causal fence rides inside `request`, so the arity stays at six. The refactor still stands on the standard alone, but note where it leads: the function's only remaining job is defaulting `targetPrincipalId` and `sessionId` to `null`, both of which `GroupMutationDescriptor` declares required, so a named input makes it an identity over that type and the honest outcome may be deletion rather than renaming. 36 call sites across 9 files, 22 of them in one. _Alternatives rejected:_ registering an exception (permanent, on a function this workstream is actively growing) and splitting the function (a design change to something six registries depend on, in the slice that adds four commands to it). |
| I17 | **Member progress keeps the arrays and gains the accepted layout identity** (was Q10); no fraction on the public API. The arrays are strictly more informative than a ratio, and the identity lets a UI anchor its bar and re-baseline when the layout changes — product decision 40's stated trap is that an unanchored fraction runs backwards during formation. It also makes "no layout" an absent identity rather than a misleading 1. _Alternative rejected:_ shipping a computed fraction, which bakes the no-layout, edgeless-layout and layout-changed cases into the public surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| I18 | **`reset` marks both topology slots obsolete inside the lifecycle transaction; it deletes nothing.** It clears `Group.acceptedLayoutIdentity`, tombstones accepted and planned with `state: 'removed'`, and retains both valid fingerprints. The planned tombstone disarms the change gate because it evaluates only an active planned snapshot. Physical delete, expiry and follow-up cleanup are rejected because they weaken traceability and atomicity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| I19 | **Internal group mutations use narrow source capabilities, owned once in slice 3.** `topology-publication` may invoke only route-less `applyPlannedLayout`; `formation-automation` may invoke only automatic `plan`, `connect` and `reconfigure`; `activation-status` may invoke only the damped status update. Existing `formation-criterion` remains limited to criterion/retry transitions. Invocation site does not redefine authority: a post-publication hook completing a latched connect still uses `formation-automation`, never `topology-publication`. A single broad mode and widening `formation-criterion` are rejected because they combine independent producers and weaken least privilege.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| I20 | **Replanning from the latest `main` is mandatory whenever its changes materially affect this plan.** At every next-one-or-two-PR checkpoint, inspect `main` changes since the previous pass against the product constraints, ownership, contracts, dataflow, failure boundaries, acceptance and validation assumptions used by the affected work. Material evidence stops that work until the affected repository truth is re-recovered and the implementation decisions, decomposition, dependencies, risks, gates, next concrete PRs and semantic PR explanation are revised. Harmless commit or line movement requires no replan. Replanning is evidence work and does not itself require a merge or rebase. _Alternatives rejected:_ treating Slice 0 as a one-time census, which lets later work execute against stale authority; and synchronising the branch for every base movement, which confuses planning correctness with Git integration.                                                                                                                                                                                                   |

Decisions I21–I25 were taken while delivering and reviewing PR 2 (1b + 1c) on 2026-08-27:

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I21 | **The trigger vocabulary carries a `manual` member, and the presets choose their triggers by character.** `manual` mirrors `GroupActivationMode`'s use of the word — no automation at that boundary. Presets: `optimistic` and `drop-in-social` are `immediate`/`immediate` (inert under immediate formation); `managed` is `manual`/`immediate`, so the manager's one `plan` command starts the wiring, preserving today's single manager action; `match` is `manual`/`manual`. _Alternatives rejected:_ nullable trigger fields (null handling at every consumer for a semantic a discriminant states), and `immediate`/`immediate` for `managed`, which would auto-plan a group whose preset exists to let the manager decide when it starts.        |
| I22 | **The new policy fields are validated-but-inert, not input-rejected** — refining I8's gating sentence. The sparse input's only shared seam across the HTTP and JSON-wire paths sits inside the AppInbox compute where a policy-style rejection does not fit; the product plan mandates input rejection only for `strictConfirmation`; and a temporary rejection gate is exactly the temporary machinery product decision 14 rejects. Honesty is kept by the cross-field rules (`server-auto-requires-automatic-trigger`, `server-auto-cannot-command-replanning`, `replan-window-exceeds-maximum-wait`), the OpenAPI "stored and validated, not yet behavioural" descriptions, and the recipes. I8's route-cutover core is untouched.                   |
| I23 | **The business-plane rows of both status axes read `inactive` / `none`.** An archived, deleted or expired group's routing plane is frozen, so no coverage claim and no remediation claim is honest — the C5 row values I10 requires, now encoded in `computeGroupActivationCondition` and `resolveGroupActivationRemediation` as precedence zero.                                                                                                                                                                                                                                                                                                                                                                                                       |
| I24 | **The settled numeric constants**: status dwell 3 000 ms, `active ↔ degraded` hysteresis width 0.05, evidence expiry 30 000 ms, minimum layout age 1 000 ms, RTC setup timeout 15 000 ms (`compute-group-activation-condition.ts`); per-group debounce window default 500 ms — matching today's `topology.recompute.formationDebounceMs` server default, an unbounded operator knob the clamped per-group field supersedes for replanning when slice 10 lands — clamped at 30 000 ms, maximum replan wait default 5 000 ms clamped at 600 000 ms, trigger delay clamp 600 000 ms (`to-normalized-group-lifecycle-policy.ts`). Pinned by the policy and status matrices so no later slice invents values under pressure.                                 |
| I25 | **Supersedes I16: the `mutationDescriptor` refactor had already landed on `main` via #338** (`MutationDescriptorInput`, one named parameter), one day after this plan's last edit, so slice 5a carries no refactor. What survives of I16 is its own closing observation: the function's remaining job is defaulting `targetPrincipalId` and `sessionId` to `null` on a type that declares both required, so the honest outcome may be deletion. That question is decided in slice 5a with the four new commands in hand, where the call-site shape is being edited anyway. _Alternative rejected:_ deleting it during a governance pass — 36 live call sites across 9 files edited outside any behavioural slice, with no gate that exercises them all. |

The held-layout capability is the next milestone under current evidence, but every checkpoint selects
only its next two independently reviewable PRs. Later labels below are capability-analysis anchors used
for dependencies and navigation; I20 permits their owners, boundaries, grouping, order and even their
continued necessity to change when current `main` provides material evidence. They do not commit file
lists, PR counts or merge order. The gate table is condition-based so those anchors cannot become a
shadow delivery schedule.

## Slice 1 — Contract closure

### 1a — The `establishing → connecting` rename

**Lands** (inventory corrected at the 2026-08-27 checkpoint, re-corrected at the review): the
single rename everywhere in one commit — the enum in `group-lifecycle-policy.ts`; the stage values
inside `TRANSITION_SOURCES` and `TRANSITION_TARGETS`; the three stage literals in the topology-work
predicates plus one comment; the three untyped runtime validators, each holding
`['forming', 'establishing', 'active', 'reconfiguring']` as a bare `readonly string[]`
(`authoritative-state-validation.ts:433`, `group-state-delta.ts:193`,
`validate-persisted-group.ts:110` — bare arrays, so the line is the only address); both OpenAPI
`lifecycleState` enum lines plus the two all-caps stage mentions in the establish/activate route
descriptions; 23 recipe assertions across 9 files; 21 typed test literals plus three test titles
and comments across 10 files; the stage-derived recipe identifiers — `zeroEstablishingGroupId` and
its references, seven step names, six request-id segments, one `displayName`, the
`createEstablishingSnapshot` test helper and one `recipe-matrix.json` scenario description; and the
19 stage-describing lines in `docs/rallar-group-formation-architecture.md`, so the doc stays
truthful about the wire value until slice 14's full rewrite. The command-derived `/lifecycle/establish/` path and
`start-establishment-{runId}` request id are **not** part of this rename — an earlier draft's
parenthetical listing them contradicted I1, 5d and 8d; no occurrence of `establishment` anywhere in
the repository is stage-derived, and the two words meet only at `group-lifecycle-transitions.ts`'s
`'start-establishment': 'establishing'` entry, where the key is the command and the value is the
stage.

**Dark:** nothing. The value is on the wire the moment a group establishes. That is why it goes first
and alone.

**Risk:** a value-keyed sweep damages unrelated code. The complete survivor allowlist for the
finalisation sweep (review-verified): the two English uses in
`docs/test-structure-coupling-exceptions.md`, and the dated planning records under
`playground/rtc-design/` — where the product plan's decision 1 and finalisation criterion name the
old value deliberately and its "What holds today" section is an explicitly dated code snapshot.
Nothing else may carry the word. And the rename is a hard cutover for durable state and
open browser tabs (product decision 14 forbids the accept-both shim): a group row persisted mid-dial
as `establishing`, and a pre-rename bundle receiving a post-rename delta, both fail their validators
until the environment is reset or reloaded — nothing deployed carries such state, which is what
makes the cutover legal, and slice 14's runbook records the ordering.

**Gates:** baseline + both black-box profiles — a partial landing fails at runtime in the recipes, not
at build time — **plus one `formation-large` profile run**, because the two managed-burst recipes
carry only that profile, which no workflow executes, so four of the 23 assertions are outside every
CI gate. That run's verdict: the four renamed cells pass in both recipes; the profile itself is red
with a pre-existing `thresholdActivatesAtScale` timing failure reproduced identically at the merge
base, filed as its own follow-up. No medium-scale; no mutation semantics change. The review added the two nets the sweep
lacked: the OpenAPI `lifecycleState` enum pin in `rallar-group-public-contracts.test.ts` and the
stored-stage acceptance matrix in `validate-persisted-group-lifecycle.test.ts`.

### 1b — Stage widening and the pure function library (dark)

**Lands:** `GroupLifecycleState` widened with `dormant | planned | reconnecting` — three members.
Halting is _not_ among them (product decision 25 keeps it on `transportState`), but the clean slate
_is_ a stage (product decision 35). The transition table is reshaped, and the pure library lands with
its matrices, called by nothing.

`TRANSITION_TARGETS` is `Readonly<Record<GroupLifecycleTransition, GroupLifecycleState>>` — one target
per transition. It cannot express `connect` landing in either `connecting` or `reconnecting`, nor
`fail-formation` landing in `forming`, `active` **or** `dormant` (product decisions 28 and 35). **The
table shape changes, not just its entries**, and product decision 41 fixes the replacement shape:
keyed on `(stage, command) → stage`, so the next stage is a table entry rather than a refactor.
Checkpoint addition (2026-08-27): `TRANSITION_SOURCES` is a co-equal second table in the same file —
`Record<GroupLifecycleTransition, readonly GroupLifecycleState[]>`, the legality half, membership
tested by a runtime `includes` — and the `(stage, command)` registry replaces **both**. Beyond
`EVERY_LIFECYCLE_STATE`, the registry derivation also covers the hand-written stage arrays in
`group-lifecycle-transitions.test.ts` and `group-admission-decision.test.ts` and the two
three-element `as const` "every state except forming" subsets in `group-admission-decision.test.ts`
and `group-topology-planning-service.test.ts`.

The library: the seven-stage transition table with C2's landing rule and the `connect` precondition;
`resolveDialLayoutRoles(stage) → none | planned | accepted | accepted-and-planned`; the complete
stage-keyed topology-work disposition (`dormant`/`forming`: publish removal,
`planned`/`reconfiguring`: plan, `connecting`/`reconnecting`: freeze the current planned identity and
rely on the transition's unconditional follow-up enqueue to replan latest authority, `active`: defer
to replanning policy); and the invariant that every stage registry has exactly one row;
`resolveLayoutRole(publication, accepted) → accepted | planned | superseded | incomparable` — a thin
wrapper over the existing causal comparators and state check; `computeGroupDataGate(stage,
transportState, preActivationAppData) → flows | blocked | halted`; total condition and remediation
functions; `resolveCoverageBasisLayoutIdentity(stage, accepted, planned)` used by every status causal
key; fingerprint staleness; the in-flight axis; trigger evaluation; expected fences; and the total
admission × stage matrix, including `dormant` and product decision 38's preserved admission posture.

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
`topology.recompute.formationDebounceMs` (500 ms) from the api-v1 configuration defaults, not from
the exported `DEFAULT_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS`, which has no references at all and should be
deleted. Checkpoint addition (2026-08-27): two more hand-maintained lists join this slice's edit
inventory — the stored-policy exact-keys list in `decode-stored-group-lifecycle-policy.ts` (a new
root policy key breaks every stored row unless the codec lands in the same change) and the
configuration source allowlist in `decode-api-v1-configuration-source.ts`, which is separate from
the decoder in `decode-api-v1-configuration.ts`.

**Gates:** baseline + the policy matrix test.

## Slice 2 — Aggregate ownership fields

**Delivers in the same PR as slice 4a** (I7), which is their first reader.

**Lands:** the accepted layout identity `{groupRevision, presenceRevision, version, state}` (product
decision 29) and `transportState` as required `Group` fields with creation values that are pure
functions of what exists, threaded through **four hand-maintained key allowlists that no compiler
links and no test cross-checks**: `GROUP_KEYS` in `authoritative-state-validation.ts:65`, a second
distinct `GROUP_KEYS` in `group-state-delta.ts:46` (same name, different module-private list),
`STORED_GROUP_KEYS` in `validate-persisted-group.ts:16`, and the OpenAPI
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

**Delivery record (PR 4, slices 2 + 4a, 2026-08-27).** Landed as specified with these verified
findings:

- **Apply-landing promotion is live behavior, not dark**: the default policy's
  `reconfigureLanding: 'apply'` makes promotion-on-publication today's implicit semantics made
  explicit. Decision 27's gate is read from the group's policy in the publication write phase
  (`hold` promotes only through activate; corrupt fails closed; an absent consumer port mints
  nothing) — the reconnect-resync recipe caught the missing gate before it shipped. Two recipes
  pinning exact revisions on apply groups now create with `hold`, the first recipe coverage of it.
- **The read-to-commit fence race is closed**: the promotion's guarded batch re-asserts the planned
  row's revision inside the transaction, so a replan between read and commit conflicts the batch.
  The PR 3 acceptance criterion is met one slice early via the revision assert; slice 4b+ may still
  move the rows into group-state ownership.
- **Measured state-write cost of apply landing** (all artifacts in `tmp/perf/pr4-*`): hot
  `sql.statements` ≈ +4% (covered by the new `planned-layout-promotion` recorded-reason profile,
  following the durable-append and formation-damping precedents), uncontended p99 +6–7% (promotion
  writes on the tail), hot throughput draw-dependent within the machine's documented comparator
  noise (control samples 38.3–48.4/s, head 30.5–49.0/s). Byte-headroom concern (C-risk in slice 2):
  `serializedResultBytes` passed in every comparison.
- **Promotion recipe legs** defer to slice 5's surfaces with the same reasoning as slice 3's
  deferral; the promotion matrix is pinned at compute level and through the durable service read.

**Review repairs (PR 4 max-effort review, 2026-08-27).** Ten finder angles and a cross-verified
sweep confirmed fifteen findings, all repaired in the PR:

- **The mint gate reads fresh durable facts and reconciles.** The promotion request had gated on
  the work payload's enqueue-time group snapshot, so a plan published after activation from a
  stale-connecting work item minted nothing and the skipped-unchanged path never healed it —
  accepted and planned could diverge permanently on a stable group. The write phase now reads the
  current group row, checks the group's accepted identity against the target layout, and mints in
  both the write and the unchanged branches, so any missed request re-derives on the next cycle.
  The cheap checks run before the policy read; the entry is stamped never-expire (it had inherited
  a finite 24-hour expiry on the RTT-refresh path); a same-identity request that already exists is
  treated as already-requested instead of wedging the publication transaction; and entries carry
  the server's sender id.
- **Compute re-checks the landing.** applyPlannedLayout reads the lifecycle policy and rejects a
  promotion whose group has hold landing or an unreadable policy — decision 27's rule holds even
  for entries minted before a future policy change, and slice 6's per-call overrides inherit the
  check.
- **The accepted-fingerprint copy is deferred to its consumer slice.** As landed it could go stale
  (a null-fingerprint promotion left the previous row standing), pair skew (the fingerprint read
  was not revision-fenced with the snapshot, and the unchanged path rewrites fingerprints without
  bumping the planned revision), and throw untyped from the write path. Slice 6/7 lands the copy
  with revision-coherent reads when the comparison consumer exists.
- **Contracts tightened**: applyPlannedLayout's fences are non-null (no path can produce null),
  the layout row types carry no derivable or dead fields (identity derives from the snapshot at
  use; the accepted read is a raw revision without a structural decode), the promotion decode
  validates against the exported layout registries with non-negative and non-empty readers, and
  the state-write reason profile is re-attributed honestly (the bench executes no promotions; the
  residue is row width plus documented drift).

**Recorded rulings and corrections from the review:**

- **Operator activation may promote a stale stored plan** (no epoch fence on principal commands):
  ruled as today's semantics made recorded — reconnect and repair already converge on the stored
  row, and the accepted row only records that fact. Slice 5b's connect fence closes it properly.
- **The activation dark-landing softening** (operator activate with no stored plan commits without
  accepted facts) is owned by **slice 5b**: when connect carries the universal fence, activate
  tightens to the plan's "the stage cannot commit without the accepted row and identity", and the
  softening's removal is part of 5b's acceptance.
- **Slice 10's producer claim is superseded**: the apply-landing producer landed here, live; slice
  10 only flips policy defaults and modes, and must not re-land a producer (decision 42's
  one-producer story).
- **Deploy posture (decision 14)**: the two new required group keys are a hard cutover — every
  pre-deploy group row and every durable queue row embedding a GroupSnapshot fails decode under
  this build. Both servers deploy before traffic; reused local or fleet databases are dropped;
  slice 14's runbook owns production ordering.
- **Promotion requests are per-(epoch, identity)**, not coalesced per group: the queue writer has
  no replace primitive, so per-group keys would corrupt on payload mismatch; a burst of N replans
  costs N−1 typed fence rejections, bounded and observable. Recorded so a future "fix" does not
  coalesce the key without adding replace semantics.
- **The OpenAPI `nullable: true` beside `$ref`** follows the file's established (3.0-style) idiom;
  under strict 3.1 readers it is a no-op. Recorded as a file-wide idiom to modernize in one sweep,
  not per-field.

## Slice 3 — Causal fences and narrow internal authority capabilities

**Needs:** PR 2's dark command and stage contracts. This slice owns the internal-authority protocol
once; later capabilities consume it and do not widen it.

**Causal fences:** `expectedFormationEpoch` and the full `expectedLayout` identity are mandatory on
every internal command and are validated in pure `compute` against freshly read durable authority.
The existing criterion builders and request ids are versioned to include the layout identity. A stale
fence is a typed no-op/rejection that writes no state, event, receipt effect or outbox; request-id reuse
with different semantics remains a typed idempotency conflict. Composite identities are hashed where
the 36-character queue resource-id cap prevents spelling them.

**Authority protocol owner (I19):** extend `GroupMutationFacts.internalAuthority`, its exact-key codec,
preparation operations, AppInbox type-to-payload relationship, command registration and **both halves
of the split authority validation — mode validity in `validateGroupMutationFacts` and the
mode × operation matrix in `validateGroupMutationAuthority` →
`validateInternalMutationAuthority` → `validateFormationCriterionAuthority`** (the checkpoint found
no single `validateTrustedAuthorityMode` owner exists) — with this total capability matrix:

| Internal mode                | Permitted operations                                                      | Producer                                    |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| `formation-criterion`        | existing criterion activation, failure and bounded retry transitions only | readiness/deadline criterion                |
| `formation-automation`       | automatic `plan`, `connect` and `reconfigure` only                        | plan/connect triggers and replanning policy |
| `topology-publication`       | route-less `applyPlannedLayout` only                                      | accepted planned-publication transaction    |
| `activation-status`          | internal activation-status update only                                    | damped coverage/status evaluator            |
| `expiry` / `session-cleanup` | existing presence-maintenance operation only                              | existing maintenance owners                 |

Each mode gets a separately named preparation method and queue registration. No public request may
supply an internal mode, no internal command may claim an actor principal/session, and every
mode/operation cross-product outside the table fails closed. The topology post-publication hook that
continues a satisfied connect trigger uses `formation-automation`; invocation from the topology
subsystem does not turn that policy intent into `topology-publication` authority.

Produce the required construction/registration and runtime invocation timelines: dependency creation,
preparer and queue registration, first invocation, command translation, read/compute/validate/write,
first conditional guard, AppInbox transaction/retry owner, receipt/event/result/outbox writes, commit
return, after-commit wake, replay and caller-visible result.

Move criterion petitions that name a layout identity to the post-publication boundary. Keep
`formationAttemptCount` growth owned by `fail-formation`; successful manual or criterion activation
resets it in 4a's atomic activation/promotion transaction, while reset owns the other zero in 5e.

**Semantic tests:** every allowed and denied mode/operation pair; authenticated-authority exclusion;
malformed and unknown mode rejection; stale epoch/layout writes nothing; same-id/different-hash
conflict; matching replay returns the durable result; conflict retries re-enter full
read/compute/validate/write; retry exhaustion and injected write failure roll back state, event,
receipt, result and outbox. `api-v1-group-formation-criterion.json` gains the
`stale-petition-fenced` leg and the failure → activation → later reconfiguration budget matrix.

**Gates:** baseline + both black-box profiles + **medium-scale** + **state-write**.

**Delivery record (PR 3, 2026-08-27).** Landed as specified, with three verified corrections:

- **No hashing needed for the v2 request ids.** The 36-character cap binds the queue resource id,
  which is already derived from the sha256 causal token (`group-state-service.ts`
  `queueResourceId: g-${causalToken.slice(...)}`), never the raw command id — so
  `formation-criterion:v2:*` ids spell the full fence (canonical JSON) instead of an `fnv1a64`
  digest, and the second checkpoint's hashing instruction is retired as conditionally scoped to a
  surface the command id never reaches.
- **Recipe legs deferred to slice 5.** The `stale-petition-fenced` leg needs an HTTP-forceable way
  to move the stored planned layout between petition build and delivery, and the
  failure → activation → later reconfiguration budget matrix needs `reconfigure`; both arrive with
  slice 5's `connect`/`reconfigure` surfaces. The fence rejections are pinned at compute level
  (stale-epoch, superseded, no-planned-row — each asserting a rejection receipt with no event and
  no outbox ids).
- **Absent fence keys: no fence on requests, malformed on commands.** The lifecycle request rows
  exclude the fence keys, so raw principal requests arrive with the fields absent and validate
  cleanly; the built command contract requires the keys present (null-or-shaped), enforced at the
  command decode boundary — so a wire-decoded command missing them fails as an honest terminal
  malformed error, never as a lying stale-epoch rejection in compute. The request-validation tests
  pin fence-less principal requests and the exact-key rejection of a client-spelled fence key.

**Review repairs (PR 3 max-effort review, 2026-08-27).** Ten finder angles, five themed verifiers
and a gap sweep confirmed fifteen findings; all were repaired in the same PR:

- **Criterion petitions now fire at the post-publication boundary in fact, not just in identity.**
  The evidence leg had petitioned pre-commit with the freshly computed candidate — never persisted
  on the skipped-unchanged path (fingerprint only, while the causal revision drifts), not yet
  persisted on the changed path — so the delivery-time fence terminally rejected the decisive
  activation; in threshold-only mode (no deadline timer) a connecting group could stall
  permanently. The petition now runs after the write-phase commit, fencing on the row the store
  actually holds (stored row when unchanged, committed snapshot when written, none when
  superseded).
- **Tombstones never activate a group.** A removed plan's empty edge set reads as observedRate 1,
  and the deadline leg had no state guard while the fence matched the tombstone against itself.
  `computeFormationCriterionCommand` now refuses any non-active plan centrally, the deadline leg
  retries (rather than consumes) its durable timer on a missing-or-removed plan, and the fence
  compute rejects an activation naming a removed layout as a typed backstop.
- **The capability matrix fails closed structurally.** The mode switch gained a default-throw with
  a `never` exhaustiveness anchor (an unhandled future mode is a compile error, not fail-open); the
  mode registry is one exported `as const` tuple the union derives from; the fence-required guards
  reject absent alongside null; and the three inert-mode preparers run the matrix at prepare time,
  so a command a mode cannot execute fails at the call site instead of poisoning the queue.
- **Fence keyed on fence presence, not producer.** `computeFenceRejection` runs for every lifecycle
  command (a no-op for null fences), so future fenced routes — slice 5b's principal `connect`
  included — inherit validation instead of re-adding a mode branch; the planned-layout read fires
  only for layout-fenced commands, is attached by the service after the group-row read, and the
  dead `?? stored.formationEpoch` fallback that neutralized the shared helper's stale-epoch branch
  is gone.
- **Known interim race, closed by slice 4:** the planned layout lives in the topology namespace,
  outside the group-row CAS the write guard covers, so a replan committing between the fence read
  and the activation commit is undetected (window: one read-compute-validate-commit span). Slice
  4's group-state-owned planned/accepted rows must bring the fence identity into the guarded
  write; record that as an explicit slice-4 acceptance criterion.
- **Deploy-boundary posture (decision 14):** in-flight v1 criterion rows fail decode under this
  build as honest terminal malformed errors, and v2 rows drained by old-code workers terminally
  fail as authority-denied — both directions drop the queued decision. A quiet connecting group
  (no further RTT evidence) then waits for operator action; groups with live RTT traffic self-heal
  on the next evidence petition. Deploy with formation quiesced or accept the drop; slice 14's
  runbook owns the ordering. Operationally, repeated `no-planned-layout` rejections on groups that
  just published a plan are the signature of a mis-wired (constant-null) planned-layout reader.

## Slice 4 — Accepted and planned layout ownership (the held-layout foundation)

The structural blocker, verified: `RtcTopologySnapshotRepository.snapshotKey(ref)` is the group
storage key alone (`rtc-topology-snapshot-repository.ts:206`) — **one never-expiring row per group**.
Publications are retention-bounded copies (24 h), not an archive. The stored row _is_ what every path
converges on: replay returns `deliver-current`, the reconnect hydrator sends only the current
snapshot, and the criterion is petitioned against the just-planned candidate. All three would repair
members onto the **planned** layout and measure coverage on a layout nobody dials.

**Product decisions 24 and 42 answer ownership:** the row that exists today is the **planned**
layout, already overwritten by each replan and measured by the criterion. The accepted layout gets a
second never-expiring row written only by the canonical promotion effect inside `activateGroup` or
route-less `applyPlannedLayout`. It is a row rather than a pointer into 24-hour publications because a
held or accepted layout may remain live beyond publication retention.

The identity trap, verified: **a version comparison is not a safe test.** The planner bumps the
version only when the hop map, kind, name or degree changes, and the removed tombstone is written with
`version: previous?.version ?? 0` — so an active layout at version N and its tombstone at version N
coexist with different content. Product decision 29's tuple plus `state` is the predicate, and it must
handle `incomparable`. Publication delivery is also **not monotonic**: the stale-publication computation
returns `publish-superseded`, so a dominated candidate's publication can be broadcast after a newer one.

- **4a — the accepted-layout store and canonical promotion effect**, delivered with slice 2's
  aggregate fields (I7). **Needs:** slice 3's `topology-publication` capability; this slice does not
  create or widen an authority mode.

  `computePlannedLayoutPromotion` is pure and returns exactly `apply`, `already-applied`,
  `no-planned-layout`, `planned-layout-superseded` or `stale-fence`. It reads the group plus
  accepted/planned rows and fingerprints, validates the epoch and full planned identity, and computes
  the accepted row, accepted fingerprint and `Group.acceptedLayoutIdentity` together. It never writes
  and never changes a stage by itself.

  The existing `activateGroup` command owns the lifecycle path: one GroupState AppInbox transaction
  applies `connecting | reconnecting → active`, zeroes `formationAttemptCount`, invokes promotion and
  writes the group guard, accepted-topology guard, event, delta/final outbox, receipt and completion.
  A conflict retries the whole read/compute/validate/write operation; an injected failure at any write
  rolls all facts back. The stage cannot commit without the accepted row and identity.

  **Acceptance criterion added by the PR 3 review:** the causal fence must move inside the guarded
  write. Slice 3's fence validates against a read taken outside the write transaction, and the
  planned row lives in the topology namespace outside the group-row CAS — a replan committing
  between the fence read and the activation commit is currently undetected. Once the planned and
  accepted layouts are group-state-owned rows, the promotion's conditional guard must re-validate
  the planned identity inside the transaction, closing decisions 19/32's residual read-to-commit
  window; slice 3's compute-level fence then becomes the early typed rejection, not the last line.

  A new route-less `applyPlannedLayout` operation owns the no-transition path. It is prepared only
  with slice 3's `topology-publication` authority, reuses the same pure effect and writes the same
  accepted facts without advancing epoch or electorate. The transaction accepting an `apply` planned
  publication atomically enqueues the command with identity derived from `(groupRef, formationEpoch,
  planned identity)`. Process loss cannot strand promotion; identical replay is success and stale
  authority writes nothing. `connect` never invokes promotion or writes accepted state.

  Reuse `RtcTopologySnapshotRepository` with an explicit namespace/slot rather than writing a second
  repository class. The generic runtime-state table needs no migration, while the existing repository
  already owns paging, revision-guarded CAS, never-expire validation, canonical keys and corruption
  checks. Store two fingerprints: planned at publication acceptance and accepted at promotion.

  **Promotion mutation gate:** focused memory and live-Postgres tests cover apply/written,
  apply/conflict/full recompute, already-applied replay, stale/no-plan typed outcomes, overlapping
  writers, equal-revision corruption, retry exhaustion, outbox collision rollback, process restart
  after publication and deterministic final convergence of group identity, accepted row and
  fingerprint. The operation-specific topology guard is the first write.

- **4b — the total stage-keyed planning gate** replacing `isGroupTopologyPlannableAt` across every
  topology write path. `dormant` and `forming` publish removal; `planned` and `reconfiguring` may plan
  and publish a held candidate; `connecting` and `reconnecting` write no replacement; `active` follows
  replanning policy. The freeze begins only after a successful `connect` commits. It does not replace
  slice 11's trigger latch, which owns automatic intent before that commit. Activation and failure
  already enqueue follow-up topology work, so source changes observed during dialing are reconsidered
  from latest authority after the stage advances, without a second durable owed-work mechanism.

- **4c — delivery correctness:** replay's `deliver-current`, the reconnect hydrator, and the criterion
  petition all pinned to the right layout — the accepted one for repair and hydration, the planned one
  for the criterion; `GroupTopologyManagementView` carrying both, and its inert `pending` field finally
  populated from the coalesced row's `dueAtEpochMs` (product decision 11). Owns C7's departure rule.

**Gates:** baseline, both profiles, **medium-scale**, `topology-replay`, state-write,
`test:integration:postgres`.

### PR 5 delivery record — slices 4b + 4c (executed 2026-08-27, branch `codex/group-activation-planning-gate`)

Delivered as designed, with these recorded rulings where the slice text left the semantics open:

- **Freeze is replacement suppression, never establishment suppression.** "Write no replacement" is
  read literally: `connecting`/`reconnecting` (and `active` under suppression) freeze only when the
  planned slot holds an **active** row; an absent or tombstoned slot always plans. This is
  load-bearing for today's phased flow — `start-establishment` jumps `forming → connecting` and the
  first real plan is produced while already `connecting`; a stage-only freeze would starve the
  deadline timer (it throws-to-retry on a missing/tombstoned planned row) and the criterion would
  never have a layout to measure. The one behavior change for a producible stage: `connecting` no
  longer replans mid-dial — the candidate stays frozen (the slice's own mitigation, the transitions'
  unconditional follow-up enqueue, reconsiders latest authority after the stage advances).
- **The decision has one owner.** `resolveTopologyPlanAction` (pure, total via the stage registry;
  beside the planning service) resolves `plan | publish-removal | freeze` from stage, replanning
  mode, work origin and previous-row state. `computeTopologyFromAuthority` applies it — still the
  single production gate both runtimes converge on — and now returns a discriminated
  `planned | frozen` result, so the compiler censused every consumer. The work handler maps `frozen`
  to a new `skipped-frozen` decision: entry finished, **no snapshot and no fingerprint write** (the
  fingerprint must keep saying the stored layout trails the authority — decision 11's latched
  signal), criterion petitioned on the stored row, promotion reconcile still runs. The local-mode
  bypasses (`reconfigureGroupTopology`, `flushDueGroupTopology`) consult the same resolver;
  local-mode explicit reconfigure of a removal-disposition stage keeps today's planning (a skip
  there has no snapshot to answer with — recorded residue, api-v1's paths all converge on the
  handler).
- **`active` follows the policy now, minimally.** The authority read resolves the group's stored
  `topology.replanning` (absent → default preset, unreadable → `'corrupt'`). `auto`/`debounced`
  plan (indistinguishable until decision 31). `commanded` freezes **change-gated coalesced** work
  and RTT refreshes (origin `automatic`); non-change-gated group-revision work — the reconfigure
  family and the lifecycle transitions' follow-up enqueues — carries origin `commanded` and plans.
  A corrupt policy fails automatic replanning closed, commanded work still plans. C6 closes here:
  the six stage-blind enqueue paths all converge on the gated compute. C7's mechanism lands with a
  pinned test: a departure arriving as automatic work under `commanded` freezes — the layout keeps
  naming the departed session until the application reconfigures; 10a owns the observable axes.
- **4c delivery is accepted-first with a planned fallback, not accepted-only.** Repair
  (`deliver-current`) and hydration content resolve `accepted ?? planned` — decisions 1/30: the
  layout carrying traffic when a promotion has produced one, the frozen planned candidate before
  that (`connecting`, pre-first-promotion, operator-activated). One split matters: the replay
  **decision** still compares the log against the **planned** row — it is written in the same
  transaction as every publication, so the log can never run ahead of it, which is exactly the
  invariant the decision's corruption checks enforce; the asynchronously promoted accepted row may
  trail the log indefinitely under hold, and using it as the comparison baseline made the
  `topology-replay` proof read healthy entries as "historical newer than current" corruption. Only
  the repair **content** is accepted-first. Replay's transport of newer planned
  publications is untouched — the browser's stage gate owns dialing (slice 8); what changed is that
  repair and hydration can no longer put `active` members onto an unaccepted planned layout. The
  hydrator scans **both** namespaces (the planned scan finds dialing members, the accepted scan
  finds members a replan moved past) deduplicating per `(overlay, connection)` pair — the cost the
  plan's table priced as "the hydrator's paged-CAS reader".
- **The view carries both slots without a rename.** `GroupTopologyManagementView` gains required
  `acceptedSnapshot` (null until first promotion); `snapshot` stays the planned slot. `pending` is
  finally populated: `readPendingTopologyReplan` (owned beside the coalesced row it decodes) reads
  the row by its exact durable key via `findByKey`, reports `{reconfigureQueued, dueAtEpochMs}` for
  a mutable row, `null` for absent/settled rows, and queued-with-unknown-due for a row whose
  envelope no longer decodes. api-v1 wires it straight over the database handle
  (`PSqlResourceInboxEntryRepository`), so the query service needs no queue-engine dependency.
- **A PR-4 post-review defect fixed beneath this PR** (`1c2967a11`, on the PR-4 branch): the
  promotion mint gate's fresh reads ran inside the publication transaction on the shared database
  handle — pooled Postgres works, single-session PGlite deadlocks and wedges the AppInbox loop
  (caught by the black-box memory leg). Doctrine recorded: **enqueue-side gate reads run before the
  transaction opens; only the idempotent mint commits inside it.** The frozen and unchanged paths
  here follow the same shape.

#### PR 5 review-repair record (ten-angle max-effort review + gap sweep, executed 2026-08-28)

Fifteen confirmed findings, all repaired in the PR. The rulings the repairs added:

- **Delivery content has one owner with two qualifiers.** `toDeliverableTopologySnapshot` (replay/)
  resolves repair and hydration content: accepted-first, **except** a planned removal tombstone
  always wins — the accepted slot only ever holds active layouts (a tombstone never promotes) and
  nothing deletes it today, so without this clause a torn-down overlay is resurrected from the stale
  accepted row forever (the teardown signal I15 protects) — and, member-aware, a session named only
  in the held planned candidate receives its candidate assignment, or a `commanded` hold starves the
  very coverage the criterion measures. The replay **decision** stays planned-pinned and now reads
  the accepted row only on the repair branch (the hot path pays nothing). Accepted-slot deletion on
  teardown belongs to slice 5e's `reset`.
- **`pending` means "the queue will still attempt it":** NEW, RETRY and RESERVED all report queued.
  Recorded residue: a delta parked on a causal-suffixed successor row behind a reserved head is
  invisible to the point read for at most its debounce window (the head reads queued while
  reserved); revivable-but-unrevived FAILED rows honestly read as not queued. `PendingTopologyReplan`
  is now the one named contract in the shared API, and api-v1 feeds the reader the mutation
  runtime's own entries repository — no raw database handle, no second repository instance.
- **The policy fold has one owner beside the resolver**: `toGroupTopologyReplanningRead` (absent →
  default preset, corrupt stays corrupt) and `consultsReplanningPolicy` (spelled off the disposition
  registry, so the read gate cannot drift from the row that consumes it). The planning service takes
  the same `readLifecyclePolicy` port every other topology consumer takes. `workOrigin` is owned by
  an exhaustive `toTopologyWorkOrigin` beside the work kinds — a new kind fails the anchor instead
  of silently classifying `commanded` past the freeze — and the origin doc is corrected: the
  transitions' follow-ups ride the **automatic** coalesced presence chain, so a `commanded` group's
  post-transition replan also waits for the application (C7), which is the intended semantics.
- **The frozen path is observable and honest**: a dedicated `topologyPlanFrozenCount` (a hold is not
  a failed publish attempt), the skipped-frozen arm carries the union's own payload (non-null
  criterion petition, no phantom frozen-without-row state), both skip decisions share one writer
  with the fingerprint non-write guarded on the discriminant, and the local `flushDue` path now
  skips for removal-disposition stages too. Hydration's pair set dedupes **attempts** (a retry pair
  keeps its mark for the next pass instead of being re-attempted by the second scan — no duplicate
  sends, no false requires-retry throw on a fully hydrated gap pass).
- **The gate list grew what the review demanded**: the frozen write path has a real-Postgres
  handler-level test (establishment plans while `connecting`, the replacement freezes with the entry
  completed and the fingerprint latch untouched); the lifecycle-transitions recipe pins
  `acceptedSnapshot: null` through establishment and a post-activation poll proves the promotion
  lands the accepted slot over REST; the admin-support narrative summarizes the traffic layout, not
  the held candidate; the formation deadline timer reads the planned slot directly instead of the
  widened management view.
- **Refuted for the record**: the transition follow-up enqueue the freeze relies on does exist —
  `compute-lifecycle-transition` marks presence-summary work and `group-presence-summary-effects`
  mints the coalesced topology row unconditionally; and the accepted slot can never hold a tombstone
  (`computePlannedLayoutPromotion` returns `no-planned-layout` for any non-active planned identity).
  Accepted residue: `preserve-known-revision` membership-delta work can evaluate the gate on an
  enqueue-time stage for one cycle — the pre-existing selection semantics; every producible
  stale-stage pairing today resolves to the same action the fresh stage would.

## Slice 5 — The command family: `plan`, `connect`, `pause`, `resume`, `reset`, `start` (dark)

Per-command cost is the checkpoint-recovered 18-file / ~23-site census: a new `AppInboxType`; a payload type and an
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
  (I16's `mutationDescriptor` refactor was found already complete at the 2026-08-27 checkpoint —
  #338 landed the named `MutationDescriptorInput`; I25 records the supersession and the deletion
  question this slice inherits.)
- **5b — `connect` semantics, dark**: binding the dialing stage to the expected planned identity — the
  expected-layout fence and the two typed denials `no-planned-layout` / `planned-layout-superseded` (product decision 32), and `plan`'s
  idempotence from `planned` (product decision 28). Needs 4b. The caller-supplied-expected-state shape
  already ships in `disconnectPresence`, and the compute-side 409 template already exists twice — `RtcRttMutationIdempotencyConflictError`
  and `GroupTopologyConfigIdempotencyConflictError`, both thrown from inside compute with their own
  `status` and `code`, both reaching HTTP untouched because `readErrorStatus` accepts any thrown object
  carrying a `status` in 400..599 —
  but unlike `disconnectPresence` this must **not** degrade to `noOp`, which is exactly the failure the
  fence exists to prevent.
- **5c — `pause` and `resume`, dark.** These write `transportState`, not `lifecycleState`, so they are
  **not** lifecycle transitions: they do not enter `LIFECYCLE_TRANSITION_BY_OPERATION`,
  `GroupLifecycleTransitionOperation` or its six downstream registries, and they advance neither the
  formation epoch nor the electorate. That is product decision 25's whole payoff, and it makes this the
  cheapest of the three sub-slices rather than the most dangerous.
- **5d — legacy retirement, prepared but not cut over**: `start-establishment`'s `AppInboxType`,
  operation and
  OpenAPI block and **21** recipe call sites across 10 files (recounted from the tree in PR 8; the
  22 predates it), once `plan` + `connect` cover it (product decision 34). **5d inventories all of
  these; 8d removes them** — the sixth checkpoint's ruling, which supersedes this bullet's original
  reading that only the route and OpenAPI path waited for 8d. Each `POST …/lifecycle/establish/…`
  becomes two calls, so the recipe edit is a rewrite, not a path substitution. The automatic retry
  leg is re-expressed as `plan` plus the connect trigger, which makes its scheduler cutover work too.
  Nothing comes out before 8d, so the tree stays deployable throughout.
- **5e — `start`, dark** (product decisions 35/37). **Needs:** nothing beyond the transition table.
  `start` is `dormant → forming` and is denied while the attempt series is exhausted. Both `reset`
  and a successful `activate` zero `formationAttemptCount` (decision 37), though only `reset` is
  reachable from `dormant`, which is why the denial names it. The budget is a **precondition of the
  transition**, not a clause of the initiator policy: PR 9's review found that internal authority
  skips the policy entirely, so a rule decision 37 calls "terminal for automation" would have been
  the one rule automation never answered to. It sits beside `resolveFormationFailureLanding` in the
  transitions module, layered over the table the same way, and compute consults it on both authority
  paths.

  **`reset` moved to 6c** after PR 9's review (see that PR's record). The two were one slice until the
  review showed `reset`'s tombstones need changes to live topology delivery and planning that a dark
  slice cannot make. `start` is unaffected by any of it.

  **Consequence of the split, stated because it looks like a coverage gap and is not one:** `start`
  cannot be exercised end-to-end until 6c lands. `dormant` is its only legal source stage, decision 35
  forbids creating a group there, and exhaustion's `dormant` landing is still dark, so no command
  reaches `dormant` today. 5e therefore proves `start` through its compute and its descriptor
  mapping, and 6c adds the executed matrix case once `reset` can produce a dormant group.

### PR 6 delivery record — slices 5a + 5b (executed 2026-08-28, branch `codex/group-activation-command-family`)

`planGroupLayout` and `connectGroup` land dark through the full recovered census — both compile-forced
surfaces (the Extract's six registries, the payload map, the descriptor and operation switches, the
key Records) and every silent surface the census names (`GROUP_APP_INBOX_OPERATIONS`, the
`toDescriptorCommand` membership fallthrough, the untyped operation Sets, the runtime predicate
chains, `decodeGroupMutationOperation`). No route, no OpenAPI, no producer: the routing inventory
stays 57/53 and `COVERED_API_MUTATIONS` stays 47, exactly as the fifth checkpoint predicted. The
dispatch classifier is pinned the only way it can be — the operation matrix executes both commands
through the real phases (plan lands `forming → planned` and the idempotent replan; connect lands its
typed denial), so a membership-fallthrough misroute cannot regress silently. Rulings:

- **`connect` requires both fences non-null** — `expectedFormationEpoch` and `expectedLayout`
  (decision 32 names the layout; the existing compute rule rejects a layout fence without an epoch
  fence, and `computeExpectedLayoutFence` is non-null by signature). A descriptor missing them is
  malformed at the builder (thrown `TypeError`), mirroring `applyPlannedLayout`'s
  non-null-by-construction posture; a manual caller reads both from the formation and topology views.
- **The two denials are thrown 409 conflicts, terminal in the AppInbox classifier.** `connect`'s
  `no-planned-layout` / `planned-layout-superseded` throw `GroupConnectDenialError`
  (`status 409`, `code group-connect-<denial>`) from inside compute — the
  `RtcRttMutationIdempotencyConflictError` template — and both codes are registered in
  `TERMINAL_STATUS_BY_CODE`, because the executor's default for an unknown thrown code is retry and
  a deterministic denial must not burn the retry budget. Stale-epoch stays the shared rejected
  receipt; a connect fence naming a removed layout is rejected like activate's.
- **`connect` begins establishment.** It joins the `beginsEstablishment` list (sets
  `establishmentStartedAtEpochMs`, arms the deadline timer under deadline-mode policies) for both of
  its rows — `planned → connecting` and `reconfiguring → reconnecting` — since under decision 34 it
  replaces `start-establishment` as the entry into dialing, and `DEADLINE_TIMER_CONSUMES` already
  expects the stage entered to have armed the deadline. `plan` begins nothing and promotes nothing;
  `connect` passes `promotion: null` (decision 42: dialing a candidate is not acceptance).
- **The idempotent replan re-pins nothing and still repairs.** `plan` from `planned` keeps the epoch
  (the table's rule) and now also keeps the stored `formationElectorate`, while remaining a write —
  the audit/version bump plus the transition's unconditional presence-summary follow-up is exactly
  the first-party repair decision 28 promises, since the `planned` disposition replans from latest
  authority. `lastFormationOutcome` is untouched by both commands (the recorded-outcome fold already
  falls through), and the `formation-automation` authority mode keeps its fail-closed throw until
  slice 11's triggers produce commands.

#### PR 6 review-repair record (ten-angle max-effort review, executed 2026-08-28)

Fifteen confirmed findings, all repaired in the PR. The rulings the repairs settled:

- **The denials are typed rejection codes, not thrown conflicts.** The first cut threw
  `GroupConnectDenialError` from compute, citing the two existing compute-thrown 409 templates. The
  review was right that this violates the repo's expected-failure doctrine and that the sanctioned
  in-tree shape already exists: `GroupMutationRejectionCode` is a union consumed by an exhaustive
  default-free mapping. `connect` now returns
  `group-connect-no-planned-layout` / `group-connect-planned-layout-superseded` as rejection values,
  which the handler boundary maps to `GroupConnectDeniedError` (409, own code) exactly like every
  other rejection. Compute stays pure, the fence stays throw-free, and the shape is compiler-forced.
  Repairing this exposed a **silent runtime mirror** of the union — a hand-written `!==` chain in the
  computed-result validator — so the codes now derive from one exported `as const` registry with a
  runtime predicate, and the mirror cannot drift again.
- **A fence that does not survive to the commit is not a fence.** Connect read the planned row
  outside the write transaction while only a promotion emitted the revision-guarded planned-row
  re-assertion, so a replan landing between read and commit could let a superseded connect commit —
  the read-to-commit race PR 4's review closed for activation. `toPlannedLayoutFenceEffect` is now
  extracted from the promotion effects and carried by any layout-fenced command that does not
  promote, so connect's batch conflicts instead.
- **Timer arming follows the landed stage, not the operation.** `connect` had been added to a
  `beginsEstablishment` equality list spelled in two files; for its `reconfiguring → reconnecting`
  row that armed a deadline `DEADLINE_TIMER_CONSUMES.reconnecting` drops, which would have parked a
  reconnecting group with no evaluation and no retry. Both facts are now stage-keyed owners in
  `resolve-formation-stage-entry.ts` — `beginsGroupEstablishmentAt` (stamps the clock) and
  `consumesFormationDeadlineAt` (arms and consumes the deadline, one registry for both sites) — so
  the two can no longer disagree and a new command joins by landing in a stage rather than by being
  added to a list.
- **Authority is checked before the fence.** The fence's answer names the stored plan, and connect is
  the first authenticated command carrying a caller-supplied layout, so evaluating it before the
  initiator policy would let a non-member probe plan existence and identity once slice 8 mounts the
  route. The ordering swap costs the criterion nothing (its authority passes) and closes the probe.
- **Connect's wire fences are validated at the boundary.** The lifecycle short-circuit in the
  request validator skipped them under a comment that this PR made false; the layout-identity shape
  check is now a shared owner used by both the request boundary and the command validator, and the
  builder rejects an explicit `null` as firmly as an absent key.
- **Recorded, not repaired:** the fence still precedes the state-machine check, so a connect naming
  no plan on a stage where connect is illegal answers `no-planned-layout` rather than a stage denial.
  Moving the stage check first would turn a legitimately racing criterion petition into a policy
  denial instead of a typed rejection, which 3b's design rejects; the fence answer is truthful, and
  slice 11's trigger latch owns automatic progression. Also recorded: `planned` has no timer of its
  own, so a group that reaches it and receives no `connect` waits for slice 11's trigger — deliberate,
  since triggers own automatic intent.
- **A retry needs a fresh request id.** The request id _is_ the command identity, so retrying a
  denial under the same id either replays the stored denial or raises an idempotency conflict. Now
  stated on the error class where a caller reads it.
- **The commit-time guard is connect's alone.** The first repair gated it on
  `isLayoutFencedGroupMutationCommand`, which also covers a **fenced formation failure** — a live
  command whose write behavior this PR has no business changing. The guard is now scoped to
  `connectGroup` on its own merits: a fenced failure _discards_ the plan rather than binding to it,
  so guarding the row buys no causal guarantee and could only add retries. Recorded because the next
  fenced command must make the same choice deliberately — bind-to-the-plan carries the guard,
  discard-the-plan does not.

  **Correction, same day:** the narrowing was prompted by a `topology-replay` CI failure that this
  record first attributed to the broad guard. That attribution was wrong and is withdrawn. The same
  proof later failed on a **markdown-only** commit (`8d14913f7` green → `2e9d37ac0` red, one file,
  fifteen lines) with a different signature (`503; expected 200` versus the earlier unresolved
  APP_OUTBOX row), so the gate is flaky on CI and no regression was ever demonstrated. The scope
  ruling stands; the causal story does not. Third flaky postgres-proof observation this session,
  alongside the medium-scale exact-revision race — the proofs' CI stability is worth its own
  investigation before it masks a real regression.
- **Deferred to slice 8: `connect`'s request contract in the descriptor union.** `GroupMutationDescriptor['request']`
  is a closed union of the named API request types, and connect's is not among them, so
  `toConnectCommand` bridges with a cast. The cast is safe today (the payload declares the fields, the
  request boundary now validates their shape, and the builder rejects both absent and null), but the
  union cannot carry them until the route's `ConnectGroupRequest` lands in `state-types.ts` with the
  HTTP surface. Slice 8 declares the contract once and adds it to the union; until then the cast
  stays and this entry is its record.
- **Gate evidence for this PR:** medium-scale PASS and state-write PASS (merge-base control vs head,
  freshly migrated pinned container each side) — both required by this slice's gate line because the
  fence extraction and the timer branch run on every lifecycle command, not only the dark ones.

### PR 7 delivery record — slice 5c (executed 2026-08-28, branch `claude/group-activation-pause-resume`)

`pauseGroupTransport` and `resumeGroupTransport` land dark through the same census as 5a+5b, minus
every routing-plane registry: they are absent from `LIFECYCLE_TRANSITION_BY_OPERATION`,
`GroupLifecycleTransitionOperation`, the transition table and `computeFormationTimerEntries`, and
present in `AppInboxType`, `GROUP_APP_INBOX_OPERATIONS`, the payload map,
`AUTHENTICATED_GROUP_INBOX_TYPES`, both descriptor switches, `toDescriptorCommand`, the operation
Sets, the key Records and the decoder chains. No route, no OpenAPI, no producer: the routing
inventory and `COVERED_API_MUTATIONS` are untouched. Rulings:

- **A redundant command is a no-op, not a write.** `plan`'s idempotent replan writes because the
  follow-up replan _is_ the repair decision 28 promises; the valve has nothing to repair, so a
  `pause` that finds `halted` returns a no-op receipt with no event, no outbox entry and the stored
  snapshot version — no delta ships for a state nobody changed. This is `computeUpdate`'s existing
  precedent, and it keeps a retry off the state-write budget.
- **The valve is stage-independent by construction.** It has no transition-table row, so there is no
  stage to deny from; the proof enumerates `GROUP_LIFECYCLE_STATES`, and a new stage joins it by
  joining the registry. `dormant` included: `reset` leaves a group halted (decision 36) and only an
  application decision lifts that.
- **One initiator policy, one owner.** `canCommandGroupLifecycleTransition` bundled the active-member
  check, the initiator switch and the state machine. The first two are now
  `canCommandGroupAuthority`, which the transitions call before their table check and the valve calls
  on its own — decision 12's "one policy for all eight" is structural rather than duplicated, and the
  two denial messages that named lifecycle transitions now name group authority, because they answer
  for both families. `denyForGroupAuthorityInitiator` never read the transition, so nothing was lost.
- **Never automatic is enforced where it cannot be forgotten.** No `internalAuthority` mode admits a
  transport operation, so `validateGroupMutationAuthority` refuses every one of them before compute;
  the compute has no service-authority arm at all, unlike the transitions' criterion bypass. The
  proof iterates `GROUP_MUTATION_INTERNAL_AUTHORITY_MODES`, so a future mode must decide explicitly.
- **The policy read has one owner for both families.** `resolveGroupAuthorityPolicy` and
  `toCorruptPolicyRejection` replace the private corrupt-policy arm in
  `compute-lifecycle-transition.ts`: missing read throws, corrupt fails closed as a rejection value,
  absent resolves to the default preset, and both computes spend three lines on it. The four
  hand-repeated read-gating disjunctions (`read-group-mutation`, `read-sequential-group-mutation`
  and both arms of `validate-group-mutation-operation-reads`) now call `readsGroupLifecyclePolicy` /
  `readsGroupActiveMemberPrincipalIds`, so the read path and its validator cannot disagree — the
  silent-mirror class PR 6's review found in the rejection codes.
- **The read scope became its own owner, and the style gate is why it happened first.** Adding two
  read-gating predicates took `group-mutation-contracts.ts` to exactly twelve runtime value exports,
  the `file.responsibility-count` review threshold, and `check:repo-style:changed` failed on it. The
  cure is the split the growth was already asking for: `mutation/read/group-mutation-read-scope.ts`
  now owns all four "what may this command's compute consult" rules — the two new ones plus
  `readsGroupLayoutRows` and `readsAcceptedLayoutRow`, which moved out of the contracts module —
  leaving contracts with the command union, the phase contracts and the operation-family predicates.
  Eight runtime exports, gate green from the worktree.
- **A halt does not supersede a plan.** The valve bumps `snapshotVersion`, which the planner would
  otherwise read as fresh authority, but `computeRtcTopologyInputFingerprint` hashes active session
  ids, display name, effective config and hysteresis widths — not the snapshot version and not
  `transportState`. The digest is what the new test pins, both directions. **Scope of the claim:**
  `isFingerprintUnchanged` additionally requires the stored planned snapshot to be `active`, so
  suppression latches exactly where the fence matters — a group holding a plan an outstanding
  `connect` names. In a stage with no active stored snapshot the coalesced row is not suppressed,
  which is the pre-existing behaviour of every group write (`updateGroup` included), not something
  the valve introduces; there is no plan to supersede there.
- **Recorded, not repaired — the valve pays for a replan it cannot need.** `presenceSummaryWork` is
  `'enqueue' | 'none'`, and the presence-summary effect mints the coalesced topology row together
  with the group delta. The valve genuinely needs the delta (decision 25's browser refusal reads the
  snapshot) and provably cannot change topology, but the mechanism has no delta-only disposition, so
  it takes the replan with it. Generalising that third disposition is a shared-infrastructure change
  this slice does not own; slice 7, which is where the halt starts being enforced, is where it
  belongs.
- **Recorded, not repaired — a no-op stores no idempotency record.** `noOp` returns receipt-only, so
  `writeGroupMutation` persists nothing to replay from. A redundant `pause` that the caller never
  saw the answer to, retried under the same request id after the application has since resumed,
  re-evaluates against the new state and halts it again. The alternative — making the redundant
  command a write — buys the replay at the cost of a delta and a coalesced work row on every
  no-change call, which is what the no-op ruling exists to avoid, and the hazard is `computeUpdate`'s
  today rather than something the valve introduces. Nothing can reach it while the commands are
  dark; slice 8's route must state that a valve retry is evaluated against current state.
- **Recorded — `resume` is legal in `dormant`, and a stage guard would be ineffective, not merely
  unnecessary.** The stage table's `dormant` row reads "blocked (and transport is halted)" and
  decision 35 says transport is halted there. Both describe how a group arrives in `dormant` —
  `reset` sets the valve (decision 36) — not an invariant the stage enforces. The decisive reason is
  structural: **every stage transition preserves the valve by construction.**
  `computeNextLifecycleGroup` never names `transportState`; it spreads the stored group, so the valve
  rides every transition unchanged. Decision 36 assigns halting to `reset` alone, and
  `resolveFormationFailureLanding` — exhaustion's `dormant` landing — touches nothing else. So once
  the criterion owner passes real exhaustion state, an `active` + `flowing` group lands in `dormant`
  **still flowing**, with no `resume` involved. `dormant` + `flowing` is therefore a state the model
  produces on its own; denying `resume` there would not establish the invariant, only stop the
  application from leaving a state the system can still enter by itself.

  The same structure explains the stage table's wording: if `dormant` enforced the valve, `reset`
  would not have to set it explicitly. Supporting facts, not the argument itself: the forward gate
  blocks `dormant` under `blocked-until-active` regardless of the valve, `dormant` dials nothing so a
  resumed `dormant` group has no edges to carry data, decision 36's own words are that the group "is
  silent until the application resumes it", and a per-stage denial would reintroduce the
  stage-dependence decision 25 removed.
- **A user-visible denial message changed on live commands.** `denyForGroupAuthorityInitiator` now
  answers for both families, so "Lifecycle transitions are server-initiated under this policy." and
  "Only the group manager can command lifecycle transitions." became "Group authority commands …" and
  "… can command group authority." Those strings reach HTTP callers today through `activate`,
  `start-establishment` and `reopen-establishment`. Nothing in the tree pins either string — recipes
  and Deno tests assert `code`, never `message` — and a denial that names the wrong command family is
  a defect once the valve answers to the same switch. Recorded because it is the one live-path
  behaviour change in an otherwise dark slice.
- **Deferred by design:** the halt is not yet enforced anywhere. Slice 7 owns the WS relay valve and
  the forward gate, and `api-v1-group-data-policy.json` gains `pause-resume` there; slice 8 mounts
  the routes. Until then `transportState` is written by these two commands and read only by
  `computeGroupDataGate` and the snapshot.
- **Deliberate census deviation: the valve is not an aggregate _input_ family.** It carries no
  operation field, so it is routed at both input-validation dispatchers rather than added to
  `AGGREGATE_GROUP_MUTATION_OPERATIONS` / `isAggregateOperation`. Those two Sets are routing keys for
  "which family validator reads this input", and the valve's whole input contract is the exact-key
  assertion the shared row already applies. This also keeps the two >60-line validators the standard
  would otherwise require refactoring or a registry entry for untouched.
- **Test honesty:** every behavioural assertion in `group-transport-mutation.test.ts` was verified to
  fail against an implementation lacking it — the valve mapping swapped, the no-op branch removed,
  the authority block removed, the corrupt-policy arm removed, `assertActive` removed — and the two
  silent registries (`GROUP_APP_INBOX_OPERATIONS`, the authority decoder's operation chain) were each
  dropped to confirm the executed matrix catches them. The max-effort review corrected one dishonest
  proof: the manager denial ran with a roster that resolved **no** manager, so it answered
  `lifecycle-manager-unavailable` and never reached the membership question it claimed to prove. It
  now carries the creator in the electorate and asserts the denial **code**, which separates the two
  arms.

### PR 8 delivery record — slice 5d (executed 2026-08-28, branch `claude/group-activation-legacy-inventory`)

Inventory only: nothing is removed, no route is mounted, no recipe is rewritten. The deliverable is
`packages/tests/repo/legacy-establishment-retirement/` — a declared table of every
`start-establishment` consumer, compared against a fresh whole-tree scan **in both directions**, so a
consumer that is added, removed, or that gains or loses an occurrence fails until it is declared.
**54 consumer files**, occurrence-exact.

**What that guarantee is bounded by**, stated because an inventory that oversells itself is worse
than none: it is exact _for the eleven declared tokens, over git-tracked files, outside the excluded
prose roots_ (`playground/`, `plans/`, `.agents/`, `.superpowers/`, `docs/superpowers/`, `projects/`,
plus the inventory's own directory). A consumer reached by a twelfth spelling, or living in an
uncommitted file, is still invisible. Nor does any of it prove the cutover finished: 8d could delete
one call site and edit the count to match. Under-declaration is blocked; under-removal is slice 9's
job, and this slice does not take it on.

- **The first draft was wrong in a way worth recording, because 8d would have inherited it.** It
  hand-authored a list of twelve files and checked only that each still existed — no scan of the tree
  at all — so the twenty-odd consumers nobody thought of stayed invisible. Among them was the
  below-floor retry leg product decision 34 names explicitly: had 8d worked from that inventory it
  would have removed the operation and left the retry timer submitting a command with no handler,
  with no route, recipe or OpenAPI entry to reveal the break. **The cause was the hand-authored list,
  not the choice of marker** — an earlier telling of this blamed route-path keying, but two of the
  draft's markers do occur in the producer file, so a converse scan with even that marker set would
  have caught it. What no marker set caught is the retry _scheduler_
  (`formation-timer-outbox-entry.ts`), which names neither route nor command; the token list now
  carries the retry leg's own vocabulary for it.
- **The test's shape is the deliverable, not the table.** A one-directional check — "every declared
  surface still exists" — passes with eleven of twelve entries deleted, which is what the first draft
  did. The comparison is now wholesale and bidirectional, and it was mutation-checked three ways:
  dropping a declared consumer, falsifying an occurrence count, and letting an undeclared consumer
  appear in the tree all fail.
- **The census is 21 recipe call sites across 10 files, not 22.** Recomputed per this slice's gate
  line ("every hard-coded inventory recomputed from semantics rather than arithmetic"). The stale 22
  in the slice bullet is corrected above rather than left to contradict this record.
- **The epoch consequence is real; the number first recorded for it was not.** `plan`
  (`forming → planned`) and `connect` (`planned → connecting`) advance the formation epoch twice
  where the single legacy call advanced it once, so assertions after a rewritten site shift. But the
  47 `formationEpoch` occurrences across the ten recipes are **not** the renumber set: five of the 21
  sites expect **403** and advance nothing, and 16 of the 47 are `"formationEpoch": 0` snapshots taken
  before any transition. `api-v1-drop-in-social-preset.json` is the clean counter-example — one
  occurrence, asserting `0`, before its only site, which is a denial: its renumber count is zero. 8d
  derives the shift map per site; this slice records the mechanism and declines to pin a number that
  does not mean what it says.
- **Scope held.** The inventory covers `start-establishment` only. `reopen-establishment` is 6a's and
  does not share a route — `lifecycle/establish/requests` and `lifecycle/reopen/requests` are separate
  registrations.
- **The worklist is a removal list, and says so under test.** Product decision 14 forbids retaining
  this command, and the sanctioned channel for retained production legacy is
  `docs/production-legacy-exceptions.md`, whose retained-exceptions section is empty. The inventory
  asserts that no `start-establishment` token appears in that registry, so listing fifty consumers
  can never read as blessing them; granting an exception fails the test. `check:retained-legacy`
  passes, and this PR touches no production file at all, so it retains nothing by construction. The
  dual path that exists today — the dark `plan`/`connect` beside the mounted legacy route — is the
  plan's staged cutover with a defined end in 8d, not a compatibility shim.

### PR 9 delivery record — slice 5e (executed 2026-08-29, branch `claude/group-activation-reset-start`)

**Shipped: `startGroupFormation` only.** The slice began as `reset` and `start` together and was split
after its own review; `reset` and everything it needed are now slice 6c. The branch name predates the
split.

- **The attempt budget is a precondition of the transition, not a clause of the initiator policy.**
  It shipped first inside `canCommandGroupLifecycleTransition`, and the review caught what that costs:
  `validateLifecycleTransitionAuthority` returns before that policy for every internal producer, so a
  rule decision 37 calls _terminal for automation_ would have been the one rule automation never
  answered to. Proven by execution — a criterion-authority `start` against a spent series returned a
  write that restarted the series. The rule now sits beside `resolveFormationFailureLanding` in the
  transitions module, layered over the table the same way, and compute consults it on both authority
  paths. The defect was latent, not live: `validateGroupMutationAuthority` still refuses
  `startGroupFormation` under criterion authority, and it is the later slices that open that arm.
- **The arithmetic has one owner now.** The same comparison existed in two off-by-one frames —
  `formationAttemptCount + 1 < max` in the criterion evaluator, `count < max` in the timer scheduler —
  and this slice was about to add a third. `isFormationAttemptBudgetExhausted` owns the frame (the
  count is attempts _already recorded_) and all three call it. The two frames were equivalent; a
  verifier checked that before the extraction rather than after.
- **A fixture was silently dropping the field the denial keys on.** The policy suite's `snapshot`
  helper whitelisted the group fields it forwarded, and `formationAttemptCount` was not among them, so
  the first denial test passed for the wrong reason. Adding the one field would have left the trap
  armed for the next five — `formationEpoch` among them, which the manager election reads — so the
  whitelist is gone: the helper now names only what it defaults differently from `createTestGroup` and
  spreads the rest.
- **`start` ships without an executed proof, deliberately — and the gap is machine-checked.**
  `dormant` is its only legal source stage; decision 35 forbids creating a group there and
  exhaustion's `dormant` landing is still dark, so no command reaches `dormant` until 6c's `reset`.
  The operation matrix therefore advertises `GROUP_FORMATION_START` without exercising it. That used
  to be a prose note beside the advertised list, which is not a mechanism; it is now a declared
  exception list the matrix asserts against, so advertising an operation and not running it fails.
  Building that guard surfaced four _pre-existing_ advertised operations the matrix array does not
  carry either: `GROUP_CONNECT` (exercised after the array), and `GROUP_ESTABLISHMENT_START`,
  `GROUP_ESTABLISHMENT_REOPEN` and `GROUP_ACTIVATE`, which this file does not exercise at all. They
  are declared with their reasons rather than quietly absorbed. `start`'s mapping is covered by the
  descriptor contract — total over `AUTHENTICATED_GROUP_INBOX_TYPES` since PR #369's follow-up — and
  its compute by the unit suite. 6c drops it from the list as it adds the case.
- **The OpenAPI enum entry was lost twice before it stuck.** A blanket `git checkout -- apps` after a
  formatting run reverted it both times, silently, and the first draft of this record claimed it had
  landed. Nothing couples the YAML enum to `GROUP_POLICY_REASON_CODES`, which is why. Measured on the
  final branch: the const carries **22** codes, the enum **16**, the same **6** are missing as before,
  and `formation-attempts-exhausted` is in both — so the slice adds no contract debt and the plan's
  "6 codes behind" figure is still exact. Slice 9 gains the coupling test.
- **`deno check` earned its place.** The same blanket checkout reverted an api-v1 wiring change that
  `tsc` cannot see, because the Deno app is outside its project. Only the Deno gate caught it.

#### Why `reset` left, and what it took with it

The review found decision 36's tombstone mechanism assumes three properties the topology machinery
does not have — a tombstoned accepted slot shadows a fresh planned layout in delivery, pre-writing
the planned tombstone swallows the removal publication, and whether the tombstone disarms change
suppression is unresolved. Fixing any of them changes live delivery or planning semantics, which a
dark slice has no authority to do. All three are written up under 6c with the evidence.

One defect was found and fixed before the split, and it is worth keeping in view because it is the
kind only execution finds: **a removed snapshot may carry no edge.**
`decodeRtcTopologySnapshotRouting` rejects one that does, so a tombstone built as "the stored row with
only its state changed" threw inside the write transaction for any group holding a multi-session
layout, and AppInbox would have retried that deterministic failure forever. Every test fixture used
empty session lists, which is exactly why nothing caught it. 6c starts from a tombstone that empties
each session's hops.

Also reverted with `reset`, and owed back in 6c: the `GroupAcceptedLayoutRow` widening and its api-v1
reader change, and the guarded-batch rollback proof — which needs rewriting there to exercise
`writeGroupMutation`'s rejection rather than re-implementing it inline, as the review pointed out.

Product decision 12 keeps one initiator policy for all eight application-facing commands, so the
command predicate needs no per-command branch.
Every new command inherits the slow sequential read path, and the read step and its validator apply
that predicate independently — a one-sided edit throws at compute.

**Gates:** baseline, both profiles, **medium-scale**, **state-write**, and every hard-coded inventory
recomputed from semantics rather than arithmetic. Seven new public commands arrive across slices 5
and 6 while `activate` remains mounted; 4a adds one route-less internal `applyPlannedLayout`; two
legacy commands leave only in 8d. Routing entrypoints, AppInbox types, trusted internal types and
covered API mutations therefore have different deltas and must not share a guessed count. Extend the
strict request-identity route inventory before recipes can reach the new paths.

## Slice 6 — `reconfigure` as a stage command (dark)

`GroupTopologyReconfigureMutation` advances the group authority fence and writes topology work but
does not touch lifecycle state. I12 keeps ownership direct: a `hold` stage transition already
atomically enqueues its replan through `presenceSummaryWork`, so commanded reconfigure needs only to
bypass change gating when membership is unchanged.

Product decisions 27 and 42 define a separate `apply` boundary. Accepting a planned publication and
durably enqueueing 4a's `applyPlannedLayout` command are one topology-publication transaction;
promotion then converges in its own retryable GroupState AppInbox transaction. A crash may expose a
short planned-before-accepted interval, but never a committed publication with no durable promotion
work.

- **6a — ownership and legacy inventory.** Prove the existing hold transition's atomic enqueue and
  inventory every `reopen-establishment` type, operation, route, OpenAPI and recipe consumer for 8d.
  Nothing leaves before the route cutover.
- **6b — landing and replanning policy, dark.** **Needs:** slice 3's `formation-automation` mode for
  automatic reconfigure and its separate `topology-publication` mode for the apply command producer;
  and 4a's route-less operation. The two modes never substitute for each other.
- **6c — `reset`, with the topology retirement semantics it needs** (product decisions 35/36).
  **Needs:** 6b's landing policy and the delivery rules slice 4 established. Split out of 5e by PR 9's
  review, which found that decision 36's tombstone mechanism assumes three properties the topology
  machinery does not have. Whoever picks this up starts from these, not from rediscovery:

  1. **A tombstoned accepted slot breaks the delivery invariant.** `toDeliverableTopologySnapshot`
     ends `accepted ?? planned`, preferring accepted on the premise that "the accepted slot only ever
     holds active layouts (a tombstone never promotes)". Read the source carefully before working
     here: that sentence is written as one of three reasons the _planned_-removal early return always
     wins, not as the tail's own rationale — the tail's stated rationale is that "members converge on
     the layout carrying traffic". The tail relies on the same premise silently, which is exactly why
     falsifying it is easy to miss. After `reset → start → plan` the accepted slot holds a tombstone
     while the planned slot holds a fresh active layout: planned is not removed, so the early return
     does not fire and the tail returns the tombstone — reconnect hydration and replay repair hand a
     member a teardown for the overlay it should be dialing. The recommended fix is teaching delivery
     to fall through to planned when accepted is removed — one function, but live on the activate and
     hydration paths, which is why it is not a dark slice's to make.
  2. **Pre-writing the planned tombstone swallows the removal publication.** The follow-up coalesced
     replan sees `previous.state === 'removed'`, so `removedTopologyResult` reports `changed: false`
     and the handler skips as unchanged; before the change the same follow-up published the removal.
     Three ways out, and this is the decision 6c owns: let the follow-up publish it (reintroduces a
     window where planned is active while the group is dormant), have `reset` mint the publication
     itself (most faithful, but reset takes on topology work), or rule that the group delta — dormant
     plus halted — is how clients learn, which I11's "the browser reads state and decides" posture
     already implies.
  3. **Whether the tombstone disarms change suppression is unresolved.** The semantic `changed` gate
     never compares `state`, so with the graph preserved a rebuild of unchanged membership reported
     `changed: false` and the planned row stayed `removed` at its old version. PR 9 then made the
     tombstone empty each session's hops for an unrelated reason — a removed row may carry no edge or
     the write transaction aborts — which plausibly makes a rebuild differ and the finding moot. It
     was **not** verified either way. Verify before choosing a fix; if it still holds, the fix is
     making `changed` compare `state`, which touches every planner.

  Also carried from PR 9: `GroupAcceptedLayoutRow` must widen to carry its snapshot (a tombstone is
  the stored row with its state changed, and a revision alone cannot express that), which moves the
  api-v1 reader to `findSnapshotEntry` and makes `findEntryRevision` dead. That widening decodes and
  graph-validates the accepted row on every activation, where the old reader could not fail — 6c owns
  proving a corrupt accepted row behaves acceptably on the activate path. The guarded-batch rollback
  proof PR 9 drafted belongs here too, rewritten to exercise `writeGroupMutation`'s rejection rather
  than re-implementing it inline.

**Gates:** baseline, both profiles, **medium-scale**, **state-write**, `topology-replay`.

### PR 10 and PR 11 delivery record — slices 6a–6c (merged 2026-08-29 as #373 and #376)

Slice 6 is complete on `main`. #373 registered the dark commanded reconfigure operation, proved that
the existing hold transition atomically enqueues topology work, made commanded replans bypass only the
unchanged-membership suppression, and recorded the `reopen-establishment` removal inventory for 8d.
#376 then landed `reset` with the topology retirement semantics deferred from PR 9: removed snapshots
carry no edges, a removed accepted row cannot shadow a fresh planned row after restart, and reset
retires the planned and accepted identities inside the authoritative mutation path. The widened
accepted-row read replaced `findEntryRevision`; that now-consumerless method was removed rather than
retained as legacy.

Both PRs passed their focused mutation and replay proofs plus the slice's baseline, both-profile,
medium-scale, state-write and topology-replay gates before merge. The route cutover remains deferred to
8d: neither PR mounted a public route or removed an inventoried legacy command.

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

**I11 settles this** (was Q3). `canSendGroupMessage` has a second, non-WS caller —
`apps/relic-hunter-server-v1/src/relic-rest-auth.ts` — passing no `preActivationAppData`, so the gate
branch never fires there today. Folding a policy-independent halt into the shared predicate makes every
Relic Hunters REST command on a halted group return 403 (C8). Per I11, `canSendGroupMessage` stays the policy predicate and the transport halt sits at the relay's
own choke point; Relic Hunters reads `transportState` and decides for itself.

The halt is exactly as complete as `isRoomScopedALMessage`: reserved system topics bypass the
authorizer entirely and the chat app topic broadcasts application payloads with zero authorization. And
`forwardsRoomScopedMessages` defaults **true** with exactly one disabling site — the
permissive-by-default boolean that already caused this bug class once (control-plane decision 5.9).
Extend `ws-server-qos-policy.test.ts` to assert a halted room-scoped message is not forwarded by the
ALM path either.

**Gates:** baseline, both profiles, **medium-scale**, `test:deno` (the api-v1 authorizer test is
Deno-only), and focused policy/authorizer plus ALM-bypass coverage. The `pause-resume` and
`reconfigure-while-halted` recipe cases move to slice 8d's public route cutover; before that cutover
the dark commands have no supported recipe path.

### PR 12 delivery record — slice 7 (merged 2026-08-30 as #378)

#378 landed both halves of the valve. The group policy gate is total over the lifecycle registry, and
the WS relay independently suppresses halted room-scoped application traffic while reserved system
topics retain their explicit ALM bypass. Relic Hunters remains outside that transport-plane policy and
keeps its own snapshot decision, preserving I11's ownership boundary. The review removed a stale chat
installer path instead of retaining a second forwarding route.

The focused policy/authorizer and ALM-bypass tests, Deno gate, both black-box profiles and medium-scale
gate remained assigned to slice 7 and passed before merge. Maintainer approval on 2026-08-29 moved only
the two recipe cases named above to slice 8; it did not weaken slice 7's executed gates.

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

- **8a — the two-slot overlay cache** and `layoutPlanned` / `layoutAccepted`.

  **Do not pin every existing reader to the accepted slot.** An earlier draft said to, calling it
  behaviour-preserving. It is not, and for one reader it breaks activation outright. On main the single
  slot always holds the _newest_ publication — which this plan renames the **planned** layout — so
  pinning readers to _accepted_ changes what every one of them sees. For `targetPeerIdsForGroup` that
  is the intended change. But `rttReportingCandidatePeerIds` and `isRttReportingPairEligibleForGroup`
  read the same cache, and RTT evidence is exactly what the server's activation criterion consumes:
  `computeGroupFormationReadiness` measures fresh RTT over `collectPlannedEdges(input.planned)`. Pin RTT
  reporting to the accepted slot and the planned layout's edges never accrue evidence — `observedRate`
  stays near zero and **the criterion never fires**. In `connecting` it is worse: there is no accepted
  layout at all, so peer selection degrades to the rendezvous top-up over active sessions, which
  overlaps the planned edges only by coincidence. RTT reporting remains pinned to the planned slot.
  Dialing is not pinned to one repository: it calls the total stage selector from 1b and receives
  planned, accepted, their union or none. Every other reader is classified explicitly, one at a time;
  there is no blanket accepted-slot rule.

  Also: the `setOverlayById` wrap is smaller than it looks. The setter already has a silent-drop branch
  (`emitOverlayAdoption(id, 'dominated-dropped')`, no throw) and already emits
  `'incomparable-conflict'` before throwing, and `hydrateGroupTopologyOverlays` already catches
  `OverlayRevisionConflictError` and classifies it as the non-fatal `'revision-conflict'`. This is
  moving an existing decision from one caller into the setter, not new machinery.

  The one hard constraint: the cache key is `toScopedOverlayId(groupRef)`, and that same `overlayId` is
  a protocol identity carried on the wire in `ALMessage.forwarding.overlayId`. A role-suffixed key is
  therefore not available — the second slot must be a second repository token (the
  `configureSharedStateRepositories` two-token pattern is the one to copy), not a re-key.
- **8b — the total browser dial gate and bootstrap suppression.** Outbound and inbound decisions use
  the same complete matrix: `connecting` permits the frozen planned layout; `active` and
  `reconfiguring` permit accepted; `reconnecting` permits their union; `dormant`, `forming` and
  `planned` permit no RTC creation. Absence never falls back to all active sessions. A publication or
  membership change during dialing cannot replace the frozen planned identity.

  All outbound entrypoints already converge on `computeRtcPeerDtoIfAbsent`; what is missing there is
  group/stage context. Add the symmetric `setOutboundDialPolicy` beside the existing inbound policy
  seam, both driven by the same layout-role result. Tests enumerate every stage × accepted/planned
  presence combination for outbound and inbound, including a lagging offer, initial bootstrap
  suppression and the reconnecting union.

- **8c — the room facade:** readiness on the accepted layout, the local halt with its typed status, the
  browser's own repair and progress reporting — the per-peer `reconnecting` / `reconnectAttempts` pair
  and the `desiredPeerIds` / `readyPeerIds` / `failedPeerIds` triple that `roomStatus().rtc` already
  computes, repointed at the accepted layout. Product decision 40's member progress is
  `readyPeerIds.length / desiredPeerIds.length`, needs no server change and no wire change, and must
  report nothing rather than 1 while no layout exists (**Q10** settles its public shape), and C10's two games updated in the
  same PR: the exhaustive status mapping and the `sendJson` fallback together.
- **8d — the route cutover** (I8): seven new HTTP/OpenAPI paths — `plan`, `connect`, `reconfigure`,
  `pause`, `resume`, `reset`, `start` — join the existing `activate` path, producing eight
  application-facing commands. In the same PR, remove both legacy routes, AppInbox types, operations,
  OpenAPI blocks and recipe consumers inventoried by 5d and 6a. No earlier slice removes them.

**Blast radius:** repointing readiness from active sessions to the accepted layout changes
`waitForRoomLane`'s `{exact: peerIds.length}` expectation for ar-eye-hunter-v1, relic-hunters-v1,
rallar-black-box and `shared-web/game/match.ts`. And `match.ts` falls back to `realtime.sendJson` with
explicit peer ids, routing around any room-level halt.

**Gates:** baseline + the shared-web trio (`shared-web-public-api-snapshots.test.ts`,
`shared-web-browser-bundle-boundaries.test.ts`, `check:browser-bundles`), the headless bundle boundary,
`test:e2e`, `test:full-stack:memory`, and **`test:rallar:full-stack:memory:live-rtc-3`**, which branch
CI does not run. 8d additionally carries both black-box profiles, medium-scale and state-write.

### Current-main checkpoint — slice 8a publication in progress (2026-08-30, PR #381)

The Slice 0 material-change review ran against `main` @ `2a62150d1`. The group-activation owners and
8a's cache-role decision remain valid. The live three-browser performance harness changed materially
through #383–#387, so #381 was rebased and its lifecycle proof adapted to the current managed/manual
group flow before publication. The formerly monolithic live matrix was then split at its delivery-
operation boundary to keep the touched test surface below the repository's hard size backstop.

Slice 8a now has two independent repository tokens under the unchanged scoped overlay identity.
Planned topology owns RTT evidence; accepted topology owns delivery and traffic preference. Snapshot
observation owns planned-to-accepted promotion and role removal. The obsolete browser graph dispatch
and its now-consumerless public topic were removed with maintainer approval; there is no graph or
single-slot compatibility fallback and no retained legacy entry.

Current-main execution exposed an independent authoritative-state defect rather than a cache-role
defect: presence writes can advance the physical group-row revision without advancing the semantic
group snapshot, while group reincarnation can advance the semantic version independently. No-op and
rejected mutation receipts therefore must validate each revision domain but must not equate them.
#381 carries the focused validator tests and the real PGlite/AppInbox rejoin proof for that rule. The
same final focused run closed one browser diagnostic gap: global-online state now reads only the client
cache, while group-present peers remain independently connectable during cache convergence. The
post-integration managed lifecycle/delivery gate passes both `realtime` and `messages.rtc`; broad gates
must be rerun on the final branch head before #381 leaves draft.

The final local Slice 8a checkpoint reran those broad gates on the repaired tree. The first state-write
A/B comparison used the development database and showed order-sensitive timing noise; the governed
pinned-Postgres A-B-B-A protocol then validated four fresh environments and the pooled comparison
passed with complete receipt/outbox evidence. `test:unit` initially exposed three integration-test
closure gaps from the live-matrix split and two-role cache: a stale legacy-removal inventory entry, a
source gate still pinned to the monolith, and a room test double that bypassed both overlay repository
roles. Their focused repairs restore the inventories and test ownership without adding a production
fallback or retained-legacy entry. The final unit, Deno, build, shared-web/headless boundary, browser
bundle, E2E, memory full-stack, live three-browser, topology-replay and fixed medium-scale gates all
pass on that earlier integration; they are not evidence for the later correction below.

### Slice 8a review refinements — receiver admission and current-state hydration

The oldest-first review keeps Slice 8a's planned-RTT/accepted-traffic separation and
canonical RTT reporter election, passive pongs and transport validation. The previous
bounded-wave stop is superseded by the maintainer's instruction to fix the findings and
continue. A prior review limit is not an acceptance waiver or a product constraint.

Two recovered ownership facts refine the remaining implementation:

- The browser's remote RTC receiver owns snapshot-floor admission. After transport
  decoding, a room message whose `minSnapshotVersion` exceeds the exact scoped local
  `GroupSnapshot.group.snapshotVersion` must not enter deduplication, ordering,
  application delivery or forwarding. The receiver emits a `not-yet-in-sync` NACK
  through the existing RTC outbox, correlated to the original message and immediate
  sending peer. Control messages bypass this gate so a rejection cannot create a
  rejection loop. No-floor traffic retains its existing behavior, and retrying the
  same message after snapshot advancement remains admissible. The local outbound
  planning path is unchanged. Injected receipts and server WebSocket rejection do not
  prove this receiver behavior.
- An HTTP topology read observes the current immutable group snapshot before awaiting
  its response. If group authority changes during that await, neither role may be
  adopted or removed from that response. Checking membership alone allows an old
  accepted layout to be recreated after newer acceptance revoked it. Current-state
  repair still accepts an incomparable topology observation when its group and role
  observations remain current. Each role also captures its raw repository record,
  including tombstones: an intervening role publication fences that role's delayed
  non-monotonic repair even when the group object is unchanged. Null results remove
  only the original active role observations and retain tombstone fences.

The receiver constructor uses a named required input with explicit stores, clock and
heartbeat policy. Its class identity remains public; the positional constructor and
uninvoked receiver outbox-callback registry have no retained overload or shim. The
consumerless receiver raw-message callback registry is also removed: it bypassed
admission, had no corresponding peer teardown and had no verified repository caller.
The data-channel and heartbeat callback ports remain independently required. The
multicast manager already owns the group cache and outbound control path, so this
receiver fix does not require changing that independent owner's constructor.

The black-box runtime and live proof use required production lifecycle ports and
canonical command/result contracts. Cleanup normalizes caught failures once and
preserves every diagnostic in a named serializable shape. Existing source-inventory
checks remain supplementary to real receiver, lifecycle and cleanup behavior tests;
no package-boundary or legacy-removal check is waived.

Every changed human-authored file must be reviewed and remediated in full. Every support
file modified during remediation enters that closure recursively. Independent untouched
code remains outside closure. Remove affected graph, single-slot and missing-port legacy;
keep no production compatibility shim merely to preserve a coupled test.

The Slice 8 gates above and condition-based gate assignment below remain acceptance requirements. In particular, real
three-browser delivery must observe receiver-generated NACKs, and current-candidate
public-surface, bundle, native PostgreSQL and state-write evidence must support delivery.
Published PR checks and review conversations own readiness; this document is not their
status ledger. Merges remain manual.

Native review validation also exposed an existing presence-response race in the
state-write convergence recipe. A successful reconnect receipt can precede the
asynchronous group-presence summary, as already decided in #112 and implemented for
the topology-churn proof in #116. Preserve that service contract. The reconnect
request observes success and its causal tuple; a bounded read in the same concurrent
presence lane must observe the exact reused session's new generation before recording
the accepted lifecycle observation. A higher presence revision alone is insufficient
because another concurrent summary update may advance it. Preserve the generation and
expiry assertions, four racing lanes, final convergence rounds, maintenance delay and
existing timeout budgets; do not make the production response synchronous or rerun the
unrepaired recipe until it happens to pass.

The subsequent `main` checkpoint at `5530e8b43` changes the live-browser harness,
not the cache-role or receiver-admission contracts. Preserve its awaited membership
refresh after peer readiness and before measured delivery, with refresh time included
in the shared readiness budget. Failed browser startup and cleanup must still release
the owned contexts and leave failure-evidence writing reachable. Preserve bounded
observation of received RTC frames and exact NACK message/peer correlation alongside
the receiver proof and named cleanup diagnostics in this slice. The delivery-operation
owner remains separate from scenario orchestration; do not restore obsolete source
topology assertions or duplicate the new browser/control owners during integration.
The pair-first proof plans and activates the pair, refreshes membership and verifies
both peers ready before connecting the third peer. Promotion must precede readiness
because a later transport reuses the group with its previous accepted session IDs.
It then uses the existing reopen transition, promotes the three-member
plan, refreshes membership and verifies three-peer readiness within the measured
budget. Current Slice 8a dialing prefers the accepted layout, so waiting for the
third peer before promoting the replacement would depend on a race or on Slice 8b's
future dial policy. Establishing again from ACTIVE is not a valid transition.
Rerun the affected live-browser and evidence tests after resolving the source conflict.

Native release validation also exposed a separate WebSocket authority/fanout
boundary: room authorization reads current durable membership, while default live
fanout resolves recipients from an independently populated snapshot cache. An
authorized message can therefore have no recipients even while its sender's socket
is live. Preserve the fresh authorization read and carry its scoped membership
observation into the original message's default live fanout. Keep that observation
server-side; do not rewrite AL targets, widen fixed recipient audiences or broadcast
exclusions, reuse it for proxy-transformed targets, or change queued delivery.
Recipient resolution must still check the exact application, workspace and group,
current leases and open connections. Canonical cache warming is insufficient: same-tuple liveness/lease
projections can legitimately differ from stored snapshots and are not new canonical
observations. Prove cold-cache, older-empty-cache and renewed-lease cases through the
actual API authorizer and live recipient path, while retaining fresh ban/deletion
rejections. The WebSocket recipe's echo assertion and existing budget remain intact.

Full-file closure removes the unused optional context arguments from the public
`RallarServerWsRouter.route` method and its internal install adapter. The class and
export remain unchanged; TypeScript callers now call `route(message)`. Repository
consumer and documentation review found no independent requirement for the ignored
arguments. This is a disclosed signature narrowing under the requested legacy
removal, with no compatibility shim or retained-legacy exception.

For the governed state-write A-B-B-A comparison, every fresh position requires
exactly nine measured runs, one warmup and concurrency ten. The general harness's
three-run example does not satisfy the pooling protocol. Preserve all four source
artifacts and environment descriptors, and diagnose failed comparisons without
selecting favorable samples or relaxing timing, resource or correctness limits.
The complete nine-run comparison for `7e6b213` failed uncontended p99, shared
throughput and hot throughput. Its retained artifacts remain the acceptance result.
A separate frozen-checkout profile captured CPU, garbage collection, event-loop
gaps and PostgreSQL waits/checkpoints; instrumented timings are diagnostic only.

### Review checkpoint — slice 8b admission and consumer closure (2026-08-31, PR #390)

PR #381 completed review at `7bac6e40194356cdc08da07a5890372d16cbd695` and the
maintainer merged it into `main` as `1bee0b239`. Its final native release gate,
three-browser live RTC proof and complete nine-run state-write A-B-B-A comparison
passed. The earlier failed comparison remains preserved and is not overwritten by
the later passing evidence. No agent merge or auto-merge was used.

The oldest remaining PR is #390. Reapply its actual Slice 8b delta over the reviewed
parent; do not resurrect predecessor cache, RTT or test owners from its old parent
history. GitHub has retargeted it to `main`; repair the actual conflict before broad
final validation. Later PRs remain unreviewed until this capability is closed.

The review found four concrete admission/security defects and two evidence gaps:

- A desired overlay edge alone authorized direct dialing, while reconciliation also
  required that peer in the same scoped room's current presence. One cached peer
  ownership computation now supplies both ownership and the layout/presence
  intersection used by every creation policy and reconciliation. Presence in another
  room is not authority for the selected edge. Existing established peers remain
  reusable after admission changes.
- A retained peer DTO could bypass admission after native failure or reset. Reuse
  requires a live connected or in-progress native connection; a DTO alone is not
  evidence of reusable transport. Remove unusable resources, then apply current
  inbound or outbound admission, capacity and establishment-attempt accounting
  before replacement allocation. Preserve attempt history across replacement.
- The browser started the signaling transport before its group manager installed
  admission policies. Install deny policies before connecting signaling, then replace
  them with the lifecycle policy during normal middleware composition. A real queued
  incoming offer during pending transport connection must allocate no native peer
  and consume no establishment attempt; the same peer must be admissible after a
  valid accepted layout arrives.
- Signaling decoded unchecked payloads and logged credentials, SDP and ICE. Validate
  the envelope and operation payload before allocation, including direct public
  accept calls. Keep untrusted wire data at the decoder and do not retain parser
  causes that may quote secrets. Attempt budget state has one explicit lifecycle
  owner; no fallback connection implementation remains.
- Replace callback-only policy tests and whole-peer mocks with real browser policy,
  connection service and native RTC boundary effects for the complete lifecycle ×
  planned/accepted matrix, scope isolation, initial denial and established reuse.
- Keep the peer-owner benchmark's accepted-layout, electorate, causal-version and
  generation fixture internally coherent. Preserve measured work and acceptance
  constants while removing private-state benchmark/test access in affected files.

The server already freezes a connecting/reconnecting plan through its canonical
plan resolver; no second browser freeze owner or tentative-state fallback is
justified. Full touched-file closure includes consumers reached by canonical RTC
filename/type migrations: native channel/queue owners, browser facade fixtures,
multicast/group owners, reusable benchmark ports and black-box command contracts.
This is still review work for #390, not a new product slice. Remove affected dead
exports and unsafe predecessor test doubles rather than adding compatibility shims.

The recursive review also corrected queue-reader disposal, channel callback
cleanup, persisted/network AL decoding, and raw browser command decoding. Native
fixtures now exercise the actual RTC/WS owners; server fixtures use real state
services and transactional persistence. The browser bridge validates connection
configuration before calling the runtime, and no longer falls back from missing
authentication support to a full connection. No verified consumer required that
fallback. Generic application message payloads remain application-owned.

Sparse CRDT validation input must preserve omission. An absent schema-version or
operation-version allowlist must not become an explicit `undefined` field that
overwrites the core's defaults. Prove rejection through the real CRDT core for
both updates and snapshots, while preserving explicit overrides and empty lists.
Console observations publish their normalized message, without retaining raw
arguments that can be circular or non-serializable.

The stricter queue boundary also exposes the administrative prune worker's old
`all/global` target pair. New page envelopes and their domain reader use canonical
`broadcast/all` targets. The maintainer chose to clear the databases for this
cutover instead of preserving retained messages. Remove the target-translation
migration and its dedicated tests; keep the canonical producer and strict reader
without a runtime fallback. Stop old producers and readers before the reset,
initialize the clean databases through the existing Prisma migrations, and start
only the new build. Prove actual queue dispatch and rejection of noncanonical
pages. The agent does not perform the database reset or change deployment settings.
The handler already completes each page atomically; generic queue release must
recognize that exact completed reservation through a server-owned, fenced admin
predicate. It must not weaken the shared queue's reservation or revival rules.

The existing deployment workflow does not stop old queue workers or clear the
databases. The maintainer owns coordination of that clean-database cutover with
the manual merge and deployment. Clearing data while old workers remain active
would let them recreate obsolete messages. No repository-wide deployment pause
is part of this implementation, and no production data or setting has been changed
during this review.

The headless browser guard accounts for the validated command and signaling
boundaries: identical builds measure 204.926758 KiB for the reviewed parent and
207.519531 KiB after the decoder corrections. Use the smallest whole-KiB ceiling,
208 KiB, retaining the existing Brotli settings and all operator-UI dependency
exclusions. This proportional browser cost does not change the state-write
performance thresholds or permit weakening input validation to save bundle bytes.

**Delivery decomposition:** keep these corrections in #390. The canonical RTC and
queue owner renames cross their production, browser, server, benchmark and test
consumers; splitting that migration would leave broken imports or require the very
legacy forwarding owners this review removes. The native fixtures and decoder
regressions are the evidence for the corrected production boundaries and belong
with them. This is an unusually large atomic review correction, not a precedent
for combining later product slices. The browser transport ownership table in
`docs/rallar-convergent-state-and-rtc-topology.md` is the durable read-first map.
Keep #391 and #396 as separate capability PRs and reassess Slice 9 only afterward.

Intermediate evidence: browser admission/manager/RTT tests passed (62 assertions),
connection-service native effects passed (31 tests), and shared/shared-web plus
985 maintained test files typechecked before the later recursive closure edits.
These are diagnostic checkpoints; integrated final checks, current-head review and
remote release evidence are still required before #390 is marked ready.

### Slice 8c start checkpoint — accepted-layout room facade (2026-08-30)

Slice 8c starts from #390's published head `079a02ba9` on
`codex/group-activation-room-facade`, stacked on the completed Slice 8b browser dial gate. #390 stays
draft on #381 while its final-head remote checks rerun. This slice owns only the room-facade cutover:
accepted-layout readiness and progress, the local halt and typed status, browser-owned repair state,
and the two game consumers named by C10. Slice 8d's HTTP/OpenAPI routes, legacy-route removal, recipe
cutover, both black-box profiles, state-write gate and public command mounting remain outside this
branch. Before code changes, the census must recover the current owners for room status, lane
readiness, local halt, per-peer reconnect state, AR Eye's exhaustive status mapping, and Relic's
explicit-peer `sendJson` fallback; any owner or contract material change updates this checkpoint before
implementation continues.

The current-head census changes the implementation owner map without changing Slice 8c's behavior or
gates. `createBrowserStateComposition` still resolves room peers from active sessions and feeds that
one callback to both `BrowserRtcWaitRuntime` and `BrowserRtcRoomRuntime`; it is the cutover point for
an accepted-layout room view. `roomStatus().rtc` already owns the desired/ready/failed arrays, while
the global RTC status owns each peer's `reconnecting` and `reconnectAttempts`; the room status still
lacks its accepted-layout identity, room-filtered peer repair view, and typed `halted` state. The
explicit-peer recovery bypass has moved out of a Relic app file into shared
`RallarGamePresenceEgressRuntime`, so removing it once closes the affected path for both games. Relic's
separate per-frame motion sender still needs the I11 snapshot-level `transportState` guard so a halt
does not spin sends. AR Eye's relevant room-send outcome mapping is now the shared
`toRallarGameRoomRealtimeSendResult`, not an app-local default arm; it must become total for the new
halted result. I17 remains authoritative: the public progress shape is the accepted layout identity
plus the existing peer arrays, never a computed fraction.

The Slice 8c TDD implementation checkpoint is green on the focused surfaces. The browser now derives
one canonical room transport target from a joined active group snapshot and the matching active,
server-provenanced accepted overlay; active sessions that are not accepted next hops cannot become
room RTC targets, and absence of an accepted layout exposes the group transport state but no peer
targets or layout identity. That target now owns room lane waits, room status and live room-targeted
channels. `roomStatus().rtc` exposes the accepted layout identity, the existing desired/known/active/
ready/failed peer arrays, and a room-filtered peer diagnostic view carrying the existing
`reconnecting`/`reconnectAttempts` pair. An accepted edgeless layout remains open, no accepted layout
is idle rather than misleadingly open, and authoritative `halted` wins before any wait, dial or send.
No readiness fraction was added.

The affected game path has one send owner after the cutover. `RallarGamePresenceEgressRuntime` now
returns the room-facade result directly; its explicit-peer `sendJson` recovery path, associated status
probe, peer-union helper and input seams were removed rather than retained. The shared room-result
translation is exhaustive and maps `halted` to the game contract's `stopped`. Relic's per-frame motion
sender reads `rallar.rooms.state().currentRoom?.group.transportState` before advancing its sequence or
send gate and records a typed halted diagnostic without sending. Focused validation passes seven
shared-web files / 64 tests plus the Relic motion file / 9 tests. The all-workspace source typecheck
and its enforced 972-test-file check pass with zero debt, and the complete shared-web sweep passes 110
files / 552 tests. The first browser boundary run found a real 164.14 KiB Brotli regression against
the unchanged `< 164 KiB` facade budget. The budget was not raised: removing the unused internal room
reference, reusing the accepted-overlay repository's canonical identity predicate, consolidating room
peer filtering, and keeping one room-send option projection reduced the measured facade to 163.98
KiB. The public API, browser boundary and headless boundary trio passes 16/16; the package browser-
bundle command passes; and AR Eye Hunter, Relic Hunters and the headless browser consumer all build.
Full unit, Deno, repository-wide build, E2E, memory full-stack and live-three-browser gates remain for
the slice-final checkpoint; their results will be recorded here before publication readiness is
claimed.

The first stacked publication run exposed one parent-branch release-gate failure rather than a Slice
8c behavior regression. Because Slice 8b replaced the removed tentative-admission test inside the
existing `WebRtcConnectionService` suite, the changed-range structure review correctly re-examined
22 pre-existing mock invocation-count assertions in that touched file. No exception was retained and
the gate was not weakened: the test doubles now expose direct signal, connection and reset state, and
the affected tests assert those observable outcomes instead of mock call counts. The focused 25-test
service suite, formatting, changed repository style and the exact changed-range structure gate pass;
the latter reports zero current unclassified candidates. Slice 8c is restacked on repaired Slice 8b
head `b8dae45a8`, and both PRs must complete their refreshed remote checks before the slice-final
checkpoint is closed.

The Slice 8c final local checkpoint is green on the runtime tree. Root typecheck passes every
workspace and all 972 enforced test files with zero debt. The complete unit run passes 997 files /
8,412 tests with four files and nine tests skipped; the complete Deno and all-workspace build commands
pass. Browser E2E passes 39 core tests with 47 configured skips and 210 Recipe Console tests with one
configured skip. Memory full-stack passes 7/7, and the enabled live three-browser RTC scenario passes
with its exhaustive and 100-reconnect variants remaining the two configured skips. The unchanged
browser facade bundle budget still passes at 163.98 KiB Brotli.

The slice-final changed-range structure review initially re-examined 32 existing mock-call assertions
across five touched tests. As with the parent repair, no disposition or baseline was added: redundant
call assertions were removed where typed outcomes already prove the branch, callback assertions now
use received-envelope collections, halted/stopped tests install fail-fast transport doubles, and the
two remaining transport counts use explicit fake state. The focused rerun passes 50 shared-web tests
and nine Relic tests; test typecheck remains 972/0; changed repository style passes; and the exact
structure gate now reports zero current unclassified candidates. Repository structure passes with its
review findings, and retained-legacy review adds no registry entry: four findings are benchmark CLI
default-value vocabulary and the remaining `register=if-needed` login attempt is current configured
auth behavior, not a compatibility path. Delivery status correctly remains `STOP_WRONG_BASE` while
#391 is stacked on #390. Refreshed remote checks on final code head `9c89e81b4` and its subsequent
plan-only checkpoint must pass before review readiness is claimed.

The independent Slice 8c review then found a real authority gap before readiness: the generic room
channel return type still permits per-send peer selectors, and fixed room membership cached its first
peer set, so an explicit selector could escape the accepted layout and a fixed channel could survive a
later authoritative halt. The fail-first review suite reproduced both sends, plus the contradictory
`empty` reason and `mode: off` state that could mask halt. Room channel creation now marks room scope
explicitly, every room send intersects its selected peers with the current accepted target, fixed
membership is re-authorized on every send, and authoritative halt wins in both state and explanation.
The negative game appointment cases also install a fail-fast appointment double instead of assuming
non-invocation. The focused correction passes 47/47 tests; the wider all-workspace typecheck passes
with 972/0 enforced test files; and the unchanged public channel contract is retained rather than
silently narrowed.

This correction is blocked only on the unchanged browser-facade bundle gate. After removing the
redundant post-`filter` fallback and the unused internal room field rather than retaining dead data, the
clean bundle measures **164.0615 KiB Brotli** against the current strict `< 164 KiB` limit. The
pre-review Slice 8c head had only 24 compressed bytes of margin, so the accepted-layout intersection
cannot fit without either changing that gate or removing public channel behavior. No budget has been
raised, no public surface has been removed, and no retained-legacy entry has been added. Maintainer
direction is required before publication continues; the recommended minimal material change is a
documented **164.25 KiB** facade budget, followed by the full final-head gate rerun and independent
re-review. The post-format correction sweep passes six focused files / 58 tests and the root
all-workspace typecheck with 972/0 enforced test files. #390 is fully green remotely; #391's previously
published head has all focused remote jobs green while its release gate remains pending, but this
unpublished correction supersedes that evidence.

The follow-up bundle audit compared the published head and clean correction with identical esbuild
entry, minification, target and Brotli-quality settings. The published head is 802,234 minified bytes
and 167,912 Brotli bytes (163.9766 KiB); the correction is 802,327 minified bytes and 167,999 Brotli
bytes (164.0615 KiB). The correction therefore adds only 93 minified / 87 compressed bytes, while the
strict `< 164 KiB` ceiling is 167,935 bytes and still requires a 64-byte reduction. This rules out a
measurement-only anomaly and confirms that further progress now requires the recorded material gate
decision rather than another compatibility removal or retained dead path.

The maintainer approved the recommended exact **164.25 KiB** browser-facade budget on 2026-08-30.
Both authoritative budget definitions now carry that value, resolving the material gate decision
without removing the public channel selector contract or retaining dead compatibility behavior. The
Slice 8c checkpoint is resumed; publication still requires the complete final-head gate rerun and an
independent re-review of the authority correction before #391 can be reported ready for its stacked
base.

The resumed checkpoint first re-proves the corrected ownership boundary: six focused files pass
58/58 tests, the complete shared-web suite passes 110 files / 554 tests, and root typecheck again
enforces 972 test files with zero debt. The authoritative browser-boundary test and package bundle
measurement both pass under the approved strict budget; the facade remains 164.1 KiB Brotli at the
human-readable reporting precision.

The complete final-head rerun is green locally. Full unit passes 997 files / 8,414 tests with four
files and nine tests skipped; Deno and every workspace build pass; and the public API, browser
boundary and headless boundary trio passes 16/16. Browser E2E passes 39 core tests with 47 configured
skips and 210 Recipe Console tests with one configured skip. Memory full-stack passes 7/7, and the
enabled live three-browser RTC scenario passes with the exhaustive and 100-reconnect variants
remaining the two configured skips. Changed repository style reports zero new findings against Slice
8b head `b8dae45a8`, while repository structure passes with the already-reviewed Relic scene density
and singleton bundle-measure script subtree findings. Independent re-review and remote validation on
the resulting published commit remain before the Slice 8c checkpoint closes.

Independent re-review confirms the original room-override, fixed-membership halt, status precedence,
and appointment-side-effect findings are corrected, but found three manual touched-file function-size
violations that the changed-range automation does not classify. No exception is retained. Targeted
channel assembly now delegates its accepted-target resolver; Relic position broadcast delegates
sample resolution, halted diagnostics, and the room send; and the game fake separates mutable state,
transport ports, sub-facades, and event emission. Their affected functions are now 39, 56, and 43
physical lines respectively, with every extracted helper at or below 45 lines. The 56-line Relic
broadcast remains in the mandatory separation-review tier and is accepted because its remaining
single responsibility is the ordered position-broadcast lifecycle. Root typecheck remains green at
972/0. The exact post-closure worktree passes seven focused shared-web files / 62 tests plus Relic
scene networking 9/9, with the approved browser facade measuring 164.2 KiB Brotli under the exact
strict **164.25 KiB** budget. Full unit passes 997 files / 8,414 tests with four files and nine tests
skipped; the complete Deno matrix, every workspace build, and the public API/browser/headless trio
at 16/16 pass. Browser E2E passes 39 core tests with 47 configured skips and 210 Recipe Console tests
with one configured skip. Memory full-stack passes 7/7, while the enabled live three-browser RTC
scenario passes with its exhaustive and 100-reconnect variants remaining the two configured skips.
Changed repository style reports zero new findings against Slice 8b head `b8dae45a8`, and repository
structure passes with the already-reviewed Relic scene density and singleton bundle-measure script
subtree findings. The publication commit, independent re-review of that exact commit, and remote
validation remain before the Slice 8c checkpoint closes.

Independent review of commit `80b327f41` reopened the checkpoint with one authority defect: a room
lane wait refreshed transport status but retained ready peers from the pre-wait accepted layout, so
an accepted-layout change during the asynchronous wait could still send to a removed peer. A new
fail-fast public room-channel regression first reproduced that send. The runtime now intersects the
wait result with both the refreshed accepted target and refreshed ready set before any send; the
regression and existing room/game tests pass 30/30. The same review found that the newly split game
facade double accepted an untyped `object`. Its partial boundary now accepts `Partial<T>`, and its
supplied room, people, RTC, realtime, message, WebSocket, and director members are compile-time
shape-checked with exact state/status returns. The replacement commit, affected and broad gate
reruns, exact-commit re-review, and remote validation remain open.

The exact post-review replacement tree is green locally. Seven focused shared-web files now pass
63/63 tests, including the fail-fast stale-layout regression, and Relic scene networking passes 9/9.
Root typecheck still enforces 972 test files with zero debt; the public API, browser boundary and
headless boundary trio passes 16/16; and the browser facade passes the exact approved **164.25 KiB**
budget at 164.1 KiB Brotli reporting precision. Full unit passes 997 files / 8,415 tests with four
files and nine tests skipped; the complete Deno matrix and every workspace build pass. Browser E2E
passes 39 core tests with 47 configured skips and 210 Recipe Console tests with one configured skip.
Memory full-stack passes 7/7, while the enabled live three-browser RTC scenario passes with the
exhaustive and 100-reconnect variants remaining the two configured skips. Changed repository style
reports zero new findings against Slice 8b head `b8dae45a8`; repository structure passes with the
already-reviewed Relic scene density and singleton bundle-measure script subtree findings. The
replacement implementation is committed at `367cef8af`; its slice-local production legacy scan finds
no candidates and validates the registry. Delivery status correctly reports `STOP_WRONG_BASE`
because #391 is stacked on #390 rather than `main`, not because of a merge conflict. Exact-head
re-review of implementation head `ada7978d3` reports no critical, important or minor findings and
confirms the authority race is closed, facade test doubles are shape-checked, the public budget is
exact in both definitions, and no Slice 8d or retained-compatibility work leaked into the slice.
Publication and remote validation remain before the Slice 8c checkpoint closes.

### Review checkpoint — slice 8c room authority (2026-08-31, PR #391)

The parent review changed native RTC and queue owners, so resolve the actual stack
conflicts without restoring partial whole-object test casts. A room target must
intersect the exact accepted layout with the same snapshot's active sessions:
layout publication may lag presence removal, and a peer connection can remain
open for another room. Keep accepted identity as the authority; presence alone
never grants a target.

Pin full room scope before asynchronous connection or lane waits. Reauthorize
targets immediately before JSON/binary writes and before reporting room-ready
peers after a wait. Changing default workspace, membership, accepted layout or
halt state during an await must not redirect an operation or expose stale ready
peers. Explicit unscoped peer APIs retain their distinct behavior.

Per-send room and peer selectors override channel defaults as a unit; a default
full room reference must not mask an explicit room ID. Omitted send options keep
the configured expiry, replacement key and lane-open timeout. A lane that closes
while another peer is still opening must also leave the final ready set.

Derive room failure progress from actual requested-lane or connection failure,
not the connection service's retry-eligibility query, which can include healthy
open or connecting peers. Prove these paths with native RTC boundaries and real
room-facade consumers. The game cleanup also checks receive scope independently
of the shared realtime lane; a dungeon room ID alone cannot identify a game room.
Relic motion therefore uses the app-private `relic.motion.v2` payload with a
mandatory full `GroupRef`. Reject old or missing-scope packets, and remove the
older world-coordinate receive fallback. All Relic clients must update together;
there is no retained dual-protocol reader.
Game match configuration must also choose a coherent room ID/reference pair:
an explicit room ID cannot inherit the current reference of another room, and an
explicit full reference determines its own room ID.

The final room-authority closure measures the browser facade at **168,399 bytes /
164.4521484375 KiB** and the headless consumer at **213,469 bytes /
208.4658203125 KiB**. Those are 208 and 478 bytes above the previous strict
allowed maxima. Independent deletion and consolidation review found no meaningful
safe reduction without obscuring the asynchronous lifecycle guards. The maintainer
approved strict **165 KiB** and **209 KiB** limits on 2026-09-01. Keep the existing
entry points, dependency exclusions, minification target and Brotli quality; the
decision changes only the two reviewed ceilings. Both authoritative facade budget
definitions and the headless boundary must carry the approved values before the
final-head gates can close.

**Next two PRs (I5, I20):**

- **Finish existing #390 / slice 8b.** Source and independent review, local validation,
  native release checks and the ready-for-main marker are complete. Await the
  maintainer's manual merge and chosen clean-database cutover. No agent database
  reset or deployment pause.
- **Finish existing #391 / slice 8c.** Apply the approved bundle ceilings, rerun the
  final-head gates, then retarget after #390 merges and publish its ready-for-main
  marker. Review #396 next; resume Slice 9 only after the newest existing PR
  completes review.

## Slice 9 — In-flight pacing

Three prerequisites remain after the #390 review: (1) `ensurePeerConnectionStarted` still returns a
right value for both a new connection and reuse, and the group manager increments its diagnostic
attempt counter before that call; (2) the connection service's lifecycle subscription still exposes
`onCreated`/`onDeleted`/`onConnectTimeout?`/`onConnectExhausted?`, without an established event for the
manager; (3) there is **no wire path for the bound** — `GroupSnapshot` carries no policy (**Q2**).
The native peer now has an `onConnected` callback, which the service uses to clear its establishment
timer and retry budget. That per-peer retry budget already charges only new admitted connections;
reuse and denied admission do not consume it. Slice 9 must expose the existing establishment truth
to its manager rather than add another native success detector or undo that corrected accounting.

A fourth structural gap: the reconcile pass flattens all groups into one desired-peer set, so there is
no per-group loop for a per-group bound. **Product decision 18 answers the ownership question, and the answer is a rule rather than a
negotiation**: a peer two groups both want is one connection charged to each group's in-flight count,
and it is admitted only when **every** owning group has a free slot — so it waits while either is at
its bound, even if the other is idle. Put that consequence in the pacing matrix. "No cross-group
arbitration is promised" describes the absence of negotiation, not the absence of a scheduling
decision, and an earlier draft leaned on it as though it removed one.

- **9a — truthful RTC lifecycle signals** (surface attempt-started and the service's established event). Dark,
  additive, independently valuable. I13 fixes the wire path: a nested member-policy object on the `Group`, carrying the resolved member-tier values with its own field validator.
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

An `apply` landing gets its producer here: the transaction that accepts a planned publication
atomically enqueues 4a's identity-fenced `applyPlannedLayout` preparation under
`topology-publication` authority. Hold writes no accepted facts. Replay, conflict, process restart and
publication supersession converge through the promotion mutation rather than a second writer.

`layoutStale` needs the accepted layout's fingerprint, copied by 4a's canonical promotion effect
rather than reconstructed here. The formation view already reads planning authority but owns no
execution repository. One non-obvious mover is the TTL'd effective topology override: if it remains
in the fingerprint, expiry can flip `layoutStale` on wall-clock time alone, so the read surface must
say so; otherwise exclude temporary overrides explicitly.

Split 10a (`commanded` + `layoutStale` + `pending` on the formation view = the `commanded-replanning`
scenario) from 10b (per-group windows, the maximum wait, and minimum layout age). **10b carries a
durable shape change**: the maximum-wait anchor is a new field on the coalesced work metadata, which is
guarded by an exact-key required/allowed list in the work codec, and rows are in flight when it lands —
so it needs either a backwards-compatible read or a documented database drop, and the local Postgres
must be dropped before re-running the profile. This is where the
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

**The connect trigger latch and 4b freeze own adjacent races; neither replaces the other.** **Needs:**
slice 3's `formation-automation` capability. No authority mode lands here, and the post-publication
hook continues policy intent with `formation-automation`, never `topology-publication`.

Trigger satisfaction creates a durable `GroupConnectTriggerLatch` keyed by group, formation epoch and
trigger generation. It remains `awaiting-publication` while the group is `planned` or
`reconfiguring`. Creating the latch immediately checks the current planned row; every later accepted
publication checks it again and enqueues an identity-specific internal `connect`. Submission never
consumes the latch.

The internal command carries the latch identity plus the exact planned identity. `no-planned-layout`
and `planned-layout-superseded` write nothing and leave the latch armed; publication B therefore
reissues after A is superseded. Only a successful `planned | reconfiguring → connecting |
reconnecting` transaction CASes the matching latch to `consumed` alongside the stage transition.
Reset or epoch supersession invalidates it. A crash after commit but before worker acknowledgement
replays the identical command and durable result. After commit, 4b's stage freeze—not the latch—owns
candidate stability until activation, failure or reset.

Manual `connect` carries no latch identity and returns the typed denial to its caller. Tests cover
trigger-before-publication, latch-created-after-publication, A→B supersession before command compute,
duplicate publication, concurrent A/B commands, crash/replay, reset/epoch invalidation and the exact
handoff from consumed latch to frozen B.

**Repair the pre-existing deadline gap here — its shape changed on `main`** (`e6a2faef6`; recorded at
the initial checkpoint). The formation timer handler now **throws** when no plan is stored, so a
dialing group whose deadline expires before its first publication redelivers the durable entry in an
unbounded retry while the planned read stays null — no longer a silently never-failed group, but
still a gap with no bound and no fail path. The retry leg is armed only by `fail-formation` and
gated on `forming`. The connect trigger reproduces the same shape and both need one bounded answer.

The `presence` trigger looked like a restructure and is not. Both facts hold — the presence summary
has no policy read and no submit port, and is constructed _before_ the `GroupStateInboxService` that
owns the criterion enqueue — but the conclusion does not follow, because the pattern already exists one
hop downstream. The presence summary writes coalesced group-revision work in its own transaction; that
row is dequeued by `createRtcTopologyWorkHandler`, which is constructed **after** the runtime, already
receives `formationCriterion: { readLifecyclePolicy, submitCommand }`, and already calls
`petitionFormationCriterion`. A presence-count trigger evaluated there is one branch beside an existing
petition call, on a path every presence change already reaches — the input fingerprint hashes
`activeSessionIds`, so a join or session replacement moves it and the `skipped-fingerprint` early
return does not swallow it. The one real gap is that `computeFormationCriterionCommand` returns null
outside the dialing stages, so a `forming`-stage trigger needs its own pure evaluator. **Cost 11b as
one branch plus a pure function, not a construction graph** — and pay the restructure only if a latency
requirement the coalesced hop cannot meet is stated explicitly.

The plan also over-counted one item: "a mirror entry" is not a distinct cost per timer kind.
`computeExpectedFormationTimerEntries` re-invokes the same `computeFormationTimerEntries` and compares
with `jsonEquals`, so there is no second implementation to maintain. The real constraint is that arming
stays a pure function of its inputs — any trigger needing a fact outside that tuple breaks the mirror. Its compute is validated by a
byte-exact mirror, so nothing it adds may capture wall-clock.

Slice 3 already owns and tests the authority matrix. Slice 11 adds no trusted mode and cannot widen
`formation-criterion`; all trigger commands use `formation-automation`.

Split 11a (`immediate`/`after` via the durable timer path) from 11b (the `presence` trigger with its
construction restructure and its own state-write verdict). **Write the first unit tests this surface has
ever had in 11a.**

**Gates:** baseline, both profiles, **medium-scale**, **state-write**, `formation-large`.

## Slice 12 — The living observed status

**Needs:** slice 3's `activation-status` capability. This slice registers no new authority mode and
cannot reuse `formation-automation`, `topology-publication` or `formation-criterion`.

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

**Coverage basis is one exact field everywhere:** `coverageBasisLayoutIdentity` is accepted whenever
an accepted layout exists; before first activation it is the frozen planned candidate being dialed.
The status command fence, evidence-watermark series, dwell and evidence-expiry keys, damping row,
stale-drop comparison, event and formation view all use `(formationEpoch,
coverageBasisLayoutIdentity)`. Two successive initial planned identities therefore cannot share a
causal series.

- **12a — the fields, the event, and read-derived reporting**: condition and remediation with their basis
  added to the key lists (I4's second edit), `group-activation-status-changed` registered at its six
  sites (only the `Record<GroupEventType, true>` one is compiler-checked), and both axes reported on the
  formation view **derived at read** — written only by transitions that already CAS the row. No new
  writer, no amplification. Also here: publish `maxFormationAttempts` beside `formationAttemptCount`
  on the formation view and in OpenAPI (product decision 39) — today it appears only inside
  `CreateGroupRequest`, a request body, so the numerator is pushed everywhere and the denominator is
  readable nowhere, which makes `start`'s exhaustion denial undiagnosable.

  **No pushed fraction** (product decision 40): coverage stays derived at read, and 12b's writer
  publishes only banded condition changes. Pushing a fraction at 1 Hz for a 50-session group would
  cost ~60 group CASes, ~60 durable event rows and ~3,000 WS deliveries per minute against a measured
  steady state of zero at that tier.
- **12b — the internal status writer** with dwell, hysteresis and durable clocks, damped on a
  per-group coalesced APP_OUTBOX row (I14) so the damping survives a multi-node cluster with no new
  durable shape.

  Two notes the earlier drafts owed. **Copy `resolveTopologyKindWithHysteresis` for the banding** —
  entry thresholds from policy, exit sitting a configured _width_ below entry so a per-group patch
  cannot invert the band, previous value deciding — rather than inventing a scheme; it is the only
  hysteresis in the repository and its shape is right, even though it is stateless and clockless.
  **And the durable clocks are not slice 11's timer shape.** A dwell timer's due time moves, and an
  armed formation-timer entry cannot be re-armed — the write throws unless resource, creator, created
  and expire timestamps all match byte for byte. So the dwell and evidence-expiry clocks need the
  coalesced replacement path, the same one I14 already picks for damping, not `GroupFormationTimerWork`.
  Earlier drafts implied slice 11's timer extension paid for this. It does not.

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
codes behind** the TypeScript const, with no test coupling them); and the twenty-six acceptance scenarios
registered in `recipe-matrix.json` plus both hand-maintained sorted id lists in `recipe-matrix.test.ts`.
It also verifies that `start-establishment` and `reopen-establishment` are gone everywhere after 5d
and 6a inventoried them and 8d removed them in the atomic route cutover.

#### Carried into this slice from PR 9 (slice 5e)

Two items the reset/start slice found and deliberately did not act on, because they belong with the
enum catch-up rather than with a dark command.

- **Nothing couples the OpenAPI `GroupPolicyReasonCode` enum to `GROUP_POLICY_REASON_CODES`, and that
  absence has already cost something.** PR 9's edit adding `formation-attempts-exhausted` to the enum
  was reverted twice by a blanket `git checkout` after a formatting run, and both times the loss was
  silent — no gate, no test, no type error. The second time it shipped as a false claim in that PR's
  own delivery record, caught only by review. Measured on that branch: the TypeScript const carries
  **22** codes, the OpenAPI enum **16**, so the **6** named below are missing and
  `formation-attempts-exhausted` is present in both — the "6 codes behind" figure above is still
  exact, and PR 9 added no debt. The catch-up should land the coupling test as well as the six codes,
  or the next edit disappears the same way:
  `lifecycle-transition-invalid`, `lifecycle-manager-unavailable`, `group-admission-closed`,
  `group-admission-deadline-passed`, `group-admission-capacity-reached`,
  `group-data-blocked-until-active`.
- **`RtcTopologySnapshotRepository.findEntryRevision` becomes dead when 6c lands, not before.** PR 9
  widened `GroupAcceptedLayoutRow` and moved the api-v1 reader to `findSnapshotEntry`, which left this
  method with no callers — but the split reverted both, so it has its caller back today. **6c owns
  removing it** when it re-lands the widening; product decision 14 forbids retaining legacy, and a
  public method with no callers is exactly that. Recorded here so the catch-up does not delete a
  method that is currently live.

**Nothing behavioural hides here.** The reader-default removal the first draft placed in this slice is
already done: #319 cut `group-state-persistence-codec.ts` from 328 lines to 49 and removed
`persistedOrDefault` entirely.

**Also lands the hard-cutover runbook.** Product decision 14 forbids compatibility shims, and slice 2's
risk note already says a reused local Postgres must be dropped because queued `GroupSnapshot`s are
re-validated with exact-key strictness on decode. That is a deployment property, not just a local
inconvenience, and it needs writing down rather than discovering: record how it was verified that no
running deployment requires compatibility, and specify the ordering — stop, drain the queues, reset or
drop, deploy both servers (api-v1 and relic-hunter-server-v1), then browsers — together with the
rollback path if a decode fails after the fact. Two servers read these rows; the runbook covers both.

**Gates:** the plan-completion set — `test:unit`, `test:ci`, `build`, the **Branch Release Gate** on the
final feature-branch commit, and **Run Hetzner Supported Distributed Manifests** on the resulting
default-branch commit.

## Gate assignment

Every delivery PR carries the baseline: `format:check`,
`check:repo-style:changed -- origin/main HEAD`, `typecheck`, `typecheck:tests`, `test:unit`,
`test:deno` and `build`. Additional gates are selected by changed behavior and ownership, not by the
later analytical labels:

| Gate                                                             | Required when                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **medium-scale** (`test:api-v1:black-box:postgres:medium-scale`) | touching `apps/api-v1/**`, `packages/shared/**`, `packages/shared-server/**` or the black-box runner; the workflow also auto-triggers this |
| **state-write** (`perf:api-v1:state-write` + comparator)         | changing any authoritative mutation path or concurrency domain, including promotion, reset, replan, trigger latch or status writes         |
| shared-web trio + `check:browser-bundles`                        | changing browser public surfaces, topology caches, dialing, reconciliation, readiness, progress or pacing                                  |
| headless bundle boundary                                         | changing any `packages/shared` browser-consumed boundary                                                                                   |
| `topology-replay`                                                | changing topology slots, keys, publication, promotion, planning gates, reset, landing, replay, hydration or reconnect convergence          |
| `formation-large`                                                | changing formation timers, debounce/maximum-wait policy, trigger latches, damping or status convergence                                    |
| **`test:rallar:full-stack:memory:live-rtc-3`**                   | changing browser dialing/routing/admission, pacing, halt, readiness or teardown behavior                                                   |
| Hetzner distributed manifests (push-to-main only)                | before the whole workstream may be marked complete                                                                                         |

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

**None block a slice.** Q1–Q11 are all settled and recorded as decisions I3–I20 above, each with the
alternative that was rejected and why. Q5 and Q8 were closed by earlier passes: the status fields do
not ride the first field edit (I4), and the `pending` name collision dissolved once the plan's
"pending layout" became the _planned_ layout, freeing `pending` to mean "a replan is queued, due at
T" — which is what it has always declared and never done.

New questions are expected as slices are scheduled; product decision 41 names which shapes are
allowed to move. When one arrives, record it here, then convert it to a numbered decision with its
alternatives the moment it is taken — that record is the only durable explanation of why the code
looks as it does.

## Validation

Per slice: focused unit matrices first, then the surface's own tests, then the recipes, then the gates
named in that slice's section. Report every command as passed, failed or skipped.

Whole-workstream acceptance is the product plan's twenty-six named scenarios, plus the three invariants
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
