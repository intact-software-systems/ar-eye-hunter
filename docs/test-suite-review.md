# Test suite review — 14 November 2026

## Judgment

The suite is large, but the evidence does not justify calling it globally excessive or setting a
percentage reduction target. There are specific opportunities to remove weak checks, combine
overlapping regression scenarios, and reduce setup duplication. There are also real coverage gaps.
A net increase in meaningful coverage is a successful outcome, even if test count rises.

The purpose of this review is collective maintenance after a long period of incremental additions.
The maintainer selected coverage-led reduction and explicitly accepted increased coverage as an
outcome. Test count is a descriptive measure, not the objective.

## Scope and evidence limits

The requested API path is actually `apps/api-v1/test/`, not `apps/api-v1/tests/`. The review covers
that tree, `packages/tests/**`, and `tests/**` at the initial checkout. Counts below describe the
pre-change baseline; they are not a continuously maintained inventory.

All 3,053 JavaScript/TypeScript files in those trees were scanned and parsed, including 2,510
`.test`/`.spec` files and 543 supporting files. A lexical scan counted lines, test declarations,
source-reading, mocks, call-count assertions, waits, and conditional-test indicators. A Babel AST
pass checked declaration bodies for identical text with whitespace removed. Runner configurations,
workflow commands, the existing reachability checker, and the coupling checker were also inspected.
Targeted manual review then followed representative tests and selected candidates into their owners.

This is an exhaustive static census plus targeted semantic review, **not a claim that every test
body has been manually reviewed or every production branch is covered**. Syntax metrics include
comments and embedded fixture text where applicable. Parameterized cases, loops, custom aliases,
projects and conditional registration mean static declarations are not executed test counts.
Identical callback bodies with different fixtures are not duplicate coverage. No full-suite timing,
flake history, mutation score, or instrumented branch-coverage baseline was collected; do not infer
runtime savings or complete absence of coverage from these measurements.

## Volume

| Suite                                        | Test files | Physical test lines | Static declaration sites, approximate |
| -------------------------------------------- | ---------: | ------------------: | ------------------------------------: |
| shared                                       |        564 |             150,986 |                                 4,617 |
| shared-server                                |        639 |             161,426 |                                 3,442 |
| shared-web                                   |        244 |              71,136 |                                 1,812 |
| shared-test                                  |        297 |             106,661 |                                 2,691 |
| rallar-black-box                             |        225 |              88,018 |                                 1,931 |
| repo                                         |        100 |              26,086 |                                   997 |
| hetzner                                      |         22 |               9,581 |                                   178 |
| shared-graph                                 |         32 |               4,962 |                                   124 |
| shared-react                                 |          4 |                 576 |                                    18 |
| ar-eye-hunter                                |          5 |                 922 |                                    33 |
| ar-eye-hunter-v1                             |         35 |               8,426 |                                   217 |
| relic-hunters                                |         27 |               7,616 |                                   195 |
| api-v1 under packages/tests                  |          6 |               2,940 |                                    49 |
| rallar-black-box-headless                    |          3 |                 349 |                                     8 |
| packages/tests helpers and Playwright config |          2 |                 310 |                                     8 |
| tests/playwright                             |        102 |              40,452 |                                   484 |
| apps/api-v1/test                             |        203 |              50,600 |                                   947 |
| **Total**                                    |  **2,510** |         **731,047** |                            **17,751** |

The AST pass found 17,790 recognizable declaration sites inside test files; the small difference
from the lexical total illustrates why neither number is an executed-case total. Median test-file
length is 191 lines. There are 297 files with one lexically recognized declaration, and 19 files
over 1,500 physical lines. These are navigation signals, not automatic reasons to merge or split;
the code standard's literal-data discount was not applied to these raw line counts.

For context, test/source physical-line ratios are approximately 1.36 for shared, 1.29 for
shared-server, 1.51 for shared-web and 2.28 for API-v1. The source denominators are 111,248,
125,153, 47,263 and 22,212 lines respectively. These are descriptive comparisons of their obvious
source trees, not acceptable-ratio thresholds: fixtures, persistence variants and integration
responsibilities differ.

## Quality and consolidation findings

| Area                           | Evidence and judgment                                                                                                                                                                                                                     | Proposed action                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent assertions         | `shared/encoding/base64url.test.ts` checks literal RFC vectors and an independent platform encoder; the canonical SHA-256 test uses literal digests. These are valuable oracles.                                                          | Keep; do not replace literals with production helpers.                                                                                                                                         |
| Storage and concurrency        | Real PostgreSQL overlap, PGlite semantics, memory decisions and browser persistence catch different failures.                                                                                                                             | Preserve distinct backend proofs. Share case data only where the contract is actually identical.                                                                                               |
| Identical bodies               | The scan found 11 groups, 33 callback bodies. Examples include base64 invalid inputs and route-owner parser fixtures. Most differ in inputs or fixtures.                                                                                  | Review data sets, hooks and failure modes before merging. No automatic duplicate deletion.                                                                                                     |
| Cache regression fragmentation | `loaned-memento-set-value.test.ts` separately checks synchronous and asynchronous reads after the same write; it also contains a `LoanedValue` epoch-zero case.                                                                           | Consolidate set/read/get into one complete regression scenario; move the epoch-zero case to its owning suite. Preserve commit, refresh and per-key behavior.                                   |
| Source-only ownership          | `shared-server/rallar-system/group-state/persistence/group-state-persistence-ownership.test.ts` only checks six files for class-declaration strings. It does not exercise persistence or prove IDE navigation.                            | Retire this check after mapping the actual repository behavior tests. Do not add a replacement file-tree ratchet.                                                                              |
| Source-reading tests           | 161 test files contain direct source/file-reading indicators. Some read fixtures or exercise real CLI/bundle artifacts. The full-repository coupling checker reports 738 candidates, 111 awaiting classification, and exits successfully. | Triage by independently meaningful contract; neither blanket deletion nor blanket retention is warranted. The 738/111 figures include paths outside this review's scope.                       |
| Documentation/governance       | `repo/repository-governance.test.ts` pins phrases in guidance; other suites execute actual delivery/governance commands.                                                                                                                  | Keep publication-integrity checks narrowly described. Consolidate repeated phrase checks; use fresh-agent evaluations for behavioral claims. Source checks cannot prove live agent compliance. |
| Public and bundle boundaries   | Public export snapshots, shared-react browser bundles and headless bundle exclusions protect real compatibility/runtime boundaries.                                                                                                       | Keep intentional public names and server/browser exclusion proofs; review incidental internal export-tree pinning separately.                                                                  |
| Browser suite cohesion         | `tabbed-navigation.spec.ts` is 3,158 lines with 30 declaration sites; `full-stack-distributed-recipes.spec.ts` is 2,008 lines with six.                                                                                                   | Review responsibilities and repeated environment setup. Split by user workflow only when it improves diagnosis; splitting alone is not test reduction.                                         |
| Scenario/manifest suites       | `scenario-black-box-config.test.ts` is 2,953 lines; RTC config has 2,279. Validating manifests is useful, but it is not proof that their workloads execute correctly.                                                                     | Keep small contract examples and invalid-input cases; investigate generated or repeated examples against one real end-to-end execution per distinct boundary.                                  |
| Graph                          | Scope isolation, reverse-edge deduplication and version replacement in `shared-graph/repositories-and-create-graph.test.ts` are distinct.                                                                                                 | Keep; investigate property-style invariant coverage for algorithms before removing examples.                                                                                                   |
| UI and game adapters           | Private-room partial failure, scheduled-start re-evaluation and visible moderation controls exercise meaningful consumer behavior.                                                                                                        | Retain consumer integration tests even when lower-level shared logic is also tested. Consolidate repeated policy matrices at their shared owner.                                               |
| Tooling/performance evidence   | Tests of result binding and artifact correctness protect whether performance evidence is trustworthy; they are not themselves performance measurements.                                                                                   | Keep correctness evidence separate from measured performance and from operational workflow source checks.                                                                                      |
| CI repetition                  | Presence-expiry runs twice intentionally, with a comment explaining retained-row contamination.                                                                                                                                           | Keep the repeated run. It verifies cross-invocation isolation, not simply the same assertion twice.                                                                                            |
| Type safety                    | `packages/tests/typecheck-debt.json` records zero outstanding errors.                                                                                                                                                                     | Keep the maintained test typecheck and API typecheck; do not trade them for transpile-only test execution.                                                                                     |

## Gaps and uncertainty

### Confirmed CI execution gap: friends presence

`packages/tests/shared-server/rallar-system/friends/friends-presence.test.ts` declares a
`postgresIt` case, “makes presence retry when a visibility change holding the own profile commits
before it”. It requires `RALLAR_POSTGRES_INTEGRATION=1` and concurrent database connections.
The default unit lane skips it. The PostgreSQL configuration does not include the file, and no
workflow directly selects it with the required environment. The test exists but its live overlap
proof is not exercised by the inspected CI commands.

The existing reachability check reports 2,648 test files repository-wide, 2,643 reached and five
manual, with success. It accounts for files, not active cases or backend variants. This finding
demonstrates that a successful reachability report is weaker than execution coverage.

**Action:** include the existing friends-presence suite in the PostgreSQL configuration; run its
full file against an isolated database with zero skipped cases. Later strengthen execution
accounting to detect conditional cases that are never enabled, using runner outcomes as evidence.

The implementation includes that suite and adds two complementary checks. Reachability now also
uses native Vitest selection for the configured `test:postgres:*` commands. For unselected
`packages/tests/**/*.test.ts` files mentioning `RALLAR_POSTGRES_INTEGRATION`, it compares dynamic
registration with the flag enabled and disabled, preserving repeated-title multiplicity. Fixture
text alone is not treated as conditional coverage. Full PostgreSQL npm runs enable a reporter that
fails on skipped, todo or pending cases; direct filtered local runs can omit that completeness flag.

These checks cover this explicit PostgreSQL registration convention, not every conditional test.
They do not establish that the selected npm commands are invoked by every relevant workflow,
detect every backend switch under an unchanged test name, or audit native Bun-only gates. Native
collection proves registration and selection; only runtime results prove execution. Keep the
existing workflow/file reachability check and real backend runs alongside them.

### Direct assertion gaps: canonical JSON input boundaries

`packages/shared/encoding/canonical-json.ts` explicitly rejects non-finite numbers, sparse arrays,
symbol keys, non-enumerable properties and object accessors. Its six direct tests cover sorting,
array order, undefined array entries, array accessors, cycles and custom object prototypes.
The hash wrapper's literal digest tests cover valid values. Direct examples for several rejection
boundaries, non-execution of object getters, null-prototype objects and repeated non-cyclic
references are absent from those owning suites.

**Action:** add compact, independently expected boundary cases, and demonstrate sensitivity to
representative removed guards in a disposable mutation experiment. This is a local direct-test
gap; the audit does not claim no indirect caller test could detect any of these failures.

### Known manual and measurement gaps

The five manual suites cover Relic focused UI, Relic two-browser propagation, mobile canvas
controls, ALM durable-send latency and deployed Quick Join. Their registry gives owners and
reasons. Manual latency/deployment workloads are intentional; mobile rendering and propagation
remain release-confidence gaps to reassess, not tests to silently delete or blindly enable.

No assertion-strength baseline or per-case execution/skip history was established here. Before
proposing large reductions, collect runner-native durations, retries and conditional-case outcomes
from comparable runs. Use targeted fault injection/mutation for high-risk contracts. Line coverage
can locate unexercised branches but cannot establish assertion quality on its own.

## Criteria for future decisions

For each candidate, identify the production defect it catches; the public/owned boundary exercised;
the independence of its expected value; distinct input partitions and backend semantics; resource
isolation and deterministic synchronization; diagnostic clarity; setup/runtime cost; and whether
CI actually executes it. Use the following dispositions:

- **Keep:** unique behavior, invariant, public compatibility or runtime-boundary proof.
- **Consolidate:** the same failure mode and boundary share redundant setup or scenarios; preserve
  readable case labels and assertions for every distinct input partition.
- **Replace:** a private-structure assertion has a meaningful behavioral requirement worth testing.
- **Remove:** no independent requirement remains, or a named surviving test proves the same break.
- **Add:** an important failure has no effective proof, including tests that exist but never run.
- **Investigate:** evidence is insufficient; a search hit or large file alone is not a verdict.

Avoid merging unrelated assertions into giant journeys merely to lower reported test count.
Parameterized rows still execute tests; `it.each` reduces repetition, not necessarily runtime.
Prefer deletion of redundant _proofs_ and unnecessary setup over cosmetic count reductions.

## Approaches considered

1. Percentage/count reduction: easy to measure, but encourages loss of edge cases and misleading
   giant tests. Rejected as the governing objective.
2. Runtime-first optimization: useful when CI latency is the immediate problem, but requires
   comparable timings and does not answer the collective quality question by itself.
3. **Coverage-led review, selected by the maintainer:** preserve unique proofs, remove demonstrated
   redundancy, close gaps, and measure the resulting volume. It can legitimately increase count.

Implementation proceeds in small, reviewed slices through
`plans/active/test-suite-review.md`. The plan and PR should remain honest about the difference
between completed changes and the broader candidates above.
