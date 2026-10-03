# RallarActor business brainstorm

Prepared: 2026-10-03. This note accompanies
[the RallarActor product proposal](./rallar-actor.md) and the
[market survey](./rallar-actor-market-survey.md). It is a brainstorm. It is
not an adopted offer, a price list, or a change to `docs/product.md`.

## What this repository already plans

There is no company business plan, pricing page, or go-to-market document in
the repository. The documents that do exist set product boundaries a business
offer would have to respect.

**The platform description** in `docs/product.md` is the standing product
boundary. Rallar is browser-first. Rooms, presence, validated events, and
peer updates are the offer. Turn-based and social rooms are the strong fit.
Casual realtime is a good fit. Authoritative matches belong to the game
layer. Competitive twitch play and MMO-scale worlds are outside the current
product. Nothing on that page names a buyer, a price, or a package. A
RallarActor business that sold those two genres as if they were already the
platform's promise would contradict the page. The actor proposal is how a
later offer could carry them, with the application still owning the tick and
the interest set.

**Cash Chase Arena** is the only concrete game product plan, in
`projects/cash-chase-arena/Cash_Chase_Arena_Product_Owner_Document.md`. It is
a browser party game for 2–8 invited desktop players, with short rounds and
no real money, ranked rewards, or durable results in the MVP. Rallar is its
only communication platform. One browser is the director for a round. That
document is a product plan for one title. It implies a first user of Rallar
who never needs an actor: everyone is already a browser. Its review notes
that audience, economy, and platform choices beyond that MVP are still open.
It is evidence that the current planned customer is a small browser room, not
a Unity or Unreal studio.

**ALM** plans under `playground/alm/` are a protocol and quality-of-service
design. They decide durability, delivery, and performance budgets. They do
not name a market.

**Production deployment** in `docs/production-deployment.md` describes how
`main` ships web apps and the API. It is an operational rule. It does not
describe a paid service.

So the existing "business plans" are really product boundaries. The platform
is the substrate. Games and tools keep their own rules. Cash Chase is a
browser consumer of that substrate. No document sells seats, traffic, or
support.

## Who would pay for an actor

The buyer is a team that already has a host and already has a group problem.

- A studio with an Unreal or Unity build that must share a group with a
  browser: an instructor, a spectator page, a companion tool, a capture
  client.
- A team whose dedicated simulation should be one participant in many groups,
  while each player process is one participant in the few groups the
  simulation named.
- A non-game process, such as a venue controller or a desktop tool, that must
  be a member rather than a database client.

The buyer is not someone shopping for a replacement of Unreal replication or
Unity Netcode. Those products already own the tick inside the engine. Photon,
coherence, and Normcore sell that ownership. The actor sells the seat and the
delivery the host already decided.

The host kit is the adoption cost, not the product being priced. A C++ client
of the actor is a small library. Charging for the kit would copy Hiro's
per-developer license and would tax the first integration. Giving the kit
away matches Colyseus, Nakama's open clients, and Epic's free SDK, and leaves
the paid object on the service the kit reaches.

## What the paid object could be

The survey shows six meters that already exist. Each one mis-measures this
product in a different way.

| Meter in the market                          | Who uses it              | How it sits on an actor                                                                                                            |
| -------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Peak concurrent users, summed across regions | Photon                   | A publishing host is one user and may fan out a world. A quiet spectator is also one user. The peaks are not the cost.             |
| CCU-hour plus simulator-hour                 | coherence                | Fits a hosted simulation better than a seat. The actor is not the simulator.                                                       |
| Room-hour plus bandwidth                     | Normcore                 | Close, if a group-hour is the room-hour. A participant in five groups must not be billed as five unknown things with no rule.      |
| Participant-minute                           | LiveKit, PlayFab Party   | Fits a seat that is simply present. Under-counts a tick stream the application pours through one seat.                             |
| Monthly active user, or a message            | PubNub, Ably             | Fits social tools. A tick is not a chat message, and Ably's own presence notes show member-to-member presence exploding the count. |
| Virtual-machine hour                         | Edgegap, PlayFab servers | Fits the dedicated game process. That process may also run an actor. The machine is not the group service.                         |

A workable brainstorm, not a price:

- Bill **participant presence time** for the seat: how long an actor is
  signed in and held in at least one group. One publishing host and one
  player cost the same presence, because each is one participant.
- Bill **delivered bytes** above an allowance, because the tick and the
  member list are the cost Photon hides inside CCU and LiveKit only partly
  sees in participant minutes.
- Treat **extra groups as free membership** up to a published cap per
  participant, then a group-hour charge. The product invites several groups.
  A meter that punishes a party-plus-match pair will push customers back to
  one giant group, which is the shape the proposal is trying to avoid.
- Keep **presence fan-out** on a group-sized cap. Ably's published warning is
  the right constraint: presence of every member to every member is a
  different product from a live tick to a named list. The allowance should
  make the expensive one visible.
- Leave **the dedicated server's CPU** on whatever host the customer already
  pays. Do not bundle Edgegap-style orchestration into the first offer.
  The survey's note on Hathora is a reason to keep that business separate.

Epic's free relay means a paid offer cannot be "datagrams between two game
builds." The paid difference is the group: scoped membership, presence,
validated events, several groups on one seat, and a browser on the same
membership. Teams that only need engine-to-engine packets will stay on EOS
or on their engine. That is an acceptable boundary.

## A first offer and a later one

**First offer, the mixed group.** Self-serve. The kit and a local actor are
free against a developer deployment of the existing API. A hosted group
service, when one exists, includes a small presence-time and byte allowance
and then the two meters above. The promised scene is the first product
outcome: one Unity or Unreal participant, one browser, one group, one
reliable event, one live update. Cash Chase does not need this offer. A
training session or a tool beside a browser room does.

**Later offer, application-paced play.** Same meters, higher byte volume,
in-process attachment, member lists, and a publishing participant in many
groups. Sell it only after the first offer has a real mixed group in use.
Pricing twitch traffic on a guess repeats the mistake of a CCU plan that
cannot see fan-out. The allowance should be rewritten from measured traffic
of that offer, not from Photon's 3 GB per peak CCU.

Support can be a third line, sold to a team that is launching, the way
Normcore and Heroic sell support beside the meter. It should not be required
to join a group.

## What the offer refuses

- A license fee per engine seat or per developer, as the price of the kit.
- A peak-CCU plan as the only meter.
- Selling interest management, prediction, or hit judgment. Those stay in the
  host. Selling them would turn the actor into a second coherence or Fusion
  and would contradict the product proposal.
- A revenue-share of the customer's game, as coherence uses for self-hosting,
  until there is a hosted service worth that share. The actor does not run
  the match.
- Bundling world hosting, matchmaking, and LiveOps into the first release.
  Nakama and PlayFab already sell that bundle. The actor's bundle is the
  group and the delivery.

## How to tell whether the brainstorm was right

The offer is the right shape when a team that already has an engine build
pays for hosted presence time because a browser and that build share a
group, and when a second group on the same actor does not surprise the bill.
It is the wrong shape when the first invoices are dominated by presence
fan-out or by tick bytes nobody had named as a meter, or when prospects
only wanted a free relay and leave for Epic.

No price, contract, or packaging in this note is adopted. Adopting any of it
is a separate decision from the product proposal.

## References

The market figures behind the meters are cited in the
[market survey](./rallar-actor-market-survey.md). Repository documents named
above:

- `docs/product.md`
- `docs/production-deployment.md`
- `projects/cash-chase-arena/Cash_Chase_Arena_Product_Owner_Document.md`
- `playground/alm/alm-qos-product-plan.md`
