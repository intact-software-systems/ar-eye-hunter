# CI timing reliability plan

**Goal:** Eliminate the diagnosed causes of the WebSocket dequeue timing failure and headless bundle-boundary timeout while preserving the behavior, coverage and performance boundaries the tests protect.

**Architecture:** Diagnose at the existing queue/sink and build/compression boundaries. Prefer deterministic semantic synchronization and a clearly owned build check over broad retries or changes to production scheduling made only to satisfy a test.

**Tech stack:** Existing Vitest, esbuild, Node Brotli, GitHub Actions and repository validation tooling. No new dependency is planned.

**Specification:** The evidence, guardrails and acceptance below define this independent CI slice. These are two distinct failures, not a claimed shared cause. The implementation PR owns delivery; delete this plan when its outcomes are complete before merge.

## Evidence and limits

- [#745](https://github.com/intact-software-systems/ar-eye-hunter/issues/745) retains an unresolved WebSocket case that observed zero sends while waiting for a full dequeued page. The separate Relic fixture race documented there was already fixed; do not reopen or duplicate it without new evidence.
- In [#775's final release run](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/41795335794), the unchanged headless bundle-boundary test exceeded its five-second limit at 5.261 seconds. The preceding hosted pass took 4.623 seconds; a focused local pass took 3.55 seconds; the unchanged targeted hosted retry took 4.152 seconds. The original build/compression phase timing was not captured. This proves variability, not whether esbuild, compression, startup or contention caused the overrun.
- The bundle test synchronously builds the production entry and compresses it at Brotli quality 11 before checking forbidden dependencies and the maintained size budget. Quality, inputs and budget are part of the measured contract.
- Before execution, check current main and active ALM PRs, including [#777](https://github.com/intact-software-systems/ar-eye-hunter/pull/777). Coordinate any overlap in dequeue/service files; do not fork or revert current publication-policy work.

## Guardrails and alternatives

**Recommended:** establish a controlled failure, then fix its owning lifecycle or measurement placement. Keep each diagnosis and verdict separate.

Rejected shortcuts: blanket timeout inflation, repeat-until-green, automatic whole-lane retries as a repair, reduced message/page counts, weaker authority assertions, lower compression quality, larger bundle budgets, cached bytes from a different source tree, or dropping the test from hosted reachability.

A test may move to a dedicated build/tooling lane only if measurements justify that ownership and the same candidate artifact, dependency exclusions and size assertions still run as a required check. Such a move is not permission to weaken an independent time budget. Any proposed budget change must be presented with its measurement and rationale for explicit approval before implementation.

No legacy or migration code. Reuse current clocks, queue completion and test-support ports where their semantics fit. Do not add a generic scheduler abstraction for one fixture or a new production retry to compensate for test synchronization. React must remain absent from the headless/Deno dependency graph and non-React shared packages.

## Current owners and candidate edits

| Boundary                                    | Current path                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| Dequeue semantic test and its local fixture | `packages/tests/shared/services/ws-dequeue-authority.test.ts`                 |
| Queue execution lifecycle                   | `packages/shared/services/inbox-outbox-engine.ts`                             |
| Dequeue/admission owner                     | `packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts` |
| Native test sink                            | `packages/tests/shared/websocket/test-web-socket.ts`                          |
| Headless build and bundle assertions        | `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`   |
| Size contract                               | `packages/tests/rallar-black-box-headless/headless-bundle-budget.json`        |
| Browser bundle boundary checks              | `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`      |
| Unit/tooling ownership                      | `vitest.config.ts`, `.github/workflows/release-gate.yml`                      |
| Hosted test reachability                    | `npm run check:test-reachability` and its current owning scripts              |

These are investigation/conditional edit paths, not a required diff. Trace current registration, execution, durable completion and native sink publication before changing a production owner.

## Implementation horizon when selected

### 1. Resolve the WebSocket dequeue timing failure

- Reproduce the exact #745 case in isolation and in its current lane. Capture enqueue, engine execution, authority/proof/supersedence reads, commit, native send and cleanup using existing owned ports. A completed engine pass must not be assumed to mean all downstream sends have completed until its contract is established.
- Exercise controlled scheduling: delay authority read, proof read and sink completion separately; hold/release the relevant owned operation, then assert eventual sent payloads and final queue states. Determine whether zero sends means unfinished scheduled work, legitimate rejection, lost wakeup or incorrect fixture readiness.
- Classify the existing read-round assertion. Retain it only as the independently required batching/interaction contract, alongside actual output and authority correctness; do not preserve an incidental helper-call pattern merely because the old test did.
- Add a deterministic regression for the proven fault. If the fixture is wrong, wait for the actual semantic boundary or drive an injected existing scheduler deterministically. If production loses work, fix that owner with unchanged authority, supersedence, cancellation and retry semantics.
- Verify full-page delivery, invalid authority refusal, superseded no-send, committed-policy publication, delayed completion and disposal. Preserve existing coverage rather than adding overlapping copies. Coordinate source changes with active ALM work.

**Deliverable:** A causal explanation and deterministic regression that fails before the repair and passes afterward. An unexplained passing repeat does not close #745.

### 2. Make bundle-boundary validation dependable

- Measure cold/warm build, emitted-byte read, Brotli compression and assertions separately under the isolated test and representative hosted lane. Capture tool versions, source identity, byte counts, wall/CPU time and concurrency; keep generated artifacts under ignored `tmp/perf/`.
- Compare the same candidate several times locally and hosted. Distinguish a real dependency/size violation from execution timeout and runner interruption. Do not infer hosted phase cost from local duration alone.
- After the phase is established, choose the smallest measured correction: remove redundant work using a same-candidate build artifact, place expensive measurement in an explicitly owned required build check, or correct fixture lifecycle/resource contention. Check existing bundle tooling before creating another builder.
- Preserve the exact production entry, target, bundler options, Brotli quality 11, forbidden dependency assertions and current size budget. A reused artifact must have verifiable same-source/toolchain provenance and fail closed when absent or stale; it must not silently reuse a successful predecessor.
- Keep all negative guarantees observable: intentionally introduce a forbidden dependency and an oversized bundle in a temporary validation probe, demonstrate failure, then remove the probe. This proves any new test placement still protects the original boundary. No permanent test should mirror implementation topology.
- If test ownership changes, update the existing unit/tooling/workflow selection coherently and run reachability proof. Remove the superseded path rather than running duplicate costly measurements indefinitely.

**Deliverable:** The same bundle contract enforced reliably in local and required hosted validation, with measured phase attribution and no concealed timeout/size relaxation.

## Review focus

1. Delayed authority must never produce a send under stale or missing permission.
2. Completion synchronization must observe committed behavior, not a private callback that can run before commit.
3. Teardown must drain/cancel owned work without contaminating later tests or losing errors.
4. A cached or relocated bundle check must reject another candidate/toolchain's artifact and still detect forbidden imports/oversize output.
5. CI classification must retain every semantic test exactly where a required lane executes it; moving a test cannot silently remove coverage.

## Validation and exit

```sh
npx vitest run --project unit packages/tests/shared/services/ws-dequeue-authority.test.ts
npx vitest run --project unit packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts
npx vitest run packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
npm run test:unit:main
npm run test:unit:tooling
npm run check:test-reachability
npm run typecheck:tests
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
```

Select affected package checks and workflow tests from the current testing skill. If only fixture/build-check ownership changes, do not invent a production performance claim or a live rollout. If a production queue, authority or retry path changes, run its focused correctness/convergence tests, required state-write comparison when applicable, medium-scale PostgreSQL, local/hosted affected recipes, GitHub Free and selected Hetzner validation. Existing hosted browser lanes remain required where their runtime changes.

Complete one unchanged full local lane and two unchanged hosted runs of the corrected affected lane, including at least one full Branch Release Gate. Repeated success is robustness evidence; the controlled regression or measured phase correction supplies causality. Report all failures and their disposition rather than hiding earlier attempts.

Every changed human-authored file is reviewed and remediated in full. Supporting files changed during remediation enter closure recursively; independent untouched code stays outside closure. Completion requires independent review, retained semantic guarantees, explicit issue disposition, and green required CI. If a cause remains inconclusive, publish the measurement limits and keep that item open rather than calling it fixed.
