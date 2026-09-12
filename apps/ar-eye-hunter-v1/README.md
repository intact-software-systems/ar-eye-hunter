# AR Eye Hunter browser app

`src/main.tsx` configures the browser facade, auth storage and Temporal, then
mounts `src/app.tsx`. App composes the existing arena presentation, operations,
match result and diagnostics surfaces in `src/arena-ui/`.

## Read-first runtime map

Start at `src/game/arena-runtime/use-rallar-arena.ts`. It constructs the hook
inputs from React-owned state and supplies production clocks at the composition
boundary. The runtime families have these entry and exit owners:

| Flow                                         | Entry and policy                                                                                                                                                                              | Result and cleanup                                                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and room selection            | `actions/use-arena-session-actions.ts` uses the browser auth/rooms facade                                                                                                                     | `transport/use-arena-connection-session-lifecycle.ts` starts the session, publishes connection state, and owns subscriptions/timers                  |
| Match lifetime                               | `match/use-arena-match-runtime.ts` creates one match for the current room/generation                                                                                                          | Cleanup stops that match; asynchronous continuation checks session identity and generation                                                           |
| Director appointment and capability delivery | `match/use-arena-director-appointment.ts` owns attempt identity and the WS delivery subscription                                                                                              | `match/to-director-attempt-state.ts` projects lifecycle evidence; `arena-ui/diagnostics-drawer.tsx` shows it beside appointment status               |
| Match inputs and intents                     | `match/create-arena-match-runtime.ts` registers envelope callbacks; `match/handlers/accept-arena-match-input.ts` and `accept-arena-match-intent.ts` validate the sender and apply game policy | Hit/pickup snapshots publish through their captured match after rechecking room and generation                                                       |
| Incoming presentation events                 | `messages/use-arena-director-message-handler.ts` and `use-arena-peer-message-handlers.ts` receive typed game messages                                                                         | Canonical director output applies accepted state; peer receive validates the only raw fallback (scoped accepted shots) before shared shot projection |
| Outgoing snapshots and diagnostics           | `transport/use-arena-network-transport-support.ts` owns snapshot scheduling; `actions/use-arena-diagnostic-actions.ts` owns explicit diagnostic refreshes                                     | Current-generation checks guard publication; `actions/read-http-probe.ts` releases abort listeners and timeout                                       |
| AI proposal lifecycle                        | `ai/start-arena-ai-director-schedule.ts` owns generation timers                                                                                                                               | `ai/generate-arena-ai-director-output.ts` validates a proposal before accepted event publication; schedule cleanup rejects late work                 |

Capability delivery reuses the shared message handle. Appointment completion
does not end delivery observation. Replacement, network-generation end and
unmount unsubscribe from observation without cancelling the message. Transport
acceptance and acknowledgement are hop evidence; loss of observation is shown
as observation lost. The shared registry remains the lifecycle authority.

Behavior tests live in `packages/tests/ar-eye-hunter-v1/`. The authenticated
Playwright delivery test in `tests/playwright/ar-eye-hunter/` uses the real arena
controls and an explicitly enabled API-v1 memory fixture on port 8080. The app
Playwright configuration serves the SPA on port 5186. Its desktop delivery project
checks authenticated diagnostics, and its three mobile projects retain the
landscape controls and portrait rotation checks. No database migration is
required for that fixture.

The raw accepted-shot fallback carries its full `roomRef` on the payload. Its
combat-lane listener belongs to `match/use-arena-match-runtime.ts`, validates the
current full room and match generation, and releases on match teardown. Both raw
and director accepted shots use `messages/arena-director-peer-message.ts` for the
same state projection, including deferred ownership checks. Motion uses canonical
game presence. Hit, pickup and match-start actions use canonical game intents,
including the director's local receiver; unused raw intent sends were removed.
The generic game envelope still identifies rooms by `roomId`; this app fallback
repair does not claim full scope isolation for that separate shared protocol.
