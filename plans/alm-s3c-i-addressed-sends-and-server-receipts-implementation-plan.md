# ALM S3c-i Addressed Sends and Server Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** written under §10's recommended answers Q1–Q13
([alm-s3-design-proposal.md](../playground/alm/alm-s3-design-proposal.md) "S3c execution questions"), all of
which the maintainer took on 2026-09-28 (commit `4550c66df`: D57 "As applied", D70–D78; draft PR #605). S3c-i
carries D70, D71, D72, D73, D76 and D77; D74, D75 and D78 are S3c-ii's. The plan's own choices C1–C16 are ruled as
R-S3c-i-0 in "Rulings during execution", and the pre-flight conflict scan's findings as R-S3c-i-1..27, applied to
the plan in place.

**Goal:** A WS send can address one session or the server itself with a real receipt, the server's own
room notifications carry receipts over a frozen audience with per-session confirmation in the server
diagnostics, and Relic Hunters proves both: its commands travel a `command` channel to the server and its
snapshots travel the durable outbox with receipts.

**Architecture:** A unicast that names its room (an optional `groupRef` on unicast targets) is room-scoped: the
router's room authorizer admits it, the WS server delivers it locally so the router publishes it to the addressee
(Q4), and the receipt aggregator opens a one-member aggregate for it (D53, Q5). The WS server's peer id reaches
the browser as `serverPeerId` on `/api/config` (Q3); a `unicast` to that id keeps the server's own ACK as its
receipt (D57 as applied, Q2), and every `hop`/`subtree` WS send tracks the server as its one hop (R-S3a-4). A
typed WS send gains a `peerId` target (Q11, WS only). The router freezes a server-originated outbox room
notification to the room's live sessions at publish, both cluster sends honour the captured audience, and a
bounded per-process recorder is the server's settlement sink, read on `/api/admin/operations/realtime` (D58, D61,
Q7, Q8). Relic sends commands on the `command` channel to the server and publishes snapshots through the outbox
with `receiver` (Q6, Q7).

**Tech Stack:** TypeScript across Node, Deno and browser; Vitest; Deno test; the black-box JSON recipe runner;
dprint; OpenAPI.

**Spec:** [playground/alm/alm-s3-design-proposal.md](../playground/alm/alm-s3-design-proposal.md) §1.4, §1.5,
§2.3, §4 (decisions 2, 6, 7, 10 = D53, D57, D58, D61), §8, §9 (S3b's carries: Q7 the WS `hop` receipt, Q8 the
leavers), §10 (Q1–Q13); [playground/alm/alm-improvement-plan.md](../playground/alm/alm-improvement-plan.md) (D3,
D8, D15, D17, D24, D38, D42, D43, D46, D50, D51, D53, D57, D58, D61, D63–D66, the S3 bullet, matrix row F1,
"Consumer proofs in the games"); the S3b plan's "Carried to S3c / later". S3c-i starts from `main` `bdb3ecd8b`
(S3b, #604) plus the questions commit `60e2f0e57` and the decisions commit `4550c66df`. The code survey behind §10
is the session scratchpad `s3c-code-survey.md`; every line number below was re-read on `4550c66df`.

**The Relic client's send path (Q11), decided here:** S3c-i introduces the typed-channel per-send target
minimally — `peerId?: string` on `RallarWsSendInput`, so `rallar.messages.ws.send`, a typed channel's `sendWs`
and a typed `send` with `strategy: 'ws'` accept it — and the facade gains `serverPeerId()` on its connection
operations. Any other strategy with a `peerId` throws a validation issue until S3c-ii adds the RTC unicast and
the unicast fallback. Relic sends through that public path
(`rallar.messages.room<RelicCommand>({ ... purpose: 'command' }).sendWs(command, { peerId })`), never through
the internal `sendWsUnicast`, which stays the purpose-free director-relay path until S3c-ii (C7).

## Global Constraints

The S3b constraints apply unchanged (D8 search-first, no legacy, touched-file closure, canonical verbs, values not
exceptions, required fields, the size tiers, the non-blocking lane, the push-time gate list, maintainer-reviewed
landing), with S3c-i's values:

- **No migration.** Reset-on-mismatch is the only lever (D3, D17). §10 Q2 avoids the envelope version bump (`v`
  stays 2, no new target mode). **Bump rule:** a task that adds a field to any persisted shape (the envelope, the
  captured policy, the pending-ACK, sent or control rows) bumps `AL_ADMISSION_SCHEMA_ID`
  (`packages/shared/alm/open-indexed-db-admission-database.ts:16`, today `'rallar-alm-2026-09-s2c-ii'`) in the
  same commit and names the PostgreSQL rows in flight at deploy in the PR body. **Task 1 applies it:** a room-scoped
  unicast carries an optional `groupRef` on its targets (C1), which both strict envelope decoders refuse today, so
  the id becomes `'rallar-alm-2026-09-s3c-i'`. Nothing else in S3c-i persists a new field: the settlement sink is
  in memory (Q8), the admitted audience is already captured (`admittedAudience`), and `serverPeerId` travels only
  on `/api/config`.
- **No new third-party dependency** (D8).
- **No new timer, queue or registry beyond the settlement recorder.** The recorder
  (`createRallarAlmReceiptDiagnosticsRecorder`) is one `Map` per process bounded to
  `RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY = 256` messages, evicting the least recently updated (C10); it schedules
  nothing. The one-member unicast aggregate lives in the existing aggregation map and deadline index.
- **Harness budgets fixed:** `CONNECT_READINESS_TIMEOUT_MS` 30 000, `CONFORMANCE_DEADLINE_MS` 18 000,
  `NON_EXPIRING_SEND_TIMEOUT_MS` 10 000, `EXPIRY_TTL_MS` 7 500, regimes 30/35 ms. S3c-i adds no conformance scenario
  (the lane scenarios are S3c-ii's).
- **Bundle ceilings:** facade `browser/rallar.ts` 223 KiB (recorded 222.86328125 at the S3b fix wave), headless 285
  KiB (recorded 284.82421875), raised only by the next-whole-KiB rule (maintainer ruling 2026-09-05) with the measured
  figure recorded in the test comment, the measure script and the task commit. Headroom is 0.14 KiB and 0.18 KiB, so
  Tasks 1, 2 and 3 each measure and raise any crossed entry in the task that crosses it (R-S3b-2's rule).
- **`rallar.realtime` untouched** (D15). Public surface: `RallarWsSendInput.peerId`, `RallarConnectionOperations.serverPeerId`,
  the trusted-server `ALDeliveryRelayRejection` reason widened to `'resync-required' | 'unauthorized'`, and the
  unicast `ALTargets.groupRef`. No new exported type name reaches `rallar.ts`, so the public API snapshot (which pins
  export names) does not move; each task runs it to prove that.
- **The mutation doctrine** (`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`). None of
  S3c-i's server writes is an AppInbox mutation, and none gains one: the router-published unicast travels the WS
  server's own QueueBox `WS_INBOX` admission and a live send (or its `WS_OUTBOX` row for an `outbox` topic); the
  server-originated snapshot is a `WS_OUTBOX` admission through the server's own outbound owner, its receipt the
  existing pending-ACK row; the settlement recorder is in-process memory. Relic's `applyCommand` keeps its direct
  optimistic app-data upsert (`app-data-optimistic-writer.ts:46-55`), as the REST route does. That write is an
  incoming mutation outside AppInbox, which the doctrine does not exempt; it predates S3c-i on the REST path, and S3c-i
  changes its transport, not the write, so it stays as named debt for the maintainer (R-S3c-i-8; the PR body names
  it). The medium-scale PostgreSQL gate runs **once**, in Task 6 (Q13).
- **REST changes carry a black-box recipe** (CLAUDE.md "REST changes"): `/api/config`'s `serverPeerId` and the WS
  addressed sends are pinned by the new recipe `api-v1-websocket-addressed-sends` (Tasks 1–2); the admin route's
  `almReceipts` by a step appended to `api-v1-admin-operations` (Task 4). No recipe may add a strict-expectation
  finding (`preflight/strict-expectation-debt.json`: new recipes add none).
- **OpenAPI** (`apps/api-v1/resources/api-v1-openapi.yaml`): `ApiConfig` gains the required `serverPeerId` (Task 2);
  `AdminOperationsRealtimeResponse` gains `almReceipts` (Task 4). Neither field has a contractual default, so the
  browser's boundary decoder (`decodeApiConfigResponse`, Task 2) reapplies none. It reads a body without
  `serverPeerId` as a server that predates S3c-i — "server unknown", a distinct domain meaning: the WS client tracks
  no server hop and Relic sends commands over REST (R-S3c-i-6) — and refuses an empty or non-string id.
- Files at cognitive-load warn or review that S3c-i touches take call lines only; new behaviour goes into new files
  beside the owner: `useRelicHunters.ts` (156), `ws-queue-box-server-service.ts` (82), `al-policy.ts` (67, untouched),
  `ws-queue-box-client-service.ts` (50), and `apps/relic-hunters-v1/src/App.tsx` (776, above the refactor-or-register
  tier and unregistered in `docs/repo-code-style-exceptions.md`: one import and one element line, no new branch — the
  command-delivery row renders in its own `relic-command-delivery-row.tsx`, R-S3c-i-2). Four files sit one value
  export below `file.responsibility-count`'s 12 (`al-contract.ts`, `al-policy.ts`, `al-runtime-stores.ts`,
  `to-arena-labels.ts`): S3c-i adds no value export to any of them (`al-contract.ts` gains only a non-exported option type). New server files go under
  `packages/shared/services/ws-queue-box-server/`, `packages/shared-server/rallar-system/websocket/` and
  `.../observability/`.
- **Per-task validation** (every task, before its commit; a task names the extra gates it needs):
  - the focused Vitest files the task names (`npx vitest run <files>`), then `npm run test:unit` (both Vitest roots)
    before the push — grep the summary line, not the exit code;
  - `npm run typecheck` (includes `npm run typecheck:tests`);
  - `npm run check:repo-style:changed -- origin/main HEAD`;
  - `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD` (commit a registry fix before
    re-running: the checker reads the head revision);
  - `npx dprint check <every touched file>` (never a glob; `npx dprint fmt <files>` only on touched files);
  - whenever `packages/shared`, `packages/shared-server` or `packages/shared-test` changed:
    `cd apps/api-v1 && deno task check`, `cd apps/rallar-black-box-control-server && deno task check`,
    `cd apps/relic-hunter-server-v1 && deno task check`, then `npm run test:deno` (it runs both apps' `test/**`);
  - for any change reaching the browser:
    `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`
    and `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`;
  - for a black-box recipe change: the strict preflight
    `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/tests/api-v1/<recipe>.json --validate --strict`
    (zero `STRICT_EXPECT_VACUOUS`/`STRICT_EXPECT_IGNORED`),
    `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts`, and, unsandboxed (it binds loopback ports),
    `npm run test:api-v1:black-box:memory` — verify the summary line;
  - the smoke lane `RALLAR_BLACK_BOX_ALM_SCOPE=smoke npm run -s test:rallar:full-stack:memory:alm` (unsandboxed;
    verify the summary line) after Tasks 1, 2 and 3, which change what every WS send tracks;
  - `npm run test:repo-governance` when docs under `docs/`, `examples/` or `.agents/` change.
- Every task ends with a commit, pushed to `claude/alm-s3c-consumer-proofs-volatile-bound` (never `main`).
- Acceptance follows D51: the local full lanes on normal pages plus the both-normal hosted smoke; the hosted full read
  is attempted at most twice and reported, never a blocker (Q13).
- PRs land through the maintainer's review: no `pr:delivery -- ready`, no auto-merge.

## Pre-execution rulings

Each §10 question in one line with the answer this plan is written under — the recommendation the maintainer took on
2026-09-28 (the decision row it amends in brackets). The controller records R-S3c-i-0 before Task 1: these thirteen
as settled, and its ruling on C1–C16.

1. **Q1** — two PRs: S3c-i addressed sends and server receipts (this plan), then S3c-ii the director command and the
   volatile bound [D70; D53, D57, D58, D61 here; D59, D60 in S3c-ii].
2. **Q2** — the server address is a `unicast` to the learned server id: no envelope bump, no new mode; the server keeps
   its own ACK and opens no aggregate for a server-addressed message [D76, D57 as applied].
3. **Q3** — the client learns the id from a `serverPeerId` field on `/api/config` [D76].
4. **Q4** — an authorized room-scoped unicast is delivered by the router: the server receives it locally and the router
   publishes it per topic fanout [D71].
5. **Q5** — `toFrozenAudience` gets a unicast case (the addressee alone); a `receiver` unicast with no room aggregate
   source is refused; an addressee outside the authorized audience is refused, not completed; the client plans
   `expectedPeerIds: []` and the `admitted` receipt names `[toPeerId]` [D71].
6. **Q6** — Relic commands on the `command` channel to the server: the handler catches rule errors, `username` comes
   from the session, REST stays one release as the fallback, the rule-error UI text is a stated regression,
   per-game serialization stays process-local [D72].
7. **Q7** — the snapshot publish: `groupRef`, the server peer id as sender, `receiver` at-least-once, the audience
   frozen from a server-side live-sessions read passed as the admitted audience, the 15 s TTL kept; cluster delivery
   carries the admitted audience at both sends [D77].
8. **Q8** — the settlement sink is a bounded in-memory per-process recorder on `/api/admin/operations/realtime`: per
   message the confirmed and unconfirmed sessions, the last settlement kind, `receipt-exhausted` [D73, D61].
9. **Q9** — the volatile bound: S3c-ii [D74, D78].
10. **Q10** — AR Eye Hunter intents: S3c-ii [D75].
11. **Q11** — the typed-channel per-send target `{ peerId }` [D75]: S3c-i adds it for WS only, because the Relic
    cutover needs it (see the header); S3c-ii adds it for RTC and the fallback strategy.
12. **Q12** — in S3c-i: leavers read unconfirmed on the WS leg [D73, amending D66]; in S3c-ii: the empty-audience
    volatile pin and a typed `evidence.failure`; out (V1): post-admission fallback for `ws-then-rtc` and for a resumed
    durable message [D75].
13. **Q13** — the medium-scale PostgreSQL gate runs once in S3c-i (the router-published unicast, the server outbox
    publish, the sink); hosted smoke on the PR; at most two hosted full reads [D76, D51].

### Choices this plan makes inside those answers

Each is recorded with the pre-execution rulings; the cost says what a reviewer gives up by accepting it.

- **C1 — A room-scoped unicast names its room.** Correction 21 below: the api-v1 room authorizer finds a room only
  through a `GroupRef`, which a unicast target has no field for, so every client unicast on a `room.*` topic is
  refused `unauthorized` today. `ALTargets`' unicast variant gains an optional `groupRef` (the canonical ref, as a
  room broadcast carries it); `newALUnicastMessage` accepts it with a `delivery`; `readALTargetGroupRef` reads it;
  `isRoomScopedALMessage` counts a unicast that names a room as room-scoped; both strict decoders accept it. That is
  a persisted-shape change, so `AL_ADMISSION_SCHEMA_ID` bumps to `'rallar-alm-2026-09-s3c-i'` (Task 1). Cost: every
  browser's ALM IndexedDB stores reset once at deploy; the WS server's PostgreSQL admission rows holding a unicast
  with `groupRef` are undecodable to a rolled-back server for their TTL (D46's acceptance).
- **C2 — Q5's "no aggregate source" refusal is the admission's `unsupported`.** `receiver` on a WS unicast is
  supported exactly when the unicast names its room (`validateALAckSupport`); one that names none is refused
  `unsupported` at admission, on the client and in the server's own outbound planning alike (D42's machinery, so
  `rtc-with-ws-fallback` treats it as it treats every `unsupported`). D71 words the refusal as "a `receiver` unicast on
  a non-room topic"; under C1 the room a unicast names, not its topic's prefix, is what gives the server an aggregate
  source, so the test is `groupRef`. Cost: a server-addressed `receiver` command must name its room too — Relic's
  does — and a `receiver` unicast on a `room.*` topic that names no room is refused at admission rather than by the
  router's authorizer.
- **C3 — Q5's out-of-audience refusal is a pre-admission NACK the origin states.** A room-scoped unicast to a session
  outside the audience its room admitted is refused before admission by `toWsQueueBoxServerAddresseeAuthorization`
  with a NACK `unauthorized`, in every ack mode (the router could not deliver it either). The origin has no receipt
  row yet for that NACK to end (Correction 22), so its control admission states `relay-rejected`
  `{ relay: 'trusted-server', reason: 'unauthorized' }` for a trusted-server `unauthorized` NACK of a message it sent
  and tracks no row for; the handle reads `rejected`. Cost: a room `receiver` send the router refuses before admission
  (a non-member) also reads `rejected` now instead of `expired` at its deadline — an evidence improvement that moves
  any pin on it. The refusal sends its NACK exactly when the wrapped authorizer does
  (`WsServerInboundAuthorizer.sendNacks`, the router's `sendNacks` option; R-S3c-i-18). The check runs at admission
  only, not at the dispatch re-authorization (`readCurrentDispatchAuthority`): an addressee who leaves between
  admission and dispatch is not re-refused — the router narrows delivery away from it, and the one-member receipt
  reads unconfirmed (`timed-out`) at its deadline.
- **C4 — Router-owned delivery is a plan change, gated on the router owning room fanout.**
  `toWsQueueBoxServerInboundPlan` (moved out of the aggregation file into its own) enables local delivery and the
  server's own ACK plan for an authorized room-scoped unicast to another session, only when the service does not
  forward room-scoped messages itself (`forwardsRoomScopedMessages: false`, the Rallar composition). Cost: a standalone
  forwarding composition keeps forwarding such a unicast and never hands it to a router.
- **C5 — `serverPeerId` is the WS server service's own `name`.** api-v1 serves
  `{ ...toApiV1PublicConfiguration(...), serverPeerId: runtime.wsQBoxServerService.name }`; Relic's own
  `/api/config` route (`main.ts:89`, registered before api-v1's) serves `rallar.ws.serverPeerId`. The served shape is
  `ApiConfigResponse extends ApiConfig`; `ApiConfig` stays the configured projection Relic's configuration builds
  before the server exists. `ApiConfigResponse.serverPeerId` is optional: absence is a server that predates S3c-i
  ("server unknown", R-S3c-i-6), which the decoder accepts so a rolling deploy never strands a new browser. Cost: one
  more response type name in `@shared/api`, and the deploy order matters — the server ships before the browser, or a
  new browser meets an old server as "server unknown" and runs without the WS hop receipt and with Relic on REST until
  the server is upgraded (the PR body states the order).
- **C6 — The WS client tracks the server as the one hop it has.** `toWsQueueBoxClientAckTrackingPlan` expects
  `[serverPeerId]` for a unicast addressed to the server and for every `hop`/`subtree` WS send (R-S3a-4 closed),
  `[]` for a `receiver` send to a session or a room; with no server id known (R-S3c-i-6) it keeps the plan it had
  before, tracking no server hop. Cost: a `hop` unicast to a session now completes at the server's hop ACK, not at the
  addressee's (whose hop ACK the server has always refused as unaggregated).
- **C7 — Q11 minimal, WS only** (the header). Cost: two public members (`peerId`, `serverPeerId()`), and a typed `send`
  with a `peerId` on an RTC strategy throws until S3c-ii.
- **C8 — The publish audience is read only for the D58 shape.** The router option `readServerPublishAudience`
  (api-v1: the current group snapshot's active members' live sessions — the authorizer's own
  `toAuthorizedRoomAudience`) is consulted only for an `outbox` publish of a room broadcast whose sender is the server
  peer id. Cost: other server publishes (the AI result publication, the game authority server) keep resolving their
  room at dequeue.
- **C9 — Both cluster sends read the captured audience from the shared admission store.** The publishing instance's
  direct send and every other instance's send call `readAdmittedAudience(msgId)` and narrow with it; the pub/sub
  notice is unchanged — PostgreSQL `NOTIFY` payloads end at 8 000 bytes, below a 256-session audience. Cost: one
  admission-store read per cluster send.
- **C10 — The recorder.** `RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY = 256` (the AL collection limit); an entry opens on
  the message's first `acknowledgement` or `receipt-exhausted` and a later settlement only moves `lastSettlementKind`;
  the least recently updated entry is evicted; not part of the metrics reset. Cost: a receipt with no fact yet is not
  listed; the 257th message evicts the oldest.
- **C11 — Leavers on the WS leg (Q12).** A message carrying a frozen multicast audience (an RTC leg handed over, D66)
  is aggregated over that audience verbatim, minus the origin; delivery stays the authorized sessions. The expected
  set may therefore exceed the delivered set by design: a frozen recipient the room no longer admits — a leaver, or any
  id the origin froze, up to the collection limit — is expected, never delivered to, and reads unconfirmed. The
  "narrow, never widen" invariant of `resolveALAdmittedRoomAudience` (`al-frozen-multicast-audience.ts:50-56`) is
  amended in the same step to name the delivery audience only (R-S3c-i-11). Cost: a leaver makes that WS receipt
  `timed-out` instead of `complete`, and an origin can make its own receipt unconfirmable.
- **C12 — Relic's WS handler catches everything the apply throws.** It reads the username from the auth session
  store (`readSessionUsername`), logs a rule error or a storage failure, and never rethrows. Cost: a storage failure
  on the WS path is not retried (REST keeps its HTTP error).
- **C13 — REST is Relic's fallback only when no WS server id is known.** The runtime never re-sends over REST after a
  WS attempt, which could apply a command twice. "No id known" is the pre-connect window and a server that serves no
  `serverPeerId` (one that predates S3c-i, R-S3c-i-6); against a server that serves it, REST is reached only before
  connect. Cost: a WS command whose receipt fails reads failed, not retried.
- **C14 — The snapshot's room is `{ DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID, roomId }`**, the scope
  Relic's REST policy reads (`main.ts:199-203`).
- **C15 — Recipes.** One new recipe `api-v1-websocket-addressed-sends` (profiles `api-v1-black-box` and
  `api-v1-black-box-recipes`) for D53, `serverPeerId` and the server-addressed receipt; one step appended to
  `api-v1-admin-operations` for `almReceipts`; no Relic recipe — no black-box recipe runner targets the Relic server.
  Its Deno tests and the real-server Playwright spec `tests/playwright/relic-hunters/full-stack-propagation.spec.ts`
  (`npm run test:playwright:relic:full-stack`, unsandboxed, in Tasks 5 and 6, R-S3c-i-10) carry the Relic share.
  The addressee's own ACK is not sent from a recipe (a raw ACK envelope's strict route key is not authorable there);
  the complete receipt is pinned by Vitest and Deno tests.
- **C16 — Six tasks, not the survey's five.** The typed-channel peer target is its own task (public surface and
  bundle), between the server address and the server receipts.

### Corrections this plan found beyond the survey's twenty

21. **Room-topic unicasts are refused at authorization on api-v1, not admitted and dropped** (survey correction 4).
    `authorizeRallarServerWsIngress` calls the room authorizer for a `room.*` topic; `createGroupRoomWsAuthorizer`
    reads its snapshot by `input.roomRef ?? readALTargetGroupRef(message)`, both undefined for a unicast, so the
    decision is `false` → `unauthorized` (`ws-topic-room-authorizer.ts:122-154`). That includes the director relay's
    WS fallback today. Hence C1.
22. **A pre-admission refusal of a `receiver` WS send leaves the origin waiting for its deadline.** The origin writes
    no receipt row for an empty expected set, and a terminal NACK only removes an existing row
    (`compute-al-outbound-control-admission.ts:218-231`), so nothing settles. Hence C3.
23. **The Relic server serves its own `/api/config`** (`main.ts:89`) ahead of api-v1's route, so it must add the
    field itself (C5).

### Carried into S3c-i

- **The WS `hop`/`subtree` receipt** (R-S3a-4, S3b Q7): Task 2 (C6).
- **Leavers read unconfirmed on the WS leg** (S3b Q8's alternative, §10 Q12): Task 4 (C11).
- **Cluster delivery ignoring the carried audience** (S2c-ii carried limitation, D58): Task 4 (C9).
- **The server's settlement sink is `undefined`** (S3b; the server's shared repair owner states `receipt-exhausted`
  into it): Task 4.

### Carried to S3c-ii / later

- **S3c-ii:** the RTC unicast and the unicast fallback (Q11's RTC half; `sendTyped`'s `peerId` refusal lifts); D60
  (AR Eye Hunter intents); D59 (the volatile bound); the lane scenarios `ws-unicast-receipt`, `unicast-fallback`,
  `server-command`, `capacity`; a typed `evidence.failure`; the empty-audience volatile pin; the director relay's WS
  fallback, whose `sendWsUnicast` names no room and so stays refused by authorization until it passes its `roomRef`
  (the S3a pin `browser-message-handle-admission.test.ts:154` flips there).
- **Later:** post-admission fallback for `ws-then-rtc` and for a resumed durable message (V1); Relic's rule-error text
  on a reply channel (I1's `awaitReply`); cross-instance per-game serialization for Relic (process-local today);
  Relic's app-data write through AppInbox on both the WS and the REST path (named debt, R-S3c-i-8).

---

## File structure

**Task 1 — room-scoped unicast delivery and the WS unicast receipt (D53, Q4, Q5):**

- Create `packages/shared/al-contracts/is-al-unicast-addressed-to.ts` — whether a message is a unicast to one peer.
- Create `packages/shared/services/ws-queue-box-server/ws-queue-box-server-inbound-plan.ts` —
  `toWsQueueBoxServerInboundPlan` moved from the aggregation file, plus router-owned unicast delivery and the
  server-addressed exemption.
- Create `packages/shared/services/ws-queue-box-server/to-ws-queue-box-server-addressee-authorization.ts` — Q5's
  out-of-audience refusal.
- Modify `packages/shared/al-contracts/al-contract.ts:33-36` (unicast `groupRef`), `:164-167`/`:236-251`
  (`newALUnicastMessage` options), `:357-379` (`isRoomScopedALMessage`, `readALTargetGroupRef`);
  `packages/shared/al-contracts/al-message-persistence/assert-persisted-al-targets.ts:14-18`;
  `packages/shared/al-contracts/validate-al-ack-support.ts:24-52`;
  `packages/shared/alm/open-indexed-db-admission-database.ts:16`;
  `packages/shared/alm/delivery/al-delivery-lifecycle.ts:240-246`;
  `packages/shared/alm/outbound/compute-al-outbound-control-admission.ts:113-169`;
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts:214-236,281-293,335-347`;
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts:64-67,437-441,517-550` (call lines);
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts:110-112` (`sendNacks`);
  `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts:105-107` (the authorizer's
  `sendNacks`); `packages/shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts:10-42`;
  `packages/shared/alm/inbound/README.md:158,262`;
  `packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts:253-272`.
- Create `packages/shared-test/black-box-runner/tests/api-v1/api-v1-websocket-addressed-sends.json`; modify
  `packages/shared-test/black-box-runner/recipe-matrix.json` and `packages/tests/shared-test/recipe-matrix.test.ts:350-381,420-464`.
- Create `apps/api-v1/test/services/ws-room-live-runtime.ts` (moved helpers) and
  `apps/api-v1/test/services/ws-room-unicast-receipt.test.ts`; modify `apps/api-v1/test/services/ws-room-live-fanout.test.ts`.

**Task 2 — the server address and the WS hop receipt (D57 as applied, Q2, Q3, R-S3a-4):**

- Create `packages/shared-web/browser/connection/decode-api-config-response.ts`.
- Modify `packages/shared/api/api-config.ts:4-10` (`ApiConfigResponse`), `packages/shared/services/ws-queue-box-client-service.ts`
  (Input, Dependencies, one field, one call line), `ws-queue-box-client-receipt-tracking.ts`,
  `packages/shared-web/browser/connection/connection-http-api.ts:6-14`,
  `packages/shared-web/browser/connection/initialise-browser-middleware.ts:256-284`,
  `packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts:33-103`,
  `packages/shared-web/browser/rallar-connection-facade.ts:123-134`,
  `packages/shared-web/browser/session/session-connection-operations.ts:25-38`,
  `apps/api-v1/src/routes/config-route.ts:45-57`, `apps/api-v1/src/composition/create-api-v1-route-installers.ts:96`,
  `apps/api-v1/src/composition/create-default-rallar-server.ts:281`, `apps/relic-hunter-server-v1/src/main.ts:89`,
  `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts:74-99,152-175` (`serverPeerId`,
  and no default fanout for a unicast to the server, R-S3c-i-5),
  `apps/api-v1/resources/api-v1-openapi.yaml:3993-4004`, the recipe from Task 1 and its matrix description, and every
  WS client construction in tests (Step 8's list).

**Task 3 — the WS peer target on typed sends (Q11, WS only):**

- Create `packages/shared-web/browser/messages/create-browser-ws-unicast-message.ts`.
- Modify `packages/shared-web/browser/messages/rallar-message-contracts.ts:67-76`,
  `packages/shared-web/browser/messages/browser-rallar-message-sender.ts:160-215`.

**Task 4 — server-originated receipts, the cluster audience and the sink (D58, D61, Q7, Q8, Q12):**

- Create `packages/shared-server/rallar-system/websocket/read-server-publish-room-audience.ts`,
  `packages/shared-server/rallar-system/websocket/router/read-rallar-server-ws-publish-audience.ts`,
  `packages/shared-server/rallar-system/observability/alm-receipt-diagnostics.ts`.
- Modify `packages/shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts:105` (export),
  `.../router/rallar-server-ws-router-contracts.ts:149-157`, `.../router/rallar-server-ws-router.ts:74-146`,
  `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts:246-300,390-397`,
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-cluster-publication.ts`,
  `ws-queue-box-server-service.ts:165-169,605-615` (call lines), `ws-queue-box-server-receipt-aggregation.ts`
  (`toFrozenAudience`, as Task 1 left it), `packages/shared/al-contracts/al-frozen-multicast-audience.ts:50-56` (the
  invariant comment, C11),
  `packages/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts:34-40,147-182,245-252`,
  `packages/shared-server/rallar-system/middleware/rallar-middleware-construction.ts:86-88`,
  `packages/shared-server/rallar-system/middleware/create-rallar-middleware-infrastructure.ts:44`,
  `packages/shared/api/admin-operations-types.ts:106-123`,
  `packages/shared-server/rallar-system/admin-operations/read-admin-realtime.ts`,
  `apps/api-v1/src/admin-operations/create-api-v1-admin-operation-use-cases.ts:25-64`,
  `apps/api-v1/src/composition/api-v1-runtime.ts`, `apps/api-v1/src/composition/create-api-v1-runtime.ts:101-212,260-276`,
  `apps/api-v1/src/composition/create-default-rallar-server.ts:116-124,210-231`,
  `apps/api-v1/resources/api-v1-openapi.yaml:3675-3688`, `packages/shared-test/black-box-runner/tests/api-v1/api-v1-admin-operations.json`.

**Task 5 — the Relic cutover (D57, D58, D61, Q6, Q7):**

- Create `apps/relic-hunter-server-v1/src/to-relic-snapshot-message.ts`,
  `apps/relic-hunter-server-v1/src/apply-relic-ws-command.ts`, `apps/relic-hunters-v1/src/game/send-relic-ws-command.ts`,
  `apps/relic-hunters-v1/src/game/to-relic-command-phase.ts`, `apps/relic-hunters-v1/src/game/relic-command-delivery-row.tsx`.
- Modify `apps/relic-hunter-server-v1/src/relic-game-service.ts:26-159`, `apps/relic-hunter-server-v1/src/main.ts:60-69`,
  `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts:23-75,116-142,280-295,321-400`,
  `apps/relic-hunters-v1/src/game/useRelicHunters.ts:636-646` (call lines), `apps/relic-hunters-v1/src/App.tsx:1583`.

**Task 6 — docs, the gates, the PR:** the two ALM READMEs, the product description, the roadmap, the proposal, the
Relic runtime docs, the shared-server runtime navigation.

---

### Task 1: Room-scoped unicast delivery and the WS unicast receipt (D53, Q4, Q5)

**Files:**

- Create: `packages/shared/al-contracts/is-al-unicast-addressed-to.ts`,
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-inbound-plan.ts`,
  `packages/shared/services/ws-queue-box-server/to-ws-queue-box-server-addressee-authorization.ts`,
  `packages/shared-test/black-box-runner/tests/api-v1/api-v1-websocket-addressed-sends.json`,
  `apps/api-v1/test/services/ws-room-live-runtime.ts`.
- Modify: as "Task 1" in the file structure.
- Test: create `packages/tests/shared/al-contracts/al-unicast-room-targets.test.ts`,
  `packages/tests/shared/services/ws-queue-box-server-addressed-receipts.test.ts`,
  `apps/api-v1/test/services/ws-room-unicast-receipt.test.ts`; modify
  `packages/tests/shared/al-contracts/validate-al-ack-support.test.ts:53-60`,
  `packages/tests/shared/services/ws-queue-box-client-receipt-tracking.test.ts` (one describe),
  `packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts` (one case),
  `apps/api-v1/test/services/ws-room-live-fanout.test.ts` (helpers moved out),
  `packages/tests/shared-test/recipe-matrix.test.ts` (two pinned lists),
  `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts` (one case, one refused shape), and every
  `authorizeInboundMessagesWith` authorizer in `packages/tests` (`sendNacks`, Step 7's list).

**Interfaces:**

- Produces on `ALTargets`: the unicast variant `Readonly<{ mode: 'unicast'; toPeerId: string; groupRef?: GroupRef; }>`.
- Produces `newALUnicastMessage(senderId, route, toPeerId, typeId, resource, options?: ALMessageBuilderOptions & Readonly<{ groupRef?: GroupRef; reliability?: 'best-effort' | 'at-least-once'; ack?: ALAckMode; ownership?: 'shared' | 'exclusive'; }>): ALMessage`
  — a `delivery` is written only when `reliability` or `ack` is given, so every existing caller's envelope is unchanged.
- Produces `isALUnicastAddressedTo(message: ALMessage, peerId: string): boolean`.
- Produces `toWsQueueBoxServerInboundPlan(input: ToWsQueueBoxServerInboundPlanInput): ALMessageHandlingPlan` with
  `ToWsQueueBoxServerInboundPlanInput = { plan; message; source; serverPeerId: string; routerOwnsRoomFanout: boolean }`
  (moved from `ws-queue-box-server-receipt-aggregation.ts`; the old two-argument export is deleted).
- Produces `toWsQueueBoxServerAddresseeAuthorization(input: ToWsQueueBoxServerAddresseeAuthorizationInput): WsServerInboundAuthorization`
  with `{ message: ALMessage; serverPeerId: string; sendNack: boolean; authorization: WsServerInboundAuthorization }`.
- Produces `WsServerInboundAuthorizer.sendNacks: boolean` (required; the router passes its `sendNacks` option).
- Produces `ALDeliveryRelayRejection`'s trusted-server variant `reason: 'resync-required' | 'unauthorized'`.
- Produces `AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-09-s3c-i'`.
- Produces the recipe id `api-v1-websocket-addressed-sends` (Task 2 appends steps to it).
- Task 2 consumes `isALUnicastAddressedTo` in the client tracking; Task 3 consumes the new `newALUnicastMessage`
  options; Task 4 extends `toFrozenAudience` in the same aggregation file.

- [ ] **Step 1: RED — the contract.** Create `packages/tests/shared/al-contracts/al-unicast-room-targets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
    isRoomScopedALMessage,
    newALRoute,
    newALUnicastMessage,
    readALTargetGroupRef
} from '@shared/al-contracts/al-contract.ts';
import {
    decodeALMessageValue,
    decodePersistedALMessageValue
} from '@shared/al-contracts/al-message-persistence-validation.ts';
import { isALUnicastAddressedTo } from '@shared/al-contracts/is-al-unicast-addressed-to.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const ROUTE = newALRoute('app.command', 'room-1', 'resource-1');

describe('a unicast that names its room (D53, S3c-i C1)', () => {
    it('carries the room and the delivery it was built with, and is room-scoped', () => {
        const message = newALUnicastMessage('a', ROUTE, 'b', 'app.command.v1', { go: true }, {
            groupRef: ROOM,
            ttlMs: 30_000,
            reliability: 'at-least-once',
            ack: 'receiver',
            ownership: 'shared'
        });

        expect(message.targets).toEqual({ mode: 'unicast', toPeerId: 'b', groupRef: ROOM });
        expect(message.delivery).toEqual({
            ownership: 'shared',
            reliability: 'at-least-once',
            ack: 'receiver'
        });
        expect(readALTargetGroupRef(message)).toEqual(ROOM);
        expect(isRoomScopedALMessage(message)).toBe(true);
    });

    it('keeps a unicast built without a room or a delivery exactly as before', () => {
        const message = newALUnicastMessage('a', ROUTE, 'b', 'app.command.v1', { go: true }, {
            ttlMs: 30_000
        });

        expect(message.targets).toEqual({ mode: 'unicast', toPeerId: 'b' });
        expect(message.delivery).toBeUndefined();
        expect(readALTargetGroupRef(message)).toBeUndefined();
        expect(isRoomScopedALMessage(message)).toBe(false);
    });

    it('decodes a room-naming unicast live and persisted, and refuses one whose room is not canonical', () => {
        const wire: unknown = JSON.parse(JSON.stringify(
            newALUnicastMessage('a', ROUTE, 'b', 'app.command.v1', {}, {
                groupRef: ROOM,
                ttlMs: 30_000
            })
        ));

        expect(decodeALMessageValue(wire).right?.targets).toEqual({
            mode: 'unicast',
            toPeerId: 'b',
            groupRef: ROOM
        });
        expect(decodePersistedALMessageValue(wire).targets).toEqual({
            mode: 'unicast',
            toPeerId: 'b',
            groupRef: ROOM
        });
        const loose = {
            ...(wire as Record<string, unknown>),
            targets: { mode: 'unicast', toPeerId: 'b', groupRef: { groupId: 'room-1' } }
        };
        expect(decodeALMessageValue(loose).left).toBeDefined();
    });

    it('names a unicast addressed to exactly one peer', () => {
        const toServer = newALUnicastMessage('a', ROUTE, 'server', 'app.command.v1', {}, {
            groupRef: ROOM
        });

        expect(isALUnicastAddressedTo(toServer, 'server')).toBe(true);
        expect(isALUnicastAddressedTo(toServer, 'b')).toBe(false);
        expect(
            isALUnicastAddressedTo({
                ...toServer,
                targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM }
            }, 'server')
        )
            .toBe(false);
    });
});
```

In `packages/tests/shared/al-contracts/validate-al-ack-support.test.ts` replace the test at `:53-60`
("refuses receiver on a WS unicast, whose receiver ACK no relay carries back to the origin (D42)") with:

```ts
it('admits receiver on a WS unicast that names its room and refuses one that names none (D53, C2)', () => {
    const roomless: ALTargets = { mode: 'unicast', toPeerId: 'peer' };
    const inRoom: ALTargets = { mode: 'unicast', toPeerId: 'peer', groupRef: room };

    expect(
        validateALAckSupport({
            algo: 'receiver',
            carrier: 'ws',
            targets: roomless,
            capabilities: wsCapabilities
        })
    )
        .toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for ws unicast targets' }]);
    expect(
        validateALAckSupport({
            algo: 'receiver',
            carrier: 'ws',
            targets: inRoom,
            capabilities: wsCapabilities
        })
    )
        .toEqual([]);
    expect(
        validateALAckSupport({
            algo: 'receiver',
            carrier: 'rtc',
            targets: roomless,
            capabilities: rtcCapabilities
        })
    )
        .toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails.**

  Run: `npx vitest run packages/tests/shared/al-contracts/al-unicast-room-targets.test.ts packages/tests/shared/al-contracts/validate-al-ack-support.test.ts`
  Expected: FAIL — `is-al-unicast-addressed-to.ts` does not exist, the unicast carries no `groupRef` or `delivery`,
  and `ws` `receiver` on the room-naming unicast is refused.

- [ ] **Step 3: GREEN — the contract.** In `packages/shared/al-contracts/al-contract.ts`:

  - Replace the unicast variant of `ALTargets` (`:33-36`) with:

```ts
| Readonly<{
    mode: 'unicast';
    toPeerId: string;
    /** The room the unicast is addressed in: its room's authority admits it and the room's router delivers it (D53). */
    groupRef?: GroupRef;
}>
```

- After `type ALMessageBuilderOptions` (`:164-167`) add the non-exported option type, and replace
  `newALUnicastMessage` (`:236-251`) with:

```ts
type ALUnicastMessageBuilderOptions =
    & ALMessageBuilderOptions
    & Readonly<{
        groupRef?: GroupRef;
        reliability?: 'best-effort' | 'at-least-once';
        ack?: ALAckMode;
        ownership?: 'shared' | 'exclusive';
    }>;
```

```ts
export function newALUnicastMessage<T>(
    senderId: string,
    route: ALRoute,
    toPeerId: string,
    typeId: string,
    resource: T,
    options?: ALUnicastMessageBuilderOptions
): ALMessage {
    return {
        ...newALUntargetedMessage(senderId, route, typeId, resource, options),
        targets: options?.groupRef === undefined
            ? { mode: 'unicast', toPeerId }
            : { mode: 'unicast', toPeerId, groupRef: toALGroupRef(options.groupRef) },
        ...(options?.reliability === undefined && options?.ack === undefined
            ? {}
            : {
                delivery: {
                    ownership: options?.ownership,
                    reliability: options?.reliability ?? 'best-effort',
                    ack: options?.ack ?? 'none'
                }
            })
    };
}
```

- Replace `isRoomScopedALMessage` (`:357-362`) and the head of `readALTargetGroupRef` (`:364-368`) with:

```ts
export function isRoomScopedALMessage(message: ALMessage): boolean {
    return message.route.topicId.startsWith('room.') ||
        message.targets?.mode === 'multicast' ||
        (message.targets?.mode === 'unicast' && message.targets.groupRef !== undefined) ||
        (message.targets?.mode === 'broadcast' &&
            message.targets.scope === 'room');
}

export function readALTargetGroupRef(message: ALMessage): GroupRef | undefined {
    const targets = message.targets;
    if (targets?.mode === 'unicast') {
        return targets.groupRef === undefined ? undefined : toALGroupRef(targets.groupRef);
    }
    if (targets?.mode === 'multicast') {
        return toALGroupRef(targets.groupRef);
    }
```

    and extend its doc comment ("Whether a message addresses a room audience by its own shape — ...") with
    "a unicast that names its room," after "a multicast,".

In `packages/shared/al-contracts/al-message-persistence/assert-persisted-al-targets.ts` replace the unicast branch
(`:14-18`) with:

```ts
if (targets.mode === 'unicast') {
    requirePersistedALFields(targets, ['mode', 'toPeerId', 'groupRef'], ['mode', 'toPeerId']);
    requirePersistedALNonEmptyString(targets.toPeerId, 'unicast peer');
    if (targets.groupRef !== undefined) {
        assertCanonicalGroupRef(targets.groupRef);
    }
    return;
}
```

Create `packages/shared/al-contracts/is-al-unicast-addressed-to.ts`:

```ts
import type { ALMessage } from './al-contract.ts';

/** Whether the message is a unicast to exactly this peer; the server tests its own id with it (D57 as applied). */
export function isALUnicastAddressedTo(message: ALMessage, peerId: string): boolean {
    return message.targets?.mode === 'unicast' && message.targets.toPeerId === peerId;
}
```

In `packages/shared/al-contracts/validate-al-ack-support.ts` replace the doc comment of `validateALAckSupport`
(`:24-28`) and `hasLogicalReceiverAudience` (`:47-52`) with:

```ts
/**
 * One issue naming an unsupported algorithm/carrier/target pair (D42). `receiver` needs a logical audience, which
 * only a unicast addressee or a room has; a world, all or principal broadcast has none. A WS unicast has its
 * addressee as its audience only when it names its room: the room's router delivers it and the server aggregates
 * the addressee's ACK (D53). One that names no room has no aggregate on the server and is refused.
 */
```

```ts
function hasLogicalReceiverAudience(
    targets: ALTargets | undefined,
    carrier: ALDeliveryCarrier
): boolean {
    if (targets?.mode === 'unicast') {
        return carrier !== 'ws' || targets.groupRef !== undefined;
    }
    return targets !== undefined && (targets.mode !== 'broadcast' || targets.scope === 'room');
}
```

In `packages/shared/alm/open-indexed-db-admission-database.ts:16` bump the schema id (the bump rule, C1):

```ts
export const AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-09-s3c-i';
```

- [ ] **Step 4: Run to verify it passes.**

  Run: `npx vitest run packages/tests/shared/al-contracts packages/tests/shared/al-message-persistence-decoding.test.ts packages/tests/shared/persistence packages/tests/shared/alm`
  Expected: PASS — every persisted-decoder pin holds, because a unicast without `groupRef` decodes as before.

- [ ] **Step 5: RED — the server's addressed receipts.** Create
      `packages/tests/shared/services/ws-queue-box-server-addressed-receipts.test.ts`:

```ts
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_CONTROL_ACK_TYPE_ID,
    AL_CONTROL_NACK_TYPE_ID,
    AL_CONTROL_RECEIPT_TYPE_ID
} from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import {
    newALAckControlMessage,
    type ALAckPayload,
    type ALNackPayload,
    type ALReceiptPayload
} from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { toWsQueueBoxServerAddresseeAuthorization } from '@shared/services/ws-queue-box-server/to-ws-queue-box-server-addressee-authorization.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

const SERVER_ID = 'server';
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
/** The sessions the room's authority admits; `c` is connected but not a member. */
const ROOM_SESSIONS: readonly string[] = ['a', 'b'];

interface AddressedFixture {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly sockets: Readonly<Record<'a' | 'b' | 'c', SimulatedWebSocket>>;
    /** Every message the stub router took from the service's inbox. */
    readonly routed: ALMessage[];
}

describe('WS server receipts for addressed sends (D53, D57 as applied)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('delivers a room unicast to its addressee through the router and answers the origin with the addressee alone', async () => {
        const fixture = await createAddressedFixture();

        const admitted = await fixture.service.acceptIncomingMessage(
            roomUnicast('to-b', 'b', 'receiver'),
            'a'
        );

        expect(admitted.right?.kind).toBe('admitted');
        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readReceipts(fixture.sockets.a).map((
                receipt
            ) => [receipt.phase, receipt.expectedRecipientPeerIds]);
        }).toEqual([['admitted', ['b']]]);
        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readFrames(fixture.sockets.b).map((message) => message.id.msgId);
        }).toEqual(['to-b']);
        expect(fixture.routed.map((message) => message.id.msgId)).toEqual(['to-b']);
        expect(readFrames(fixture.sockets.c)).toEqual([]);
    });

    it('completes the one-member receipt on the addressee\'s own ACK', async () => {
        const fixture = await createAddressedFixture();
        await fixture.service.acceptIncomingMessage(roomUnicast('to-b', 'b', 'receiver'), 'a');
        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readFrames(fixture.sockets.b).length;
        }).toBe(1);

        const counted = await fixture.service.acceptIncomingMessage(addresseeAck('to-b', 'b'), 'b');

        expect(counted.left).toBeUndefined();
        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readReceipts(fixture.sockets.a).map((
                receipt
            ) => [receipt.phase, receipt.confirmedRecipientPeerIds]);
        }).toEqual([['admitted', []], ['complete', ['b']]]);
    });

    it('refuses a room unicast to a session outside the admitted audience before admission, with a NACK (Q5)', async () => {
        const fixture = await createAddressedFixture();

        const refused = await fixture.service.acceptIncomingMessage(
            roomUnicast('to-c', 'c', 'receiver'),
            'a'
        );

        expect(refused.left).toEqual({
            code: 'unauthorized',
            message: 'AL unicast to-c addresses c, who is not in the audience its room admitted'
        });
        expect(readNacks(fixture.sockets.a).map((nack) => [nack.msgId, nack.reason])).toEqual([[
            'to-c',
            'unauthorized'
        ]]);
        await fixture.engine.executeOnce();
        expect(fixture.routed).toEqual([]);
        expect(readReceipts(fixture.sockets.a)).toEqual([]);
        expect(readFrames(fixture.sockets.c)).toEqual([]);
    });

    it('refuses an out-of-audience addressee with the NACK policy its authorizer was configured with (C3)', () => {
        const refusal = toWsQueueBoxServerAddresseeAuthorization({
            message: roomUnicast('to-c', 'c', 'receiver'),
            serverPeerId: SERVER_ID,
            sendNack: false,
            authorization: {
                authorized: true,
                roomAudience: { recipientPeerIds: ROOM_SESSIONS, snapshotVersion: 3 }
            }
        });

        expect(refusal).toMatchObject({
            authorized: false,
            reason: 'unauthorized',
            sendNack: false
        });
    });

    it('keeps its own ACK for a receiver unicast addressed to itself and opens no aggregate (Q2)', async () => {
        const fixture = await createAddressedFixture();

        const admitted = await fixture.service.acceptIncomingMessage(
            roomUnicast('to-server', SERVER_ID, 'receiver'),
            'a'
        );

        expect(admitted.right?.kind).toBe('admitted');
        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readAcks(fixture.sockets.a).map((
                ack
            ) => [ack.ackedMsgId, ack.fromPeerId, ack.logicalRecipientPeerId]);
        }).toEqual([['to-server', SERVER_ID, SERVER_ID]]);
        expect(readReceipts(fixture.sockets.a)).toEqual([]);
        expect(fixture.routed.map((message) => message.id.msgId)).toEqual(['to-server']);
    });

    it('acknowledges a hop room unicast to another session itself, as the origin\'s one hop', async () => {
        const fixture = await createAddressedFixture();

        await fixture.service.acceptIncomingMessage(
            roomUnicast('hop-to-b', 'b', 'none', { ack: { algo: 'hop' } }),
            'a'
        );

        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readAcks(fixture.sockets.a).map((ack) => [ack.ackedMsgId, ack.fromPeerId]);
        }).toEqual([['hop-to-b', SERVER_ID]]);
        expect(readFrames(fixture.sockets.b).map((message) => message.id.msgId)).toEqual([
            'hop-to-b'
        ]);
    });
});

async function createAddressedFixture(): Promise<AddressedFixture> {
    const socketServer = new JsonWebSocketServer();
    const sockets = {
        a: new SimulatedWebSocket('ws://a'),
        b: new SimulatedWebSocket('ws://b'),
        c: new SimulatedWebSocket('ws://c')
    };
    for (const [peerId, socket] of Object.entries(sockets)) {
        await socket.open();
        socketServer.addConnection(new ConnectionContext({ id: peerId, socket }));
    }
    const recipients = () =>
        [...socketServer.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }));
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        outbox: new InMemoryQueueBox(new Map()),
        socket: socketServer,
        name: SERVER_ID,
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        targetResolver: {
            resolvePeerRecipients: (peerId) =>
                recipients().filter((recipient) => recipient.peerId === peerId),
            resolveBroadcastRecipients: recipients
        }
    });
    service.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? {
                    authorized: true,
                    roomAudience: { recipientPeerIds: ROOM_SESSIONS, snapshotVersion: 3 }
                }
                : { authorized: true }
    });
    const routed: ALMessage[] = [];
    // The router's live fanout for a unicast: the addressee, narrowed to the admitted audience.
    service.onAnyInboxMessageDo('router', {
        onMessage: async (message) => {
            routed.push(message);
            if (message.targets?.mode === 'unicast' && message.targets.toPeerId !== SERVER_ID) {
                service.sendToTargetsWithResult(message, [message.targets.toPeerId], ROOM_SESSIONS);
            }
        }
    });
    onTestFinished(() => service.dispose());
    return { service, engine, sockets, routed };
}

function roomUnicast(
    msgId: string,
    toPeerId: string,
    ack: 'receiver' | 'none',
    qos?: ALMessage['qos']
): ALMessage {
    const nowMs = Date.now();
    return {
        id: { v: 2, msgId, ts: nowMs, senderId: 'a' },
        route: { topicId: 'room.command', resourceId: msgId, contextId: ROOM.groupId },
        targets: { mode: 'unicast', toPeerId, groupRef: ROOM },
        constraints: { expiresAtMs: nowMs + 30_000 },
        delivery: { reliability: 'at-least-once', ack },
        ...(qos === undefined ? {} : { qos }),
        payload: { typeId: 'command.v1', contentType: 'application/json', resource: '{}' }
    };
}

function addresseeAck(ackedMsgId: string, recipient: string): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${ackedMsgId}-${recipient}`, senderId: recipient, ts: Date.now() },
        {
            ackedMsgId,
            fromPeerId: recipient,
            toPeerId: 'a',
            originPeerId: 'a',
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}

function readMessages(socket: SimulatedWebSocket): readonly ALMessage[] {
    return socket.sent.map((frame) => decodePersistedALMessage(frame));
}

function readFrames(socket: SimulatedWebSocket): readonly ALMessage[] {
    return readMessages(socket).filter((message) =>
        !message.payload.typeId.startsWith('al.control.')
    );
}

function readControlPayloads(socket: SimulatedWebSocket, typeId: string): readonly unknown[] {
    return readMessages(socket)
        .filter((message) => message.payload.typeId === typeId)
        .map((message): unknown => JSON.parse(message.payload.resource));
}

function readReceipts(socket: SimulatedWebSocket): readonly ALReceiptPayload[] {
    return readControlPayloads(socket, AL_CONTROL_RECEIPT_TYPE_ID).map((payload) =>
        decodeALReceiptPayload(payload)
    );
}

function readAcks(socket: SimulatedWebSocket): readonly ALAckPayload[] {
    return readControlPayloads(socket, AL_CONTROL_ACK_TYPE_ID) as readonly ALAckPayload[];
}

function readNacks(socket: SimulatedWebSocket): readonly ALNackPayload[] {
    return readControlPayloads(socket, AL_CONTROL_NACK_TYPE_ID) as readonly ALNackPayload[];
}
```

- [ ] **Step 6: Run to verify it fails.**

  Run: `npx vitest run packages/tests/shared/services/ws-queue-box-server-addressed-receipts.test.ts`
  Expected: FAIL — the room unicast never reaches the router (no local delivery), `to-c` is admitted with an empty
  aggregate, and the server withholds its own ACK for `to-server`.

- [ ] **Step 7: GREEN — router-owned delivery, the one-member aggregate, the server-addressed exemption.**

  Create `packages/shared/services/ws-queue-box-server/ws-queue-box-server-inbound-plan.ts`:

```ts
import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { isALUnicastAddressedTo } from '../../al-contracts/is-al-unicast-addressed-to.ts';
import type { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';

export interface ToWsQueueBoxServerInboundPlanInput {
    readonly plan: ALMessageHandlingPlan;
    readonly message: ALMessage;
    readonly source: ALInboundMessageRuntime.Source;
    readonly serverPeerId: string;
    /** False when the service relays room-scoped messages itself (`forwardsRoomScopedMessages`). */
    readonly routerOwnsRoomFanout: boolean;
}

/**
 * The WS server's own changes to the plan of a message its router admitted to a room audience. A room unicast to
 * another session is the router's to deliver (Q4): the server receives it locally and plans its own ACK as for any
 * message it receives. A `receiver` message the server aggregates withholds that ACK, because the receipt speaks for
 * the audience; a message addressed to the server itself keeps it and opens no aggregate (D57 as applied).
 */
export function toWsQueueBoxServerInboundPlan(
    input: ToWsQueueBoxServerInboundPlanInput
): ALMessageHandlingPlan {
    const { source } = input;
    if (source.kind !== 'ws-client' || source.groupRecipientPeerIds === undefined) {
        return input.plan;
    }
    const plan = toRouterDeliveredPlan(input);
    const aggregated = plan.ack.algo === 'receiver' &&
        !isALUnicastAddressedTo(input.message, input.serverPeerId);
    return aggregated
        ? { ...plan, ack: { enabled: false, algo: plan.ack.algo, deferred: false } }
        : plan;
}

function toRouterDeliveredPlan(input: ToWsQueueBoxServerInboundPlanInput): ALMessageHandlingPlan {
    const { plan, message } = input;
    const routerDelivers = input.routerOwnsRoomFanout && message.targets?.mode === 'unicast' &&
        !isALUnicastAddressedTo(message, input.serverPeerId) && plan.dropReasonCode === undefined;
    return routerDelivers
        ? {
            ...plan,
            localDelivery: { ...plan.localDelivery, enabled: !plan.localDelivery.deferred },
            ack: {
                ...plan.ack,
                enabled: plan.ack.algo !== 'none' && plan.ack.toPeerId !== undefined
            }
        }
        : plan;
}
```

Create `packages/shared/services/ws-queue-box-server/to-ws-queue-box-server-addressee-authorization.ts`:

```ts
import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { WsServerInboundAuthorization } from './ws-queue-box-server-contracts.ts';

export interface ToWsQueueBoxServerAddresseeAuthorizationInput {
    readonly message: ALMessage;
    readonly serverPeerId: string;
    /** The wrapped authorizer's own NACK policy (`WsServerInboundAuthorizer.sendNacks`), so both refusals agree. */
    readonly sendNack: boolean;
    readonly authorization: WsServerInboundAuthorization;
}

/**
 * A room unicast to a session outside the audience its room admitted is refused before admission, with a NACK the
 * origin states (Q5, C3): admitted, its receipt would expect nobody and complete at once. A unicast to the server,
 * and a message the authorizer resolved no room audience for, keep their authorization.
 */
export function toWsQueueBoxServerAddresseeAuthorization(
    input: ToWsQueueBoxServerAddresseeAuthorizationInput
): WsServerInboundAuthorization {
    const { message, authorization } = input;
    const targets = message.targets;
    if (
        !authorization.authorized || authorization.roomAudience === undefined ||
        targets?.mode !== 'unicast'
    ) {
        return authorization;
    }
    const addressable = targets.toPeerId === input.serverPeerId ||
        (targets.toPeerId !== message.id.senderId &&
            authorization.roomAudience.recipientPeerIds.includes(targets.toPeerId));
    return addressable ? authorization : {
        authorized: false,
        reason: 'unauthorized',
        rejectionCode: 'unauthorized',
        logMessage:
            `AL unicast ${message.id.msgId} addresses ${targets.toPeerId}, who is not in the audience its room admitted`,
        sendNack: input.sendNack
    };
}
```

In `packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts`:

- delete `toWsQueueBoxServerInboundPlan` and its doc comment (`:281-293`), and drop `type ALMessageHandlingPlan`
  from the `al-policy.ts` import if nothing else in the file uses it;
- add `import { isALUnicastAddressedTo } from '../../al-contracts/is-al-unicast-addressed-to.ts';`;
- in `toAdmission` (`:226`) replace `return effective.ack.algo !== 'receiver' ? undefined : {` with

```ts
const aggregated = effective.ack.algo === 'receiver' && !isALUnicastAddressedTo(message, serverPeerId);
return !aggregated ? undefined : {
```

    and extend its doc comment with "A message addressed to the server itself is answered by the server's own ACK,
    never aggregated.";

- replace `toFrozenAudience` (`:335-347`) with:

```ts
/** The unicast addressee alone when the room admitted it (D53); a room send's authorized sessions but its origin. */
function toFrozenAudience(
    message: ALMessage,
    originPeerId: string,
    authorizedPeerIds: readonly string[]
): readonly string[] {
    const targets = message.targets;
    if (targets?.mode === 'unicast') {
        return targets.toPeerId !== originPeerId && authorizedPeerIds.includes(targets.toPeerId)
            ? [targets.toPeerId]
            : [];
    }
    return [...new Set(authorizedPeerIds)].filter((peerId) =>
        peerId !== originPeerId &&
        (targets?.mode !== 'broadcast' ||
            (!targets.exceptPeerIds?.includes(peerId) &&
                (targets.recipientPeerIds === undefined ||
                    targets.recipientPeerIds.includes(peerId))))
    );
}
```

In `packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts` (warn tier: call lines only):

- replace the aggregation import (`:64-67`) with

```ts
import { toWsQueueBoxServerAddresseeAuthorization } from './to-ws-queue-box-server-addressee-authorization.ts';
import { toWsQueueBoxServerInboundPlan } from './ws-queue-box-server-inbound-plan.ts';
import { WsQueueBoxServerReceiptAggregation } from './ws-queue-box-server-receipt-aggregation.ts';
```

- replace `const authorization = await this.inboundAuthorizer?.authorize(message) ?? { authorized: true };` in
  `acceptIncomingMessage` (`:440`) with (no authorizer resolves no room audience, so no addressee refusal can follow
  and its `sendNack` is never read):

```ts
const authorization = toWsQueueBoxServerAddresseeAuthorization({
    message,
    serverPeerId: this.name,
    sendNack: this.inboundAuthorizer?.sendNacks ?? false,
    authorization: await this.inboundAuthorizer?.authorize(message) ?? { authorized: true }
});
```

- replace the `return toWsQueueBoxServerInboundPlan(planALMessageHandling(...), source);` of `planIncomingMessage`
  (`:531-549`) with

```ts
return toWsQueueBoxServerInboundPlan({
    plan: planALMessageHandling(
        message,
        {
            ...observations,
            selfPeerId: this.name,
            fromPeerId,
            connectedPeerIds: recipientPeerIds,
            groupMemberPeerIds,
            overlayNeighborPeerIds: recipientPeerIds
        },
        resolveALQosNormalizationInput(
            message,
            { selfPeerId: this.name, fromPeerId, direction: 'inbound' },
            this.qosProvider
        )
    ),
    message,
    source,
    serverPeerId: this.name,
    routerOwnsRoomFanout: !this.forwardsRoomScopedMessages
});
```

In `packages/shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts` replace `WsServerInboundAuthorizer`
(`:110-112`) with (R-S3c-i-18):

```ts
export interface WsServerInboundAuthorizer {
    /** Whether a refusal answers its origin with a NACK; the service's addressee refusal follows it too (C3). */
    readonly sendNacks: boolean;
    authorize(message: ALMessage): Promise<WsServerInboundAuthorization>;
}
```

In `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts` (`install`, `:105-107`) add
`sendNacks: this.sendNacks,` as the first member of the object passed to `this.service.authorizeInboundMessagesWith`.
Add `sendNacks: true,` as the first member of every other authorizer object passed to `authorizeInboundMessagesWith`:
`packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts` (1 site),
`packages/tests/shared/services/ws-queue-box-server-ingress.test.ts` (13 sites),
`packages/tests/shared/services/ws-queue-box-server-receipt-aggregation.test.ts` (1),
`packages/tests/shared/services/ws-queue-box-server-receipt-row.test.ts` (1) and
`packages/tests/shared/ws-server-qos-policy.test.ts` (1). Prove completeness — every line prints two equal counts:

```bash
grep -rl 'authorizeInboundMessagesWith(' packages/tests apps --include='*.ts' | grep -v node_modules \
  | while read -r f; do
      echo "$f $(grep -c 'authorizeInboundMessagesWith(' "$f") $(grep -c 'sendNacks: true' "$f")"
    done
```

In `packages/shared/alm/inbound/README.md:158` point the link at the new file:
`([`toWsQueueBoxServerInboundPlan`](../../services/ws-queue-box-server/ws-queue-box-server-inbound-plan.ts)):`.
In the same README replace `:262`'s identity with `'rallar-alm-2026-09-s3c-i'` and add after that paragraph: "S3c-i
bumped it because a unicast may now name its room (`targets.groupRef`), which older decoders refuse (C1)." — the bump
and its record land in one commit (R-S3c-i-24).

- [ ] **Step 8: Run to verify the server passes.**

  Run: `npx vitest run packages/tests/shared/services/ws-queue-box-server-addressed-receipts.test.ts packages/tests/shared/services/ws-queue-box-server-receipt-aggregation.test.ts packages/tests/shared/services/ws-queue-box-server-ingress.test.ts packages/tests/shared/services/ws-queue-box-server-outbound-planning.test.ts packages/tests/shared/services/ws-queue-box-server-receipt-row.test.ts packages/tests/shared/ws-server-qos-policy.test.ts packages/tests/shared-server/rallar-system/rallar-server-ws-router.test.ts`
  Expected: PASS — the existing files unchanged but for `sendNacks: true` (a room broadcast keeps every earlier plan;
  a forwarding fixture, `routerOwnsRoomFanout: false`, keeps forwarding).

- [ ] **Step 9: RED — the origin's side.** In `packages/tests/shared/services/ws-queue-box-client-receipt-tracking.test.ts`
      add, after the first `describe`:

```ts
describe('WS client receipt tracking for a receiver unicast that names its room (D53)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('expects nobody at admission; the admitted receipt names the addressee and its complete receipt acknowledges it', async () => {
        const fixture = await createReceiptTrackingFixture();
        const unicast: ALMessage = {
            ...roomMessage(),
            id: { ...roomMessage().id, msgId: 'unicast-message-1' },
            targets: { mode: 'unicast', toPeerId: 'b', groupRef: ROOM }
        };
        expect((await fixture.service.enqueueOutboxIfAbsent(unicast)).verdict.kind).toBe(
            'admitted'
        );
        const readUnicastReceipt = async () =>
            await fixture.outboundStores.admissionStore.readReceiptState({
                originPeerId: 'self',
                msgId: 'unicast-message-1'
            });
        expect(await readUnicastReceipt()).toBeUndefined();

        await fixture.service.acceptIncomingMessage(
            receiptMessage('admitted', [], 'unicast-message-1', ['b'])
        );
        expect(await readUnicastReceipt()).toMatchObject({
            mode: 'receiver',
            expectedPeerIds: ['b'],
            ackedPeerIds: []
        });
        await fixture.service.acceptIncomingMessage(
            receiptMessage('complete', ['b'], 'unicast-message-1', ['b'])
        );

        expect(
            fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)
        ).toMatchObject({
            msgId: 'unicast-message-1',
            mode: 'receiver',
            confirmedRecipientPeerIds: ['b'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
    });
});
```

In `packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts` add inside the existing `describe`:

```ts
it('states the server refusing a room unicast to a non-member before admission; the receipted handle reads rejected (C3)', async () => {
    const fixture = await createRelayFixture();
    const origin = await createOriginClient();
    const unicast = roomUnicast('unicast-to-outsider', 'outsider');
    expect((await origin.service.enqueueOutboxIfAbsent(unicast)).verdict.kind).toBe('admitted');

    const refused = await fixture.server.acceptIncomingMessage(unicast, 'a');

    expect(refused.left?.code).toBe('unauthorized');
    expect(readSentNacks(fixture.sockets.a)).toHaveLength(1);
    await relayFrames(fixture.sockets.a, origin);
    expect(origin.settlements.filter((settlement) => settlement.kind === 'relay-rejected')).toEqual(
        [{
            kind: 'relay-rejected',
            msgId: 'unicast-to-outsider',
            carrier: 'ws',
            atMs: expect.any(Number),
            relayRejection: { relay: 'trusted-server', reason: 'unauthorized' },
            detail: 'The server refused the message before admitting it: unauthorized.'
        }]
    );
    const lifecycle = origin.settlements
        .filter((settlement) => settlement.msgId === 'unicast-to-outsider')
        .reduce(computeALDeliveryLifecycle, toInitialLifecycle('unicast-to-outsider', 'receiver'));
    expect(lifecycle.state).toBe('rejected');
    expect(lifecycle.evidence.relayRejection).toEqual({
        relay: 'trusted-server',
        reason: 'unauthorized'
    });
});
```

and beside `orderedRoomMessage`:

```ts
/** A receipted command to one session of the room, which names its room so the room's authority admits it. */
function roomUnicast(msgId: string, toPeerId: string): ALMessage {
    return {
        id: { v: 2, msgId, ts: Date.now(), senderId: 'a' },
        route: { topicId: 'room.command', resourceId: msgId, contextId: ROOM.groupId },
        targets: { mode: 'unicast', toPeerId, groupRef: ROOM },
        constraints: { expiresAtMs: Date.now() + 30_000 },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'command.v1', contentType: 'application/json', resource: '{}' }
    };
}
```

Run: `npx vitest run packages/tests/shared/services/ws-queue-box-client-receipt-tracking.test.ts packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts`
Expected: FAIL — the unicast writes a row expecting `['b']` at admission, and the `unauthorized` NACK states nothing.

- [ ] **Step 10: GREEN — the origin's side.** In `packages/shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts`
      replace the doc comment of `toWsQueueBoxClientAckTrackingPlan` (`:10-15`) and `toReceiptAudience` (`:34-42`) with:

```ts
/**
 * The receipt a WS send tracks. A `receiver` send expects nobody yet, a room's or a unicast's that names its room
 * (D53): the server's `admitted` receipt names the frozen audience the row is created from. Any other unicast
 * expects its addressee as its hop; any other room send tracks no receipt on WS.
 */
```

```ts
function toReceiptAudience(
    effective: ALQosEffectivePolicy,
    targets: ALMessage['targets']
): readonly string[] | undefined {
    if (targets?.mode === 'unicast') {
        return effective.ack.algo === 'receiver' ? [] : [targets.toPeerId];
    }
    return effective.ack.algo === 'receiver' && targets !== undefined ? [] : undefined;
}
```

In `packages/shared/alm/delivery/al-delivery-lifecycle.ts` replace `ALDeliveryRelayRejection` and its doc comment
(`:240-246`) with:

```ts
/**
 * The hop whose admitted NACK refused the message, and the reason it gave (D50); a trusted server may also refuse
 * a message before admitting it (`unauthorized`, S3c-i C3). A trusted server relay is not named.
 */
export type ALDeliveryRelayRejection =
    | Readonly<{ relay: 'trusted-server'; reason: 'resync-required' | 'unauthorized'; }>
    | Readonly<{ relay: 'peer'; peerId: string; reason: 'resync-required'; }>;
```

In `packages/shared/alm/outbound/compute-al-outbound-control-admission.ts` add, in `toALOutboundControlSettlements`
right after the `resync-required` branch (`:117-119`):

```ts
if (isServerRefusalBeforeReceipt(read)) {
    return [toServerRefusalFact(read)];
}
```

and beside `toRelayRejectedFact`:

```ts
/** The trusted server refused a message this owner sent before admitting it (C3): no receipt row exists for its NACK to end. */
function isServerRefusalBeforeReceipt(read: ALControlAdmissionRead): boolean {
    return read.parsed.type === 'nack' && read.parsed.payload.reason === 'unauthorized' &&
        read.source === 'trusted-server' && read.sent !== undefined && read.pending === undefined;
}

function toServerRefusalFact(read: ALControlAdmissionRead): ALOutboundSettlementFact {
    return {
        kind: 'relay-rejected',
        msgId: read.targetMsgId,
        relayRejection: { relay: 'trusted-server', reason: 'unauthorized' },
        detail: 'The server refused the message before admitting it: unauthorized.'
    };
}
```

The black-box harness decodes the same union strictly (R-S3c-i-4). In
`packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts` replace `readAlmRelayRejectionField`'s doc
comment and its first branch (`:253-267`) with:

```ts
/**
 * Absent unless a hop refused the message; a trusted server relay is never named, so an id on one is refused. A
 * trusted server refuses with `resync-required` after admission or `unauthorized` before it (S3c-i C3).
 */
function readAlmRelayRejectionField(
    record: RallarBlackBoxTestRecord,
    path: string
): ALDeliveryRelayRejection | undefined {
    const value = record.relayRejection;
    if (value === undefined) {
        return undefined;
    }
    const rejection = decodeAlmRuntimeRecord(value);
    if (
        (rejection.reason === 'resync-required' || rejection.reason === 'unauthorized') &&
        rejection.relay === 'trusted-server' && rejection.peerId === undefined
    ) {
        return { relay: 'trusted-server', reason: rejection.reason };
    }
```

(the `peer` branch and the final `throw` stay). In `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`
add `{ field: 'relayRejection', value: { relay: 'peer', peerId: 'relay-session', reason: 'unauthorized' } }` to the
`it.each` of unusable fields (`:893-904`), and after "sends a typed message and observes its delivery through the page
runtime" (`:451-506`):

```ts
it('reads a trusted server\'s refusal before admission from a delivery observation (S3c-i C3)', async () => {
    const rejection = { relay: 'trusted-server', reason: 'unauthorized' } as const;
    const runtime = createRallarBlackBoxBrowserTestRuntime({
        rallarRuntime: {
            ...createAlmBrowserRuntimeFake(createAlmRuntimeCaptures()),
            observeDelivery: async () => ({
                ...DELIVERY_OBSERVATION,
                state: 'rejected',
                relayRejection: rejection
            })
        }
    });

    const observed = await runtime.execute({
        kind: 'messages.observe',
        commandId: 'alm-observe-server-refusal',
        handleId: 'handle-1',
        state: ['rejected'],
        timeoutMs: 2_500
    });

    expect(observed.ok, observed.error?.message).toBe(true);
    expect(observed.value).toMatchObject({ state: 'rejected', relayRejection: rejection });
});
```

Run the Step 9 files again and `npx vitest run packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`.
Expected: PASS. Then
`npx vitest run packages/tests/shared/services packages/tests/shared/alm packages/tests/shared-web/messages` —
expected PASS. A pin that encoded a room `receiver` send refused `unauthorized` by the router expiring at its
deadline moves to `rejected` (C3's cost); name every such moved pin, with its old and new state, in the commit body.

- [ ] **Step 11: The api-v1 room unicast through the real router (Deno).** Create
      `apps/api-v1/test/services/ws-room-live-runtime.ts` by **moving** from `ws-room-live-fanout.test.ts`, verbatim and
      exported: the interfaces `RoomLiveSend`, `RoomDeliveryClock`, `LiveRoomTestRuntime` (`:36-51`) and the functions
      `createLiveRoomRuntime`, `waitForRoomSends`, `receiverAck`, `readOriginReceipts` (`:358-423`), with the imports they
      need:

```ts
import assert from 'node:assert/strict';

import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { newALAckControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { createOpenTestWebSocket } from '../../../../packages/tests/shared-server/rallar-system/websocket/test-support/open-test-websocket.ts';
import { createApiV1RoomWsAuthorizer } from '../../src/services/ws-topic-room-authorizer.ts';
import { createRoomStateTestRuntime, type RoomStateTestRuntime } from './ws-room-test-runtime.ts';
```

In `ws-room-live-fanout.test.ts` import `createLiveRoomRuntime`, `readOriginReceipts`, `receiverAck`,
`waitForRoomSends` from `./ws-room-live-runtime.ts` and delete the imports only the moved code used
(`createWsServerTargetResolver`, `AL_CONTROL_RECEIPT_TYPE_ID`, `decodeALReceiptPayload`, `newALAckControlMessage`,
`ALReceiptPayload`, `createDefaultInMemoryALOutboundRuntimeStores`, `ALOutboundRuntimeStores`,
`decodeWsQueueBoxServerPreparedMessage`, `WsQueueBoxServerPreparedMessage`, `createApiV1RoomWsAuthorizer`,
`RoomStateTestRuntime`). Find any left over with
`cd apps/api-v1 && deno lint test/services/ws-room-live-fanout.test.ts test/services/ws-room-live-runtime.ts` (its
`no-unused-vars` names an unused import; `deno task check` checks `src/main.ts` only and never sees `test/**`); type
errors in both files surface in `npm run test:deno`.

Create `apps/api-v1/test/services/ws-room-unicast-receipt.test.ts`:

```ts
import assert from 'node:assert/strict';

import {
    newALEventRoute,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { createGroupSnapshot } from '../../../../packages/tests/shared-server/rallar-system/group-state/snapshot/group-state-snapshot-test-fixtures.ts';
import {
    createLiveRoomRuntime,
    readOriginReceipts,
    receiverAck,
    waitForRoomSends,
    type RoomLiveSend
} from './ws-room-live-runtime.ts';
import { putRoomSnapshot } from './ws-room-test-runtime.ts';

Deno.test('a receiver room unicast reaches only its addressee and its receipt names the addressee alone (D53)', async () => {
    const snapshot = createGroupSnapshot(2, ['session-1', 'session-2', 'session-3']);
    const runtime = createLiveRoomRuntime(Date.now());
    try {
        await putRoomSnapshot(runtime.repository, snapshot);
        runtime.cache.observe(snapshot);
        runtime.router.install();
        const message = roomUnicast(snapshot.group, 'unicast-1', 'session-2');

        assert.deepEqual(
            (await runtime.service.acceptIncomingMessage(message, 'session-1')).right,
            { kind: 'admitted' }
        );
        await waitForRoomSends(() => roomSends(runtime.sent).length >= 1);
        await runtime.service.acceptIncomingMessage(receiverAck(message, 'session-2'), 'session-2');
        await waitForRoomSends(() => readOriginReceipts(runtime.sent).length >= 2);

        assert.deepEqual(roomSends(runtime.sent), [{
            sessionId: 'session-2',
            encoded: JSON.stringify(message)
        }]);
        assert.deepEqual(
            readOriginReceipts(runtime.sent).map((
                receipt
            ) => [
                receipt.phase,
                receipt.expectedRecipientPeerIds,
                receipt.confirmedRecipientPeerIds
            ]),
            [['admitted', ['session-2'], []], ['complete', ['session-2'], ['session-2']]]
        );
    }
    finally {
        runtime.service.dispose();
        await runtime.manager.clear();
    }
});

Deno.test('a room unicast to a session outside the room is refused before admission (Q5)', async () => {
    const snapshot = createGroupSnapshot(2, ['session-1', 'session-2']);
    const runtime = createLiveRoomRuntime(Date.now());
    try {
        await putRoomSnapshot(runtime.repository, snapshot);
        runtime.cache.observe(snapshot);
        runtime.router.install();

        const refused = await runtime.service.acceptIncomingMessage(
            roomUnicast(snapshot.group, 'unicast-2', 'outsider'),
            'session-1'
        );
        await waitForRoomSends(() => false);

        assert.equal(refused.left?.code, 'unauthorized');
        assert.deepEqual(roomSends(runtime.sent), []);
        assert.deepEqual(readOriginReceipts(runtime.sent), []);
    }
    finally {
        runtime.service.dispose();
        await runtime.manager.clear();
    }
});

function roomUnicast(groupRef: GroupRef, resourceId: string, toPeerId: string): ALMessage {
    return newALUnicastMessage(
        'session-1',
        newALEventRoute('room.chat', groupRef.groupId, resourceId),
        toPeerId,
        'chat.message.v1',
        {
            text: 'for you'
        },
        { groupRef, ttlMs: 30_000, reliability: 'at-least-once', ack: 'receiver' }
    );
}

function roomSends(sent: readonly RoomLiveSend[]): readonly RoomLiveSend[] {
    return sent.filter((send) =>
        decodePersistedALMessage(send.encoded).route.topicId === 'room.chat'
    );
}
```

Run: `cd apps/api-v1 && deno test --allow-env --allow-read test/services/ws-room-unicast-receipt.test.ts test/services/ws-room-live-fanout.test.ts`
Expected: PASS (both).

- [ ] **Step 12: The recipe.** Create `packages/shared-test/black-box-runner/tests/api-v1/api-v1-websocket-addressed-sends.json`:

```json
{
  "variables": {
    "apiPrimary": { "env": "RALLAR_API_BASE_URL", "default": "http://127.0.0.1:18080" },
    "rallarWsBaseUrl": { "env": "RALLAR_WS_BASE_URL", "default": "ws://127.0.0.1:18080" },
    "applicationId": "addressed-sends-{runId}",
    "workspaceId": "default-{runId}",
    "groupId": "addressed-sends-room-{runId}",
    "aliceUsername": { "env": "RALLAR_ALICE_USERNAME", "default": "alice" },
    "alicePassword": { "env": "RALLAR_ALICE_PASSWORD", "default": "secret", "secret": true },
    "bobUsername": { "env": "RALLAR_BOB_USERNAME", "default": "bob" },
    "bobPassword": { "env": "RALLAR_BOB_PASSWORD", "default": "secret", "secret": true },
    "runId": { "env": "RALLAR_BB_RUN_ID", "default": "local" }
  },
  "execution": { "correlation": { "injectHeaders": true, "injectPayloads": false } },
  "connections": {
    "primary": {
      "type": "http",
      "baseUrl": "{apiPrimary}",
      "headers": { "Content-Type": "application/json" },
      "timeoutMs": 10000
    },
    "wsAlice": { "type": "ws", "timeoutMs": 10000 },
    "wsBob": { "type": "ws", "timeoutMs": 10000 }
  },
  "steps": [
    {
      "name": "loginAlice",
      "type": "http",
      "connection": "primary",
      "request": {
        "method": "POST",
        "path": "/api/auth/login/requests/bb-addressed-login-alice-{runId}",
        "body": { "username": "{aliceUsername}", "password": "{alicePassword}" },
        "outputs": {
          "aliceClientId": "body.clientId",
          "aliceSessionId": "body.sessionId",
          "aliceAccessToken": { "path": "body.accessToken", "secret": true }
        }
      },
      "expect": { "status": 200 }
    },
    {
      "name": "deriveAliceAuthHeader",
      "type": "set",
      "output": "aliceAuthHeader",
      "secret": true,
      "redactAs": "aliceAuthHeader",
      "transform": { "concat": ["Bearer ", { "path": "outputs.aliceAccessToken" }] }
    },
    {
      "name": "loginBob",
      "type": "http",
      "connection": "primary",
      "request": {
        "method": "POST",
        "path": "/api/auth/login/requests/bb-addressed-login-bob-{runId}",
        "body": { "username": "{bobUsername}", "password": "{bobPassword}" },
        "outputs": {
          "bobClientId": "body.clientId",
          "bobSessionId": "body.sessionId",
          "bobAccessToken": { "path": "body.accessToken", "secret": true }
        }
      },
      "expect": { "status": 200 }
    },
    {
      "name": "deriveBobAuthHeader",
      "type": "set",
      "output": "bobAuthHeader",
      "secret": true,
      "redactAs": "bobAuthHeader",
      "transform": { "concat": ["Bearer ", { "path": "outputs.bobAccessToken" }] }
    },
    {
      "name": "aliceCreatesTheRoom",
      "type": "http",
      "connection": "primary",
      "request": {
        "method": "POST",
        "path": "/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/requests/bb-addressed-create-room-{runId}",
        "headers": { "Authorization": "{aliceAuthHeader}", "x-client-id": "{aliceClientId}" },
        "body": {
          "groupId": "{groupId}",
          "displayName": "Addressed sends {runId}",
          "kind": "room",
          "joinMode": "open",
          "createdByPrincipalId": "{aliceClientId}"
        }
      },
      "expect": { "status": 201, "body": { "group": { "groupId": "{groupId}" } } }
    },
    {
      "name": "bobJoinsTheRoom",
      "type": "http",
      "connection": "primary",
      "request": {
        "method": "POST",
        "path": "/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/join/requests/bb-addressed-join-bob-{runId}",
        "headers": { "Authorization": "{bobAuthHeader}", "x-client-id": "{bobClientId}" },
        "body": {}
      },
      "expect": {
        "status": 200,
        "body": { "members": [{ "principalId": "{bobClientId}", "status": "active" }] }
      }
    },
    {
      "name": "connectAlicePresence",
      "type": "http",
      "connection": "primary",
      "request": {
        "method": "PUT",
        "path": "/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/sessions/{aliceSessionId}/requests/bb-addressed-presence-alice-{runId}",
        "headers": { "Authorization": "{aliceAuthHeader}", "x-client-id": "{aliceClientId}" },
        "body": { "generationId": "generation-{runId}", "principalId": "{aliceClientId}" }
      },
      "expect": { "status": 200 }
    },
    {
      "name": "connectBobPresence",
      "type": "http",
      "connection": "primary",
      "request": {
        "method": "PUT",
        "path": "/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/sessions/{bobSessionId}/requests/bb-addressed-presence-bob-{runId}",
        "headers": { "Authorization": "{bobAuthHeader}", "x-client-id": "{bobClientId}" },
        "body": { "generationId": "generation-{runId}", "principalId": "{bobClientId}" }
      },
      "expect": { "status": 200 }
    },
    {
      "name": "createAliceWsTicket",
      "type": "http",
      "connection": "primary",
      "request": {
        "method": "POST",
        "path": "/api/auth/ws-ticket/requests/bb-addressed-ticket-alice-{runId}",
        "headers": { "Authorization": "{aliceAuthHeader}", "x-client-id": "{aliceClientId}" },
        "outputs": { "aliceWsTicket": { "path": "body.ticket", "secret": true } }
      },
      "expect": { "status": 200 }
    },
    {
      "name": "deriveAliceWsUrl",
      "type": "set",
      "output": "aliceWsUrl",
      "secret": true,
      "redactAs": "aliceWsUrl",
      "transform": {
        "concat": [
          { "path": "variables.rallarWsBaseUrl" },
          "/api/ws/",
          { "path": "outputs.aliceSessionId" },
          "?ticket=",
          { "urlEncode": { "path": "outputs.aliceWsTicket" } }
        ]
      }
    },
    {
      "name": "openAliceWs",
      "type": "ws.open",
      "connection": "wsAlice",
      "request": { "url": "{aliceWsUrl}", "timeoutMs": 10000 }
    },
    {
      "name": "createBobWsTicket",
      "type": "http",
      "connection": "primary",
      "request": {
        "method": "POST",
        "path": "/api/auth/ws-ticket/requests/bb-addressed-ticket-bob-{runId}",
        "headers": { "Authorization": "{bobAuthHeader}", "x-client-id": "{bobClientId}" },
        "outputs": { "bobWsTicket": { "path": "body.ticket", "secret": true } }
      },
      "expect": { "status": 200 }
    },
    {
      "name": "deriveBobWsUrl",
      "type": "set",
      "output": "bobWsUrl",
      "secret": true,
      "redactAs": "bobWsUrl",
      "transform": {
        "concat": [
          { "path": "variables.rallarWsBaseUrl" },
          "/api/ws/",
          { "path": "outputs.bobSessionId" },
          "?ticket=",
          { "urlEncode": { "path": "outputs.bobWsTicket" } }
        ]
      }
    },
    {
      "name": "openBobWs",
      "type": "ws.open",
      "connection": "wsBob",
      "request": { "url": "{bobWsUrl}", "timeoutMs": 10000 }
    },
    {
      "name": "receiverUnicastToBobIsAdmittedForBobAlone",
      "type": "ws.send",
      "connection": "wsAlice",
      "request": {
        "send": {
          "id": {
            "v": 2,
            "msgId": "addressed-to-bob-{runId}",
            "ts": 0,
            "senderId": "{aliceSessionId}",
            "sessionId": "{aliceSessionId}",
            "traceId": "addressed-to-bob-trace-{runId}"
          },
          "route": {
            "topicId": "room.chat",
            "resourceId": "addressed-to-bob-{runId}",
            "contextId": "{groupId}"
          },
          "targets": {
            "mode": "unicast",
            "toPeerId": "{bobSessionId}",
            "groupRef": {
              "applicationId": "{applicationId}",
              "workspaceId": "{workspaceId}",
              "groupId": "{groupId}"
            }
          },
          "delivery": { "reliability": "at-least-once", "ack": "receiver" },
          "payload": {
            "typeId": "chat.message.v1",
            "contentType": "application/json",
            "resource": "{\"text\":\"for bob\",\"runId\":\"{runId}\"}"
          }
        },
        "outputs": { "admittedReceiptResource": "matchedMessage.data.payload.resource" }
      },
      "expect": {
        "connection": "wsAlice",
        "withinMs": 10000,
        "message": {
          "route": { "topicId": "al-control" },
          "targets": { "mode": "unicast", "toPeerId": "{aliceSessionId}" },
          "payload": { "typeId": "al.control.receipt.v1" }
        },
        "consume": true
      }
    },
    {
      "name": "parseAdmittedReceipt",
      "type": "set",
      "output": "admittedReceipt",
      "transform": { "jsonParse": { "path": "outputs.admittedReceiptResource" } }
    },
    {
      "name": "assertAdmittedReceiptNamesBobAlone",
      "type": "assert",
      "actual": {
        "msgId": "{admittedReceipt.msgId}",
        "phase": "{admittedReceipt.phase}",
        "firstExpected": "{admittedReceipt.expectedRecipientPeerIds.0}",
        "secondExpected": "{admittedReceipt.expectedRecipientPeerIds.1}"
      },
      "expect": {
        "missingActualValue": "MISSING",
        "body": {
          "msgId": "addressed-to-bob-{runId}",
          "phase": "admitted",
          "firstExpected": "{bobSessionId}",
          "secondExpected": "MISSING"
        }
      }
    },
    {
      "name": "bobReceivesTheUnicast",
      "type": "ws.wait",
      "connection": "wsBob",
      "expect": {
        "connection": "wsBob",
        "withinMs": 10000,
        "message": {
          "id": { "msgId": "addressed-to-bob-{runId}" },
          "route": { "topicId": "room.chat" }
        }
      }
    },
    {
      "name": "unicastToANonMemberIsRefused",
      "type": "ws.send",
      "connection": "wsAlice",
      "request": {
        "send": {
          "id": {
            "v": 2,
            "msgId": "addressed-to-outsider-{runId}",
            "ts": 0,
            "senderId": "{aliceSessionId}",
            "sessionId": "{aliceSessionId}",
            "traceId": "addressed-to-outsider-trace-{runId}"
          },
          "route": {
            "topicId": "room.chat",
            "resourceId": "addressed-to-outsider-{runId}",
            "contextId": "{groupId}"
          },
          "targets": {
            "mode": "unicast",
            "toPeerId": "not-a-member-{runId}",
            "groupRef": {
              "applicationId": "{applicationId}",
              "workspaceId": "{workspaceId}",
              "groupId": "{groupId}"
            }
          },
          "delivery": { "reliability": "at-least-once", "ack": "receiver" },
          "payload": {
            "typeId": "chat.message.v1",
            "contentType": "application/json",
            "resource": "{\"text\":\"for nobody\",\"runId\":\"{runId}\"}"
          }
        },
        "outputs": { "outsiderNackResource": "matchedMessage.data.payload.resource" }
      },
      "expect": {
        "connection": "wsAlice",
        "withinMs": 10000,
        "message": {
          "route": { "topicId": "al-control" },
          "targets": { "mode": "unicast", "toPeerId": "{aliceSessionId}" },
          "payload": { "typeId": "al.control.nack.v1" }
        },
        "consume": true
      }
    },
    {
      "name": "parseOutsiderNack",
      "type": "set",
      "output": "outsiderNack",
      "transform": { "jsonParse": { "path": "outputs.outsiderNackResource" } }
    },
    {
      "name": "assertOutsiderNackShape",
      "type": "assert",
      "actual": { "msgId": "{outsiderNack.msgId}", "reason": "{outsiderNack.reason}" },
      "expect": {
        "missingActualValue": "MISSING",
        "body": { "msgId": "addressed-to-outsider-{runId}", "reason": "unauthorized" }
      }
    },
    {
      "name": "closeBobWs",
      "type": "ws.close",
      "connection": "wsBob",
      "request": { "code": 1000, "reason": "addressed sends recipe done" }
    },
    {
      "name": "closeAliceWs",
      "type": "ws.close",
      "connection": "wsAlice",
      "request": { "code": 1000, "reason": "addressed sends recipe done" }
    }
  ]
}
```

In `packages/shared-test/black-box-runner/recipe-matrix.json` insert, immediately before the
`"id": "api-v1-websocket-topic-routing"` entry:

```json
{
  "id": "api-v1-websocket-addressed-sends",
  "recipe": "tests/api-v1/api-v1-websocket-addressed-sends.json",
  "category": "api-v1-black-box",
  "mode": "run",
  "tier": 1,
  "profiles": [
    "api-v1-black-box",
    "api-v1-black-box-recipes"
  ],
  "expectedExitCode": 0,
  "artifactName": "api-v1-websocket-addressed-sends",
  "requires": {
    "httpServices": [
      {
        "name": "Rallar API",
        "env": "RALLAR_API_BASE_URL",
        "default": "http://127.0.0.1:18080"
      }
    ]
  },
  "description": "No-browser API-v1 WebSocket addressed sends: a room unicast's one-member receipt and the out-of-audience refusal."
},
```

In `packages/tests/shared-test/recipe-matrix.test.ts` insert `'api-v1-websocket-addressed-sends',` immediately
before `'api-v1-websocket-topic-routing'` in both pinned lists (`:381` and `:464`).

Run: the strict preflight on the new recipe (Global Constraints), expected zero findings;
`npx vitest run packages/tests/shared-test/recipe-matrix.test.ts`, expected PASS; unsandboxed
`npm run test:api-v1:black-box:memory`, expected the summary line to count `api-v1-websocket-addressed-sends`
passed. Each Alice step matches its control by `payload.typeId`, so the later `timed-out` receipt of Bob's unicast
(the raw recipe client never ACKs) matches neither the NACK step nor the Task 2 ACK step.

- [ ] **Step 13: Validate.** The per-task set (Global Constraints) including the Deno checks of both apps, the
      public API and bundle tests (record both bundle figures; raise a crossed ceiling by the next-whole-KiB rule in
      `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts:39-57`,
      `packages/shared-web/scripts/measure-browser-bundles.mjs:36-47` and
      `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts:70-80`, appending "S3c-i's room-naming
      unicast and the unicast receipt measure <the measured figure> KiB" to each comment), the smoke lane, and the medium-scale gate is
      **not** run here (Task 6, Q13).

- [ ] **Step 14: Commit and push.**

```bash
git add packages/shared/al-contracts packages/shared/alm/open-indexed-db-admission-database.ts packages/shared/alm/delivery/al-delivery-lifecycle.ts packages/shared/alm/outbound/compute-al-outbound-control-admission.ts packages/shared/alm/inbound/README.md packages/shared/services/ws-queue-box-server packages/shared/services/ws-queue-box-client packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts packages/tests/shared/al-contracts packages/tests/shared/services packages/tests/shared/ws-server-qos-policy.test.ts packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts packages/shared-test/black-box-runner/tests/api-v1/api-v1-websocket-addressed-sends.json packages/shared-test/black-box-runner/recipe-matrix.json packages/tests/shared-test/recipe-matrix.test.ts apps/api-v1/test/services
git commit -m "feat(alm): S3c-i -- a room unicast is router-delivered with a one-member receipt (D53, Q4, Q5)"
git push
```

Add every bundle file the step raised and every moved-pin file to the `git add`; the commit body names the schema
bump (`rallar-alm-2026-09-s3c-i`, C1) and the bundle figures.

### Task 2: The server address and the WS hop receipt (D57 as applied, Q2, Q3, R-S3a-4)

**Files:**

- Create: `packages/shared-web/browser/connection/decode-api-config-response.ts`.
- Modify: as "Task 2" in the file structure, plus `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts:74-99,152-175`
  (the `serverPeerId` field Relic's config route and Task 4 read, and no default fanout for a unicast addressed to
  the server, R-S3c-i-5) and `packages/tests/shared-web/api-middleware-test-double.ts:91`.
- Test: create `packages/tests/shared-web/connection/decode-api-config-response.test.ts`,
  `packages/tests/shared-web/session/session-connection-operations-server-peer.test.ts`; modify
  `packages/tests/shared/services/ws-queue-box-client-receipt-tracking.test.ts` (one describe),
  `packages/tests/shared/services/ws-queue-box-server-addressed-receipts.test.ts` (one case),
  `packages/tests/shared-web/messages/browser-message-tracked-receipt.test.ts:41-58,128-151` (moved pins),
  `packages/tests/shared-web/api/browser-http-feature-ownership.test.ts:273-278`,
  `packages/tests/shared-server/rallar-system/rallar-server-ws-router.test.ts` (one case),
  `apps/api-v1/test/composition/create-api-v1-route-installers.test.ts:30,164-168`,
  `apps/api-v1/test/routes/config-route-test-runtime.ts:44-48`, and every WS client construction in tests (Step 8).

**Interfaces:**

- Consumes `isALUnicastAddressedTo` (Task 1).
- Produces `interface ApiConfigResponse extends ApiConfig { readonly serverPeerId?: string }` in `@shared/api/api-config.ts`
  (absent: a server that predates S3c-i, "server unknown", R-S3c-i-6).
- Produces `decodeApiConfigResponse(value: unknown): Either<string, ApiConfigResponse>`;
  `readApiConfig(options?): Promise<ApiConfigResponse>` (throws the decoder's reason, as it throws HTTP failures).
- Produces `WsQueueBoxClientService.Input.serverPeerId: string | undefined` and
  `.Dependencies.serverPeerId: string | undefined` (both required keys; undefined = server unknown),
  `WsQueueBoxClientService.serverPeerId: string | undefined` (public readonly),
  `CreateBrowserWebSocketQueueBox.Input.serverPeerId: string | undefined`.
- Produces `toWsQueueBoxClientAckTrackingPlan(effective: ALQosEffectivePolicy, msg: ALMessage, serverPeerId: string | undefined): ALOutboundAckTrackingPlan | undefined`.
- Produces `RallarConnectionOperations.serverPeerId(): string | undefined` (Task 5's Relic client reads it).
- Produces `RallarServerWsRouter.serverPeerId: string` (public readonly; Task 4's publish and Task 5's Relic server read
  it); `route()` publishes no default fanout for a unicast addressed to it.
- Produces `ConfigRouteDependencies.publicConfiguration: ApiConfigResponse` and the same type on
  `CreateApiV1RouteInstallersInput.publicConfiguration`.

- [ ] **Step 1: RED — the boundary decoder.** Create `packages/tests/shared-web/connection/decode-api-config-response.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { decodeApiConfigResponse } from '@shared-web/browser/connection/decode-api-config-response.ts';

const SERVED = {
    apiBaseUrl: 'https://api.example.test',
    wsBaseUrl: 'wss://api.example.test',
    endpoints: { createWs: '/api/ws/:id' },
    serverPeerId: 'default-qbox-server'
};

describe('the /api/config boundary decoder (D57 as applied, C5, R-S3c-i-6)', () => {
    it('reads the configuration and the WS server peer id', () => {
        expect(decodeApiConfigResponse({ ...SERVED, build: 'b-1' }).right).toEqual(SERVED);
    });

    it('reads a server that names no peer id as one that predates S3c-i: the server stays unknown', () => {
        const { serverPeerId: _serverPeerId, ...unknownServer } = SERVED;

        expect(decodeApiConfigResponse(unknownServer).right).toEqual(unknownServer);
    });

    it.each([
        [
            'an empty peer id',
            { ...SERVED, serverPeerId: '' },
            'The /api/config response names an empty or non-string WS server peer id.'
        ],
        [
            'a non-string peer id',
            { ...SERVED, serverPeerId: 7 },
            'The /api/config response names an empty or non-string WS server peer id.'
        ],
        [
            'no WS endpoint',
            { ...SERVED, endpoints: {} },
            'The /api/config response names no API base URL, WS base URL or WS endpoint.'
        ],
        [
            'no endpoints object',
            { ...SERVED, endpoints: 'x' },
            'The /api/config response is not an object with endpoints.'
        ],
        ['a non-object body', 'config', 'The /api/config response is not an object with endpoints.']
    ])('refuses %s', (_name, value, reason) => {
        expect(decodeApiConfigResponse(value).left).toBe(reason);
    });
});
```

Run: `npx vitest run packages/tests/shared-web/connection/decode-api-config-response.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 2: GREEN — the served shape and its decoder.** In `packages/shared/api/api-config.ts` add after `ApiConfig`:

```ts
/** What `/api/config` serves: the configuration and the peer id a client addresses the WS server by (D57 as applied). */
export interface ApiConfigResponse extends ApiConfig {
    /**
     * Absent from a server that predates S3c-i: the server is unknown, so a client neither addresses it nor tracks
     * it as its hop, and an app that would address it falls back (Relic: REST). Every S3c-i server serves it.
     */
    readonly serverPeerId?: string;
}
```

Create `packages/shared-web/browser/connection/decode-api-config-response.ts`:

```ts
import type { ApiConfigResponse } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';

/**
 * The `/api/config` body the browser connects with. A body without `serverPeerId` comes from a server that predates
 * S3c-i and reads as "server unknown" — a distinct meaning, not a default — so a rolling deploy never strands a new
 * browser; an empty or non-string id is refused (S3c-i C5, R-S3c-i-6).
 */
export function decodeApiConfigResponse(value: unknown): Either<string, ApiConfigResponse> {
    if (!isRecord(value) || !isRecord(value.endpoints)) {
        return Either.ofLeft('The /api/config response is not an object with endpoints.');
    }
    const { apiBaseUrl, wsBaseUrl, serverPeerId } = value;
    const createWs = value.endpoints.createWs;
    if (
        typeof apiBaseUrl !== 'string' || typeof wsBaseUrl !== 'string' ||
        typeof createWs !== 'string'
    ) {
        return Either.ofLeft(
            'The /api/config response names no API base URL, WS base URL or WS endpoint.'
        );
    }
    if (serverPeerId === undefined) {
        return Either.ofRight({ apiBaseUrl, wsBaseUrl, endpoints: { createWs } });
    }
    if (typeof serverPeerId !== 'string' || serverPeerId.length === 0) {
        return Either.ofLeft(
            'The /api/config response names an empty or non-string WS server peer id.'
        );
    }
    return Either.ofRight({ apiBaseUrl, wsBaseUrl, endpoints: { createWs }, serverPeerId });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

In `packages/shared-web/browser/connection/connection-http-api.ts` replace `readApiConfig` (`:6-14`) and its type
import with:

```ts
import type { ApiConfigResponse, IceConfig } from '@shared/api/api-config.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { executeHttpRequest, type ApiRequestOptions } from '../api/http-request.ts';
import { decodeApiConfigResponse } from './decode-api-config-response.ts';

export async function readApiConfig(options?: ApiRequestOptions): Promise<ApiConfigResponse> {
    const decoded = decodeApiConfigResponse(
        await executeHttpRequest<void, unknown>(
            readApiBaseUrl(),
            '/api/config',
            'GET',
            undefined,
            options
        )
    );
    if (decoded.left !== undefined) {
        throw new Error(decoded.left);
    }
    return decoded.right!;
}
```

In `packages/tests/shared-web/api/browser-http-feature-ownership.test.ts:273-278` add `serverPeerId: 'server'` to
the mocked `/api/config` body. Then find every other test that answers `/api/config` with a body and add the same
field to each, so a mocked page runs the S3c-i path rather than "server unknown" (a mock without it still connects,
R-S3c-i-6). Grep the path without quotes — several mocks route the absolute URL
(`'http://localhost:8080/api/config'`) or compare `url.pathname`:

```bash
grep -rn "api/config" packages/tests tests/playwright apps/ar-eye-hunter-v1 apps/relic-hunters-v1/tests | grep -v node_modules
```

— among them `tests/playwright/relic-hunters/web.spec.ts:1083-1090`, where the field is
`serverPeerId: 'default-qbox-server'` (Task 5 names it `MOCK_SERVER_PEER_ID`),
`tests/playwright/rallar-black-box/tabbed-navigation.spec.ts:360,510,603,1182,1225,1255`,
`tests/playwright/rallar-black-box/agent-session-ticket-ui.spec.ts:38` and
`tests/playwright/rallar-black-box/recipe-console-history.spec.ts:595`. Hits that only name the path (a request log,
a `configPath` option, an expected route list) take no edit. A Playwright spec is type-checked by nothing, so read each
hit rather than relying on `npm run typecheck`.

Run the Step 1 file and `npx vitest run packages/tests/shared-web/api/browser-http-feature-ownership.test.ts`.
Expected: PASS.

- [ ] **Step 3: RED — the client's server receipts.** In `packages/tests/shared/services/ws-queue-box-client-receipt-tracking.test.ts`
      give `createReceiptTrackingFixture` the parameter
      `input: Readonly<{ serverPeerId: string | undefined; }> = { serverPeerId: 'server' }` and add
      `serverPeerId: input.serverPeerId,` after `sessionId: 'self',` in its service input (an object, not a defaulted
      positional, so a case can pass `undefined`), add `newALAckControlMessage` to the `al-control.ts` import, and add
      after the Task 1 describe:

```ts
describe('WS client receipts the server answers itself (R-S3a-4, D57 as applied)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('tracks a hop room send against its server, the one hop a WS origin has', async () => {
        const fixture = await createReceiptTrackingFixture();
        const hop: ALMessage = {
            ...roomMessage(),
            delivery: { reliability: 'at-least-once', ack: 'none' },
            qos: { ack: { algo: 'hop' } }
        };
        await fixture.service.enqueueOutboxIfAbsent(hop);
        expect(await readReceipt(fixture)).toMatchObject({
            mode: 'hop',
            expectedPeerIds: ['server'],
            ackedPeerIds: []
        });

        await fixture.service.acceptIncomingMessage(serverAck('room-message-1'));

        expect(
            fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)
        ).toMatchObject({
            msgId: 'room-message-1',
            mode: 'hop',
            confirmedHopPeerIds: ['server'],
            unconfirmedHopPeerIds: [],
            complete: true
        });
    });

    it('expects the server itself for a receiver command addressed to it and completes on the server\'s own ACK', async () => {
        const fixture = await createReceiptTrackingFixture();
        const command: ALMessage = {
            ...roomMessage(),
            id: { ...roomMessage().id, msgId: 'server-command-1' },
            targets: { mode: 'unicast', toPeerId: 'server', groupRef: ROOM }
        };
        await fixture.service.enqueueOutboxIfAbsent(command);
        expect(
            await fixture.outboundStores.admissionStore.readReceiptState({
                originPeerId: 'self',
                msgId: 'server-command-1'
            })
        )
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['server'], ackedPeerIds: [] });

        await fixture.service.acceptIncomingMessage(serverAck('server-command-1'));

        expect(
            fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)
        ).toMatchObject({
            msgId: 'server-command-1',
            mode: 'receiver',
            confirmedRecipientPeerIds: ['server'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
    });

    it('tracks no server hop while the server named no peer id: one that predates S3c-i (R-S3c-i-6)', async () => {
        const fixture = await createReceiptTrackingFixture({ serverPeerId: undefined });

        await fixture.service.enqueueOutboxIfAbsent({
            ...roomMessage(),
            delivery: { reliability: 'at-least-once', ack: 'none' },
            qos: { ack: { algo: 'hop' } }
        });

        expect(await readReceipt(fixture)).toBeUndefined();
    });
});

/** The server's own ACK: it speaks for itself as the recipient and is addressed to the origin. */
function serverAck(ackedMsgId: string): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `server-ack-${ackedMsgId}`, senderId: 'server', ts: Date.now() },
        {
            ackedMsgId,
            fromPeerId: 'server',
            toPeerId: 'self',
            originPeerId: 'self',
            logicalRecipientPeerId: 'server',
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}
```

In `packages/tests/shared/services/ws-queue-box-server-addressed-receipts.test.ts` add inside the describe:

```ts
it('acknowledges a subtree room send itself: the router owns the fanout, so no subtree is waited for (R-S3a-4)', async () => {
    const fixture = await createAddressedFixture();
    const roomSend: ALMessage = {
        ...roomUnicast('subtree-room', 'b', 'none'),
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        delivery: { reliability: 'at-least-once', ack: 'group-leader' }
    };

    await fixture.service.acceptIncomingMessage(roomSend, 'a');

    await expect.poll(async () => {
        await fixture.engine.executeOnce();
        return readAcks(fixture.sockets.a).map((ack) => [ack.ackedMsgId, ack.fromPeerId]);
    }).toEqual([['subtree-room', SERVER_ID]]);
});
```

Run: `npx vitest run packages/tests/shared/services/ws-queue-box-client-receipt-tracking.test.ts packages/tests/shared/services/ws-queue-box-server-addressed-receipts.test.ts`
Expected: the first two client cases FAIL (a hop room send tracks no receipt; the command expects nobody), the
server-unknown case PASSES (it pins that Step 4 keeps the old plan without an id); the server case PASSES already —
it pins what the client now relies on (the router composition cannot forward a room message, so
`computeIncomingAcknowledgements` answers `subtree` at once, `compute-al-inbound-admission.ts:245-259`).

- [ ] **Step 4: GREEN — the client learns and tracks the server.** In
      `packages/shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts` add
      `import { isALUnicastAddressedTo } from '../../al-contracts/is-al-unicast-addressed-to.ts';` and replace the doc
      comment, the signature and `toReceiptAudience` with:

```ts
/**
 * The receipt a WS send tracks. The server is the one hop a WS origin has (R-S3a-4): a unicast addressed to the server
 * and every `hop` or `subtree` send expect the server's own ACK. A `receiver` send to a session or a room expects
 * nobody yet: the server's `admitted` receipt names the frozen audience the row is created from (D53). With no server
 * id known (a server that predates S3c-i), a send tracks what it did before: a unicast its addressee, a room send
 * nothing unless it asks `receiver`.
 */
export function toWsQueueBoxClientAckTrackingPlan(
    effective: ALQosEffectivePolicy,
    msg: ALMessage,
    serverPeerId: string | undefined
): ALOutboundAckTrackingPlan | undefined {
    const receiptAudience = toReceiptAudience(effective, msg, serverPeerId);
```

```ts
function toReceiptAudience(
    effective: ALQosEffectivePolicy,
    msg: ALMessage,
    serverPeerId: string | undefined
): readonly string[] | undefined {
    const targets = msg.targets;
    if (targets === undefined) {
        return undefined;
    }
    if (serverPeerId === undefined) {
        return toServerUnknownReceiptAudience(effective, targets);
    }
    return isALUnicastAddressedTo(msg, serverPeerId) || effective.ack.algo !== 'receiver'
        ? [serverPeerId]
        : [];
}

function toServerUnknownReceiptAudience(
    effective: ALQosEffectivePolicy,
    targets: NonNullable<ALMessage['targets']>
): readonly string[] | undefined {
    if (targets.mode === 'unicast') {
        return effective.ack.algo === 'receiver' ? [] : [targets.toPeerId];
    }
    return effective.ack.algo === 'receiver' ? [] : undefined;
}
```

In `packages/shared/services/ws-queue-box-client-service.ts` (warn tier: these lines only):

- in `WsQueueBoxClientService.Input`, after `readonly sessionId: string;`:

```ts
/**
 * The peer id the WS server answers as, learned from `/api/config` (D57 as applied, Q3); undefined when the server
 * names none (it predates S3c-i, R-S3c-i-6), so the client tracks no server hop.
 */
readonly serverPeerId: string | undefined;
```

- in `WsQueueBoxClientService.Dependencies`, after `readonly sessionId: string;`:
  `readonly serverPeerId: string | undefined;`
- in the class, after `public readonly sessionId: string;`: `public readonly serverPeerId: string | undefined;`, and in the
  constructor after `this.sessionId = dependencies.sessionId;`: `this.serverPeerId = dependencies.serverPeerId;`
- in `planOutgoingMessage`: `ackTracking: toWsQueueBoxClientAckTrackingPlan(normalized.effective, msg, this.serverPeerId),`
- in `createDefaultWsQueueBoxClientService`, after `sessionId: input.sessionId,`: `serverPeerId: input.serverPeerId,`

In `packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts` add to
`CreateBrowserWebSocketQueueBox.Input` after `readonly clientData: ClientInfo;`:

```ts
/** The WS server's peer id from `/api/config`; undefined when the server names none (R-S3c-i-6). */
readonly serverPeerId: string | undefined;
```

and in `createBrowserWebSocketQueueBoxService` after `sessionId: clientData.sessionId,`:
`serverPeerId: input.serverPeerId,`.

In `packages/shared-web/browser/connection/initialise-browser-middleware.ts` (`initialiseBrowserWebSocketTransport`,
`:265-284`) add `serverPeerId: apiConfig.serverPeerId,` after `clientData: input.clientData,` in the
`createBrowserWebSocketQueueBox` input.

- [ ] **Step 5: The facade reads the learned id; the router names its own.** In
      `packages/shared-web/browser/rallar-connection-facade.ts` add to `RallarConnectionOperations` after
      `session(): AuthSession | undefined;`:

```ts
/**
 * The peer id the WS server answers as, learned from `/api/config`; undefined until connected, and when the server
 * names none (D57 as applied, R-S3c-i-6).
 */
serverPeerId(): string | undefined;
```

In `packages/shared-web/browser/session/session-connection-operations.ts` add after `session: readSession,`:

```ts
serverPeerId: () => input.connectionRuntime.readMiddleware()?.middleware.webSocketQueueBox.serverPeerId,
```

In `packages/tests/shared-web/api-middleware-test-double.ts:91` add `serverPeerId: 'server',` as the first member
of the `toServiceTestDouble` object in `createWebSocketQueueBoxDouble`.

Create `packages/tests/shared-web/session/session-connection-operations-server-peer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { RallarConnectionRuntimePort } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import type { BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarSessionAuthLifecycle } from '@shared-web/browser/session/session-auth-lifecycle.ts';
import { createRallarSessionConnectionOperations } from '@shared-web/browser/session/session-connection-operations.ts';

import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

describe('the WS server peer id on the connection operations (D57 as applied)', () => {
    it('reads the id the connected WS client learned, and nothing before a connection', () => {
        let middleware: ApiMiddleware | undefined;
        const operations = createRallarSessionConnectionOperations({
            connectionRuntime: {
                readMiddleware: () => middleware
            } as unknown as RallarConnectionRuntimePort,
            transportRuntime: {} as BrowserTransportRuntimePort,
            authLifecycle: {} as RallarSessionAuthLifecycle
        });

        expect(operations.serverPeerId()).toBeUndefined();
        middleware = createDefaultApiMiddlewareTestDouble({
            middleware: { webSocketQueueBox: { serverPeerId: 'server-7' } }
        });
        expect(operations.serverPeerId()).toBe('server-7');
    });
});
```

In `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts` add the public field after
`private readonly nowEpochMs: () => number;`:

```ts
/** The peer id the WS server answers as: the id clients address it by and its own publishes carry (D57, D58). */
readonly serverPeerId: string;
```

and in the constructor, after `this.service = service;`: `this.serverPeerId = service.name;`.

A unicast addressed to the server ends at the server's handlers (R-S3c-i-5): the topic's default fanout would find no
session for it — a `live-only` topic logs "had no recipients" on every such command, and an `outbox` topic enqueues a
`WS_OUTBOX` row addressed to the server itself. In `route()` (`:152-175`) add
`import { isALUnicastAddressedTo } from '@shared/al-contracts/is-al-unicast-addressed-to.ts';` and replace
`if (!suppressDefaultFanout) {` (`:170`) with:

```ts
// A unicast addressed to the server ends at its handlers: the server is its recipient (D57 as applied).
if (!suppressDefaultFanout && !isALUnicastAddressedTo(message, this.serverPeerId)) {
```

In `packages/tests/shared-server/rallar-system/rallar-server-ws-router.test.ts` add
`import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';` and, after "can route registered topics
through the QueueBox outbox":

```ts
it('publishes no default fanout for a unicast addressed to the server itself (R-S3c-i-5)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());
    const { router, socket, outboundStores } = createRouter();
    router.defineTopic({ topicId: 'app.durable', typeId: 'app.command.v1', fanout: 'outbox' });
    const handled: string[] = [];
    router.on({ topicId: 'app.command' }, async (message) => {
        handled.push(message.raw.id.msgId);
    });
    const liveOnly = newALUnicastMessage(
        'peer-1',
        newALRoute('app.command', 'all', 'command-1'),
        router.serverPeerId,
        'app.command.v1',
        { go: true }
    );
    const durable = newALUnicastMessage(
        'peer-1',
        newALRoute('app.durable', 'all', 'command-2'),
        router.serverPeerId,
        'app.command.v1',
        { go: true },
        { reliability: 'at-least-once', ack: 'none' }
    );

    await router.route(liveOnly);
    await router.route(durable);

    expect(handled).toEqual([liveOnly.id.msgId]);
    expect(socket.sent).toHaveLength(0);
    expect(warn).not.toHaveBeenCalledWith('Rallar server WS topic had no recipients: app.command');
    expect(await outboundStores.admissionStore.readSentMessage(durable.id.msgId)).toBeUndefined();
});
```

Run: `npx vitest run packages/tests/shared-web/session/session-connection-operations-server-peer.test.ts packages/tests/shared/services/ws-queue-box-client-receipt-tracking.test.ts packages/tests/shared-server/rallar-system/rallar-server-ws-router.test.ts`
Expected: PASS (the router case fails without the guard: the `live-only` unicast logs "had no recipients" and the
`outbox` one is admitted as a `WS_OUTBOX` row). `npm run typecheck` names every other object typed
`RallarConnectionOperations` or `RallarFacade` that a test builds by hand; add `serverPeerId: () => 'server'` to each.

- [ ] **Step 6: The api-v1 and Relic config routes, and OpenAPI.** In `apps/api-v1/src/routes/config-route.ts` change
      the import to `import type { ApiConfigResponse } from '@shared/api/api-config.ts';` and
      `readonly publicConfiguration: ApiConfig;` (`:45`) to `readonly publicConfiguration: ApiConfigResponse;`; the same
      type change on `CreateApiV1RouteInstallersInput.publicConfiguration` in
      `apps/api-v1/src/composition/create-api-v1-route-installers.ts:96` (and its import). In
      `apps/api-v1/src/composition/create-default-rallar-server.ts:281` replace
      `publicConfiguration: toApiV1PublicConfiguration(configuration.publicApi),` with:

```ts
publicConfiguration: {
    ...toApiV1PublicConfiguration(configuration.publicApi),
    serverPeerId: runtime.wsQBoxServerService.name
},
```

In `apps/relic-hunter-server-v1/src/main.ts:89` (Relic's own route is registered before api-v1's, Correction 23)
replace the route with:

```ts
app.get(
    '/api/config',
    (c) =>
        c.json(
            {
                ...configuration.browser,
                serverPeerId: rallar.ws.serverPeerId
            } satisfies ApiConfigResponse
        )
);
```

and add `import type { ApiConfigResponse } from '@shared/api/api-config.ts';` beside the other `@shared` imports.

In `apps/api-v1/resources/api-v1-openapi.yaml` replace the `ApiConfig` schema (`:3993-4004`) with:

```yaml
ApiConfig:
  type: object
  required: [apiBaseUrl, wsBaseUrl, endpoints, serverPeerId]
  properties:
    apiBaseUrl:
      type: string
      format: uri
    wsBaseUrl:
      type: string
      format: uri
    endpoints:
      $ref: '#/components/schemas/ApiEndpoints'
    serverPeerId:
      type: string
      minLength: 1
      description: >-
        The peer id the WebSocket server answers as. A client addresses the server with a unicast to it and
        tracks the server as its one hop by it. Every server since S3c-i serves it; a browser reads a body
        without it as a server that predates the field and falls back (no hop receipt, app commands over REST).
      example: default-qbox-server
  additionalProperties: true
```

In `apps/api-v1/test/routes/config-route-test-runtime.ts:44-48` and
`apps/api-v1/test/composition/create-api-v1-route-installers.test.ts:164-168` add `serverPeerId: 'default-qbox-server'`
to `publicConfiguration`, and in `create-api-v1-route-installers.test.ts` replace
`assert.equal((await app.request('/api/config')).status, 200);` (`:30`) with:

```ts
const config: unknown = await (await app.request('/api/config')).json();
assert.deepEqual(config, {
    apiBaseUrl: 'http://localhost:8080',
    wsBaseUrl: 'ws://localhost:8080',
    endpoints: { createWs: '/api/ws/:id' },
    serverPeerId: 'default-qbox-server'
});
```

Run: `cd apps/api-v1 && deno task check && deno test --allow-env --allow-read test/composition/create-api-v1-route-installers.test.ts test/routes`
and `cd apps/relic-hunter-server-v1 && deno task check`. Expected: PASS.

- [ ] **Step 7: The moved pins (R-S3a-4's downgrade evidence ends for WS `hop`/`subtree`).** In
      `packages/tests/shared-web/messages/browser-message-tracked-receipt.test.ts` add `serverPeerId: 'server',` after
      `sessionId,` in `createWsClient`, and replace the `it.each` at `:41-58` with:

```ts
it.each([
    {
        ackLabel: 'qos.ack hop',
        ack: 'none' as const,
        qos: { ack: { algo: 'hop' as const } },
        requested: 'hop' as const
    },
    {
        ackLabel: 'ack group-leader',
        ack: 'group-leader' as const,
        qos: undefined,
        requested: 'subtree' as const
    }
])(
    'keeps a room send asking $ackLabel open past transport acceptance, tracking the server as its hop (R-S3a-4)',
    async ({ ack, qos, requested }) => {
        const harness = await createWsDispatchHarness();
        const handle = harness.send(
            newALMulticastMessage(SESSION_ID, toRoute('room-hop'), ORIGIN_ROOM, 'chat.message.v1', {
                text: 'hop'
            }, { reliability: 'at-least-once', ack, ttlMs: TTL_MS, qos })
        );

        await expect.poll(() => handle.lifecycle().state).toBe('transport-accepted');

        expect(handle.lifecycle()).toMatchObject({ receiptAlgo: requested });
        expect(handle.lifecycle().evidence.receiptDowngrade).toBeUndefined();
        expect(isALDeliveryTerminal(handle.lifecycle())).toBe(false);
    }
);
```

and the fallback case at `:128-151` (its comment and body) with:

```ts
// The RTC leg's `unroutable` leaves the handle's receipt alone; the WS leg that takes over tracks the server as the
// room send's one hop, so the handle stays open for the server's ACK (R-S3a-4 closed by S3c-i).
it('keeps a room send asking qos.ack hop open on its WS leg after its RTC leg is unroutable', async () => {
    const registry = createRegistry();
    const ws = await createWsClient(registry, 'a');
    const fixture = createRtcOriginOverlayFixture({
        snapshot: createOriginSnapshot(['a', 'b'], 4),
        nextHopPeerIds: []
    });
    const harness = createDispatchHarness(registry, 'rtc', {
        rtc: (message) => fixture.manager.enqueueIfAbsent(message),
        ws: (message) => ws.enqueueOutboxIfAbsent(message)
    });
    const handle = harness.send(
        newALMulticastMessage('a', toRoute('fallback-hop'), ORIGIN_ROOM, 'chat.message.v1', {
            text: 'hop'
        }, {
            reliability: 'at-least-once',
            ack: 'none',
            ttlMs: TTL_MS,
            qos: { ack: { algo: 'hop' } }
        })
    );

    await expect.poll(() => handle.lifecycle().state).toBe('transport-accepted');

    expect(handle.lifecycle()).toMatchObject({ receiptAlgo: 'hop' });
    expect(handle.lifecycle().evidence.receiptDowngrade).toBeUndefined();
    expect(
        handle.lifecycle().evidence.attempts.map(({ carrier, outcome }) => ({ carrier, outcome }))
    ).toEqual([
        { carrier: 'rtc', outcome: 'unroutable' },
        { carrier: 'ws', outcome: 'sent' }
    ]);
    expect(isALDeliveryTerminal(handle.lifecycle())).toBe(false);
});
```

Run: `npx vitest run packages/tests/shared-web/messages/browser-message-tracked-receipt.test.ts`. Expected: PASS.
Name both moved pins in the commit body (old: `receiptAlgo: 'none'`, a downgrade, terminal at `transport-accepted`;
new: the requested algorithm, no downgrade, open).

- [ ] **Step 8: Every WS client construction in tests names its server.** Add `serverPeerId: 'server',` after the
      `sessionId` member of every `createDefaultWsQueueBoxClientService({ ... })` and `new WsQueueBoxClientService({ ... })`
      object in: `packages/tests/shared-web/connection/browser-middleware-rtt.test.ts`,
      `packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts`,
      `packages/tests/shared/browser-outbound-cancellation.test.ts`,
      `packages/tests/shared/multicast/rtc-outbound-transport-results.test.ts`,
      `packages/tests/shared/services/ws-outbound-send-deadline.test.ts`,
      `packages/tests/shared/services/ws-queue-box-client-ingress.test.ts` (2 sites),
      `packages/tests/shared/services/ws-queue-box-client-reconnect.test.ts`,
      `packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts`,
      `packages/tests/shared/services/ws-queue-box-client-send-live.test.ts` (2 sites),
      `packages/tests/shared/services/ws-queue-box-server-receipt-row.test.ts`,
      `packages/tests/shared/webrtc/ws-rtc-signaling-admission-recovery.test.ts`,
      `packages/tests/shared/webrtc/ws-rtc-signaling-transport.test.ts`,
      `packages/tests/shared/ws-qos-policy.test.ts` (13 sites). Prove completeness — every line prints two equal counts:

```bash
grep -rlE 'createDefaultWsQueueBoxClientService\(|new WsQueueBoxClientService\(' packages/tests apps --include='*.ts' \
  | grep -v node_modules | while read -r f; do
      echo "$f $(grep -cE 'createDefaultWsQueueBoxClientService\(|new WsQueueBoxClientService\(' "$f") $(grep -c 'serverPeerId' "$f")"
    done
```

(A file that imports the constructor without calling it prints `0 0`.) Then run
`npx vitest run packages/tests/shared/services packages/tests/shared/webrtc packages/tests/shared/multicast packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared/browser-outbound-cancellation.test.ts packages/tests/shared-web`.
Expected: PASS. Any other pin a WS `hop`/`subtree` send moved (it now tracks `[serverPeerId]` instead of nothing, or
instead of the unicast addressee) is renamed and re-asserted the way Step 7 shows, and named in the commit body.

- [ ] **Step 9: The recipe learns the server id and addresses the server.** In
      `api-v1-websocket-addressed-sends.json` insert as the **first** step:

```json
{
  "name": "readConfigNamesTheServerPeerId",
  "type": "http",
  "connection": "primary",
  "request": {
    "method": "GET",
    "path": "/api/config",
    "outputs": { "serverPeerId": "body.serverPeerId" }
  },
  "expect": { "status": 200, "body": { "serverPeerId": "string", "endpoints": { "createWs": "string" } } }
},
```

and after `assertOutsiderNackShape`:

```json
{
  "name": "commandAddressedToTheServerIsAcknowledgedByTheServer",
  "type": "ws.send",
  "connection": "wsAlice",
  "request": {
    "send": {
      "id": { "v": 2, "msgId": "addressed-to-server-{runId}", "ts": 0, "senderId": "{aliceSessionId}", "sessionId": "{aliceSessionId}", "traceId": "addressed-to-server-trace-{runId}" },
      "route": { "topicId": "room.chat", "resourceId": "addressed-to-server-{runId}", "contextId": "{groupId}" },
      "targets": {
        "mode": "unicast",
        "toPeerId": "{serverPeerId}",
        "groupRef": { "applicationId": "{applicationId}", "workspaceId": "{workspaceId}", "groupId": "{groupId}" }
      },
      "delivery": { "reliability": "at-least-once", "ack": "receiver" },
      "payload": { "typeId": "chat.message.v1", "contentType": "application/json", "resource": "{\"text\":\"for the server\",\"runId\":\"{runId}\"}" }
    },
    "outputs": { "serverAckResource": "matchedMessage.data.payload.resource" }
  },
  "expect": {
    "connection": "wsAlice",
    "withinMs": 10000,
    "message": {
      "id": { "senderId": "{serverPeerId}" },
      "route": { "topicId": "al-control" },
      "targets": { "mode": "unicast", "toPeerId": "{aliceSessionId}" },
      "payload": { "typeId": "al.control.ack.v2" }
    },
    "consume": true
  }
},
{
  "name": "parseServerAck",
  "type": "set",
  "output": "serverAck",
  "transform": { "jsonParse": { "path": "outputs.serverAckResource" } }
},
{
  "name": "assertTheServerSpeaksForItself",
  "type": "assert",
  "actual": {
    "ackedMsgId": "{serverAck.ackedMsgId}",
    "fromPeerId": "{serverAck.fromPeerId}",
    "logicalRecipientPeerId": "{serverAck.logicalRecipientPeerId}"
  },
  "expect": {
    "missingActualValue": "MISSING",
    "body": {
      "ackedMsgId": "addressed-to-server-{runId}",
      "fromPeerId": "{serverPeerId}",
      "logicalRecipientPeerId": "{serverPeerId}"
    }
  }
},
```

In `packages/shared-test/black-box-runner/recipe-matrix.json` extend the entry's description to
`"No-browser API-v1 WebSocket addressed sends: a room unicast's one-member receipt, the out-of-audience refusal, serverPeerId on /api/config and the server-addressed receipt."`
(R-S3c-i-12).

Run the strict preflight on the recipe (zero findings), `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts`,
and unsandboxed `npm run test:api-v1:black-box:memory` (the recipe passes; verify the summary line).

- [ ] **Step 10: Validate.** The per-task set (Global Constraints) with the Deno checks and tests of both apps, the
      public API and bundle tests (the API snapshot must not move — no new export name; record both bundle figures and
      raise a crossed ceiling as Task 1 Step 13 does, "S3c-i's server address and hop receipt measure <the measured figure> KiB"), and
      the smoke lane (every WS `hop`/`subtree` send now waits for the server's ACK; the smoke family sends `receiver` and
      `none`, so it is expected unchanged — any red is a finding, not a budget change).

- [ ] **Step 11: Commit and push.**

```bash
git add packages/shared/api/api-config.ts packages/shared/services packages/shared-web/browser packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts apps/api-v1/src apps/api-v1/resources/api-v1-openapi.yaml apps/api-v1/test apps/relic-hunter-server-v1/src/main.ts packages/tests tests/playwright packages/shared-test/black-box-runner/tests/api-v1/api-v1-websocket-addressed-sends.json packages/shared-test/black-box-runner/recipe-matrix.json
git commit -m "feat(alm): S3c-i -- clients learn the WS server id and track it as their one hop (D57 as applied, Q2, Q3, R-S3a-4)"
git push
```

Add every app test directory Step 2's grep or Step 5's typecheck sweep edited (for example
`apps/relic-hunters-v1/tests`, `apps/ar-eye-hunter-v1`'s tests) to the `git add` (R-S3c-i-3).

### Task 3: The WS peer target on typed sends (Q11, WS only)

**Files:**

- Create: `packages/shared-web/browser/messages/create-browser-ws-unicast-message.ts`.
- Modify: `packages/shared-web/browser/messages/rallar-message-contracts.ts:67-76`,
  `packages/shared-web/browser/messages/browser-rallar-message-sender.ts:160-215` and its imports.
- Test: create `packages/tests/shared-web/messages/browser-ws-peer-send.test.ts`.

**Interfaces:**

- Consumes `newALUnicastMessage`'s `groupRef`/`reliability`/`ack`/`ownership` options (Task 1).
- Produces `RallarWsSendInput.peerId?: string` — absence means a broadcast to the send's scope, its distinct meaning.
- Produces `createBrowserWsUnicastMessage<T>(input: CreateBrowserWsUnicastMessageInput<T>): ALMessage` and
  `validateBrowserWsPeerInput<T>(input: RallarWsSendInput<T>): readonly RallarValidationIssue[]`.
- Task 5's Relic client calls `rallar.messages.room<RelicCommand>(definition).sendWs(command, { peerId })`.

- [ ] **Step 1: RED.** Create `packages/tests/shared-web/messages/browser-ws-peer-send.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

import { createBrowserMessageSenderFixture } from './browser-message-sender-fixture.ts';

const ROOM_REF = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const COMMAND_CHANNEL = { purpose: 'command', durability: undefined } as const;

describe('a WS send addressed to one peer (Q11, WS only)', () => {
    it('builds a receipted room unicast to the peer for a command channel', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const envelope = vi.spyOn(
            fixture.middleware.middleware.webSocketQueueBox,
            'enqueueOutboxIfAbsent'
        );

        await fixture.sender.sendWs({
            typeId: 'relic.command.v1',
            topicId: 'room.relic.command',
            payload: { kind: 'start-expedition' },
            roomId: 'room',
            peerId: 'server'
        }, COMMAND_CHANNEL);

        const message = envelope.mock.calls[0][0];
        expect(message.targets).toEqual({
            mode: 'unicast',
            toPeerId: 'server',
            groupRef: ROOM_REF
        });
        expect(message.route).toMatchObject({ topicId: 'room.relic.command', contextId: 'room' });
        expect(message.delivery).toEqual({
            ownership: 'shared',
            reliability: 'at-least-once',
            ack: 'receiver'
        });
        expect(message.qos?.durability).toEqual({ algo: 'volatile' });
    });

    it('keeps a lane send to a peer on the lane defaults: at-least-once and no receipt', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const envelope = vi.spyOn(
            fixture.middleware.middleware.webSocketQueueBox,
            'enqueueOutboxIfAbsent'
        );

        await fixture.sender.sendWs({
            typeId: 'app.note.v1',
            payload: { text: 'hi' },
            roomId: 'room',
            peerId: 'peer-b'
        }, undefined);

        expect(envelope.mock.calls[0][0]).toMatchObject({
            targets: { mode: 'unicast', toPeerId: 'peer-b', groupRef: ROOM_REF },
            delivery: { reliability: 'at-least-once', ack: 'none' }
        });
    });

    it('refuses a peer target on any strategy but ws until the RTC unicast lands (S3c-ii)', async () => {
        const fixture = createBrowserMessageSenderFixture();

        await expect(
            fixture.sender.sendTyped({
                typeId: 'relic.command.v1',
                payload: {},
                roomId: 'room',
                peerId: 'server'
            }, COMMAND_CHANNEL)
        )
            .rejects.toSatisfy(isRallarValidationError);
    });

    it.each([
        ['exclusions', { exceptPeerIds: ['peer-c'] }],
        ['ordering', { orderingKey: 'k', seq: 1 }],
        ['a snapshot floor', { minSnapshotVersion: 3 }],
        ['a hop limit', { ttlHops: 2 }]
    ])(
        'refuses a peer target that carries %s, which a unicast cannot honour',
        async (_name, extra) => {
            const fixture = createBrowserMessageSenderFixture();

            await expect(fixture.sender.sendWs({
                typeId: 'app.note.v1',
                payload: {},
                roomId: 'room',
                peerId: 'peer-b',
                ...extra
            }, undefined)).rejects.toSatisfy(isRallarValidationError);
        }
    );
});
```

Run: `npx vitest run packages/tests/shared-web/messages/browser-ws-peer-send.test.ts`
Expected: FAIL — `peerId` is not a member of `RallarWsSendInput`, and the send builds a room broadcast.

- [ ] **Step 2: GREEN.** In `packages/shared-web/browser/messages/rallar-message-contracts.ts` add to
      `RallarWsSendInput` after `readonly exceptPeerIds?: readonly string[];`:

```ts
/**
 * The one session or server a WS send addresses; absent, the send reaches its scope. A peer send names the room it
 * resolves, so the room admits it and asks the peer's receipt under a `command` purpose (D53). WS only until the RTC
 * unicast lands; carries no exclusions, no ordering, no snapshot floor and no hop limit, which a unicast cannot honour.
 */
readonly peerId?: string;
```

Create `packages/shared-web/browser/messages/create-browser-ws-unicast-message.ts`:

```ts
import type { ResolvedWsMessageInput } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type { RallarWsSendInput } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import {
    toBrowserMessageSendDefaults,
    type BrowserTypedChannelPolicy
} from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import {
    newALRoute,
    type ALMessage,
    type newALUnicastMessage
} from '@shared/al-contracts/al-contract.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

export interface CreateBrowserWsUnicastMessageInput<T> {
    readonly creation: Readonly<
        { createUnicast: typeof newALUnicastMessage; newResourceId(): string; }
    >;
    readonly resolved: ResolvedWsMessageInput<T>;
    readonly peerId: string;
    /** The payload as the validator captured it, parsed once. */
    readonly payload: unknown;
    readonly senderId: string;
    readonly channel: BrowserTypedChannelPolicy | undefined;
    readonly laneTtlMs: number;
}

/**
 * A WS send to one peer (Q11): a unicast that names the room it resolved, so the room's authority admits it and the
 * room's router delivers it (D53). The channel's purpose fills what the send left out, with the addressee as the
 * logical audience when a room is named, so a `command` asks the addressee's receipt.
 */
export function createBrowserWsUnicastMessage<T>(
    input: CreateBrowserWsUnicastMessageInput<T>
): ALMessage {
    const { resolved } = input;
    const send = resolved.input;
    const defaults = toBrowserMessageSendDefaults({
        send,
        channel: input.channel,
        hasLogicalAudience: resolved.roomRef !== undefined,
        laneTtlMs: input.laneTtlMs
    });
    return input.creation.createUnicast(
        input.senderId,
        newALRoute(
            send.topicId ?? send.typeId,
            send.contextId ?? resolved.roomId ?? resolved.scope,
            send.resourceId ?? input.creation.newResourceId()
        ),
        input.peerId,
        send.typeId,
        input.payload,
        {
            groupRef: resolved.roomRef,
            ttlMs: defaults.ttlMs,
            reliability: defaults.reliability,
            ack: defaults.ack,
            ownership: send.ownership ?? 'shared',
            qos: defaults.qos
        }
    );
}

/**
 * A peer-addressed WS send names its peer and carries no exclusions, no ordering, no snapshot floor and no hop limit:
 * the unicast it builds has no field for them, so they are refused rather than dropped (R-S3c-i-23).
 */
export function validateBrowserWsPeerInput<T>(
    input: RallarWsSendInput<T>
): readonly RallarValidationIssue[] {
    if (input.peerId === undefined) {
        return [];
    }
    const issues: RallarValidationIssue[] = [];
    if (input.peerId.length === 0) {
        issues.push({
            path: '$.peerId',
            code: 'missing-peer-id',
            message: 'A peer-addressed send names its peer.'
        });
    }
    if (
        input.exceptPeerIds !== undefined || input.orderingKey !== undefined ||
        input.seq !== undefined
    ) {
        issues.push({
            path: '$.peerId',
            code: 'unsupported',
            message: 'A peer-addressed send carries no exclusions and no ordering.'
        });
    }
    if (input.minSnapshotVersion !== undefined || input.ttlHops !== undefined) {
        issues.push({
            path: '$.peerId',
            code: 'unsupported',
            message: 'A peer-addressed send carries no snapshot floor and no hop limit.'
        });
    }
    return issues;
}
```

In `packages/shared-web/browser/messages/browser-rallar-message-sender.ts` import
`createBrowserWsUnicastMessage, validateBrowserWsPeerInput` from `./create-browser-ws-unicast-message.ts`, and
replace the body of `sendWs` after the scope resolution (`:171-192`) with:

```ts
throwIfMessageIssues([
    ...this.input.inputValidator.validateWs({ input, scope, roomId, roomRef }),
    ...this.input.inputValidator.validateWsOrdering(input),
    ...validateBrowserWsPeerInput(input)
]);

const payloadValidation = this.capturePayload(input.payload);
const context = await this.input.connect();
const session = this.input.requireSession();
const resolved = { input, scope, roomId, roomRef };
const message = input.peerId === undefined
    ? this.createWsMessage({ resolved, room, payloadValidation, session, channel })
    : createBrowserWsUnicastMessage({
        creation: this.input.creation,
        resolved,
        peerId: input.peerId,
        payload: parseCapturedPayload(payloadValidation),
        senderId: session.sessionId,
        channel,
        laneTtlMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS
    });

return this.startDelivery({
    context,
    carrier: 'ws',
    message,
    canFallback: false,
    payloadIssues: payloadValidation.issues
});
```

and the head of `sendTyped` (`:199`) with:

```ts
const strategy = input.strategy ?? 'rtc-with-ws-fallback';
if (input.peerId !== undefined && strategy !== 'ws') {
    return throwMessageValidationIssue(
        '$.peerId',
        'unsupported',
        'A peer-addressed typed send travels WS only until the RTC unicast lands.'
    );
}
switch (strategy) {
```

- [ ] **Step 3: Run to verify it passes.**

  Run: `npx vitest run packages/tests/shared-web/messages`
  Expected: PASS — the S3a pin `browser-message-handle-admission.test.ts:154` still holds: `sendWsUnicast` is
  untouched, its unicast names no room and carries no `delivery` (it flips in S3c-ii).

- [ ] **Step 4: Validate.** The per-task set with the public API and bundle tests (no export name moves; record both
      bundle figures and raise a crossed ceiling as Task 1 Step 13 does, "S3c-i's WS peer target measures <the measured figure> KiB").

- [ ] **Step 5: Commit and push.**

```bash
git add packages/shared-web/browser/messages packages/tests/shared-web/messages
git commit -m "feat(alm): S3c-i -- a typed WS send may address one peer (Q11, WS only)"
git push
```

### Task 4: Server-originated receipts, the cluster audience and the settlement sink (D58, D61, Q7, Q8, Q12)

**Files:**

- Create: `packages/shared-server/rallar-system/websocket/read-server-publish-room-audience.ts`,
  `packages/shared-server/rallar-system/websocket/router/read-rallar-server-ws-publish-audience.ts`,
  `packages/shared-server/rallar-system/observability/alm-receipt-diagnostics.ts`.
- Modify: as "Task 4" in the file structure.
- Test: create `packages/tests/shared-server/rallar-system/observability/alm-receipt-diagnostics.test.ts`,
  `packages/tests/shared-server/rallar-system/websocket/router/read-rallar-server-ws-publish-audience.test.ts`,
  `packages/tests/shared-server/rallar-system/websocket/read-server-publish-room-audience.test.ts`,
  `packages/tests/shared/services/ws-queue-box-server-originated-receipt.test.ts`; modify
  `packages/tests/shared/services/ws-queue-box-server-addressed-receipts.test.ts` (one case),
  `packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts:619-634`,
  `packages/tests/shared-server/rallar-system/admin-operations/read-admin-realtime.test.ts`,
  `apps/api-v1/test/composition/api-v1-runtime.test.ts:36-44,104-140`,
  `apps/api-v1/test/composition/create-api-v1-admin-services.test.ts:118`.

**Interfaces:**

- Consumes `RallarServerWsRouter.serverPeerId` (Task 2).
- Produces `ALOutboundAdmissionStore.readAdmittedAudience: (msgId: string) => Promise<readonly string[] | undefined>`.
- Produces `WsQueueBoxServerClusterPublication.Publisher = (message: ALMessage, entry: ResourceEntry, admittedAudience: readonly string[] | undefined) => Promise<void>`,
  `WsQueueBoxServerClusterPublication.Dependencies.readAdmittedAudience`, `WsQueueBoxServerClusterPublication.readAdmittedAudience(msgId)`
  and `WsQueueBoxServerService.readAdmittedAudience(msgId: string): Promise<readonly string[] | undefined>`.
- Produces on `QueueBoxPubSubWsService`: `sendToTargetsWithResult(message, recipientSessionIds?, admittedPeerIds?)`,
  `readAdmittedAudience(msgId)`, and the three-argument publisher.
- Produces `RallarServerWsPublishAudienceReader = (message: ALMessage) => Promise<RallarServerWsRoomAudience | undefined>`,
  `RallarServerWsRouterOptions.readServerPublishAudience?`, `createServerPublishRoomAudienceReader(dependencies: ServerPublishRoomAudienceDependencies): RallarServerWsPublishAudienceReader`,
  `readRallarServerWsPublishAudience(input: ReadRallarServerWsPublishAudienceInput): Promise<RallarServerWsFrozenPublishAudience | undefined>`;
  `toAuthorizedRoomAudience` becomes an export of `ws-topic-room-authorizer.ts`.
- Produces `RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY = 256`, `createRallarAlmReceiptDiagnosticsRecorder(input: CreateRallarAlmReceiptDiagnosticsRecorderInput): RallarAlmReceiptDiagnosticsRecorder`
  (`{ settlements: ALDeliverySettlementSink; readDiagnostics: () => AdminOperationsAlmReceiptDiagnostics }`),
  `toRallarAlmReceiptEntry(current, settlement, nowEpochMs)`; API types `AdminOperationsAlmReceiptEntry`,
  `AdminOperationsAlmReceiptDiagnostics`; `AdminOperationsRealtimeResponse.almReceipts: { diagnostics; processLocal }`.
- Produces `CreateRallarMiddlewareOptions.wsOutboundSettlements?: ALDeliverySettlementSink`,
  `ReadAdminRealtime.Options.readAlmReceipts`, `CreateApiV1AdminOperationUseCasesInput.readAlmReceipts`,
  `ApiV1Runtime.almReceiptDiagnostics` and `RequireApiV1RuntimeInput.almReceiptDiagnostics`.
- Task 5's Relic snapshot publish relies on the router freezing an `outbox` room broadcast whose sender is the server.

- [ ] **Step 1: RED — the recorder.** Create `packages/tests/shared-server/rallar-system/observability/alm-receipt-diagnostics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
    createRallarAlmReceiptDiagnosticsRecorder,
    RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY
} from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;

describe('the WS server settlement recorder (D58, D61, C10)', () => {
    it('opens an entry on the first receipt fact and keeps who confirmed and who did not', () => {
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => NOW_EPOCH_MS,
            capacity: 4
        });

        recorder.settlements(attemptSettled('snapshot-1'));
        recorder.settlements(acknowledgement('snapshot-1', ['a'], ['b']));

        expect(recorder.readDiagnostics()).toEqual({
            capacity: 4,
            messages: [{
                msgId: 'snapshot-1',
                mode: 'receiver',
                confirmedPeerIds: ['a'],
                unconfirmedPeerIds: ['b'],
                lastSettlementKind: 'acknowledgement',
                receiptExhausted: false,
                updatedAtEpochMs: NOW_EPOCH_MS
            }]
        });
    });

    it('marks an exhausted receipt and moves only the last kind on a later settlement', () => {
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => NOW_EPOCH_MS,
            capacity: 4
        });
        recorder.settlements(acknowledgement('snapshot-1', ['a'], ['b']));

        recorder.settlements({
            kind: 'receipt-exhausted',
            msgId: 'snapshot-1',
            carrier: 'ws',
            atMs: NOW_EPOCH_MS,
            mode: 'receiver',
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            detail: 'The receipt ran out of retries after 3 of 3.'
        });
        recorder.settlements(attemptSettled('snapshot-1'));

        expect(recorder.readDiagnostics().messages).toEqual([expect.objectContaining({
            msgId: 'snapshot-1',
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            receiptExhausted: true,
            lastSettlementKind: 'attempt-settled'
        })]);
    });

    it('keeps the capacity by evicting the least recently updated entry', () => {
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => NOW_EPOCH_MS,
            capacity: 2
        });

        recorder.settlements(acknowledgement('first', ['a'], []));
        recorder.settlements(acknowledgement('second', ['a'], []));
        recorder.settlements(acknowledgement('first', ['a', 'b'], []));
        recorder.settlements(acknowledgement('third', ['a'], []));

        expect(recorder.readDiagnostics().messages.map((entry) => entry.msgId)).toEqual([
            'first',
            'third'
        ]);
        expect(RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY).toBe(256);
    });
});

function acknowledgement(
    msgId: string,
    confirmed: readonly string[],
    unconfirmed: readonly string[]
): ALDeliverySettlement {
    return {
        kind: 'acknowledgement',
        msgId,
        carrier: 'ws',
        atMs: NOW_EPOCH_MS,
        mode: 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: [...confirmed, ...unconfirmed],
        confirmedRecipientPeerIds: confirmed,
        unconfirmedRecipientPeerIds: unconfirmed,
        complete: unconfirmed.length === 0
    };
}

function attemptSettled(msgId: string): ALDeliverySettlement {
    return {
        kind: 'attempt-settled',
        msgId,
        carrier: 'ws',
        atMs: NOW_EPOCH_MS,
        attemptId: 'attempt-1',
        outcome: 'sent',
        submissionAttempted: true,
        detail: undefined,
        willRetry: false
    };
}
```

Run: `npx vitest run packages/tests/shared-server/rallar-system/observability/alm-receipt-diagnostics.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 2: GREEN — the recorder and its API types.** In `packages/shared/api/admin-operations-types.ts` add the
      imports `import type { ALReceiptMode } from '../al-contracts/al-policy.ts';` and
      `import type { ALDeliverySettlement } from '../alm/delivery/al-delivery-lifecycle.ts';`, the types:

```ts
/** One message's receipt as the WS server's own outbound owner settled it (D61). */
export interface AdminOperationsAlmReceiptEntry {
    readonly msgId: string;
    /** Under `receiver` the peers are sessions of the frozen audience; under `hop` and `subtree`, next hops. */
    readonly mode: ALReceiptMode;
    readonly confirmedPeerIds: readonly string[];
    readonly unconfirmedPeerIds: readonly string[];
    readonly lastSettlementKind: ALDeliverySettlement['kind'];
    readonly receiptExhausted: boolean;
    readonly updatedAtEpochMs: number;
}

export interface AdminOperationsAlmReceiptDiagnostics {
    readonly capacity: number;
    /** The least recently updated first. */
    readonly messages: readonly AdminOperationsAlmReceiptEntry[];
}
```

and to `AdminOperationsRealtimeResponse` (`:106-123`), after `groupFormation`:

```ts
almReceipts: Readonly<{
    diagnostics: AdminOperationsAlmReceiptDiagnostics;
    processLocal: boolean;
}>;
```

Create `packages/shared-server/rallar-system/observability/alm-receipt-diagnostics.ts`:

```ts
import type {
    ALDeliverySettlement,
    ALDeliverySettlementSink
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    AdminOperationsAlmReceiptDiagnostics,
    AdminOperationsAlmReceiptEntry
} from '@shared/api/admin-operations-types.ts';

/** The most messages the recorder lists: the AL collection limit, so a room-sized burst stays visible (C10). */
export const RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY = 256;

export interface CreateRallarAlmReceiptDiagnosticsRecorderInput {
    readonly nowEpochMs: () => number;
    readonly capacity: number;
}

/** The WS server's settlement sink (D58, D61): per message, who confirmed its receipt; in memory, per process. */
export interface RallarAlmReceiptDiagnosticsRecorder {
    readonly settlements: ALDeliverySettlementSink;
    readonly readDiagnostics: () => AdminOperationsAlmReceiptDiagnostics;
}

export function createRallarAlmReceiptDiagnosticsRecorder(
    input: CreateRallarAlmReceiptDiagnosticsRecorderInput
): RallarAlmReceiptDiagnosticsRecorder {
    const entries = new Map<string, AdminOperationsAlmReceiptEntry>();
    return {
        settlements: (settlement) => {
            const next = toRallarAlmReceiptEntry(
                entries.get(settlement.msgId),
                settlement,
                input.nowEpochMs()
            );
            if (next !== undefined) {
                setBoundedEntry(entries, next, input.capacity);
            }
        },
        readDiagnostics: () => ({ capacity: input.capacity, messages: [...entries.values()] })
    };
}

/** A receipt fact opens or refreshes the message's entry; any other settlement only moves its last kind. */
export function toRallarAlmReceiptEntry(
    current: AdminOperationsAlmReceiptEntry | undefined,
    settlement: ALDeliverySettlement,
    nowEpochMs: number
): AdminOperationsAlmReceiptEntry | undefined {
    switch (settlement.kind) {
        case 'acknowledgement':
            return {
                msgId: settlement.msgId,
                mode: settlement.mode,
                confirmedPeerIds: settlement.confirmedRecipientPeerIds,
                unconfirmedPeerIds: settlement.unconfirmedRecipientPeerIds,
                lastSettlementKind: settlement.kind,
                receiptExhausted: current?.receiptExhausted ?? false,
                updatedAtEpochMs: nowEpochMs
            };
        case 'receipt-exhausted':
            return {
                msgId: settlement.msgId,
                mode: settlement.mode,
                confirmedPeerIds: settlement.confirmedPeerIds,
                unconfirmedPeerIds: settlement.unconfirmedPeerIds,
                lastSettlementKind: settlement.kind,
                receiptExhausted: true,
                updatedAtEpochMs: nowEpochMs
            };
        default:
            return current === undefined
                ? undefined
                : { ...current, lastSettlementKind: settlement.kind, updatedAtEpochMs: nowEpochMs };
    }
}

/** The least recently updated entry leaves first. */
function setBoundedEntry(
    entries: Map<string, AdminOperationsAlmReceiptEntry>,
    entry: AdminOperationsAlmReceiptEntry,
    capacity: number
): void {
    entries.delete(entry.msgId);
    entries.set(entry.msgId, entry);
    for (const msgId of entries.keys()) {
        if (entries.size <= capacity) {
            return;
        }
        entries.delete(msgId);
    }
}
```

Run the Step 1 file. Expected: PASS.

- [ ] **Step 3: RED — the publish audience.** Create
      `packages/tests/shared-server/rallar-system/websocket/router/read-rallar-server-ws-publish-audience.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import type { RallarServerWsRoomAudience } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { readRallarServerWsPublishAudience } from '@shared-server/rallar-system/websocket/router/read-rallar-server-ws-publish-audience.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const NOTIFICATION = newALBroadcastMessage(
    'server',
    newALRoute('room.snapshot', 'room-1', 'round-1'),
    'room',
    'snapshot.v1',
    {},
    {
        groupRef: ROOM,
        reliability: 'at-least-once',
        ack: 'receiver',
        ttlMs: 15_000
    }
);
const AUDIENCE: RallarServerWsRoomAudience = {
    targets: NOTIFICATION.targets!,
    sessions: [{ sessionId: 'b' }, {
        sessionId: 'c'
    }] as unknown as RallarServerWsRoomAudience['sessions'],
    snapshotVersion: 4
};

describe('the audience a server publish is frozen to (D58, Q7, C8)', () => {
    it('freezes the server\'s own outbox room notification to the room\'s live sessions', async () => {
        const readRoomAudience = vi.fn(async () => AUDIENCE);

        const frozen = await readRallarServerWsPublishAudience({
            message: NOTIFICATION,
            fanout: 'outbox',
            serverPeerId: 'server',
            readRoomAudience
        });

        expect(frozen).toEqual({ current: AUDIENCE, admittedPeerIds: ['b', 'c'] });
        expect(readRoomAudience).toHaveBeenCalledWith(NOTIFICATION);
    });

    it.each<[string, ALMessage, 'outbox' | 'live-only']>([
        ['a live-only publish', NOTIFICATION, 'live-only'],
        ['a notification another sender publishes', {
            ...NOTIFICATION,
            id: { ...NOTIFICATION.id, senderId: 'relic-hunter-server' }
        }, 'outbox'],
        [
            'a world broadcast',
            { ...NOTIFICATION, targets: { mode: 'broadcast', scope: 'world' } },
            'outbox'
        ]
    ])('leaves %s to resolve its audience at dequeue', async (_name, message, fanout) => {
        const readRoomAudience = vi.fn(async () => AUDIENCE);

        expect(
            await readRallarServerWsPublishAudience({
                message,
                fanout,
                serverPeerId: 'server',
                readRoomAudience
            })
        ).toBeUndefined();
        expect(readRoomAudience).not.toHaveBeenCalled();
    });

    it('freezes nothing when the router has no audience reader or the room has none to read', async () => {
        expect(
            await readRallarServerWsPublishAudience({
                message: NOTIFICATION,
                fanout: 'outbox',
                serverPeerId: 'server',
                readRoomAudience: undefined
            })
        )
            .toBeUndefined();
        expect(
            await readRallarServerWsPublishAudience({
                message: NOTIFICATION,
                fanout: 'outbox',
                serverPeerId: 'server',
                readRoomAudience: async () => undefined
            })
        )
            .toBeUndefined();
    });
});
```

Create `packages/tests/shared-server/rallar-system/websocket/read-server-publish-room-audience.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createServerPublishRoomAudienceReader } from '@shared-server/rallar-system/websocket/read-server-publish-room-audience.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';

import { createGroupSnapshot } from '../group-state/snapshot/group-state-snapshot-test-fixtures.ts';

describe('the room audience a server publish reads (D58, Q7)', () => {
    it('reads the active members\' live sessions of the named room at its snapshot version', async () => {
        const snapshot = createGroupSnapshot(3, ['session-1', 'session-2']);
        const reader = createServerPublishRoomAudienceReader({
            readGroupSnapshot: async (ref) =>
                ref.groupId === snapshot.group.groupId ? snapshot : undefined,
            nowEpochMs: Date.now
        });
        const message = newALBroadcastMessage(
            'server',
            newALRoute('room.snapshot', snapshot.group.groupId, 'r1'),
            'room',
            'snapshot.v1',
            {},
            {
                groupRef: snapshot.group
            }
        );

        const audience = await reader(message);

        expect(audience?.sessions.map((session) => session.sessionId)).toEqual([
            'session-1',
            'session-2'
        ]);
        expect(audience?.targets).toEqual(message.targets);
        expect(
            await reader({
                ...message,
                targets: {
                    mode: 'broadcast',
                    scope: 'room',
                    groupRef: { ...snapshot.group, groupId: 'other' }
                }
            })
        )
            .toBeUndefined();
    });
});
```

Run both files. Expected: FAIL — the modules do not exist.

- [ ] **Step 4: GREEN — the publish audience.** In
      `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts` add after
      `RallarServerWsRoomAuthorizer`:

```ts
/** The room's live sessions a server-originated publish freezes as its audience; undefined when there is no room to read. */
export type RallarServerWsPublishAudienceReader = (
    message: ALMessage
) => Promise<RallarServerWsRoomAudience | undefined>;
```

and to `RallarServerWsRouterOptions` (`:149-157`): `readonly readServerPublishAudience?: RallarServerWsPublishAudienceReader;`.

Create `packages/shared-server/rallar-system/websocket/router/read-rallar-server-ws-publish-audience.ts`:

```ts
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsPublishAudienceReader,
    RallarServerWsRoomAudience
} from './rallar-server-ws-router-contracts.ts';

export interface RallarServerWsFrozenPublishAudience {
    readonly current: RallarServerWsRoomAudience;
    readonly admittedPeerIds: readonly string[];
}

export interface ReadRallarServerWsPublishAudienceInput {
    readonly message: ALMessage;
    readonly fanout: RallarServerWsFanout;
    readonly serverPeerId: string;
    readonly readRoomAudience: RallarServerWsPublishAudienceReader | undefined;
}

/**
 * A room notification the server itself publishes through the outbox is frozen to the room's live sessions at
 * publish (D58, Q7): its receipt expects them, a session that joins later is not addressed, and one that leaves reads
 * unconfirmed (D43). Every other publish resolves its audience as before (C8).
 */
export async function readRallarServerWsPublishAudience(
    input: ReadRallarServerWsPublishAudienceInput
): Promise<RallarServerWsFrozenPublishAudience | undefined> {
    const { message } = input;
    const serverRoomNotification = input.fanout === 'outbox' &&
        message.id.senderId === input.serverPeerId &&
        message.targets?.mode === 'broadcast' && message.targets.scope === 'room';
    const current = serverRoomNotification ? await input.readRoomAudience?.(message) : undefined;
    return current === undefined
        ? undefined
        : { current, admittedPeerIds: current.sessions.map((session) => session.sessionId) };
}
```

In `packages/shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts:105` export
`toAuthorizedRoomAudience` (add `export`; no other change). Create
`packages/shared-server/rallar-system/websocket/read-server-publish-room-audience.ts`:

```ts
import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { RallarServerWsPublishAudienceReader } from './router/rallar-server-ws-router-contracts.ts';
import { toAuthorizedRoomAudience } from './ws-topic-room-authorizer.ts';

export interface ServerPublishRoomAudienceDependencies {
    readonly readGroupSnapshot: (ref: GroupRef) => Promise<GroupSnapshot | undefined>;
    readonly nowEpochMs: () => number;
}

/** The named room's active members' live sessions, read the way the room authorizer reads a sender's room (D58, Q7). */
export function createServerPublishRoomAudienceReader(
    dependencies: ServerPublishRoomAudienceDependencies
): RallarServerWsPublishAudienceReader {
    return async (message: ALMessage) => {
        const groupRef = readALTargetGroupRef(message);
        const snapshot = groupRef === undefined
            ? undefined
            : await dependencies.readGroupSnapshot(groupRef);
        return snapshot === undefined || message.targets === undefined
            ? undefined
            : toAuthorizedRoomAudience(snapshot, message.targets, dependencies.nowEpochMs());
    };
}
```

In `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts`: import
`readRallarServerWsPublishAudience` from `./read-rallar-server-ws-publish-audience.ts`; add the field
`private readonly readServerPublishAudience: RallarServerWsRouterOptions['readServerPublishAudience'];` and in the
constructor `this.readServerPublishAudience = options.readServerPublishAudience;`; replace `publish` (`:141-146`) with:

```ts
async publish(
    message: ALMessage,
    fanout?: RallarServerWsFanout
): Promise<RallarServerWsPublishResult> {
    const selected = fanout ?? this.defaultFanout;
    const frozen = await readRallarServerWsPublishAudience({
        message,
        fanout: selected,
        serverPeerId: this.serverPeerId,
        readRoomAudience: this.readServerPublishAudience
    });
    return await this.publishToFanout(message, selected, frozen);
}
```

In `apps/api-v1/src/composition/create-default-rallar-server.ts` (`:116-124`) add to the `ws` options, before
`...input.ws`:

```ts
readServerPublishAudience: createServerPublishRoomAudienceReader({
    readGroupSnapshot: async (ref) => await runtime.groupStateService.readCurrentSnapshot(ref),
    nowEpochMs
}),
```

with `import { createServerPublishRoomAudienceReader } from '@shared-server/rallar-system/websocket/read-server-publish-room-audience.ts';`.

Run the Step 3 files and `npx vitest run packages/tests/shared-server/rallar-system/rallar-server-ws-router.test.ts packages/tests/shared-server/rallar-system/websocket`.
Expected: PASS.

- [ ] **Step 5: RED — the server's own receipts, end to end, and the cluster audience.** Create
      `packages/tests/shared/services/ws-queue-box-server-originated-receipt.test.ts`:

```ts
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    createRallarAlmReceiptDiagnosticsRecorder,
    type RallarAlmReceiptDiagnosticsRecorder
} from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type {
    QueueBoxPubSubBridge,
    QueueBoxPubSubMessage
} from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

const SERVER_ID = 'server';
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
/** Long enough that the receipt budget (four 2 s windows) ends first. */
const NOTIFICATION_TTL_MS = 60_000;
const CLOCK_STEP_MS = 1_000;

interface ServerInstance {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly sockets: Readonly<Record<string, SimulatedWebSocket>>;
}

describe('receipts of the server\'s own room notifications (D58, D61)', () => {
    it('sends only to the audience frozen at publish and records who confirmed, then that the rest never did', async () => {
        const clock = mockClock();
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => clock.nowMs,
            capacity: 256
        });
        const outbox = createOutbox(clock);
        const local = await createInstance({
            outbox,
            state: createInMemoryALAdmissionState(outbox),
            peerIds: ['a', 'b', 'c'],
            recorder,
            nowMs: () => clock.nowMs
        });

        const enqueued = await local.service.enqueueOutboxIfAbsent(
            serverNotification('snapshot-1'),
            ['a', 'b']
        );

        expect(enqueued.verdict.kind).toBe('admitted');
        await expect.poll(async () => {
            await local.engine.executeOnce();
            return [
                countCopies(local.sockets.a, 'snapshot-1'),
                countCopies(local.sockets.b, 'snapshot-1')
            ];
        }).toEqual([1, 1]);
        expect(countCopies(local.sockets.c, 'snapshot-1')).toBe(0);

        await local.service.acceptIncomingMessage(sessionAck('snapshot-1', 'a'), 'a');
        expect(recorder.readDiagnostics().messages).toEqual([expect.objectContaining({
            msgId: 'snapshot-1',
            mode: 'receiver',
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            receiptExhausted: false
        })]);

        await expect.poll(async () => {
            clock.nowMs += CLOCK_STEP_MS;
            await local.engine.executeOnce();
            return recorder.readDiagnostics().messages[0]?.receiptExhausted;
        }, { timeout: 5_000 }).toBe(true);
        expect(recorder.readDiagnostics().messages[0]).toMatchObject({
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            lastSettlementKind: 'receipt-exhausted'
        });
    });

    it('sends the frozen audience only, on the publishing instance and on every other one (C9)', async () => {
        const clock = mockClock();
        const outbox = createOutbox(clock);
        const state = createInMemoryALAdmissionState(outbox);
        const nowMs = () => clock.nowMs;
        const local = await createInstance({
            outbox,
            state,
            peerIds: ['a', 'b'],
            recorder: undefined,
            nowMs
        });
        const remote = await createInstance({
            outbox,
            state,
            peerIds: ['c', 'd'],
            recorder: undefined,
            nowMs
        });
        await joinCluster(local, remote);

        await local.service.enqueueOutboxIfAbsent(serverNotification('snapshot-2'), ['a', 'c']);

        await expect.poll(async () => {
            await local.engine.executeOnce();
            return [
                countCopies(local.sockets.a, 'snapshot-2'),
                countCopies(remote.sockets.c, 'snapshot-2')
            ];
        }).toEqual([1, 1]);
        expect(countCopies(local.sockets.b, 'snapshot-2')).toBe(0);
        expect(countCopies(remote.sockets.d, 'snapshot-2')).toBe(0);
    });
});

interface CreateInstanceInput {
    readonly outbox: InMemoryQueueBox;
    readonly state: ALAdmissionMemoryState;
    readonly peerIds: readonly string[];
    readonly recorder: RallarAlmReceiptDiagnosticsRecorder | undefined;
    readonly nowMs: () => number;
}

/** One WS server instance; two of them share the outbox and the outbound admission state, as PostgreSQL does. */
async function createInstance(input: CreateInstanceInput): Promise<ServerInstance> {
    const socketServer = new JsonWebSocketServer();
    const sockets: Record<string, SimulatedWebSocket> = {};
    for (const peerId of input.peerIds) {
        const socket = new SimulatedWebSocket(`ws://${peerId}`);
        await socket.open();
        socketServer.addConnection(new ConnectionContext({ id: peerId, socket }));
        sockets[peerId] = socket;
    }
    const recipients = () =>
        [...socketServer.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }));
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        outbox: input.outbox,
        socket: socketServer,
        name: SERVER_ID,
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        outboundStores: createDefaultInMemoryALOutboundRuntimeStores({
            nowMs: input.nowMs,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            outboundBackend: new InMemoryAdmissionBackend(input.state, input.nowMs)
        }),
        outboundSettlements: input.recorder?.settlements,
        targetResolver: {
            resolvePeerRecipients: (peerId) =>
                recipients().filter((recipient) => recipient.peerId === peerId),
            resolveBroadcastRecipients: recipients
        }
    });
    onTestFinished(() => service.dispose());
    return { service, engine, sockets };
}

async function joinCluster(local: ServerInstance, remote: ServerInstance): Promise<void> {
    const subscribers: ((message: QueueBoxPubSubMessage) => Promise<void> | void)[] = [];
    const bus: QueueBoxPubSubBridge = {
        subscribe: async (_channel, subscriber) => {
            subscribers.push(subscriber);
        },
        publish: async (_channel, message) => {
            await Promise.all(subscribers.map(async (subscriber) => await subscriber(message)));
        }
    };
    await installQueueBoxPubSubBridge({
        wsQBoxServerService: local.service,
        bridge: bus,
        channel: 'ws',
        publisherId: 'local'
    });
    await installQueueBoxPubSubBridge({
        wsQBoxServerService: remote.service,
        bridge: bus,
        channel: 'ws',
        publisherId: 'remote'
    });
}

function mockClock(): { nowMs: number; } {
    const clock = { nowMs: Date.now() };
    vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(() =>
        Temporal.Instant.fromEpochMilliseconds(clock.nowMs)
    );
    onTestFinished(() => vi.restoreAllMocks());
    return clock;
}

function createOutbox(clock: { nowMs: number; }): InMemoryQueueBox {
    return new InMemoryQueueBox(
        new Map(),
        () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs)
    );
}

function serverNotification(msgId: string): ALMessage {
    const message = newALBroadcastMessage(
        SERVER_ID,
        newALRoute('room.snapshot', ROOM.groupId, msgId),
        'room',
        'snapshot.v1',
        { msgId },
        {
            groupRef: ROOM,
            reliability: 'at-least-once',
            ack: 'receiver',
            ttlMs: NOTIFICATION_TTL_MS
        }
    );
    return { ...message, id: { ...message.id, msgId } };
}

function sessionAck(ackedMsgId: string, recipient: string): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${ackedMsgId}-${recipient}`, senderId: recipient, ts: Date.now() },
        {
            ackedMsgId,
            fromPeerId: recipient,
            toPeerId: SERVER_ID,
            originPeerId: SERVER_ID,
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}

function countCopies(socket: SimulatedWebSocket, msgId: string): number {
    return socket.sent.filter((frame) => decodePersistedALMessage(frame).id.msgId === msgId).length;
}
```

Run: `npx vitest run packages/tests/shared/services/ws-queue-box-server-originated-receipt.test.ts`
Expected: the first case PASSES already — a single instance without a cluster publisher narrows its dequeue plan
to the admitted audience (`ws-queue-box-server-outbound-planning.ts:180-185`), and the recorder is handed straight
to the service as its sink, so the case pins the sink's contract that Step 8 wires into api-v1. The second case
FAILS: the local direct send reaches `b` and the remote send reaches `d` (`queue-box-pub-sub-bridge.ts:165,250`).

- [ ] **Step 6: GREEN — both cluster sends read the captured audience (C9).** In
      `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts` add to `ALOutboundAdmissionStore` after
      `readSentMessage`:

```ts
/** The audience a server admitted the message to, captured with its policy; undefined for every other message (D58). */
readonly readAdmittedAudience: (msgId: string) => Promise<readonly string[] | undefined>;
```

and to `ProviderBackedALOutboundAdmissionStore` after `readSentMessage` (`:394-396`):

```ts
async readAdmittedAudience(msgId: string): Promise<readonly string[] | undefined> {
    return await this.backend.readWithin(async (session) =>
        (await this.reads.readStoredMessage(session, msgId))?.policy.admittedAudience
    );
}
```

In `packages/shared/services/ws-queue-box-server/ws-queue-box-server-cluster-publication.ts` replace the
namespace's `Publisher` and `Dependencies`, `writeDequeuedRow` and the publisher call in `writeReceiptRow` with:

```ts
/**
 * Hands one durable outbox row to every other instance and delivers it to this instance's own targets, narrowed to
 * the audience it was admitted to when it has one (D58).
 */
export type Publisher = (
    message: ALMessage,
    entry: ResourceEntry,
    admittedAudience: readonly string[] | undefined
) => Promise<void>;

export interface Dependencies {
    readonly targetResolution: WsQueueBoxServerTargetResolution;
    /** The outbound owner's canonical scope, which locates the outbox row a publication names. */
    readonly canonicalScope: string;
    readonly clock: ALOutboundMessageRuntime.Clock;
    /** The captured admitted audience of a message, read from the admission store every instance shares. */
    readonly readAdmittedAudience: (msgId: string) => Promise<readonly string[] | undefined>;
}
```

```ts
    async writeDequeuedRow(message: ALMessage, entry: ResourceEntry): Promise<void> {
        const publisher = this.#publisher;
        if (publisher === undefined || isWsQueueBoxServerReceiptRow(message)) {
            return;
        }
        await publisher(message, entry, await this.#dependencies.readAdmittedAudience(message.id.msgId));
    }

    readAdmittedAudience(msgId: string): Promise<readonly string[] | undefined> {
        return this.#dependencies.readAdmittedAudience(msgId);
    }
```

and in `writeReceiptRow` pass `undefined` as the publisher's third argument (a receipt addresses its origin alone).

In `packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts` (call lines): add
`readAdmittedAudience: (msgId) => dependencies.outboundRuntime.admissionStore.readAdmittedAudience(msgId)` to the
`WsQueueBoxServerClusterPublication` dependencies (`:165-169`), and beside `sendToTargetsWithResult` (`:609-615`):

```ts
readAdmittedAudience(msgId: string): Promise<readonly string[] | undefined> {
    return this.clusterPublication.readAdmittedAudience(msgId);
}
```

In `packages/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts` replace `QueueBoxPubSubWsService`
(`:34-40`) with:

```ts
export interface QueueBoxPubSubWsService {
    readonly outbox: QueueBoxResourceEntryRepository;
    onOutboxClusterPublishDo(
        publisher: (
            message: ALMessage,
            entry: ResourceEntry,
            admittedAudience: readonly string[] | undefined
        ) => Promise<void>
    ): QueueBoxPubSubWsService;
    sendToTargetsWithResult(
        message: ALMessage,
        recipientSessionIds?: readonly string[],
        admittedPeerIds?: readonly string[]
    ): WsServerLiveSendResult;
    /** The audience the row was admitted to, captured in the shared admission store (D58, C9). */
    readAdmittedAudience(msgId: string): Promise<readonly string[] | undefined>;
}
```

in `registerQueueBoxOutboxPublisher` change the callback to `async (message, entry, admittedAudience) => {` and its
send to `options.wsQBoxServerService.sendToTargetsWithResult(message, undefined, admittedAudience);`, and in
`sendRemoteQueueBoxOutboxEntry` replace the send (`:250-252`) with:

```ts
const remoteMessage = decodePersistedALMessage(entry.resource);
const result = options.wsQBoxServerService.sendToTargetsWithResult(
    remoteMessage,
    undefined,
    await options.wsQBoxServerService.readAdmittedAudience(remoteMessage.id.msgId)
);
```

In `packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts` add
`readonly readAdmittedAudience?: (msgId: string) => Promise<readonly string[] | undefined>;` to
`CreateTestQueueBoxPubSubWsServiceInput` and to the double in `createTestQueueBoxPubSubWsService` (`:622-631`):

```ts
readAdmittedAudience(msgId) {
    return input.readAdmittedAudience?.(msgId) ?? Promise.resolve(undefined);
}
```

and pass `undefined` as the third argument of the direct publisher call at `:150`
(`await outboxPublishers[0](message, entry, undefined);`), which the tests-typecheck ratchet otherwise reports
(R-S3c-i-16).

Run: `npx vitest run packages/tests/shared/services/ws-queue-box-server-originated-receipt.test.ts packages/tests/shared-server/rallar-system/queue-pubsub packages/tests/shared/services/ws-queue-box-server-receipt-aggregation.test.ts packages/tests/shared/services/ws-queue-box-server-receipt-row.test.ts packages/tests/shared/ws-outbox-owner-miss-retry.test.ts`
Expected: PASS. `npm run typecheck` names any other object typed `ALOutboundAdmissionStore` or
`QueueBoxPubSubWsService` a test builds by hand; add `readAdmittedAudience: async () => undefined` to each.

- [ ] **Step 7: Leavers read unconfirmed on the WS leg (Q12, C11).** In
      `packages/tests/shared/services/ws-queue-box-server-addressed-receipts.test.ts` add inside the describe:

```ts
it('aggregates a handed-over message over the audience its RTC leg froze, so a leaver reads unconfirmed (Q12)', async () => {
    const fixture = await createAddressedFixture();
    const handedOver: ALMessage = {
        ...roomUnicast('frozen-1', 'b', 'receiver'),
        targets: {
            mode: 'multicast',
            groupRef: ROOM,
            recipientPeerIds: ['b', 'd'],
            snapshotVersion: 2
        }
    };

    await fixture.service.acceptIncomingMessage(handedOver, 'a');

    await expect.poll(async () => {
        await fixture.engine.executeOnce();
        return readReceipts(fixture.sockets.a).map((receipt) => receipt.expectedRecipientPeerIds);
    }).toEqual([['b', 'd']]);
});
```

Run it: FAIL (the aggregate narrows to `['b']`). In `ws-queue-box-server-receipt-aggregation.ts` import
`resolveALFrozenMulticastAudience` from `../../al-contracts/al-frozen-multicast-audience.ts` and add to
`toFrozenAudience`, after the unicast branch:

```ts
const frozen = resolveALFrozenMulticastAudience(targets);
if (frozen !== undefined) {
    return frozen.recipientPeerIds.filter((peerId) => peerId !== originPeerId);
}
```

and extend its doc comment: "A multicast the origin froze (an RTC leg handed to WS) keeps that audience verbatim,
so a session that left since reads unconfirmed (Q12); delivery stays the authorized sessions, so the expected set may
exceed the delivered set by design." In the same step amend the invariant that aggregate now departs from
(R-S3c-i-11): in `packages/shared/al-contracts/al-frozen-multicast-audience.ts` replace the doc comment of
`resolveALAdmittedRoomAudience` (`:50-56`) with:

```ts
/**
 * The sessions an admission stamps as a room message's delivery audience: every authorized session, narrowed to a
 * multicast's frozen recipients when it carries them. A frozen audience can narrow, never widen, whom the message is
 * delivered to. The WS server's receipt aggregate is the one reader that may expect more: it keeps a frozen audience
 * verbatim, so a frozen recipient the authority no longer admits reads unconfirmed (S3c-i C11). The origin stays in
 * it, as it does in an unfrozen audience, so a narrowed audience is never empty: every consumer already excludes the
 * origin, and the handling policy reads an empty member set as unrestricted.
 */
```

Run the addressed receipts file and `ws-queue-box-server-receipt-aggregation.test.ts`: PASS. D66's "the WS server
narrows its current room to the frozen set" is amended by this; Task 6 records it.

- [ ] **Step 8: The sink on the server and the admin route.** In
      `packages/shared-server/rallar-system/middleware/rallar-middleware-construction.ts` add to
      `CreateRallarMiddlewareOptions` after `wsInboundDiagnostics`:

```ts
/** The WS server's settlement sink; absent, the server's own receipts are settled but observed by nobody. */
readonly wsOutboundSettlements?: ALDeliverySettlementSink;
```

(import `ALDeliverySettlementSink` from `@shared/alm/delivery/al-delivery-lifecycle.ts`), and in
`create-rallar-middleware-infrastructure.ts:44` replace `outboundSettlements: undefined,` with
`outboundSettlements: options.wsOutboundSettlements,`.

In `packages/shared-server/rallar-system/admin-operations/read-admin-realtime.ts` add to `ReadAdminRealtime.Options`
`readonly readAlmReceipts: () => AdminOperationsAlmReceiptDiagnostics;` (import the type from
`@shared/api/admin-operations-types.ts`) and to the response after `groupFormation`:

```ts
almReceipts: {
    diagnostics: this.options.readAlmReceipts(),
    processLocal: true
}
```

In `packages/tests/shared-server/rallar-system/admin-operations/read-admin-realtime.test.ts` add
`readAlmReceipts: () => ({ capacity: 256, messages: [] }),` to the options and
`almReceipts: { diagnostics: { capacity: 256, messages: [] }, processLocal: true }` to the expected object.

In `apps/api-v1/src/admin-operations/create-api-v1-admin-operation-use-cases.ts` add to
`CreateApiV1AdminOperationUseCasesInput`
`readonly readAlmReceipts: RallarAlmReceiptDiagnosticsRecorder['readDiagnostics'];` (import the type from
`@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts`) and `readAlmReceipts: input.readAlmReceipts`
to the `ReadAdminRealtime` options. In `apps/api-v1/test/composition/create-api-v1-admin-services.test.ts:118` add
`readAlmReceipts: () => ({ capacity: 256, messages: [] }),`.

In `apps/api-v1/src/composition/api-v1-runtime.ts` add `readonly almReceiptDiagnostics: RallarAlmReceiptDiagnosticsRecorder;`
to `ApiV1Runtime` and to `RequireApiV1RuntimeInput`, and `almReceiptDiagnostics: input.almReceiptDiagnostics,` to the
object `requireApiV1Runtime` returns. In `apps/api-v1/src/composition/create-api-v1-runtime.ts`:

- add `readonly almReceiptDiagnostics: RallarAlmReceiptDiagnosticsRecorder;` to `CreateSharedMiddlewareInput`;
- in `constructApiV1Runtime`, after `const startupGeneration = ...`:

```ts
const almReceiptDiagnostics = createRallarAlmReceiptDiagnosticsRecorder({
    nowEpochMs: input.nowEpochMs,
    capacity: RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY
});
```

- pass `almReceiptDiagnostics,` in the `operations.createMiddleware({ ... })` input and in the
  `operations.requireRuntime({ ... })` input;
- in `createSharedMiddleware`, after `wsOutboundDiagnostics: mutation.groupFormationMetrics.outboundWork,`:
  `wsOutboundSettlements: input.almReceiptDiagnostics.settlements,`.

In `apps/api-v1/src/composition/create-default-rallar-server.ts` (`createDefaultApiV1AdminServices`, `:224-231`) add
`readAlmReceipts: runtime.almReceiptDiagnostics.readDiagnostics,` after `resetGroupFormationMetrics`.

In `apps/api-v1/test/composition/api-v1-runtime.test.ts` add `readonly almReceiptDiagnostics: RallarAlmReceiptDiagnosticsRecorder;`
to `RuntimeAdditions`,
`almReceiptDiagnostics: createRallarAlmReceiptDiagnosticsRecorder({ nowEpochMs: Date.now, capacity: RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY }),`
to `createRuntimeAdditions`, and `assert.equal(complete.almReceiptDiagnostics, additions.almReceiptDiagnostics);`
after the `groupFormationMetrics` assertion.

In `apps/api-v1/resources/api-v1-openapi.yaml`, in `AdminOperationsRealtimeResponse` (`:3675-3688`), add
`required: [almReceipts]` to its inline `type: object` member (beside `properties`; the existing properties stay
optional, and the TS type requires `almReceipts`, R-S3c-i-25), and add to its properties after `groupFormation`:

```yaml
almReceipts:
  type: object
  required: [diagnostics, processLocal]
  properties:
    processLocal:
      type: boolean
    diagnostics:
      $ref: '#/components/schemas/AdminOperationsAlmReceiptDiagnostics'
```

and after that schema:

```yaml
AdminOperationsAlmReceiptDiagnostics:
  type: object
  required: [capacity, messages]
  properties:
    capacity:
      type: integer
      description: The most messages this process lists; the least recently updated leaves first.
    messages:
      type: array
      items:
        $ref: '#/components/schemas/AdminOperationsAlmReceiptEntry'

AdminOperationsAlmReceiptEntry:
  type: object
  required: [msgId, mode, confirmedPeerIds, unconfirmedPeerIds, lastSettlementKind, receiptExhausted, updatedAtEpochMs]
  properties:
    msgId:
      type: string
    mode:
      type: string
      enum: [hop, subtree, receiver]
    confirmedPeerIds:
      type: array
      items:
        type: string
    unconfirmedPeerIds:
      type: array
      items:
        type: string
    lastSettlementKind:
      type: string
      description: The kind of the message's last settlement (`ALDeliverySettlement['kind']`).
      enum:
        - admission
        - carrier-refused
        - carrier-fallback
        - attempts-exhausted
        - attempt-started
        - attempt-settled
        - acknowledgement
        - receipt-exhausted
        - not-yet-in-sync-exhausted
        - relay-rejected
        - expired
        - superseded
        - cancelled
    receiptExhausted:
      type: boolean
    updatedAtEpochMs:
      type: integer
```

In `packages/shared-test/black-box-runner/tests/api-v1/api-v1-admin-operations.json` insert after `readAdminOverview`:

```json
{
  "name": "readAdminRealtimeListsTheServerReceipts",
  "type": "http",
  "connection": "api",
  "request": {
    "method": "GET",
    "path": "/api/admin/operations/realtime",
    "headers": {
      "Authorization": "{adminAuthHeader}",
      "x-client-id": "{adminClientId}"
    }
  },
  "expect": {
    "status": 200,
    "body": {
      "serverId": "string",
      "almReceipts": {
        "processLocal": true,
        "diagnostics": {
          "capacity": 256
        }
      }
    }
  }
},
```

Run: `npx vitest run packages/tests/shared-server/rallar-system/admin-operations packages/tests/shared-server/rallar-system/observability`;
`cd apps/api-v1 && deno task check && deno test --allow-env --allow-read test/composition test/admin-operations`;
`cd apps/relic-hunter-server-v1 && deno task check`; the strict preflight on `api-v1-admin-operations.json` (its debt
stays 4); unsandboxed `npm run test:api-v1:black-box:memory`. Expected: PASS, summary lines verified.

- [ ] **Step 9: Validate.** The per-task set (Global Constraints) with both apps' Deno checks and `npm run test:deno`.
      No browser file changes in this task beyond types the browser does not import; run the bundle tests anyway and
      record "unchanged" or the figure.

- [ ] **Step 10: Commit and push.**

```bash
git add packages/shared/alm/outbound/admission/al-outbound-admission-store.ts packages/shared/al-contracts/al-frozen-multicast-audience.ts packages/shared/services/ws-queue-box-server packages/shared/api/admin-operations-types.ts packages/shared-server/rallar-system apps/api-v1/src apps/api-v1/resources/api-v1-openapi.yaml apps/api-v1/test packages/tests/shared packages/tests/shared-server packages/shared-test/black-box-runner/tests/api-v1/api-v1-admin-operations.json
git commit -m "feat(alm): S3c-i -- server notifications carry receipts over the frozen room, both cluster sends honour it, the sink reports per-session confirmation (D58, D61, Q7, Q8, Q12)"
git push
```

### Task 5: The Relic cutover (D57 as applied, D72, D77, D61)

**Files:**

- Create: `apps/relic-hunter-server-v1/src/to-relic-snapshot-message.ts`,
  `apps/relic-hunter-server-v1/src/apply-relic-ws-command.ts`,
  `apps/relic-hunters-v1/src/game/send-relic-ws-command.ts`, `apps/relic-hunters-v1/src/game/to-relic-command-phase.ts`,
  `apps/relic-hunters-v1/src/game/relic-command-delivery-row.tsx`.
- Modify: `apps/relic-hunter-server-v1/src/relic-game-service.ts`, `apps/relic-hunter-server-v1/src/main.ts:60-69`,
  `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts`, `apps/relic-hunters-v1/src/game/useRelicHunters.ts`
  (review tier: the `sendCommand` try block and one import only), `apps/relic-hunters-v1/src/App.tsx:1583` (one
  import and one element line),
  `tests/playwright/relic-hunters/web.spec.ts` (the browser WebSocket double and the mocked backend).
- Test: modify `apps/relic-hunter-server-v1/test/relic-server-service.test.ts`,
  `apps/relic-hunter-server-v1/test/relic-server-browser-contract.test.ts`,
  `apps/relic-hunters-v1/tests/relic-hunters-runtime.test.ts:81-107,195-230`; create
  `apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts`, `apps/relic-hunters-v1/tests/to-relic-command-phase.test.ts`.

**Interfaces:**

- Consumes `RallarServerWsRouter.serverPeerId` (Task 2) and the router's frozen `outbox` publish (Task 4) on the server;
  `rallar.serverPeerId()` (Task 2) and `sendWs(payload, { peerId })` (Task 3) in the browser.
- Produces `RelicHunterGameServiceOptions.readSessionUsername: (sessionId: string) => Promise<string | undefined>` and
  `RelicHunterServer.ws.serverPeerId: string`.
- Produces `RELIC_SNAPSHOT_TTL_MS = 15_000` and `toRelicSnapshotMessage(state: RelicGameState, serverPeerId: string): ALMessage`.
- Produces `applyRelicWsCommand(input: ApplyRelicWsCommandInput): Promise<RelicWsCommandOutcome>` with
  `RelicWsCommandOutcome = applied | no-session | not-applied`.
- Produces `RELIC_COMMAND_RECEIPT_WAIT_MS = 30_000`, `RelicWsCommandDelivery { state: ALDeliveryState; reason: string | undefined }`,
  `sendRelicWsCommand(facade: Pick<RallarFacade, 'serverPeerId' | 'messages'>, roomId: string, command: RelicCommand): Promise<RelicWsCommandDelivery | undefined>`.
- Produces `RelicCommandTransport = 'ws' | 'rest'`, `RelicCommandOutcome`, `RelicHuntersRuntime.sendCommand(...): Promise<RelicCommandOutcome>`,
  the deps `sendWsCommand` and `sendRestCommand` (the old `sendCommand` dep renamed), and
  `RelicRuntimeDiagnostics.lastCommandDelivery?: ALDeliveryState` (absent: no WS command yet).
- Produces `toRelicCommandPhase(outcome: RelicCommandOutcome, snapshotReady: boolean): RelicCommandPhase`.

- [ ] **Step 1: RED — the server.** In `apps/relic-hunter-server-v1/test/relic-server-service.test.ts`:

  - add the imports `import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';`;
  - replace `TEST_GAME_SERVICE_OPTIONS` with:

```ts
const SESSION_USERNAMES: Readonly<Record<string, string>> = {
    'alice-session': 'Alice',
    'bob-session': 'Bob'
};

const TEST_GAME_SERVICE_OPTIONS = {
    createInitialState: (gameId: string) => Promise.resolve(createRelicGame(gameId, gameId, 1)),
    readSessionUsername: (sessionId: string) => Promise.resolve(SESSION_USERNAMES[sessionId])
};
```

- add `readSessionUsername: TEST_GAME_SERVICE_OPTIONS.readSessionUsername,` to the inline options of
  "uses the centralized async initializer ...";
- widen `PublishedMessage.message` with `id: Readonly<{ senderId: string; }>;`,
  `targets?: Readonly<{ mode: string; scope?: string; groupRef?: Readonly<{ applicationId: string; workspaceId?: string; groupId: string; }>; }>;`,
  `delivery?: Readonly<{ reliability?: string; ack?: string; }>;` and `constraints?: Readonly<{ expiresAtMs?: number; }>;`;
- add `serverPeerId: 'relic-server',` to the fake's `ws` object;
- replace the test "persists command results and publishes live snapshots" with:

```ts
it('persists command results and publishes snapshots from the server through the outbox with receipts (D58, D77)', async () => {
    const fake = createFakeRallar();
    const service = await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

    const snapshot = await service.applyCommand(joinCommand('room-1'), 'alice-session');

    expect(snapshot.players[0]).toMatchObject({
        playerId: 'alice-session',
        username: 'Alice',
        characterId: 'nyra-vale'
    });
    expect(fake.store.get('room-1')?.players).toHaveLength(1);
    expect(fake.published).toHaveLength(1);
    expect(fake.published[0]).toMatchObject({
        fanout: 'outbox',
        message: {
            id: { senderId: 'relic-server' },
            route: { topicId: RELIC_TOPICS.snapshot, contextId: 'room-1', resourceId: 'room-1:1' },
            payload: { typeId: RELIC_TYPES.snapshot },
            targets: {
                mode: 'broadcast',
                scope: 'room',
                groupRef: {
                    applicationId: DEFAULT_STATE_APPLICATION_ID,
                    workspaceId: DEFAULT_STATE_WORKSPACE_ID,
                    groupId: 'room-1'
                }
            },
            delivery: { reliability: 'at-least-once', ack: 'receiver' }
        }
    });
    expect(fake.published[0].message.constraints?.expiresAtMs).toBeGreaterThan(Date.now());
    expect(JSON.parse(fake.published[0].message.payload.resource).snapshot.players[0].playerId)
        .toBe('alice-session');
});
```

- add after "handles WebSocket commands through the registered command handler":

```ts
it('applies a WebSocket command under its sender\'s session username, never the one it carries (Q6)', async () => {
    const fake = createFakeRallar();
    await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

    await fake.commandHandler?.({ payload: { ...joinCommand('room-1'), username: 'Mallory' } }, {
        senderId: 'alice-session'
    });

    expect(fake.store.get('room-1')?.players[0]).toMatchObject({
        playerId: 'alice-session',
        username: 'Alice'
    });
});

it('ends a WebSocket command that breaks a rule as a value: nothing is thrown into an inbox retry (Q6, C12)', async () => {
    const fake = createFakeRallar();
    await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

    await expect(
        fake.commandHandler?.({ payload: continueReview('room-1') }, { senderId: 'alice-session' })
    )
        .resolves.toBeUndefined();

    expect(fake.published).toHaveLength(0);
});

it('drops a WebSocket command whose sender has no issued session', async () => {
    const fake = createFakeRallar();
    await installRelicHunterGame(fake.rallar, TEST_GAME_SERVICE_OPTIONS);

    await fake.commandHandler?.({ payload: joinCommand('room-1') }, { senderId: 'ghost-session' });

    expect(fake.store.get('room-1')).toBeUndefined();
    expect(fake.published).toHaveLength(0);
});
```

    with, beside `joinCommand`:

```ts
function continueReview(gameId: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'continue-review',
        gameId,
        username: 'Alice'
    };
}
```

In `apps/relic-hunter-server-v1/test/relic-server-browser-contract.test.ts` add
`readSessionUsername: (sessionId: string) => Promise.resolve(sessionId === 'alice-session' ? 'Alice' : undefined)`
to the options and `serverPeerId: 'relic-server',` to the fake's `ws` object.

Run: `cd apps/relic-hunter-server-v1 && deno test --allow-env --allow-read test/`
Expected: FAIL — the snapshot is `live-only` from `relic-hunter-server` with no room and no receipt, the payload's
`Mallory` is applied, and the rule error rejects the handler.

- [ ] **Step 2: GREEN — the server.** Create `apps/relic-hunter-server-v1/src/to-relic-snapshot-message.ts`:

```ts
import {
    RELIC_TOPICS,
    RELIC_TYPES,
    toPublicRelicSnapshot,
    type RelicGameState,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import {
    DEFAULT_STATE_APPLICATION_ID,
    DEFAULT_STATE_WORKSPACE_ID
} from '@shared/api/state-types.ts';

/** How long a snapshot stays deliverable: the 15 s it had before it carried receipts (Q7). */
export const RELIC_SNAPSHOT_TTL_MS = 15_000;

/**
 * A snapshot is the server's own room notification (D58, D77): the server peer id is its sender, so every receiver's
 * ACK reaches the server's receipt row, and it names the room Relic's REST routes read (C14).
 */
export function toRelicSnapshotMessage(state: RelicGameState, serverPeerId: string): ALMessage {
    const snapshot = toPublicRelicSnapshot(state);
    const event: RelicServerEvent = {
        protocolVersion: snapshot.protocolVersion,
        gameId: snapshot.gameId,
        snapshot
    };
    return newALBroadcastMessage(
        serverPeerId,
        newALRoute(RELIC_TOPICS.snapshot, state.roomId, `${state.gameId}:${state.round}`),
        'room',
        RELIC_TYPES.snapshot,
        event,
        {
            groupRef: {
                applicationId: DEFAULT_STATE_APPLICATION_ID,
                workspaceId: DEFAULT_STATE_WORKSPACE_ID,
                groupId: state.roomId
            },
            reliability: 'at-least-once',
            ack: 'receiver',
            ttlMs: RELIC_SNAPSHOT_TTL_MS
        }
    );
}
```

Create `apps/relic-hunter-server-v1/src/apply-relic-ws-command.ts`:

```ts
import type { RelicCommand, RelicPublicSnapshot } from '@relic-hunters/mod.ts';

export interface ApplyRelicWsCommandInput {
    readonly command: RelicCommand;
    readonly senderId: string;
    readonly readSessionUsername: (sessionId: string) => Promise<string | undefined>;
    readonly applyCommand: (
        command: RelicCommand,
        senderId: string
    ) => Promise<RelicPublicSnapshot>;
}

export type RelicWsCommandOutcome =
    | Readonly<{ kind: 'applied'; snapshot: RelicPublicSnapshot; }>
    | Readonly<{ kind: 'no-session'; detail: string; }>
    | Readonly<{ kind: 'not-applied'; detail: string; }>;

/**
 * A WS command is applied under its sender's session username, never the one it carries (Q6). The server already
 * acknowledged it at admission, so a rule error or a storage failure ends here as a value: rethrown, it would retry the
 * inbox entry into the same error (C12). No client sees the detail until a reply channel exists (I1).
 */
export async function applyRelicWsCommand(
    input: ApplyRelicWsCommandInput
): Promise<RelicWsCommandOutcome> {
    const username = await input.readSessionUsername(input.senderId);
    if (username === undefined) {
        return { kind: 'no-session', detail: `No issued session ${input.senderId}.` };
    }
    try {
        return {
            kind: 'applied',
            snapshot: await input.applyCommand({ ...input.command, username }, input.senderId)
        };
    }
    catch (error) {
        return {
            kind: 'not-applied',
            detail: error instanceof Error ? error.message : String(error)
        };
    }
}
```

In `apps/relic-hunter-server-v1/src/relic-game-service.ts`:

- add to `RelicHunterGameServiceOptions`:

```ts
/**
 * The username of an issued session, read from the auth store: a WS command's own username is never trusted (Q6).
 * The store also returns expired and logged-out sessions; the sender's open WS connection is what authenticated it.
 */
readonly readSessionUsername: (sessionId: string) => Promise<string | undefined>;
```

- add as the first member of `RelicHunterServer.ws`:

```ts
/** The WS server's peer id: every snapshot's sender, so receivers' ACKs reach its receipt (D58). */
serverPeerId: string;
```

- replace `publishSnapshot` (`:95-121`) with:

```ts
async function publishSnapshot(state: RelicGameState): Promise<void> {
    await rallar.ws.publish(toRelicSnapshotMessage(state, rallar.ws.serverPeerId), 'outbox');
}
```

- replace the comment above `defineTopic` (`:137-138`) with
  `// Browsers send commands to the server itself on this topic (D57); REST carries them only before a browser learns the server id.`
  and the handler (`:151-159`) with:

```ts
rallar.ws.on(
    {
        topicId: RELIC_TOPICS.command,
        typeId: RELIC_TYPES.command
    },
    async (message, context) => {
        const outcome = await applyRelicWsCommand({
            command: message.payload,
            senderId: context.senderId,
            readSessionUsername: options.readSessionUsername,
            applyCommand
        });
        if (outcome.kind !== 'applied') {
            console.warn(
                `[relic] WS command from ${context.senderId} was not applied: ${outcome.detail}`
            );
        }
    }
);
```

- import `applyRelicWsCommand` from `./apply-relic-ws-command.ts` and `toRelicSnapshotMessage` from
  `./to-relic-snapshot-message.ts`; drop `newALBroadcastMessage`, `newALRoute` and `RelicServerEvent` from the imports
  (keep `type ALMessage`: the `RelicHunterServer.ws.publish` signature uses it).

In `apps/relic-hunter-server-v1/src/main.ts` (`:60-69`) add to the `installRelicHunterGame` options:

```ts
readSessionUsername: async (sessionId) =>
    (await rallar.runtime.authSessionRepository.findBySessionId(sessionId))?.username,
```

Run: `cd apps/relic-hunter-server-v1 && deno task check && deno test --allow-env --allow-read test/`. Expected: PASS.

- [ ] **Step 3: RED — the browser.** Create `apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts`:

```ts
import {
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicCommand
} from '@ar-eye-hunter/relic-hunters/mod.ts';
import { describe, expect, it, vi } from 'vitest';
import {
    RELIC_COMMAND_RECEIPT_WAIT_MS,
    sendRelicWsCommand
} from '../src/game/send-relic-ws-command.ts';

const COMMAND: RelicCommand = {
    protocolVersion: RELIC_PROTOCOL_VERSION,
    kind: 'start-expedition',
    gameId: 'room-42',
    username: 'Alice'
};

type RelicCommandFacade = Parameters<typeof sendRelicWsCommand>[0];

describe('a Relic command to the server (D57 as applied, D72)', () => {
    it('sends on the command channel to the server peer and reports the end of its receipt', async () => {
        const wait = vi.fn(async () => ({
            status: 'settled',
            lifecycle: { state: 'acknowledged', evidence: { reason: undefined } }
        }));
        const sendWs = vi.fn(async () => ({ wait }));
        const room = vi.fn(() => ({ sendWs }));
        const facade = {
            serverPeerId: () => 'default-qbox-server',
            messages: { room }
        } as unknown as RelicCommandFacade;

        const delivery = await sendRelicWsCommand(facade, 'room-42', COMMAND);

        expect(room).toHaveBeenCalledWith({
            topicId: RELIC_TOPICS.command,
            typeId: RELIC_TYPES.command,
            purpose: 'command',
            roomId: 'room-42'
        });
        expect(sendWs).toHaveBeenCalledWith(COMMAND, { peerId: 'default-qbox-server' });
        expect(wait).toHaveBeenCalledWith({ timeoutMs: RELIC_COMMAND_RECEIPT_WAIT_MS });
        expect(delivery).toEqual({ state: 'acknowledged', reason: undefined });
    });

    it('sends nothing before the server id is known, so the runtime falls back to REST (C13)', async () => {
        const room = vi.fn();
        const facade = {
            serverPeerId: () => undefined,
            messages: { room }
        } as unknown as RelicCommandFacade;

        expect(await sendRelicWsCommand(facade, 'room-42', COMMAND)).toBeUndefined();
        expect(room).not.toHaveBeenCalled();
    });
});
```

Create `apps/relic-hunters-v1/tests/to-relic-command-phase.test.ts`:

```ts
import { createRelicGame, toPublicRelicSnapshot } from '@ar-eye-hunter/relic-hunters/mod.ts';
import { describe, expect, it } from 'vitest';
import { toRelicCommandPhase } from '../src/game/to-relic-command-phase.ts';

describe('what the hunter sees after a command (D57 as applied, D72)', () => {
    it('reads an acknowledged WS command as ready; its snapshot arrives on the snapshot channel', () => {
        expect(
            toRelicCommandPhase({
                transport: 'ws',
                delivery: { state: 'acknowledged', reason: undefined }
            }, true)
        ).toEqual({
            phase: 'ready',
            patch: {
                snapshotReady: true,
                commandTransport: 'ws',
                lastCommandDelivery: 'acknowledged',
                lastError: undefined
            },
            error: undefined
        });
    });

    // A server-addressed command tracks the server as its expected peer, so the server's pre-admission refusal ends
    // that receipt row: the handle reads `failed` with the receipt-exhausted detail, never C3's `rejected` fact.
    it('reads a WS command the server did not confirm as degraded, naming its state and reason', () => {
        const phase = toRelicCommandPhase({
            transport: 'ws',
            delivery: {
                state: 'failed',
                reason: 'Hop default-qbox-server refused the message: unauthorized.'
            }
        }, true);

        expect(phase.phase).toBe('degraded');
        expect(phase.error).toBe(
            'The server did not confirm the command (failed): Hop default-qbox-server refused the message: unauthorized.'
        );
        expect(phase.patch).toMatchObject({
            commandTransport: 'ws',
            lastCommandDelivery: 'failed',
            lastError: phase.error
        });
    });

    it('keeps the REST reply\'s reading while REST is the fallback', () => {
        const snapshot = toPublicRelicSnapshot(
            createRelicGame('room-1', 'room-1', 1_700_000_000_000)
        );

        expect(toRelicCommandPhase({ transport: 'rest', snapshot }, true)).toMatchObject({
            phase: 'ready',
            patch: { commandTransport: 'rest', lastError: undefined },
            error: undefined
        });
        expect(toRelicCommandPhase({ transport: 'rest', snapshot: undefined }, false))
            .toMatchObject({
                phase: 'degraded',
                patch: { lastError: 'No relic snapshot returned for command.' }
            });
    });
});
```

In `apps/relic-hunters-v1/tests/relic-hunters-runtime.test.ts` replace the tests at `:81-107` with:

```ts
it('sends gameplay commands to the server over WS and reports the receipt (D57 as applied)', async () => {
    const deps = runtimeDeps({
        sendWsCommand: vi.fn(async () => ({ state: 'acknowledged' as const, reason: undefined }))
    });
    const runtime = new RelicHuntersRuntime(deps);

    const outcome = await runtime.sendCommand(session(), 'room-42', { kind: 'start-expedition' });

    expect(deps.sendWsCommand).toHaveBeenCalledWith('room-42', {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        gameId: 'room-42',
        username: 'Alice',
        kind: 'start-expedition'
    });
    expect(deps.sendRestCommand).not.toHaveBeenCalled();
    expect(outcome).toEqual({
        transport: 'ws',
        delivery: { state: 'acknowledged', reason: undefined }
    });
});

it('falls back to REST only while no WS server id is known (C13)', async () => {
    const deps = runtimeDeps();
    const runtime = new RelicHuntersRuntime(deps);

    const outcome = await runtime.sendCommand(session(), 'room-42', {
        kind: 'force-resolve-round'
    });

    expect(deps.sendRestCommand).toHaveBeenCalledWith('room-42', {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        gameId: 'room-42',
        username: 'Alice',
        kind: 'force-resolve-round'
    });
    expect(outcome).toMatchObject({ transport: 'rest' });
});
```

and in `runtimeDeps` replace `sendCommand: vi.fn(async () => ...)` with:

```ts
sendWsCommand: vi.fn(async () => undefined),
sendRestCommand: vi.fn(async () => toPublicRelicSnapshot(createRelicGame('game-1', 'room-1', 1_700_000_000_000))),
```

Run: `npm --workspace relic-hunters-v1 run test -- tests/send-relic-ws-command.test.ts tests/to-relic-command-phase.test.ts tests/relic-hunters-runtime.test.ts`
Expected: FAIL — the two modules do not exist and the runtime has no `sendWsCommand`.

- [ ] **Step 4: GREEN — the browser.** Create `apps/relic-hunters-v1/src/game/send-relic-ws-command.ts`:

```ts
import { RELIC_TOPICS, RELIC_TYPES, type RelicCommand } from '@relic-hunters/mod.ts';
import type { ALDeliveryState, RallarFacade } from '@shared-web/browser/rallar.ts';

/** How long a command waits for the server's receipt: the `command` purpose's 30 s deadline (D52). */
export const RELIC_COMMAND_RECEIPT_WAIT_MS = 30_000;

export interface RelicWsCommandDelivery {
    readonly state: ALDeliveryState;
    /** Why the receipt ended unconfirmed; undefined once acknowledged or while it is still open. */
    readonly reason: string | undefined;
}

/**
 * A Relic command to the server itself on the `command` channel (D57 as applied): a unicast to the WS server's peer id,
 * receipted by the server's own ACK once it admits the command. Undefined when no server id is known yet, so the
 * runtime sends over REST instead (Q6, C13).
 */
export async function sendRelicWsCommand(
    facade: Pick<RallarFacade, 'serverPeerId' | 'messages'>,
    roomId: string,
    command: RelicCommand
): Promise<RelicWsCommandDelivery | undefined> {
    const serverPeerId = facade.serverPeerId();
    if (serverPeerId === undefined) {
        return undefined;
    }
    const handle = await facade.messages
        .room<RelicCommand>({
            topicId: RELIC_TOPICS.command,
            typeId: RELIC_TYPES.command,
            purpose: 'command',
            roomId
        })
        .sendWs(command, { peerId: serverPeerId });
    const outcome = await handle.wait({ timeoutMs: RELIC_COMMAND_RECEIPT_WAIT_MS });
    return { state: outcome.lifecycle.state, reason: outcome.lifecycle.evidence.reason };
}
```

In `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts`:

- replace `export const RELIC_COMMAND_TRANSPORT = 'rest' as const;` (`:28`) with:

```ts
export type RelicCommandTransport = 'ws' | 'rest';

/** A command's end as the UI reads it: the WS receipt, or the REST reply's snapshot while REST is the fallback (Q6). */
export type RelicCommandOutcome =
    | Readonly<{ transport: 'ws'; delivery: RelicWsCommandDelivery; }>
    | Readonly<{ transport: 'rest'; snapshot: RelicPublicSnapshot | undefined; }>;
```

- in `RelicRuntimeDiagnostics` replace `commandTransport: typeof RELIC_COMMAND_TRANSPORT;` with
  `commandTransport: RelicCommandTransport;` and add `lastCommandDelivery?: ALDeliveryState;` after it;
- in `RelicHuntersRuntimeDeps` replace `sendCommand(roomId: string, command: RelicCommand): Promise<RelicPublicSnapshot | undefined>;` with:

```ts
sendWsCommand(roomId: string, command: RelicCommand): Promise<RelicWsCommandDelivery | undefined>;
sendRestCommand(roomId: string, command: RelicCommand): Promise<RelicPublicSnapshot | undefined>;
```

- replace `sendCommand` (`:280-295`) with:

```ts
async sendCommand(
    session: AuthSession,
    roomId: string,
    input: RelicCommandDraft
): Promise<RelicCommandOutcome> {
    // The server applies a WS command under the sender's session username (Q6); REST carries it only before the
    // browser learns the WS server id, never after a WS attempt, which could apply it twice (C13).
    const command = {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        gameId: roomId,
        username: session.username,
        ...input
    } as RelicCommand;
    const delivery = await this.deps.sendWsCommand(roomId, command);
    return delivery === undefined
        ? { transport: 'rest', snapshot: await this.deps.sendRestCommand(roomId, command) }
        : { transport: 'ws', delivery };
}
```

- in `initialRelicDiagnostics` replace `commandTransport: RELIC_COMMAND_TRANSPORT,` with `commandTransport: 'ws',` and
  add `lastCommandDelivery: undefined,` after it;
- in `browserRelicRuntimeDeps` replace `sendCommand: (roomId, command) => sendRelicCommand(roomId, command),` with:

```ts
sendWsCommand: (roomId, command) => sendRelicWsCommand(rallar, roomId, command),
sendRestCommand: (roomId, command) => sendRelicCommand(roomId, command),
```

- add `type ALDeliveryState` to the `@shared-web/browser/rallar.ts` import and
  `import { sendRelicWsCommand, type RelicWsCommandDelivery } from './send-relic-ws-command.ts';`.

Create `apps/relic-hunters-v1/src/game/to-relic-command-phase.ts`:

```ts
import type {
    RelicCommandOutcome,
    RelicHuntersRuntimePhase,
    RelicRuntimeDiagnostics
} from './relic-hunters-runtime.ts';

export interface RelicCommandPhase {
    readonly phase: RelicHuntersRuntimePhase;
    readonly patch: Partial<RelicRuntimeDiagnostics>;
    /** The text the hunter sees; undefined when the command landed. */
    readonly error: string | undefined;
}

/**
 * What the UI shows after a command: a WS receipt says the server admitted it, and the applied snapshot arrives on the
 * snapshot channel (D57 as applied); a REST reply carries its snapshot. A rule error the server met is not shown
 * after a WS command until a reply channel exists — the stated regression (D72).
 */
export function toRelicCommandPhase(
    outcome: RelicCommandOutcome,
    snapshotReady: boolean
): RelicCommandPhase {
    if (outcome.transport === 'rest') {
        return {
            phase: snapshotReady ? 'ready' : 'degraded',
            patch: {
                snapshotReady,
                commandTransport: 'rest',
                lastCommandDelivery: undefined,
                lastError: outcome.snapshot ? undefined : 'No relic snapshot returned for command.'
            },
            error: undefined
        };
    }
    const { state, reason } = outcome.delivery;
    const unconfirmed = `The server did not confirm the command (${state})`;
    const error = state === 'acknowledged'
        ? undefined
        : reason === undefined
        ? `${unconfirmed}.`
        : `${unconfirmed}: ${reason}`;
    return {
        phase: error === undefined && snapshotReady ? 'ready' : 'degraded',
        patch: {
            snapshotReady,
            commandTransport: 'ws',
            lastCommandDelivery: state,
            lastError: error
        },
        error
    };
}
```

In `apps/relic-hunters-v1/src/game/useRelicHunters.ts` (review tier: call lines only) add
`import { toRelicCommandPhase } from './to-relic-command-phase.ts';` and replace, inside `sendCommand`'s `try`, the
block from `const next = await runtime.sendCommand(...)` to the closing `});` of its `setPhase(...)` with:

```ts
const outcome = await runtime.sendCommand(currentSession, currentRoomId, input);
if (outcome.transport === 'rest' && outcome.snapshot) {
    acceptSnapshotCandidate(outcome.snapshot, 'rest-command', currentRoomId);
}
const commandPhase = toRelicCommandPhase(outcome, !!snapshotRef.current);
if (commandPhase.error) {
    setError(commandPhase.error);
}
setPhase(commandPhase.phase, { ...commandPhase.patch, lastHydratedAtEpochMs: Date.now() });
```

The `catch` keeps its "There is no review to continue" branch: it serves the REST fallback; after a WS command the
rule-error text never reaches the browser (D72's stated regression).

Create `apps/relic-hunters-v1/src/game/relic-command-delivery-row.tsx` (the row owns its absence check, so
`App.tsx` — cognitive load 776, above the refactor-or-register tier and unregistered — gains one import and one
element line and no new branch, R-S3c-i-2):

```tsx
import type { ALDeliveryState } from '@shared-web/browser/rallar.ts';

/** The last WS command's receipt state in the diagnostics panel; nothing before the first WS command (D72). */
export function RelicCommandDeliveryRow({
    delivery
}: Readonly<{ delivery: ALDeliveryState | undefined; }>) {
    return delivery === undefined ? null : <small>Last command {delivery}</small>;
}
```

In `apps/relic-hunters-v1/src/App.tsx` add `import { RelicCommandDeliveryRow } from './game/relic-command-delivery-row.tsx';`
after the `./game/relic-hunters-runtime.ts` type import, and after `:1583`
(`<small>Commands {diagnostics.commandTransport.toUpperCase()}</small>`) add:

```tsx
<RelicCommandDeliveryRow delivery={diagnostics.lastCommandDelivery} />;
```

Run the Step 3 command, then `npm --workspace relic-hunters-v1 run test` and
`npm --workspace relic-hunters-v1 run typecheck`. Expected: PASS.

- [ ] **Step 5: The Relic browser spec answers commands over its WebSocket double.** In
      `tests/playwright/relic-hunters/web.spec.ts`:

  - add the imports `import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';` and
    `import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';` (the `@shared` alias resolves at
    runtime in Playwright, as `tests/playwright/rallar-black-box/tabbed-navigation.spec.ts:7` already relies on), so the
    double builds its frames with the production constructors instead of copying their envelopes (R-S3c-i-22);
  - add after the imports `const MOCK_SERVER_PEER_ID = 'default-qbox-server';` and use it for the `serverPeerId` Task 2
    put in the mocked `/api/config`;
  - in `installBrowserDoubles`' `FakeWebSocket`, replace `send` with:

```ts
send(data: unknown): void {
    const target = window as unknown as {
        __rallarWsOutbox?: unknown[];
        __rallarWsReply?: (frame: string) => Promise<readonly string[]>;
    };
    target.__rallarWsOutbox ??= [];
    target.__rallarWsOutbox.push(data);
    void target.__rallarWsReply?.(String(data)).then((frames) => {
        for (const frame of frames) {
            const event = new MessageEvent('message', { data: frame });
            this.dispatchEvent(event);
            this.onmessage?.(event);
        }
    });
}
```

- in `mockBackend`, before its `page.route(...)`, extract the REST command branch's snapshot choice into

```ts
const nextCommandSnapshot = (commandBody: unknown): RelicSnapshot => {
    const next = options.commandResponse?.(commandBody) ??
        options.commandSnapshots?.[commandSnapshotIndex] ??
        options.commandSnapshot ??
        relicSnapshotWithPlayers(1);
    commandSnapshotIndex += 1;
    return next;
};

// The server's side of a WS command: its own ACK, then the applied snapshot on the snapshot channel (D57, D58).
await page.exposeFunction('__rallarWsReply', (frame: string): readonly string[] => {
    const message = JSON.parse(frame) as MockWsFrame;
    if (
        message.payload?.typeId !== 'relic.command.v1' ||
        message.targets?.toPeerId !== MOCK_SERVER_PEER_ID
    ) {
        return [];
    }
    const commandBody: unknown = JSON.parse(message.payload.resource);
    options.commandBodies?.push(commandBody);
    currentRelicSnapshot = nextCommandSnapshot(commandBody);
    return [toServerAckFrame(message), toSnapshotFrame(currentRelicSnapshot)];
});
```

    make the REST branch (`:1132-1140`) push the body and `currentRelicSnapshot = nextCommandSnapshot(commandBody);`,
    and add beside `mockBackend`:

```ts
type MockWsFrame = Readonly<{
    id: Readonly<{ msgId: string; senderId: string; }>;
    targets?: Readonly<{ toPeerId?: string; }>;
    payload?: Readonly<{ typeId: string; resource: string; }>;
}>;

/** The server's own ACK, built by the AL control codec's own constructor, as the server builds it. */
function toServerAckFrame(command: MockWsFrame): string {
    return JSON.stringify(newALAckControlMessage(
        { v: 2, msgId: `ack-${command.id.msgId}`, ts: Date.now(), senderId: MOCK_SERVER_PEER_ID },
        {
            ackedMsgId: command.id.msgId,
            fromPeerId: MOCK_SERVER_PEER_ID,
            toPeerId: command.id.senderId,
            originPeerId: command.id.senderId,
            logicalRecipientPeerId: MOCK_SERVER_PEER_ID,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    ));
}

/** The applied snapshot as the Relic server publishes it (`toRelicSnapshotMessage`): `receiver`, at-least-once. */
function toSnapshotFrame(snapshot: RelicSnapshot): string {
    return JSON.stringify(newALBroadcastMessage(
        MOCK_SERVER_PEER_ID,
        newALRoute('room.relic.snapshot', snapshot.roomId, `${snapshot.gameId}:${snapshot.round}`),
        'room',
        'relic.snapshot.v1',
        { protocolVersion: snapshot.protocolVersion, gameId: snapshot.gameId, snapshot },
        {
            groupRef: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: snapshot.roomId
            },
            reliability: 'at-least-once',
            ack: 'receiver',
            ttlMs: 15_000
        }
    ));
}
```

- in "sends room-scoped relic commands from the browser UI" (`:437`) add, after the `commandBodies` assertions:

```ts
const commandFrames = await page.evaluate(() =>
    ((window as unknown as { __rallarWsOutbox?: unknown[]; }).__rallarWsOutbox ?? [])
        .map((frame) =>
            JSON.parse(String(frame)) as { targets?: unknown; payload?: { typeId?: string; }; }
        )
        .filter((frame) => frame.payload?.typeId === 'relic.command.v1')
        .map((frame) => frame.targets)
);
expect(commandFrames).toEqual([
    {
        mode: 'unicast',
        toPeerId: MOCK_SERVER_PEER_ID,
        groupRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'room-1' }
    },
    {
        mode: 'unicast',
        toPeerId: MOCK_SERVER_PEER_ID,
        groupRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'room-1' }
    }
]);
// Each snapshot frame asks `receiver`, so the page acknowledges it to the server: the snapshot receipt (D58, D77).
await expect.poll(async () =>
    await page.evaluate(
        (serverPeerId) =>
            ((window as unknown as { __rallarWsOutbox?: unknown[]; }).__rallarWsOutbox ?? [])
                .map((frame) =>
                    JSON.parse(String(frame)) as {
                        payload?: { typeId?: string; resource?: string; };
                    }
                )
                .filter((frame) => frame.payload?.typeId === 'al.control.ack.v2')
                .map((frame) =>
                    JSON.parse(frame.payload?.resource ?? '{}') as { toPeerId?: string; }
                )
                .filter((ack) => ack.toPeerId === serverPeerId).length,
        MOCK_SERVER_PEER_ID
    )
).toBe(2);
```

Run unsandboxed: `npm run test:playwright:relic` (it serves the Relic SPA; verify the summary line). Expected: PASS.
No spec pins a rule error's REST text (`grep -n 'no review' tests/playwright/relic-hunters/web.spec.ts` prints
nothing), so D72's stated regression moves no Playwright pin. Both frames use the scope the spec's `groupSnapshot`
declares (`applicationId: 'rallar-server'`, `workspaceId: 'default'`, `:1469-1471`), which is the room the page
resolves. Every spec that clicks a command now sees the server's ACK and the snapshot frame instead of the REST
reply; any that still reads `requests` for `POST /api/relic/games/room-1/commands` is moved to read the WS outbox as
the test above does, and named in the commit body.

- [ ] **Step 6: Validate.** The per-task set with both apps' Deno checks and tests (`npm run test:deno` runs
      `apps/relic-hunter-server-v1` check and test), `npm --workspace relic-hunters-v1 run test`,
      `npm --workspace relic-hunters-v1 run build`, and, unsandboxed, `npm run test:playwright:relic` and
      `npm run test:playwright:relic:full-stack` — the real Relic server (which embeds API-v1) behind the SPA
      (`tests/playwright/relic-hunters/full-stack-propagation.spec.ts`), the only gate on Relic's own `/api/config`
      (Task 2), the WS command and the outbox snapshot outside fakes (R-S3c-i-10); verify both summary lines. Relic's
      REST route and its recipe-free server share are unchanged (C15).

- [ ] **Step 7: Commit and push.**

```bash
git add apps/relic-hunter-server-v1/src apps/relic-hunter-server-v1/test apps/relic-hunters-v1/src apps/relic-hunters-v1/tests tests/playwright/relic-hunters/web.spec.ts
git commit -m "feat(relic): S3c-i -- commands travel the command channel to the server; snapshots travel the outbox with receipts (D57, D72, D77)"
git push
```

### Task 6: Docs, the gates, the PR

**Files:** `packages/shared/alm/outbound/README.md` ("### Server receipts on WS", `:292-322`),
`packages/shared/alm/inbound/README.md` (`:155-170` the WS server rules; its `:262` schema identity moved to Task 1
Step 7 with the bump),
`playground/alm/alm-complete-product-description.md` (`:195-200` "Unicast", `:405-412` the S3a paragraph of
"Acknowledgement modes", `:624-625` "Observability and privacy"), `playground/alm/alm-improvement-plan.md` (rows D46,
D53, D57, D58, D61, D66, D71; the S3 bullet `:809-843`; matrix row F1 `:952`; the revision history),
`playground/alm/alm-s3-design-proposal.md` (§2.3 `:210-231`, the schema-id status line `:416`),
`apps/relic-hunters-v1/docs/runtime-data-flow.md` (`:44-58` "Command Path"),
`apps/relic-hunters-v1/docs/current-state.md:26-28`. Line numbers are on `75d503425`; re-read each anchor before
editing.

- [ ] **Step 1: The outbound README.** In "### Server receipts on WS" delete the sentence "No client learns a server
      id." and replace the paragraph's last sentence ("A `receiver` message addressed to the server itself keeps the
      server's own ACK; `receiver` on a WS unicast is refused `unsupported` (D42) until a slice aggregates unicasts.") with:

```md
Since S3c-i a WS origin knows its server: `/api/config` names it as `serverPeerId`, and the WS client plans against it
([`toWsQueueBoxClientAckTrackingPlan`](../../services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts)).
A unicast addressed to the server, and every `hop` or `subtree` send, expects the server's own ACK: the server is the
one hop a WS origin has (R-S3a-4). A `receiver` unicast that names its room (`targets.groupRef`) is aggregated like a
room send over one member: the router delivers it to its addressee
([`toWsQueueBoxServerInboundPlan`](../../services/ws-queue-box-server/ws-queue-box-server-inbound-plan.ts)), the
`admitted` receipt names the addressee, and the addressee's own ACK completes it. A unicast to a session outside the
room's admitted audience is refused before admission with a NACK
([`toWsQueueBoxServerAddresseeAuthorization`](../../services/ws-queue-box-server/to-ws-queue-box-server-addressee-authorization.ts)),
which the origin states as a trusted-server `relay-rejected` `unauthorized`; a `receiver` unicast that names no room
is refused `unsupported` at admission (D71). A message addressed to the server keeps the server's own ACK and opens no
aggregate (D76). A message carrying a frozen multicast audience — an RTC leg handed to WS — is aggregated over that
audience verbatim, so a session that left since reads unconfirmed (D73).
```

and after the paragraph "In the production outbox fan-out ..." add:

```md
The server's own room notifications carry receipts too (D58, D77). The router freezes an `outbox` room broadcast whose
sender is the server peer id to the room's live sessions at publish
([`readRallarServerWsPublishAudience`](../../../shared-server/rallar-system/websocket/router/read-rallar-server-ws-publish-audience.ts));
the server's pending row expects them, and both cluster sends — the publishing instance's and every other instance's —
narrow to the audience captured in the shared admission store (`readAdmittedAudience`). Every settlement of the
server's outbound owner feeds one bounded in-memory recorder per process
([`createRallarAlmReceiptDiagnosticsRecorder`](../../../shared-server/rallar-system/observability/alm-receipt-diagnostics.ts),
256 messages), read as `almReceipts` on `/api/admin/operations/realtime`: per message the confirmed and unconfirmed
sessions, the last settlement kind and whether the receipt ran out (D61, D73).
```

- [ ] **Step 2: The inbound README.** In the WS server paragraph (`:155-170`), after "A `receiver` message whose
      logical recipient is the server keeps its ACK.", add: "The server receives an authorized room unicast to another
      session itself (D71), so its router delivers it; a unicast to a session outside the room's admitted audience is
      refused before admission." (The schema identity at `:262` was updated with the bump in Task 1 Step 7.)

- [ ] **Step 3: The product description.** Replace "**CURRENT** for basic RTC and WS routing." under "### Unicast"
      with:

```md
**CURRENT** for basic RTC and WS routing. **CURRENT — S3c-i, addressed WS sends:** a unicast may name its room; the
room's authority admits it and the room's router delivers it, and a `receiver` unicast's receipt is its addressee's
own ACK, aggregated by the server over one member (D53, D71). A client addresses the server itself with a unicast to
the server peer id `/api/config` names; the server's own ACK is that receipt, meaning the server admitted the message,
not that the application applied it (D76). The RTC unicast and the unicast fallback are S3c-ii's.
```

In "Acknowledgement modes", after the S3a paragraph ending "... own HTTP/WS catch-up.", add:

```md
**CURRENT — S3c-i, the WS hop receipt:** a WS `hop` or `subtree` send tracks the server as its one hop, so it is
receipted by the server's own ACK and no longer ends at `transport-accepted` with a downgrade (R-S3a-4 closed). The
server's own room notifications carry `receiver` receipts over the room's live sessions frozen at publish, and cluster
delivery honours that audience (D58, D77).
```

In "Observability and privacy" append to the PARTIAL paragraph: "The WS server records, per process and for its 256
most recent receipted messages, who confirmed each receipt and whether it ran out, on
`/api/admin/operations/realtime` (S3c-i, D61, D73)."

- [ ] **Step 4: The roadmap and the proposal.** In `alm-improvement-plan.md` (keep every row's column width; re-pad
      the table cell):
  - D53: append " **As applied (S3c-i, PR #605):** D71 — a room unicast names its room (`targets.groupRef`, schema
    `rallar-alm-2026-09-s3c-i`); a `receiver` unicast that names none is refused `unsupported` at admission.";
  - D57: extend "**As applied (S3c-i):** D70, D76." with " Delivered by PR #605: Relic commands are a unicast to the
    server peer id on `room.relic.command`, receipted at the server's admission; REST is the fallback before the id is
    known (C13).";
  - D58: append " **As applied (S3c-i, PR #605):** D77; the audience is read only for an `outbox` room broadcast the
    server sends (C8).";
  - D61: append " **Delivered by S3c-i (PR #605):** D73's recorder, read as `almReceipts`.";
  - D66: append " **Amended by S3c-i (D73):** the WS server keeps a handed-over message's frozen audience verbatim, so
    a leaver reads unconfirmed.";
  - D71: append " **As applied (S3c-i):** the refusal keys on the unicast naming no room, not on its topic (C2).";
  - D46: append " **Extended by S3c-i (C1)** to the `rallar-alm-2026-09-s3c-i` bump: the server's admission rows holding
    a room-naming unicast stay undecodable to a rolled-back server for their TTL.";
  - F1 (`:952`) state: "Partial: the default typed send is receipted and volatile (S3a, PR #597); every receipt end
    settles and `receipt-exhausted` hands `rtc-with-ws-fallback` to WS (S3b, PR #604); the WS unicast receipt, the WS
    `hop` receipt and the server's own receipts (S3c-i, PR #605); the RTC unicast is S3c-ii's.";
  - the S3 bullet, after the S3b sentence: "S3c-i delivered by PR #605 (branch
    `claude/alm-s3c-consumer-proofs-volatile-bound`): addressed WS sends with a one-member receipt, the server address
    on `/api/config`, the WS hop receipt, server-originated receipts over the frozen room with the cluster audience and
    the settlement recorder, and the Relic cutover; its rulings R-S3c-i-0 onward are in its plan.";
  - revision history: "- 2026-09-DD: S3c-i delivered by PR #605: D53, D57, D58, D61 as applied (D70–D73, D76, D77);
    matrix row F1 moved." with the commit's date.

  In `alm-s3-design-proposal.md` §2.3 add after its last bullet: "**As applied (S3c-i, PR #605):** a room unicast names
  its room (`groupRef`, schema bump — the server target needs no envelope bump, D76); the WS `hop` receipt tracks the
  server; the snapshot sender is the server peer id and the sink a per-process recorder; the typed-channel `peerId`
  target landed WS-only for the Relic cutover (Q11's RTC half is S3c-ii's)." At `:416` append to "`AL_ADMISSION_SCHEMA_ID`
  is still `rallar-alm-2026-09-s2c-ii`." the sentence " S3c-i (PR #605) bumps it to `rallar-alm-2026-09-s3c-i` (C1)."
  (R-S3c-i-24).

- [ ] **Step 5: The Relic docs.** In `apps/relic-hunters-v1/docs/runtime-data-flow.md` replace "## Command Path"
      through "... does not send gameplay commands over that topic." with:

````md
## Command Path

The browser sends gameplay commands to the server itself on the Rallar WS `command` channel (`room.relic.command`, a
unicast to the WS server's peer id from `/api/config`, D57 as applied). The server's own ACK is the command's receipt:
the server admitted it. The server applies it under the sender's session username and publishes the new snapshot
through the outbox with receipts:

```text
command -> WS unicast to the server -> server ACK (receipt) -> applyCommand -> persisted state -> outbox snapshot (receiver) -> WS snapshot subscription
reset -> REST reset endpoint -> persisted new game -> outbox snapshot -> REST response snapshot
```

REST (`POST /api/relic/games/:gameId/commands`) stays for one release: the browser uses it only before it knows the WS
server's peer id, never after a WS attempt. A rule error the server meets on the WS path is logged there and not
shown in the browser until a reply channel exists (D72's stated regression); the UI shows the command's receipt state
and the applied snapshot's arrival.
````

In `current-state.md:26-28` replace "relic REST calls, WS snapshot fanout," with "relic commands on the Rallar WS
`command` channel (REST before the server id is known), WS snapshot fanout with receipts,".

- [ ] **Step 6: Validate the docs.** `npx dprint check <the seven edited files>`, `npm run test:repo-governance`,
      `npm run check:repo-style:changed -- origin/main HEAD`. Commit and push:

```bash
git add packages/shared/alm/outbound/README.md packages/shared/alm/inbound/README.md playground/alm apps/relic-hunters-v1/docs
git commit -m "docs(alm): S3c-i -- addressed sends, the server address and the server's own receipts"
git push
```

- [ ] **Step 7: The push-time gate list.** On the final tree, record passed / failed / skipped for each (grep every
      summary line, never the exit code):
  - `npm run test:unit` (both Vitest roots);
  - `npm run test:deno` (api-v1, the control server, the Relic server check and test);
    `cd apps/api-v1 && deno task check`; `cd apps/rallar-black-box-control-server && deno task check`;
    `cd apps/relic-hunter-server-v1 && deno task check`;
  - `npm run typecheck`; `npm run build`; `npm --workspace relic-hunters-v1 run test`;
  - `npm run check:repo-style:changed -- origin/main HEAD`; `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`;
  - `npm run test:repo-governance`;
  - the public API and both bundle tests, `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`;
  - the strict preflight on `api-v1-websocket-addressed-sends.json` and `api-v1-admin-operations.json`,
    `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts`;
  - unsandboxed: `npm run test:api-v1:black-box:memory`; with the Postgres container up,
    `npm run test:api-v1:black-box:postgres` (both new recipe steps pass on PostgreSQL);
  - unsandboxed: `npm run test:e2e`, `npm run test:full-stack:memory`, `npm run test:playwright:relic`,
    `npm run test:playwright:relic:full-stack` (the real Relic server, R-S3c-i-10), the ALM smoke lane, and the full
    lane two- and three-agent on every carrier on normal pages (S3c-i adds no scenario; every carrier's expectations
    are unchanged except where a moved pin is named);
  - **the medium-scale gate, once (Q13, D76):** unsandboxed, the Postgres container `ar-eye-hunter-postgres` up and
    freshly migrated (`npm run db:test:up` in this worktree; `docker start` it if it stopped), run
    `npm run test:api-v1:black-box:postgres:medium-scale` and record its summary line in this step's notes and the PR
    body. It covers the S3c-i server mutation paths through the WS server (`ws-queue-box-server/**` changed: the inbound
    plan, the addressee authorization, the aggregation, the cluster publication) even though its recipe exercises the
    HTTP group-state churn; a red is diagnosed against `main` before it is blamed on the branch (the perf-gate noise
    floor), never by weakening its constants.

- [ ] **Step 8: The PR and the hosted reads.** Update draft PR #605 (it holds the questions and decisions commits) with
      `gh pr edit 605 --title "ALM S3c-i: addressed sends and server receipts" --body-file <file>` (unsandboxed; the sandbox
      fails `gh` on TLS). Body sections, in the S3b shape: the decisions applied (D70–D73, D76, D77, D57 as applied; Q1–Q13)
      and the R-S3c-i rulings with C1–C16 as ruled; Corrections 21–23; the room unicast and its receipt; the server address
      and the WS hop receipt (the moved R-S3a-4 pins from Task 2 Step 7 and Step 8); the WS peer target (WS only, the RTC
      half S3c-ii's); the server's own receipts, the cluster audience and the recorder; the Relic cutover (what the UI shows;
      D72's stated regression, whose paragraph says that the server log is the only surface for a caught rule or storage
      error and a `no-session` drop — no counter, no recorder entry, and the client reads `acknowledged` (R-S3c-i-20);
      REST as the pre-id fallback and where it is reachable — before connect, and against a server that serves no
      `serverPeerId` (R-S3c-i-6); process-local serialization); **named debt for the maintainer:** Relic's WS command
      writes app data through `AppDataOptimisticWriter.set` outside AppInbox, as the REST route already did — S3c-i
      changes the transport, not the write (R-S3c-i-8); every moved pin by task; the bundle figures from Tasks 1–3; the
      schema bump `rallar-alm-2026-09-s3c-i` and what a deploy discards (every browser's ALM IndexedDB stores reset once;
      PostgreSQL WS admission rows holding a room-naming unicast are undecodable to a rolled-back server for their TTL,
      D46 extended); the deploy order — the server before the browser: a new browser against a server without
      `serverPeerId` runs as "server unknown" (no WS hop receipt, Relic commands over REST) until the server is upgraded
      (R-S3c-i-6); the medium-scale summary line; the gate list from Step 7; the carried
      lists; and, last, the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Hosted: dispatch the
      Hetzner smoke from the PR branch (`gh workflow run hetzner-distributed-recipe.yml --ref claude/alm-s3c-consumer-proofs-volatile-bound -f ref=claude/alm-s3c-consumer-proofs-volatile-bound`,
      never from `main`) on both-normal runners, and the hosted full read with `RALLAR_BLACK_BOX_ALM_SCOPE=full` at most
      twice (D51), reported under the two-regime rule and never a blocker; poll with foreground `gh run list`. Wait for the
      Branch Release Gate on the final commit. Do not run `pr:delivery -- ready` or enable auto-merge: the maintainer lands
      the PR. After the maintainer merges it, the plan is complete only once **Run Hetzner Supported Distributed
      Manifests** passes on the resulting default-branch commit (CLAUDE.md's completion gate; S3c-i changes no manifest
      or conformance catalog entry, so the run is expected unchanged); record its run id and summary in the closing
      report, and treat a red there under the hosted-manifest triage rules before blaming the branch (R-S3c-i-27).

## Rulings during execution

- **R-S3c-i-0 (pre-execution, 2026-09-28).** Q1–Q13 stand as settled (D57 as applied, D70–D78). C1–C16 are
  accepted as written. C1 in particular: a room-scoped unicast names its room through an optional `groupRef` on
  unicast targets (absence = a direct, room-less unicast), which is a persisted-shape change, so
  `AL_ADMISSION_SCHEMA_ID` moves to `'rallar-alm-2026-09-s3c-i'` in the same commit — that is the bump rule the
  Global Constraints prescribe, not a departure from "no migration" (reset-on-mismatch is the lever, D3/D17); the
  PR body names it and the server's Postgres admission rows in flight at deploy (no schema reset there — they fail
  the strict decode until their TTL). C2 (`unsupported` at admission for a `receiver` unicast naming no room), C3
  (a pre-admission refusal reads as a trusted-server `relay-rejected unauthorized`, closing correction 22), C7 (the
  `{ peerId }` target WS-only; other strategies throw until S3c-ii), C10 (recorder capacity 256), C13 (REST only
  while no server id is known). Cost if wrong: C1 resets every browser's stored ALM rows once at deploy; C13 leaves a
  Relic client whose WS is down without a command path until reconnect (REST is a fallback for the missing id, not
  for a dead socket).

R-S3c-i-1..27 rule on the pre-flight conflict scan's findings 1–27 (finding 28 is informational), one ruling per
finding; the controller accepted every finding's smallest edit on 2026-09-28, with the specifics below, and the plan
above is amended accordingly.

- **R-S3c-i-5 (the router's default fanout skips a unicast to the server).** `route()` publishes a topic's default
  fanout after its handlers, and nothing excluded a unicast addressed to the server: a `live-only` topic logged "had no
  recipients" for every such command (Task 2's recipe step on `room.chat` included), and an `outbox` topic enqueued a
  `WS_OUTBOX` row addressed to the server itself. Task 2 Step 5, where the router gains `serverPeerId`, guards the
  fanout with `isALUnicastAddressedTo(message, this.serverPeerId)` and adds a router test (`live-only`: no log;
  `outbox`: no row). Cost if wrong: a proxy rule or topic that meant to re-publish a server-addressed unicast must now
  publish it explicitly.
- **R-S3c-i-6 (an absent `serverPeerId` is "server unknown").** A strict decoder made REST reachable only before
  connect and stranded a new browser against an old server (or an un-updated mock). `decodeApiConfigResponse` now reads
  an absent id as a server that predates S3c-i — a distinct domain meaning that selects the old WS tracking and Relic's
  REST path — and refuses only an empty or non-string id; `ApiConfigResponse.serverPeerId` and the WS client's
  `serverPeerId` become `string | undefined`; C5 and C13 state the cost; the PR body states the deploy order (server
  before browser) and REST's reachability (Task 6 Step 8). Cost if wrong: a server that should serve the id but
  does not fails silently into REST and no hop receipt instead of refusing to connect.
- **R-S3c-i-8 (Relic's WS app-data write stays outside AppInbox, as named debt).** The mutation doctrine makes AppInbox
  mandatory for every incoming WS mutation, and Relic's WS command writes app data through
  `AppDataOptimisticWriter.set` directly. That write predates S3c-i on the REST path; S3c-i changes its transport, not
  the write, so no code changes here: the Global Constraints record it and the PR body names it as debt for the
  maintainer. Cost if wrong: S3c-i makes the undoctrined path Relic's primary write path until a later slice routes it
  through AppInbox.
- **R-S3c-i-10 (the real Relic server gets a gate).** Relic's own `/api/config` edit and the WS command and outbox
  snapshot cutover were proven only by fakes and a mocked Playwright double; `npm run test:playwright:relic:full-stack`
  (unsandboxed; `tests/playwright/relic-hunters/full-stack-propagation.spec.ts` against the real Relic server) joins
  Task 5 Step 6 and Task 6 Step 7, and C15 names it. Cost if wrong: a slower local gate that no CI workflow runs, so a
  red there is found only by the executor.
- **R-S3c-i-11 (the WS receipt's expected set may exceed its delivered set).** Q12 aggregates a handed-over message over
  its frozen audience verbatim, which contradicts `al-frozen-multicast-audience.ts`'s "narrow, never widen" invariant.
  That is by design — a leaver must read unconfirmed — so C11, the aggregation's doc comment and that invariant comment
  (amended in Task 4 Step 7) say the invariant governs delivery and the receipt may expect more. Cost if wrong: an
  origin can freeze ids the room never admitted (up to the collection limit) and make its own receipt unconfirmable.
- **R-S3c-i-18 (the addressee refusal follows the authorizer's NACK policy).** The refusal hardcoded `sendNack: true`,
  ignoring the router's `sendNacks` option. `WsServerInboundAuthorizer` gains the required `sendNacks` (the router passes
  its option; every test authorizer states `true`, Task 1 Step 7 with a completeness grep), and
  `toWsQueueBoxServerAddresseeAuthorization` takes it as `sendNack`. The check stays admission-only: C3 states that an
  addressee who leaves between admission and dispatch is not re-refused and reads unconfirmed at the deadline. Cost if
  wrong: one more required member on an internal interface (17 test sites), and a late leaver costs the origin its
  receipt deadline instead of a prompt refusal.
- **R-S3c-i-21 (the phase test pins a reachable state).** A server-addressed command tracks `[serverPeerId]`, so the
  server's pre-admission `unauthorized` NACK ends that row as `receipt-exhausted` ("Hop default-qbox-server refused the
  message: unauthorized.", state `failed`), never C3's `relay-rejected` fact; the degraded case of
  `to-relic-command-phase.test.ts` now uses that state and detail. Cost if wrong: none beyond the pin; C3's fact stays
  pinned by Task 1's relay-rejection test for a session-addressed unicast.
- **R-S3c-i-22 (the Playwright double uses the production constructors).** The double hand-copied
  `computeALControlMessage`'s envelope and sent its snapshot `best-effort`/`none`, so the spec never exercised the
  snapshot receipt. It now builds both frames with `newALAckControlMessage` and `newALBroadcastMessage` through the
  `@shared` alias, sends the snapshot `receiver` at-least-once as `toRelicSnapshotMessage` does, and asserts the page's
  two snapshot ACKs to the server. Cost if wrong: the spec depends on runtime `@shared` resolution in Playwright, which
  `tabbed-navigation.spec.ts` already relies on.
- **R-S3c-i-1, -2, -19, -23, -26 (code validity and conventions).** The Relic `main.ts` option is a valid object member
  (1); the command-delivery row renders in the new `relic-command-delivery-row.tsx` so `App.tsx` (cognitive load 776,
  unregistered) gains one import and one element line and joins the Global Constraints' call-lines list (2); the
  recorder's in-memory eviction is `setBoundedEntry` (19); a peer-addressed send refuses `minSnapshotVersion` and
  `ttlHops` instead of dropping them (23); the WS command's `no-session` reads "No issued session", since the auth store
  also returns expired and logged-out sessions (26).
- **R-S3c-i-3, -4, -7, -9, -15, -16, -25 (edit completeness).** Task 2's `git add` carries `tests/playwright`, the recipe
  matrix and every app test directory its sweeps edit (3); the black-box ALM result decoder accepts the trusted-server
  `unauthorized` rejection, with a case, in Task 1 Step 10 (4); the `/api/config` mock grep drops the quotes and lists
  the absolute-URL and `pathname` mocks (7); leftover imports are found with `deno lint`, not `deno task check` (9);
  `ws-queue-box-client-ingress.test.ts` has 2 construction sites (15); the bridge test's direct publisher call passes
  `undefined` as the new third argument (16); the OpenAPI realtime response requires `almReceipts` and enumerates
  `lastSettlementKind` (25).
- **R-S3c-i-12, -13, -14, -17, -20, -24, -27 (records, anchors and the PR).** Task 1's matrix description no longer
  claims the server-addressed receipt, which Task 2 Step 9 adds (12); the duplicate R-S3c-i-0 entry is deleted (13);
  Task 6's roadmap anchors are `:809-843` and `:952` and its docs step names seven files (14); Task 4 cites
  `toFrozenAudience` by name and Task 5 no longer claims Relic `main.ts:89`, which Task 2 owns (17); the PR body's D72
  paragraph says the server log is the only surface for a caught Relic error (20); the inbound README's schema id moves
  with the bump into Task 1 Step 7 and the proposal's `:416` status line is updated in Task 6 (24); Task 6 names the
  post-merge Hetzner supported-manifests gate on the default-branch commit (27).

Later rulings follow as R-S3c-i-n with why and the cost if wrong.

## Self-review

- **Spec coverage.** §2.3's S3c-i share: "the `receiver` receipt on a WS unicast" → Task 1 (D53, D71: router delivery
  Q4, the one-member aggregate, both refusals Q5, the empty client plan, the addressee's ACK admitted at ingress);
  "Relic Hunters commands ... a server-addressed unicast ... the id learned ... receipt = the server's own ACK ... the
  UI shows the delivery outcome and the applied snapshot's arrival ... REST stays for one release" → Task 2 (the id on
  `/api/config`, Q2/Q3/D76, the server-addressed exemption in Task 1 Step 7) and Task 5 (the command channel, D72, the
  UI row, REST fallback C13); "Relic snapshots ... `fanout: 'outbox'` with `ack: 'receiver'` ... freezes the room's
  current sessions at publish ... sender id is the server peer id ... a server settlement sink ... per-session
  confirmation" → Task 4 (the frozen publish audience C8, the recorder C10, `almReceipts`) and Task 5 (the snapshot
  message, D77, C14); "cluster delivery honouring the carried audience" → Task 4 Step 6 (C9). §10: Q1 → the plan's
  scope; Q2/Q3 → Task 2; Q4/Q5 → Task 1; Q6 → Task 5 Steps 1–2 and 4; Q7 → Tasks 4–5; Q8 → Task 4 Steps 1–2 and 8;
  Q9/Q10 → carried to S3c-ii; Q11 → Task 3 (WS only, header); Q12's S3c-i share (leavers) → Task 4 Step 7, its S3c-ii
  and V1 shares → "Carried to S3c-ii / later"; Q13 → Global Constraints and Task 6 Step 7. S3b's carries: R-S3a-4 →
  Task 2; S3b Q8's alternative → Task 4 Step 7; the `undefined` server sink → Task 4 Step 8.
- **Placeholder scan.** Every code step shows the code against the signatures read on `4550c66df`. The values only a
  run gives are named as such: the bundle figures (Task 1 Step 13, Task 2 Step 10, Task 3 Step 4), the moved pins
  (Task 1 Step 10, Task 2 Steps 7–8, Task 5 Step 5), the medium-scale summary line (Task 6 Step 7) and the revision
  history date. The mechanical edits (Task 2 Step 8's WS client constructions, the `/api/config` mocks) name every file
  and end with a command that proves completeness; where `npm run typecheck` is the completeness proof (hand-built
  `RallarConnectionOperations`, `ALOutboundAdmissionStore` or `QueueBoxPubSubWsService` doubles), the member to add is
  written out.
- **Type consistency.** `isALUnicastAddressedTo` (Task 1) is what `toWsQueueBoxServerInboundPlan`, the aggregation's
  `toAdmission` and the client's `toReceiptAudience` (Task 2) call; the unicast `groupRef` and `newALUnicastMessage`'s
  new options (Task 1) are what `createBrowserWsUnicastMessage` (Task 3) passes; `ApiConfigResponse` (Task 2) types
  `decodeApiConfigResponse`, `readApiConfig`, `ConfigRouteDependencies.publicConfiguration` and Relic's config route;
  `WsQueueBoxClientService.serverPeerId` (Task 2) is what `RallarConnectionOperations.serverPeerId()` reads and what
  `sendRelicWsCommand` (Task 5) addresses; `RallarServerWsRouter.serverPeerId` (Task 2) is what
  `readRallarServerWsPublishAudience` (Task 4) compares and `RelicHunterServer.ws.serverPeerId` (Task 5) reads;
  `readAdmittedAudience` is one name from the admission store through `WsQueueBoxServerClusterPublication` and
  `WsQueueBoxServerService` to `QueueBoxPubSubWsService` (Task 4); `RallarAlmReceiptDiagnosticsRecorder.readDiagnostics`
  returns the `AdminOperationsAlmReceiptDiagnostics` that `ReadAdminRealtime.Options.readAlmReceipts` and
  `CreateApiV1AdminOperationUseCasesInput.readAlmReceipts` type (Task 4); `RelicWsCommandDelivery` (Task 5 Step 4) is
  the `delivery` of `RelicCommandOutcome` that `toRelicCommandPhase` reads.
