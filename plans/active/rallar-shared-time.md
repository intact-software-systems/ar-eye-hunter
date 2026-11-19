# Shared time for Rallar rooms

## Product decision

Start with one expiring message between two browsers whose device clocks disagree. Make its deadline survive signing, transport fallback and final delivery. Then prove that a room can recover its presence and pending work after its clock becomes unavailable. Both outcomes have a real consumer in Grumpy Town, and every proposed public timing feature depends on them.

The first customer-facing product should be **shared deadlines**. A live-poll developer can publish one closing instant, explain what each device knows about it, and let the poll authority decide whether a vote arrived in time. A late joiner or returning phone can recover the same deadline from the room's current state. Grumpy Town provides a second consumer with different rules for countdown interruption and host loss. Keep gameplay iteration independent of platform qualification.

## Product options and investment decisions

| Option | Customer and outcome | Benefit and cost | When to invest |
| --- | --- | --- | --- |
| Transport timing | Every connected browser gets consistent handling of message expiry and bounded presence. | Broad reach without app code. Requires calibration at startup, periodic network traffic, and recovery when timing becomes unavailable. Much of the value is invisible. | Begin here. A signed deadline must have the same meaning at creation, admission and final delivery. This is a valuable stopping point for transport-only consumers. |
| Shared deadlines | A poll or game compares an authoritative instant with the connected client's server-time estimate. | Small, demonstrable SDK capability. The public contract must explain uncertainty, disconnects, and who decides acceptance. | First public release candidate once transport and recovery qualification pass. Demonstrate it in a poll and a game before stabilizing the API. |
| Read-only room timelines | A late joiner derives the current phase of a published schedule, such as question, voting, and results. | Reuses deadlines and avoids a server job per transition. The schedule owner still publishes revisions and defines interruption policy. | Start with an example. Promote it to a shared helper when two consumers repeat the same phase and boundary logic. |
| Managed room timelines | A room owner can pause, resume or replace the host while participants recover the same committed phase. | Removes substantial application recovery code. Adds durable state, command authorization, stale-writer fencing, retries, and compatibility obligations. | Pursue only when consumers need Rallar to own transitions. A requirement to perform an effect in an empty room would also need a durable scheduler and idempotent effects. Decide that separately. |

## Starting evidence

The foundation PR supplies an uncached server observation, a connection-scoped time window, calibrated RTC and WebSocket checks, and a separate clock for settling already-owned work. It also makes room presence timing configurable. Signed browser sends now capture the creation epoch before signing. Delivery handles and RTC proof checks use the same connection’s expiry bound. Room entry and renewal stamp leases from the earliest plausible server time. Arrival and reconnect compare the returned session, socket generation and expiry with the live connection. Checkpoint disposal can finish previously owned writes after calibration closes. Director freshness uses the same window and expires with the director’s room presence. Grumpy Town passed all 14 browser scenarios for clock skew, room entry, host loss, timed rounds and rematch. Physical-device suspension remains to be qualified before a mobile recovery claim. [Foundation PR](https://github.com/intact-software-systems/ar-eye-hunter/pull/845) · [Skew qualification and builder decision](https://github.com/intact-software-systems/ar-eye-hunter/issues/836)

## Shared deadline demonstration

The connected SDK comparison and [runnable room poll](../../examples/shared-deadline-poll/README.md) demonstrate a server-owned cutoff, first-ballot replay and recovery after browser reload. The two Chromium sessions run with opposite two-minute wall-clock offsets. One submission arrives in time, and another crosses the cutoff in transit. The example authority lives in one process and receives ballots over HTTP.

Grumpy Town now consumes the connected deadline APIs for away-seat recovery across host replacement on [PR #832](https://github.com/intact-software-systems/ar-eye-hunter/pull/832). A poll with two phase boundaries is the next test of read-only room timelines.

## Next two slices

1. **Publish a fixed poll schedule.** One authority publishes the opening and closing epochs together. Its receipt clock admits first ballots only in the half-open voting window. An early attempt can retry when voting opens. Clients show the question, voting or results, with an explicit uncertain state at either boundary. Validate opening and closing equality and retry behavior in the authority tests. Keep the schedule immutable for the poll lifetime. Editing published schedules and stabilizing an SDK timeline API need further consumer evidence.
2. **Recover the phase on first entry.** Run a real browser through preview, voting and results. Open a fresh participant view after closing and verify it derives results from the published record, with the same schedule, tally and disabled voting. Preserve the delayed-ballot and reload checks with opposing device clocks. Run the focused memory-stack journey and typecheck the changed example and fixture.

## Public product and launch evidence

**Shared deadlines.** Expose comparison through the connected client. For a deadline D and valid window [earliest, latest], return *before* when latest < D, *at or after* when earliest ≥ D, and *overlaps* otherwise. Return *unavailable* when the connection lacks a valid sample. The room or domain record owns D. The UI may show “closing” during overlap. The authoritative receiver owns vote or move acceptance. Use a local monotonic clock for animation and elapsed durations.

**Read-only timelines.** Publish a versioned schedule as room state and derive the current phase from that schedule and the time window. A returning client reads the latest revision. Define what it displays when the window straddles a transition. A late client can derive “voting closed” without replaying transitions or requiring a server timer to fire.

**Managed timelines.** If demand warrants this option, settle who may advance or pause a room, what survives host replacement, and whether any transition must take effect while nobody is connected. The server room owner would authorize commands through AppInbox, reject stale revisions, and persist the outcome for reconnecting participants. Keep scoring, winner selection, and other application rules with their domain owner.

**Launch demonstration.** Open one poll on two devices with opposing wall clocks. Cast an in-time vote, background one device, and reopen it after close. Recover the closed poll and show the authoritative disposition of a delayed submission over fallback. Repeat the shared-time behavior in Grumpy Town with its own host-loss policy.

**Operational qualification.** Deploy the server time endpoint before updating clients. Measure calibration startup success and latency, window width and sample age, refresh traffic, clock-loss reasons, and foreground recovery on supported devices. Exercise calibration against one API node and deadline enforcement on another under a documented inter-node skew bound. Use measured network and device results to set supported conditions and accuracy claims. The product promise concerns deadline decisions within those conditions. Screen rendering and simultaneous actuation have separate timing budgets.
