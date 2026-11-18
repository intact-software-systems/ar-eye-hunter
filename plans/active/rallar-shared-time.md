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

The foundation PR supplies an uncached server observation, a connection-scoped time window, calibrated RTC and WebSocket checks, and a separate clock for settling already-owned work. It also makes room presence timing configurable. Signed browser sends now capture the creation epoch before signing. Delivery handles and RTC proof checks use the same connection’s expiry bound. Selected-room recovery still uses default browser timers to construct and compare lease expiries. A public clock reader alone would leave these failures in place. [Foundation PR](https://github.com/intact-software-systems/ar-eye-hunter/pull/845) · [Skew qualification and builder decision](https://github.com/intact-software-systems/ar-eye-hunter/issues/836)

## Next two independently testable slices

### 1. Carry one signed deadline from creation to final delivery

Use the smallest failing cross-clock room-entry or play case from the Grumpy Town integration as the reproducer. For a short-lived message, capture the signed creation and expiry fields, which carrier handled it, and the acceptance or rejection at the destination. Run with the sender ahead and behind. This distinguishes an invalid deadline at creation from a valid envelope rejected farther downstream. [Consumer PR](https://github.com/intact-software-systems/ar-eye-hunter/pull/832)

Keep wire semantics in the shared message contract. The browser connection supplies conservative creation time before signing and the latest plausible time for expiry checks. Follow the envelope through the page delivery registry and RTC proof verifier. RTC forwarding preserves the original proof. At WebSocket handoff the server verifies the original envelope against the sender’s registered room key. It issues a recipient-specific copy under server authority and preserves the original deadline. Each of the five low-level message builders requires a named creation epoch.

**Exit evidence.** Show that an in-budget message arrives with opposing device offsets, the same envelope is rejected at equality with its deadline on both carriers, and a delayed fallback or replay cannot extend its life. Exercise the owning package tests and type checks, then rerun the smallest browser case. If room entry still fails before a message is sent, record that boundary and exercise the envelope independently.

### 2. Recover room presence and pending work after clock loss

Follow one bounded room lease through join, renewal, suspension, expiry and reconnection. Evaluate having the client request a duration and the server grant an absolute expiry against the existing persistence and API contracts. Compare any granted expiry using the active calibration window. Keep room selection as recoverable user intent. The authoritative session and connection generation determine whether a restored participant can act.

Trace dirty checkpoints and reserved work across the same interruption. Expired calibration ends new authority while previously owned work can flush or release. Preserve monotonic elapsed time for game ticks and RTT durations. Include ICE or signaling expiry where the reproducer crosses those boundaries.

**Exit evidence.** Run the three independent-browser clock-skew cases tracked in #836, the normal-clock room and rematch regressions, and focused checkpoint and lease tests. Demonstrate bounded interruption, survivor continuation after host loss, refusal of stale work, and successful checkpoint cleanup. Repeat background and foreground recovery on a physical phone before claiming mobile recovery.

## Public product and launch evidence

**Shared deadlines.** Expose comparison through the connected client. For a deadline D and valid window [earliest, latest], return *before* when latest < D, *at or after* when earliest ≥ D, and *overlaps* otherwise. Return *unavailable* when the connection lacks a valid sample. The room or domain record owns D. The UI may show “closing” during overlap. The authoritative receiver owns vote or move acceptance. Use a local monotonic clock for animation and elapsed durations.

**Read-only timelines.** Publish a versioned schedule as room state and derive the current phase from that schedule and the time window. A returning client reads the latest revision. Define what it displays when the window straddles a transition. A late client can derive “voting closed” without replaying transitions or requiring a server timer to fire.

**Managed timelines.** If demand warrants this option, settle who may advance or pause a room, what survives host replacement, and whether any transition must take effect while nobody is connected. The server room owner would authorize commands through AppInbox, reject stale revisions, and persist the outcome for reconnecting participants. Keep scoring, winner selection, and other application rules with their domain owner.

**Launch demonstration.** Open one poll on two devices with opposing wall clocks. Cast an in-time vote, background one device, and reopen it after close. Recover the closed poll and show the authoritative disposition of a delayed submission over fallback. Repeat the shared-time behavior in Grumpy Town with its own host-loss policy.

**Operational qualification.** Deploy the server time endpoint before updating clients. Measure calibration startup success and latency, window width and sample age, refresh traffic, clock-loss reasons, and foreground recovery on supported devices. Exercise calibration against one API node and deadline enforcement on another under a documented inter-node skew bound. Use measured network and device results to set supported conditions and accuracy claims. The product promise concerns deadline decisions within those conditions. Screen rendering and simultaneous actuation have separate timing budgets.
