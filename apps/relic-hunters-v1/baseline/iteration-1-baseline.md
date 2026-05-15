# Relic Hunters V1 Iteration 1 Baseline

Date: 2026-05-15

## Scope

This baseline records the current state before changing gameplay, layout, rendering, or Rallar integration.

Iteration 1 deliverables:

- known issues list
- screenshots where reachable
- current bundle and frame timing notes
- current Rallar event flow
- manual QA checklist

## Verification Commands

Frontend validation:

```bash
npm --workspace relic-hunters-v1 run typecheck
npm --workspace relic-hunters-v1 run build
```

Both passed.

Server validation:

```bash
cd apps/relic-hunter-server-v1
deno task check
```

This failed before the server could be used for authenticated-state screenshots. The failure is a Temporal type split between global `Temporal` types and the app-local `@js-temporal/polyfill` types pulled through `node_modules/.deno`. The first error is in `packages/shared-server/postgres/queuebox/PSqlQueueBox.ts`, and the check reported 44 errors.

## Screenshots

Captured screenshots:

| State | Viewport | File |
| --- | --- | --- |
| Signed out | 1440x900 | `baseline/screenshots/signed-out-desktop.png` |
| Signed out | 390x844 | `baseline/screenshots/signed-out-mobile.png` |

Pending screenshots:

| State | Reason not captured |
| --- | --- |
| Lobby | Requires running authenticated Relic Hunter server and test users. Server check currently fails. |
| Planning | Requires running authenticated Relic Hunter server and at least one joined expedition. |
| Waiting | Requires two-player or multi-player run with submitted and unsubmitted players. |
| Finished | Requires a complete or seeded game state. |

## Bundle Baseline

Built output from `npm --workspace relic-hunters-v1 run build`:

| Asset | Size |
| --- | ---: |
| `dist/assets/babylon-BOqI6WSp.js` | 3,074,751 bytes |
| `dist/assets/index-Cd-mptNi.js` | 919,748 bytes |
| `dist/assets/react-DyDP3OYo.js` | 189,637 bytes |
| `dist/assets/index-oCO65bPi.css` | 45,427 bytes |
| `dist/assets/rolldown-runtime-S-ySWqyJ.js` | 694 bytes |
| Total measured JS/CSS | 4,230,257 bytes |

Vite reported gzip sizes:

| Asset | Gzip size |
| --- | ---: |
| Babylon chunk | 692.72 kB |
| App chunk | 228.88 kB |
| React chunk | 59.64 kB |
| CSS | 10.23 kB |

The Babylon chunk triggers Vite's large chunk warning.

## Frame Timing Probe

Measured in headless Chromium after skipping the intro, signed-out state, 1440x900 viewport, 180 `requestAnimationFrame` samples:

```json
{
  "frames": 180,
  "avgMs": 176.00888888902134,
  "p50Ms": 175.80000007152557,
  "p95Ms": 186.89999997615814,
  "maxMs": 215.19999992847443
}
```

This is useful as a repeatable smoke probe, but it should not be treated as a real player FPS measurement. The headless browser and software rendering environment are likely throttled. Iteration 12 should add in-app frame-time diagnostics from the Babylon engine.

## Known Issues

| Area | Observation | Evidence |
| --- | --- | --- |
| Layout hierarchy | Main UI is composed from many independent fixed or absolute overlays. | `styles.css` contains many `position: fixed` and `position: absolute` HUD elements; screenshots show top status, auth panel, objective card, chronicle, and scene all competing for attention. |
| Mobile layout | Mobile signed-out view stacks large game scene, brand/status, auth form, spacer, and chronicle into a long page. | `signed-out-mobile.png` shows the interaction flow split across vertical regions with duplicated visual weight. |
| Visual sharpness | Signed-out scene is soft and bloom-heavy. | `signed-out-desktop.png` and `signed-out-mobile.png` show blurred geometry and large glowing lights. |
| Controls clarity | The first visible actionable UI is login/register, but the game control model is not communicated until later. | Controls are split across action panel, scene click targets, keyboard shortcuts, touch D-pad, and help overlay. |
| State model | The app has `signed-out`, `connecting`, `connected`, and `error`, but not room/snapshot/listener readiness states. | `useRelicHunters.ts` performs auth restore, `rallar.connect`, room refresh, snapshot fetch, WS listener registration, and REST commands in one hook. |
| Rallar command path | Server defines a Rallar WS command topic, while the client sends commands over REST. | `relic-game-service.ts` defines `rallar.ws.on<RelicCommand>`, but `useRelicHunters.ts` uses `sendRelicCommand`. |
| RTC position path | Scene broadcasts RTC position every 80 ms without exposing health, failures, or readiness to the UI. | `RelicScene.tsx` calls `rallar.messages.rtc.send` in the render-loop path. |
| Server local check | Authenticated screenshots are blocked. | `deno task check` in `apps/relic-hunter-server-v1` fails with Temporal type conflicts. |
| Bundle size | Babylon chunk is large and loaded in the initial app path. | Build output has a 3,074,751 byte Babylon chunk. |

## Current Rallar Event Flow

Observed from `useRelicHunters.ts`, `RelicScene.tsx`, and `relic-game-service.ts`:

1. `main.tsx` configures the browser Rallar facade with `API_BASE_URL`.
2. `useRelicHunters` restores an auth session from local storage.
3. If a session exists, `connect()` calls `rallar.connect()`.
4. After connect, the hook refreshes Rallar rooms with `rallar.rooms.refresh()`.
5. The hook stores `currentRoomId`, room summaries, and a `connected` state.
6. If a room exists, the hook fetches the current game snapshot over REST with `fetchRelicSnapshot(roomId)`.
7. When connected, the hook subscribes to Rallar WS snapshot messages with `rallar.messages.ws.onMessage`.
8. Room state changes are observed with `rallar.rooms.onChange`.
9. Creating or joining a room uses `rallar.rooms.create` or `rallar.rooms.join`, then fetches the game snapshot over REST.
10. Game commands are sent over REST with `sendRelicCommand`.
11. The server applies commands, persists game state, and publishes snapshots with `rallar.ws.publish`.
12. `RelicScene` subscribes to RTC position messages with `rallar.messages.rtc.onMessage`.
13. `RelicScene` sends local position updates through `rallar.messages.rtc.send` from the render loop.

Important interpretation: Rallar operations generally wait on `rallar.connect()` internally, but the game app does not expose a precise readiness model. The next Rallar-focused iteration should introduce explicit phases for auth, middleware connect, room join, snapshot hydration, listener readiness, and RTC position readiness.

## Manual QA Checklist

Run this checklist after each major iteration.

### Startup

- App loads without console errors.
- Intro can be skipped.
- Signed-out state shows login/register clearly.
- Mobile signed-out layout does not overlap controls.

### Auth And Rooms

- Register a new user.
- Log in as an existing user.
- Log out and return to signed-out state.
- Create a new expedition room.
- Refresh room list.
- Join an existing room.
- Room membership count updates when another player joins.

### Lobby

- Select a character.
- Join expedition.
- Confirm ready state.
- Confirm non-admin player waits for keeper/admin.
- Confirm admin can start the expedition.
- Confirm online members and expedition players are distinguishable.

### Planning Round

- Select Move, Search, Steal, and Escape actions.
- Confirm illegal actions explain why they are blocked.
- Confirm target selection is obvious.
- Submit a plan.
- Confirm "plan locked" state is visible.
- Confirm waiting-for-others state is visible.

### Turn Resolution

- Resolve a round with all active players submitted.
- Confirm round events are understandable.
- Confirm player room, health, relics, score, and submitted state update correctly.
- Confirm event timeline does not obscure the next action.

### Rallar And Recovery

- Disconnect/reconnect one browser.
- Confirm snapshot reloads.
- Confirm WS snapshot pushes resume.
- Confirm RTC position updates stop when not connected and resume after reconnect.
- Confirm visible diagnostics when Rallar is degraded.

### Rendering And Controls

- WASD movement works in scene.
- Mouse/pointer look does not trap the player unexpectedly.
- Scene click targets are optional, not required.
- Touch controls appear only on coarse pointer devices.
- Main controls do not overlap scene prompts, minimap, timeline, or status.

### End Game

- Reach the exit with a relic.
- Submit Escape.
- Finish by max rounds or all active players resolved.
- Victory panel explains winner and scoring.

## Iteration 1 Status

Completed:

- frontend typecheck and production build
- signed-out desktop screenshot
- signed-out mobile screenshot
- bundle baseline
- basic headless frame timing probe
- current Rallar event flow documentation
- manual QA checklist
- known issue list

Blocked:

- lobby/planning/waiting/finished screenshots until local Relic Hunter server validation/startup is fixed or a fixture harness is added

Recommended next step:

- either fix `apps/relic-hunter-server-v1` Temporal type conflicts enough to run authenticated baseline captures, or add a fixture-driven UI harness for stable lobby/planning/waiting/finished screenshots without a live server.
