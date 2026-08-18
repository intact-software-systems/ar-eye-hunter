# Slice 2b Handoff (2026-08-17)

Pick up here. Everything below is verified, not remembered.

## State

- **`main` is green.** Last merge was #264, the one-line `runId` fix that restored the
  `api-v1-black-box-cluster` profile to 6/6 and cleared the Medium-Scale and Release gates.
- **Branch `codex/group-lifecycle-state-field`** holds slice 2b-i as two WIP commits. **Unpushed, no
  PR, not mergeable.** Nothing else is in flight.
- Landed before it: #250 (cache expiry), #252/#254/#255/#256 (Vivaldi), #258 (policy contract +
  planning docs), #260 (policy store), #263 (create-path wiring), #264.

## What 2b-i has done

`lifecycleState` is a **required** field on `Group` (owner decision — see below):

- on `GroupBase` in `packages/shared/api/group-types.ts`
- registered in four exact-key registries: `validate-persisted-group.ts`,
  `group-state-persistence-codec.ts` (with `persistedOrDefault(…, 'active')` at the decode
  boundary), `authoritative-state-validation.ts`, `group-state-delta.ts`
- initial value derived from the policy in `createInitialGroup`: `'forming'` when
  `formation === 'phased'`, else `'active'`
- the seven `packages/shared-rtc-bench` construction sites `tsc` flagged

`npm run typecheck` is clean.

## What is left, and the trap in it

**162 failures across 41 files, all one shape:** something builds a group without `lifecycleState`.
68 test files construct `Group` literals and there is no shared builder.

**Do not blanket-patch on `purgeAfterEpochMs`.** It is the obvious anchor and it is wrong: the same
field appears in requests and commands, where adding `lifecycleState` would trip the exact-key
validators in the other direction. A correct patch discriminates on a Group-only field —
`rosterVersion` or `ownerPrincipalId` — being present in the same literal.

**`tsc` staying clean is a signal, not reassurance.** These literals are not typed as `Group`, so the
compiler never sees them; only the runtime validators do. Do not read a green typecheck as meaning
the construction sites are handled.

## Recommended approach

Introduce `createTestGroup(overrides)` in the shared test fixtures, **typed as `Group`**, and migrate
the 68 sites to it as the fix. Same work as blind-patching, but:

- the compiler enforces future aggregate fields instead of runtime validators catching them late
- the next aggregate change is one edit rather than 68

`lifecycleState` is the first of several lifecycle fields, so this pays for itself inside this
workstream.

## Finding registries

`grep -rln "'purgeAfterEpochMs'" packages/shared-server packages/shared --include="*.ts"` lists all
six exact-key registries in one shot. Doing this **first** is what took the failure count from 174/57
to 162/41 in one step, after two rounds of chasing individual test failures had barely moved it.
This aggregate enforces its shape in more places than any one of them advertises.

## Then

- **2b-ii** — the three AppInbox transition commands (`start-establishment`, `activate`,
  `reopen-establishment`) with an authorization predicate over (principal, role, policy, current
  state), plus the activation epoch. This is where the design content is. Expect four key registries
  per new command, as slice 2a found.
- **2c** — FORMING gates topology planning. The behaviour change, and Phase 5's M7.

## Open decisions

1. **Corrupt policy semantics — settle before slice 5.** `GroupLifecyclePolicyRepository.readPolicy`
   deliberately reports `absent` / `present` / `corrupt` as three outcomes so the enforcement point
   decides. Slice 5 is the first enforcement point. A corrupt policy on a `closed` group must not
   read as open.
2. **Pending-admission representation** for `manager-approval`: extend invites, or a dedicated
   pending-membership state. Extending invites is the lower-coupling default.
3. **Rank source** for `elected-by-rank`. Application-supplied member metadata is the least coupled.

## Governing decisions already made

- `lifecycleState` is **required**; both databases are wipeable, so no aggregate change needs a
  backfill or a tolerated-absent phase. Recorded in project memory as
  `group-lifecycle-state-required`.
- Placement is split: the policy document is its own scoped document, the lifecycle enum and
  activation epoch sit on the aggregate.
- `RECONFIGURING` is a distinct intent state. No terminal `FAILED`. Full policy vocabulary.
  `strictConfirmation` accepted as a field, rejected when true.
- The activation criterion carries **two** rates — `successRate` and `minimumViableRate`. This
  subsumed and removed `onDeadline`.

The plan is `2026-08-17-group-lifecycle-control-plane-implementation-plan.md`; the posture evidence
is `2026-08-17-phase5-establishment-posture-decision.md`. Both are in this directory.

## Caveat on the prior session's reporting

Two things were reported as verified where the check did not cover what the wording implied: a
black-box recipe "passing its validation gates" (structure only — it had never been executed, and it
failed in CI), and a 65-file estimate from a grep rather than from the compiler (`tsc` found 7).
Weight status claims from that session accordingly.
