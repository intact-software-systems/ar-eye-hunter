# Rallar Architecture Quality And RTC Program Roadmap

> **For agents:** This is the live cross-program coordination record. Use the
> concern-specific plan for implementation. Only the current roadmap coordinator
> edits this file. Track agents report evidence and update their own child plans.

**Started:** 2026-08-06

**Status:** Phase 0 `verified`; Phase 1 remains `in-progress`. Human auth PR A
and PR B are externally `verified`; Ontology Task 1 is published and verified;
RTC foundation, B01, B02, and B03 are published; PR #196 published and merged
the three-layer benchmark-organization stack before B04; and exact-blob human
approval activates Task 4A only. Task 4A implementation is in progress on its
separate branch. Task 4B, B04, baseline capture, and Phase 2 remain inactive.

**Human owner:** Product/technical owner

**Current roadmap coordinator:** The active primary agent for this roadmap task

**Last reconciliation:** 2026-08-12 on
`codex/shared-rtc-bench-task-4a`, after fetching and starting from exact current
`origin/main` `55d7f44c24d0345798a5b2c1dc7ffa0d2b5269af`. That commit is PR #196's
merge and passed resulting-main run 31597501992. Compatibility review against
the prior handoff found no material effect on the exact package inventory,
frozen RTC contracts, ontology Task 4 reservation, or organization sequence.

**Stable design:**
[Rallar architecture quality and RTC program design](../docs/superpowers/specs/2026-08-06-rallar-architecture-quality-and-rtc-program-design.md)

## 1. Goal And Boundaries

Coordinate three independently executable programs:

1. [human-traceability refactoring](repo-human-traceability-refactoring-program-plan.md);
2. [ontology implementation](../docs/superpowers/plans/2026-08-05-rallar-ontologies-implementation-plan.md);
3. RTC performance measurement and optimization.

This roadmap owns order, cross-program gates, reservations, and handoffs. It
does not authorize source changes, replace a child plan, or duplicate task
details from the authoritative plans.

Global constraints:

- Human understandability governs design after correctness, safety, security,
  compatibility, and required performance.
- No ontology task may change runtime routing, validation, packets, authority,
  or payload size unless separate compatibility work is approved.
- No readability refactor may hide an optimization or semantic change.
- No RTC optimization begins without a reproducible baseline and focused
  correctness evidence.
- Existing public exports and import paths remain compatible unless an approved
  plan explicitly says otherwise.
- Generated profiles remain under `tmp/perf/` and are not committed unless the
  human explicitly requests it.
- Each track obeys the repository's local, publication, and remote completion
  gates on its own final unchanged tree.

## 2. Document And Agent Ownership

| Record                         | Writer                                                  | Update trigger                                                             |
| ------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| This roadmap                   | Exactly one current primary/coordinating agent          | Phase, verified milestone, blocker, reservation, or human decision changes |
| Human master/execution plans   | Human-program coordinator under their existing protocol | An authorized child changes state or its external evidence is verified     |
| Human child plan               | Agent executing that approved child                     | The child plan requires progress/evidence publication                      |
| Ontology implementation plan   | Ontology track owner under its plan                     | A task milestone or pilot/governance decision must be recorded             |
| RTC baseline/optimization plan | RTC performance track owner                             | Workload, baseline, experiment, or accepted result changes                 |
| Git/CI/performance artifacts   | Producing system or track                               | Evidence is generated; agents reference it rather than re-create it here   |

### Coordinator handoff

A replacement coordinator must first:

- read this roadmap and the three authoritative program records;
- inspect `git status`, current branch, current `HEAD`, and recent history;
- verify any claimed remote or measurement evidence that is material to the
  next transition;
- list active write reservations; and
- update the coordinator and reconciliation date below before assigning work.

Track agents must not edit this roadmap merely to report that their local work
passed. Their completion handoff supplies exact evidence to the coordinator.

## 3. State Model

| State            | Meaning                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `not-started`    | No authorized work is active.                                                                                    |
| `ready`          | Prerequisites are verified and a concern-specific plan defines the work.                                         |
| `in-progress`    | Authorized work is executing.                                                                                    |
| `local-complete` | Scoped local work and required local checks passed, but publication evidence is incomplete.                      |
| `published`      | The change is on the intended branch/default branch; required remote evidence may still be pending.              |
| `verified`       | Exact required local and every applicable branch, merge or direct-main, and default-branch evidence is recorded. |
| `blocked`        | A named prerequisite, conflict, or human decision prevents progress.                                             |
| `deferred`       | The human explicitly removed the item from the current phase.                                                    |

Only `verified` satisfies a cross-program publication gate. A plan's own state
model remains authoritative when it is more specific, such as the human
program's `ledger-published` state.

## 4. Reconciled Starting Point

| Program                    | State                                                                        | Current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Next required action                                                                                                                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human traceability         | client state `ledger-published`; auth PR A and PR B externally `verified`    | Approved auth-plan anchor `123990bceac9732660e1113101addd5b194d8347` remains supported by [PR #76's closure record](https://github.com/intact-software-systems/ar-eye-hunter/pull/76#issuecomment-5205571315). [PR #78](https://github.com/intact-software-systems/ar-eye-hunter/pull/78) published PR A and merged as `a90042398448776b0972aaaaa0f5cca762163fde`; its exact branch/default evidence remains in the [PR #78 closure handoff](https://github.com/intact-software-systems/ar-eye-hunter/pull/78#issuecomment-5215094789). [PR #81](https://github.com/intact-software-systems/ar-eye-hunter/pull/81) then published PR B feature `1f7d7b0682c93c7c831fc2a31c0f635829d50734`, tree `2a5d756b83f44b6b8bbae166e8571f761371af29`; [Branch Release Gate 31185044360](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31185044360), attempt 1, job `92887353726`, succeeded. It merged as `8152de39faf2d630158143366596d61346e20457`, tree `2a5d756b83f44b6b8bbae166e8571f761371af29`; [Run Hetzner Supported Distributed Manifests 31187663870](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31187663870), attempt 1, succeeded with jobs `92896224485`, `92896279297`, `92896661802`, `92897074068`, `92897537193`, `92897911043`, and `92898310196`. Auth-plan blob `262fa38044a382f58c7cf1fa34a755159a9c9272` still predicts pending PR B publication in Task 5/progress, so the human-program owner retains that read-only reconciliation duty. | Human-program owner reconciles its authoritative plan/progress with verified PR B closure. PR C remains inactive. The stable auth-tree prerequisite for later RTC-B06 is satisfied, but B06 remains held behind its own separate approval, reservation, publication, and capture gates. |
| Ontology                   | Task 1 `verified`                                                            | [PR #89](https://github.com/intact-software-systems/ar-eye-hunter/pull/89) published the exact 17-path Task 1 candidate at `ff9e77405b4986836272a3c48dc0659241ff5d83`, tree `07d58cd0936406f6ab632b6d219431fadc2605e0`; Branch Release Gate 31214805578 attempt 1/job `92985722492` succeeded. It merged as `f7ea9b2f4b3277f7f5ae72e7f490812c8058bb41`, tree `e5b7eb5a40ad0f6fff50c1afb4ae1583cbd7dd23`; resulting-main run 31242891941 attempt 1 and all seven jobs succeeded. The approved plan blob remains `7e142365f9b18f59966aa440cb5b9cdd228935b0`; the old `d68d511...` prototype remains untouched historical input.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Preserve Task 1 publication. Tasks 2-11, runtime activation, and generated artifacts remain held.                                                                                                                                                                                       |
| RTC performance            | foundation-B03 `verified`; Task 4A draft published; Task 4B/B04/capture held | Foundation PR #150, B01 PR #162, B02 PR #169, and B03 PR #193 are merged. PR #196 merged as `55d7f44c24d0345798a5b2c1dc7ffa0d2b5269af`; resulting-main run 31597501992 succeeded. The human approved exact plan blob `b78e00e982d186264bc5ba6b4b2a943f15a328f3` and explicitly authorized Task 4A. Draft PR #198 publishes its exact Section 10 relocation from `codex/shared-rtc-bench-task-4a`; correction and exact-head publication gates remain pending. No benchmark was captured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Require corrected exact-head Branch Release Gate success, human review, merge, and resulting-main workflow evidence for Task 4A. Keep Task 4B, B04, capture, B06, B07, production, optimization, raw artifacts, and Phase 2 held.                                                       |
| Cross-program coordination | Phase 0 `verified`; Phase 1 `in-progress`                                    | Phase 0 remains anchored by PR #77; historical RTC activation revisions remain publication evidence. Current `origin/main` and the fresh Task 4A base are `55d7f44c24d0345798a5b2c1dc7ffa0d2b5269af`. Compatibility review found no material conflict with package ownership, frozen RTC contracts, or ontology Task 4's shared-web reservation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Publish only the exact Task 4A parity layer in its separate draft PR and record its exact commit/tree/workflow evidence.                                                                                                                                                                |

The roadmap records externally observed human-program state but does not edit or
advance its plans. Both concern plans and the ontology activation are published
on `main`. The historical RTC approval/activation record exists and produced
the published foundation through B03 milestones. This revision proposes a new
organization plan/reservation only; it activates no source move or later RTC
task.

## 5. Work Routing And Reservations

### Default path ownership

| Track                     | Independent write set                                                                                                                                                                                                                                                         | Must coordinate before touching                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Coordination              | This design and this roadmap                                                                                                                                                                                                                                                  | Any concern-specific implementation plan                                                                                |
| Human traceability        | Paths named by its explicitly activated approved child                                                                                                                                                                                                                        | Ontology sources/bindings, RTC benchmark scripts, or another human child                                                |
| Ontology foundation/pilot | `packages/shared/ontology/**`, named ontology tests, generated ontology docs/artifacts                                                                                                                                                                                        | Root scripts, barrels, public snapshots, or production files owned by active human/RTC work                             |
| RTC baseline              | Current published tooling remains at the authoritative plan's verified historical paths. If separately approved/activated, Task 4A owns the exact Section 10 reservation that moves it to private `packages/shared-rtc-bench/**`; ignored `tmp/perf/**` output remains local. | Production RTC/realtime sources, ontology implementation/bindings, or any path outside the exact activated reservation. |

### Serialized integration paths

One agent at a time owns:

- `packages/shared/ontology/mod.ts`;
- ontology aggregate generators, artifacts, reports, and aggregate tests;
- package barrels/public export snapshots;
- root `package.json` and shared checker scripts; and
- any production RTC/realtime path that appears in both an active readability
  child and an RTC experiment.

The coordinator records a temporary reservation here before parallel work
starts:

| Reservation            | Owner                                                                               | State                                                   | Release condition / hold                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordination documents | Roadmap coordinator on `codex/phase-1-rtc-protocol-roadmap-activation`              | active                                                  | Release after the Phase 1 exit envelope and external evidence are recorded.                                                                                                                                                                                                                                                                                                                                     |
| Ontology Task 1 paths  | `/root/ontology_task1_phase1` on `codex/rallar-ontology-foundation`                 | published; reservation released                         | Exact published plan blob `7e142365f9b18f59966aa440cb5b9cdd228935b0`; PR #89 verified the exact 17 paths. Tasks 2-11, runtime activation, generated artifacts, and every unlisted path remain held.                                                                                                                                                                                                             |
| RTC Phase 1 B01-B05    | `/root/rtc_b01_b05_phase1_owner` on `codex/rallar-rtc-performance-baseline-phase-1` | activation recorded; effective when this revision lands | Exact published plan blob `d977a6495cffee240d7484a7f238533afc5feacf`; approval comment `5237125583` is verified. Reserve only the unchanged exact 59-path Section 10 B01-B05 set below after this revision reaches `main`. Until then implementation and capture remain inactive. README/PR #40, B06, B07, production, optimization, raw-artifact publication, human-plan edits, PR C, and Phase 2 remain held. |
| Human auth program     | Human-program owner; read-only to this coordinator                                  | PR A and PR B externally verified                       | PR #81 merged as `8152de39faf2d630158143366596d61346e20457`, tree `2a5d756b83f44b6b8bbae166e8571f761371af29`; the human-program owner still owns reconciliation of its stale authoritative progress record. PR C remains inactive. The stable-auth-tree prerequisite is satisfied, but service-backed B06 remains separately held.                                                                              |

Ontology Task 1 is published and verified. RTC instrumentation and capture have
not resumed and remain inactive until this exact roadmap revision is published
on `main`.
Verified human work is external evidence, not a coordinator reservation.

### Phase 1 structural decision envelope — plans approved; track activations recorded

At draft PR #79 head `1dba71d7b2bebaa2738b7e36a6f8fb510fee3f71`,
the human approved only the plan-publication amendment envelope below. The two
concern owners then published and branch-gated their plan-only candidates. The
ontology blob received an exact approval comment. The human later merged both
plan PRs and instructed the coordinator to continue without waiting for the
plan-only resulting-main build. Both resulting workflows subsequently succeeded.
The no-wait instruction changed only that build wait. PR #91 published the
one-path CLI-boundary amendment, [PR #96](https://github.com/intact-software-systems/ar-eye-hunter/pull/96)
published the nine-path Task 1 split, and [PR #109](https://github.com/intact-software-systems/ar-eye-hunter/pull/109)
published the thirteen-path split. [PR #111](https://github.com/intact-software-systems/ar-eye-hunter/pull/111)
published that superseded thirteen-path activation. [PR #117](https://github.com/intact-software-systems/ar-eye-hunter/pull/117)
published the superseded sixteen-path Task 1 split. [PR #126](https://github.com/intact-software-systems/ar-eye-hunter/pull/126)
published the superseded twenty-five-path Task 1 split. [PR #130](https://github.com/intact-software-systems/ar-eye-hunter/pull/130)
published the exact thirty-nine-path Task 1 split, and [PR #147](https://github.com/intact-software-systems/ar-eye-hunter/pull/147)
published its controller-protocol correction without changing that split or its
reservation. [RTC Task 0 approval comment
5237125583](https://github.com/intact-software-systems/ar-eye-hunter/pull/147#issuecomment-5237125583)
is an OWNER-authored GitHub User record naming current plan blob
`d977a6495cffee240d7484a7f238533afc5feacf`. PR #79 published the ontology
activation; PR #89 completed Ontology Task 1; and this revision separately
records the thirty-nine-path RTC B01-B05 activation, effective only when this
revision reaches `main`.

#### Published plan evidence

- Ontology PR #80: feature commit
  `9f3ba079205f4f6581193cbd27a2e33d3442d062`, tree
  `aad315c7626245ab7e1b24d4687456858422aad9`, plan blob
  `7e142365f9b18f59966aa440cb5b9cdd228935b0`; independent content review and
  full local gates passed; Branch Release Gate 31171494388, attempt 1, job
  `92844080043`, succeeded on the exact commit. [PR #80 comment
  5218917814](https://github.com/intact-software-systems/ar-eye-hunter/pull/80#issuecomment-5218917814)
  records human approval of that exact blob. It merged as
  `978e05c4f0d654ddd425952b97533d42ca5b488a`, tree
  `123043f4173683288c462ca03a41deaebff63ba9`; resulting-main run 31201689431,
  attempt 1, succeeded.
- RTC PR #82: feature commit
  `2bda07ed576e00687f0d4380482c908f231b3b36`, tree
  `697bf4f3ad5cee08af345c03dbbd5890bc668ce1`, plan blob
  `c819a3f3d939bfa5a83196455053d226509da9bb`; independent specification and
  quality review and full local gates passed; Branch Release Gate 31194886604,
  attempt 1, job `92920574211`, succeeded on the exact linear head. [PR #82
  comment 5219512616](https://github.com/intact-software-systems/ar-eye-hunter/pull/82#issuecomment-5219512616)
  records the protected-ref history repair and exact evidence. It merged as
  resulting commit `e949e670e9867124806bd352cbf132d397c7ee5a`, tree
  `b97b9f52600cd788dc7b3d84c53a432650ea16a0`, with the exact plan blob retained.
  Resulting-main run 31201721914, attempt 1, subsequently succeeded with jobs
  `92945207654`, `92945239814`, `92945606459`, `92945985211`, `92946391846`,
  `92946691885`, and `92947093952`. [Human approval comment
  5220439312](https://github.com/intact-software-systems/ar-eye-hunter/pull/82#issuecomment-5220439312)
  is an OWNER-authored GitHub User record that names this exact plan blob and
  preserves separate coordinator activation.
- RTC amendment PR #91: feature commit
  `e834c1d1c76641362401ddf9e64fea9c0d28bbcf`, tree
  `8abbac7da2bfab842f3df383b3c26178646eeb4b`, amended plan blob
  `62c2575184190671b879f5addfd81787cc381372`; independent feasibility review
  approved the single added `rtc-baseline-cli.ts` boundary. The plan-only branch
  did not trigger Branch Release Gate because that push workflow ignores
  `docs/superpowers/plans/**`; local build, format, diff, and style checks passed,
  while unit/CI reproduced two unrelated auth ratchets already present on its
  exact main base. It merged as
  `e9325cf50d6c47860cc1e173a91755d9cb47b68a`, tree
  `8abbac7da2bfab842f3df383b3c26178646eeb4b`; resulting-main run 31246356732
  attempt 1 failed only RTC smoke job `93075898725` with two RTC readiness
  timeouts on the unchanged runtime tree. Failed-job retry attempt 2 succeeded
  as exact RTC smoke job `93076590106` on the same commit. [Human approval comment
  5225152426](https://github.com/intact-software-systems/ar-eye-hunter/pull/91#issuecomment-5225152426)
  is an OWNER-authored GitHub User record naming the amended exact blob and
  preserving separate coordinator activation.
- RTC nine-path amendment PR #96: feature commit
  `a41c8bb6cc6552a50ab108df9140832f0d701842`, tree
  `7f551f4db2086ed6df3ce0a39012cd301654c2a7`, amended plan blob
  `b805375aaa4f99eaec7f085b2dc1782d2e67ceeb`; independent feasibility review
  approved the added statistics, evidence-store, and CLI-test owners, and the
  exact full local plan gates passed. It merged as
  `32a325d4ab0f5597e44041c59db627fa84d18bfb`, tree
  `d4e902dd8f9ab0e8ff2115ac1459a2cb398938ca`, with the plan blob retained.
  Resulting-main run 31259052021 attempt 1 succeeded on that exact commit.
  [Human approval comment 5226263796](https://github.com/intact-software-systems/ar-eye-hunter/pull/96#issuecomment-5226263796)
  is an OWNER-authored GitHub User record naming this exact blob and preserving
  separate coordinator activation.
- RTC thirteen-path amendment PR #109: feature commit
  `e490682b4865309ce3a8d54f5339518052d0d7a6`, tree
  `3ac2604ef7774a45cfe42f223648a68c1e195a0d`, amended plan blob
  `585398d6835e2328d6a0f4b82fa8d01605ef6f9a`; independent feasibility review
  approved the added workload-manifest and evidence-acceptance owners plus
  their dedicated tests, and the exact full local plan gates passed. It merged
  as `05cec262b838fb661dcb923152991ce88a28ceac`, tree
  `5816137f7587cc581c405680994b1ecf62ef875b`, with the plan blob retained.
  Resulting-main run 31271274737 attempt 1 succeeded on that exact commit.
  [Human approval comment
  5227422413](https://github.com/intact-software-systems/ar-eye-hunter/pull/109#issuecomment-5227422413)
  is an OWNER-authored GitHub User record naming this exact blob and preserving
  separate coordinator activation.
- RTC thirteen-path activation PR #111: feature commit
  `918d65abf1fddba2101f04bd1fdeb5fa599b8058`, tree
  `e0672f99a0ea7d7cf7f85d985eb6b42deea49c75`, roadmap blob
  `d21f5d68d3f2cb4187a4df0a0a793d1bcbe26c5c`, merged as
  `fdb53f836f7e1fae7b416161a0dbff8d98f91760` with the same tree and blob.
  Resulting-main run 31273181674 attempt 1 succeeded with jobs `93142469059`,
  `93142482831`, `93142623492`, `93142772119`, `93142930549`, `93143104441`,
  and `93143227126`. This activation is superseded only by the new exact plan
  blob; it remains historical publication evidence.
- RTC sixteen-path amendment PR #117: feature commit
  `84548e2470318f05cd775e37ba788633502a7ebf`, tree
  `574dd5a621f76d6a3c926a331bc2c5847dfde6c4`, amended plan blob
  `85858aca6c85e54e48e71aaa6e3b6975d1f851e3`; independent feasibility review
  approved the added Deno runtime owner, its direct runtime test, and the direct
  evidence-acceptance test, and every final local plan gate passed. It merged as
  `b35de676d5764406d661e802ecb4bf46b285e660`, tree
  `574dd5a621f76d6a3c926a331bc2c5847dfde6c4`, with the exact plan blob retained.
  Resulting-main run 31295299260 attempt 1 succeeded with jobs `93199305724`,
  `93199319282`, `93199443601`, `93199556015`, `93199654700`, `93199762848`,
  and `93199913722`. [Human approval comment
  5230123447](https://github.com/intact-software-systems/ar-eye-hunter/pull/117#issuecomment-5230123447)
  is an OWNER-authored GitHub User record naming this exact blob and preserving
  separate coordinator activation.
- RTC twenty-five-path amendment PR #126: feature commit
  `38b2e10452c2fb0bf18d93508a20f7548cf4d65b`, tree
  `5e384bfd26a295637c37ae4e7f18fb8b75a89c12`, amended plan blob
  `e97cdd255a015198a178a97fee442d36ce8f33af`; independent feasibility review
  approved the six added source owners, three added direct tests, and the frozen
  configuration/command, browser-locator, repeat-link, failure, and finalization
  boundaries. All authorized plan-only local gates passed. It merged as
  `555084e7ea1ad947132a0f8cc06ad9fdc6631a6b`, tree
  `5e384bfd26a295637c37ae4e7f18fb8b75a89c12`, with the exact plan blob retained.
  Resulting-main run 31309299549 attempt 1 succeeded on that exact commit with
  jobs `93234509430`, `93234525994`, `93234676877`, `93234818954`,
  `93234918853`, `93235065769`, and `93235217935` all successful. [Human approval comment
  5231118287](https://github.com/intact-software-systems/ar-eye-hunter/pull/126#issuecomment-5231118287)
  is an OWNER-authored GitHub User record naming this exact blob and preserving
  separate coordinator activation. Its exact API path is
  `/repos/intact-software-systems/ar-eye-hunter/issues/comments/5231118287`, and
  its exact body is
  `Human approval: RTC B01-B05 plan blob e97cdd255a015198a178a97fee442d36ce8f33af; coordinator activation remains separately required.`
- RTC thirty-nine-path amendment PR #130: feature commit
  `c727d6b17e3a6a78638f6d70b13d39a2b109102a`, tree
  `eadd5eea805b17fd385208f48fad2140abf05115`, amended plan blob
  `9d9393c2e671f21467e7b7d1fce5050053541d75`; independent feasibility review
  approved the six added source owners, eight added direct tests, and the
  corrected ownership split that keeps every Task 1 file within its reviewed
  boundary and physical-line budget. All authorized plan-only local gates
  passed. It merged as `661e497597587e3803c0760a90b0a124df8af075`, tree
  `dfc45f287ecfd39b10acb399c42d7a6214f5353f`, with the exact plan blob
  retained. [Resulting-main run 31316480108](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31316480108),
  attempt 1, completed successfully at `2026-08-09T14:10:39Z` on that exact
  merge commit with jobs `93254667294`, `93254685331`, `93254834256`,
  `93254974961`, `93255128683`, `93255301860`, and `93255486019` all
  successful; it is recorded separately from activation. [Human approval comment
  5231825686](https://github.com/intact-software-systems/ar-eye-hunter/pull/130#issuecomment-5231825686)
  is an OWNER-authored GitHub User record naming this exact blob and preserving
  separate coordinator activation. Its exact API path is
  `/repos/intact-software-systems/ar-eye-hunter/issues/comments/5231825686`, and
  its exact body is
  `Human approval: RTC B01-B05 plan blob 9d9393c2e671f21467e7b7d1fce5050053541d75; coordinator activation remains separately required.`
- RTC protocol-correction PR #147: feature commit
  `3d0c91db7d934e80b0409c115c5c4d2c7bd1b7c4`, tree
  `7d869b5a6ca6cd1e473b612f1a2f3892b65f5d4c`, corrected plan blob
  `d977a6495cffee240d7484a7f238533afc5feacf`; it freezes the later executable
  recipe as canonical: one baseline owns an ordered workload list, the CLI uses
  `--workloads`, `--producer-exit-status`, and `--raw-result`, and external
  attempts emit exactly four TSV columns. It changes no workload, evidence rule,
  hold, or reserved path. It merged as
  `cd843d154c5698912eb99a92039ecd31464aef0f`, tree
  `7d869b5a6ca6cd1e473b612f1a2f3892b65f5d4c`, with the exact plan blob retained.
  [Resulting-main run 31365680140](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31365680140),
  attempt 1, completed successfully at `2026-08-10T07:33:40Z` on that exact
  merge commit with jobs `93383420770`, `93383478739`, `93383791691`,
  `93384081554`, `93384374387`, `93384711142`, and `93385105464` all
  successful; it is recorded separately from activation. [Human approval comment
  5237125583](https://github.com/intact-software-systems/ar-eye-hunter/pull/147#issuecomment-5237125583)
  is an OWNER-authored GitHub User record naming this exact blob and preserving
  separate coordinator activation. Its exact API path is
  `/repos/intact-software-systems/ar-eye-hunter/issues/comments/5237125583`, and
  its exact body is
  `Human approval: RTC B01-B05 plan blob d977a6495cffee240d7484a7f238533afc5feacf; coordinator activation remains separately required.`

#### Resolved RTC candidate coordination discrepancy

Superseded RTC blob `63f24b125ec28d84087045880d78098317afd32b`
incorrectly froze a live-status assertion that PR B/C remained inactive. It and
Branch Release Gate 31178434885 remain historical review evidence only and do
not approve or activate the corrected candidate. Blob
`c819a3f3d939bfa5a83196455053d226509da9bb` corrected that coordination status
and is retained as the pre-amendment design anchor. Blob
`62c2575184190671b879f5addfd81787cc381372` added the Deno CLI/composition
boundary. Blob `b805375aaa4f99eaec7f085b2dc1782d2e67ceeb` added the coherent
statistics and evidence-store owners plus the dedicated CLI test. Blob
`585398d6835e2328d6a0f4b82fa8d01605ef6f9a` added the workload-manifest and
evidence-acceptance owners plus their dedicated tests. Blob
`85858aca6c85e54e48e71aaa6e3b6975d1f851e3` added the real Deno runtime owner,
its direct runtime test, and the direct evidence-acceptance test to preserve
complete runtime composition, acceptance, failure, finalization,
semantic-coverage, and physical-line responsibilities. Blob
`e97cdd255a015198a178a97fee442d36ce8f33af` added safe decoding, evidence layout,
failure accounting, finalized evidence, runtime observation, and CLI grammar
owners plus direct validation, evidence-failure, and finalization tests. It
freezes the configuration/command protocol, complete browser locator, and exact
primary-summary repeat link while preserving workloads and later holds. Blob
`9d9393c2e671f21467e7b7d1fce5050053541d75` adds artifact decoding,
workload-catalog, artifact-validation, finalized-reader, Deno-adapters, and
CLI-options owners plus eight direct tests so each responsibility remains
coherent under the hard physical-line limit, while preserving workloads,
evidence rules, and later holds. Current blob
`d977a6495cffee240d7484a7f238533afc5feacf` resolves only the controller-protocol
contradictions by making the later executable recipe canonical; it preserves
the same thirty-nine-path Task 1 split, 59-path reservation, workloads, evidence
rules, and later holds. The rejected twenty-five-path WIP is design
input only and supplies no inherited test, gate, completion, capture, or
benchmark evidence. The RTC
plan cannot activate or deactivate human-program work; this roadmap owns live
status, and service-backed B06
serializes with any externally active auth child until its stable exact tree.
Section 4 records PR B's verified merge. Its stable-tree prerequisite is
satisfied. The amended B01-B05 exact-blob approval record exists, and this
revision is the separate coordinator activation record, effective only after
publication on `main`. B06 remains inactive behind its own reservation,
publication, correctness, and capture gates.

#### Exact Ontology Task 1 reservation — published and verified

Ontology Task 1 exact 17-path reservation for plan blob 7e142365f9b18f59966aa440cb5b9cdd228935b0 produced verified PR #89; Tasks 2-11, runtime activation, generated artifacts, and Phase 2 remain held.

- `packages/shared/ontology/rallar-ontology-contracts.ts`
- `packages/shared/ontology/rallar-domain-ontology-term.ts`
- `packages/shared/ontology/rallar-realtime-ontology-contracts.ts`
- `packages/shared/ontology/rallar-ontology-registry-contracts.ts`
- `packages/shared/ontology/rallar-ontology-identity-validation.ts`
- `packages/shared/ontology/validate-rallar-ontology-vocabulary-module.ts`
- `packages/shared/ontology/validate-rallar-ontology-binding-module.ts`
- `packages/shared/ontology/validate-rallar-ontology-catalog.ts`
- `packages/shared/ontology/rallar-ontology-registry.ts`
- `packages/shared/ontology/mod.ts`
- `packages/tests/shared/rallar-ontology-test-fixtures.ts`
- `packages/tests/shared/rallar-ontology-registry.test.ts`
- `packages/tests/shared/rallar-ontology-vocabulary-validation.test.ts`
- `packages/tests/shared/rallar-ontology-binding-validation.test.ts`
- `packages/tests/shared/rallar-ontology-catalog-validation.test.ts`
- `scripts/repo-style-check/layout-rules.mjs`
- `packages/tests/repo/repo-style-layout-rules.test.ts`

The amendment must keep the public Task 1 API/behavior unchanged, keep every
new Task 1 source/test at or below 400 physical lines, and add only
`packages/shared/ontology/mod.ts` to the existing exact compatibility-boundary
allowlist with its semantic checker test. It may not change checker rule IDs,
thresholds, suppressions, another compatibility boundary, package barrels,
runtime imports, packets, payloads, authority, routing, validation, generated
artifacts, or Tasks 2-11.

#### Historical exact RTC B01-B05 reservation — foundation through B03 published

RTC Phase 1 B01-B05 exact Section 10 reservation for plan blob
`d977a6495cffee240d7484a7f238533afc5feacf` was activated and remains the
historical authority for the published foundation/B01/B02/B03 work. B04 did not
start. PR #196 superseded its path layout before B04, and exact plan-blob
approval now grants only the Task 4A write authority recorded below.

The exact reservation includes
`docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md` for
its durable progress entry, ignored `tmp/perf/rtc-baseline/**`, and exactly 59
implementation paths grouped as follows.

The 24 feature-folder TypeScript files are:

- `scripts/perf/rtc-baseline/rtc-baseline-contracts.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-decoding.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-validation.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-statistics.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-envelope.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts`
- `scripts/perf/rtc-baseline/rtc-baseline-cli.ts`
- `scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts`
- `scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts`
- `scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts`

The 18 repository tests are:

- `packages/tests/repo/rtc-performance-baseline-contract.test.ts`
- `packages/tests/repo/rtc-performance-baseline-decoding.test.ts`
- `packages/tests/repo/rtc-performance-baseline-validation.test.ts`
- `packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts`
- `packages/tests/repo/rtc-performance-baseline-statistics.test.ts`
- `packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts`
- `packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts`
- `packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts`
- `packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts`
- `packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts`
- `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`
- `packages/tests/repo/rtc-performance-baseline-envelope.test.ts`
- `packages/tests/repo/rtc-performance-baseline-finalization.test.ts`
- `packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts`
- `packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts`
- `packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts`
- `packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts`
- `packages/tests/repo/rtc-performance-baseline-cli.test.ts`

The 16 accepted existing TypeScript harnesses receive only the
measurement-only bounded-input, artifact-normalization, and correctness changes
authorized by the plan:

- `scripts/perf/rtc-peer-connection-diagnostics-burst.ts`
- `scripts/perf/rtc-ice-candidate-queue-bench.ts`
- `scripts/perf/rtc-peer-listener-cleanup-bench.ts`
- `scripts/perf/rtc-data-channel-replace-key-bench.ts`
- `scripts/perf/rtc-data-channel-close-retention-bench.ts`
- `scripts/perf/rtc-data-channel-error-reference-bench.ts`
- `scripts/perf/rtc-topology-star-bench.ts`
- `scripts/perf/rtc-topology-tree-no-rtt-bench.ts`
- `scripts/perf/rtc-topology-mesh-no-rtt-bench.ts`
- `scripts/perf/rtc-room-graph-rtt-bench.ts`
- `scripts/perf/rtc-topology-inactive-churn-bench.ts`
- `scripts/perf/rtc-multicast-serialization-bench.ts`
- `scripts/perf/webrtc-group-cache-fallback-bench.ts`
- `scripts/perf/webrtc-group-manager-state-bench.ts`
- `scripts/perf/webrtc-group-manager-peer-owners-bench.ts`
- `scripts/perf/webrtc-heartbeat-callback-churn-bench.ts`

The one Node browser-soak entrypoint is
`scripts/perf/rtc-data-channel-browser-soak.mjs`, limited to the plan's
measurement-only bounded inputs, per-iteration open/close durations, and
create-new raw browser evidence consumed by the shared accepted-envelope
bridge. The plan itself is the separate durable progress record and is not part
of the 59-path implementation count.

The foundation Deno gate names the 21 foundation source files, and later gates
carry the authorized B01-B05 slice files plus the 16 accepted existing
TypeScript harnesses exactly; they do not pull in or repair the three
unreserved historical probes. Publish one RTC branch/draft PR as ordered
foundation, B01, B02, B03, B04, and B05 commits. Its final unchanged, fully
gated head is the B01-B05 measurement anchor.

The revised plan must also retain the reviewed evidence contract: JSON-safe
round trips; live clean-Git, source, configuration, and redacted-command
reconciliation; baseline-ID path confinement and exclusive writes; retained
failure artifacts followed by nonzero exit; exact workload inputs and complete
sample-set accounting; and the reviewed B01-B04 correctness invariants.
Existing README commands remain supported as confined, non-overwriting
diagnostic runs that cannot emit accepted baseline evidence; accepted capture
requires the complete environment/sample/output envelope.

The later B06 reservation remains inactive and is limited to:

- `tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts`
- `packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts`
- `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts`
- `packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts`

No B06 style exception is proposed: the current human-readability standard
supersedes the historical blanket line rule. B06 receives its own later clean measurement head and
fresh gates. Before selecting a candidate using both heads, rerun the relevant
B01-B05 workload on the B06 head. The proposed Task 4A reservation updates
`scripts/perf/README.md` only to cross-navigate to the package; the existing B06
coverage test remains untouched absent a separately
approved coverage-semantic change. Human-plan edits and PR C remain owned by
the human-program track and held here; B07, production, optimization, raw
artifact publication, and Phase 2 remain held by the standalone activation
line above.

#### Activated shared RTC benchmark organization reservation — Task 4A only

[PR #196](https://github.com/intact-software-systems/ar-eye-hunter/pull/196)
published the authoritative RTC plan blob
`b78e00e982d186264bc5ba6b4b2a943f15a328f3` and merged as
`55d7f44c24d0345798a5b2c1dc7ffa0d2b5269af`. Resulting-main **Run Hetzner
Supported Distributed Manifests** run 31597501992 succeeded on that exact
commit. The human then named that exact blob and explicitly authorized starting
Task 4A. This record activates Task 4A only.

The review stack is exactly:

1. PR #196: design, in-place authoritative plan amendment, and pending
   coordination records only;
2. Task 4A follow-on PR: package relocation, repository integration, and
   semantic parity only; and
3. Task 4B follow-on PR: complete executable trace, structural remediation,
   combined-test separation, legacy dispositions, and independent re-review.

The active Task 4A reservation is exactly Section 10 of plan blob
`b78e00e982d186264bc5ba6b4b2a943f15a328f3`; the grouped record here does not
broaden it:

- create only the plan's exact inventory under
  `packages/shared-rtc-bench/**`;
- move/delete exactly the 48 RTC/WebRTC sources mapped from
  `scripts/perf/rtc-baseline/**`, the plan's exact 20 RTC/WebRTC root files, and
  the four RTC topology delivery/replay files; move the fifth topology file,
  general state-write policy `scripts/perf/rtc-topology/state-write-reasons.ts`,
  only to
  `scripts/perf/state-write/api-v1-state-write-regression-reasons.ts`;
- move exactly the 18
  `packages/tests/repo/rtc-performance-baseline-*.test.ts` owners and the exact
  delivery/replay harness tests named by the plan; keep the general state-write
  harness with its owner and change only its reason import;
- modify only `package.json`, `package-lock.json`, `tsconfig.json`,
  `vitest.config.ts`, `deno.json`, `scripts/perf/README.md`, the exact three
  state-write importers, the exact reviewed-disposition source/test, the new
  `plans/repo-style-lineages/shared-rtc-bench-task-4a.json`, this RTC plan, and
  this roadmap as external integration/progress paths; and
- write no production RTC/realtime, app, shared-test, ontology, or other package
  implementation.

Task 4B is separately limited to the exact Task 4A package inventory, its
README/tests, the three named capability tests, deletion of the combined
workload test, and plan/roadmap evidence. Any additional owner requires another
exact approved plan revision.

Ontology Task 4 independently reserves:

- `packages/shared-web/browser/rallar-browser-realtime-ontology.ts`;
- `packages/shared-web/browser/rallar-browser-realtime-ontology-bindings.ts`;
  and
- `packages/tests/shared-web/rallar-browser-realtime-ontology.test.ts`.

Task 4A/4B edit none of those paths. RTC production remains authoritative;
`shared-rtc-bench` measures it; package README/catalog metadata is navigation
and provenance, not ontology metadata. The ontology plan retains its
operationally inert, build-time binding-resolution mechanism; no second binding
or metadata system belongs in the benchmark package.

**Activation state:** Task 4A only is active on
`codex/shared-rtc-bench-task-4a`, based on exact current main
`55d7f44c24d0345798a5b2c1dc7ffa0d2b5269af`. The compatibility review found no
material path, contract, or ontology-reservation conflict. Task 4B, B04, all
capture, B06, B07, production change, optimization, and Phase 2 remain held.

## 6. Phase 0 — Establish Control And Measurement Design

**Objective:** Make the three programs independently executable and safely
interleavable before adding ontology code or optimizing RTC production paths.

### Task 0A: Publish the coordination design and roadmap

**Files:**

- `docs/superpowers/specs/2026-08-06-rallar-architecture-quality-and-rtc-program-design.md`
- `plans/rallar-architecture-quality-and-rtc-program-roadmap.md`

**Steps:**

- [x] Separate stable design from live progress state.
- [x] Define single-writer roadmap ownership and track-agent handoffs.
- [x] Define change routing, path reservations, states, and phase gates.
- [x] Reconcile local Git history through current `main`.
- [x] Run document formatting and diff checks.
- [x] Publish the original coordination draft on `main` at
      `92f3f4f3fb6ea0bbadbf006cd3483e618726f001` and verify its named
      default-branch workflow.
- [x] Obtain human review of the roadmap content.
- [x] Publish this Phase 0 reconciliation through the repository's plan-document
      process and record its external evidence outside the candidate itself.

**State:** `verified`. PR #77 merged as
`d68d5112797b2cf8332dfe0243cebbe545da89c9`; resulting-main run 31122914721,
attempt 4, succeeded. The durable closure record linked in Section 4 preserves
the exact jobs and artifacts.

### Task 0B: Reconcile existing publication envelopes

**Owner:** Roadmap coordinator or a read-only evidence agent assigned by the
coordinator.

**Steps:**

- [x] Verify ledger PR #75's feature commit/tree, Branch Release Gate, resulting
      `main` commit, and default-branch workflow.
- [x] Because all named evidence is green, record client-state as
      `ledger-published` in the appropriate coordination/evidence record.
- [x] Verify the applicable default-branch workflow for ontology-plan commit
      `254e8a05a962abb4f8df49da80d761ab3d922d56`.
- [x] Record failures as failures with exact run/job/step; do not diagnose or
      relabel them inside this task.

**Verified ancillary failures:**

- Client-state Branch Release Gate
  [run 31097790516, attempt 1](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31097790516/attempts/1)
  failed in job `Release Gate / Release Gate`, step `Run root CI suite`, when
  unchanged test `packages/tests/shared/ws-outbox-owner-miss-retry.test.ts:196`
  observed `FAILED` instead of expected `RETRY`. Attempt 2 succeeded for the
  same exact feature tree without a content change.
- Client-state resulting-main Deploy Web + API
  [run 31100952064](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31100952064),
  attempt 1, failed at job `92614114557`; job name
  `Enforce Cloudflare main-only branch controls`; failed step 4,
  `Disable feature-branch Workers and Pages builds`.
- Ontology-plan Deploy Web + API
  [run 31103071859](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31103071859),
  attempt 1, failed at job `92621232924`, the same named job and step.
- The client-state commit also reported failed Deno Deploy contexts for
  [rallar-bb-server](https://console.deno.com/intact-software-systems/rallar-bb-server/builds/tfmf3m7yxd4e),
  [rallar-server](https://console.deno.com/intact-software-systems/rallar-server/builds/cme3jtjx2bgz),
  and
  [relic-hunters](https://console.deno.com/intact-software-systems/relic-hunters/builds/g4xhx17cxgsz).
- The ontology-plan commit also reported failed Deno Deploy contexts for
  [rallar-bb-server](https://console.deno.com/intact-software-systems/rallar-bb-server/builds/aeamg6v3sayp),
  [rallar-server](https://console.deno.com/intact-software-systems/rallar-server/builds/bm16tz9b0yh3),
  and
  [relic-hunters](https://console.deno.com/intact-software-systems/relic-hunters/builds/8g1vnjcxm4d0).

These failures are not relabelled and remain unresolved. They do not replace
the roadmap's explicitly named successful default-branch publication workflow.
They are a scoped release blocker: a separate operations owner must be assigned
before any release claim that depends on the affected Deploy Web + API or Deno
Deploy contexts. They do not block unrelated tracks or release claims that do
not depend on those contexts.

**State:** `verified` for the required Phase 0 publication envelopes; ancillary
deployment failures recorded.

### Task 0C: Draft the RTC performance baseline plan

**Target file:**
`docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md`

**Required contents:**

- [x] Inventory current RTC/realtime production paths and consumers before
      proposing changes.
- [x] Inventory relevant existing harnesses under `scripts/perf/**` and state
      what each can and cannot prove.
- [x] Define representative environments and fixed workloads for connection
      setup, signaling, data-channel queueing, topology/RTT, multicast, reconnect,
      and long-running retention/cleanup where applicable.
- [x] Define correctness checks, warmup, sample count, noise handling, captured
      runtime/commit/configuration, and before/after comparison rules.
- [x] Define hotspot selection criteria and stop conditions.
- [x] Separate instrumentation, baseline capture, structural refactoring, and
      optimization into independently reviewable tasks.
- [x] Keep generated profiles under `tmp/perf/` and define the small durable
      summary that may be reviewed or published.
- [x] Map candidate production paths against active and planned human-readability
      children so overlapping write sets are serialized.

**State:** planning task `verified` against exact blob
`50614b299cfc9b1d85aafb1e32537e56f512ff3d` and workloads `RTC-B01` through
`RTC-B06`. Section 5 records the later Phase 1 owner assignments, revised exact
reservations, and serialized holds. No baseline capture, production change,
remote `RTC-B07` run, or optimization has started.

### Task 0D: Approve the Phase 1 launch envelope

The human reviews one concise launch record containing:

- exact ontology plan revision and approval scope for Task 1 only;
- accepted RTC baseline workloads and environment limitations;
- verified client-state ledger status and the selected next human child;
- the first three write reservations; and
- any known shared-path serialization.

**State:** `verified`. PR #77 and resulting-main run 31122914721 attempt 4
provide the exact approval-record publication evidence. The later Phase 1 owner
assignments and revised reservations are recorded in Sections 4-5.

### Approved Phase 1 launch envelope — later reservation state recorded in Section 5

Approval applies only to the exact items below. It starts no work by itself;
the coordinator records each approved cross-program reservation, while the
assigned concern-specific track owner activates and updates its own work.

#### Approval record

On 2026-08-06, the human owner approved the envelope as proposed after reviewing
draft PR #77 candidate commit `693446cdf8ba5fc1c027f1e854c6b2d8825e4901`,
tree `5779939bc76d313377aa672d6cc2fe45d9339a6a`, and roadmap blob
`f17157c4fc9035573f2ba88bfa17860dab18424f`. This approval-record edit changes
the roadmap blob but does not revise that reviewed scope. The approval:

1. approves the reconciled roadmap content and Phase 0 decision exit;
2. approves ontology Task 1 only against exact plan blob
   `9267a16a3fa3c547ba7db9ce4fd55f858f7d9e37` and the six paths below;
3. accepts RTC workloads `RTC-B01` through `RTC-B06` and their initial
   measurement reservation against exact RTC plan blob
   `50614b299cfc9b1d85aafb1e32537e56f512ff3d`;
4. selects the already approved auth child at exact blob
   `123990bceac9732660e1113101addd5b194d8347`, with Task 1 first, PR A gated,
   and PR B/C inactive;
5. allows Postgres only when a measured candidate call path requires
   database-backed admission, topology, or persistence, while remote `RTC-B07`
   remains held; and
6. requires a separate operations owner before any release claim affected by
   the recorded Deploy Web + API or Deno Deploy failures, without blocking
   unrelated tracks.

This Phase 0 approval alone assigned no track owner, activated no reservation,
and authorized no source edit, instrumentation run, baseline capture, remote
fleet work, or optimization. Section 5 records the later, separate Phase 1
owner assignments and revised exact reservations; each owner remains bound to
the authoritative child plan and its gates.

#### Ontology Task 1 approval revision

- Plan:
  `docs/superpowers/plans/2026-08-05-rallar-ontologies-implementation-plan.md`
- Exact plan blob: `9267a16a3fa3c547ba7db9ce4fd55f858f7d9e37`.
- Publication commit/tree:
  `254e8a05a962abb4f8df49da80d761ab3d922d56` /
  `f99eb14639261d200375761e8a8c7ba44d680ed3`.
- Approval scope: Task 1 only, creating
  `packages/shared/ontology/rallar-ontology-contracts.ts`,
  `rallar-domain-ontology-contracts.ts`,
  `rallar-realtime-ontology-contracts.ts`,
  `rallar-ontology-registry.ts`, `packages/shared/ontology/mod.ts`, and
  `packages/tests/shared/rallar-ontology-registry.test.ts`.
- Locked behavior: additive opt-in metadata contracts/registry only; no import
  into runtime paths, no packet/payload/authority/routing/validation change, and
  no shared package barrel change.

#### RTC baseline acceptance set

Accept `RTC-B01` through `RTC-B06` from
[the RTC baseline plan](../docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md):

**Exact accepted RTC plan blob:**
`50614b299cfc9b1d85aafb1e32537e56f512ff3d`.

1. deterministic signaling/ICE/listener counters;
2. data-channel replacement, drain, close, and error lifecycle;
3. star/tree/mesh topology, RTT shape/current repository filtering, and
   inactive-state characterization;
4. multicast serialization and group/cache/heartbeat coordination;
5. raw native Chromium connection/data-channel lifecycle; and
6. local three-browser memory, receiver-observed phase timings, reconnect, and
   bounded 100-cycle Rallar retention indicators.

The fixed inputs, sample counts, correctness gates, environment fingerprints,
noise rules, artifact contract, and stop conditions in that plan are part of
the acceptance. `E4-pg` is allowed—and required before selecting such a
hotspot—only when the measured candidate call path includes database-backed
admission, topology persistence, AppInbox, outbox, or cluster transport. It
does not replace required `E3-memory`. Remote `RTC-B07` remains held and needs
separate explicit cost, fleet, commit, and artifact authorization before
dispatch.

#### Client-state ledger and selected human child

Client-state is `verified` here and `ledger-published` in the authoritative
human-program model, based on PR #75 and the exact successful gates in Section 4. The coordinator made no human-plan edit.

The selected next child is
`plans/rallar-auth-server-structure-plan.md` at exact blob
`123990bceac9732660e1113101addd5b194d8347`. Its planning envelope is verified:

- [PR #76](https://github.com/intact-software-systems/ar-eye-hunter/pull/76)
  feature `38a961c4ee184856422b3acf6f0494d04d8d6e5b`, frozen tree
  `aa82a21c85d7a6504aaa1a203aaabfe439d90af5`;
- Branch Release Gate
  [run 31103489838](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31103489838),
  attempt 2, success. Its
  [attempt-1 evidence record](https://github.com/intact-software-systems/ar-eye-hunter/pull/76#issuecomment-5205255673)
  records failure in job `Release Gate / Release Gate`, step
  `Run root CI suite`, when unchanged
  `packages/tests/shared/ws-outbox-owner-miss-retry.test.ts:196` observed
  `FAILED` instead of expected `RETRY`; no content changed before attempt 2; and
- resulting `main` `61e708708f94328f095f1f1fa5690747bb933476`, tree
  `32fad7c720dcc1eb462f6b486ff64db4f687f67e`, with Run Hetzner Supported
  Distributed Manifests
  [31106485616](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31106485616),
  attempt 1, success.

The exact
[external closure record](https://github.com/intact-software-systems/ar-eye-hunter/pull/76#issuecomment-5205571315),
created by repository account `intact-software-systems` at
`2026-08-06T13:53:26Z`, identifies blob
`123990bceac9732660e1113101addd5b194d8347` as approved, states it remains
byte-identical on resulting `main`, removes the former plan-approval blocker for
PR A, and keeps PR B, PR C, and the later ledger blocked. That removal does not
bypass Task 1 or PR A's sample, warning, and independent-review gates.

The entire auth child plan at exact blob
`123990bceac9732660e1113101addd5b194d8347` was already externally approved at
the Phase 0 decision. Under that historical sequencing, separately activated
work began with Task 1 characterization; after its human sample/warning approval
and independent review, the first implementation cohort was PR A mutation/login
core, with PR B and PR C held behind predecessor publication and human merge
gates. Sections 4 and 7 record that PR A and PR B later published and verified;
only PR C remains inactive. The human-program coordinator or assigned
human-traceability track owner, not this roadmap coordinator, activates and
updates that child.

#### Historical Phase 0 initial write reservations — superseded by Section 5

This table preserves the exact Phase 0 launch decision. It is not the current
write authority; the reconciled reservations and holds in Section 5 govern all
new work.

| Reservation                  | Approved owner role                                                  | Exact initial write set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Serialization rule                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ontology Task 1              | Ontology track owner                                                 | The six Task 1 paths listed above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | No package barrel, public snapshot, runtime, generated artifact, or root-script edit.                                                                                                                  |
| RTC instrumentation/baseline | RTC performance owner                                                | RTC plan/progress; `scripts/perf/README.md`; `scripts/perf/{rtc-baseline-envelope,rtc-data-channel-drain-bench,rtc-rtt-repository-filter-bench}.ts`; measurement-only `scripts/perf/rtc-data-channel-browser-soak.mjs`; the 16 accepted existing harnesses enumerated exactly in baseline-plan Section 10; `packages/tests/repo/rtc-performance-baseline-contract.test.ts`; measurement-only `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts`; its two named existing coverage/script-gate tests; and ignored `tmp/perf/rtc-baseline/**` | No production RTC path or root script. Serialize full-stack/remote runs with auth work.                                                                                                                |
| Human auth Task 1            | Human-program coordinator or assigned human-traceability track owner | `plans/rallar-auth-server-structure-plan.md`, ignored `tmp/repo-human-traceability/auth/task-1-report.md`, RED semantic tests under `packages/tests/shared-server/auth/**`, and navigation/ownership tests matching `packages/tests/repo/auth-server-*.test.ts`; Task 1 produces the exact later PR-cohort assignment                                                                                                                                                                                                                                                        | No production auth move in Task 1. PR A activates only after its sample/warning/review gate; PR B/C stay inactive. Synthetic RTC may run in parallel; service-backed RTC waits for a stable auth tree. |

#### Human-program owner handoff (read only)

The earlier planning/status contradictions and PR #76 evidence were delivered
in the read-only
[PR #76 handoff](https://github.com/intact-software-systems/ar-eye-hunter/pull/76#issuecomment-5206866857).
The human-program owner subsequently published PR A, but the auth child merged
with Task 3 and its live progress table still predicting pending branch/default
publication. The exact PR A feature, branch-gate, merge, resulting tree, and
default-workflow evidence were therefore delivered in the later
[PR #78 closure handoff](https://github.com/intact-software-systems/ar-eye-hunter/pull/78#issuecomment-5215094789).
The owner must reconcile that authoritative progress under its own non-circular
protocol. PR #81 subsequently published Tasks 4-5 / PR B at feature head
`1f7d7b0682c93c7c831fc2a31c0f635829d50734`, tree
`2a5d756b83f44b6b8bbae166e8571f761371af29`; Branch Release Gate
31185044360 attempt 1/job `92887353726` succeeded. It merged as
`8152de39faf2d630158143366596d61346e20457` with the same tree, and resulting-main
Run Hetzner Supported Distributed Manifests 31187663870 attempt 1 succeeded.
The earlier conflict and B06 serialization record remains available through the
read-only
[PR #81 handoff](https://github.com/intact-software-systems/ar-eye-hunter/pull/81#issuecomment-5217172104).
The human-owned auth plan still predicts pending PR B publication, so its owner
must reconcile that stale status under the program's non-circular protocol.
The roadmap coordinator did not edit or advance the human master, execution, or
auth child plans. PR C remains inactive here; PR B's stable exact resulting tree
satisfies only B06's auth-tree prerequisite, not B06's separate activation gate.

#### Recorded human decisions and remaining condition

1. Phase 0 content and the exit decision are approved as proposed; this does not
   itself provide approval-record publication evidence or start Phase 1.
2. Ontology Task 1 only is approved against exact blob
   `9267a16a3fa3c547ba7db9ce4fd55f858f7d9e37`.
3. `RTC-B01` through `RTC-B06` and their measurement-only reservation are
   accepted against exact blob `50614b299cfc9b1d85aafb1e32537e56f512ff3d`.
4. Auth blob `123990bceac9732660e1113101addd5b194d8347` is selected; at the
   Phase 0 decision Task 1 was first and PR A/PR B/PR C were gated. Section 4
   records PR A's and PR B's later verified publication; PR C remains held.
5. Conditional Postgres is permitted only under the measured-path rule above;
   remote `RTC-B07` remains held.
6. A separate operations owner is required before affected release claims;
   unrelated tracks remain unblocked.

No Phase 0 human decision remains open. The operations owner is intentionally
unassigned: assignment becomes a blocking condition only before an affected
release claim.

### Phase 0 exit gate

The human-approved decision gate is satisfied:

- [x] the coordination documents are reviewed and published;
- [x] existing publication envelopes are truthfully recorded;
- [x] the RTC baseline plan is approved;
- [x] ontology Task 1 is approved against an exact revision;
- [x] the next human child is either explicitly selected or intentionally left
      blocked; and
- [x] the Phase 1 write sets have no unresolved overlap.

Human approval and the exact PR #77/resulting-main evidence satisfy the Phase 0
exit gate. Phase 0 is closed. Section 5 records the later named Phase 1 owners,
exact activation reservations, and serialized holds. Those implementation
reservations take effect only when this roadmap revision reaches `main`.

## 7. Phase 1 — Independent Foundations

### Track 1A: Ontology Task 1 foundation

Execute only Task 1 of the ontology plan on its named independent branch. Treat
the ontology as operationally inert metadata. Publish and verify Task 1 before
Tasks 2-5 branch from it.

**Entry:** exact plan approval, applicable publication evidence, a named owner,
and an explicitly active reservation.

**Exit:** Task 1 focused/full gates and exact branch/default publication evidence
are verified.

**Current state:** `verified`. Exact plan blob
`7e142365f9b18f59966aa440cb5b9cdd228935b0` is human-approved and published on
`main` by PR #80. PR #89 then published exact 17-path Task 1 head
`ff9e77405b4986836272a3c48dc0659241ff5d83`, tree
`07d58cd0936406f6ab632b6d219431fadc2605e0`; Branch Release Gate 31214805578
attempt 1/job `92985722492` succeeded. It merged as
`f7ea9b2f4b3277f7f5ae72e7f490812c8058bb41`, tree
`e5b7eb5a40ad0f6fff50c1afb4ae1583cbd7dd23`; resulting-main run 31242891941
attempt 1 and all seven jobs succeeded. The old six-path, `d68d511...`-based
prototype remains historical input only. Tasks 2-11 remain unauthorized.

### Track 1B: Human-traceability continuation

When separately activated, follow the existing human program's selected auth
child. The current master order places auth before group topology, RTC/RTT,
CRDT, and admin, but only the human-program owner may activate and advance that
child.

**Entry:** client-state `ledger-published`, human child approval, a named owner,
and an explicitly active reservation.

**Exit:** the approved interval reaches the state required by its own child
plan; the roadmap records only cross-program consequences.

**Current state:** PR A and PR B are externally `verified`. PR #78's final
exact-head Branch Release Gate passed, it merged as `a900423...`, and
resulting-main run 31163606362 attempt 1 passed. PR #81 then published PR B at
feature head `1f7d7b0682c93c7c831fc2a31c0f635829d50734`, tree
`2a5d756b83f44b6b8bbae166e8571f761371af29`; Branch Release Gate 31185044360
attempt 1/job `92887353726` succeeded. It merged as
`8152de39faf2d630158143366596d61346e20457` with the same tree, and resulting-main
Run Hetzner Supported Distributed Manifests 31187663870 attempt 1 succeeded.
The human-owned auth plan still predicts pending PR B publication; its owner
received the read-only handoff and must reconcile that stale status and its
activation record. This coordinator keeps every human plan read-only. PR C
remains inactive. PR B's stable exact tree satisfies B06's auth-tree
prerequisite, but B06 remains inactive behind its distinct plan approval,
four-path activation, clean-head gates, and capture authorization.

### Track 1C: RTC baseline execution

Run the approved baseline plan without production optimization. Capture exact
commit, runtime, environment, configuration, commands, workloads, samples,
noise, and limitations. Rank hotspots by measured user/system impact and
confidence, not file size or intuition.

**Entry:** approved RTC baseline plan, a named owner, and an explicitly active,
non-overlapping harness reservation.

**Exit:** reproducible baseline and one human-accepted candidate vertical slice.

**Current state:** Foundation PR #150 merged as
`f43c1881e684fd2a423b0993c4389d969c264311`; B01 PR #162 merged as
`e921c46058d9db91c8c7707868593a523c4e75e0`; B02 PR #169 merged as
`33fa104d2cbf347eab1d02a54107c01f064aad00`; and B03 PR #193 merged as
`39ad65b499c4bf944acfe48446ad1c334d97d37d`, tree
`f11d95321e7bbd241d816f303f888945352160d7`. B03's exact feature head
`e7c62c00a4356d17f5d8febfcea3305edafd43d9` passed Branch Release Gate
31543466797; resulting-main run 31570814746 succeeded. No benchmark or baseline
capture ran.

PR #196 owns only the organization design, authoritative RTC plan amendment,
and coordination record. Its published stack is:

1. PR #196 — design, exact plan amendment, and pending reservations only;
2. Task 4A follow-on PR — complete package relocation and semantic parity; and
3. Task 4B follow-on PR — complete code/legacy review and remediation.

B04 and capture remain held until all three layers merge and are revalidated.
Exact plan blob `b78e00e982d186264bc5ba6b4b2a943f15a328f3` is human-approved, and Task 4A
alone is active. Task 4B, B06, B07, production change, optimization,
raw-artifact publication, human-plan edits, PR C, and Phase 2 remain held.

### Phase 1 exit gate

- Ontology Task 1 is verified and published.
- RTC baselines are reproducible and one candidate is accepted or the evidence
  explicitly says no optimization is justified yet.
- The active human child has no unresolved write conflict with the proposed RTC
  slice.
- The coordinator records the Phase 2 ordering decision.

## 8. Phase 2 — Ontology Pilot And One Measured RTC Slice

The default interleave is:

1. publish ontology Task 2 (domain pilot) after Task 1;
2. allow ontology Task 5 (code standards) in parallel when its write set is
   independent;
3. publish ontology Tasks 3-4 in their prerequisite order;
4. continue the approved human child on non-overlapping paths;
5. characterize one measured RTC slice semantically and structurally;
6. if needed, land ontology clarification first;
7. if needed, land behavior-neutral readability movement second;
8. land the measured optimization separately with before/after evidence;
9. assemble ontology Task 6 artifacts only after Tasks 1-5 publish; and
10. run Task 7 and the human pilot gate before any optional Tasks 8-9.

When the measured RTC slice overlaps the human program's later RTC/RTT or
WebRTC/multicast children, use one of these explicit choices:

- advance the human child first, then rebaseline and optimize;
- optimize the current structure first, then refactor with the performance gate
  retained; or
- create one coordinated child plan with separate commits and gates for
  semantics, structure, and optimization.

The human chooses among them from measured risk. Agents must not infer the
choice from the fact that all work concerns RTC.

## 9. Required Track Handoff

Every track agent sends the coordinator:

- outcome and authoritative task/plan section;
- exact files changed and behavior impact;
- branch, final commit, and Git tree;
- focused and full local commands with pass/fail/skipped status;
- PR, Branch Release Gate, resulting default commit, and default workflow when
  they exist;
- RTC workload/result/artifact identity when applicable;
- unresolved warnings, compatibility risks, and path reservations;
- human decisions made or still required; and
- the smallest safe next action.

The coordinator rejects a handoff that predicts future evidence, omits the
tested tree, or combines semantic, structural, and performance outcomes so they
cannot be reviewed independently.

## 10. Live Program Progress

| Item                         | Owner                            | State                                                       | Evidence/blocker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Next action                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 0 publication          | Roadmap coordinator              | `verified`                                                  | PR #77 merged as `d68d511...`; resulting-main run 31122914721 attempt 4 succeeded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Preserve the historical closure record while reconciling later `main` commits separately.                                                                                                                                                                                                                                                              |
| Phase 1 coordination record  | Roadmap coordinator              | protocol-corrected RTC activation publication in progress   | PR #79 merged the Phase 1 coordination record as `6d4b9653eda00fb0234d2dc419321dd8b7fce7a4`; PR #92 published the six-path activation as `72c426f4c1873d71765da35d26c9d2c0b4b1b6fd`; PR #101 published the superseded nine-path activation as `7b10146aac7718a807337886d48c8fa5b5145813`; PR #111 published the superseded thirteen-path activation as `fdb53f836f7e1fae7b416161a0dbff8d98f91760`; and later superseded activations remain historical evidence. Current `main` is `cd843d154c5698912eb99a92039ecd31464aef0f`, tree `7d869b5a6ca6cd1e473b612f1a2f3892b65f5d4c`, with protocol-corrected RTC blob `d977a6495cffee240d7484a7f238533afc5feacf`.     | Publish this one-file protocol-corrected RTC activation revision and keep RTC work inactive until it reaches `main`.                                                                                                                                                                                                                                   |
| 1A Ontology Task 1           | `/root/ontology_task1_phase1`    | `verified`                                                  | PR #89 feature head `ff9e77405b4986836272a3c48dc0659241ff5d83`, tree `07d58cd0936406f6ab632b6d219431fadc2605e0`, passed Branch Release Gate 31214805578 attempt 1/job `92985722492`; it merged as `f7ea9b2f4b3277f7f5ae72e7f490812c8058bb41`, and resulting-main run 31242891941 attempt 1 succeeded.                                                                                                                                                                                                                                                                                                                                                           | Preserve Task 1 publication; keep Tasks 2-11 and runtime activation held.                                                                                                                                                                                                                                                                              |
| 1B Human auth                | Human-program owner              | PR A and PR B externally verified                           | PR #78 merged as `a900423...` with resulting-main run 31163606362 attempt 1 successful. PR #81 feature `1f7d7b0682c93c7c831fc2a31c0f635829d50734`, tree `2a5d756b83f44b6b8bbae166e8571f761371af29`, passed Branch Release Gate 31185044360 attempt 1/job `92887353726`; it merged as `8152de39faf2d630158143366596d61346e20457`, and resulting-main Hetzner run 31187663870 attempt 1 succeeded. The human-owned plan still predicts pending PR B publication.                                                                                                                                                                                                  | Human-program owner reconciles its own plan/status. PR C and RTC-B06 remain inactive here.                                                                                                                                                                                                                                                             |
| 1C RTC baseline              | `/root/rtc_b01_b05_phase1_owner` | protocol-corrected activation recorded; publication pending | PR #147 published exact plan blob `d977a6495cffee240d7484a7f238533afc5feacf`; OWNER/User approval comment `5237125583` exactly satisfies Task 0. This roadmap revision records only the unchanged exact 59-path Section 10 B01-B05 activation. Resulting-main run 31365680140 attempt 1 completed successfully at `2026-08-10T07:33:40Z` on exact merge `cd843d154c5698912eb99a92039ecd31464aef0f`; jobs `93383420770`, `93383478739`, `93383791691`, `93384081554`, `93384374387`, `93384711142`, and `93385105464` all succeeded. Every earlier Task 1 worktree remains read-only design input and is not completion, source, capture, or benchmark evidence. | After this revision reaches `main`, start Task 1 code immediately from a fresh clean branch: author all 18 tests while all 21 foundation sources are absent, record the new RED, then implement. Do not create another plan amendment unless the human explicitly directs it. Until activation merges, do not edit implementation or capture evidence. |
| RTC benchmark organization   | RTC performance plan owner       | `task-4a-draft-published`; merge gates pending              | PR #196 merged as current main `55d7f44c24d0345798a5b2c1dc7ffa0d2b5269af`, and resulting-main run 31597501992 succeeded on that exact commit. The human named and approved exact plan blob `b78e00e982d186264bc5ba6b4b2a943f15a328f3`, then explicitly authorized starting. Compatibility review found no material package, contract, or ontology overlap. Draft PR #198 publishes the exact 49 source dispositions and Task 4A integration on `codex/shared-rtc-bench-task-4a`; no benchmark execution or capture occurred.                                                                                                                                    | Require corrected exact-head Branch Release Gate success, human review, merge, and resulting-main evidence. Keep Task 4B, B04, capture, and every later layer inactive.                                                                                                                                                                                |
| Conditional operations owner | unassigned                       | not blocking unrelated tracks                               | Existing Deploy Web + API and Deno Deploy failures remain recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Assign before an affected release claim.                                                                                                                                                                                                                                                                                                               |

## 11. Immediate Next Actions

1. Publish the corrected exact Task 4A head to draft PR #198 and require its
   Branch Release Gate to pass.
2. Preserve Task 4A semantics and keep Task 4B, B04, all benchmark capture, B06,
   ontology implementation, and production RTC changes held.
3. Merge Task 4A only after human review and exact-head Branch Release Gate
   success; then record its resulting-main commit/tree and successful
   supported-manifests workflow.
4. After Task 4A merges and its resulting-main gates pass, execute Task 4B in a
   separate follow-on PR. B04 remains held until its complete review, legacy
   dispositions, independent re-review, and publication gates pass.
5. Preserve the ontology Task 4 shared-web browser-lane reservation and its
   build-time binding resolution. Do not edit ontology implementation or create
   benchmark-owned ontology metadata.
6. Keep B06, B07, production RTC changes, optimization, raw-artifact publication,
   and Phase 2 inactive until their separately named gates are satisfied.
