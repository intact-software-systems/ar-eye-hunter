# Cash Chase Arena 2D

Design proposal · 15 November 2026 · Working subtitle: **Market Mayhem**

## Purpose

Make a browser game that friends choose to play again, using Rallar for reliable
multiplayer. Success is a good game experience on phones, iPads, and computers;
demonstrating Rallar follows from that experience.

The user requested this project pack and is open to 2D. The particular game rules,
art direction, Phaser recommendation, server authority, and numerical targets below
are proposals, not previously approved decisions or measured results. No CCA 2D
implementation, approved artwork, device qualification, or performance evidence exists yet.

## The proposal

Three [smartphone gameplay visual concepts](visual-concepts/README.md) show
alternative graphics styles with touch controls. These are generated screen
mockups for selection, not an implemented game or approved production artwork.

Two to six cartoon thieves race around a bright paper-cut market, collecting loot
and depositing it at pneumatic bank booths. Carrying more makes the payout better
and the guards more interested. Dash around a stall, tempt a guard down someone
else's route, grab an exposed jackpot, and decide whether one more pickup is worth it.

Banking keeps you in play. Being caught costs your bag and about three seconds,
then you return. A round lasts three minutes. The highest banked score wins;
equal scores share the win. There is no real money, wagering, or purchased advantage.

The proposed first release has one excellent arena, one guard behavior, one public
jackpot event, and two actions besides movement. Four players are the first
multiplayer acceptance target; six is the intended release cap only after device
and network qualification. Eight players are outside the initial scope.

## Read the pack

| Document                                        | Owns                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| [Game design](game-design.md)                   | Rules, social tension, map, fairness, tuning, and fun criteria      |
| [Art and polish](art-and-polish.md)             | Art direction, production assets, animation, sound, visual review   |
| [Mobile and controls](mobile-and-controls.md)   | Phone/tablet/desktop play, camera, input parity, accessibility      |
| [Architecture](architecture.md)                 | Rallar authority, transport, recovery, ownership, technical budgets |
| [Development sequence](development-sequence.md) | Next two slices, later outcome gates, agents, tools, acceptance     |

These documents have distinct owners; cross-link rather than repeating a rule.
Current repository standards still govern implementation. These files are a design
proposal and development strategy, not a delivery ledger or an authorization to
build, deploy, buy assets, install integrations, or change existing public APIs.

## Alternatives considered

| Direction                                              | Strength                                                                 | Cost or weakness                                                                               | Proposal                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Preserve the original third-person 3D elimination game | Physical chase spectacle                                                 | Camera, assets, mobile controls, hosting recovery, and long spectator waits compete for effort | Do not carry this shape into CCA 2D             |
| Illustrated top-down 2D with repeated raids            | Readable on touch, small content set, frequent decisions, short setbacks | Requires precise animation and map tuning; still needs measured networking                     | Start here                                      |
| Turn-based heist board game                            | More tolerant of latency and touch imprecision                           | Gives up the immediate chase fantasy and overlaps Relic's experience                           | Reconsider only if action play is not enjoyable |

Within 2D, Phaser is the leading implementation choice. It supplies game systems
that otherwise need assembling. It does not supply art direction or guarantee a
small download. A simpler Canvas or PixiJS implementation remains a possible
response to measured engine cost, not a parallel project to maintain.

## Changes from the earlier Cash Chase proposal

The [earlier product document](../cash-chase-arena/Cash_Chase_Arena_Product_Owner_Document.md)
is inspiration, not governing scope for this proposal.

| Earlier choice                                   | CCA 2D proposal                              | Reason                                              |
| ------------------------------------------------ | -------------------------------------------- | --------------------------------------------------- |
| Desktop active play                              | Phone, iPad, and desktop active play         | Explicit user requirement                           |
| Continuous passive credit accrual                | Pickups, route choices, and public jackpots  | Reward doing interesting things; discourage hiding  |
| Cash out and spectate                            | Deposit and immediately make another run     | Keep the whole group playing                        |
| Caught until round end                           | Brief catch animation and respawn            | Preserve tension without minutes of exclusion       |
| Peer browser director and migration              | Server-owned round                           | A sleeping phone must not stop everyone's game      |
| Procedural 3D arenas and three mission templates | One authored 2D arena and one event          | Concentrate polish and learn whether the loop works |
| AI and creator features later                    | No runtime generative AI or CRDT requirement | Fast opening and dependable authored gameplay       |

Existing apps and the old project documents are unchanged. This proposal creates
no migration or compatibility obligation for them.

## What must become true

- A newcomer can collect and bank without an explanation from the developer.
- A touch player can dodge, deposit, and compete without keyboard-only advantages.
- Players describe an exciting decision and voluntarily ask for another round.
- A small gameplay capture looks like an intentional illustrated game, not a
  technical demonstration or a dashboard around a canvas.
- Refreshing or losing a connection has a clear outcome; clients agree on scores.
- Loading and sustained play meet measured budgets on actual target hardware.

The next decisions should come from a tiny playable slice and an approved visual
reference. More documents alone cannot establish fun, visual quality, or reliability.
