# Game browser responsiveness implementation plan

## Goal and accepted scope

Address #724 and #764 together in one PR with measured fixes, clickable regression tests,
local and hosted validation, and green CI. No legacy or migration code; avoid duplication.
The approved design is the conversation's room-entry and recovery reliability slice.
Preserve room/account isolation, game authority, scene appearance and gameplay controls.
Do not increase deadlines, skip journeys, or substitute independent browsers for same-session tabs.

## Current evidence and owners

- AR Eye: `ArenaCanvasRuntime` already retains one engine and compiled shaders while
  `ArenaSceneRuntime` replaces room-owned state. Retain those accepted ownership boundaries.
  Existing Quick Join profiling reuses `tmp/perf/ar-eye-browser/cpu-profile/`.
- Relic: `RelicGameScene` in `apps/relic-hunters-v1/src/app.tsx` selects an opening
  renderer whenever no snapshot exists, including restored-session room admission.
  The opening and expedition components each create a WebGL engine.
- On the merged baseline, the unchanged Relic shared-session click journey passes in
  34.8 seconds. A separate sampled run attributes 4.576 seconds of second-tab context
  initialization to the opening scene and 7.608 seconds to the expedition scene.
  These are sampled wall-time stacks, not GPU CPU utilization or proof of a shared AR Eye cause.
- Existing `BrowserTimingCapture`, room browser fixtures, and real game journeys own evidence.
  Generated profiles remain ignored under `tmp/perf/game-browser-responsiveness/`.

## Next two work items

### 1. Remove unnecessary graphics initialization during Relic room admission

- Extend the existing shared-session continuity journey to observe actual WebGL context
  acquisition in the second tab. A restored room destination must initialize only its
  expedition renderer; keep the subsequent clickable leave/re-entry assertions.
- Run the added regression before changing production; verify the failure is the extra context.
- In `RelicGameScene`, distinguish room/session admission from the idle opening presentation.
  Preserve the opening scene for unauthenticated/idle users and watcher rooms without a game.
  Keep entry status and retry/cancel controls available while admission is pending.
- Repeat the same built-SPA journey and profile; compare readiness, context work and failures.
  Run Relic app tests/build and full clickable continuity coverage.

### 2. Repair the measured remaining AR Eye browser stalls

- Capture the unchanged Quick Join/recovery journeys with the existing CPU/timing wrapper.
  Separate one-time context creation, shader compilation, steady rendering and native navigation.
- Correlate expensive frames with application/graphics work and test one hypothesis at a time.
  Implement only a correction supported by the measured workload; retain shader/engine reuse.
- Add a failing clickable regression for the corrected lifetime or work-suppression behavior,
  then run its red/green cycle and comparable before/after measurements.
- Run AR Eye app tests/build and both games' scheduled-entry, recovery, Move together and
  repeat-play journeys. Publish hosted baseline/candidate evidence and require green CI.

## Review and completion

Review every changed human-authored file in full; recursively include modified support files.
Independent untouched code stays outside closure. Reuse shared mechanisms where semantics match;
React remains in apps or shared-react. Review failures and stale state, Strict Mode/unmount,
room/account replacement, second-tab same-session behavior, and return after renderer inactivity.
Use one fresh whole-branch reviewer after implementation. The PR carries progress and evidence.
Delete this completed plan in the PR before readiness; do not create post-merge bookkeeping.
