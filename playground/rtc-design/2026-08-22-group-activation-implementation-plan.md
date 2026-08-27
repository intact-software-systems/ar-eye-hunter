# Group Activation — Implementation Plan (2026-08-22)

Status: **planning — re-baselined against product decisions 1–42. The product decisions are settled;
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
  repair is still owed; its shape changed. Timer-id headroom is thin: `fnv1a64` renders ≤13
  base-36 characters, so `ft-deadline-<epoch>-<hash>` sits near the 36-character cap.
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
| I24 | **The settled numeric constants**: status dwell 3 000 ms, `active ↔ degraded` hysteresis width 0.05, evidence expiry 30 000 ms, minimum layout age 1 000 ms, RTC setup timeout 15 000 ms (`compute-group-activation-condition.ts`); per-group debounce window default 500 ms (the live server value) clamped at 30 000 ms, maximum replan wait default 5 000 ms clamped at 600 000 ms, trigger delay clamp 600 000 ms (`to-normalized-group-lifecycle-policy.ts`). Pinned by the policy and status matrices so no later slice invents values under pressure.                                                                                                                                                                                            |
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

**Risk:** a value-keyed sweep damages unrelated code. Two legitimate English uses must survive in
`docs/test-structure-coupling-exceptions.md`. And the rename is a hard cutover for durable state and
open browser tabs (product decision 14 forbids the accept-both shim): a group row persisted mid-dial
as `establishing`, and a pre-rename bundle receiving a post-rename delta, both fail their validators
until the environment is reset or reloaded — nothing deployed carries such state, which is what
makes the cutover legal, and slice 14's runbook records the ordering.

**Gates:** baseline + both black-box profiles — a partial landing fails at runtime in the recipes, not
at build time. No medium-scale; no mutation semantics change. The review added the two nets the
sweep lacked: the OpenAPI `lifecycleState` enum pin in `rallar-group-public-contracts.test.ts` and
the stored-stage acceptance matrix in `validate-persisted-group-lifecycle.test.ts`.

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
  OpenAPI block and 22 recipe call sites across 10 files, once `plan` + `connect` cover it (product
  decision 34). Each `POST …/lifecycle/establish/…` becomes two calls, so the recipe edit is a rewrite,
  not a path substitution. The automatic retry leg is re-expressed as `plan` plus the connect trigger.
  **The route and OpenAPI path themselves come out in 8d, not here**, so the tree stays deployable
  throughout.
- **5e — `reset` and `start`, dark** (product decisions 35–37). **Needs:** 4a's accepted slot and
  promotion-owned fingerprint semantics. `start` is `dormant → forming` and is denied while the
  attempt series is exhausted. `reset` is one AppInbox transaction that advances the epoch, zeroes
  `formationAttemptCount`, clears `establishmentStartedAtEpochMs`, `lastFormationOutcome` and
  `Group.acceptedLayoutIdentity`, sets `transportState: 'halted'`, and tombstones both accepted and
  planned topology rows. It retains both valid fingerprints for tracing. The active planned-row
  predicate—not fingerprint deletion—controls change suppression, so the planned tombstone guarantees
  unchanged membership can rebuild after `start`.

  Expiry is unavailable because `RtcTopologySnapshotRepository` rejects expiring snapshots, and lazy
  hard delete would destroy trace evidence. Physical delete and follow-up cleanup are rejected because
  they weaken atomicity and leave a window where hydration or change suppression can observe a
  half-reset group. Reset's tests inject failure at each write and prove group facts, both tombstones,
  event, receipt, result and outbox either all commit or all roll back.

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

**Gates:** baseline, both profiles, **medium-scale**, **state-write**, `topology-replay`.

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

## Slice 9 — In-flight pacing

Three prerequisites are missing: (1) `ensurePeerConnectionStarted` returns a right value whether or not
it decided to connect, so the attempt counter already counts idempotent ensures; (2) there is **no
success callback** — the peer lifecycle callback has `onCreated`/`onDeleted`/`onConnectTimeout?`/
`onConnectExhausted?` and nothing for established; (3) there is **no wire path for the bound** —
`GroupSnapshot` carries no policy (**Q2**).

A fourth structural gap: the reconcile pass flattens all groups into one desired-peer set, so there is
no per-group loop for a per-group bound. **Product decision 18 answers the ownership question, and the answer is a rule rather than a
negotiation**: a peer two groups both want is one connection charged to each group's in-flight count,
and it is admitted only when **every** owning group has a free slot — so it waits while either is at
its bound, even if the other is idle. Put that consequence in the pacing matrix. "No cross-group
arbitration is promised" describes the absence of negotiation, not the absence of a scheduling
decision, and an earlier draft leaned on it as though it removed one.

- **9a — truthful RTC lifecycle signals** (surface attempt-started, add an established callback). Dark,
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
