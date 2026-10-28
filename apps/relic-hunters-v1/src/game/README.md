# Relic browser owners

Start at `../app.tsx` for the rendered regions and at `relic-hunters-runtime.ts`
for connection, room, command, and snapshot state. The runtime is the single
stateful owner; `relic-hunters-browser.ts` supplies the Rallar and authority ports,
and `use-relic-hunters.ts` binds its immutable snapshots to React.

| Question                                         | Owner                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Room destination, sign-in, cancellation, sharing | Runtime plus `hud/relic-room-entry.tsx`, `hud/relic-lobby.tsx`, and `hud/relic-room-hosting.tsx`; shared admission is `RallarRoomEntry` |
| Links, listing, and codes                        | `hud/relic-room-sharing.tsx`                                                                                                            |
| Room invitations                                 | `hud/relic-room-invitations.tsx`                                                                                                        |
| Expedition membership and Keeper controls        | `hud/relic-party.tsx`                                                                                                                   |
| Legal actions and accepted snapshot derivation   | `game-view-model.ts` and `relic-snapshot-ordering.ts`                                                                                   |
| Draft, keyboard, round clock, and submission     | `use-relic-turn.ts` with `hud/relic-plan.tsx`                                                                                           |
| HUD reveal timing and local preferences          | `use-relic-playback.ts` and `use-relic-preferences.ts`                                                                                  |
| Diagnostic defaults and snapshot summaries | `relic-runtime-diagnostics.ts` |
| Command transport and repair                     | Runtime with `send-relic-ws-command.ts` and `to-relic-command-phase.ts`                                                                 |
| Map, intel, timeline, score, overlays            | Named files under `hud/`                                                                                                                |
| Advisory AI and proposal validation              | `ai/`                                                                                                                                   |
| Active scene and cosmetic motion                 | `RelicSceneNext.tsx` with `scene/`; `OpeningRelicScene.tsx` before a snapshot                                                           |

Direct game files own runtime or gameplay behavior. Rendering and HUD already
have separate owners; adding folders around the runtime's private state would
make its session and room fences harder to follow. Full flow and validation
commands are in [the current-state guide](../../docs/current-state.md).
