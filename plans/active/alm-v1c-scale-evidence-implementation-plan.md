# ALM V1c Scale Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Deliver 15/30/50-agent match-payload manifests with sampled ALM budgets and exact controller evidence.

**Architecture:** Shared-test owns a composed reliable workload and native group assertions. The app catalog chooses participants and topology. Existing runtime commands execute the workload without a new runner or delivery abstraction.

**Tech Stack:** Existing TypeScript, Vitest, Deno and GitHub/Hetzner tooling; no new dependencies.

**Spec:** `playground/alm/alm-v1c-design-proposal.md`, implementing D183 in `playground/alm/alm-improvement-plan.md`.

## Global Constraints

- No runtime policy, public delivery contract, migration path, or dependency changes.
- One director and N−1 players; participant counts 15, 30, 50; 45-second RTC readiness allowance; tree topology.
- Six leader-ACK shot intents per player at five-second intervals; two all-recipient-ACK match events; 30-second sampling window; seven samples at five-second intervals.
- Effective delivery policy: volatile, at-least-once, 30-second TTL, rtc-with-ws-fallback.
- Budgets: own admissions 1,000; own bytes 4,194,304; counted oldest age 300,000 ms; own tracks 64; ordering snapshots 512; overloaded false; congestion dropped 0.
- AL admission storage and non-probe AL work storage remain zero after the explicit setup/reset boundary; idle probes excluded explicitly and still recorded.
- Every touched human-authored file is reviewed and remediated in full; each support file changed by remediation enters closure recursively; independent untouched code stays outside closure.
- Requested behavior remains the outcome. Direct tests and affected package/app checks are required. No retained affected legacy, duplicate policy engine, or compatibility alias.
- Every task uses RED → GREEN → refactor and records actual output. Implementers do not dispatch agents. Controller owns fresh task reviews and the final whole-branch review.
- Publish one PR and keep its semantic description current. User merges manually. Delete this implementation plan before readiness; retain the design.

## Review Focus

- A transient excess followed by zero usage must still fail acceptance.
- Absent ALM/congestion samples and incomplete/cancelled sampler evidence must fail closed.
- A partially ready room must not shrink the declared receipt audience and still pass.
- Session, nested envelope, and match identities must agree; valid game payloads alone do not prove receipt delivery.
- Exact controller attribution must survive nested command evidence; duplicate sources must not become a healthy result.

### Task 1: Reusable scale workload and acceptance evidence

**Files:**

- Create owner: `packages/shared-test/rallar-bb-test/conformance/alm/scale/create-alm-scale-recipes.ts`.
- Create cohesive neighboring modules under `.../alm/scale/` only for real payload, setup, or acceptance responsibilities; do not add generic helpers or rename existing types.
- Tests: `packages/tests/shared-test/alm-scale-recipes.test.ts` and, if needed for a meaningful runtime boundary, `packages/tests/shared-test/alm-scale-acceptance.test.ts`.

**Interfaces:**

- Consume existing `RallarBlackBoxTestRecipe`, `RallarBlackBoxTestCommand`, `RallarBlackBoxDistributedGroupAssertion`, `RallarBlackBoxDistributedGroupRef`, `RallarBlackBoxTestRecord`, group-assertion evaluator, runtime, and ensure-group commands.
- Produce `createAlmScaleRecipes(input: AlmScaleRecipeInput): AlmScaleRecipes`.
- `AlmScaleRecipeInput` has required readonly `participantCount: 15 | 30 | 50`, `group: RallarBlackBoxDistributedGroupRef`, and `readyTimeoutMs: number`.
- `AlmScaleRecipes` has required readonly `recipes: readonly RallarBlackBoxTestRecipe[]` (sender then receiver), `groupAssertions: readonly RallarBlackBoxDistributedGroupAssertion[]`, and `metadata: RallarBlackBoxTestRecord`.
- Stable recipe IDs: `alm-scale-director`, `alm-scale-player`; manifest roles stay sender/receiver. Metadata declares cadence, counts, policy, budgets, metric paths, sampling scope and storage reset scope.

- [ ] Step 1: Load applicable repo code/platform/realtime/games/testing/structure skills and required references, then inspect current examples and the fixture/runtime paths in `tmp/alm-v1c/contract-survey.md` and `tmp/alm-v1c/game-payload-survey.md`. Announce closure and exact behavior/check commands before editing.
- [ ] Step 2: Write independent failing tests for supported audiences; schema-valid recipes; AR Eye shot and match wire contracts; coherent identities; selectors; explicit delivery policies; six shots and seven samples; barrier/reset before traffic; exact receipt/typed arrival requirements. Run `npx vitest run packages/tests/shared-test/alm-scale-recipes.test.ts` and record expected RED.
- [ ] Step 3: Implement the declared builder by composing existing commands. Both roles connect with AR Eye topic/intent/event selectors, settle readiness, and use shared barriers. The director appoints itself; players refresh/poll its active status. Reuse ensure-group and membership setup. Avoid the fixed three-role conformance inventory. Unique root command IDs identify sampler, final stats, storage and delivery evidence.
- [ ] Step 4: Author coherent nested relay/game fixtures. Page session placeholders own sender/shot identity. Lifecycle specimens share a match, representative baseline and valid completed results. Use existing loop iteration placeholders for shot sequence/handles. Wait for acknowledged states then assert state/receipt mode/expected and confirmed cardinalities, zero unconfirmed. Type-targeted arrivals enforce six shots per player and two events per player; a workload completion barrier orders the end event after all players finish.
- [ ] Step 5: Write RED tests executing the owned generated sampler through the real command runtime with healthy readings, a transient over-budget reading followed by zero, and missing page metrics. Add native group-evaluator tests with controller IDs for healthy, violating, absent, duplicate and incomplete/cancelled evidence. Assert exact violating/missing IDs, not only overall rollup. Do not duplicate generic runtime tests.
- [ ] Step 6: Implement sampled local assertions and role-scoped group assertions using declared literal budgets and runtime-limit checks. Parallel sampler/workload groups use existing maxConcurrency 2. Require seven completed samples, zero failures and cancelled false for all frozen participants; final stats do not replace sampled evidence. Reset storage after setup and assert named AL storage budgets.
- [ ] Step 7: Run focused new suites plus `packages/tests/shared-test/rallar-bb-runtime/stats.test.ts`, `packages/tests/shared-test/rallar-bb-runtime/composite.test.ts`, `packages/tests/shared-test/alm-conformance-leader-ack.test.ts`, and `packages/tests/shared-test/rallar-bb-test-group-assertion-conformance.test.ts`. Then `npm --workspace @ar-eye-hunter/shared-test run build`, required format/type checks, and the full affected shared-test suite once. Read all touched files and self-review; commit only this task's files on `codex/alm-v1c-scale-evidence`.

### Task 2: Manifest ownership, generated artifacts, and current-candidate scale proof

**Files:**

- Create: `apps/rallar-black-box/src/hetzner/create-alm-scale-manifest-entries.ts`.
- Modify: `apps/rallar-black-box/src/create-hetzner-distributed-manifest-catalog.ts`, `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts` (remove obsolete extended workload owner and its now-unused imports/constants).
- Generate: manifests 19/20/21 in `apps/rallar-black-box/manifests/hetzner/` using the canonical writer.
- Tests: affected ALM/manifest catalog tests under `packages/tests/rallar-black-box/`; split cohesive tests only when full-file closure requires it.
- Documentation: design and existing next-slice prose in `playground/alm/alm-improvement-plan.md`; no delivery ledger/catalog/status files.

**Interfaces:**

- Consume Task 1's exact `createAlmScaleRecipes` interface.
- Produce `createAlmScaleManifestEntries(): readonly HetznerDistributedManifestEntry[]` in the new owner, imported directly by the catalog.
- Reuse `createManifestEntry`, `toControllerAgentIds`, `HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER`, and the canonical manifest group. Preserve numbered paths, 15/30/50 participants, tree topology, live/barrier settings and mainline false; terminal budget may cover explicit ACK waits without hiding failures.

- [ ] Step 1: Write failing manifest tests requiring 15/30/50 frozen role counts, new recipe IDs/payloads, declared budgets, seven-sample enforcement, exact per-role group sources, storage scope and policy. Replace the obsolete assertion that ALM metrics are absent. Verify existing 18/22 and ordinary multicast workload behavior remains. Record RED with the focused manifest suites.
- [ ] Step 2: Wire the new scale owner to Task 1's reusable fixture; remove the old extended implementation entirely. Keep unrelated conformance entries in their existing owner. Run the canonical writer to regenerate manifests, then its `--check` mode. Current full-file standards govern all touched tests/source files, including existing violations.
- [ ] Step 3: Update durable design with applied decisions if evidence changes the design. Link V1c design from roadmap's next-slice prose without PR status metadata. Keep V1d as the next outcome, not an invented implementation plan.
- [ ] Step 4: Run focused catalog/ALM suites, both affected package/app builds, required format/type checks and all affected black-box tests once. Self-review full touched files, commit and report the exact generated file set; no remote dispatch from implementer.
- [ ] Step 5: Controller publishes the reviewed branch/updates the draft PR, runs `npm run pr:delivery -- status` before broad validation, then current-candidate hosted 15/30/50 manifests sequentially using repo ops tooling. Inspect materialized manifest, operation report, rollup, per-agent/group assertion evidence and page failures. Fix any failure through the owning implementer with TDD; do not claim old artifacts as current proof.
- [ ] Step 6: Controller obtains a fresh whole-branch review, resolves findings through implementers, runs remaining selected checks, deletes this completed implementation plan in the PR, updates semantic PR body and runs `npm run pr:delivery -- ready` once only when it cannot arm auto-merge. Wait for the user's manual merge before planning V1d.
