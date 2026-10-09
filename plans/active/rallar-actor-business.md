# RallarActor business brainstorm

Prepared: 2026-10-03. Reviewed against the proposal on 2026-10-09. This note
accompanies [the RallarActor product proposal](./rallar-actor.md) and the
[market survey](./rallar-actor-market-survey.md). It is a brainstorm. It is not
an adopted offer, a price list, or a change to `docs/product.md`.

## What this repository already plans

There is no company business plan, pricing page, or go-to-market document in
the repository. The documents that do exist set product boundaries a business
offer would have to respect.

**The platform description** in `docs/product.md` is the standing product
boundary. Rallar is browser-first. Rooms, presence, validated events, and peer
updates are the offer. Turn-based and social rooms are the strong fit. Casual
realtime is a good fit. Authoritative matches belong to the game layer.
Competitive twitch play and MMO-scale worlds are outside the current product.
Nothing on that page names a buyer, a price, or a package. A RallarActor
business that sold those two genres as if they were already the platform's
promise would contradict the page. The actor proposal is how a later offer
could carry them, with the application still owning the simulation tick and
interest set.

**Cash Chase Arena** is the only concrete game product plan, in
`projects/cash-chase-arena/Cash_Chase_Arena_Product_Owner_Document.md`. It is
a browser party game for 2–8 invited desktop players, with short rounds and no
real money, ranked rewards, or durable results in the MVP. Rallar is its only
communication platform. One browser is the director for a round. That
document is a product plan for one title. It implies a first user of Rallar
who never needs an actor: everyone is already a browser. Its review notes that
audience, economy, and platform choices beyond that MVP are still open. It is
evidence that the current planned customer is a small browser room, not a
Unity or Unreal studio.

**ALM** plans under `playground/alm/` are a protocol and quality-of-service
design. They decide durability, delivery, and performance budgets. They do not
name a market.

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
- A product where a bot or AI agent should be an ordinary participant beside
  people, native clients, and browser members.

The buyer is not someone shopping for a replacement of Unreal replication,
Unity Netcode, Photon, or another working gameplay stack. Those products may
continue to own gameplay replication. The actor sells the participant seat and
the delivery around it: the same identity, groups, presence, events, and live
lanes can include browsers, native players, servers, tools, observers, bots,
and agents.

The host kit is not the paid object, but it is part of the product. An Unreal
plugin or Unity package has to feel native, install cleanly, survive the engine
lifecycle, expose diagnostics, and make the first mixed group easy to build.
Charging for the kit would tax the first integration. Giving it away matches
Colyseus, Nakama's open clients, and Epic's free SDK, while the paid object
remains the hosted service the kit reaches.

## What the paid object could be

The survey shows six meters that already exist. Each one mis-measures this
product in a different way.

| Meter in the market                          | Who uses it              | How it sits on an actor                                                                                                            |
| -------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Peak concurrent users, summed across regions | Photon                   | A publishing host is one user and may fan out a world. A quiet spectator is also one user. The peaks are not the cost.             |
| CCU-hour plus simulator-hour                 | coherence                | Fits a hosted simulation better than a seat. The actor is not the simulator.                                                       |
| Room-hour plus bandwidth                     | Normcore                 | Close, if a group-hour is the room-hour. A participant in five groups must not be billed as five unknown things with no rule.      |
| Participant-minute                           | LiveKit, PlayFab Party   | Fits a seat that is simply present. Under-counts a high-rate live stream the application pours through one seat.                   |
| Monthly active user, or a message            | PubNub, Ably             | Fits social tools. A live update is not a chat message, and presence fan-out can dominate message count.                          |
| Virtual-machine hour                         | Edgegap, PlayFab servers | Fits the dedicated game process. That process may also run an actor. The machine is not the group service.                         |

A workable brainstorm, not a price:

- Bill **participant presence time** for the seat: how long an actor is signed
  in and held in at least one group. One publishing host and one player cost
  the same presence, because each is one participant.
- Bill **delivered bytes** above an allowance, because live fan-out is the
  variable cost that a presence-time meter does not see.
- Treat **extra groups as included membership** inside a published technical
  cap. The product invites several groups. The first offer should not add a
  third billing dimension merely because a player holds party and match at the
  same time.
- Keep **presence fan-out** on a group-sized technical cap or fair-use limit.
  Ably's published warning is the right constraint: presence of every member
  to every member is a different product from a live payload to a named list.
  Make the expensive case visible in diagnostics before turning it into
  another customer-facing meter.
- Leave **the dedicated server's CPU** on whatever host the customer already
  pays. Do not bundle Edgegap-style orchestration into the first offer. The
  survey's note on Hathora is a reason to keep that business separate.

The internal cost model may still track groups, relay use, fan-out, regions,
and other expensive cases. The customer-facing model should stay simpler than
the cost ledger unless measurements show that another meter is unavoidable.

Epic's free relay and Steam Networking mean a paid offer cannot be "datagrams
between two game builds." The paid difference is the participant fabric:
scoped membership, presence, validated events, reconnect, several groups on
one seat, and browser/native/tool/agent membership under the same contract.
Teams that only need game-to-game packets will stay on EOS, Steam, or their
engine. That is an acceptable boundary.

## A first offer and a later one

**First offer, the mixed group.** Self-serve. The kit and a local actor are
free against a developer deployment of the existing API. A hosted group
service, when one exists, includes a small presence-time and byte allowance and
then the two meters above. The promised scene is the first product outcome:
one Unity or Unreal participant, one browser, one group, one reliable event,
one live update. The adoption target should be measured in minutes to that
scene, not in how small the C++ surface is. Cash Chase does not need this
offer. A training session, companion, observer, agent, or tool beside a
browser room does.

**Later offer, application-paced play.** Same meters, higher byte volume,
member lists, a publishing participant in many groups, and optional
N-latest-values paced realtime transport, where N=1 is latest-value. The beside-process attachment remains valid when
its measured latency and jitter fit the application's budget. In-process or
lower-copy attachment is an optimization for measured cases that require it,
not an extra product tier. Sell this offer only after the first offer has a
real mixed group in use. Pricing high-rate traffic on a guess repeats the
mistake of a CCU plan that cannot see fan-out. The allowance should be
rewritten from measured traffic of that offer, not from another vendor's
allowance.

Support can be a third line, sold to a team that is launching, the way
Normcore and Heroic sell support beside the meter. It should not be required
to join a group.

## What would make the offer broad

The first differentiator is not "native networking." It is that anything can
become the same kind of participant. A game can keep Unreal replication, Unity
Netcode, Photon, or another gameplay path while Rallar connects the surrounding
product: browser companion, party, spectator, instructor, tool, dedicated
process, bot, or agent. That makes adoption additive instead of a networking
rewrite.

Broad adoption then depends on product work around the architecture:

- A first mixed Unity-or-Unreal plus browser group that takes minutes to run,
  with engine-native installation, lifecycle handling, examples, and
  diagnostics.
- A hosted service with regions, relay fallback, reconnect behavior,
  observability, quotas, and a credible operating envelope.
- Published latency, jitter, throughput, fan-out, and reconnect measurements.
  For the local attachment, p95/p99 and missed network-send windows matter more
  than arguing from an assumed localhost average.
- Predictable customer pricing even though the internal cost model sees
  presence, bytes, fan-out, and relay traffic.
- A stable participant contract across beside-process, lower-copy, and
  in-process attachment variants, so a customer can optimize later without
  rewriting the application.

The mass-market thesis, if one emerges, is therefore broader than the first
mixed-group use case: **one participant model for every process around an
interactive product, without taking ownership of the product's simulation.**

## What the offer refuses

- A license fee per engine seat or per developer, as the price of the kit.
- A peak-CCU plan as the only meter.
- Requiring a customer to replace a working gameplay networking or replication
  stack merely to adopt RallarActor.
- Selling the simulation tick, interest management, prediction, rollback, or
  hit judgment. Those stay in the host. Optional paced realtime transport is
  only a delivery policy for replaceable values: a bounded N-latest-values
  window, with N=1 as latest-value. It is intentionally lossy and must not be
  presented as a reliable queue. Selling the rest would turn the
  actor into a second coherence or Fusion and would contradict the product
  proposal.
- A revenue-share of the customer's game, as coherence uses for self-hosting,
  until there is a hosted service worth that share. The actor does not run the
  match.
- Bundling world hosting, matchmaking, and LiveOps into the first release.
  Nakama and PlayFab already sell that bundle. The actor's bundle is the group
  and the delivery.

## How to tell whether the brainstorm was right

The offer is the right shape when a team that already has an engine build and
working gameplay networking adds Rallar because a browser, tool, server, or
agent can become an ordinary participant without a rewrite, and when a second
group on the same actor does not surprise the bill. It is also right when a
beside-process actor meets the measured latency and jitter budget for most
customers and the rarer in-process path can preserve the same contract.

It is the wrong shape when the first invoices are dominated by presence
fan-out or by live bytes nobody had named as a meter, when integration feels
like building a networking SDK from scratch, or when prospects only wanted a
free relay and leave for Epic or Steam.

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
