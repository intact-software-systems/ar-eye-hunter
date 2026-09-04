---
name: rallar-realtime
description: Use when changing Rallar rooms, GroupRef/scoped identity, group/client state, WS/RTC routing, multicast, graph topology, presence, state sync, or reconnect/cold-cache behavior.
---

# Rallar Realtime

**REQUIRED SUB-SKILL:** Use `rallar-code-writing` when writing, generating,
refactoring, or reviewing TypeScript.

Use `building-rallar-apps` when deciding how realtime fits into a whole new
app. `rallar-realtime` remains authoritative for rooms, scope, messages,
WS/RTC, identity, routing, and readiness.

## First Pass

Inspect both runtime sides before editing:

```bash
rg -n "GroupRef|groupRef|groupId|roomId|createAndSwitch|createAndJoin|joinRoom|waitForPresence|RallarReadinessExpectation|state-sync|WebSocket|RTC|topology|presence|realtime\\.room|messages\\.room|peerConnectionAttemptBudget|connect-exhausted" packages/shared packages/shared-web packages/shared-server packages/shared-graph apps/api-v1 apps/ar-eye-hunter-v1 apps/relic-hunters-v1
```

## Core Areas

- Browser compatibility facade: `packages/shared-web/browser/rallar.ts`.
- Narrow browser entry points: `packages/shared-web/browser/rallar-core.ts`, `rallar-realtime.ts`, `rallar-data.ts`, `rallar-crdt.ts`, and `rallar-media-calls.ts`.
- Browser room helpers: `rallar.realtime.room<T>(...)` for room-scoped RTC JSON sends and `rallar.messages.room<T>(...)` for typed room messages with RTC/WS options.
- HTTP API calls: `packages/shared-web/browser/api-integration.ts`.
- Canonical authoritative group state:
  `packages/shared-server/rallar-system/group-state/**`.
- Group formation lifecycle: the stage a group is in gates topology planning,
  dialing and pre-activation application data. Read
  `docs/rallar-group-formation-architecture.md` before changing anything that
  reads `lifecycleState`, the lifecycle policy, or the activation status.
- Canonical topology inbox handling:
  `packages/shared-server/rallar-system/topology/inbox/**`.
- Durable RTC topology delivery replay and reconnect/gap hydration:
  `packages/shared-server/rallar-system/topology/replay/**`; use
  `packages/shared-server/docs/persistence-and-replay.md` before changing
  ownership or lifecycle.
- Canonical RTC RTT inbox handling:
  `packages/shared-server/rallar-system/rtc-rtt/inbox/**`.
- State sync routing/publication:
  `packages/shared-server/rallar-system/state-sync/**`.
- WS topic routing:
  `packages/shared-server/rallar-system/websocket/router/**`; API-v1 feature
  registration lives in `apps/api-v1/src/composition/create-api-v1-system-installers.ts`.
- RTC topology/graph: the canonical inbox path above, the owning topology
  feature modules, and `packages/shared-graph`.

## Rules Of Thumb

- Prefer `GroupRef` over bare `groupId` when application/workspace scope matters.
- Formation readiness and the activation status are observation, never
  authority. A criterion evaluator may petition a transition by enqueueing a
  command; the command re-authorizes through AppInbox against fresh state.
  Nothing gates a decision on an observed fraction.
- A group with no `lifecyclePolicy` is the `optimistic` preset, which is
  exactly the behaviour groups had before the layer existed. Every enforcement
  point reads an absent policy that way; do not add a fourth answer.
- Do not trust warm in-memory presence blindly; check expiry and durable read-through paths.
- For authoritative database or realtime service mutations, read
  `.agents/skills/rallar-code-writing/references/convergent-service-writing.md`
  completely and apply it unchanged. The remaining rules here are realtime
  domain deltas.
- Keep the compact `MutationReceipt` family and `GroupStateCausalRevision` as
  replay and group/presence authority.
- Keep one durable publisher HEAD per ephemeral process and one cursor per
  consumer/publisher pair. QueueBox remains the low-latency path; replay
  notification, poll, and local-commit events only wake one single-flight
  bounded drain. Cross-stream sequence numbers never define authority.
- Reconnect and retention-gap hydration must re-read current durable group
  authority and fence the final send to the same socket generation. Cached
  membership/presence does not authorize hydration.
- Group user mutations require a real issued auth session or exact
  command-bound proof. Server maintenance remains a separately wired narrow
  capability, never a public bypass field.
- Presence summaries are optimistic materialized views, not authority. Compute
  them from entry-aware group/member/admission/session reads, validate their
  exact persisted shapes, CAS the exact summary predecessor, and exclude
  sessions whose member is no longer active even if a stale session row remains
  live. Snapshot assembly captures one observation time and also intersects the
  summary with current group status/expiry: archived, deleted, or expired groups
  report zero active sessions and online members while preserving causal
  revisions. Newer source mutations enqueue follow-up convergence work.
- A liveness-filtered current-authority projection that preserves the summary
  causal tuple is not a canonical summary-cache observation. Return it without
  observing, evicting, rewriting, or synthetically advancing the monotonic
  cache; only canonical summary convergence with an advanced tuple updates that
  cache. Never report committed authoritative success as failure because an
  optional cache observation conflicts.
- Group presence uses its per-session guard and does not contend on the group
  row. Group metadata and roster operations use the aggregate group guard.
- For authoritative group-state protocol dispatch, retain the existing
  discriminated type-to-payload relationship; repeated case-local assertions
  are not an acceptable substitute. One boundary narrowing may establish that
  relationship but must not claim payload validation it did not perform or
  alter runtime error timing.
- Keep transaction, retry, lifecycle, and after-commit dependencies behind a
  named port beside the canonical owner so Go to Definition exposes invocation,
  retry, commit, and failure semantics. Judge cohesion by responsibility, not
  method count.
- An explicit group-state timing or decorator owner uses a closed operation-name
  type and exhaustive operation inventory. Timing identity fields are
  deliberately populated, deliberately retained for compatibility, or changed
  only through separately approved observable-behavior work.
- A feature with more than 20 production modules or more than three materially
  different control-flow families retains a durable repository navigation map;
  a historical PR body is not a durable substitute.
- Keep browser ergonomics, but diagnose ambiguity where string room IDs can cross scopes.
- Use `rallar.rooms.createAndSwitch(...)` for browser flows where creating a new
  room should leave the previous current room. Plain `rooms.create(...)` keeps
  the previous membership.
- Use `rooms.waitForPresence(...)` and RTC `expect` options when a flow needs a
  bounded number or exact set of active sessions/peers.
- Prefer `rallar.realtime.room<T>(...)` for app/game room traffic before wiring `rtc.waitForRoomLane`, `readyPeerIds`, and `realtime.sendJson` manually.
- Prefer `rallar.messages.room<T>(...)` when important room-scoped messages need typed RTC/WS fallback behavior.
- Room handles scope sends, peer selection, and readiness; their receive
  callbacks remain topic/type or lane listeners and are not automatically
  room-filtered. Validate message targets from `message.raw.targets` with
  `isSameGroupRef`. A realtime payload must carry the full `roomRef` and the
  receiver must validate it, unless the lane is unique to that room.
- For RTC tests, distinguish signaling readiness from actual data-channel readiness.
- For inbound RTC peer creation, group state is eventually consistent. Prefer
  optimistic/tentative admission under caps and attempt budgets; keep hard
  rejects for malformed, self, wrong-target, exhausted, or cap-blocked peers.
- Browser RTC enables the initial connection-attempt budget by default. The
  shared service exposes `connect-exhausted`; browser facade waits report
  exhaustion as `failed` with reason `rtc-connect-attempt-budget-exhausted`.
- Keep `rooms.refresh()` and people refresh on complete durable collections,
  but use one exact group point read for a room session refresh. Capture the
  current object identity before targeted, heartbeat, or collection repair and
  remove only that unchanged observation after authoritative absence.
- Conditional snapshot removal is a race fence, not a causal tombstone. Test
  that a newer in-memory observation survives cleanup, and do not claim that
  delayed stale publication cannot recreate a physically removed snapshot.
- Game and motion traffic are reliability consumers of the realtime layer, not separate demos.

## Validation

Use `rallar-testing` for command selection and the canonical service reference
for mutation verification. Run focused tests in `packages/tests/shared-web`,
`packages/tests/shared-server`, `packages/tests/shared-graph`, and relevant game
tests. For restart or cold-cache work, include server routing tests and at least
one reconnect scenario.
