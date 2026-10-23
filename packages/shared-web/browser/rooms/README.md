# Browser room ownership

`browser-rallar-rooms.ts` composes the public `rallar.rooms` facade. Its public inputs,
results, and state live in `rallar-room-contracts.ts`. Start at the concrete facade
method, then follow its named workflow below.

| Capability                                                                 | Owner                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Private link, pending sign-in destination, scoped reload, and cancellation | `rallar-room-entry.ts`; optional public entry point `../rallar-room-entry.ts`     |
| Create and adopt a room                                                    | `create-and-join-room.ts`                                                         |
| Join, Quick Join, adopt a destination, and clean up the previous room      | `join-room.ts`                                                                    |
| Leave membership and presence                                              | `leave-room.ts`                                                                   |
| Invite, revoke, rotate codes, and govern members                           | `room-membership.ts`                                                              |
| Apply a targeted room mutation and accept its snapshot                     | `update-room.ts`                                                                  |
| Resolve scope and fence replaced sessions or aborted operations            | `room-target.ts`, `room-session-fence.ts`                                         |
| Observe current state, presence readiness, and accepted transport targets  | `room-state-store.ts`, `room-presence.ts`, `room-transport-target-observation.ts` |
| Plan and observe formation/layout commands                                 | `formation/`                                                                      |

The group-state workflows own command identity and HTTP retry policy. Creation,
admission, and presence use `room-group-state-workflows.ts`; lifecycle/configuration
uses `room-group-state-mutation-workflows.ts`; membership policy operations use
`room-membership-group-state-workflows.ts`. Their HTTP boundary is
`room-group-state-http-api.ts`, and canonical state-to-room translation is
`room-group-state-translation.ts`.

`RallarRoomEntry` coordinates browser intent and persistence. It delegates admission
to the existing join facade; it does not authorize membership or implement another
join algorithm. The server's AppInbox operations remain the mutation authority.
Room admission and an application's activity participation are separate decisions.
