# Rallar Browser Match Support Brainstorm

## Summary

Rallar already has the important substrate for browser-led matches: scoped
groups, authenticated principals, active sessions, room membership policy,
presence, room-scoped WS/RTC messages, director appointment, game lane presets,
authority envelopes, snapshots, events, and diagnostics.

The current boundary is mostly right. Rallar should not become the owner of
game-specific rules such as how points are awarded, when a hit counts, what a
win means, or how a seasonal leaderboard is ranked. Those rules belong to the
game or app domain.

There is still a useful optional library shape between "raw Rallar transport"
and "full game backend": a small match-support layer that standardizes match
lifecycle, participant identity, authority handoff, command/result envelopes,
scoreboard projection, final result publication, and diagnostics. That layer
could serve games, quizzes, classroom activities, shared simulations, challenge
rooms, and other browser-first realtime experiences.

## Current Repo Evidence

Relevant existing pieces:

- `packages/shared/api/group-types.ts` defines the base identity model:
  `PrincipalId`, `SessionId`, `GroupRef`, `GroupRole`, group membership,
  active presence sessions, and group events.
- `packages/shared/api/group-director.ts` defines browser director appointment
  as a session-bound, principal-bound lease with an epoch and heartbeat TTL.
- `packages/shared-web/browser/rallar-director-facade.ts` exposes
  `director.appoint(...)`, `director.status(...)`, and `director.createRelay(...)`.
- `packages/shared-web/game/match.ts` already provides browser-director match
  support: host capability reporting, host election, appointment, room lane
  readiness, input/intent routing, snapshots, events, presence, sync requests,
  recovery state, and diagnostics.
- `packages/shared-web/game/authority-client.ts` plus
  `packages/shared-server/game/authority-server.ts` provide a server-authority
  path for commands, command results, snapshots, events, sync requests, and
  peer-assisted presence/snapshot repair.
- `apps/api-v1/README.md` states that `api-v1` supplies rooms, director state,
  WS, RTC, and relay support, while the game owns simulation, command legality,
  validation, persistence, scoring, AI, and rendering.
- AR Eye Hunter and Relic Hunters keep score and winners inside their own
  domain models. AR Eye calculates hit score deltas and match results in
  `apps/ar-eye-hunter-v1/src/game/simulation.ts`; Relic Hunters calculates
  carried relic scores, escape bonuses, penalties, and winners in
  `packages/relic-hunters/src/rules.ts`.

That evidence points to a good split: Rallar owns coordination and message
contracts; apps own domain state transitions.

## Scenario: A Peer As Principal For A Group

It helps to separate three identities:

- Principal: the authenticated actor or user, represented by `principalId`.
- Session/peer: one live browser connection, represented by `sessionId` or RTC
  peer id.
- Group/room membership: the principal's role and status inside a `GroupRef`.

When a peer is assigned as the active authority for a room, the existing Rallar
concept is not "this principal now owns the group." It is closer to: this live
session, for this principal, holds a time-limited director lease for this room.
That distinction is important because a principal may have multiple sessions,
the browser may disconnect, and director authority should not imply owner/admin
permissions.

For browser-led matches, the director can run the authoritative loop for a
casual or cooperative room. For durable competitive outcomes, the director's
output should be treated as proposed or room-trusted data unless a trusted
server validates and finalizes it.

## What Is Generic Enough For Rallar

These operations are generic enough for an optional Rallar browser match
library:

| Operation | Why it fits Rallar | Notes |
| --- | --- | --- |
| Match lifecycle | Most room activities need lobby, starting, active, paused, complete, abandoned, and recovery states. | The phase names should be configurable. |
| Participant registry | Rallar already knows principals, sessions, active room members, and presence. | The app decides whether one principal can have multiple seats. |
| Ready checks | `rooms.waitForPresence(...)` and RTC lane readiness already exist. | A match layer can compose these into "ready to start" gates. |
| Authority lease | Director appointment is already a Rallar concept. | Keep it session-bound and epoch-based. |
| Host election | Existing Rallar Game capability scoring is generic enough as a default. | Apps can override scoring. |
| Command/result envelope | Sequence, room, protocol, sender, authority epoch, and type IDs are reusable. | Payload validation remains app-owned. |
| Snapshot/event fanout | Already present in browser-director and server-authority flows. | The match layer can standardize names and defaults. |
| Scoreboard projection | Sorting rows, tie handling, ranks, display rows, and local-player highlighting are reusable. | Score calculation is not generic. |
| Result envelope | A standard final result record is useful for storage, replay, and diagnostics. | Trust level must be explicit. |
| Diagnostics | Stale authority, pending commands, no room, missing local peer, RTC not ready, and stale snapshot are generic. | Build on existing Rallar Game diagnostics. |

## What Is Too Game Specific

These should not be implemented as core Rallar behavior:

- Point awards, combo rules, penalties, bonuses, and win conditions.
- Hit validation, physics, collision, turn legality, map rules, and cooldowns.
- Rating systems such as Elo, MMR, leagues, seasons, and ladders.
- Global leaderboards with fraud prevention and moderation.
- Achievements, rewards, inventory, unlocks, currencies, and economies.
- Matchmaking policy, party skill balancing, regions, and queue design.
- Anti-cheat beyond generic transport, authority, and audit hooks.

Rallar can supply contracts and helpers around these areas, but it should not
decide their semantics.

## Leaderboards And Points

Leaderboards and points are split concepts.

Points are domain facts. Rallar should not know that a relic is worth 50 points,
that a headshot has a multiplier, or that an escape bonus beats a carried item.
The app should emit domain events or accepted commands, then its reducer should
derive score changes.

Standings are generic projections. Rallar can help turn app-provided participant
metrics into ordered rows:

```ts
type RallarMatchStanding = Readonly<{
    participantId: string;
    principalId?: string;
    sessionIds: readonly string[];
    rank: number;
    metrics: Readonly<Record<string, number>>;
    tieGroup?: number;
}>;
```

A generic standings helper could accept a comparator and produce stable ranks:

```ts
const standings = deriveRallarMatchStandings({
    participants,
    metrics,
    compare: (left, right) =>
        right.metrics.points - left.metrics.points ||
        right.metrics.objectives - left.metrics.objectives ||
        left.participantId.localeCompare(right.participantId),
});
```

That is useful without deciding what `points` means.

Global leaderboards need a stronger trust model. A browser director can publish
a local room result, but a durable cross-room leaderboard should normally be
written by a server-authoritative service or by a server validator that accepts
only signed or policy-checked match results.

## Recommended Optional Library Shape

Start as an opt-in library rather than a new required surface on `rallar`.

Possible package split:

- `packages/shared/rallar-match`: runtime-agnostic types and pure helpers.
- `packages/shared-web/match` or `packages/shared-web/game/match-support`:
  browser integration on top of rooms, director, messages, realtime, and Rallar
  Game.
- `packages/shared-server/match`: optional server authority/result helpers if
  durable results are needed.

Avoid adding `rallar.match` to the main browser facade until the shape has
proved itself in one or two apps. Named imports keep the core facade smaller and
make the feature clearly optional.

## Candidate API Sketch

```ts
const match = createRallarBrowserMatch<Command, Snapshot, Event>({
    rallar,
    roomRef,
    protocol: 'audit-sprint.match.v1',
    topicId: 'room.audit-sprint.match',
    authority: {
        mode: 'browser-director',
        appointmentPolicy: 'metadata-owner-admin-or-member-fallback',
    },
    participants: {
        participantId: ({ principalId }) => principalId,
    },
    standings: {
        metrics: ['points', 'objectives'],
        compare: (left, right) =>
            right.metrics.points - left.metrics.points ||
            right.metrics.objectives - left.metrics.objectives,
    },
    readSnapshot,
    applyCommand,
});

await match.start();
await match.ready.wait({ minParticipants: 2, lanes: ['input', 'snapshot'] });
await match.submit({ kind: 'fire', targetId: 'target-1' });

match.onSnapshot((snapshot) => render(snapshot));
match.onStandings((rows) => renderScoreboard(rows));
```

This sketch intentionally makes `applyCommand` and scoring app-owned. The Rallar
match layer would own the wiring, sequencing, authority checks, readiness,
fanout, and projections.

## Result Contract

A reusable result envelope could be valuable:

```ts
type RallarMatchResult<TSummary = unknown> = Readonly<{
    resultId: string;
    matchId: string;
    roomRef: GroupRef;
    protocol: string;
    authority: {
        kind: 'browser-director' | 'server';
        id: string;
        epoch: number;
        principalId?: string;
        sessionId?: string;
    };
    trust: 'local' | 'room-trusted' | 'server-validated';
    startedAtEpochMs?: number;
    finishedAtEpochMs: number;
    standings: readonly RallarMatchStanding[];
    summary: TSummary;
    idempotencyKey: string;
}>;
```

The `trust` field is essential. It lets browser-director matches be useful
without pretending they are anti-cheat safe global records.

## Three Approaches

### 1. Keep Rallar As Low-Level Substrate Only

Rallar continues to expose rooms, director, WS, RTC, and Rallar Game helpers.
Each game defines its own match lifecycle, scoreboard, and result model.

Pros:

- Keeps Rallar small and clean.
- Avoids accidental game-engine scope creep.
- Matches the current API server boundary.

Cons:

- Every browser game or activity repeats match lifecycle, scoreboard rows,
  result envelopes, and diagnostics.
- Harder to write docs and examples that feel complete.

### 2. Add Optional Match Support Library

Add a thin, opt-in layer that composes existing Rallar primitives and exposes
common match operations without owning game rules.

Pros:

- Reuses existing Rallar Game work.
- Gives developers a concrete "browser match" path.
- Supports games and non-game realtime rooms.
- Keeps scoring, legality, and persistence pluggable.

Cons:

- Needs careful naming so it does not imply a complete game backend.
- Requires compatibility tests and docs.
- May need both browser-director and server-authority variants.

Recommendation: this is the best next step.

### 3. Build Full Game Backend Features

Add first-class leaderboards, ratings, matchmaking, seasons, achievements,
anti-cheat, rewards, and authoritative persistence to Rallar.

Pros:

- More complete for game teams in theory.
- Could produce flashy demos.

Cons:

- Too broad for Rallar's current product boundary.
- Pulls domain policy into platform packages.
- Competes with mature game backend products before Rallar has proved the
  smaller match-support layer.

Recommendation: avoid for now.

## Suggested V1 Scope

V1 should be intentionally small:

- `RallarMatchParticipant` and helpers to derive participants from room members
  and active sessions.
- Configurable match phase model with generic timestamps and status.
- Browser-director adapter over `createRallarGameMatch(...)`.
- Server-authority adapter over `createRallarGameAuthorityClient(...)`.
- Generic standings projection helpers.
- Optional result envelope and finalization helper.
- Diagnostics that combine room membership, director authority, RTC readiness,
  pending commands, snapshot age, and result state.
- One example that uses an app-owned score reducer.

Do not include global leaderboards, matchmaking, rankings, seasons, rewards, or
anti-cheat in V1.

## Storage And Durability

Use different storage levels for different trust levels:

- Browser local state: use `rallar.data` for UI drafts, local cached snapshots,
  and reconnect convenience. Do not treat it as live match truth.
- Browser-director room result: publish as a room-scoped event/result envelope.
  Useful for casual rooms and replay, but mark as `room-trusted`.
- Server-authoritative result: validate commands on the server, produce the
  result server-side, and store it through an app-owned repository or app-data
  layer. This is the path for durable leaderboards.

If Rallar later adds result persistence, it should probably be a generic
append-only result repository with authorization and idempotency, not a
leaderboard system.

## Testing Implications

For a future implementation:

- Shared pure helpers: unit tests in `packages/tests/shared`.
- Browser match adapter: focused tests in `packages/tests/shared-web`, including
  public API snapshots and browser bundle boundaries if exported.
- Server authority/result helpers: tests in `packages/tests/shared-server`.
- If REST result routes are added: black-box recipes in
  `packages/shared-test/black-box-runner`.
- Game consumers: AR Eye Hunter and Relic Hunters app tests/builds only when
  they adopt the optional layer.

## Open Questions

- Should the library be named `rallar-match` to include non-game activities, or
  live under the existing `rallar-game` namespace?
- Should match participants be principal-first, session-first, or configurable
  per match?
- Should browser-director final results be persistable by default, or should
  persistence require a server validator?
- Should standings support teams in V1, or wait until a real consumer needs it?
- Should result envelopes be routed through room WS messages only, or should
  there be an optional REST finalization endpoint?

## Bottom Line

Leaderboards and points are not themselves generic enough for core Rallar.
However, match lifecycle, participant identity, authority leases, command and
snapshot envelopes, standings projection, result envelopes, and diagnostics are
generic enough for an optional library.

The best direction is to keep core Rallar as the room/realtime substrate, keep
game rules in app packages, and add a small optional match-support layer that
turns the existing browser-director and server-authority primitives into a
more discoverable workflow.
