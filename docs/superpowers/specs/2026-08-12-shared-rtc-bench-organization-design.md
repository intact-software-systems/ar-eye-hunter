# Shared RTC Benchmark Package Organization Design

**Date:** 2026-08-12

**Status:** Draft for human review

**Decision owner:** Product/technical owner

**Affected plan:**
[Rallar RTC Performance Baseline Implementation Plan](../plans/2026-08-06-rallar-rtc-performance-baseline-plan.md)

## Purpose

RTC and WebRTC performance tooling is currently difficult for a human to locate
and understand. The accepted baseline framework, measured workloads, standalone
diagnostics, historical probes, topology delivery tools, topology replay tools,
and their tests are spread across `scripts/perf/**` and several
`packages/tests/**` trees. A reader must already know historical task names and
consult the implementation plan or an AI to reconstruct the whole capability.

This design makes `packages/shared-rtc-bench/**` the single repository home for
every RTC and WebRTC performance tool. Folder structure becomes the primary
navigation system. The migration preserves the approved measurement and evidence
contracts first, then performs a separate major code and legacy review over the
organized package.

The reorganization is an architecture milestone in the active RTC plan. It must
finish before B04 implementation or any B01-B05 baseline capture resumes.

## Human Navigation Outcome

A developer who opens `packages/shared-rtc-bench/README.md` must be able to find,
without consulting a historical plan:

- every accepted RTC baseline workload;
- every standalone RTC or WebRTC benchmark;
- every maintained diagnostic and its acceptance status;
- every executable command and output location;
- the production package and symbol actually being measured;
- the setup, measured operation, validation, and artifact owner;
- the owning semantic or smoke test; and
- the distinction between accepted evidence and diagnostic output.

No RTC or WebRTC performance executable or workload implementation remains under
`scripts/**` after the migration.

## Current Affected Surface And Legacy Baseline

The current implementation contains 49 RTC/WebRTC-related performance source
files under `scripts/perf/**`:

- 24 accepted-baseline framework and workload files under
  `scripts/perf/rtc-baseline/**`;
- 17 accepted B01-B05 TypeScript/Node workload entrypoints at the
  `scripts/perf/**` root;
- three maintained-diagnostic candidates that the accepted plan calls
  historical probes; and
- five topology delivery, replay, and state-write support files under
  `scripts/perf/rtc-topology/**`.

Twenty direct baseline/delivery/replay tests are split between
`packages/tests/repo/**` and `packages/tests/shared-server/**`. A general
state-write benchmark test also imports the mixed-ownership state-write reason
module and therefore needs a path update when that module moves to its actual
owner.

Known affected-surface legacy is:

| Current shape                                          | Problem                                                             | Required disposition                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Accepted framework in `scripts/perf/rtc-baseline/**`   | Tooling ownership is hidden under a generic scripts tree            | Move and organize under package capabilities               |
| Accepted workloads scattered at `scripts/perf/**` root | A human cannot see the accepted program as one unit                 | Move under capability-named workload folders               |
| Direct imports from `packages/tests/**`                | Production tooling depends on test implementation                   | Replace with benchmark-owned deterministic setup           |
| Thirteen repeated accepted/diagnostic shells           | Evidence protocol is duplicated across workloads                    | Review and centralize only the real protocol boundary      |
| Many files shaped to 397-400 physical lines            | The obsolete cap influenced formatting and responsibility decisions | Review by ownership and current cognitive-load standards   |
| One combined 824-line workload test                    | Distinct capabilities and failures are difficult to locate          | Separate into mirrored capability tests                    |
| Three historical probes                                | Unchecked/excluded code has no trustworthy maintenance status       | Maintain and check, or delete as superseded through review |
| `rtc-topology/state-write-reasons.ts`                  | General state-write policy is stored under an RTC benchmark folder  | Move to the state-write benchmark owner                    |
| RTC rows in `scripts/perf/README.md`                   | Documentation points humans back to the old source tree             | Replace with one link to the package navigation map        |

Task 4B expands this baseline when code tracing discovers another in-scope
candidate. Unclassified affected legacy is not permitted at milestone exit.

## Design Decisions

### One package owns the complete performance capability

Create one private workspace package:

```text
packages/shared-rtc-bench/
├── README.md
├── package.json
├── tsconfig.json
├── deno.json
├── baseline/
│   ├── contracts/
│   ├── catalog/
│   ├── acceptance/
│   ├── evidence/
│   ├── runtime/
│   └── command/
├── workloads/
│   ├── signaling/
│   ├── data-channel/
│   ├── topology/
│   ├── multicast/
│   ├── group-coordination/
│   └── browser-lifecycle/
├── topology-delivery/
├── topology-replay/
├── diagnostics/
│   ├── room-graph/
│   ├── rtt-group-scan/
│   └── rtt-traffic/
└── tests/
    ├── architecture/
    ├── baseline/
    ├── workloads/
    ├── topology-delivery/
    ├── topology-replay/
    └── diagnostics/
```

The final implementation plan locks the exact file inventory. This design locks
the ownership boundaries and navigation rules; it does not require a one-file
folder when the major review proves that colocating a small cohesive workload is
easier to understand.

### Top-level folder meanings

- `baseline/` owns accepted evidence lifecycle behavior. It does not own the RTC
  algorithms being measured.
- `workloads/` owns accepted B01-B05 setup, measurement, validation, and raw
  evidence projection by RTC capability.
- `topology-delivery/` owns the PostgreSQL publisher-stream delivery-log
  performance program.
- `topology-replay/` owns deterministic replay-drain operation-count tooling.
- `diagnostics/` owns maintained standalone probes that are explicitly excluded
  from accepted baseline evidence.
- `tests/` mirrors the production capability tree. Tests do not remain in
  `packages/tests/repo/**` or `packages/tests/shared-server/**` merely because
  that was their historical location.

`baseline/`, `workloads/`, `topology-delivery/`, `topology-replay/`, and
`diagnostics/` name distinct product/tooling capabilities. The design prohibits
generic package-wide `utils`, `helpers`, `types`, or `fixtures` folders.

### Direct dependency boundary

Human-authored source in `packages/shared-rtc-bench/**` may directly import only:

- platform and approved external libraries required by a benchmark;
- `packages/shared/**`;
- `packages/shared-web/**`;
- `packages/shared-server/**`; and
- another owning file inside `packages/shared-rtc-bench/**`.

It must not directly import:

- `packages/tests/**`;
- `scripts/**`;
- `apps/**`;
- `packages/shared-test/**`;
- `packages/shared-graph/**`; or
- any other repository package.

Transitive dependencies of the three approved product packages remain owned by
those packages. Package-local TypeScript and Deno configuration may resolve
their transitive aliases, but benchmark source may not bypass the approved
boundary with direct imports.

The dependency direction is one-way:

```text
packages/shared-rtc-bench
  ├── packages/shared
  ├── packages/shared-web
  └── packages/shared-server

packages/shared, packages/shared-web, packages/shared-server
  -/-> packages/shared-rtc-bench
```

No product package, app, or production runtime imports the benchmark package.
Root npm scripts may execute package entrypoints directly; they do not require
compatibility wrappers in `scripts/perf/**`.

### General state-write policy is not an RTC benchmark executable

The current `scripts/perf/rtc-topology/state-write-reasons.ts` is shared policy
for the API-v1 state-write benchmark and imports that benchmark's artifact
contract. It is not an independent RTC benchmark executable or workload. During
the move it is renamed and colocated under the state-write benchmark owner in
`scripts/perf/state-write/**`. The RTC package README links to that related
cross-benchmark policy, but `shared-rtc-bench` does not import it. This avoids
pulling the general API-v1 state-write benchmark into the RTC package merely
because of its historical folder.

## Program Classes And Status

The package preserves three visibly different execution classes.

### Accepted baseline

```text
baseline command
  -> accepted workload catalog
  -> fresh workload process
  -> deterministic setup
  -> exact measured operation
  -> workload-owned validation
  -> accepted evidence
  -> finalization and report
```

Only catalog membership plus the accepted evidence path can create accepted
baseline evidence. Folder placement alone never grants acceptance.

### Standalone benchmark

```text
package command
  -> deterministic setup
  -> measured operation
  -> validation
  -> diagnostic artifact
```

Topology delivery and topology replay remain independent programs with their own
commands, contracts, tests, and output rules.

### Maintained diagnostic

```text
explicit diagnostic command
  -> probe
  -> diagnostic validation
  -> diagnostic artifact
```

The three formerly historical probes become maintained code:

- no-RTT room graph;
- RTT group scan; and
- RTT traffic metrics.

Each is typechecked, documented, and semantic- or smoke-tested. Each remains
outside the accepted baseline catalog unless a later explicit plan decision
changes its evidence status. No unchecked or silently excluded TypeScript
graveyard remains.

## Workload Ownership

Every measured workload exposes an obvious workload entry and command entry.
The exact number of files follows cohesion, but these responsibilities remain
visible.

The workload owner contains:

- frozen supported inputs and accepted variants;
- deterministic fixture construction;
- setup outside the measured interval;
- the exact production operation under measurement;
- timing start and stop placement;
- result validation; and
- raw-evidence projection.

The command owner contains:

- argument decoding;
- accepted-worker versus diagnostic-mode selection;
- output confinement and create-new behavior;
- exit and error mapping; and
- the runtime entry boundary such as `import.meta.main`.

The production algorithm remains in `shared`, `shared-web`, or `shared-server`.
The benchmark package constructs inputs and invokes that implementation. It must
not copy or approximate the measured RTC behavior.

## Accepted Worker Protocol

Thirteen current workload files repeat accepted and diagnostic command mechanics.
That repetition represents one real protocol boundary and is reviewed for one
canonical package owner. The common accepted-worker protocol may own:

- accepted worker identity decoding;
- expected sample identity construction from catalog-owned facts;
- first-failure stopping;
- causal `not-run` accounting;
- common sample envelope construction; and
- diagnostic-output path confinement.

The common protocol must not own:

- workload matrices;
- workload-specific arguments;
- fixture generation;
- the measured operation;
- correctness invariants; or
- workload raw evidence.

This boundary reduces duplicated evidence mechanics without creating a generic
benchmark framework or hiding the workload's mainline dataflow.

## Benchmark-Owned Setup Without Test Dependencies

Production benchmark source cannot import test code.

### Topology group snapshots

The five B03 topology workloads currently import `createGroupSnapshot` from
`packages/tests/shared-graph/helpers.ts`. The package receives a deterministic
topology-workload snapshot builder owned beside the topology workloads. It uses
the authoritative `GroupSnapshot` contract but contains no topology algorithm.

### RTT repository filtering

The B03 RTT repository workload currently imports
`FakeRuntimeStateRepository` from `packages/tests/shared-server/**`. The workload
receives a narrowly named synthetic runtime-state adapter owned beside that
workload. It implements only the production repository port required for
deterministic prepopulation and observation. The measured operation remains the
real `RtcRttRepository.listMeasurementsForSessionIds(...)` method from
`packages/shared-server`.

### RTT traffic cache composition

The RTT traffic diagnostic currently imports
`configureTestCacheRepositories` from `packages/tests/**`. The diagnostic owns
its explicit cache composition using production configuration functions. It
does not import, move, or rename the test helper.

Benchmark-owned fixtures and adapters are production tooling, not product
runtime code. They are not exported through product package barrels.

## Root Navigation Map

`packages/shared-rtc-bench/README.md` is a durable read-first map, not a long
historical narrative. One inventory row per executable records:

- program class: accepted baseline, standalone benchmark, or maintained
  diagnostic;
- capability and purpose;
- command entrypoint;
- root/package command;
- frozen or configurable input summary;
- exact production symbol measured;
- setup owner;
- measured boundary;
- validation owner;
- output location and artifact class;
- owning test; and
- acceptance status.

The README also explains package dependencies, the distinction between accepted
and diagnostic evidence, local artifact policy, and how to add a workload
without introducing product/runtime dependencies.

## Migration Strategy

The active RTC plan gains two milestones between current Task 4 and Task 5.
Later tasks retain their existing numbers to preserve durable references.

### Review pressure and publication slices

The affected surface contains more than 20 production-tooling modules and more
than three materially different control-flow families. A single implementation
pull request would make it difficult to verify relocation parity separately
from structural corrections. The work therefore uses a three-layer stack:

1. Design and plan layer: this specification, the exact RTC plan amendment, and
   coordination/activation records only. It authorizes no source move until its
   exact plan blob is approved and activated.
2. Task 4A relocation layer: package creation, complete moves, dependency
   corrections, command/path updates, and semantic-parity evidence. It contains
   no broad structural redesign beyond the boundaries required to remove test
   dependencies and establish the package.
3. Task 4B review/remediation layer: major code and legacy review, protocol
   consolidation, responsibility splits, test separation, corrections, and
   final independent re-review.

Each layer records its parent, exact base and head, owned paths, plan link,
validation evidence, and remaining holds. The next layer does not merge before
its parent. B04 remains a later plan task after all three layers are merged and
revalidated.

### Task 4A: Establish package ownership

Task 4A is a behavior-preserving relocation and boundary change:

1. Create the private workspace package, its package-local TypeScript/Deno
   configuration, and the read-first README.
2. Add package-local architecture tests before moving implementation.
3. Move every RTC/WebRTC performance executable, workload, support module, and
   owning test into the capability tree.
4. Move the general state-write regression-reason policy to its actual
   state-write owner rather than importing `scripts/**` from the RTC package.
5. Update the accepted catalog, source paths, source-hash paths, root/package
   scripts, Vitest discovery, Deno commands, TypeScript build participation,
   and `scripts/perf/README.md` cross-navigation.
6. Replace every production-tooling import from `packages/tests/**` with the
   benchmark-owned setup described above.
7. Preserve workload inputs, accepted identities, artifact schemas, CLI
   grammar, measured intervals, validation behavior, output confinement, and
   failure accounting.
8. Typecheck and smoke every maintained diagnostic.
9. Delete migrated implementations and tests from their old locations. Do not
   leave compatibility wrappers in `scripts/perf/**`.
10. Prove semantic parity and the new dependency boundaries.

Path-valued metadata and source hashes intentionally change because source files
move. Artifacts from the old and new trees cannot be pooled. No B01-B05 capture
has started, so the reorganized tree becomes the only eligible future
measurement anchor.

### Task 4B: Complete code and legacy review

Task 4B reviews the organized package as one capability, then remediates it
along real ownership boundaries. It is not satisfied by file moves, a clean
formatter, or a clean warning checker.

For every executable and materially different lifecycle, the review records:

- purpose and program class;
- command entry owner;
- setup owner;
- measured production package and symbol;
- exact timing interval;
- validation and failure owner;
- output and cleanup owner;
- tests and evidence;
- dependencies; and
- legacy disposition.

The review specifically examines:

- package and folder navigability;
- mixed responsibilities and cognitive load;
- the large baseline contract and evidence modules;
- repeated accepted-worker and diagnostic shells;
- type and contract ownership;
- deterministic fixtures and hidden globals;
- setup accidentally included in timing;
- copied or simulated production behavior;
- mutation, cleanup, and failure paths;
- CLI grammar and output confinement;
- the combined 824-line harness test;
- source-inventory tests coupled to obsolete paths;
- duplicate or superseded tools; and
- every formerly historical diagnostic.

Each reviewed legacy candidate receives exactly one disposition:

- `canonical`;
- `refactored`;
- `deleted-superseded`; or
- `retained-pending-human-approval`.

All Critical and Important findings are corrected and independently reviewed
again. Retention requires the human approval and durable exception record
required by the repository's legacy-review rules.

## File Review Standard

The old RTC plan's blanket 400-physical-line gate is not carried into the new
package. It produced many files at 397-400 lines and encouraged formatting and
responsibility decisions around a numeric cap. The reorganized package follows
the current repository standard:

- one coherent responsibility per file;
- cognitive-load and runtime-export responsibility review;
- the physical-length navigation backstop after declarative-data discount;
- function-size and decision-depth review; and
- human review even when automated checks are clean.

The existing user-approved exception for the combined harness test becomes
obsolete when Task 4B separates that test by capability. No new exception is
created merely to preserve the pre-move shape.

## Test Organization And Gates

All RTC/WebRTC benchmark tests move into
`packages/shared-rtc-bench/tests/**` and mirror the capability tree. Root Vitest
configuration explicitly discovers:

```text
packages/shared-rtc-bench/tests/**/*.test.ts
```

Tests remain semantic. Exact-tree or inventory assertions may temporarily guard
the migration, but they record an owner and removal condition and do not replace
behavior tests.

### Architecture gates

Tests prove:

- no RTC/WebRTC performance executable or workload remains under `scripts/**`;
- package source imports only approved direct dependencies;
- package source never imports `packages/tests/**`, `scripts/**`, or `apps/**`;
- product packages and apps never import `shared-rtc-bench`;
- every executable appears in the README navigation map;
- every executable has an owning semantic or smoke test;
- every maintained diagnostic is typechecked;
- only approved workloads appear in the accepted baseline catalog; and
- diagnostics cannot emit accepted baseline evidence.

### Behavioral parity gates

Task 4A proves unchanged:

- frozen case and input matrices;
- worker argument grammar and normalization;
- sample, attempt, failure, and causal remainder identities;
- first-failure stopping and complete remainder accounting;
- accepted artifact schemas;
- output confinement and create-new semantics;
- timing placement around each exact measured operation;
- graph, RTT, repository, data-channel, signaling, multicast, group, and
  lifecycle invariants; and
- topology delivery and replay policies.

### Focused commands

The package exposes focused commands equivalent to:

```text
npm --workspace @ar-eye-hunter/shared-rtc-bench run typecheck
npm --workspace @ar-eye-hunter/shared-rtc-bench run test
npm --workspace @ar-eye-hunter/shared-rtc-bench run check:deno
npm run check:repo-style -- --root packages/shared-rtc-bench
npm run check:repo-style:changed -- origin/main
git diff --check
```

The exact Deno command uses `packages/shared-rtc-bench/deno.json`; the package
does not rely on an app-owned Deno configuration.

### Completion gates

After the final uncommitted tree is ready:

```text
npm run test:unit
npm run test:ci
npm run build
```

Completion also requires:

- independent read-only architecture review;
- independent code and legacy review;
- resolution and re-review of all Critical and Important findings;
- Branch Release Gate success on the exact final feature head;
- merge and compatibility review against the resulting `main`; and
- required default-branch workflow evidence before the active plan can claim
  completion.

B04 begins only after this milestone is merged and revalidated.

## Plan Amendment Requirements

The RTC implementation plan must be amended rather than supplemented by a
contradictory side document. The amendment updates:

- goal and global navigation constraints;
- current implementation and consumer map;
- existing harness coverage;
- every accepted catalog entrypoint and source/config path;
- root commands and the `scripts/perf/README.md` cross-navigation link;
- correctness and measurement-instrumentation commands;
- the obsolete 400-line gate;
- overlap and exact write reservations;
- responsibility and interface maps;
- Task 4 exit state;
- new Tasks 4A and 4B;
- Tasks 5-12 paths and prerequisites;
- completion gates; and
- the progress record.

The plan must include a complete legacy baseline and exit criteria for this
affected surface and end the reorganization milestone with the repository's
required Complete Code and Legacy Review.

The cross-program roadmap must receive the new plan blob and path reservation
before implementation activation. The existing exact-blob and activation rules
remain in force; approval of this design does not silently activate source
moves.

## Compatibility And Rollback

This work changes repository organization and tooling entry paths. It does not
change product package exports, network protocols, authoritative RTC state,
runtime behavior, accepted artifact schemas, or frozen workload definitions.

There are no compatibility wrappers at old script paths. Root npm commands and
the README are the supported human entrypoints. A rollback reverts the complete
Task 4A package move, catalog path update, command update, and test move as one
unit. It must not leave duplicate implementations in both locations.

Task 4B structural corrections are separate reviewable commits after Task 4A's
parity checkpoint. If a correction cannot preserve a frozen measurement or
evidence contract, work stops for a specific human plan decision rather than
silently broadening the refactor.

## Non-Goals

This milestone does not:

- reimplement RTC or WebRTC;
- move product RTC behavior into the benchmark package;
- optimize a measured hotspot;
- capture a performance baseline;
- change B01-B05 workloads or evidence policy;
- activate B06 or B07;
- add a general benchmark framework;
- make diagnostics accepted evidence; or
- introduce a runtime dependency on benchmark code.

## Success Criteria

The design is realized when:

1. `packages/shared-rtc-bench/**` is the single human entry point for every RTC
   and WebRTC performance program.
2. Folder names expose program class and capability without historical plan
   knowledge.
3. The README maps every command from purpose to measured implementation and
   test.
4. All benchmark tests live in and mirror the package.
5. Benchmark implementation has no dependency on tests, scripts, or apps.
6. Product/runtime code has no dependency on the benchmark package.
7. The three former historical probes are maintained, checked diagnostics or
   are deleted as superseded through the explicit review ledger.
8. Accepted baseline behavior remains semantically identical after relocation.
9. The major review resolves all Critical and Important findings and classifies
   every affected legacy item.
10. B04 and baseline capture remain blocked until the reorganized package and
    reviews are merged and externally gated.
