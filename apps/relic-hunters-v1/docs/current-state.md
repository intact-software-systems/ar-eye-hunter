# Current State

Last reviewed: 2026-10-24.

## Scope and ownership

The SPA is `apps/relic-hunters-v1`, the paired authority is
`apps/relic-hunter-server-v1`, and shared game contracts/rules live in
`packages/relic-hunters`.

- `src/app.tsx` composes the named `GameHudLayout` regions. Lobby, party, plan,
  map, intel, timeline, score, and overlay presentation live under `src/game/hud/`.
- `src/game/relic-hunters-runtime.ts` owns the authenticated connection, room
  adoption, command delivery, accepted snapshots, subscriptions, and recovery.
  `relic-hunters-browser.ts` binds its external ports to the public Rallar facade.
  `use-relic-hunters.ts` subscribes React to that one runtime owner.
- `use-relic-turn.ts` owns the local draft, legal target selection, round clock,
  keyboard controls, and review continuation. `use-relic-playback.ts` owns HUD
  reveal timing. `use-relic-preferences.ts` owns language, help, and ambient audio.
- `game-view-model.ts` derives current-player state, legal actions, objectives,
  warnings, and submission blockers from the accepted public snapshot.
- `src/game/ai/` owns the advisory planning companion and its presentation.
  Generated proposals must pass domain validation before they can prime a draft.
- `RelicSceneNext.tsx` is the active procedural neon facility renderer. Its
  camera/facility model is `scene/relicSceneNextModel.ts`; cosmetic room-scoped
  motion is `scene/networking.ts`. `OpeningRelicScene.tsx` renders while no
  expedition snapshot is available. The retired castle renderer and disabled
  intro/onboarding implementation are removed.

## Room entry and participation

Relic uses the `rallar-server/default` scope. The shared `RallarRoomEntry` owner
captures a scoped reference and optional code from a link or the visible manual
entry form, retains it in tab-local storage through authentication, and resumes
it before ordinary startup room selection. A new link replaces a saved room.
Denial leaves the destination visible with correction, retry, and cancel controls.
Successful entry retains the room reference and principal identity without its code.
There is no bare-room-ID restore or storage migration fallback.

The lobby supports public, code, and invite-only creation through
`rooms.createAndSwitch`. Code hosts can copy the room link and rotate the code;
the UI displays the server-returned expiry. Invite-only hosts invite and revoke
existing account references. A hunter's own account reference is shown in their
profile; the app does not invent a username directory.

Creation waits for the initiating session's presence before reporting the new
room ready. Session changes fence late completions. Failure to leave the previous
room does not undo an already admitted new room.

Room admission remains separate from **Join Expedition**. The Keeper starts the
expedition, hunters submit plans, the authority resolves them into a shared review
phase, and a continuation advances to planning or final scoring. Returning members
can re-enter after code rotation; an old code cannot admit a new account.

## Transport and authority

Gameplay commands use the Rallar WS command channel when a server identity is
known. REST is used before that identity is available, and reset uses its REST
endpoint. A failed WS attempt is never resent through REST. Snapshot hydration,
WS delivery, RTC repair, and timeout repair all use the same acceptance policy.
The server reads live session and room authority on every AppInbox attempt. Its group revision and
save CAS share the deletion fence; no process-local game cache or serial command queue owns truth.
Only the explicit administrator identity grants Keeper controls, badges and start permission.
Room membership and cosmetic avatar motion never authorize game actions.

Disconnected expedition hunters remain in game state. After the round deadline,
an active hunter can resolve the submitted plans and skip missing ones. Reset
rebuilds the roster. The runtime repairs a missed timeout-resolution snapshot and
cancels its subscriptions/timers when the room or session changes.

## Validation commands

```sh
npm --workspace relic-hunters-v1 run test
npm --workspace relic-hunters-v1 run typecheck
npm --workspace relic-hunters-v1 run build
npx vitest run packages/tests/relic-hunters
npm run test:playwright:relic
npm run test:playwright:relic:full-stack
```

The full-stack command starts a fresh paired server and browser app. Its scenarios
cover two-browser gameplay propagation and private-room entry, sharing, rotation,
and return. The active pull request records exact pass/fail results; this command
catalog is not a claim that every check has passed on every revision.

## Remaining risks

The scene still owns substantial rendering and interaction code, and the HUD is
dense. Visual or transport changes need focused browser evidence. Snapshot
convergence tests do not prove visual interpolation under every WS/RTC disruption.
The shared review phase has no per-viewer acknowledgement barrier, so one accepted
continuation can advance a slower viewer. These are existing behavior boundaries;
private-room admission does not change them.
