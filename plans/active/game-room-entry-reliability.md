# Game room creation, sharing and return plan

**Goal:** A player can create and share a room, enter it, reload, and return through visible controls in AR Eye and Relic without a blank link, lost visit or unexplained pending entry.

**Architecture:** Preserve the existing room admission and history owners. Repair the measured lifecycle boundary, with app presentation consuming shared browser behavior rather than duplicating it.

**Tech stack:** Existing TypeScript, React, Rallar room services, Vitest and built-SPA Playwright. No new dependency is planned.

**Specification:** The product contract and acceptance below are this plan's specification. This is planned work, not a claim that the reported failures still reproduce on current main. The implementation PR owns delivery; delete this plan when its outcomes are complete, before that PR is merged.

## Product contract and constraints

- A successful code-room creation displays a usable share link for the exact created room and current account. A failed code rotation shows an actionable failure; it never publishes a code from another room or session.
- Opening a shared link retains the destination through sign-in and reload. Cancellation, account changes and replacement destinations fence late completions.
- Recent-room history records an admitted visit after its storage write succeeds. Return rechecks current admission; Forget removes only the shortcut. History failure must not misreport admission failure or repeat admission.
- Keep public, unlisted, code and invite-only access policies, bans, capacity, player/spectator roles and existing membership-preservation behavior. Room entry does not silently join an expedition or abandon unfinished gameplay.
- Preserve real clickable workflows, same-context shared-session tabs and existing action/readiness deadlines. A passing retry alone does not prove a repair.
- Reuse canonical mechanisms. No legacy or migration code, parallel predecessor, app-local duplicate, or forwarding-only module. React belongs only in app UI or `packages/shared-react`; it must not enter shared, shared-web, shared-server, shared-test, shared-graph or Deno apps/lockfiles.
- Apply the current repo standard in full to every changed human-authored file; supporting files changed during remediation enter closure recursively. Independent untouched code stays outside closure.

## Evidence and coordination

- [#712](https://github.com/intact-software-systems/ar-eye-hunter/issues/712) records a created Relic code room with an empty link. Its original failure is established; its cause is not.
- [#738](https://github.com/intact-software-systems/ar-eye-hunter/pull/738) already owns the proven recent-history restart/write race. At activation, check its current state and exact diff. If merged, test the merged implementation. If open, coordinate delivery with that PR; do not copy its patch into a competing implementation or merge it without authorization. Independent sharing work can proceed meanwhile.
- [#724](https://github.com/intact-software-systems/ar-eye-hunter/issues/724) and [#764](https://github.com/intact-software-systems/ar-eye-hunter/issues/764) contain older graphics/startup observations. #765 and #775 subsequently changed graphics lifetimes and rendering cost. Re-establish the remaining symptoms on current main before prescribing another renderer change.
- Existing local/hosted passes establish behavior in those runs, not elimination of every intermittent native-browser stall. Expired artifacts must be replaced by new captures, not cited as newly inspected evidence.

## Current owners and reuse

| Boundary                                                           | Starting owner or evidence                                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Relic creation, rotation and visible link                          | `apps/relic-hunters-v1/src/game/hud/relic-room-hosting.tsx`, `relic-room-sharing.tsx` in the same directory                       |
| Relic room adoption                                                | `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts`                                                                         |
| AR Eye host controls                                               | `apps/ar-eye-hunter-v1/src/arena-ui/arena-room-hosting.tsx`                                                                       |
| Admission and cancellation                                         | `packages/shared-web/browser/rooms/entry/rallar-room-entry.ts` and `packages/shared-web/browser/rooms/join-room.ts`               |
| History persistence                                                | `packages/shared-web/browser/rooms/recent-rooms/rallar-recent-rooms.ts` and `recent-room-history.ts` beside it                    |
| Shared presentation, when a second equivalent consumer is verified | `packages/shared-react`; keep generic lifecycle mechanisms in `packages/shared`                                                   |
| Correct consumer example                                           | `examples/browser-startup-room/README.md`                                                                                         |
| Graphics, only if measured again                                   | `apps/ar-eye-hunter-v1/src/game/scene/arena-scene-runtime.ts`, `apps/relic-hunters-v1/src/game/scene/neon/relic-scene-runtime.ts` |

These are investigation entry points, not an instruction to edit every file. Recover the current creation → presence/adoption → rotation → render path before selecting the correction.

## Approaches

1. **Recommended: reproduce the race at its owned boundary, then repair that owner.** This can distinguish an application lifecycle defect from slow browser progress and retains the current architecture.
2. Replace both room workflows wholesale with a new coordinator. Rejected: no evidence that a replacement owner is needed; it risks duplicating admission, cancellation and history.
3. Raise deadlines or add automatic whole-workflow retries. Rejected: it can conceal a missing link, lost visit or stale-account publication.

## Implementation horizon when selected

### 1. Establish current failures and deterministic regressions

- Run the existing full-stack private-entry, recent-room and shared-session journeys on current main. Capture the exact branch, environment, game/API responses and visible failure. Keep credentials and join codes out of published diagnostics.
- For #712, capture whether creation returned its snapshot, which room was adopted, whether code rotation was requested/completed, and whether a later render cleared the returned code. Separately exercise delayed adoption, delayed rotation, room replacement and account replacement through owned ports. Label each hypothesis confirmed, refuted or inconclusive.
- Start with `tests/playwright/relic-hunters/full-stack-private-room-entry.spec.ts` and `packages/tests/shared-web/rooms/entry/rallar-room-entry.test.ts`. Add a focused test beside the responsible owner only after the failure boundary is identified; retain the visible New code room → copy/open link → guest entry proof.
- For history, use the existing `packages/tests/shared-web/rooms/recent-rooms/rallar-recent-rooms.test.ts` and the shared journey `tests/playwright/room-entry-recovery-journey.ts`. Preserve #738's independently proven case instead of adding an overlapping test.
- For remaining graphics symptoms, correlate request completion with app consumption, renderer sampling and process CPU/RSS. Preserve same-browser-context tabs. Distinguish wall time, CPU work, graphics allocation and native wait; do not name an uncaptured browser-internal cause.

**Deliverable:** Reproducible failure evidence and a semantic regression for every selected repair. If an issue no longer reproduces, record what the current test proves and the remaining uncertainty; do not fabricate a failing case or call an unexplained rerun a fix.

### 2. Repair confirmed boundaries and prove the complete journeys

- Implement the smallest correction in the owner identified above. Bind pending results to account/session, operation and full room scope. Reuse the repository's cancellation, generation, notification and persistence owners after checking their exact semantics.
- Run the regression red before the fix and green afterward. Prove success, refusal, delayed completion, cancellation and cleanup through observable state or captured external effects, not private helper-call topology.
- Exercise both games through visible controls: creation/sharing, guest sign-in, code rotation, account replacement, reload, Return/Forget, Watch and explicit player entry. Preserve old-room membership and unfinished-game rules.
- If graphics work changes, compare the same workload and environment before/after, including idle/terminal pages, next-room rendering, resize and disposal. Require unchanged gameplay assertions; a speed claim needs controlled measurements.
- Publish fixes and evidence to the responsible issue/PR. Close an issue only when its described failure has a demonstrated correction; otherwise narrow its remaining scope explicitly. Do not silently take over #738.

## Review focus

1. Late rotation response after room/account replacement must not reveal the old code.
2. History opening or writing during stop/start must not lose a committed visit or repeat a forgotten one.
3. Admission success followed by presence/adoption failure must retain explicit recovery of that exact room.
4. Shared-session tabs must preserve participation and authorization while observing consistent room state.
5. An idle renderer must still resume for gameplay, receive current network state and release resources on disposal.

## Validation and exit

Focused package tests precede browser suites and app builds. Relevant starting commands:

```sh
npx vitest run packages/tests/shared-web/rooms/entry/rallar-room-entry.test.ts packages/tests/shared-web/rooms/recent-rooms/rallar-recent-rooms.test.ts
DENO_NO_PACKAGE_JSON=1 RELIC_HUNTERS_FULL_STACK=1 RELIC_HUNTERS_BUILT_PREVIEW=1 RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory npx playwright test --config apps/relic-hunters-v1/playwright.full-stack.config.ts tests/playwright/relic-hunters/full-stack-private-room-entry.spec.ts tests/playwright/relic-hunters/full-stack-continuity.spec.ts --project chromium --workers=1 --trace=on
DENO_NO_PACKAGE_JSON=1 RALLAR_ARENA_FULL_STACK=1 RALLAR_BROWSER_TIMING=1 npx playwright test --config apps/ar-eye-hunter-v1/playwright.config.ts tests/playwright/ar-eye-hunter/private-room-entry.spec.ts tests/playwright/ar-eye-hunter/quick-join.spec.ts --project desktop-delivery --workers=1 --trace=on
npm --workspace ar-eye-hunter-v1 run build
npm --workspace relic-hunters-v1 run build
npm run typecheck:tests
```

Run game harnesses serially because they own local services. Include the relevant room-entry-recovery suites when history changes. Use the testing skill's current package checks and public-API/bundle checks if shared exports change. Require hosted clickable lanes and Branch Release Gate. Altered reusable recipes also run locally, hosted and through Run GitHub Free Distributed Recipe. Select Hetzner for actual distributed risk; do not add a rollout merely for a UI-only correction. Any authoritative mutation change also requires AppInbox convergence coverage, medium-scale PostgreSQL and the controlled state-write comparison.

Completion requires full changed-file review, local and hosted evidence, an honest disposition of each selected issue, and green required CI. No new numerical product SLO is implied. Independent remaining performance questions stay outside the finished repair rather than being reported as solved.
