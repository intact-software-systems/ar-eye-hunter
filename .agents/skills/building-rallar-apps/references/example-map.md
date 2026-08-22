# Rallar App Example Map

Use this map to start from the smallest current source for the requested
capability. Then inspect its focused tests and current public implementation.

| Need                            | Primary evidence                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Initial browser boot and rooms  | `examples/browser-startup-room`                                                                            |
| Reliable/fallback room messages | `examples/room-message-channel`                                                                            |
| Low-latency room data           | `examples/room-realtime-channel`                                                                           |
| Browser director                | `examples/director-relay`, `apps/ar-eye-hunter-v1`                                                         |
| Motion presentation             | `examples/motion-smoothing`, `apps/relic-hunters-v1/src/game/scene/networking.ts`                          |
| Browser local state             | `examples/browser-data-store`                                                                              |
| Authored collaboration          | `examples/room-crdt-document`                                                                              |
| Server authority                | `examples/server-authoritative-game`, `apps/relic-hunter-server-v1`                                        |
| Server middleware/app data      | `examples/server-middleware`, `examples/server-app-data`                                                   |
| AI proposals                    | `examples/rallar-ai-game-event`, `examples/rallar-ai-server-ollama`                                        |
| Complete runtime boundary       | `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts`, `apps/relic-hunters-v1/docs/scene-contracts.md` |
| Broad game composition          | `apps/ar-eye-hunter-v1/src/game/useRallarArena.ts`                                                         |
| Renderer-neutral planning       | `projects/cash-chase-arena/Cash_Chase_Arena_Rallar_React_Three_Plans.md`                                   |

Inspect the smallest matching source and its tests; do not copy either large
SPA wholesale.
