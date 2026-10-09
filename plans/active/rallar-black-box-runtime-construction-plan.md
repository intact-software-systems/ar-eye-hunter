# Black-box Runtime Construction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan with TDD and independent specification/quality review. Steps use checkbox (`- [ ]`) syntax for tracking. Continue the original author/reviewer for this correction to the existing integration task; do not dispatch duplicate task reviews.

**Goal:** Make runtime construction require explicit dependencies, expose named default composition, and update every verified partial caller without retaining the old default-capable signature.

**Architecture:** The existing runtime remains the lifecycle owner. One canonical required input feeds its constructor through the explicit public factory; one default factory assembles overrides and real defaults visibly. All affected callers and tests change in the same coherent slice.

**Tech Stack:** TypeScript 7, Vitest, Deno, the existing native/maintained compiler checks, esbuild, and Brotli quality 11.

**Spec:** [Approved construction spec](./rallar-black-box-runtime-construction.md). Read both documents. Repository active-plan routing overrides the external skill's default location; the live PR remains the delivery record.

## Global Constraints

- “The runtime remains one lifecycle owner.”
- “It selects no defaults.” This governs `createRallarBlackBoxTestRuntime`.
- “Its executor, cleanup, ALM-usage reader, and congestion-counter reader remain optional.”
- “Each default runtime owns an ID sequence beginning at one.”
- “Another runtime starts its own sequence.”
- “The snapshot copies references; it does not deep-clone functions or install generic forwarding behavior.”
- “Selectors, presence polls, message sends, retries, API payloads, and deadlines do not change.”
- “Every changed human-authored file is reviewed and remediated in full.”
- “Every support file modified by that remediation enters closure recursively until closure.”
- “Independent untouched code remains outside closure.”
- “The user's E3 and unrelated-process cleanup hold remains in effect.”

Keep the current repo standard authoritative. No legacy overload, alias, duplicate dependency contract, new default helper, fabricated page reading, or no-op replacement for a previously real default sleep is introduced. Preserve all original failures and genuine tree absences. Root alone owns Git/index/ref/publication operations; the source author must not stage, commit, reset, merge, or push.

## Review Focus

1. Missing argument or any of the three infrastructure fields must be refused by the native construction type contract: Step 2.
2. Caller mutation of any of seven supplied dependencies must not change the constructed runtime: Step 3 snapshot matrix.
3. Replacing `Date.now` after construction must affect default clock reads while supplied clocks remain independent: Step 3 clock cases.
4. Interleaved event/command IDs must share one sequence without leaking across runtime instances: Step 3 ID case.
5. Default sleep must remain pending for a positive interval and release owned waits on cancellation; absent page capabilities must remain absent: Step 3 sleep/absence cases.

---

## Task 1: Close explicit/default construction and its consumers

This is one task because an isolated signature change would leave verified callers incoherent. The deliverable is the complete construction capability, not a file batch or a partially passing public contract. No intermediate feature publication is selected.

### Files and responsibilities

The runtime owner defines input/default composition; production browser/operator callers select it; the existing core test owner holds construction behavior; other tests/support retain their selected dependencies; shared-test architecture describes both entries. These are the 49 minimum existing owners, not a waiver for recursive closure:

- Modify: `apps/rallar-black-box-control-server/test/control-client-failure-evidence.test.ts`
- Modify: `apps/rallar-black-box-control-server/test/control-distributed-api.test.ts`
- Modify: `apps/rallar-black-box-control-server/test/control-distributed-service.test.ts`
- Modify: `apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts`
- Modify: `apps/rallar-black-box-control-server/test/control-recipe-barrier.test.ts`
- Modify: `apps/rallar-black-box-control-server/test/control-reload-prerequisite.test.ts`
- Modify: `apps/rallar-black-box/src/runtime-store.ts`
- Modify: `packages/shared-test/architecture.md`
- Modify: `packages/shared-test/rallar-bb-test/browser-control-agent.ts`
- Modify: `packages/shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts`
- Modify: `packages/tests/rallar-black-box/distributed-recipes.test.ts`
- Modify: `packages/tests/rallar-black-box/distributed-recipes/monitor.test.ts`
- Modify: `packages/tests/shared-test/alm-conformance-audiences.test.ts`
- Modify: `packages/tests/shared-test/alm-conformance-claim.test.ts`
- Modify: `packages/tests/shared-test/alm-conformance-congestion.test.ts`
- Modify: `packages/tests/shared-test/alm-conformance-durable-takeover.test.ts`
- Modify: `packages/tests/shared-test/alm-conformance-leader-ack.test.ts`
- Modify: `packages/tests/shared-test/alm-conformance-membership-fence.test.ts`
- Modify: `packages/tests/shared-test/alm-conformance-recipes.test.ts`
- Modify: `packages/tests/shared-test/alm-conformance-storage-window.test.ts`
- Modify: `packages/tests/shared-test/alm-cross-carrier-duplicate-outcome.test.ts`
- Modify: `packages/tests/shared-test/alm-lifecycle-recipes.test.ts`
- Modify: `packages/tests/shared-test/alm-reload-recipes.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-runtime/composite.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-runtime/create-deterministic-runtime.ts`
- Modify: `packages/tests/shared-test/rallar-bb-runtime/evidence.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-runtime/facade.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-runtime/observers.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-agent-reload.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-assert-operators.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-barrier.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-browser-control-agent.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-cancellation-lifetime.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-capture-acceptance.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-composite-conformance.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-composite-results.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-control-client.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-diagnostics.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-invocation-capture.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-loop-send-observation.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-recipe-format.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-rtc-send-expect-fail-closed.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-targeted-cancellation.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-wait-absence.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-wait-payload-fields.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-wait-result-reference.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test.test.ts`
- Modify: `packages/tests/shared-test/rallar-provider-parity.test.ts`

- Create, ignored test evidence only: `.superpowers/sdd/2026-08-06-rallar-rtc-performance-baseline-plan/integration-repair/child-start-20261009/runtime-construction/native-explicit-input.ts`
- Create, ignored test evidence only: the adjacent `native-explicit-input.tsconfig.json`.
- Cover without changing unless remediation requires it: the three fully supplied callers named in the spec, existing stats/cancellation tests, public entry, and canonical bundle/manifest owners.

### Interfaces

Consume the existing `RallarBlackBoxTestRuntime`, command/event contracts, `sleepWithAbort`, and optional executor/cleanup/page-reader types. Preserve their signatures and behavior.

Produce in `packages/shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts`:

- Exported `CreateRallarBlackBoxTestRuntimeInput`: required `now: () => number`, `sleep: (ms: number, signal?: AbortSignal) => Promise<void>`, `idFactory: (prefix: string) => string`; existing executor, cleanup, ALM usage and congestion reader fields stay optional with their current types.
- Exported `CreateRallarBlackBoxTestRuntimeOptions = Partial<CreateRallarBlackBoxTestRuntimeInput>`: the meaningful sparse override shape.
- `createRallarBlackBoxTestRuntime(input: CreateRallarBlackBoxTestRuntimeInput): RallarBlackBoxTestRuntime`.
- `createDefaultRallarBlackBoxTestRuntime(options: CreateRallarBlackBoxTestRuntimeOptions = {}): RallarBlackBoxTestRuntime`.

The public `mod.ts` already re-exports the owner. Do not add another wrapper or barrel. The private class uses the canonical input, removing its duplicate `Dependencies` declaration.

- [ ] **Step 1: Preserve the admitted source and recover all affected owners**

Read all 49 complete owners, nearby examples/tests, the approved spec, the current source review and its factory clarification. Revalidate the existing source/consumer bindings before mutation. Preserve the original ten-owner integration freeze and diagnosis artifacts as preimages; expanded owners receive exact current and available Git preimages, with absence recorded honestly. Resolve full-file standards within every actual touched owner and recursively admitted support file; independent untouched code stays outside closure. Report any expansion at the next checkpoint without creating another task or requesting a debt waiver.

- [ ] **Step 2: Write and observe the native required-input RED**

The ignored native fixture imports only the existing factory through `@shared-test/rallar-bb-test/mod.ts`, so a missing new export cannot mask the signature witness:

```ts
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/mod.ts';
const explicit = {
    now: () => 1_000,
    sleep: async (_ms: number, _signal?: AbortSignal) => undefined,
    idFactory: (prefix: string) => prefix
};
createRallarBlackBoxTestRuntime(explicit);
// @ts-expect-error the argument is required
createRallarBlackBoxTestRuntime();
// @ts-expect-error now is required
createRallarBlackBoxTestRuntime({ sleep: explicit.sleep, idFactory: explicit.idFactory });
// @ts-expect-error sleep is required
createRallarBlackBoxTestRuntime({ now: explicit.now, idFactory: explicit.idFactory });
// @ts-expect-error idFactory is required
createRallarBlackBoxTestRuntime({ now: explicit.now, sleep: explicit.sleep });
```

Its config extends `../../../../../../packages/shared-test/tsconfig.json`, includes `native-explicit-input.ts` and `../../../../../../types/**/*.d.ts`, and changes no compiler options. The no-op function here is compile-only explicit input, never a runtime default.

Run:
`npx tsc --noEmit -p .superpowers/sdd/2026-08-06-rallar-rtc-performance-baseline-plan/integration-repair/child-start-20261009/runtime-construction/native-explicit-input.tsconfig.json`

Expected current RED: four TS2578 unused expected-error directives because the old signature accepts the forbidden calls; the complete input has no diagnostic. Preserve full output. Dependency/setup failures do not establish this RED. After implementation, the same fixture must exit 0. Add public type-import positive controls for the new input/options once the contract witness is established.

- [ ] **Step 3: Add construction behavior cases and observe the new-entry RED**

Add cases in `packages/tests/shared-test/rallar-bb-test.test.ts`, using the real public entry and existing runtime commands. Preserve all independent existing coverage. Name and assert these cases:

| Test name | Actions and independent assertions |
| --- | --- |
| `constructs a default runtime through the public entry` | Construct `createDefaultRallarBlackBoxTestRuntime()`, execute `{ kind: 'health' }`, assert `expect(result.ok).toBe(true)`. |
| `shares default IDs across prefixes and isolates runtime instances` | Construct A/B. A records `{ kind: 'event', topic: 'construction.first' }`; capture its event. A executes health with omitted commandId. B records its first event. Assert `expect(firstA.eventId).toBe('event-1')`, `expect(healthA.commandId).toBe('command-2')`, `expect(firstB.eventId).toBe('event-1')`. Do not assert unrelated diagnostic/event order. |
| `reads the current default clock function after construction` | Replace `Date.now` with a 1,000-valued function, construct, record one event, replace the function with a 2,000-valued function, record another. Assert `expect(eventTimes).toEqual([1_000, 2_000])`. Restore the original descriptor in `finally`; changing only one mock's return value would not catch a captured function. |
| `uses each supplied infrastructure override without replacing other defaults` | Separate now/sleep/idFactory override cells. The clock cell asserts event time 1,000; the ID cell asserts the supplied event/command prefix values. With controlled Date and a two-iteration loop (`intervalMs: 10`, child health), the sleep cell asserts `expect(sleptMs).toEqual([10])` and two successful iterations. Default the other two fields in each cell. |
| `snapshots every supplied dependency for explicit and default construction` | For both entries, construct from a mutable object then replace each of its seven callbacks before using the corresponding public port. Assert original time 1,000, original IDs, original sleeper's captured 10ms interval, executor result `{ owner: 'initial' }`, original cleanup's external resource record, and original valid ledger/congestion values in stats. Each replacement uses a distinguishable `replacement` marker/value. Share the meaningful matrix, not a generic callback/field walker or a second runtime harness. |
| `keeps absent optional capabilities absent` | Both factories with just required infrastructure/defaults execute stats without page readers. Assert `expect(stats.value).not.toHaveProperty('rallar.alm')` and `expect(stats.value).not.toHaveProperty('rallar.congestion')`. Do not install fake zero readings or a cleanup/executor provider. |
| `paces and cancels a loop using real default sleep` | With owned fake clock/timers, run a two-iteration health loop at 10ms. Before 10ms, assert that the second iteration has not completed; after advancing 10ms, assert two iterations and success. In a separate cancellation cell cancel while its positive wait is pending, assert `expect(result.status).toBe('cancelled')` and no retained owned timer. Restore timers in `finally`; retain existing test deadlines. |
| `preserves nonpositive and pre-aborted sleep outcomes` | At the existing owned `sleepWithAbort` boundary, an already-aborted signal with reason `new Error('owned-abort')` still resolves for 0 and -1; 1 rejects with that exact reason. This is preservation coverage, alongside the runtime default-wiring loop, not a new defect claim. |

Run:
`npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts --reporter=verbose`

Expected new-entry RED: the current public entry lacks `createDefaultRallarBlackBoxTestRuntime`. Distinguish this absent-capability failure from unrelated loading/setup failures. Existing behavior/owned sleep cases that are immediately GREEN remain labelled preservation coverage. Do not manufacture a semantic regression or add overlapping tests just to increase counts.

- [ ] **Step 4: Implement the explicit/default boundary in the runtime owner**

Add the canonical required input and sparse options types using current imported types. The explicit factory copies the seven fields into a new owned object and constructs the existing runtime; it has no default parameter or default selections. Its constructor/property use the canonical input.

The default factory owns `let sequence = 1`, chooses `options.now ?? (() => Date.now())`, `options.sleep ?? sleepWithAbort`, and the supplied ID factory or ``(prefix) => `${prefix}-${sequence++}```; forward the four genuinely optional capabilities as absent when absent. It calls the explicit factory with the complete object. Remove `toRuntimeDependencies`, the duplicate dependency contract and `createSequentialIdFactory`. Do not change the lifecycle body or both-awaits/publication fence to satisfy construction tests.

- [ ] **Step 5: Update all verified partial callers and package navigation**

Update the 157 partial/no-argument calls and imports in the listed 47 caller files to the default entry; preserve each selected option. Keep the three fully supplied callers on the explicit entry. In the deterministic helper retain its clock/ID callback choices and the same real default sleep. Update `packages/shared-test/architecture.md` to distinguish explicit construction from defaults. No compatibility alias/overload is added. Recheck the parser inventory and report actual counts; source counts supplement native typing rather than proving behavior.

- [ ] **Step 6: Finish full-file recursive standards closure**

Review/remediate every actually changed human-authored file in full, including pre-existing affected legacy and aliases. Admit each changed support file recursively, with preserved preimages and a stated reason. Keep genuine optional capability absence; do not fill it merely for a style metric. Preserve the original source classifications as evidence, but obtain fresh canonical facts for the changed owner. A new finding must be diagnosed and resolved or legitimately adjudicated on current merits; there is no authority to widen matchers/caps or retain a real violation. A genuine new public compatibility/retention decision still requires its own human decision.

- [ ] **Step 7: Observe native contract GREEN**

Run the exact Step 2 native command again. Expected exit 0, all four forbidden calls genuinely diagnosed under their expected-error annotations, complete input and canonical public input/options type controls accepted, optional capabilities absent without fabricated values. Preserve both original RED and final GREEN.

- [ ] **Step 8: Run direct runtime and lifecycle GREEN**

Run:
`npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-runtime/stats.test.ts packages/tests/shared-test/rallar-bb-test-cancellation-lifetime.test.ts packages/tests/shared-test/rallar-bb-test-targeted-cancellation.test.ts packages/tests/shared-test/rallar-bb-test-loop-until.test.ts --reporter=verbose`

Expected all selected tests pass, including the existing stats/control-assignment fence cases. Keep original assertions/deadlines; do not retry an unexplained failure or attribute it to host pressure without evidence.

- [ ] **Step 9: Run affected package/test-consumer coverage**

Run:
`npx vitest run packages/tests/shared-test packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/distributed-recipes/monitor.test.ts`

Expected all selected tests pass. This covers capture/recipe/ALM contracts and updated test/support consumers. Preserve any original failure completely before diagnosis.

- [ ] **Step 10: Check native package typing**

Run: `npm --workspace @ar-eye-hunter/shared-test run check:ts`.
Expected exit 0. Native compiler errors remain distinct from maintained test-typing results.

- [ ] **Step 11: Check maintained test typing**

Run: `npm run typecheck:tests`.
Expected exit 0 and zero enforced consumer errors. Do not relax checks or debt admission.

- [ ] **Step 12: Check and exercise the Deno consumers**

From `apps/rallar-black-box-control-server`, run `deno task check`; expected main/test typing exits 0. Then run:
`deno test --allow-run --allow-net --allow-env --allow-read --allow-write test/control-client-failure-evidence.test.ts test/control-distributed-api.test.ts test/control-distributed-service.test.ts test/control-generated-alm-reload.test.ts test/control-recipe-barrier.test.ts test/control-reload-prerequisite.test.ts`
Expected the six changed consumer suites pass. These are local correctness checks; no deployed Actions/HOST/RUN or E3 acceptance follows.

- [ ] **Step 13: Build the affected production consumers**

Run `npm --workspace rallar-black-box run build`, then `npm run build:rallar-black-box-headless` sequentially. Expected both exit 0; record actual warnings rather than treating them as failures or silently omitting them. No deploy/worker/measurement launch is selected.

- [ ] **Step 14: Verify canonical artifacts and fresh bundle measurements**

Run `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check`; expected exit 0 and unchanged generated manifests. A failure is diagnosed against canonical owners before any regeneration, not patched by hand.

Run `npm --prefix packages/shared-web run measure:browser-bundles`, then `npm --prefix packages/shared-web run check:browser-bundles`; expected the real budgets pass. Run `npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`; expected the headless budget and forbidden-input boundary pass.

Retain exact raw bytes/SHA and Brotli-11 measurements. For headless, use the boundary test's actual build options with a unique ignored output path under `tmp/perf/`, preserving its metafile. Do not substitute Vite-reported size or reuse previous-code measurements. A measured budget failure is diagnosed/reviewed; no cap bypass or speculative threshold adjustment is released.

- [ ] **Step 15: Run changed-source facts and freeze the whole correction**

Run `npm run check:repo-style:changed -- e71db5f0ad4b30eee992ff21539a338c4c1fc6c6 WORKTREE`, `npm run check:repo-structure -- --base e71db5f0ad4b30eee992ff21539a338c4c1fc6c6`, and `npm run check:test-structure-coupling`. Inspect every new coupling finding on its merits; a full-registry pass does not prove changed-range classification. The coupling CLI accepts committed refs for `--changed`, so do not pass `WORKTREE` to that mode. Working gates use pre-merge ancestry; they do not replace Root's eventual immutable-main gate. Record complete results and any remaining pressure, not only exit codes.

Join all owned commands. Seal every actual changed source owner, preserved preimage, generated output, raw RED/GREEN/build/check log and exact dependency/environment limitation. Keep the old freeze/report untouched. Stop source edits and send Root a complete correction report; no staging or commit.

- [ ] **Step 16: Obtain the original independent correction review**

Root supplies the actual bounded correction, the approved spec/plan, full owner scope/preimages and fresh evidence to the original independent reviewer. Require separate specification and complete file-quality verdicts. Address real findings with the same author and return only the actual correction for re-review. Do not narrow full-file closure, duplicate reviewer seats or treat green tools as a human standards waiver.

- [ ] **Step 17: Root completes source integration and feature publication**

Only after both task verdicts approve, Root reviews the staged file list/tree, stages the actual merge resolution and coherent correction, and makes the valid feature merge commit. No author-side or manufactured partial merge commit is allowed. Include the reviewed construction documents at a valid publication boundary; delete these active documents before the PR finishing them merges, as repo policy requires.

Before broad final validation, run `npm run pr:delivery -- status`; preserve the intentional stacked base rather than retargeting to appease the helper. Resolve the verified current main commit and new feature HEAD, then run `npm run check:repo-style:changed -- <main-commit> <feature-commit>` and `npm run check:test-structure-coupling -- --changed <main-commit> <feature-commit>` using those literal immutable commit IDs. Re-evaluate current affected legacy, obtain whole-branch review, update the semantic PR explanation, publish the feature ref and verify fresh CI/remote state. Preserve failed original full-suite/Temporal evidence; bounded passes do not retroactively turn it green. Final delivery uses the existing repo ready workflow and its actual merge state; default-branch operations retain the user's exact just-in-time approval requirement.

## Later required outcomes

Deployed HOST/RUN verification requires accepted source and exact deployment/configuration-bound evidence; it remains open. Governed E3 remains an explicit goal with zero accepted cohorts, under the user's hold. Original baseline workloads/counts, raw failure retention, and conditional repeat acceptance remain authoritative. This construction plan supplies no substitute cohort, performance conclusion, initial RTC-cause claim, or authorization to stop unrelated processes.
