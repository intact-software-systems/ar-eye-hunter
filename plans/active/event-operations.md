# Running pickup events across rooms

An organizer playing on court A can run court B, hand the event to another staff member, and keep both games running. A guest can book days ahead and claim their lobby seat when registration opens for arrival. During play, players can opt into a court-ready notification and put their phones away.

Deliver the plan first, followed by one implementation PR per numbered slice. Start each with a failing behavioral regression through its actual owner. Rallar server and SDK packages own the capabilities. Consumers supply the controls. Use existing AppInbox transactions, room-scoped identities, private WebSocket invalidations and authorized snapshot recovery. Remove superseded paths in touched code. Keep game rules in consumers.

## 1. Watch the event as its organizer

1. Start with two browsers in different rooms. While the organizer plays on A, a player claims on B and a different offer expires. Disconnect the organizer during those changes. The recovered view must show the current players, waiting parties in order, court assignments, individual claim status and deadlines. An ordinary participant and an authorized organizer of a different event cannot read this view.
2. Derive a private view from the event allocation and event-local membership display names. Check the current event organizer on every read. Represent each court occurrence and the event revision. Route hints privately, re-read after a hint or reconnect, and coalesce reads without idle HTTP polling. Keep the organizer in the selected room. Clear the mounted privileged view on access loss.
3. Verify server authorization, SDK state and disposal, missed notices, zero idle traffic, and a thin consumer using only public SDK operations. Run affected unit, type, browser bundle, browser and API-v1 black-box checks.

## 2. Hand over the running event

1. Start with Alex offering control to Sam in court B, then disconnecting. Sam accepts, Alex's delayed moderation command fails and both court occurrences, players and clocks survive. Test cancellation and expiry racing acceptance on two server processes and a lost acceptance response.
2. Offer, cancel and accept through the event mutation owner. Only a present app-authorized organizer in this event can receive control. Recheck eligibility and presence at acceptance and fence those facts with the current event revision and offer identity. Configure the acceptance window with a ten-minute default. Use server time when deciding expiry, including when cleanup is late.
3. Publish private changes to sender and recipient. The previous organizer loses the mounted roster and event management. The new organizer recovers both from any event room. Without a pending offer, disconnect leaves authority with the existing organizer. Preserve independent room and director responsibilities. Exercise rejection of former authority through ordinary room management as well as event commands.

## 3. Reserve a scheduled lobby seat as a guest

A session accepts guest bookings only when enabled by app policy and chosen by its organizer. Existing sessions keep their signed-in-only behavior. Booking lasts from registration opening to the existing claim deadline, including sessions scheduled weeks ahead. The reservation consumes one lobby seat and provides no early room entry or court position.

Use the existing scheduled-room capacity and reservation authority for guest and registered players. Bind a recoverable proof to the browser and the reservation. The same browser can reserve, withdraw, retry a lost response, restart and explicitly claim once at arrival. A second device opening the ordinary link starts an independent visit. Rescheduling releases the seat and requires fresh consent for the new time. Returning players see what changed. Test the competing last-seat race on separate nodes, claim versus expiry, and the same-browser journey with independent credentials and a forwarded link.

## 4. Notify a player when their court is ready

Rallar owns Web Push delivery. Scope explicit opt-in to the event and device for temporary and registered players, across subsequent turns. Use a committed court offer to enqueue delivery; distinguish retry from a new offer using the assignment identity. Support consent withdrawal, event closure, access loss and dead provider subscriptions. Keep private event and player details out of visible notifications. Opening the alert retrieves current authority. An expired alert offers requeue and leaves the original deadline and subsequent allocation intact.

Provide the server delivery integration, SDK consent operations, service worker integration and an installable HTTPS consumer. Foreground event state continues over WebSockets. For the first release, an iPhone player wanting alerts opens the Home Screen app before joining. A guest already playing in Safari keeps that seat and receives setup guidance for a future visit. Test provider retry, duplicate work, revocation, expired offers, notification click recovery and permission refusal through automated boundaries. Qualify two real closed-app notification journeys on the user's iPhone: open a current offer, then open a delayed alert after another player claims. Record actual device observations. Android device qualification follows separately.

## Delivery and evidence

Each slice gets focused red/green evidence, review, and its own PR. Review new shared SDK entry points for bundle boundaries and prove API behavior through black-box tests. Keep the initial implementation detail concentrated on slices 1 and 2; refine slices 3 and 4 against the shipped authorities before writing their code. The final slice retires this plan when the acceptance criteria are met. Account for actual device and HTTPS push delivery dependencies before claiming the last slice qualified.
