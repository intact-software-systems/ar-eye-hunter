# Room lobbies, programs and director succession

A player can keep a place in a named lobby while using another room. A full group can call its absent players back, and someone waiting outside can claim an exclusive offer. Sports and event organizers can later manage a whole program, close its registration on time and replace its director.

## Product decisions

Ordinary room entry is the default. An organizer may enable seat holds and a queue for a finite-capacity room. An application may enable them by default for its capacity-limited rooms. One account may hold one lobby commitment, including waiting, per application and workspace. Switching commitments requires explicit consent. Visiting another room or disconnecting preserves the commitment. A closed lobby ends it.

An away seat holder has no return countdown until the roster fills. An unclaimed offer consumes capacity but counts toward a full roster only on actual arrival. On fill, absent holders get a private notice and a two-minute configurable window to return. Opening a prompt never confirms arrival. A drop below capacity cancels the current return windows. The next fill starts fresh windows. Deadlines use authoritative server time even with every browser closed.

Release offers the seat to the oldest eligible waiter ahead of a simultaneous walk-in. The exclusive claim window defaults to one minute and is configurable. Eligible arrival claims the offer. Decline and expiry offer the place onward. At scheduled registration closure, stop new registrations and offers. Honor previously issued offers until their displayed deadline.

A program pause preserves the current phase balance. Resume shifts the remaining program by the paused duration. Independent UTC deadlines retain their times. Director disconnect preserves running or paused state. Owners and admins can explicitly appoint a replacement at any time. A disconnect opens a configurable 30-second reconnect window. A designated deputy then has a configurable 30-second exclusive claim. Without a deputy, or when the deputy declines or times out, present players may claim. Spectators require appointment or designation. One appointment wins and fences every old command.

## First implementation slice — hold a seat across rooms

1. Trace admission, membership, live session presence, scheduled-session reservations and private matchmaking invalidations from their public entry points. Establish which durable authority serializes room capacity and the account's scoped commitment. Prove all player admission paths obey it.
2. Start with failing behavior tests. Alice holds a place in A while visiting B. A fills, loses a player, and fills again. Deliver the obsolete expiry after the second fill. Alice still holds her seat. At the current deadline account for all holders due at that instant together. A reconnect or room switch cannot impersonate a confirmed arrival.
3. Add server and SDK operations for opt-in policy, commitment, release, private state observation and recovery. Use the existing fenced mutation, receipt, notification and recovery machinery where its guarantees match. Test competing commitments, retries, revocation and ordinary room behavior. Prove the two-room journey through the real server and SDK, including a missed notice and quiet idle network.

## Second implementation slice — queue and exclusive offer

Establish durable queue order and serialize seat release, selection and allocation with new admission. Repeat a release/claim race across two API nodes and a process restart. Verify the oldest eligible account receives one effective offer, a walk-in cannot take it, and replays preserve the receipt. Cover decline, expiry, cancellation, access changes and a successful arrival. Keep private queue identities out of public room snapshots. Reassess the design after testing slice 1.

## Subsequent outcomes

| Order | Outcome | End-to-end evidence |
| --- | --- | --- |
| 3 | Scheduled registration closure | Issue an offer before closure, restart with the organizer offline, then accept before the offer's own expiry. Declining after closure releases capacity without issuing another offer. Use both deadline actions to judge what is reusable. |
| 4 | Whole-program pause and resume | Pause during a phase, resume ten minutes later, retry resume, and recover from another room. Assert one shift, the same phase balance and an unchanged independent venue cutoff. |
| 5 | Admin appointment and deputy succession | The former director reconnects as the deputy claims. Exactly one appointment controls the clock. An explicit admin appointment supersedes it. Run with running and paused programs. |
| 6 | Present-player succession | Race two eligible players after fallback opens. Verify a single winner and reject an away holder, ordinary spectator and commands from a replaced director. |

Qualify server timing on independently hosted directly routed nodes under a maintained offset budget and representative load. Exercise seat claim on one node and expiry on another. Report clock uncertainty separately from durable admission correctness. Local multi-process tests cover consistency and tooling. An operational accuracy claim requires actual independent-node measurements.

## Delivery

Publish the plan first. Build each slice in a separate PR stacked on its predecessor. Start with failing tests, implement the shared product behavior, exercise the public path, and review each slice. At the end of each slice update the concrete next slice using evidence. Keep only the next two slices detailed. Follow repository release checks and leave default-branch merges to the maintainer. Use WebSocket invalidations and authoritative reads on wake or reconnect. Preserve idle operation without periodic HTTP reads. Remove superseded paths as their replacement lands. The final implementation PR retires this plan.
