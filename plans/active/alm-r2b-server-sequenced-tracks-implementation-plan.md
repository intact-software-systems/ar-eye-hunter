# ALM R2b: server-sequenced tracks and Relic's round transitions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven development with test-driven development:
> one implementer per task, the failing tests first, the controller reviews and commits, one commit
> per task, a three-seat final review with one fix wave before the close. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Deliver Release 5, R2b (D150 to D155, `playground/alm/alm-r2b-design-proposal.md`). The WS
server mints the sequence of a publication that names an ordering key without one, from an
ordering-head row per track under the sender-version fence, so a server track is contiguous across
instances and survives a restart; its range repair of its own publications is proven at the server.
Relic publishes a round-transition event on a track per round (the game's incarnation,
`${gameId}:${createdAtEpochMs}`, as key, the round as epoch, R-R2b-31) beside its latest-wins
snapshot, and the Relic client reads it through a typed channel whose recovery owner re-hydrates
over REST and whose messages drive the UI's live round cues. The docs state the server-sequenced
track and the Relic consumer.

**Spec:** `playground/alm/alm-r2b-design-proposal.md`; decisions D150–D155 in
`playground/alm/alm-improvement-plan.md`.

## Global constraints

- **The maintainer's notes stand: "No legacy, avoid duplication, no migration code, keep the repo
  consistent, prefer existing patterns."** No wire or schema bump: `ALOrdering` is unchanged; the
  minted sequence is an ordinary `seq`. No compatibility path (D3).
- **D8 reuse first.** Named reuses, each verified at `file:line` by its task: the sender-version fence
  and its key beside the new ordering-head key; the sent row's ordering index and `set-ordering-message`;
  the WS server's outbound runtime, repair planner and control admission; the WS client's inbound
  ordering of trusted-server tracks and the recovery owner registry; the three-backend schedule module;
  the Relic server's publish chain and the existing REST read; the typed room channel API. Every task
  carries a D8 reuse inspection paragraph and its commit one `D8 reuse:` line.
- **No guarantee weakens.** Browser sends keep client-assigned sequences (D24 narrowed, never
  server-minted); the server repairs only requesters of a message's admitted audience (D43); the
  snapshot stays latest-wins (D151); the ledger, cold, inbound, D55 and checkpoint pins stay unedited;
  hosted manifests 18 and 22 byte-identical.
- **Convergent-service rules** (`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`)
  bind the minting: the head is read in the decision phase, the mint is pure compute, the write
  advances the head in the same fenced commit, a conflict is a value that re-runs with fresh reads.
- **Code standard** (`.agents/skills/rallar-code-writing/references/repo-code-style.md`): canonical
  verbs; functions ≤40 lines; ≤3 positional parameters; `interface` for object contracts; required
  fields by default; `Either` for expected failure; kebab-case filenames after the primary export; no
  role folders; no comments but invariants, external constraints and tradeoffs; no plan, decision,
  task, PR or ruling id in code or tests; one canonical name per type.
- **Formatting:** `npx dprint fmt <explicit file list>` on touched files only.
- **Per-task checks:** the focused Vitest files; `npx tsc -p packages/shared/tsconfig.json --noEmit`;
  the shared-web, shared-server and shared-test typechecks; `deno check` from the repo root on every
  changed `packages/shared/**` and `packages/shared-server/**` file; `cd apps/api-v1 && deno task check`
  then `rm -rf apps/api-v1/node_modules/.deno`; `cd apps/relic-hunter-server-v1 && deno task check` and
  its tests for the Relic server; `node scripts/check-tests-typecheck.mjs`; the four pins; the bundle
  checks with a private `TMPDIR` after any `packages/shared` or `shared-web` change (budgets:
  `browser/rallar.ts` 240, headless 305; a crossed budget rises to the next whole KiB with the figure
  in the commit message); after the commit `npm run check:repo-style:changed -- origin/main HEAD`,
  `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD` and, when a test file
  is added, `npm run check:test-reachability`; `npm run test:postgres:integration` is owed by the task
  that changes `alm/outbound/**` or `ws-queue-box-server/**` source where a Postgres is available (the
  controller runs it unsandboxed), and the api-v1 medium-scale gate runs in CI on every push.
- **Sandbox notes.** Loopback binds fail (EPERM): name those suites as sandbox reds; `mktemp -d
  /tmp/claude-501/b.XXXX` for a private TMPDIR; `npx tsx` fails on its IPC pipe (use `node --import
  tsx`); `git fetch` and `gh` need the sandbox off.
- **Git.** One commit per task with one `D8 reuse:` line and no attribution lines; the controller
  commits and pushes after review; never `git stash`; the PR body is written at the close.

## File structure

| Area               | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server minting (1) | `packages/shared/al-contracts/al-contract.ts`, `al-runtime.ts`; `packages/shared/alm/outbound/admission/al-outbound-admission-{keys,mutations,reads,store,validation}.ts`; `packages/shared/alm/outbound/al-outbound-{canonical-message,canonical-storage,dispatch-admission,message-effects,message-runtime}.ts`, `compute-al-outbound-dispatch.ts`, `validate-al-outbound-dispatch.ts`; `packages/shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts`; `packages/shared/alm/outbound/README.md`; tests `al-broadcast-ordering.test.ts` (new), `al-outbound-sequence-minting.test.ts` (new), `al-shared-key-arbitration.test.ts`, `ws-queue-box-server-outbound-planning.test.ts`, the PostgreSQL `al-outbound-supersedence.test.ts` |
| Server repair (2)  | `packages/shared-server/rallar-system/websocket/router/publish-rallar-server-ws-message.ts`, `rallar-server-ws-publish-result.ts`; tests `packages/tests/shared/services/ws-queue-box-server-ordered-repair.test.ts` (new), `packages/tests/shared/ws-qos-policy.test.ts`, `rallar-server-ws-fanout-carrier.test.ts`, `apps/api-v1/test/services/ws-room-authority-delivery.test.ts`                                                                                                                                                                                                                                                                                                                                                                            |
| Relic server (3)   | `apps/relic-hunter-server-v1/src/to-relic-round-transition-message.ts` (new), `relic-game-service.ts`, `apply-relic-ws-command.ts`, `resources/relic-hunter-server-v1-openapi.yaml`; `packages/relic-hunters/src/model.ts`; `apps/relic-hunter-server-v1/test/relic-server-service.test.ts`; the snapshot literals of seven `apps/relic-hunters-v1/tests/*.test.ts` files and `tests/playwright/relic-hunters/web.spec.ts`                                                                                                                                                                                                                                                                                                                                      |
| Relic client (4)   | `apps/relic-hunters-v1/src/game/subscribe-relic-round-transitions.ts` (new), `to-relic-phase-banner.ts` (new), `relic-hunters-runtime.ts`, `relic-snapshot-ordering.ts`, `useRelicHunters.ts`; `apps/relic-hunters-v1/src/App.tsx`; `packages/relic-hunters/src/model.ts`; tests under `apps/relic-hunters-v1/tests/` and `packages/tests/relic-hunters/`; `tests/playwright/relic-hunters/full-stack-propagation.spec.ts`; `docs/test-structure-coupling-exceptions.md`                                                                                                                                                                                                                                                                                        |
| Docs (5)           | `docs/rallar-api-reference.md`; `packages/shared/alm/inbound/README.md`, `outbound/README.md`; `playground/alm/alm-complete-product-description.md`, `alm-improvement-plan.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Close (6)          | the pins, the gates, the review, the PR body, the roadmap's delivered line, this file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Task order

1 (server minting) → 2 (server repair) → 3 (Relic server) → 4 (Relic client) → 5 (docs) → 6 (close).
Task 2 consumes Task 1's mint at the planner and the enqueue result's minted message; Task 3 consumes
Task 1's broadcast-builder `ordering` option and is independent of Task 2; Task 4 consumes Task 3's
event type and the key's owner in `model.ts`; Task 5 states what Tasks 1–4 built and is checked
against them.

## Rulings

- **R-R2b-1 (from W-D):** the WS server mints a sequence only for a publication whose `msg.id.senderId` is the
  outbound runtime's own peer id; a relayed browser message that carries a key without a sequence (every RTC room
  multicast and its WS fallback broadcast) passes through unsequenced as today. Pinned both ways in Task 1.
  _Cost if wrong:_ every browser room send would gain a server sequence, and receivers would order, NACK and buffer
  the browsers' group tracks — a silent change in both games.
- **R-R2b-2 (from W-D):** the product description's Relic paragraph lives in "Delivery and compatibility posture"
  after the D4 sentence (the document has no consumer section). _Cost if wrong:_ one paragraph moves.
- **R-R2b-3 (from W-D):** D150–D155 are recorded in the roadmap's decision table (7df651c89); D24 is narrowed by
  D150 in the roadmap row text at the close if the row's "(2026-09-23)" wording needs it. _Cost if wrong:_ a row note.
- **R-R2b-4 (from W-D, carried; the corrected wording from W-B's report, which supersedes the first form):** one receiver's `resync-required` NACK settles the server publication
  `relay-rejected { relay: 'peer', peerId, reason: 'resync-required' }` and removes its whole pending receipt (no more
  receipt retries for any recipient); pinned by Task 2's fixture; a carried limit.
  _Cost if wrong:_ the other recipients of a round event lose receipt retries after one receiver's resync.
- **R-R2b-5 (from W-D):** the API reference's server-track text stays as paragraphs inside "Ordering, Repair And
  Resynchronization" (no new heading). _Cost if wrong:_ a heading.
- **R-R2b-6 (from W-D):** the ordering-head row expires with the durable row retention (≥ 60 min); a track idle
  past it restarts at 1 on the same epoch, harmless because receiver tracks expire after 5 min; the docs claim only
  "continues after a restart". _Cost if wrong:_ a stale receiver sees `stale` once.
- **R-R2b-7:** only `newALBroadcastMessage` takes the `ordering: { orderingKey, epoch?, seq? }` option; the multicast
  builder keeps its flat `seq`/`orderingKey` options (the browser's path, unchanged). _Cost if wrong:_ one builder's
  option shape.
- **R-R2b-8:** the ordering head is read in the admission's read session beside the planner and the mint is applied to
  the message before the fenced commit; the sender-version fence serialises concurrent mints. _Cost if wrong:_ the
  mint moves into a compute step.
- **R-R2b-9 (reverses W-A's A3):** a lost sender fence keeps the existing pending-admission path and the sequence
  belongs to the committing attempt: the pending admission stores the caller's unminted message and the replay's
  admission mints through the same code when it commits; no immediate re-mint retry loop. _Cost if wrong:_ a
  conflicting mint could reuse a sequence (A3's hazard) or spin on a hot fence.
- **R-R2b-10:** bundle headroom after Task 1 is 0.3 KiB (facade 239.685 of 240) and 0.2 KiB (headless 304.799 of
  305); a crossed budget rises to the next whole KiB with the figure in the commit message (maintainer rule).
- **R-R2b-11 (amends D151; reverses W-C's C4 carry):** the ordering key names the game INCARNATION,
  `${gameId}:${createdAtEpochMs}` (both in the public snapshot, `model.ts`), because a reset keeps the game id and would
  continue the previous incarnation's round tracks (the server's head at 3, 4, … while a joiner expects 1). A new
  incarnation is a new key; the client's recovery owner filters on it from the snapshot it holds. _Cost if wrong:_
  a joiner or reloaded page after a reset loses cues for up to 5 min per round.
- **R-R2b-12 (W-C C1):** the transition is derived from a four-row phase-change table (lobby→planning round-started,
  planning→review round-resolved, review→planning review-continued, review→finished finished); the text is the newest
  event of the row's marker type. _Cost if wrong:_ event-type derivation would publish false round-started events
  (a repeated start appends `round_started` without a phase change).
- **R-R2b-13 (W-C C2):** only the phase banner moves to the ordered stream; the event feed, its sounds and the
  scene's replay stay on the snapshot history (one owner per cue). The old banner effect's `prevPhaseRef` bug goes with
  it. _Cost if wrong:_ two owners of the reveal list.
- **R-R2b-14 (W-C C3, limit):** a mid-round joiner or reloaded page gets no banner for the rest of that round unless
  the server repairs the track to it (in the audience, inside the 60 s deadline); it cues from the next round.
- **R-R2b-15 (W-C C5):** the subscription lives in a hook effect keyed on `roomId` and the middleware connection,
  not in `connectAndHydrate`. _Cost if wrong:_ the subscription moves.
- **R-R2b-16 (W-C C6, C7):** the warning text "…was applied, but its publication failed."; the touched-file closure
  edits (`isOneOf` guards, `ApiJsonObject`, `decodeRelicSnapshotPayload`, the window cast, `toError`, the registry
  contract `relic-unauthorized-auth-change-never-logs-out`) stand. _Cost if wrong:_ a registered exception instead.
- **R-R2b-17 (W-C C8):** the Playwright case asserts exact cue logs for the page that stayed and an in-order
  subsequence for the reloaded page (its current round depends on repair). _Cost if wrong:_ a flaky exact assertion.
- **R-R2b-18 (W-C surprise 6, limit):** recovery owners are global per route (latest wins, no removal); a stale owner
  after leaving a room is harmless (its snapshot is refused `room-mismatch`).
- **R-R2b-19 (W-A amendment):** the captured policy keeps `mintsSequence` (persisted, decoder accepts only `true`);
  the WS server planner sets it only at `phase: 'immediate'`; the pending admission stores the unminted request and a
  replay that minted replaces the retained canonical row only when it is `COMPLETED` and differs by the seq alone
  (`isALOutboundMintOfPendingRequest`); the mint condition is "no sent row". _Cost if wrong:_ a producer-written outbox
  row could never be minted, or a replay could overwrite a live row.
- **R-R2b-20 (W-B B1):** an `outbox` publish result carries the admitted (minted) message:
  `toRallarServerWsOutboxPublishResult(fanout, result)` returns `result.message`; `live-only`/`none` keep the caller's.
  The API reference's `ws.publish` row says so. _Cost if wrong:_ a caller deep-comparing result with input.
- **R-R2b-21 (W-B B2):** a server track's requester must be in the admitted audience AND expected by the trigger
  message's pending receipt (the existing rules, unchanged), so a keyed server publication uses `ack: 'receiver'`
  (Relic does); an `ack: 'none'` server track gets no ranged repair (documented limit). _Cost if wrong:_ widening the
  expected-peer rule would also widen browser senders' trust.
- **R-R2b-22 (W-B B3):** only `fanout: 'outbox'` mints; `publishAuthorizedRallarServerWsMessage` REFUSES a keyed,
  unsequenced `live-only` publish (fail closed; one check with a router test — added to Task 2 at composition), and
  the docs say so. _Cost if wrong:_ a live-only keyed publish goes out silently unsequenced.
- **R-R2b-23 (W-B B4, limit):** the repair budget is per message (`maxRepairs: 1` default), shared by all
  requesters; the first receiver to NACK a sequence spends it, the others fall back to receipt retries (2 s).
- **R-R2b-24 (W-B B5, follow-up):** the readiness probe reads 16 rows per status and can hide a due row behind
  not-yet-due ones (pre-existing, every outbound lane); Task 2's paging case advances the clock; a follow-up issue.
- **R-R2b-25 (W-B B6):** the fixture is the new sibling `ws-queue-box-server-ordered-repair.test.ts` (mocked clock,
  manual engine, frozen audiences); `ws-server-qos-policy.test.ts` is not extended. _Cost if wrong:_ a file moves.
- **R-R2b-26 (W-B surprise 2):** a joiner's NACK and a NACK past the deadline stop at the repair authority as
  `not-handled` (not a refusal); the fixture pins `not-handled`.
- **R-R2b-27 (W-B surprise 6, follow-up):** a complete receipt swallows a repair send with no settlement, leaving a
  dangling `attempt-started`; minor, follow-up.
- **R-R2b-28:** `RelicPublicSnapshot` gains the required `createdAtEpochMs` (copied by `toPublicRelicSnapshot`,
  required by `isRelicSnapshot` and the OpenAPI schema); one owner of the key shape,
  `toRelicRoundTrackKey(game)` in `packages/relic-hunters/src/model.ts`, used by the server builder and the client
  filter; D3: a client refuses a snapshot from an older server (no compatibility window). _Cost if wrong:_ a hidden
  second formatter of the key, or an optional field with no domain meaning.
- **R-R2b-29 (loosens the Task 4 filter):** the recovery owner hydrates for any resync cursor whose `orderingKey`
  names the page's GAME (`startsWith(\`${gameId}:\`)`), not only the incarnation the page holds: a page that missed
  the reset snapshot and resyncs on the new incarnation's track is exactly the page that needs hydration.
  _Cost if wrong:_ a stale page waits for the next snapshot instead of hydrating.
- **R-R2b-30:** `isRelicRoundTrackOfGame(orderingKey, gameId)` beside `toRelicRoundTrackKey` requires the prefix
  `${gameId}:` and an all-digit remainder; `readRoundTrackKey` is removed from the subscription, runtime and hook.
- **R-R2b-31 (assembler):** the incarnation key of R-R2b-11 reaches every text that still named the
  game id alone: the plan's Goal (the head's "(the game id as key, the round as epoch)") and the
  roadmap's R2b paragraph bullet "**Relic's rounds (D151, D152).**", corrected in Task 5's commit
  (the D151 row and the proposal were already corrected in `9e5c4bf38`). Tasks 3, 4 and 5 agreed
  on `${gameId}:${createdAtEpochMs}` through `toRelicRoundTrackKey` and `isRelicRoundTrackOfGame`
  as prototyped. _Cost if wrong:_ one roadmap phrase.
- **R-R2b-32 (assembler):** every task's changed-range gates run from the plan base,
  `npm run check:repo-style:changed -- 9e5c4bf38 HEAD` and `node scripts/check-test-structure-coupling.mjs
  --changed 9e5c4bf38 HEAD` (measured PASS at each composed commit); `origin/main` (`e366f60eb`) is
  equivalent, because the three design commits change only two Markdown files under `playground/alm/`.
  _Cost if wrong:_ none; a narrower range checks a subset.

## Limits (carried; Task 6 states them in the PR body)

- A joiner within a round buffers that round's remaining transitions until the next epoch: the
  protocol has no track-start hint (D155). A mid-round joiner or reloaded page gets no banner for the
  rest of that round unless the server repairs the track to it, inside the admitted audience and the
  60 s deadline; it cues from the next round (R-R2b-14).
- Repair of a server publication is bounded by its 60 s deadline; the ordering index dies with it.
- The state-sync group events carry a non-contiguous `seq` (`snapshotVersion`); whether a client's
  window NACKs the server for their gaps is a pre-existing question R2b records and does not change.
- Server tracks carry no membership fence (D146).
- Relic's per-game command serialization is process-local (D72): the minted sequence is contiguous
  whichever instance publishes, but concurrent command application across instances stays Relic's own
  hazard; cluster-safe command serialization is not part of R2b.
- A server-originated send has no conformance cell, because the harness has no capability for
  server-originated typed sends (follow-up).
- The Relic snapshot itself is not ordered: it stays latest-wins (D151).
- One receiver's `resync-required` NACK settles a server publication `relay-rejected` and removes its
  whole pending receipt, so no recipient is retried after it; pre-existing, for a browser's room
  multicast as for a server publication (R-R2b-4).
- The ordering-head row expires with the durable row retention (at least 60 min): a track idle past
  it restarts at 1 on the same epoch, which a receiver whose track has not expired (5 min) reads as
  `stale` once; the docs claim only "continues after a restart" (R-R2b-6).
- Recovery owners are global per route (latest wins, no removal); a stale owner after leaving a room
  is harmless, its snapshot is refused `room-mismatch` (R-R2b-18).
- A server track's requester must be in the admitted audience and expected by the trigger message's
  pending receipt, so an `ack: 'none'` server track gets no ranged repair (R-R2b-21).
- The repair budget is per message (`maxRepairs: 1` by default) and shared by all requesters: the
  first receiver to NACK a sequence spends it, the others fall back to receipt retries (2 s)
  (R-R2b-23).
- The outbound readiness probe reads 16 rows per status and can hide a due row behind not-yet-due
  ones, on every outbound lane; pre-existing, Task 2's paging case advances the clock; a follow-up
  issue (R-R2b-24).
- A complete receipt swallows a repair send with no settlement, leaving a dangling
  `attempt-started`; minor, a follow-up (R-R2b-27).
- Only the outbox fanout mints: a keyed server publication without `seq` on `live-only` or `none`
  is refused as a failed publish, never sent unsequenced (R-R2b-22).
- Hosted manifests 18 and 22 stay byte-identical; the Relic full-stack Playwright case is manual and
  had no run while planning (Task 6 runs it where its stack is available).

---

### Task 1: Server-minted sequences (D150)

**Files** (anchors at the plan base `9e5c4bf38`, this task's parent, where the code is the design commit's; the prototype is
`final-patch-task-1.patch`)

- Modify `packages/shared/al-contracts/al-contract.ts`: `newALBroadcastMessage`'s option (`:415`) becomes
  `ordering?: Readonly<{ orderingKey: string; epoch?: number; seq?: number; }>` with the doc line "A sequence left out
  is minted by the WS server's outbound for its own publication."; the ordering block (`:443-445`) writes
  `{ orderingKey, epoch, seq }` from the option. `newALMulticastMessage` keeps its flat `seq`/`orderingKey` (R-R2b-7).
- Modify `al-contracts/al-runtime.ts:73-82`: `toALOrderingTrackKey` returns `toTrackKey(orderingKey, msg)`; add
  `toALSequenceMintTrackKey(msg)` (the track of a message that names a key and no `seq`, else `undefined`),
  `toALSequenceMintComparableMessage(original, candidate)` (removes `seq` from a candidate whose track equals the
  original's mint track; any other candidate is returned as is) and the private
  `toTrackKey(orderingKey, msg) = \` ${orderingKey}:${msg.id.senderId}:${msg.ordering?.epoch ?? 0}\``.
- Modify `alm/outbound/admission/al-outbound-admission-keys.ts`: before `toALOutboundSentMessageKey` (`:11`) add
  `toALOutboundOrderingHeadKey(namespace, trackKey)` = `` `${namespace}:ordering-head:${trackKey}` ``.
- Modify `al-outbound-admission-validation.ts`: before `decodeALOutboundSentMessage` (`:118`) add
  `interface ALOutboundOrderingHeadRow { readonly seq: number; }` (type only: a decoder here makes 12 runtime exports,
  a changed-gate failure); `ALOutboundCapturedPolicy` gains, after `supersedenceTracking` (`:42`), `readonly
  mintsSequence?: true;` ("Kept only for a WS server publication whose admission mints its sequence, so a retained
  replay mints too."); `captureALOutboundPolicy` (`:56`) spreads `...(plan.mintsSequence ? { mintsSequence: true } :
  {})`; `decodeALOutboundCapturedPolicy` (`:150`) lists `'mintsSequence'` first among the optional keys and throws
  `TypeError('Captured sequence minting is invalid')` for any value but `true`.
- Modify `al-outbound-message-effects.ts:410`: `toALOutboundRetainedDispatchPlan` restores
  `mintsSequence: pending.policy.mintsSequence`.
- Modify `al-outbound-message-runtime.ts`: after `supersedenceTracking?` (`:169`) the plan gains
  `readonly mintsSequence?: true;` (doc: the sender asks its own outbound for the sequence; only the WS server plans
  it, only for a message it publishes itself; absent, a keyed message without a sequence stays unsequenced).
- Modify `al-outbound-admission-store.ts`: before `ALOutboundMessageReadDto` (`:163`) add
  `interface ALOutboundOrderingHead { readonly trackKey: string; readonly seq: number; }`; after `plan` (`:173`) the DTO
  gains the required `readonly orderingHead: ALOutboundOrderingHead | undefined;`.
- Modify `al-outbound-admission-reads.ts`: `readOutgoingMessage` (`:147`) passes the plan through
  `readSequenceMint(session, plan, stored === undefined)` and returns its `plan` and `orderingHead`; the private
  `readSequenceMint(session, plan, unadmitted)` (before `readControlTracking`, `:420`) returns the plan unchanged
  unless `plan.mintsSequence`, `unadmitted` (no sent row: a first attempt or the replay of a retained request) and
  `toALSequenceMintTrackKey(plan.msg)` all hold, else reads the
  head (`readValue`, same session as the sender version) and stamps `seq = (head?.seq ?? 0) + 1` on `plan.msg`;
  `readAdmissionFences` (`:465`) computes the supersedence input from `plan.msg` (the minted copy); a private
  `decodeALOutboundOrderingHead` before `requireALOutboundPlannedMessage` (`:556`): `decodeALAdmissionNumber` of the
  record's one `seq` field, below 1 throws `TypeError('Stored outbound ordering head is invalid')`.
- Modify `al-outbound-admission-mutations.ts`: the union (`:38`) gains `{ kind: 'set-ordering-head'; trackKey; seq;
  expireAtTimestamp: number }`; the write value union (`:99`) gains `ALOutboundOrderingHeadRow`; before the class
  (`:120`) export `toALOutboundOrderingHeadMutations(head, expireAtTimestamp)` (`[]` when either is undefined);
  `computeStateWrite` (`:216`) writes `{ seq }` at the head key, expiring by `computeMessageRowExpiryMs(deadline, nowMs,
  retention.sentMessageTtlMs)`, the sent row's formula.
- Modify `compute-al-outbound-dispatch.ts:197`: before `appendSupersedenceMutations` push
  `...toALOutboundOrderingHeadMutations(read.orderingHead, expiresAtMs)` (an inline `if` lifts the file to cognitive
  load 51, a changed-gate warn).
- Modify `al-outbound-dispatch-admission.ts` (the conflict path keeps the pending admission, R-R2b-9): before
  `hasOneALOutboundSenderVersion` (`:686`) add `toALOutboundRequestedMessage(read)` = `read.msg` when
  `read.orderingHead` is undefined, else `toALSequenceMintComparableMessage(read.originalMsg, read.msg)` (the message
  as its sender asked for it). `retainPendingDispatch` (`:408-444`) builds the retained canonical row from it
  (`{ ...candidate, resource: this.dependencies.toOutboxEntry(requested).resource }`, comment: the sequence belongs to
  the attempt that commits; the replay mints when it commits) and uses `requested` for the reference and both
  results (`:435`, `:440`); the found-pending answer (`:347`) states `toALOutboundRequestedMessage(input.read)`;
  `toDispatchInput` (`:533`) builds the entry from `read.msg` when the read minted (`read.orderingHead === undefined &&
  read.canonicalEntry ? read.canonicalEntry : this.dependencies.toOutboxEntry(read.msg)`, comment: a replay that
  minted replaces the request its retained canonical row holds). No retry loop: the replay's own conflict throws
  `RetryableConflictError` and the work queue retries on its schedule, as today.
- Modify `al-outbound-canonical-message.ts`: before `outboundMessageIdentity` (`:179`) export
  `isALOutboundMintOfPendingRequest(activatesPendingRow, expected, entry)`: true only when activating, `expected` is
  `COMPLETED`, the resources differ, the decoded candidate has a `seq` and `jsonEquals(requested,
  toALSequenceMintComparableMessage(requested, minted))`. `al-outbound-canonical-storage.ts`: after the identity read
  (`:127`) `const minting = isALOutboundMintOfPendingRequest(activatePendingCanonical, expected, entry);` — the
  content check (`:145`) adds `&& !minting`, `replaceExisting` (`:155`) becomes `minting || (<today's condition>)`
  (the helper lives in the message module: in the storage module the file's cognitive load reaches 50).
- Modify `validate-al-outbound-dispatch.ts:63` and `al-outbound-canonical-storage.ts:103`: compare against
  `toALFreezeComparableMessage(original, toALSequenceMintComparableMessage(original, candidate))`.
- Modify `services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts:153`: `planOutboundMessage` returns
  `{ ...plan, mintsSequence: true }` when the private `isOwnSequenceRequest(message)` holds:
  `phase === 'immediate' && message.id.senderId === this.#serverPeerId && toALSequenceMintTrackKey(message) !==
  undefined` (R-R2b-1; the phase keeps a row a producer wrote straight to WS_OUTBOX unminted, whose canonical row
  is the producer's and cannot be replaced).
- Modify `packages/shared/alm/outbound/README.md`: before "Known limitations:" (`:610`) the "**Server-minted
  sequences.**" paragraph (where minted, the own-peer-id rule, the fence, the retained unminted request and its
  minting replay, idempotency, retention).
- Tests: create `packages/tests/shared/al-contracts/al-broadcast-ordering.test.ts` and
  `packages/tests/shared/alm/outbound/al-outbound-sequence-minting.test.ts`; modify
  `packages/tests/shared/alm/al-shared-key-arbitration.test.ts`,
  `packages/tests/shared/services/ws-queue-box-server-outbound-planning.test.ts`,
  `packages/tests/shared-server/integration/postgres/al-outbound-supersedence.test.ts`.

**Interfaces.** Produces, for W-B and W-C: `newALBroadcastMessage(..., { ordering: { orderingKey, epoch?, seq? } })`
(epoch written); `toALSequenceMintTrackKey(msg): string | undefined`;
`toALSequenceMintComparableMessage(original, candidate): ALMessage`; `toALOutboundOrderingHeadKey(namespace,
trackKey): string`; `ALOutboundDispatchPlan.mintsSequence?: true`; `ALOutboundMessageReadDto.orderingHead`. **The rule:**
the mint applies only when `msg.id.senderId` is the WS server's own peer id (`service.name`, `default-qbox-server` in
api-v1 and Relic) and the message names `ordering.orderingKey` without `seq`; a relayed message with a key and no `seq`
(every browser RTC room multicast and its WS fallback) passes through unsequenced. Only an admission with no sent
row mints; a repeated `enqueueOutboxIfAbsent` answers `duplicate` with the stored message. A first attempt that
loses the sender fence answers `pending` with the unminted message; the work queue's replay mints when it commits.
`WsQueueBoxServerService.enqueueOutboxIfAbsent(...)` returns the minted message as `result.message`; the sent row, the
ordering index (`readSentMessageByOrdering(trackKey, seq)`), the canonical row every cluster send reads and the wire
carry it. Server-side range repair needs nothing more from this task.

**D8 reuse inspection.** The sender-version fence (`al-outbound-admission-store.ts:663-700`) serialises mints; the
mutation vocabulary, `computeMessageRowExpiryMs` and the `readValue` session read carry the head; the track key shares
`toALOrderingTrackKey`'s formula; the minted-copy comparison follows `toALFreezeComparableMessage`'s pattern; the
cluster publisher already reads the canonical message (`ws-queue-box-server-cluster-publication.ts:58-90`,
`lifecycle.canonicalMessage`); a lost fence rides the existing pending-admission replay, whose activation of the
retained canonical row (`replaceExisting`) takes the minted copy. No sequence service, no new store, no migration.

- [ ] **Step 1: Write the failing tests** (copy from the patch). Builder: three cases (key, epoch and seq written and
      decoded; key and epoch only → `toALOrderingTrackKey` undefined, `toALSequenceMintTrackKey` `'game-1:server:2'`; no
      epoch → `'game-1:server:0'`). Minting (runtime fixture, planner `OUTBOUND_TEST_SEND_PLANNER` + `mintsSequence: true`,
      sender `server`, 60 s TTL): "mints 1, 2, 3 on one track and starts another key or another epoch at 1"; "keeps the
      sequence of an admitted message when the same message is admitted again" (`duplicate`, seq 1, next 2); "stores,
      indexes and sends the minted message" (sent row `{ orderingKey: 'game-1', epoch: 3, seq: 1 }`, ordering index names
      the msgId, the carrier's canonical frame carries seq 1); "continues the track where the store stands when a new
      runtime opens it" (4); "a conflicting mint never reuses a sequence: the replay of its pending admission mints the
      next one" (a store-level commit of `early` interleaved after `late`'s first decision read — a second runtime
      would wait on the sender's Web Lock; `late` answers `pending`, `result.message.ordering.seq` undefined, no sent
      row, its retained canonical row `{ orderingKey: 'game-1', epoch: 1 }`; after `runOutboundWorkTask` and
      `waitForOutboundWorkDrained`: sent rows 1 (`early`) and 2 (`late`), the canonical row seq 2, the carrier sent
      exactly `[early, 1]` and `[late, 2]`); "mints nothing for a plan that does not ask for a sequence" (green at
      base, the guard). Shared-key: "decides on the outbound ordering head: one track, two minted sequences" over
      memory/IndexedDB/pglite (arbitrated key the head, A's sent key absent, A re-reads → seq 2, B seq 1). WS server:
      "mints the sequence of its own keyed publication and leaves a relayed keyed send unsequenced" (fixture gains
      `backend`; own seqs 1, 2; relayed `a` with `toALGroupTargetKey(ROOM)` keeps no seq, its sent row
      `{ orderingTrackKey: null, orderingSeq: null }`; `b` receives seqs `[1, 2, undefined]`). PostgreSQL: describe
      "Postgres outbound sequence minting", "mints the next sequence again when another connection committed the one
      it read".
- [ ] **Step 2: Run red.** `npx vitest run packages/tests/shared/al-contracts/al-broadcast-ordering.test.ts
      packages/tests/shared/alm/outbound/al-outbound-sequence-minting.test.ts
      packages/tests/shared/alm/al-shared-key-arbitration.test.ts
      packages/tests/shared/services/ws-queue-box-server-outbound-planning.test.ts`: 12 failed, 24 passed; e.g.
      `TypeError: toALSequenceMintTrackKey is not a function`, `expected undefined to be 1`, `expected undefined to be 4`,
      `expected { orderingKey: 'game-1' } to deeply equal { orderingKey: 'game-1', epoch: 1 }`.
- [ ] **Step 3: Implement** (contract, track key, key, head row, plan field, DTO, read, mutation, compute, retained
      unminted request and its minting replay, comparisons, the planner, README). Green: 36 passed.
- [ ] **Step 4: Verify.** `npx vitest run packages/tests/shared/alm packages/tests/shared/services
      packages/tests/shared/al-contracts packages/tests/shared/ws-server-qos-policy.test.ts
      packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts` (153 files,
      1734 tests; the four pins inside, unedited). `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/
      tsconfig.json --noEmit`; `node scripts/check-tests-typecheck.mjs`; `deno check` on the 15 changed
      `packages/shared/**` files; `cd apps/api-v1 && deno task check`, then `rm -rf apps/api-v1/node_modules/.deno`; the
      PostgreSQL file compiles and skips: `npx vitest run --config
      packages/tests/shared-server/vitest.postgres-integration.config.mjs
      packages/tests/shared-server/integration/postgres/al-outbound-supersedence.test.ts` (2 skipped); the controller
      runs `npm run test:postgres:integration`. Bundles (private `TMPDIR`): facade 239.702 KiB (base 239.315) of 240,
      headless 304.841 (base 304.489) of 305; API snapshot unchanged. `npx dprint fmt` on touched files only.
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- 9e5c4bf38 HEAD` (PASS), `node
      scripts/check-test-structure-coupling.mjs --changed 9e5c4bf38 HEAD` (PASS), `npm run check:test-reachability` (1760 test files, 1754 reached by CI, 6 manual).

```text
Mint the WS server's own sequences at its outbound admission

A room broadcast's ordering option takes the key, an optional epoch and an
optional sequence, and the builder writes the epoch it is given. A message
the WS server publishes itself that names a key without a sequence is
sequenced by the server's outbound: the server's planner marks the plan
mintsSequence at admission and only for its own peer id, so a relayed
browser send that carries the group key and no sequence passes through
unsequenced. An admission of a marked plan with no sent row reads the
track's ordering head in the session that reads the sender version, stamps
head + 1 on the message, and commits the head beside the canonical row,
the sent row and the ordering index under the sender-version fence; a
repeated admission of the msgId keeps the stored sequence. The sequence
belongs to the attempt that commits: a commit that loses the fence retains
its pending admission with the unminted request and the captured
mintsSequence, and the work queue's replay mints when it commits, replacing
the retained request in the canonical row. The head row expires as the sent
row does. The canonical-reuse and planned-message checks accept a minted
sequence on a request that named none, and the admission's supersedence
observation reads the planned message. The outbound README states the rule.

D8 reuse: the sender-version fence, the pending-admission replay, the outbound mutation vocabulary, the message-row retention formula and the frozen-audience comparison pattern carry the mint; the track key shares toALOrderingTrackKey's formula.
```

### Task 2: Server-side range repair of a server track, proven at the server (D153)

**Files** (anchors at Task 1's commit, this task's parent; the prototype is `final-patch-task-2.patch`)

- Create `packages/tests/shared/services/ws-queue-box-server-ordered-repair.test.ts` (323 lines). A sibling file, not
  `ws-server-qos-policy.test.ts` (977 lines, a real-timer engine and a fixed `group-1` resolver): the cases need a
  mocked clock, a manual `InboxOutboxEngine`, a frozen audience and the outbound diagnostics/settlement sinks — the
  shape of `ws-queue-box-server-originated-receipt.test.ts:262-305`, which tests the server's own room notifications
  in this folder. Instance: sockets `a`, `b`, `c` (`SimulatedWebSocket`), `name: 'server'`,
  `forwardsRoomScopedMessages: false`, in-memory outbound stores over the outbox, `outboundDiagnostics` collecting
  `control-admission` events, `outboundSettlements` collecting settlements. Events: `newALBroadcastMessage('server',
  newALRoute('room.round.event', 'room-1', msgId), 'room', 'round.event.v1', { msgId }, { groupRef, reliability:
  'at-least-once', ack: 'receiver', ttlMs: 60_000, ordering: { orderingKey: 'game-1', epoch: 1 } })` with
  `msgId = event-<n>`, enqueued with `{ admittedAudience: ['a', 'b'], recipientScope: undefined }`; NACKs and ACKs
  enter through the socket (`socket.receive(JSON.stringify(control))`), addressed `toPeerId: 'server'`, ranged NACKs
  name `orderingKey: 'game-1:server:1'`, `expectedSeq` = the first range's `from`.
- Modify `packages/tests/shared/ws-qos-policy.test.ts`: two cases before `:695` ("admits an at-least-once send that
  requests no durability…"); before `groupRef` (`:818`) the helpers `serverRoundEvent(seq)` (sender `'server'`,
  `ordering: { orderingKey: 'game-1', epoch: 1, seq }`, msgId `round-event-<seq>`) and `readSentNacks(sent):
  readonly ALNackPayload[]` (`decodeALControlMessage(...).right`, `type === 'nack'`); imports `decodeALControlMessage`,
  `type ALNackPayload` (`al-control.ts`) and `type ALInboundResyncRequired` (`al-inbound-resync-required.ts`).
- Modify `apps/api-v1/test/services/ws-room-authority-delivery.test.ts`: one `Deno.test` before
  `createRoomDeliveryHarness` (`:423`); before `addRecordingConnection` (`:474`) the helpers
  `serverTrackNotice(serverPeerId, noticeId)` (route `room.notice`, type `notice.v1`, `ordering: { orderingKey:
  'notice-track', epoch: 1 }`, receiver ack, 60 s TTL; an arbitrary key, not Relic's) and `readNoticeOrderings(frames)`.
- Modify `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-publish-result.ts:29-43`:
  `toRallarServerWsOutboxPublishResult(fanout, result)` drops its `message` parameter and returns
  `message: result.message`; `publish-rallar-server-ws-message.ts:136` calls it as
  `toRallarServerWsOutboxPublishResult(input.fanout, result)` (R-R2b-20).
- Modify `publish-rallar-server-ws-message.ts` (R-R2b-22): import `toALSequenceMintTrackKey` (`al-runtime.ts`) after
  `:1`; in `publishAuthorizedRallarServerWsMessage`, after the scope check (`:92-94`) and before the `none` branch
  (`:95`), `if (isUnmintedServerSequence(input)) return toFailedPublishResult(input, 'A server publication that names
  an ordering key without a sequence needs the outbox fanout, which mints it.');`; before `toFailedPublishResult`
  (`:162`) the private `isUnmintedServerSequence(input)` = `input.fanout !== 'outbox' && input.message.id.senderId ===
  input.service.name && toALSequenceMintTrackKey(input.message) !== undefined`, with the one-line doc "Only the outbox
  admission mints the server's own sequence; any other fanout would send the keyed message unsequenced." The refusal
  is the router's existing `status: 'failed'` result (`toFailedPublishResult`, as the room-publication refusals at
  `:101-109`); a relayed sender's keyed send (R-R2b-1) and a server message that states its `seq` pass as before.
- Modify `packages/tests/shared-server/rallar-system/websocket/router/rallar-server-ws-fanout-carrier.test.ts`: after
  `QosCase` (`:45`) `const UNMINTED_SEQUENCE_REASON` (the reason above); `createRoomBroadcast` (`:288`) gains a fourth
  optional `ordering?: Readonly<{ orderingKey: string; epoch: number; seq?: number; }>` passed to the builder; before
  `createCarrierFixture` (`:241`) a describe "a keyed server publication without a sequence" (see Step 1).

**Interfaces.** Consumes Task 1: the planner's `mintsSequence` at `phase: 'immediate'`, `result.message` of
`enqueueOutboxIfAbsent` carrying the minted sequence, the sent row's `orderingTrackKey`/`orderingSeq`. Produces:
`RallarServerWsPublishResult.message` of an `outbox` publish is the admitted message (minted `seq` included); a
`live-only` or `none` publish still returns the caller's message; a server-own keyed publication without `seq` on
`live-only` or `none` is `{ status: 'failed', reason: UNMINTED_SEQUENCE_REASON }` and sends nothing.

**D8 reuse inspection.** Nothing new serves server tracks: control admission
(`validate-al-outbound-control-admission.ts:46-54`, expected peer `:122-125`, hints `:127-147`), the repair authority
(`al-outbound-repair-admission.ts:120-153`, which asks the server planner), the planner's audience filter
(`ws-queue-box-server-outbound-planning.ts:240-280`, `eligibleRequested` `:249`), the paged retransmission
(`al-outbound-repair-retransmission.ts:79-104`, page 32 + one follow-up hint) and the relay-rejection settlement
(`control/resolve-al-outbound-relay-rejection.ts:22-24`). The fixture copies the originated-receipt instance shape and
R1's page grouping (`al-outbound-repair-paging.test.ts:45-57`); the publish result reads the field the enqueue result
already has; the refusal reuses `toFailedPublishResult`, the router's existing failed publish, and Task 1's
`toALSequenceMintTrackKey`, the mint's own predicate, so the router refuses exactly what only the outbox would mint.

- [ ] **Step 1: Write the tests** (copy from the patch). Server file, describe "the WS server repairs its own ordered
      publication", six cases:
      1. "sequences its keyed publications 1, 2, 3 for the audience it admitted them to": `result.message.ordering` of
      three publications `= { orderingKey: 'game-1', epoch: 1, seq: n }`; `a` and `b` frames `[1, 2, 3]`, `c` `[]`.
      2. "admits a gap NACK from a peer the receipt expects and retransmits the missing sequence to that requester
      alone": `b` NACKs `event-3` `gap` `[{ from: 2, to: 2 }]`; poll `b` → `[1, 2, 3, 2]`; one `control-admission`
      `{ targetMsgId: 'event-3', outcome: 'committed', reason: 'none' }`; `a` `[1, 2, 3]`, `c` `[]`.
      3. "serves a gap wider than one repair page in two ascending pages, to the requester alone": 35 events; `a` ACKs
      all 35; `b` NACKs `event-35` `[{ from: 1, to: 34 }]`; poll (clock `+= 250` per pass, 5 s timeout) until 34
      repair sends; pages (sent `attempt-settled` whose attempt id names `repair-hint:…:b:…:<ranges>:`) `=
         [{ hint: '1-34', seqs: 1..32 }, { hint: '33-34', seqs: [33, 34] }]`; `b`'s frames 36–69 `= 1..34`; `a` `1..35`.
      4. "retransmits nothing for a gap NACK that arrives after the message deadline": clock `+= 60_000`, `b`'s gap
      NACK → `control-admission` `outcome: 'not-handled'`; `a`, `b` stay `[1, 2, 3]`.
      5. "does not handle a gap NACK from a session that joined after the publication, and sends it nothing": `c` NACKs
      `[{ from: 1, to: 2 }]` → `outcome: 'not-handled'`; `a`, `b` `[1, 2, 3]`, `c` `[]`.
      6. "ends the whole receipt of a message one receiver NACKs resync-required, so no recipient is retried": `b`
      NACKs `event-3` `resync-required` → settlement `{ kind: 'relay-rejected', msgId: 'event-3', relayRejection:
         { relay: 'peer', peerId: 'b', reason: 'resync-required' } }`; clock `+= 2_000` → `a` and `b` read
      `[1, 2, 3, 1, 2]` (no retry of 3); no `receipt-exhausted` for `event-3`.
      Client: "buffers a gap on a server track, NACKs the server for it and delivers the track in order" (seq 2 →
      one NACK `{ msgId: 'round-event-2', fromPeerId: 'self', toPeerId: 'server', reason: 'gap', orderingKey:
      'game-1:server:1', missingRanges: [{ from: 1, to: 1 }] }`, nothing delivered; seq 1 → `[1, 2]`); "hands a
      server track that needs resynchronization to the recovery owner with the server as its sender" (`onResyncRequired`
      on the service; seq 258 → cursor `{ orderingKey: 'game-1', senderId: 'server', epoch: 1, lastContiguousSeq: 0,
      expectedSeq: 1, observedSeq: 258, carrier: 'ws' }`; one NACK `resync-required` to `server`). api-v1: "a server
      publication that names an ordering key is published with the sequence its outbound minted, and delivered with
      it" (two `router.publish({ message, fanout: 'outbox' })`; results `['queued-outbox', { orderingKey:
      'notice-track', epoch: 1, seq: 1 | 2 }]`; `alice` and `bob` frames carry seqs 1, 2). Router (sender
      `server-1`, `ordering: { orderingKey: 'track-1', epoch: 1 }`): "is refused on a $fanout fanout (cluster
      $cluster) and sends nothing" over `live-only`/false, `live-only`/true, `none`/false (`status: 'failed'`, the
      caller's message, `reason` the constant, no notice, no frame); "is admitted on the outbox fanout with the sequence
      the server minted" (result and sent row `seq: 1`); "leaves a live-only publish from $sender with ordering
      $ordering as it came" for `server-1` with `seq: 4`, `alice` without `seq`, `server-1` without ordering (`sent-live`,
      the frame's ordering equals the message's).
- [ ] **Step 2: Run.** `npx vitest run packages/tests/shared/services/ws-queue-box-server-ordered-repair.test.ts
      packages/tests/shared/ws-qos-policy.test.ts` → 21 passed: the eight vitest cases are green on arrival (they pin
      Task 1's mint and the existing repair machinery; without the planner's mint all six server cases fail, e.g.
      `expected [ undefined, undefined, undefined ] to deeply equal [ 1, 2, 3, 2 ]`). Red:
      `cd apps/api-v1 && deno test --allow-env --allow-read test/services/ws-room-authority-delivery.test.ts` → 1
      failed, 14 passed: `AssertionError … + seq: undefined - seq: 1` (the publish result returns the caller's copy).
      `npx vitest run packages/tests/shared-server/rallar-system/websocket/router/rallar-server-ws-fanout-carrier.test.ts`
      → 3 failed, 17 passed (`expected { fanout: 'live-only', … } to match object { …, status: 'failed' … }`).
- [ ] **Step 3: Implement** the publish-result change and the refusal. Green: the Deno file 15 passed; the router file
      20 passed.
- [ ] **Step 4: Verify.** `npx vitest run packages/tests/shared/services packages/tests/shared/alm
      packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared/ws-server-qos-policy.test.ts
      packages/tests/shared-server/rallar-system packages/tests/shared-server/queue-pubsub` (485 files, 3974 tests,
      12 skipped; the four pins inside, unedited; `outbound-delivery-settlements.test.ts`'s IndexedDB case can time out
      under the sweep's load and passes alone); `cd apps/api-v1 && deno test --allow-env --allow-read --allow-write
      "--allow-run=$(deno eval 'console.log(Deno.execPath())')" test/services/
      test/composition/create-api-v1-ws-live-publication.test.ts test/ws-routes.test.ts` (131 passed); `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json
      --noEmit`; `node scripts/check-tests-typecheck.mjs`; `deno check` on the two changed shared-server files;
      `cd apps/api-v1 && deno task check`, then `rm -rf apps/api-v1/node_modules/.deno`. No `packages/shared` source
      changes: no bundle check. `npx dprint fmt` on the six files only.
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- 9e5c4bf38 HEAD` (PASS), `node
      scripts/check-test-structure-coupling.mjs --changed 9e5c4bf38 HEAD` (PASS), `npm run
      check:test-reachability` (1761 files, 1755 CI, 6 manual).

```text
Prove the WS server's range repair of its own ordered publications

A keyed server publication is sequenced 1, 2, 3 for the audience it was
admitted to. A receiver the pending receipt expects NACKs a gap addressed
to the server and gets the missing sequence retransmitted to it alone; a
gap wider than one repair page is served from the ordering index in two
ascending pages, 32 then the follow-up hint's rest; a gap NACK past the
message deadline, or from a session that joined after the publication, is
not handled and sends nothing; one receiver's resync-required NACK ends
the whole receipt, which the server states relay-rejected. The WS client
NACKs the server for a gap on a server track, delivers the track in order,
and hands a track that needs resynchronization to its recovery owner with
the server as the sender. An outbox publish through the server router now
returns the message its outbound admitted, so the caller reads the minted
sequence that the delivered frames carry. Only the outbox admission mints,
so the router refuses, as a failed publish, a server publication that
names an ordering key without a sequence on any other fanout instead of
sending it unsequenced.

D8 reuse: the server's existing control admission, repair planner and paged retransmission serve server tracks unchanged; the publish result reads the enqueue result's admitted message, and the refusal is the router's existing failed publish result.
```

### Task 3: The Relic server publishes its round transitions on a track per round (D151, R-R2b-11)

Prototype: `final-patch-task-3.patch` (one commit on Task 2's commit, this task's parent; 14 files, +446/−47; Tasks 1
and 2 touch no Relic file, so every anchor below holds there). Needs only Task 1's broadcast-builder
option `ordering: { orderingKey, epoch?, seq? }`; the WS server mints the sequence because the Relic server publishes
with the server's own peer id (`rallar.ws.serverPeerId`, R-R2b-1).

**Files**

- Create `apps/relic-hunter-server-v1/src/to-relic-round-transition-message.ts` (82 lines).
- Modify `apps/relic-hunter-server-v1/resources/relic-hunter-server-v1-openapi.yaml` (`RelicPublicSnapshot`: required
  `createdAtEpochMs`, `integer`/`int64`, after `maxRounds`), and add `createdAtEpochMs: 1,` after `maxRounds: 10,` in
  the snapshot literals of `apps/relic-hunters-v1/tests/{scene-cost,camera-modes,relic-scene-next-model,scene-movement,
  relic-snapshot-ordering,lighting-presets,scene-networking}.test.ts` and `tests/playwright/relic-hunters/web.spec.ts`.
- Modify `apps/relic-hunter-server-v1/src/relic-game-service.ts` (publication, comment at `:158`),
  `apps/relic-hunter-server-v1/src/apply-relic-ws-command.ts` (`:64`, the warning text),
  `packages/relic-hunters/src/model.ts` (event type; touched-file closure of its guards),
  `apps/relic-hunter-server-v1/test/relic-server-service.test.ts`.

**Interfaces**

- **The track key (one owner, R-R2b-11):** `model.ts` gains `createdAtEpochMs: number` on `RelicPublicSnapshot` (after
  `maxRounds`), copied by `toPublicRelicSnapshot` and required by `isRelicSnapshot` (`isFiniteNumber`), and, before
  `toPublicRelicSnapshot`, `export function toRelicRoundTrackKey(game: Pick<RelicPublicSnapshot, 'gameId' |
  'createdAtEpochMs'>): string { return \` ${game.gameId}:${game.createdAtEpochMs}\`; }`(doc: the key names the
  incarnation of the game; a reset keeps the id and starts new tracks).`RelicGameState`satisfies the`Pick`; the server and the
  client both call it, nothing else formats the key.
- `model.ts`, right after `RelicServerEvent` (`:274-278`):
  `export type RelicRoundTransition = 'round-started' | 'round-resolved' | 'review-continued' | 'finished';` and
  `export interface RelicRoundTransitionEvent { readonly protocolVersion: typeof RELIC_PROTOCOL_VERSION; readonly gameId: string; readonly round: number; /** The phase the transition entered. */ readonly phase: RelicGamePhase; readonly transition: RelicRoundTransition; /** The message of the event the rules append for the transition. */ readonly text: string; }`
  (no apostrophe in any comment of this file: the checker's quote stripper is comment-unaware).
- The builder module exports `RELIC_EVENT_TTL_MS = 60_000` (doc: "How long a round transition stays deliverable and
  repairable: the default round time limit."), `toRelicRoundTransitionEvent(previous: RelicGameState, next:
  RelicGameState): RelicRoundTransitionEvent | undefined` and `toRelicRoundTransitionMessage(state: RelicGameState,
  event: RelicRoundTransitionEvent, serverPeerId: string): ALMessage`.
- **The derivation (the phase change, not the event list):** a private table
  `RELIC_ROUND_TRANSITION_RULES: Readonly<Partial<Record<RelicPhaseChange, RelicRoundTransitionRule>>>` with
  `type RelicPhaseChange = \` ${RelicGamePhase}:${RelicGamePhase}\``and`interface RelicRoundTransitionRule { readonly transition: RelicRoundTransition; readonly eventType: RelicEventType; }`:`'lobby:planning'`→`round-started`/`round_started`;`'planning:review'`→`round-resolved`/`action_revealed`;`'review:planning'`→`review-continued`/`round_started`;`'review:finished'`→`finished`/`game_finished`. The event
  is`{ protocolVersion: next.protocolVersion, gameId: next.gameId, round: next.round, phase: next.phase, transition,
  text: next.events.findLast((event) => event.type === rule.eventType)?.message ?? '' }`; any other phase pair is`undefined`. Why not the emitted events: a repeated`start-expedition`appends a`round_started`event with no phase
  change (`rules.ts:202-223`), and`toEvent`defaults an untyped event to`round_started`(`rules.ts:1271`).
- The message: `newALBroadcastMessage(serverPeerId, newALRoute(RELIC_TOPICS.event, state.roomId,
  \` ${event.gameId}:${event.round}\`), 'room', RELIC_TYPES.event, event, { groupRef: { applicationId:
  DEFAULT_STATE_APPLICATION_ID, workspaceId: DEFAULT_STATE_WORKSPACE_ID, groupId: state.roomId }, reliability:
  'at-least-once', ack: 'receiver', ttlMs: RELIC_EVENT_TTL_MS, ordering: { orderingKey: toRelicRoundTrackKey(state),
  epoch: event.round } })`— no`seq`.
- `relic-game-service.ts`: a private `publishCommandResult(previous, next)` (doc: "The snapshot first, then the round
  transition the command made, if it made one.") awaits `publishSnapshot(next)`, then, when
  `toRelicRoundTransitionEvent(previous, next)` is defined, `rallar.ws.publish({ message:
  toRelicRoundTransitionMessage(next, transition, rallar.ws.serverPeerId), fanout: 'outbox' })`. In
  `applyAndPublishCommand` (`:136-140`) the `try` calls `publishCommandResult(previous, result.state)`; a throw from
  either publication stays `publishFailure` (the `applied-not-published` value). `reset` (`:212-220`) and
  `ensureSnapshot` publish no event. Replace the two comment lines at `:158-159` with
  `// The browser sends commands over WebSocket and falls back to REST only before it knows the server's peer id.`
- `apply-relic-ws-command.ts:64`: the warning becomes `` `${subject} was applied, but its publication failed.` ``.
- **Touched-file closure of `model.ts`** (the changed-style gate retains every `boundary.unknown` finding of a touched
  file, and `file.cognitive-load` must stay below the warn tier 50; base 45): add after `isRelicCharacterId`
  `function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T { return typeof value ===
  'string' && options.some((option) => option === value); }`; rewrite `isRelicGamePhase`, `isRelicRoomKind`,
  `isRelicRoomInvestigationEffect`, `isRelicEventType`, `isRelicAnimationCueType`, `isRelicActionKind` each as
  `return isOneOf<RelicX>(value, [<the same literals, same order>]);` (one-line signatures),
  `isRelicCharacterId` as `return isOneOf(value, RELIC_CHARACTER_IDS);`, and `isRecord`'s predicate as
  `value is ApiJsonObject` with `import type { ApiJsonObject } from '@shared/api/api-json-value.ts';` (blank line, then
  the relative import). Measured: 0 `boundary.unknown` findings, cognitive load 39.
- Test file closure: `TopicDefinition.validate(value: JsonWireValue, …)` with `import type { JsonWireValue } from
  '@shared-server/rallar-system/protocol/json-wire-identity.ts';` (its `unknown` was the file's one finding).

**D8 reuse inspection.** The snapshot builder's broadcast/group-ref/receipt options (`to-relic-snapshot-message.ts`),
the rules' own phase changes and event messages, the service test's fake rallar (extended, not copied). No sequence is
minted here (Task 1 owns minting).

- [ ] **Step 1: Tests.** In `relic-server-service.test.ts`: a `ROOM_ONE_GROUP_REF` constant (default application and
      workspace, `room-1`); `interface FakePublishFailure { readonly error: Error; /** The one topic whose publications
      fail; undefined fails every publication. */ readonly topicId: string | undefined; }` and
      `createFakeRallar(publishFailure: FakePublishFailure | undefined = undefined)` rejecting when `topicId` is
      undefined or equals `publication.message.route.topicId`; helpers `startCommand`, `searchCommand` (`submit-action`
      `{ kind: 'search' }`), `toPublishedTopicId`, `isRoundEvent`, and `toPublishedRoundEvent` returning
      `interface PublishedRoundEvent extends Pick<RelicRoundTransitionEvent, 'round' | 'phase' | 'transition' | 'text'>
      { readonly resourceId: string; readonly orderingKey: string | undefined; readonly epoch: number | undefined; }`.
      The test initial state is `createRelicGame(gameId, gameId, 1)`, so the key is `'room-1:1'`. The existing snapshot-failure case passes
      `{ error: new Error('outbox admission failed'), topicId: undefined }` and expects the new warning text. New cases:
  - `'ends a WebSocket command whose round event publish fails after its snapshot as applied, not published'` (join,
    then a WS start with the event topic failing): phase `planning` stored, topics `[snapshot, snapshot]`, one warning
    `[relic] WS command from alice-session was applied, but its publication failed.` with `event admission failed`.
  - `'publishes a started round right after its snapshot as an ordered, receipted event on the game\'s track for the
    round'`: topics `[snapshot, snapshot, event]`; `published[2]` `toMatchObject` `{ fanout: 'outbox', message: { id:
    { senderId: 'relic-server' }, route: { topicId: RELIC_TOPICS.event, contextId: 'room-1', resourceId: 'room-1:1' },
    payload: { typeId: RELIC_TYPES.event }, targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM_ONE_GROUP_REF },
    delivery: { reliability: 'at-least-once', ack: 'receiver' }, ordering: { orderingKey: 'room-1:1', epoch: 1 } } }`;
    `scope` and `ordering?.seq` undefined; expiry within `[before + 60 s, now + 60 s]`; `RELIC_EVENT_TTL_MS` 60 000;
    payload `toEqual` `{ protocolVersion, gameId: 'room-1', round: 1, phase: 'planning', transition: 'round-started',
    text: 'Alice started the expedition.' }`.
  - `'publishes the resolved round and the continued review on the tracks of their rounds, each after its snapshot'`
    (join, start, search, continue): topics `[s, s, e, s, e, s, e]`; round events (`orderingKey` `'room-1:1'` on each) `[{ 'room-1:1', 1, 1, planning,
    round-started, 'Alice started the expedition.' }, { 'room-1:1', 1, 1, review, round-resolved, 'Round 1 actions are
    revealed.' }, { 'room-1:2', 2, 2, planning, review-continued, 'Round 2 begins.' }]`.
  - `'publishes the finish on the last round\'s track'` (initial state `maxRounds: 1`): last event `{ 'room-1:1', 1, 1,
    finished, finished, 'The castle collapses as the expedition ends.' }`.
  - `'publishes no round event for a command or a reset that moves no phase'` (join, start, start, reset): topics
    `[s, s, e, s, s]`.
  - `'starts the rounds of a reset game on the tracks of its new incarnation'` (initial states created at 1 000 and
    2 000; join, start, reset, join, start): ordering keys `['room-1:1000', 'room-1:2000']`; the last snapshot's
    `createdAtEpochMs` is 2 000.
- [ ] **Step 2: Red.** `cd apps/relic-hunter-server-v1 && deno test --allow-env --allow-read test/relic-server-service.test.ts`
      → TS2307 (the module) and TS2305 (`RelicRoundTransitionEvent`). After the model type and the builder module:
      `FAILED | 0 passed (13 steps) | 1 failed (7 steps)`.
- [ ] **Step 3: Implement** as above. **Green:** `ok | 1 passed (20 steps)`; `deno task check` exit 0; the app's
      `deno test --allow-env --allow-read` → `ok | 6 passed (29 steps)`.
- [ ] **Step 4: Checks.** `npx tsc -p packages/relic-hunters/tsconfig.json --noEmit` and
      `npx tsc -p apps/relic-hunters-v1/tsconfig.json --noEmit` (0); `npx vitest run packages/tests/relic-hunters
      apps/relic-hunters-v1/tests` (31 files, 187 tests at this commit); `node scripts/check-tests-typecheck.mjs` (PASS);
      `npx dprint fmt <the five files>`; after the commit `npm run check:repo-style:changed -- 9e5c4bf38 HEAD` and
      `node scripts/check-test-structure-coupling.mjs --changed 9e5c4bf38 HEAD` (both PASS).
- [ ] **Step 5: Commit.**

```text
Publish Relic's round transitions on the game's ordered track per round

A command that moves the game's phase along a round (the lobby into the
first round, a round into its review, a review into the next round or the
finish) publishes a relic.event.v1 round-transition event on
room.relic.event right after its snapshot: the game's incarnation (its
id and creation time, toRelicRoundTrackKey) keys the ordering track, so a
reset starts new tracks; the round is its epoch, and no sequence is
stated, so the WS server's outbound admission mints it. The public
snapshot carries the creation time, so a client names the same key. The event is at-least-once,
receipted by every receiver and deliverable for 60 s, the default round
time limit; its text is the message of the rules' event that marks the
transition. A join, a repeated start and a reset publish none. A failed
publication after the write stays the applied-not-published value, whose
warning names the publication rather than the snapshot alone. The
service's note on the browser's command transport states WebSocket with
the REST fallback before the server's peer id is known. The Relic
model's enum guards share one isOneOf narrowing and its record guard
narrows to the shared JSON object type.

D8 reuse: the snapshot message's broadcast builder, room group ref and receipt options; the rules' own phase changes and event messages; the service test's fake rallar, extended to fail one topic.
```

### Task 4: The Relic client reads the ordered transitions and cues its phase banner from them (D152)

Prototype: `final-patch-task-4.patch` (one commit on Task 3's commit, this task's parent; 14 files, +744/−88). Line
anchors are at the plan base `9e5c4bf38` and hold at the parent: Tasks 1–3 touch none of the client files named by line;
the `model.ts` anchors are relative to Task 3's additions.

**The seam (one cue owner).** The live round-transition cue is the phase banner (`App.tsx:374-396` today, derived
from `game.snapshot.phase` changes through `prevPhaseRef`). It moves to the ordered stream. `scheduleReveal` over
`snapshot.events` (`App.tsx:276-314`, the event feed, its sounds and the tension beat) and the scene's review cue ids
(`RelicSceneNext.tsx:1875-1893, 2309`) read the snapshot's event history and stay unchanged. A mid-round joiner (or a
reloaded page) gets no banner for that round's remaining transitions unless the server repairs the round's track to it;
from the next round its track starts at sequence 1.

**Files**

- Create `apps/relic-hunters-v1/src/game/subscribe-relic-round-transitions.ts`,
  `apps/relic-hunters-v1/src/game/to-relic-phase-banner.ts`,
  `apps/relic-hunters-v1/tests/subscribe-relic-round-transitions.test.ts`, `apps/relic-hunters-v1/tests/to-relic-phase-banner.test.ts`.
- Modify `packages/relic-hunters/src/model.ts`, `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts`,
  `relic-snapshot-ordering.ts`, `useRelicHunters.ts`, `apps/relic-hunters-v1/src/App.tsx`,
  `apps/relic-hunters-v1/tests/relic-hunters-runtime.test.ts`, `packages/tests/relic-hunters/use-relic-hunters-auth-lifecycle.test.ts`,
  `packages/tests/relic-hunters/relic-web-app.browser.test.ts`, `tests/playwright/relic-hunters/full-stack-propagation.spec.ts`,
  `docs/test-structure-coupling-exceptions.md`.

**Interfaces**

- `model.ts`, right after `toRelicRoundTrackKey` (Task 3), the second half of the key's one owner (R-R2b-29):
  `/** A round track of any incarnation of the game: its key is the game id, a colon and a creation time. */ export
  function isRelicRoundTrackOfGame(orderingKey: string, gameId: string): boolean { const prefix = \` ${gameId}:\`;
  return orderingKey.startsWith(prefix) && /^\\d+$/.test(orderingKey.slice(prefix.length)); }`(the digits check keeps`room-10:…`out of`room-1`).
- `model.ts`: `export function isRelicRoundTransitionEvent(value: unknown): value is RelicRoundTransitionEvent` before
  `isRelicGamePhase`: `isRecord(value) && value.protocolVersion === RELIC_PROTOCOL_VERSION && typeof value.gameId ===
  'string' && isFiniteNumber(value.round) && isRelicGamePhase(value.phase) && isOneOf<RelicRoundTransition>(value.transition,
  ['round-started', 'round-resolved', 'review-continued', 'finished']) && typeof value.text === 'string'`.
- `subscribe-relic-round-transitions.ts`: `export interface RelicRoundTransitionSubscription { readonly onTransition:
  (event: RelicRoundTransitionEvent) => void; /** The receiver can no longer order the room's round transitions; the game is read again instead. */ readonly onResyncRequired: () => void; }`
  and `subscribeRelicRoundTransitions(facade: Pick<RallarFacade, 'messages'>, roomId: string, subscription):
  RallarUnsubscribe`: `roomRef` = default application/workspace + `roomId`;
  `facade.messages.room<RelicRoundTransitionEvent>({ topicId: RELIC_TOPICS.event, typeId: RELIC_TYPES.event, roomRef,
  purpose: 'notification', recovery: { onResyncRequired: (cursor) => { if
  (isRelicRoundTrackOfGame(cursor.orderingKey, roomId)) subscription.onResyncRequired(); } } })` (R-R2b-29: a track of
  any incarnation of the room's game hydrates, so a page that missed a reset snapshot catches up; another game's does
  not), returning `channel.onWs(...)` that hands on a payload only when
  `isRelicRoundTransitionEvent(payload) && payload.gameId === roomId` and a private `isRoomMessage(message, roomRef)`
  holds (`message.raw.targets` is a `broadcast`, scope `room`, with a `groupRef` that `isSameGroupRef` matches).
- `to-relic-phase-banner.ts`: `export interface RelicPhaseBanner { readonly text: string; /** The expedition's start: its own style, held longer. */ readonly start: boolean; readonly durationMs: number; }`
  and `toRelicPhaseBanner(event, lang: Lang)`: `round-started` → `{ UI[lang].phaseBannerPlanning, true, 4_000 }`;
  `review-continued` → `{ UI[lang].phaseBannerPlanning, false, 2_400 }`; `round-resolved` → `'Plans are revealed.'`;
  `finished` → `'The ruin falls silent.'` (both `false, 2_400`); constants `RELIC_PHASE_BANNER_MS`, `RELIC_START_BANNER_MS`.
- Runtime: deps gain `onRoundTransitionMessage(roomId: string, subscription: RelicRoundTransitionSubscription): () => void`
  (browser deps: `subscribeRelicRoundTransitions(rallar, roomId, subscription)`); exported
  `type RelicResyncHydration = Readonly<{ kind: 'hydrated'; snapshot: RelicPublicSnapshot | undefined; }> | Readonly<{ kind: 'failed'; error: string; }>`
  and `interface RelicRoundTransitionListeners { onTransition; onResyncHydration(hydration) }`; method
  `subscribeRoundTransitions(roomId, listeners)` passes `onTransition` through and wires `onResyncRequired` to
  `void this.readResyncHydration(roomId).then(listeners.onResyncHydration)` (private: `this.deps.fetchSnapshot(roomId)`,
  the REST read of `hydrateRoom` `:321-330`, caught into `failed`). `RelicRuntimeDiagnostics` gains required
  `roundTransitionCues: readonly string[]` (initial `[]`). Delete the exported `toErrorMessage` (`:416-418`); both its
  files use `toError(x).message` from `@shared/resilience/to-error.ts` (its `unknown` blocks the gate).
- `relic-snapshot-ordering.ts:3-10`: add source `'resync-recovery'`.
- Hook: `roundTransition?: RelicRoundTransitionEvent` on `RelicHuntersConnection` (doc: latest delivered, undefined
  until one arrives) and in the memo and its deps; state `roundTransition`; `ROUND_TRANSITION_CUE_LOG_SIZE = 16`;
  `acceptRoundTransition` sets it and appends `` `${event.round}:${event.transition}` `` to the cue log (`.slice(-16)`);
  `acceptResyncHydration` writes `lastError: \`Round transition resync failed: ${error}\``or`acceptSnapshotCandidate(snapshot, 'resync-recovery')`; an effect before`refreshRooms`subscribes`runtime.subscribeRoundTransitions(roomId, ...)`while`roomId && diagnostics.middlewareConnected`, cleaned up on change.
  Gate closure:`acceptSnapshotFromSource(next: RelicPublicSnapshot | undefined, source)`;`acceptWsSnapshot`/`acceptRtcSnapshot`take`event: RelicServerEvent`and pass`decodeRelicSnapshotPayload(event)`, a module function`(value: unknown): RelicPublicSnapshot | undefined`(server event's snapshot or the value, kept only if`isRelicSnapshot`).
- `App.tsx`: `phaseBanner` state is `RelicPhaseBanner | null`; delete `prevPhaseRef` and the effect at `:374-396`; new
  effect on `[game.roundTransition]` sets `toRelicPhaseBanner(game.roundTransition, lang)` and clears it after
  `durationMs`; JSX `:1296-1308` uses `phaseBanner.start` / `phaseBanner.text`; `:114` casts `window as Window & {...}`.

**D8 reuse inspection.** The typed room channel and its recovery-owner registry (`browser-typed-message-channels.ts:45-46`,
`browser-channel-recovery-owners.ts`), `isSameGroupRef`, the runtime's REST read and the snapshot acceptance path,
the shared `toError`, the facade double of `send-relic-ws-command.test.ts`. No new fetch.

- [ ] **Step 1: Tests (red).** Subscribe test (plain recorders, no mock counts — the coupling gate blocks those):
      `'subscribes the room\'s notification channel with a recovery owner for every incarnation of the room\'s game'` (definition `toEqual`
      the one above with `recovery: { onResyncRequired: expect.any(Function) }`; cursors `room-2:1000` and `room-10:1000` → 0 resyncs, then
      `room-1:900` and `room-1:1000` (two incarnations of the room's game) → 2;
      unsubscribe empties the handlers); `'hands on a round transition the server published to the room'`; `'drops a
  transition of another room, one whose game is not the room\'s, and a payload that is not a transition'` (the malformed
      one via `JSON.parse(JSON.stringify({ ...ROUND_STARTED, transition: 'round-paused' }))`). Banner test `'cues each
  transition the server ordered, the first round\'s start held longest'` (the four banners; `no` reads `UI.no`). Runtime
      test `'re-reads the room\'s game over REST each time its round-transition track needs resynchronizing'` (two resyncs:
      `fetchedRoomIds` `['room-1','room-1']`, hydrations `[{ hydrated, snapshot }, { failed, 'snapshot unavailable' }]`);
      `runtimeDeps` gains `onRoundTransitionMessage: vi.fn(() => () => undefined)`. Hook test `'cues the room\'s ordered round
  transitions and re-reads the game over REST when a track of any of its incarnations needs resynchronizing'` (mock `messages.room`; default
      `{ onWs: vi.fn(() => vi.fn()) }`; `roundTransition` and cue log `['1:round-started']`; the owner, given a cursor
      keyed `toRelicRoundTrackKey({ gameId: 'relic-room-1', createdAtEpochMs: 7 })` (another incarnation than the held one), → `fetchRelicSnapshot('relic-room-1')`,
      `lastSnapshotSource` `resync-recovery`, `updatedAtEpochMs` 21); its `{ payload: unknown }` becomes
      `Pick<RelicServerEvent, 'snapshot'>`. Browser test: `messages.room` mock recording `roundTransitionHandler`; its five
      `unknown`s become `MockWsMessage { payload: object; ... }`, `object`, `RallarWsSendInput<object>`; case `'cues a phase
  banner from the room\'s ordered round transition, not from a snapshot that moves the phase'` (lobby → planning snapshot:
      no `.phase-banner`; the transition → `.phase-banner.phase-banner-start` contains `The Hunt Begins!`).
      Red: `Tests  2 failed | 11 passed (13)` over the runtime/hook files, two files fail to import; the browser case fails
      on `toBeNull()` against the old effect.
- [ ] **Step 2: Implement.** Green: `npx vitest run packages/tests/relic-hunters apps/relic-hunters-v1/tests` →
      `Test Files  33 passed (33)`, `Tests  194 passed (194)`.
- [ ] **Step 3: Coupling registry.** The touched hook test's `expect(mockRallar.auth.logout).not.toHaveBeenCalled();`
      (`test-structure-coupling-a8b22d69e6c0d234`) needs a contract `relic-unauthorized-auth-change-never-logs-out`
      (absence, port `rallar.auth logout`) after `relic-ws-command-never-repeated-over-rest` and an entry after its entry —
      copy both blocks from the patch.
- [ ] **Step 4: Playwright (manual, not run here).** `RuntimeHook.diagnostics` gains `roundTransitionCues`; the converge
      test asserts `expectRoundTransitionCues(pageA, pageB, ['1:round-started'])` after the start and
      `[..., '1:round-resolved', '2:review-continued']` after round 2 converges; after the reload both submit, converge on
      round 3 (`minEventCount: 5`), and `expectCuesResumedAfterReload` holds: the page that stayed ends with
      `['2:review-continued', '2:round-resolved', '3:review-continued']`; the reloaded page ends with `3:review-continued`
      and its log is an in-order subsequence of those three (its round 2 depends on the server repairing that track for it).
      Run: `npm run test:playwright:relic:full-stack`.
- [ ] **Step 5: Checks.** `npx tsc -p apps/relic-hunters-v1/tsconfig.json --noEmit`; `npx tsc -p
  packages/relic-hunters/tsconfig.json --noEmit`; `cd apps/relic-hunter-server-v1 && deno task check` and its tests
      (`ok | 6 passed (29 steps)`); `node scripts/check-tests-typecheck.mjs` (PASS; it does not cover `apps/*/tests` or
      `tests/playwright`, so typecheck those ad hoc); `npx dprint fmt <files>`; after the commit the changed-style and coupling
      gates from the plan base, `9e5c4bf38 HEAD` (PASS; coupling `all 23 current ... candidates are individually classified`) and
      `npm run check:test-reachability` (`1763 test files, 1757 reached by CI, 6 manual`).
- [ ] **Step 6: Commit.**

```text
Cue Relic's phase banner from the room's ordered round transitions

The browser reads the room's round transitions through a typed room
notification channel on room.relic.event whose recovery owner, for a
track of any incarnation of the room's game (isRelicRoundTrackOfGame,
beside the key's formatter), reads the game again over the REST read a
room's hydration uses, and accepts that snapshot as a resync-recovery
source. A transition is handed on only when
it is a valid relic.event.v1 payload of the room's game, published to the
room's group. The hook exposes the latest transition and a bounded cue log
in its diagnostics; the phase banner (the expedition's start, the revealed
plans, the next round, the finish) is cued from those transitions alone,
no longer from the snapshot's phase changes, so it has one owner and
follows the server's order. The snapshot and its event list stay the
state and the history the scene and the event feed read. A browser that
joins or reloads mid-round cues from the next round on. The snapshot
payload is decoded at the hook's boundary and the runtime's private
error message helper gives way to the shared toError. The full-stack
Playwright case asserts the cues in order on both pages and their
resumption after a reload.

D8 reuse: the typed room channel and its recovery owner registry, isSameGroupRef, the existing REST snapshot read and acceptance path, the shared toError, the send test's facade double.
```

### Task 5: Docs — server-sequenced tracks and Relic's round transitions (D150–D155)

Prototype: `final-patch-task-5.patch` (one commit on Task 4's commit, this task's parent; 5 files, +145/−16, docs only;
R-R2b-11, R-R2b-20..23 and R-R2b-31 folded in). It is the exact text: apply it with
`git am -3 final-patch-task-5.patch` (in the controller's R2b plan directory,
`/private/tmp/claude-501/-Users-knuthelge-ProjectLocker-github-ar-eye-hunter--claude-worktrees-busy-bassi-3ddde3/c50eb2cc-1da6-4e01-aa95-6d02a8b4b538/scratchpad/r2b-plan`) on Task 4's commit, where it applies cleanly; if a hunk does not apply,
replay that hunk by its text anchor below. Then run the "true of the code" checks, which
are the only part that can fail.

**Files (text anchors; line numbers are at Task 4's commit, this task's parent)**

- Modify `docs/rallar-api-reference.md`, section `### Ordering, Repair And Resynchronization` (`:838`):
  - First paragraph (`:840-841`): "A send states its position …" becomes "A browser send states its position with
    `orderingKey` and `seq` together, or neither (`RallarRtcSendInput`, `RallarWsSendInput`): a browser's sequence is
    client-assigned; a server publication's is minted by the server (below)." The rest of the paragraph is rewrapped,
    not reworded.
  - Second paragraph (`:851-852`): "The hop that keeps the sender's ordering track" → "The hop that keeps a browser
    sender's ordering track" (over WS the server keeps a browser's track; a server track's hop is the WS client).
  - After the recovery-owner paragraph that ends "reload invokes the owner once more for the same track." (`:900`) and
    before `### Membership Fencing`, three paragraphs and one `ts` block, no new heading:
    1. A server publication states `orderingKey` and `epoch` and no `seq` in its `ordering` option and publishes with
       `ws.publish` at `fanout: 'outbox'`; the WS server's outbound admission assigns the sequence and the publish
       result's message carries it; a keyed `live-only` publish without `seq` is refused (only the outbox mints); the track is (ordering key, server peer
       id, epoch, `0` when absent); the first message gets `seq` 1, each later one the next, assigned in the commit
       that admits it, so it is contiguous whichever instance publishes and continues after a restart; the same
       `msgId` keeps its first sequence; a server publication that states its own `seq` keeps it.
    2. The server repairs its own publications from its sent copies: the WS client admits server frames as the
       trusted server's, orders the track with the server peer id as sender, NACKs a gap of an at-least-once
       publication to the server; the server serves a requester inside the admitted audience that the gap-revealing
       message's receipt still expects, so a sequenced server publication asks `ack: 'receiver'` (`ack: 'none'` gets
       no ranged repair; a later joiner is never sent it); it resends to that requester alone, `repairPageMessages`
       (32) per round, until the deadline; the budget is per message and shared (the first NACKing receiver spends
       `maxRepairs`, others fall back to receipt retries); a spent budget settles `skipped`/`repair-exhausted` once;
       a `resync-required` NACK settles `relay-rejected` (`{ relay: 'peer', peerId, reason: 'resync-required' }`) and
       removes the whole pending receipt; the receiver invokes
       the owner of the typed channel the publication's topic and type name, the cursor's `senderId` is the server peer
       id; a new epoch is a new track and re-arms the owner.
    3. "Relic Hunters publishes its round transitions this way." — `relic.event.v1` on `room.relic.event`, key = the game's
       incarnation (id and creation time, since a reset keeps the id), epoch = round; the `ts` block is the frame's `newALBroadcastMessage(rallarServer.ws.serverPeerId,
       newALRoute(RELIC_TOPICS.event, roomId, \` ${gameId}:${round}\`), 'room', RELIC_TYPES.event, event, { groupRef,
       reliability: 'at-least-once', ack: 'receiver', ttlMs: RELIC_EVENT_TTL_MS, ordering: { orderingKey:
       \`${gameId}:${createdAtEpochMs}\`, epoch: round } })`then`await rallarServer.ws.publish({ message, fanout: 'outbox' })`; the browser reads it
       through`messages.room<T>(...)`, purpose`notification`, a`recovery`owner that re-reads the game over REST
       (`GET /api/relic/games/:gameId`); a browser joining during a round reads that round's state from the snapshot
       and its first ordered transition at the next round.
  - Server SDK list (`:1850`): the `ws.publish({ message, scope?, fanout? })` bullet appends "; a message whose
    `ordering` states `orderingKey` (and `epoch`) without `seq` is sequenced by the server at `outbox` admission and refused at `live-only` (see "Ordering, Repair
    And Resynchronization"); an `outbox` publish result's message is the admitted one and carries the minted `seq`,
    while a `live-only` or `none` publish returns the caller's message".
- Modify `packages/shared/alm/inbound/README.md`, "**Ordering gaps and resynchronization.**", after "diagnostics
  state the refusal." (`:427`): the WS client admits server frames as `trusted-server`; a sequenced server publication
  is ordered on `<orderingKey>:<serverPeerId>:<epoch>` (`default-qbox-server` in api-v1 and the Relic server); its gap
  NACK and repair request go to the server (a `trusted-server` source's `fromPeerId` is the message's `senderId`),
  which repairs its own publication (D153); the owner is the typed channel the topic and type name (D142); Relic's
  round-transition channel is one (D152).
- Modify `packages/shared/alm/outbound/README.md`, the opening repair-owners paragraph, after "retransmits the missing
  ranges along that hop." (`:29`): the WS server repairs its own publications through its repair planner — a WS
  client's gap NACK on a server-minted track pages the missing sequences from the ordering index and resends each to
  that requester alone, only inside the audience the resent message was admitted to and still expected by the
  gap-revealing message's receipt (so `ack: 'receiver'`; `ack: 'none'` gets no ranged repair) (D43, D153); the budget
  is per message (first requester spends it, others fall back to receipt retries); only `outbox` mints, a keyed
  `live-only` publish without a sequence is refused; Relic Hunters' round
  transitions are the consumer: one track per round, the game's incarnation `${gameId}:${createdAtEpochMs}` as key
  (a reset keeps the id), round epoch (D151). Task 1's "Server-minted
  sequences" text stays Task 1's; do not repeat the minting rule here.
- Modify `playground/alm/alm-complete-product-description.md`:
  - "## Ordering and gap recovery", after the `**CURRENT — R1, range repair and resync integration:**` paragraph
    (`:525-536`): a `**CURRENT — R2b, server-sequenced tracks:**` paragraph (D24 narrowed, D150; the head row, the fence,
    contiguity, restart, msgId; server repair to the requester inside the admitted audience that the triggering receipt still
    expects, so `ack: 'receiver'` and `outbox`; `live-only` keyed refused, `ack: 'none'` unrepaired; 32 per page, until
    the deadline; the shared per-message budget; `skipped`/`repair-exhausted` (D141, D153); one receiver's
    `resync-required` settles `relay-rejected` and removes the whole receipt (D155); the typed channel's owner; the proofs; no conformance cell
    (D155)).
  - "## Delivery and compatibility posture", after the paragraph ending "the admission schema bump (D101)." (`:911`):
    the Relic Hunters paragraph (commands WS unicast to the server peer id on `room.relic.command`, D79, on
    `local-checkpoint`, D134; snapshots latest-wins over the frozen audience, 15 s TTL, D77; `**CURRENT — R2b, round
    transitions:**` the four transitions as `relic.event.v1` on `room.relic.event`, key `${gameId}:${createdAtEpochMs}` (the incarnation), round epoch, no
    sequence (D150, D151); the typed channel with the REST owner and the cues (D152); the mid-round joiner (D155)).
- Modify `playground/alm/alm-improvement-plan.md` consumer table row `| 5 R1, R2 |` (`:1237`), Relic column only:
  "Round transitions on a server-sequenced track per round with range repair (R2b)." No status prose. In the R2b
  paragraph's "**Relic's rounds (D151, D152).**" bullet (`:1113-1115`), "(the game id as key, the round as epoch)"
  becomes "(the game incarnation `${gameId}:${createdAtEpochMs}` as key, the round as epoch)", the bullet rewrapped at
  100 columns (R-R2b-31).

**True of the code (check each against Tasks 1–4 before committing; a mismatch is fixed in the doc, never the code)**

- `git grep -n -A1 "ordering?: Readonly<" packages/shared/al-contracts/al-contract.ts` shows `orderingKey`, `epoch?` and
  `seq?` on the broadcast builder's option (the `ts` block's shape).
- Task 1 mints only for a publication whose `senderId` is the server's own peer id (R-R2b-1): its pin that a
  browser-sent keyed message without `seq` stays unsequenced is green, so "a browser's sequence is client-assigned" holds.
- Task 3's event builder keys `${gameId}:${createdAtEpochMs}` (R-R2b-11), the `ts` block's `orderingKey`.
- The D150–D155 rows exist in the roadmap (`7df651c89`); the READMEs and product description cite them.
- `rallarServer.ws.serverPeerId` exists (`rallar-server-ws-router.ts`, `serverPeerId = service.name`).
- Task 2's pins: a joiner's NACK stops as `not-handled` (never served); `resync-required` settles `relay-rejected`
  `{ relay: 'peer', peerId, reason: 'resync-required' }` and removes the receipt; exhaustion settles
  `repair-exhausted`; the second requester of a spent sequence is served by the receipt retry; the `outbox` publish
  result carries the minted `seq` (`toRallarServerWsOutboxPublishResult`); a keyed unsequenced `live-only` publish is
  refused by `publishAuthorizedRallarServerWsMessage`. Task 3's builder matches the `ts` block; Task 4's channel is
  `messages.room` with `purpose: 'notification'` and a REST-hydrating `recovery`.

- [ ] **Step 1: Apply** the patch (or replay the hunks above).
- [ ] **Step 2: True-of-code checks** above.
- [ ] **Step 3: Format** `npx dprint fmt docs/rallar-api-reference.md packages/shared/alm/inbound/README.md packages/shared/alm/outbound/README.md playground/alm/alm-complete-product-description.md playground/alm/alm-improvement-plan.md`
      (explicit files only), then `npx dprint check` on the same five → clean. The roadmap row re-aligns only itself.
- [ ] **Step 4: Checks.** `npx vitest run packages/tests/repo packages/tests/shared-web/rallar-group-public-contracts.test.ts`
      → `Test Files  92 passed (92)`, `Tests  1230 passed (1230)` on Task 4's commit;
      `cd apps/api-v1 && deno test --allow-all test/swagger-routes.test.ts` → `14 passed | 0 failed`, then
      `rm -rf apps/api-v1/node_modules/.deno`; after the commit `npm run check:repo-style:changed -- 9e5c4bf38 HEAD`
      (PASS) and `node scripts/check-test-structure-coupling.mjs --changed 9e5c4bf38 HEAD` (PASS, no candidates).
- [ ] **Step 5: Commit.**

```text
Document server-sequenced tracks and Relic's round transitions

The API reference states that a browser's sequence is client-assigned
and a server publication's is minted by the server: a publication that
names an ordering key and epoch without a sequence is sequenced at the
WS server's admission, contiguous across instances, kept across a
restart and per message id; the server repairs its own publications from
its sent copies to the requester alone, inside the admitted audience,
paged, with repair-exhausted at the end; the receiver's recovery owner
is the typed channel's; Relic's round transitions are the example, and
ws.publish names the ordering option. The inbound README states the WS
client's server track and its NACK to the server, the outbound README
the server's planner-served repair and its Relic consumer. The product
description gains the server-sequenced tracks under "Ordering and gap
recovery" and a Relic Hunters paragraph; the roadmap's consumer row
names Relic's round transitions and its R2b paragraph keys a round track
by the game's incarnation.

D8 reuse: the existing ordering, repair and recovery-owner prose of each document, extended in place; no new section heading.
```

### Task 6: Close

Pins unchanged and bundles measured; the static merge bar (typecheck, build, changed-range gates,
reachability, dprint, manifests `--check`); `npm run test:postgres:integration` (the outbound store and
the WS server changed) and the api-v1 medium-scale gate from CI; the Relic full-stack Playwright case
where its stack is available (`RELIC_HUNTERS_FULL_STACK=1 npx playwright test --config
apps/relic-hunters-v1/playwright.full-stack.config.ts`), every red named from its artifact; the
three-seat final review (product, harness, code quality) with one fix wave; push; the Branch Release
Gate and the API gates green on the code head; hosted manifests 18 and 22 dispatched from the branch
as regression reads; the PR body (Goal, Changes, Public surface, Acceptance, Validation with every red
named, Rulings, Corrections, Limits, Risk and rollback, Follow-ups incl. the harness capability for
server-originated sends); the last commit records "Delivered (R2b, <head>; #643)" on the roadmap's
consumer row and the "Releases 4 to 8" row, updates the fresh-session paragraph (Release 6 A1 next)
and the revision history, and deletes this plan file.

- [ ] **Step 1: Pins and bundles.**
- [ ] **Step 2: Static merge bar.**
- [ ] **Step 3: Postgres and the Relic case.**
- [ ] **Step 4: Final review, one fix wave, push, gates, hosted 18/22.**
- [ ] **Step 5: PR body and the delivered line;** delete this plan file in the last commit.
