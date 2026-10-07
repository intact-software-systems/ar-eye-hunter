# ALM A2a: the leader ACK and the per-player private event — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven development with test-driven development:
> one implementer per task, the failing tests first, the controller reviews and commits, one commit
> per task, a three-seat final review with one fix wave before the close. Steps use checkbox
> (`- [ ]`) syntax for tracking. The tasks run in the order 1 → 2 → 3 → 4 → 5 → 6 → 7.

**Goal:** Deliver Release 6, A2a (D164 to D170, `playground/alm/alm-a2a-design-proposal.md`). A room
send with `ack: 'group-leader'` addresses the room's leader: the appointed director session present at
admission, resolved from the room snapshot by the carrier that admits the send and frozen as the one
recipient its new `leader` receipt expects, so the director's ordinary ACK confirms it. A room with no
such leader inside the audience the sender names refuses the send `no-leader` on both carriers, no
fallback trigger. AR Eye Hunter's director relay addresses intents and sync requests by role and reads
`no-leader` as `no-director`; the Relic server tells the acting hunter's own sessions what became of a
command (its recorded action, or the rule text that refused it); the `leader-ack` lane family proves the
leader over `ws`, `rtc` and `rtc-with-ws-fallback`; the docs state the acknowledgement modes.

**Architecture:** The AL contracts gain a fourth receipt algorithm `leader`, which `group-leader`
normalizes to (no longer `subtree`), and A1's `ALAudienceNarrowing` gains `{ kind: 'leader'; sessionId }`,
built by one shared `toALLeaderNarrowing(message, leaderSessionId)` from the message's `delivery.ack`; each
carrier resolves the session with `resolveRallarGroupLeaderSessionId(snapshot)` at its own admission. The
RTC origin freezes `[director]` (a room broadcast too, held for a carrier gap as A1's audiences are) and
refuses an empty leader audience `refused/no-leader`; the WS room authorizer narrows its authorized
`sessions` to the director and refuses a leaderless audience, which ingress answers with the advisory
`no-leader` NACK that the WS origin reads as a trusted-server `relay-rejected`. `receiver` and `leader`
count logical recipients wherever a receipt is planned, aggregated, tracked or decoded
(`isALLogicalReceiptMode`). The browser validator refuses a leader send without a room; the relay sends on
the room command channel. The Relic server publishes `relic.hunter.v1` as a principal broadcast in the room
from its per-game queue on both command paths.

**Tech Stack:** TypeScript on Node (Vitest, Playwright, esbuild bundle budgets) and Deno (api-v1, the
Relic server, the control server: `deno test`, `deno check`, `deno lint`); dprint.

**Spec:** `playground/alm/alm-a2a-design-proposal.md`; decisions D164–D170 in
`playground/alm/alm-improvement-plan.md`; survey `.superpowers/sdd/a2-survey/facts.md`.

## Global constraints

- **The maintainer's notes stand: "No legacy, avoid duplication, no migration code, keep the repo
  consistent, prefer existing patterns."** No wire or schema bump: `ALTargets`, `ALDelivery` and the
  control frames keep their fields; `group-leader` was already on the wire.
- **The leader (D164):** a room send with `ack: 'group-leader'` addresses the room's appointed director
  session present at admission (group metadata `rallarDirector` and `activeSessions`, resolved by
  `resolveRallarGroupLeaderSessionId` from the snapshot the admitting carrier holds), narrowed and frozen
  with the roster as A1's audiences are; the receipt expects that session alone and the leader's ordinary
  ACK confirms it; a succession after admission does not move the frozen leader (the receipt times out, a
  resend re-admits); no leader epoch on the wire.
- **The `no-leader` refusal (D165):** `no-leader` is a new `ALDeliveryRefusalReason` arm and `ALNackReason`.
  A send is refused when its room has no active director at admission, when the sender is the director, or
  when the director is outside the audience the sender names after its exclusions (a list or a principal
  without it, `exceptPeerIds` naming it; R-A2a-2). The RTC origin refuses at its own admission
  (`refused { reason: 'no-leader' }`, no attempt); the WS server refuses at ingress (rejection code
  `unauthorized`, advisory NACK `no-leader`), which the WS origin settles as `relay-rejected { relay:
  'trusted-server', reason: 'no-leader' }` on its one sent attempt (R-A2a-1, R-A2a-14). Both end the handle
  `rejected`; not a fallback trigger.
- **The supported shapes and the `leader` algorithm (D166):** a fourth receipt algorithm `leader`, declared
  by every carrier (`ws-client`, `rtc-overlay`, `ws-server`); `group-leader` normalizes to it and no longer
  to `subtree` (amends D41); a requested `leader` is kept, never downgraded; supported on room multicast,
  room broadcast, principal broadcast with its room and listed room broadcast; unicast, `world` and `all`
  are `unsupported`. `DEFAULT_AL_QOS_CAPABILITIES` and the fallback preference order do not gain `leader`
  (R-A2a-4, R-A2a-5). Delivery and confirmation are one set.
- **D3:** no compatibility window. A changed contract changes everywhere in the same task; no `?:` added
  "for now".
- **D8 reuse first.** Search `packages/**` for an existing pattern before writing one; delete what becomes
  unused in the same task; no raw Maps where `packages/shared/cache` repositories fit. Every task carries a
  D8 reuse inspection paragraph and its commit one `D8 reuse:` line.
- **No ids in code, tests or docs:** no plan, task, PR or ruling id in code or tests; decision ids (D164 …)
  only in docs.
- **No guarantee weakens.** The four pins (`al-indexeddb-transaction-ledger`,
  `al-indexeddb-operation-counts`, `al-storage-snapshot`, `al-indexeddb-empty-audience-counts`) stay
  unedited; hosted manifests 18 and 22 stay byte-identical (the `leader-ack` cells withheld through
  `HETZNER_WITHHELD_ALM_SCENARIOS`, as D148).
- **Convergent-service rules** (`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`)
  bind the WS ingress and the room authorizer: the refusal is a typed authorization value, never a throw.
- **Code standard** (`.agents/skills/rallar-code-writing/references/repo-code-style.md`): canonical verbs;
  functions ≤40 lines; ≤3 positional parameters for a new function; `interface` for object contracts;
  required fields by default; `Either` for expected failure; kebab-case filenames after the primary export;
  no role folders; no narration comments; one canonical name per type. Tests live under `packages/tests/**`
  mirroring the source; Deno app tests under `apps/<app>/test/`; the Relic app's own tests under
  `apps/relic-hunters-v1/tests/`.
- **Formatting:** `npx dprint fmt <explicit file list>` on touched files only (pipe a list through `xargs`;
  zsh does not split `$(...)`).
- **Per-task checks:** the focused Vitest files; `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json
  --noEmit`; `deno check` from the repo root on every changed `packages/shared/**` and
  `packages/shared-server/**` file; `cd apps/api-v1 && deno task check` (it checks `src/main.ts` and `test/`)
  then `rm -rf apps/api-v1/node_modules/.deno`; for Task 5 the Relic server's `deno task check`, `deno lint`
  and tests and `cd apps/relic-hunters-v1 && npm run typecheck`; `node scripts/check-tests-typecheck.mjs`;
  the four pins; the bundle checks with a private `TMPDIR` (`mktemp -d /tmp/claude-501/b.XXXX`) after any
  `packages/shared`, `shared-web` or `shared-test` change (`npm --workspace @ar-eye-hunter/shared-web run
  check:browser-bundles` and `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`;
  budgets after Task 1: `browser/rallar.ts` 242, headless 307; a crossed budget rises to the next whole KiB
  with the measured figure in the commit message); for a public shared-web change
  `shared-web-public-api-snapshots.test.ts` and `shared-web-browser-bundle-boundaries.test.ts`; after the
  commit `npm run check:repo-style:changed -- c0ae57d71 HEAD` (read the verdict line: the script exits 0 on
  FAIL), `node scripts/check-test-structure-coupling.mjs --changed c0ae57d71 HEAD` and, when a test file is
  added or deleted, `npm run check:test-reachability`.
- **Sandbox notes.** Loopback binds fail (`listen EPERM`): name those suites as sandbox reds
  (`api-v1-rtc-rtt-recipe-semantics` 5, `api-v1-state-write-convergence-recipe` 4, `local-websocket-session`
  1, `live-rtc-control-client`, `headless-worker-script`); pglite and IndexedDB 5 s load timeouts pass alone
  (`al-inbound-queue-work`, `outbound-admission-read-order`, `outbound-delivery-settlements`); `npx tsx`
  fails on its IPC pipe (use `node --import tsx`); `pgrep` fails under the sandbox (poll for a summary
  line); `git fetch`, `gh` and the Playwright lane need the sandbox off. The api-v1 `node_modules` is shared
  across worktrees: remove `.deno` only when no other Deno suite runs. Do not run `npm run test:unit` per task.
- **Git.** One commit per task with one `D8 reuse:` line and no attribution lines; the controller commits
  and pushes after review; never `git stash`; the PR body is written at the close.

## File structure

| Area                  | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts and RTC (1) | `packages/shared/al-contracts/{al-policy,normalize-al-qos-policy,al-carrier-capabilities,validate-al-ack-support,al-audience-narrowing,al-control,al-control-value-codec,al-frozen-multicast-audience}.ts`, `al-message-persistence/assert-persisted-al-qos.ts`; `packages/shared/api/group-director.ts`; `packages/shared/alm/delivery/{al-delivery-lifecycle,compute-al-delivery-lifecycle}.ts`, `alm/inbound/decode-al-inbound-plan.ts`, `alm/outbound/{al-outbound-message-runtime,compute-al-outbound-dispatch,transition-al-outbound-pending-ack}.ts`, `alm/outbound/admission/al-outbound-admission-validation.ts`, `alm/outbound/control/{compute-al-outbound-receipt-admission,resolve-al-outbound-relay-rejection}.ts`; `packages/shared/multicast/{rtc-room-snapshot-admission,web-rtc-overlay-frozen-audience,web-rtc-overlay-missing-recipient-repair,web-rtc-overlay-multicast-manager}.ts`; `packages/shared-test/rallar-bb-test/alm/{decode-alm-delivery-failure,decode-alm-runtime-result}.ts`; `packages/shared-web/bundle-budgets.json`; tests `rtc-leader-audience.test.ts` (new), the fixture `rtc-origin-overlay-fixture.ts` and thirteen edited test files (41 files) |
| WS server (2)         | `packages/shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts`; `packages/shared/services/ws-queue-box-server/ws-queue-box-server-{receipt-aggregation,inbound-plan,outbound-planning}.ts`; `packages/shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts`; tests `ws-topic-room-authorizer.test.ts`, `rallar-server-ws-live-publication.test.ts`, `ws-queue-box-server-receipt-aggregation.test.ts`, `ws-queue-box-client-receipt-tracking.test.ts`, `al-audience-narrowing.test.ts`, `apps/api-v1/test/services/ws-room-authority-delivery.test.ts` (11 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Browser and relay (3) | `packages/shared-web/browser/messages/{browser-message-input-validator,create-browser-unicast-message}.ts`, `browser/director/browser-director-relay-transport.ts`; tests under `packages/tests/shared-web/messages/` and `packages/tests/shared-web/director/` (9 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Lane and harness (4)  | `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/leader-ack/{leader-ack-commands,leader-confirms,no-leader-refused,leader-outside-list}.ts` (new); the lane's message, receipt, scenario-definition and recipe modules, `scenarios/audiences/*`, `scenarios/receipted-audience.ts`; the harness `recipientPeer` contract, schema, capability, decoder, peer resolver, ledger and composition; `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`; `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`; tests `alm-conformance-leader-ack.test.ts` (new) and the recipe, command, runtime, three-agent and manifest tests (32 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Relic (5)             | `packages/relic-hunters/src/{protocol,model}.ts`; `apps/relic-hunter-server-v1/src/{to-relic-hunter-event-message (new),apply-relic-ws-command,relic-game-service,relic-rest-auth,main}.ts`; `apps/relic-hunters-v1/src/game/{subscribe-relic-hunter-events (new),relic-hunters-runtime,useRelicHunters}.ts`, `src/App.tsx`, `src/styles.css`, `docs/{runtime-data-flow,ui-gameplay}.md`; tests `apps/relic-hunter-server-v1/test/*`, `apps/relic-hunters-v1/tests/{subscribe-relic-hunter-events (new),relic-hunters-runtime}.test.ts`, `packages/tests/relic-hunters/*` (21 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Docs (6)              | `docs/rallar-api-reference.md`; `packages/shared/alm/inbound/README.md`, `outbound/README.md`; `playground/alm/{alm-complete-product-description,alm-improvement-plan,alm-static-audit}.md` (6 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Close (7)             | the pins, the gates, the lane run, the review, the PR body, the roadmap's delivered lines, the audit's F16 status line, the requirement matrix's PC7 row, this file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Task order

1 (contracts and RTC) → 2 (WS server) → 3 (browser and relay) → 4 (lane) → 5 (Relic) → 6 (docs) → 7 (close).
Task 2 consumes Task 1's `toALLeaderNarrowing`, `resolveRallarGroupLeaderSessionId`, `isALLogicalReceiptMode`,
the `leader` algorithm and the trusted-server `no-leader` relay rejection. Task 3 consumes Task 1's arms and RTC
fixture (`toOriginDirectedSnapshot`) and Task 2's WS client tracking and ingress NACK; its facade proofs run on
the real carriers. Task 4 consumes Tasks 1–3 (its lane cells need all three; its unit tests need Task 1's
resolver and decoder rows). Task 5 needs nothing from Tasks 1–4 (`newALPrincipalBroadcastMessage` is A1's).
Task 6 states what Tasks 1–5 built and is checked against them.

The composed commits (scratch tree, each `git am`-able on its predecessor from the design head `c0ae57d71`):
`final-patch-task-1.patch` … `final-patch-task-6.patch` under `.superpowers/sdd/a2a-plan/`.

## Rulings

- **R-A2a-1 (W-D D1):** `no-leader` follows the existing ingress seam. The WS server's NACK becomes
  `relay-rejected { relay: 'trusted-server', reason: 'no-leader' }`, as `unauthorized` and `membership-fenced`
  do; the RTC origin's own admission ends `refused { reason: 'no-leader' }`. Both carriers end `rejected` and the
  failure's reason reads `no-leader`; the lane and the docs assert the reason and name the kind per carrier.
  _Cost if wrong:_ two failure kinds for one condition (the A1 precedent: a client `all` is `unauthorized` on WS,
  `unsupported` on RTC).
- **R-A2a-2 (W-D D2):** the general rule is "the leader must be inside the audience the sender names, after
  exclusions": a principal send whose principal is not the director's, a list without the director and
  `exceptPeerIds` naming the director are all `no-leader`; Tasks 1 and 2 pin the three. _Cost if wrong:_ three pins.
- **R-A2a-3 (W-D D3):** the handle's `receiptAlgo` reads `leader` (Task 1's `ALReceiptMode`). _Cost if wrong:_ none.
- **R-A2a-4 (W-A A1):** `DEFAULT_AL_QOS_CAPABILITIES` does not gain `leader`: the default set names no tracked
  logical receipt. _Cost if wrong:_ one array entry.
- **R-A2a-5 (W-A A2):** `leader` stays out of the fallback preference order: a kept request never reaches it.
  _Cost if wrong:_ one entry.
- **R-A2a-6 (W-A A3):** no `toNackReason` case for `no-leader`: RTC refuses at the origin and the WS NACK is
  advisory, built from `authorization.reason`; a case would be dead code. _Cost if wrong:_ two lines.
- **R-A2a-7 (W-A A4):** the narrowing follows only the wire `delivery.ack === 'group-leader'`; a `qos.ack` leader
  without the wire ack would track a leader receipt over the whole audience. _Cost if wrong:_ one refusal in
  `computeALOutboundAckRefusal`.
- **R-A2a-8 (W-A A5):** a director whose presence lease expired is `no-leader` on both carriers: the RTC narrowing
  filters the authorized `memberSessions`, the WS authorizer applies its live-lease filter before the leader
  filter (pinned). _Cost if wrong:_ a carrier disagreement on the edge.
- **R-A2a-9 (W-A A6):** the browser validator's issue code is `leader-requires-room-audience` on `$.ack`.
  _Cost if wrong:_ a rename.
- **R-A2a-10 (W-B B1):** one shared leader rule lives in `al-audience-narrowing.ts` and both carriers call it:
  `toALLeaderNarrowing(message, leaderSessionId)` narrows the audience the sender names (after exclusions) to the
  leader, and each carrier refuses when the narrowed audience it already computes delivers to nobody but the
  sender (RTC: an empty frozen audience, `computeRtcLeaderRefusal`; WS: `isLeaderlessRoomAudience` over
  `resolveALAdmittedRoomAudience` and `filterLiveWsRoomRecipientSessionIds`). W-B's private
  `toRoomLeaderNarrowing`/`isNamedRoomSession` were merged into Task 1's function before the Task 2 patch was cut.
  _Cost if wrong:_ two copies drift and the carriers refuse different sends.
- **R-A2a-11 (W-B B2):** Task 1 owns the logical-receipt predicate as `isALLogicalReceiptMode` in
  `validate-al-ack-support.ts` (two style gates forbid the alternatives); Task 2 uses it at the server's
  aggregation, inbound plan and outbound planning and the client's receipt tracking. _Cost if wrong:_ a WS leader
  receipt tracking hops where a site is missed.
- **R-A2a-12 (W-B B3):** an RTC leg handed to WS after a succession is refused `no-leader` by the server (the
  current director is outside the frozen list): a typed outcome, the hand-over form of D164's "succession after
  admission" (an RTC-only send times out instead). _Cost if wrong:_ the handle reads `rejected` rather than a
  receipt timeout on that path.
- **R-A2a-13 (W-B B4, limit):** a leader send held at ingress (`not-yet-in-sync`) whose room later has no leader is
  dropped without a NACK, as a held `membership-fenced` send is (`readCurrentDispatchAuthority`); a server
  publication with `group-leader` and no leader reaches no one. _Cost if wrong:_ a silent expiry instead of a typed
  refusal on those two paths.
- **R-A2a-14 (W-B B5):** on `ws` the `no-leader` failure is `relay-rejected`, read at `failure.rejection.reason`,
  with a SENT attempt (the NACK arrives after the frame left); on `rtc` it is `refused`, read at
  `failure.reason`, with no attempt. The frame's "attempt-less refusal on ws" is withdrawn; the lane cells, the
  facade tests and the docs assert accordingly. _Cost if wrong:_ red lane cells.
- **R-A2a-15 (W-B B6):** no leader narrowing in the target resolver (`resolve-ws-group-target.ts:98`): the outbox
  dequeue keeps only the row's `admittedAudience`, already the leader; a resolver filter would read a cache older
  than the appointment and drop an authorized send (api-v1 pin: a cached snapshot with no director still delivers
  to the director on live-only and outbox). _Cost if wrong:_ a generic authorizer that returns no audience
  delivers a leader send room-wide (a pre-existing path that never aggregates a receipt).
- **R-A2a-16 (W-C C1):** the harness `recipientPeer: 'recipient-b'` resolves to the one other live session of
  another principal that is not the room's leader (a peers port `getRoomLeaderSessionId` over Task 1's
  resolver). _Cost if wrong:_ harness-only.
- **R-A2a-17 (W-C C2, C3):** the sender sequences with a first-success poll of `director.status { refresh: true }`
  (200 ms interval, within the send budget) until `directorStatus.active` reads `true` (`false` in
  `no-leader-refused`), not a barrier; `leader-confirms` ends with the receiver resigning and `no-leader-refused`
  relies on the run order. _Cost if wrong:_ up to 10 s per cell; a failed resign reddens the next cell.
- **R-A2a-18 (W-C C4):** the leader receipt expects `receiptMode: 'leader'` on all three carriers (Task 2's WS
  client tracks a leader receipt). _Cost if wrong:_ one line per carrier if a carrier reports `receiver`.
- **R-A2a-19 (W-C C5, C6):** the Relic server publishes the hunter event from the per-game queue on both REST and
  WS commands (`applyCommand(command, sender)`; `readSession` replaces `readSessionUsername`; the rules run under
  `Try.compute` so only a rule refusal becomes `command-refused`; REST still throws the rule error); publication
  order snapshot → `action-recorded` → round transition. _Cost if wrong:_ one publish to drop if REST should stay
  silent.
- **R-A2a-20 (W-C C7):** "Recorded on another device" shows in the round-plan panel only when that device is an
  active planner without its own `lockedAction`; the refusal text becomes the hook's `error`, shown by the
  existing error panel. _Cost if wrong:_ a moved line.
- **R-A2a-21 (W-C C8):** `RelicCommandSender` and `RelicRestAuthSession` had one shape; one name stays,
  `RelicCommandSender` (one canonical name per type). _Cost if wrong:_ a rename.
- **R-A2a-22 (W-C C9):** `isRelicHunterEvent` checks only the action's kind, as `isRelicCommand` does (a stricter
  check takes `model.ts` past the cognitive-load gate). _Cost if wrong:_ a looser guard on a server-originated
  event.
- **R-A2a-23 (W-C C10):** Task 5 owns the Relic app docs (`runtime-data-flow.md` including its D72 sentence,
  `ui-gameplay.md`); where Task 6's prototype also edited them, Task 5's wording stands. _Cost if wrong:_ none.
- **R-A2a-24 (assembler):** R-A2a-21 is realised in Task 5: `RelicRestAuthSession` is deleted from
  `relic-rest-auth.ts`, which imports `type RelicCommandSender` from `./apply-relic-ws-command.ts` (no cycle:
  the command module imports nothing from the REST authorizer) and drops its now-unused `AuthSession` import;
  Task 5's commit message gains "under the one sender type the REST authorizer also reads". _Cost if wrong:_ the
  type moves to the other module.
- **R-A2a-25 (assembler):** Task 6's prototype predated R-A2a-1, -2, -12, -14 and -23. The composed Task 6 drops
  its `runtime-data-flow.md` hunk (Task 5's wording, R-A2a-23); the API reference's `no-leader` paragraph, its
  example and the outbound README's ingress sentence state the per-carrier failure (R-A2a-14); the refusal names
  the list, a principal other than the director's and `exceptPeerIds` (R-A2a-2); the succession sentence gains
  the hand-over refusal (R-A2a-12); the product description's CURRENT paragraph names both kinds. The commit
  message follows (6 files). _Cost if wrong:_ doc wording.
- **R-A2a-26 (assembler):** every task's changed-range gates run from the plan base `c0ae57d71`; `origin/main`
  (`d5db1569d`) is equivalent, because the two design commits change only three Markdown files under
  `playground/alm/`. _Cost if wrong:_ none; a narrower range checks a subset.
- **R-A2a-27 (assembler):** the budgets stay `browser/rallar.ts` 242 (raised by Task 1) and headless 307: the
  composed facade measures 241.087 KiB after Task 1 and 241.246 after Tasks 3–6; the headless agent 306.476
  after Task 1, 306.507 after Task 2, 306.528 after Task 3 and 306.701 after Task 4 (the harness peer resolver),
  unchanged by Tasks 5–6. _Cost if wrong:_ a budget raise at the close if a review fix adds 0.3 KiB.
- **R-A2a-28 (assembler):** nothing moved into Task 1's commit: it already carries every stub line Tasks 4 and 5
  needed to compile (`ALAckAlgo` `leader`, `ALDeliveryRefusalReason` `no-leader`,
  `resolveRallarGroupLeaderSessionId`, the strength map's `leader: 3` in `compute-al-delivery-lifecycle.ts:392`,
  `decode-alm-delivery-failure.ts`'s `'no-leader'` refusal and NACK rows, `decode-alm-runtime-result.ts`'s
  `leader: true`). _Cost if wrong:_ none; the composed tree compiles at every commit.

## Limits (carried; Task 7 states them in the PR body)

- Exclusive ownership (`ownership: 'exclusive'` as a ResourceInbox-backed claim with `claimed`,
  `held-by-other`, `expired`) is A2b; the roadmap's A2 row is split (D170).
- No leader epoch rides the wire: the appointment at admission is the authority, and a succession between
  admission and the ACK leaves the receipt expecting the frozen session, so an RTC-only send times out (D164,
  D170).
- Heartbeat freshness stays a client-side concern: the carriers judge presence only, and the relay's
  `stale-director` check runs before the send (D170).
- A leader send over RTC still relays through non-recipient room peers; only the director delivers it
  (R-A1-26, D170).
- No server-originated conformance cell: the harness has no capability for server-originated typed sends, so
  the Relic hunter event is proven by the Relic Deno and browser suites, not the lane (D153, D170).
- An RTC leg handed to WS after a succession is refused `no-leader` by the server, because the frozen list no
  longer names the director: the handle reads `rejected` on that path rather than a receipt timeout
  (R-A2a-12).
- Two silent paths: a leader send held at ingress (`not-yet-in-sync`) whose room later has no leader is dropped
  without a NACK, as a held `membership-fenced` send is; and a server publication with `group-leader` and no
  leader reaches no one (R-A2a-13).
- A generic room authorizer that returns no audience leaves a leader send to the target resolver, which does
  not narrow it, so it is delivered room-wide without a receipt aggregate; pre-existing for such authorizers
  and kept out of the resolver on purpose (R-A2a-15).
- The `no-leader` failure differs by carrier: `refused` at `failure.reason` with no attempt on RTC, a
  trusted-server `relay-rejected` at `failure.rejection.reason` on its one sent attempt on WS; applications
  check both (R-A2a-1, R-A2a-14).
- `isRelicHunterEvent` checks only the action's kind, as `isRelicCommand` does: a lighter guard on a
  server-originated event (R-A2a-22).
- The Relic hunter event is not a reply correlated with the command (I1 keeps correlation); a storage or
  session failure on the WS path is still only logged.
- The `leader-ack` cells are local and the hosted full read's: manifests 18 and 22 withhold them and stay
  byte-identical (D169).
- The lane's `no-leader-refused` cell relies on the run order after `leader-confirms`' resign, and each cell
  may spend up to 10 s polling `director.status` before it sends (R-A2a-17).

## Corrections and notes (Task 7 states them in the PR body's Corrections)

- **`group-leader` meant `subtree` on `main` (D41):** a WS room send asking for it completed on the server's
  own hop ACK, and the RTC tests used it as a synonym for `subtree`. Task 1 rewords those pins to ask for
  `qos.ack` `subtree` with `ack` left `none`; Task 3 drops the two `group-leader` rows of the RTC room-limit
  fallback table (a leader audience is at most one session).
- **The frame's `RtcAudienceNarrowing` name was stale:** A1 unified it as `ALAudienceNarrowing`
  (`al-audience-narrowing.ts`); the leader arm and `toALLeaderNarrowing` live there.
- **The frame's Relic builder shape did not compile:** `newALPrincipalBroadcastMessage`'s options type refuses
  `groupRef` (TS2353); the room's `groupRef` rides in the target beside `principalRef`.
- **The lane's receipt window hardcoded the `receiver` mode** (`alm-conformance-receipt-commands.ts`,
  `receiptMode: 'receiver'`): Task 4 makes it `{ roles, ending, mode }`, and every existing caller names
  `receiver`.
- **The harness could not name `recipient-b` before:** `recipientPeer` took only `receiver`; Task 4 adds
  `recipient-b`, the one other live session of another principal that is not the room's leader.
- **RTC never froze a room broadcast before:** a leader room broadcast is the first; `isRtcUnfrozenRoomMessage`
  and `isALNarrowedBroadcastFrozenAs` count it, else a held leader broadcast fails "Outbound planned message
  changes original authority or deadline" at the replan (Task 1).
- **The frame's "attempt-less refusal on ws" was wrong** (R-A2a-14): the WS NACK settles the one attempt the
  send made.
- **D72's lost rule text** is closed for the acting hunter's own sessions (D168); the Relic data-flow document's
  regression sentence is replaced in Task 5.

## Tasks

### Task 1: The leader receipt, the no-leader refusal and the RTC origin (D164, D165, D166)

**Files** (anchors at the design head `c0ae57d71`, this task's parent; the composed commit is `.superpowers/sdd/a2a-plan/final-patch-task-1.patch`, `git am`-able there; 41 files). The narrowing type is A1's `ALAudienceNarrowing`.

- Contracts, `packages/shared/al-contracts/`: `al-policy.ts:32` `ALAckAlgo` gains `'leader'`; the `ALReceiptMode` doc
  (`:34-37`) reads "… logical recipients under `receiver`, and the room's leader alone under `leader`".
  `normalize-al-qos-policy.ts:464-465` maps `group-leader` to `'leader'`. `al-carrier-capabilities.ts:12` the shared
  carrier set becomes `['none', 'hop', 'subtree', 'receiver', 'leader']` (all three carriers). `DEFAULT_AL_QOS_CAPABILITIES`
  and the fallback preference (`normalize-al-qos-policy.ts:99,419`) stay unchanged (R-A2a-4, R-A2a-5).
- `validate-al-ack-support.ts`: export `isALLogicalReceiptMode(algo: ALAckAlgo): boolean` (receiver or leader; doc
  "`receiver` and `leader` count logical recipients; `hop` and `subtree` count next hops, and `none` counts nothing.")
  before `toALNormalizableAckAlgos` — it lives here, not in `al-policy.ts` (a value import would close the cycle
  al-policy → normalize → validate) and not in a new file (`al-contracts/` would cross the 20-file directory review).
  `validateALAckSupport` (`:31-38`) adds `&& (algo !== 'leader' || hasRoomAudience(targets))`; the doc gains "`leader`
  needs a room audience its leader may be inside, so a unicast has none either (D166)."; `hasLogicalReceiverAudience`
  (`:50-62`) keeps its unicast branch and returns the new private `hasRoomAudience` (multicast, room broadcast, principal
  broadcast with `groupRef`; not unicast). `toALNormalizableAckAlgos` (`:41-47`) keeps a requested or defaulted
  `receiver` or `leader`: `isALLogicalReceiptMode(algo) ? [...supported, algo] : supported`.
- `al-audience-narrowing.ts`: `ALAudienceNarrowing` gains `Readonly<{ kind: 'leader'; sessionId: string; }>`;
  `isALAudienceSession` `case 'leader': return session.sessionId === narrowing.sessionId;`; export
  `toALLeaderNarrowing(message: Pick<ALMessage, 'delivery'>, leaderSessionId: string | undefined)` — `undefined` unless
  `message.delivery?.ack === 'group-leader'`; no leader → `{ kind: 'list', recipientPeerIds: [] }` (A1's "names no
  session" precedent); else `{ kind: 'leader', sessionId }`. Doc: "A `group-leader` room send narrows the audience its
  sender names to the room's leader, the session its carrier resolves from the room snapshot it admits with (D164). A
  room without one narrows to no session."
- `api/group-director.ts` after `:141`: `resolveRallarGroupLeaderSessionId(snapshot: GroupSnapshot): string | undefined`.
- `al-control.ts:39` `ALNackReason` += `'no-leader'`; `al-control-value-codec.ts:276` decodes it.
  `alm/delivery/al-delivery-lifecycle.ts:59-64` `ALDeliveryRefusalReason` += `'no-leader'` (doc "`no-leader`: a
  `group-leader` send whose room has no active leader inside the audience it names (D165)."); `:281-283`
  `ALDeliveryRelayRejection`'s trusted-server reason += `'no-leader'` (doc names it beside `unauthorized`).
  `alm/outbound/al-outbound-message-runtime.ts:145` `ALOutboundDropReasonCode` += `'no-leader'`;
  `compute-al-outbound-dispatch.ts:288` maps it to `{ kind: 'refused', reason }`. `resolve-al-outbound-relay-rejection.ts:18`
  uses the private `isTrustedServerAdmissionRefusal(reason): reason is 'unauthorized' | 'membership-fenced' | 'no-leader'`
  (the ruled seam: a trusted server's `no-leader` NACK before a receipt row is `relay-rejected`, never a refusal).
  `al-inbound-effect-intent.ts` `toNackReason` is NOT touched: no inbound plan produces `no-leader` (R-A2a-6).
- Logical receipt everywhere `receiver` was tested: `transition-al-outbound-pending-ack.ts:58-59` (an empty logical
  receipt returns `ackTracking.mode`), `:133` (`case 'leader':` beside receiver), `:167`; `compute-al-delivery-lifecycle.ts:209,233`;
  `:386` strength map `leader: 3`; `admission/al-outbound-admission-validation.ts:104` and the decoder `:285`;
  `control/compute-al-outbound-receipt-admission.ts:77` (detail "AL receipt names a message that tracks no logical
  recipient receipt"); `multicast/web-rtc-overlay-missing-recipient-repair.ts:84`; decoders `decode-al-inbound-plan.ts:125`,
  `al-message-persistence/assert-persisted-al-qos.ts:14` accept `'leader'`. The two empty-audience sites
  (`frozen-audience.ts:193`, `transition-al-outbound-pending-ack.ts:202`) stay `receiver`-only: a leader frozen to nobody
  is refused, never complete.
- RTC origin, `packages/shared/multicast/`: `rtc-room-snapshot-admission.ts:36-43` the `authorized` arm gains `readonly
  leaderSessionId: string | undefined;` ("The room's leader the snapshot appoints and holds present, to which a
  `group-leader` send narrows."), filled at `:196` by `resolveRallarGroupLeaderSessionId(snapshot)`.
  `web-rtc-overlay-frozen-audience.ts`: `ComputeFrozenAudienceInput` gains required `leader: ALAudienceNarrowing |
  undefined` and the filter applies both narrowings; `isRtcUnfrozenRoomMessage` (`:92`) also holds a room broadcast with
  `groupRef` and `delivery.ack === 'group-leader'`; `toRtcFrozenRoomMessage` (`:97-123`) computes one frozen audience
  (`narrowing: toRtcAudienceNarrowing(message), leader: toALLeaderNarrowing(message, admission.leaderSessionId)`), a
  non-broadcast takes `toALFrozenMulticastMessage`, a broadcast keeps today's conversion less `exceptPeerIds`. Export
  `computeRtcLeaderRefusal(msg, original)`: right unless `msg.delivery?.ack === 'group-leader'` and the frozen audience is
  empty; left `{ msg: toUnfrozenRoomMessage(msg, original), dropReason: 'no-leader: the room has no active leader inside
  the audience the send names', dropReasonCode: 'no-leader', lane: 'volatile', preparedMessages: [] }`; the private
  `toUnfrozenRoomMessage` is extracted from `computeRtcFrozenAudienceRefusal` (`:141-143`), which now uses it.
  `toRtcFrozenAudienceDispatchPlan` (`:169`) swaps the expected set for any logical mode. `web-rtc-overlay-multicast-manager.ts:544-548`
  chains `computeRtcLeaderRefusal(carried, original)` after the frozen-audience refusal.
- `al-contracts/al-frozen-multicast-audience.ts:91-106`: `isALNarrowedBroadcastFrozenAs(message: ALMessage, …)` reads the
  targets from the message and counts a room broadcast with `delivery.ack === 'group-leader'` as narrowed (without it a
  held leader broadcast fails "Outbound planned message changes original authority or deadline").
- `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts:22-28,66-77,115-127` (`'no-leader'` in both keyed
  maps and the trusted-server relay rejection); `decode-alm-runtime-result.ts:44` (`leader: true`). Budget
  `packages/shared-web/bundle-budgets.json` `browser/rallar.ts` 241 → 242.
- Tests: create `packages/tests/shared/multicast/rtc-leader-audience.test.ts` (copy from the patch); the fixture
  `rtc-origin-overlay-fixture.ts` exports `toOriginDirectedSnapshot(snapshot, directorSessionId)` (Task 3 reuses it). Modify
  `al-contracts/{validate-al-ack-support,al-carrier-capabilities,al-audience-narrowing}.test.ts`, `group-director.test.ts`,
  `alm/delivery/compute-al-delivery-lifecycle.test.ts` (helper `toReceiptAlgo`: group-leader → leader),
  `services/ws-queue-box-client-relay-rejection.test.ts`, `shared-test/rallar-bb-test-alm-commands.test.ts:622-625`,
  `multicast/web-rtc-overlay-frozen-audience.test.ts:323,346` (`leader: undefined`). The `subtree` pins that used
  `group-leader` as a synonym now ask for what they mean, `qos: { ack: { algo: 'subtree' } }` with `ack` left `'none'`:
  `multicast/rtc-relay-ownership.test.ts:457` (and `:342`, which merges `subtree.qos` before adding repair),
  `multicast-policy-integration.test.ts:359,416,563`, `services/ws-queue-box-client-receipt-tracking.test.ts:244`,
  `services/ws-queue-box-server-addressed-receipts.test.ts:180`, `shared-web/messages/browser-message-tracked-receipt.test.ts:49-53,81-85`
  (rows become `ackLabel: 'qos.ack subtree'`). `validate-al-ack-support.test.ts:176` ("prefers receiver as the fallback")
  sends `qos: { ack: { algo: 'subtree' } }` instead of `group-leader`.

**Interfaces produced** (Tasks 2–3): `'leader'` in `ALAckAlgo`/`ALReceiptMode`; `isALLogicalReceiptMode`;
`toALLeaderNarrowing`; `ALAudienceNarrowing` `leader`; `resolveRallarGroupLeaderSessionId`; `'no-leader'` in
`ALNackReason`, `ALDeliveryRefusalReason`, `ALOutboundDropReasonCode` and the trusted-server `ALDeliveryRelayRejection`;
the authorized admission's `leaderSessionId`; `computeFrozenAudience({ admission, selfPeerId, narrowing, leader })`;
`computeRtcLeaderRefusal`. Left to Task 2: `isALLogicalReceiptMode` at `ws-queue-box-client-receipt-tracking.ts:49,59,61`,
`ws-queue-box-server-{receipt-aggregation.ts:233,inbound-plan.ts:42,outbound-planning.ts:368}`.
**D8 reuse inspection.** As the commit's `D8 reuse:` line; no new state, control frame, aggregate or file of source.

- [ ] **Step 1: Write the failing tests** (copy from the patch). `rtc-leader-audience.test.ts` (snapshot
      `createOriginPrincipalSnapshot()` with `rallarDirector` merged in by `toDirectedSnapshot(sessionId)`, next hops
      `b c`, leg `enqueueLegIfAbsent(message, 'hold')`): `it.each(['room multicast','room broadcast','principal','list'])`
      "freezes a group-leader %s send as the director session alone, the one recipient its leader receipt expects"
      (director `d`, list `['b','d']`; targets `{ …toOriginFrozenTargets(['d'], 4), minSnapshotVersion: 4, rosterVersion: 4 }`
      on `message`, on b and on c — a non-recipient relays (R-A1-26); pending ack `{ mode: 'leader', expectedPeerIds: ['d'] }`);
      "completes the leader receipt on the director's ACK alone" (ACK from b for d: `{ mode: 'leader',
      expectedRecipientPeerIds: ['d'], confirmedRecipientPeerIds: ['d'], unconfirmedRecipientPeerIds: [], complete: true }`);
      six refusals "refuses a group-leader send as no-leader when $label, sending nothing" — no director, director `z` not
      present, the sender `a` is the director, the list leaves the director `c` out, the principal is not the director's
      (`c`), the exceptions name the director (`exceptPeerIds: ['b','d']`, director `d`) — verdict `{ kind: 'refused',
      reason: 'no-leader', detail: 'no-leader: the room has no active leader inside the audience the send names' }`,
      `message.targets` the sender's, nothing on b or c, no pending ack; "holds a durable group-leader send admitted before
      its room snapshot and freezes it to the director when the snapshot arrives" (`local-outbox` room broadcast; verdict
      `{ kind: 'admitted', durable: true, queuedAttempts: 0 }`, nothing after 200 ms; then b and c carry `[d]`, mode leader).
      Also (titles in the patch): leader admitted on the four room shapes over both carriers; unicast/world/all refused
      `ack leader is unsupported for <carrier> <shape> targets` (guard, green at base); an unsupported leader request kept
      (caps `['none','hop']` → `leader`, no note); the resolver (`session-1`; undefined without the session, the metadata,
      or with another principal); narrowing rows `leader` s1 true / s2 false; lifecycle leader `acknowledged` only with
      `d` confirmed, and the `no-leader` refusal → `rejected`, failure `{ kind: 'refused', reason: 'no-leader' }` (guard);
      the WS client reading a stub authorizer's `no-leader` NACK as `{ kind: 'relay-rejected', rejection: { relay:
      'trusted-server', reason: 'no-leader' } }`; the black-box decoder row `{ relay: 'trusted-server', reason: 'no-leader' }`.
- [ ] **Step 2: Run red.** `npx vitest run packages/tests/shared/al-contracts/validate-al-ack-support.test.ts
      packages/tests/shared/al-contracts/al-carrier-capabilities.test.ts packages/tests/shared/al-contracts/al-audience-narrowing.test.ts
      packages/tests/shared/group-director.test.ts packages/tests/shared/alm/delivery/compute-al-delivery-lifecycle.test.ts
      packages/tests/shared/multicast/rtc-leader-audience.test.ts packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts
      packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`: 24 failed, 261 passed (285); e.g. `TypeError:
      resolveRallarGroupLeaderSessionId is not a function`, `expected 'subtree' to be 'leader'`, `expected { kind:
      'admitted', …(2) } to deeply equal { kind: 'refused', …(2) }`, `TypeError: Control NACK reason is invalid`.
- [ ] **Step 3: Implement.** Green: 285 passed (subtree-synonym edits green before and after).
- [ ] **Step 4: Verify.** `npx vitest run packages/tests/shared/multicast packages/tests/shared/al-contracts
      packages/tests/shared/alm packages/tests/shared/services packages/tests/shared/al-policy.test.ts
      packages/tests/shared/al-message-persistence-decoding.test.ts packages/tests/shared/ws-server-qos-policy.test.ts
      packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts
      packages/tests/shared/rtc-snapshot-nack.test.ts packages/tests/shared/al-inbound-message-runtime.test.ts
      packages/tests/shared/multicast-policy-integration.test.ts packages/tests/shared/group-director.test.ts
      packages/tests/shared-web/messages packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
      packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared-test
      packages/tests/shared-server/rallar-system/websocket packages/tests/rallar-black-box-headless` (410 files, 4954
      tests; the four pins inside, unedited): only the sandbox reds `api-v1-rtc-rtt-recipe-semantics`,
      `api-v1-state-write-convergence-recipe`, `local-websocket-session` (10, identical at `c0ae57d71`) and load-timeouts
      that pass alone (`al-inbound-queue-work`, `outbound-admission-read-order`, `outbound-delivery-settlements`).
      `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit`; `node
      scripts/check-tests-typecheck.mjs` (PASS); `deno check` on the 23 changed `packages/shared/**` files; `cd apps/api-v1
      && deno task check`, then `rm -rf apps/api-v1/node_modules/.deno`. Bundles (private `TMPDIR`): facade 241.087 KiB
      (base 240.886) → budget 242; headless 306.476 (base 306.074) under 307; public API snapshot unchanged. `npx dprint
      fmt` on the touched files (pipe the list through `xargs`).
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- c0ae57d71 HEAD` (verdict line: `PASS: no new
      repository style findings`), `node scripts/check-test-structure-coupling.mjs --changed c0ae57d71 HEAD` (PASS),
      `npm run check:test-reachability` (a test file was added; 1770 files).

```text
Add the leader receipt and refuse a group-leader send with no leader on RTC

group-leader stops meaning subtree: it normalizes to a fourth receipt
algorithm, leader, which every carrier declares, kept and never
downgraded, supported on room audiences only (unicast, world and all are
unsupported). receiver and leader count logical recipients wherever a
receipt is planned, tracked, decoded or read.

The room's leader is its appointed director session while present
(resolveRallarGroupLeaderSessionId). The RTC origin narrows the audience
a group-leader send names, after its exceptions, to that session and
freezes it as the multicast of the director alone; a send frozen to
nobody is refused no-leader (refusal reason, drop code, NACK reason; not
a fallback trigger), and a trusted server's no-leader NACK before a
receipt row is a relay rejection. A leader room broadcast holds and
freezes at the replan as A1's audiences do. Tests that used group-leader
as a synonym for subtree ask for qos.ack subtree.

Bundle budget raised: browser/rallar.ts measures 241.087 KiB (base
240.886) against 241, now 242; headless 306.476 KiB (base 306.074),
under 307.

D8 reuse: A1's ALAudienceNarrowing and isALAudienceSession, computeFrozenAudience, the origin and carrier-gap freezes, the freeze comparison and the room refusal plan carry the leader; readRallarGroupDirectorFromSnapshot and isRallarGroupDirectorSessionActive resolve it; the receiver receipt machinery and the trusted-server relay rejection count it.
```

### Task 2: The WS server addresses a group-leader room send to the room's director, and refuses it no-leader (D164, D165)

**Files** (anchors at Task 1's commit, this task's parent, which touches none of the source files below; the composed commit is `final-patch-task-2.patch`, `git am`-able on `final-patch-task-1.patch`; 11 files)

- `packages/shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts`:
  - imports (`:6-9`) gain `toALLeaderNarrowing`, `resolveALAdmittedRoomAudience` (`al-frozen-multicast-audience.ts`),
    `resolveRallarGroupLeaderSessionId` and `filterLiveWsRoomRecipientSessionIds` (`../queue-pubsub/live-ws-audience.ts`);
  - a new exported `interface AuthorizedRoomAudienceMessage { readonly targets: ALTargets; readonly delivery?: ALMessage['delivery']; }`
    (doc: "What a room message's authorized audience reads of it: whom it names, and the receipt it asks for.");
  - `toAuthorizedRoomAudience(snapshot, message: AuthorizedRoomAudienceMessage, nowEpochMs)` (`:123-140`, was `targets: ALTargets`) adds
    `const leader = toALLeaderNarrowing(message, resolveRallarGroupLeaderSessionId(snapshot))` and filters
    `isALAudienceSession(session, narrowing) && isALAudienceSession(session, leader)` after the active-member and live-lease filters. A
    director with an expired lease therefore drops out, as on RTC (R-A2a-8);
  - callers: `computeServerRoomPublicationAudience` (`:69`) passes `{ ...message, targets: message.targets }`; `authorizeGroupRoomMessage`
    (`:117-120`) builds `audience` from `{ ...input.message, targets }` (the cloned targets);
  - when the private `isLeaderlessRoomAudience(input.message, audience)` holds, `authorizeGroupRoomMessage` returns
    ``{ authorized: false, reason: 'no-leader', logMessage: `Rejected room message for ${input.roomId}: no-leader: the room has no active
    leader inside the audience the send names.`, serverSnapshotVersion }``;
  - `isLeaderlessRoomAudience`: `false` unless `delivery?.ack === 'group-leader'`; else
    `filterLiveWsRoomRecipientSessionIds(audience.targets, senderId, resolveALAdmittedRoomAudience(message, sessionIds)).every((id) => id ===
    senderId)`. These are the filters delivery applies (exclusions, list, frozen list, origin), so the sender as director, `exceptPeerIds`, a
    list or a principal that leaves the director out are each refused. Doc in the patch; no decision ids in code.
- Ingress needs no edit. The router maps every room-authorizer denial to code `unauthorized` with the authorizer's reason
  (`rallar-server-ws-router.ts:264-270`, the `membership-fenced` path). The service sends the advisory NACK with that reason
  (`ws-queue-box-server-inbound-authority.ts:159-162,312-353`). The WS origin maps it to `relay-rejected`/`trusted-server`/`no-leader`
  through Task 1's `isTrustedServerAdmissionRefusal`.
- `packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts:233` (doc `:216-220`),
  `…-inbound-plan.ts:42`, `…-outbound-planning.ts:363-368` (doc): `effective.ack.algo === 'receiver'` → `isALLogicalReceiptMode(…)`
  (`validate-al-ack-support.ts:43`). The aggregate then expects `[leader]` (`toFrozenAudience` unchanged), the server sends no ACK of its own,
  and the outbox row expects the admitted audience.
- `packages/shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts:11-62`: the three `'receiver'` tests (`:49,59,61`)
  → `isALLogicalReceiptMode`; the doc names the `leader` room send.
- Not edited: `targets/resolve-ws-group-target.ts:98`. The outbox dequeue resolves recipients through the target resolver over the local
  cached snapshot and intersects them with the row's `admittedAudience` (`ws-queue-box-server-outbound-planning.ts:176,300-310`). A leader
  narrowing there reads the director from a cache that may predate the appointment and drops an authorized send. The prototype showed this:
  the api-v1 outbox case went red. Delivery is already narrowed by the admitted audience.
- Tests:
  - `packages/tests/shared-server/rallar-system/websocket/ws-topic-room-authorizer.test.ts`: tests before `:179`; helpers
    `createLeaderRoomSnapshot`, `withDirector`, `leaderRoomMessage`, `leaderAuthorizationInput` at the end; imports
    `createRallarGroupDirectorAppointment`, `mergeRallarGroupDirectorMetadata`, `RallarServerWsRoomAuthorizationInput`.
  - `packages/tests/shared/services/ws-queue-box-server-receipt-aggregation.test.ts`: option `authorizedPeerIds?` at `:67`, used at `:468`;
    a test before `:230`.
  - `…/ws-queue-box-client-receipt-tracking.test.ts`: a test at the end of the first describe (before `:205`).
  - `packages/tests/shared-server/rallar-system/websocket/router/rallar-server-ws-live-publication.test.ts`: a test before `:631`; the it.each
    at `:631-635` gains `leader`, and its message becomes a `{ room, principal, leader }[audience]` lookup; `createRoomClusterFixture`
    (`:1210-1219`) appoints `carol-1`.
  - `packages/tests/shared/al-contracts/al-audience-narrowing.test.ts:54` becomes `{ ...message, targets: message.targets! }`.
  - `apps/api-v1/test/services/ws-room-authority-delivery.test.ts`: tests before `:704`; helpers `leaderMessage` and `withDirector` before
    `:787`.

**Interfaces.**

- Consumes from Task 1:
  - `toALLeaderNarrowing(message, leaderSessionId)` (`al-audience-narrowing.ts:45`) and `isALAudienceSession`'s `leader` case;
  - `resolveRallarGroupLeaderSessionId`;
  - `isALLogicalReceiptMode` (`validate-al-ack-support.ts:43`);
  - the `'leader'` algorithm and carrier support;
  - the `no-leader` NACK and the trusted-server `relay-rejected` arm, its black-box decoder and its WS-client pin;
  - the two `services/` subtree pins.
- Produces:
  - `AuthorizedRoomAudienceMessage`;
  - the narrowed `[leader]` audience on every WS path;
  - the ingress refusal `no-leader` (code `unauthorized`). Tasks 3 and 4 read the WS failure as `relay-rejected`, with
    `failure.rejection.reason === 'no-leader'`.

**D8 reuse inspection.** No new audience, refusal path or aggregate. `toALLeaderNarrowing` and `isALAudienceSession` narrow the authorized
sessions. `resolveALAdmittedRoomAudience` and `filterLiveWsRoomRecipientSessionIds` decide the refusal exactly as delivery would. The narrowed
`sessions` feed the router, the receipt, the outbox `admittedAudience`, the cluster bridge and the live notice. The `receiver` aggregate and
receipt row count the leader.

- [ ] **Step 1: Write the tests** (copy from the patch).
  - Authorizer:
    - "narrows the audience of a group-leader room send to the appointed director session in the room": sessions a, b, c; director c;
      sender a → `sessions: [c]`, `snapshotVersion: 2`.
    - it.each "refuses a group-leader room send no-leader when $situation", with six situations: no director is appointed; the director has
      no live session in the room (`session-gone`); the director sent it; its fixed list omits the director (`['session-b']`); it excepts the
      director (`exceptPeerIds: ['session-c']`); the principal it names is not the director's (principal `session-b`). Each →
      `{ authorized: false, reason: 'no-leader', logMessage: 'Rejected room message for leader-room: no-leader: the room has no active leader
      inside the audience the send names.', serverSnapshotVersion: 2 }`.
    - "refuses a group-leader room send no-leader when the director's presence lease has expired" (`expiresAtEpochMs: 1`) → `toMatchObject({
      authorized: false, reason: 'no-leader' })`.
  - Aggregation: "aggregates a group-leader room send against the one leader its room authority admitted, as the receipt of that leader".
    With `authorizedPeerIds: ['a', 'c']`, the sent receipts are `[['admitted', ['c']]]`, then after c's ACK `[['admitted', []], ['complete',
    ['c']]]`. c gets one copy, b none, and no ACK frame reaches a.
  - WS client: "tracks a group-leader room send as the leader receipt the admitted receipt names, and acknowledges it on the leader alone".
    The send gives `['admitted', 'leader']`; the row is `{ mode: 'leader', expectedPeerIds: ['c'] }`; the acknowledgement has `mode: 'leader'`,
    no hops, `complete: true`.
  - Live publication:
    - "publishes an admitted group-leader room send as a room notice naming the director session alone" → `recipientSessionIds:
      ['carol-1']`.
    - The 9 KB it.each row `leader` → an inbound-key `room` notice, `remoteSent [['carol-1']]`, nothing for dave. This is the cluster parity
      pin.
  - api-v1:
    - "a group-leader room send reaches the appointed director alone, and its receipt expects the director and completes on its ACK", over
      live-only and outbox. The cached snapshot predates the appointment (one-line intent comment). carol gets one frame, alice and bob none.
      The receipts are `[['admitted', ['carol'], []], ['complete', ['carol'], ['carol']]]` and the outbox `admittedAudience` is `['carol']`.
    - Five "a group-leader room send is refused no-leader with its typed NACK and reaches no one when …": no director is appointed; the
      director sent it; its fixed list omits the director; it excepts the director; the principal it names is not the director's. Each:
      `accepted.left.code 'unauthorized'`, the sender's frames are one NACK `no-leader`, no chat frame or receipt reaches anyone, and the
      outbox is empty.
- [ ] **Step 2: Run red.**
  - The five vitest files (authorizer, aggregation, client receipt tracking, live publication, al-audience-narrowing; pipe the list through
    `xargs` under zsh) → 13 failed, 96 passed. al-audience-narrowing's 2 failures are the signature change.
  - `cd apps/api-v1 && deno test --no-check --allow-env --allow-read --allow-write "--allow-run=$(deno eval 'console.log(Deno.execPath())')"
    test/services/ws-room-authority-delivery.test.ts test/services/filter-eligible-live-ws-session-ids.test.ts` → 6 failed, 29 passed.
- [ ] **Step 3: Implement** as listed. Green: 109 vitest; Deno 35.
- [ ] **Step 4: Verify.**
  - `npx vitest run packages/tests/shared/services packages/tests/shared/alm packages/tests/shared/ws-qos-policy.test.ts
    packages/tests/shared/ws-server-qos-policy.test.ts packages/tests/shared-server packages/tests/shared/al-contracts packages/tests/shared/multicast
    packages/tests/shared/multicast-policy-integration.test.ts packages/tests/shared/group-director.test.ts packages/tests/shared-web/websocket
    packages/tests/shared-web/messages packages/tests/shared-test` → 774 files: 7352 passed, 12 skipped, 11 failed. Ten are the sandbox
    loopback `listen EPERM` ones: rtc-rtt recipe 5, state-write recipe 4, local-websocket-session 1. The eleventh is the IndexedDB
    load timeout in `outbound-delivery-settlements.test.ts` ("settles a retained send its relay refuses with a resync-required
    NACK as rejected by that relay, with no resend, over indexeddb": `expected 'pending-control' to be 'committed'`), which
    passes alone (37 passed, twice). The four pins pass unedited.
  - `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit` and `node scripts/check-tests-typecheck.mjs`.
  - `deno check` on the changed `packages/shared*` files.
  - `cd apps/api-v1 && deno task check`, then `deno test … test/` (619 passed), then `rm -rf apps/api-v1/node_modules/.deno`.
  - Bundle checks with a private `TMPDIR`: `rallar.ts` 241.087 KiB < 242 (Task 1's budget), headless 306.507 KiB < 307; the boundary and headless tests pass.
  - `npx dprint fmt` on the touched files only, through `xargs`.
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- c0ae57d71 HEAD` (PASS) and `node scripts/check-test-structure-coupling.mjs
      --changed c0ae57d71 HEAD` (PASS). No test file is added.

**True of the code after this task.**

- A WS `group-leader` room send reaches the appointed director's live session alone, inside the audience the sender names after exclusions
  and never the sender. This holds on the live send, forwarding, the outbox, the cluster bridge and the live notice: the inline `room`
  notice, or the `room` inbound-key notice whose canonical row captured `[leader]`. Memory and Postgres agree, whatever the local cache holds.
- Its receipt expects the director and completes on the director's ACK.
- With no such director the server refuses it at ingress (`unauthorized`, NACK `no-leader`) and it reaches no one. The WS origin ends it
  `rejected` with `relay-rejected`/`no-leader`.
- A send retained as `not-yet-in-sync` whose room later has no leader is dropped without a NACK, as a retained `membership-fenced` send is.
- A server publication with `group-leader` and no leader reaches no one.

```text
Address a group-leader room send to the room's director on the WS server

The room authorizer narrows a group-leader send with the leader its
snapshot appoints, beside the audience the sender names, so the
authorized sessions are the director's live session alone. The receipt
aggregate, the router's delivery, the outbox row's admitted audience,
the cluster bridge and the live notice (inline, or keyed to the inbound
row that captured the narrowed audience) all carry that one session,
whatever the local cache holds. When that audience delivers to no
leader - no director live in the room, an expired presence lease, the
director as the sender, or exclusions, a list or a principal that leave
the director out - the authorizer refuses the send no-leader, and
ingress answers it as it answers a membership-fenced room send: the
rejection code unauthorized and an advisory no-leader NACK, with nothing
admitted or delivered.

The server aggregates a leader receipt as a receiver receipt of its one
expected recipient and sends no acknowledgement of its own, and the WS
client tracks a leader room send as a logical receipt that expects
nobody until the admitted receipt names the leader.

D8 reuse: toALLeaderNarrowing and isALAudienceSession narrow the authorized sessions, resolveALAdmittedRoomAudience and filterLiveWsRoomRecipientSessionIds decide the refusal as delivery does, and the receiver aggregate and receipt row count the leader; no new audience, aggregate or refusal path.
```

### Task 3: The browser leader send and the AR Eye relay by role (D166, D167)

**Files** (anchors at Task 2's commit, this task's parent; they equal `c0ae57d71` for every file below, because Tasks 1
and 2 touch none of them but `browser-message-tracked-receipt.test.ts`, whose edits here are anchored by name; the
composed commit is `final-patch-task-3.patch`; 9 files, +298/−26)

- `packages/shared-web/browser/messages/browser-message-input-validator.ts`: import `type ALAckMode` from
  `@shared/al-contracts/al-contract.ts`; `validateRtc` after `pushAudienceIssues` (`:84`) and `validateWs` after
  `pushAudienceIssues` (`:112`) push `...validateLeaderAudience(input.ack, <scope>)` (RTC: `input.scope ?? 'room'`; WS:
  the resolved `scope`). At the end of the file the private function:
  the doc ``/** A `group-leader` send addresses its room's leader, so it names a room audience: never the world (D166). */``
  on `function validateLeaderAudience(ack: ALAckMode | undefined, scope: RallarMessageScope): readonly RallarValidationIssue[]`
  → for `ack === 'group-leader' && scope === 'world'` one issue `{ path: '$.ack', code: 'leader-requires-room-audience',
  message: "A group-leader send addresses its room's leader: it names a room audience, never the world." }`, else `[]`.
- `packages/shared-web/browser/messages/create-browser-unicast-message.ts` `validatePeerCarriage` (before `return issues`,
  `:138`): `send.ack === 'group-leader'` pushes `{ path: '$.ack', code: 'leader-requires-room-audience', message: "A
  group-leader send addresses its room's leader: it names a room audience, never one peer." }` — it runs for every
  peer-addressed send (`sendScoped` on ws, `validateBrowserRtcPeerSend` on rtc and rtc-with-ws-fallback), and
  `validateWs` never sees `peerId`, so no issue is raised twice. `sendRtc`/`sendWs` pass the ack unchanged.
- `packages/shared-web/browser/director/browser-director-relay-transport.ts`: `sendCommand` (`:61-64`) reads only
  `roomRef` (`const roomRef = input.current.roomRef; if (!roomRef) throw …`); the send options (`:73-76`) become
  `{ ack: 'group-leader', strategy: 'rtc-with-ws-fallback' }` (no `peerId`). `readDirectorReceipt` (`:201-213`), doc
  "The room's leader confirms a command; a room without one refuses it `no-leader` on either carrier (D167).": on
  `acknowledged` `{ status: 'sent', receipt }`; else `{ status: isNoLeaderFailure(lifecycle.evidence.failure) ?
  'no-director' : 'failed', receipt, reason: lifecycle.evidence.reason ?? DIRECTOR_COMMAND_UNCONFIRMED_REASON }`.
  Private `isNoLeaderFailure(failure: ALDeliveryFailure | undefined): boolean` — `refused` with `reason === 'no-leader'`
  (the RTC origin) or `relay-rejected` with `rejection.reason === 'no-leader'` (the WS ingress, the ruled seam); import
  `type ALDeliveryFailure` from `@shared/alm/delivery/al-delivery-failure.ts`. `readCommandRejection` (`stale-director`,
  `not-director`, the client-side `no-director`) and `sendRoomEnvelope` are unchanged; the game layer
  (`rallar-game-director-relay-runtime.ts:229`) keeps mapping `stale-director` to `no-director`, so its API is unchanged.
- Tests: `packages/tests/shared-web/messages/browser-message-audiences.test.ts` (after `:279`, new describe "a group-leader
  send"), `browser-message-tracked-receipt.test.ts` (new describe before `toRoute`, helpers `LeaderRtcLeg`,
  `createLeaderRtcLeg`, `recordCompleteAcknowledgement`, `createLeaderSend`, `toLeaderReceipt`; imports
  `newALNackControlMessage`, `newALReceiptControlMessage`, `ALReceiptPayload`, `ALDeliverySettlement`, and from the RTC
  origin fixture `acknowledgeAtOrigin`, `toOriginDirectedSnapshot`, `RtcOriginOverlayFixture`),
  `browser-message-fallback-identity.test.ts:113,116` (the two `group-leader` rows of the RTC room-limit table go: a
  leader audience is at most one session, so that refusal cannot occur), `director/browser-director-relay-transport.test.ts`
  (`:147,153,187`, a new `it.each` after `:191`, helper `toNoLeaderCommand` after `:339`, `recordDirectorReceipt` mode
  `'leader'` `:346`), `director/browser-director-relay-runtime.test.ts:291,333-337` (title "sends a director $command as
  one command to the room's leader whose WS fallback keeps its msgId (D60)"; targets `{ mode: 'multicast', groupRef }`,
  delivery `{ reliability: 'at-least-once', ack: 'group-leader' }`), `director/director-command-storage-volume.test.ts:95-96`
  (same targets and delivery) and `:148` (mode `'leader'`).

**Interfaces consumed**: Task 1's `'leader'`, `'no-leader'` arms, the trusted-server `no-leader` relay rejection,
`toOriginDirectedSnapshot`; Task 2's WS client tracking of a leader send as a logical receipt (expects nobody until the
server's `admitted` receipt) and its ingress NACK `no-leader`. **Produced**: the validator code
`leader-requires-room-audience`; the relay's `no-director` for a `no-leader` command. Public surface: no export changes
(`shared-web-public-api-snapshots.test.ts` unchanged).

**D8 reuse inspection.** The room command channel, the validator's issue shape, the relay's typed `no-director` status
and the carriers' leader narrowing carry the role-addressed command; no new channel, status, option or send path. The
facade proofs reuse the tracked-receipt harness (`createDispatchHarness`, `createWsClient`) and Task 1's RTC origin
fixture rather than a second harness.

- [ ] **Step 1: Write the failing tests** (copy from the patch). Audiences: `it.each(['ws','rtc','rtc-with-ws-fallback',
      'ws-then-rtc'])` "passes a group-leader room send through to its carrier with the ack unchanged on %s" (first
      admitted message: `targets` with `groupRef: ROOM_REF`, mode not `unicast`, `delivery.ack` `group-leader`; green at
      base, a guard); same four "refuses a group-leader world send on %s before either carrier admits it" (topic
      `app.chat`, `scope: 'world'`; rejects with `{ path: '$.ack', code: 'leader-requires-room-audience' }`, neither
      carrier called); `['ws','rtc','rtc-with-ws-fallback']` "refuses a group-leader send addressed to one peer on %s
      before either carrier admits it" (`peerId: 'peer-1'`). Facade proofs on the real carriers (green once Tasks 1–2
      land; they pin the ruled seams): `it.each(['rtc','rtc-with-ws-fallback'])` "ends a group-leader send on %s
      acknowledged when the director session confirms it, with no WS leg" (snapshot `toOriginDirectedSnapshot(
      createOriginSnapshot(['a','b','c'], 4), 'c')`, ACK from `c` for `c`, the origin's complete acknowledgement relayed
      to the registry; `{ state: 'acknowledged', receiptAlgo: 'leader', evidence: { receiptMode: 'leader',
      expectedRecipientPeerIds: ['c'], confirmedRecipientPeerIds: ['c'] } }`, no WS admission); same two "ends a
      group-leader send on %s rejected for no leader when the room appoints no director, with no fallback" (failure
      `{ kind: 'refused', reason: 'no-leader' }`, `carrierFallback` undefined, no WS admission); "ends a group-leader send
      on ws acknowledged when the server's receipt names the director confirmed" (`admitted` receipt with expected
      `['director']`, then `complete` confirming it; receiptMode `leader`); "ends a group-leader send on ws rejected by
      the server's no-leader refusal, as its relay rejection" (server NACK `reason: 'no-leader'` before any receipt row;
      failure `{ kind: 'relay-rejected', rejection: { relay: 'trusted-server', reason: 'no-leader' } }`). Relay: "sends %s on
      its own command channel to the room's leader and reports sent on the leader's receipt" (options `{ ack:
      'group-leader', strategy: 'rtc-with-ws-fallback' }`); `it.each(['rtc','ws'])` "reports a command refused for no
      leader on %s as no-director, with its receipt and reason" (rtc: verdict `refused`/`no-leader`; ws: admitted, then a
      `relay-rejected` settlement `{ relay: 'trusted-server', reason: 'no-leader' }`; result `{ status: 'no-director',
      receipt, reason: <the lifecycle's evidence.reason> }`, state `rejected`).
- [ ] **Step 2: Run red.** `npx vitest run packages/tests/shared-web/messages/browser-message-audiences.test.ts
      packages/tests/shared-web/messages/browser-message-tracked-receipt.test.ts
      packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts
      packages/tests/shared-web/director/browser-director-relay-transport.test.ts
      packages/tests/shared-web/director/browser-director-relay-runtime.test.ts
      packages/tests/shared-web/director/director-command-storage-volume.test.ts`: 14 failed, 107 passed (121); e.g.
      `promise resolved "{ …(6) }" instead of rejecting` (7, the validator), `expected { status: 'failed', …(2) } to deeply
      equal { status: 'no-director', …(2) }` (2), `expected "vi.fn()" to be called with arguments` (2, the options), the
      runtime and storage-volume targets (3).
- [ ] **Step 3: Implement** the validator, the peer carriage issue and the relay. Green: 121 passed.
- [ ] **Step 4: Verify.** `npx vitest run packages/tests/shared-web packages/tests/ar-eye-hunter-v1
      packages/tests/rallar-black-box-headless` (188 files, 1601 passed; the public API snapshot, bundle-boundary and
      headless bundle tests inside); `npx tsc -p packages/shared-web/tsconfig.json --noEmit`; `npx tsc -p
      packages/shared-test/tsconfig.json --noEmit`; `cd apps/ar-eye-hunter-v1 && npm run typecheck`; `node
      scripts/check-tests-typecheck.mjs` (PASS); `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` with a
      private `TMPDIR` (`mktemp -d /tmp/claude-501/b.XXXX`): `browser/rallar.ts` 241.246 KiB against 242 (raised by Task 1),
      headless 306.528 KiB against 307 (306.507 after Task 2) — no budget moves here. `npx dprint fmt`
      on the touched files (pipe through `xargs`). No `packages/shared/**` file changes, so no `deno check`.
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- c0ae57d71 HEAD` (verdict `PASS: no new repository
      style findings`), `node scripts/check-test-structure-coupling.mjs --changed c0ae57d71 HEAD` (PASS). No test file is
      added, so no reachability run.

```text
Address the director by role and refuse a group-leader send without a room

A browser send asking group-leader with scope world, or addressed to one
peer, is refused before either carrier admits it
(leader-requires-room-audience): the leader is its room's. A room send
passes the ack to its carrier unchanged, and the carriers narrow it. The
handle proofs run on the real carriers: on rtc and rtc-with-ws-fallback a
group-leader send is acknowledged when the director session confirms it,
and rejected with the refusal no-leader when the room appoints none,
with no WS leg and no fallback evidence; on ws the server's receipt
naming the director acknowledges it and the server's no-leader NACK ends
it rejected as a trusted-server relay rejection. The RTC room-limit
fallback rows no longer list group-leader, whose frozen audience is at
most one session.

The AR Eye director relay sends intents and sync requests on the room
command channel with ack group-leader over rtc-with-ws-fallback instead
of a unicast to the cached appointment's session; the authority resolves
the director at admission. A command refused for no leader on either
carrier reads no-director; the stale-director and not-director checks
still run before the send, and director outputs are unchanged.

Bundles: browser/rallar.ts measures 241.246 KiB against 242; the headless
agent 306.528 KiB against 307.

D8 reuse: the room command channel, the browser validator's issue shape, the relay's typed no-director status and the carriers' leader narrowing carry the role-addressed command; no new channel, status or send path.
```

### Task 4: The `leader-ack` lane family (D169)

Composed commit: `final-patch-task-4.patch` (32 files, +848/−82), `git am`-able on Task 3's commit. Line anchors are on
`c0ae57d71`, which equals Task 3's commit for every file below except `rallar-bb-test-alm-commands.test.ts` (Task 1 edited
its `:622-625`; this task's edits there are anchored by name). The prototype ran on a local stub of Tasks 1–3 that added
`'leader'` to `ALAckAlgo` (`al-policy.ts:32`), `'no-leader'` to `ALDeliveryRefusalReason` (`al-delivery-lifecycle.ts:59-64`),
`resolveRallarGroupLeaderSessionId(snapshot)` (`group-director.ts`, before `createRallarGroupDirectorAppointment`), `leader: 3` in
`AL_ACK_ALGO_STRENGTH` (`compute-al-delivery-lifecycle.ts:386`), `'no-leader': true` in `ALM_REFUSAL_REASONS`
(`shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts:22-28`) and `leader: true` in `ALM_RECEIPT_MODES`
(`decode-alm-runtime-result.ts:44`). Task 1 provides all six (R-A2a-28), so nothing of the stub remains and
nothing moved between tasks.

**Files**

- Create `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/leader-ack/{leader-ack-commands,leader-confirms,no-leader-refused,leader-outside-list}.ts`
  (the helpers live in the family folder: one more file in `conformance/alm/` trips `layout.directory-density`, 23 > 20);
  `packages/tests/shared-test/alm-conformance-leader-ack.test.ts`.
- Modify (lane) `conformance/alm/alm-conformance-message-commands.ts:30,67,194`, `alm-conformance-receipt-commands.ts:1,34-35,111-134`,
  `alm-conformance-scenario-definition.ts:42-43`, `create-alm-conformance-recipes.ts:45-46,131`, `scenarios/audiences/{world-routing,fixed-list-delivery,principal-delivery}.ts`,
  `scenarios/receipted-audience.ts:56,80-84,104,132`, `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts:70-71`,
  `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md` (after the membership-fence hosted sentence, `:343`).
- Modify (harness `recipientPeer: 'recipient-b'`) `rallar-bb-test/rallar-black-box-test-contracts.ts:329-334`, `schema/rallar-black-box-command-fields.ts:307`,
  `alm/rallar-black-box-alm-command-capabilities.ts:22-25`, `black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts:302`,
  `.../messaging/decode-black-box-rallar-message-send-input.ts:50-52,145`, `.../messaging/resolve-black-box-rallar-message-peer.ts:15-20,45-62`,
  `.../messaging/black-box-rallar-delivery-ledger.ts:226-231`, `.../browser-rallar-runtime-composition.ts:57,136-140,259`.
- Modify tests `packages/tests/shared-test/{alm-conformance-recipes,alm-conformance-recipe-validation,rallar-bb-test-alm-commands}.test.ts`,
  `rallar-browser-runtime/{delivery,resolve-black-box-rallar-message-peer}.test.ts`, `rallar-browser-runtime/browser-runtime-facade-test-double.ts:205,369`,
  `packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts:758-760`, `packages/tests/rallar-black-box/{full-stack-three-agent-run,hetzner-alm-manifest-entries}.test.ts`.

**Interfaces**

- Send helper: `AlmConformanceSendDelivery.ack?: 'receiver' | 'all-logical-recipients' | 'group-leader'`. World-routing's local
  `WorldVerdictFact` and `toVerdictCommands` move to `alm-conformance-message-commands.ts` as `export type AlmConformanceVerdictFact`
  and `export function toVerdictCommands(sender, state: ALDeliveryState, facts)` (moved, not copied; world-routing imports them).
- Receipt window: `toReceiptWindowCommands(sender, { roles, ending, mode }: AlmConformanceReceiptWindow)` with
  `interface AlmConformanceReceiptWindow { roles; ending; mode: Extract<ALReceiptMode, 'receiver' | 'leader'> }`; the
  `receiptMode` assertion reads `mode` (it was the literal `'receiver'`). The six existing callers pass `mode: 'receiver'`.
- `leader-ack-commands.ts`: `toDirectorAppointCommand(step)` / `toDirectorResignCommand(step)` →
  `{ kind: 'director.appoint' | 'director.resign', commandId: <step>-director-appoint|resign, roomRef: toRoomRef(group), timeoutMs: 5_000 }`
  (the page appoints / resigns its own session, `director-controller.ts:333-376`; the receiver owns the lane group,
  `full-stack-three-agent-run.ts:73-77`, so `resolveRallarGroupDirectorAppointmentEligibility` allows it while others are online);
  `toLeaderActivityWait(sender, active)` → a `loop` `until: 'first-success'`, `count: NON_EXPIRING_SEND_TIMEOUT_MS / 200`,
  `intervalMs: 200`, named `await-leader` / `await-no-leader`, children `director.status { roomRef, refresh: true }` (`leader-status`)
  and an assert on `resultCache.<loop>:i{loop.iteration}:c1:<leader-status>.value.directorStatus.active` equals `active`
  (durable-takeover's poll shape); `toLeaderSendCommand(sender, recipientPeer)` → send-1 with `ack: 'group-leader'`,
  `reliability: 'at-least-once'`, `ttlMs: NON_EXPIRING_TTL_MS`, the audience payload, and `recipientPeer` when given;
  `toNoLeaderVerdictCommands(sender)` → `observe-rejected-1` + facts. rtc: `refused` (`failure.kind`=`refused`), `no-leader`
  (`failure.reason`), `no-attempt` (`attempts`=0). ws (W-A/W-B fact: the NACK settles the one attempt): `relay-rejected`
  (`failure.kind`), `trusted-server` (`failure.rejection.relay`), `no-leader` (`failure.rejection.reason`), `one-attempt` (`attempts`=1).
- Scenarios (all `FULL_TAGS`, `ALM_CONFORMANCE_THREE_AGENT_ROLES`, `laneFamily: 'three-agent'`, ids alphabetical in the union,
  registered after `worldRouting`: `leaderConfirms, noLeaderRefused, leaderOutsideList`):
  `leader-confirms` (all three carriers; `toReceiptRoles` `{ confirmed: ['receiver'], unconfirmed: [] }`): sender
  `await-leader`, send-1, admission, `toServerReceiptCommands`, window `{ roles, ending: 'acknowledged', mode: 'leader' }`;
  receiver `director-appoint`, `toSingleArrivalReceiverCommands`, `director-resign`; recipient-b `received-1` absent.
  `no-leader-refused` (`['ws', 'rtc']`): sender `await-no-leader`, send-1, verdict; receiver `director-resign` then `received-1`
  absent; recipient-b `received-1` absent. `leader-outside-list` (`['ws']`): sender `await-leader`, send-1 with
  `recipientPeer: 'recipient-b'`, verdict; receiver `director-appoint`, `received-1` absent, `director-resign`; recipient-b absent.
- Harness: `recipientPeer?: 'receiver' | 'recipient-b'` (contract doc: resolved among the room's other live sessions whose principal
  is not the sender's: `receiver` the one such session, `recipient-b` the one that is not the room's leader); values
  `messagesRecipientPeer: ['receiver', 'recipient-b']`; decoder issue `'messages.send.recipientPeer must be receiver or recipient-b.'`.
  `ResolveBlackBoxRallarRecipientPeerInput` gains `recipientPeer` and `leaderSessionId: string | undefined`; `recipient-b` filters
  out the leader; Left text `` `the room holds ${n} other live sessions of another principal${recipient-b ? ' beside its leader' : ''}, not exactly one` ``.
  `BlackBoxBrowserPeersDependency.getRoomLeaderSessionId(roomRef): string | undefined` = `resolveRallarGroupLeaderSessionId` (Task 1)
  of `state.roomStateStore.findGroupSnapshot(roomRef)`; the ledger passes `recipientPeer` and the leader id.
- Hosted: `HETZNER_WITHHELD_ALM_SCENARIOS` gains `leader-confirms` (`ALM_CONFORMANCE_CARRIERS`), `no-leader-refused` (`['ws', 'rtc']`),
  `leader-outside-list` (`['ws']`) under "The leader cells' lane evidence is local and the hosted full read's; manifest 22 stays as recorded."

**D8 reuse inspection.** `toSendCommand`, `toAdmissionCommands`, `toServerReceiptCommands`, the receipt window and the role identity
assessment (`almReceiptRoles` metadata), world-routing's verdict reader (moved), durable-takeover's first-success poll, the browser
director appoint/resign/status commands, Task 1's leader resolver, the lane-role resolution and its live filter, the withheld list.

- [ ] **Step 1: Tests (red).** Apply the patch's test files (or `git am` and revert the non-test files). Red against Task 3's tree:
      `npx vitest run packages/tests/shared-test/alm-conformance-leader-ack.test.ts packages/tests/shared-test/alm-conformance-recipes.test.ts packages/tests/shared-test/alm-conformance-recipe-validation.test.ts packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts packages/tests/shared-test/rallar-browser-runtime/resolve-black-box-rallar-message-peer.test.ts packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts`
      → `Test Files  8 failed (8)`, `Tests  23 failed | 179 passed (202)` (Task 1 added the trusted-server `no-leader` decoder row to
      `rallar-bb-test-alm-commands.test.ts`).
- [ ] **Step 2: Implement** the lane, harness and hosted files. Same command → `Test Files  8 passed (8)`, `Tests  202 passed (202)`;
      plus `alm-conformance-audiences`, `alm-conformance-membership-fence`, `hetzner-distributed-manifests`,
      `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` → `Test Files  12 passed (12)`, `Tests  271 passed (271)`.
      The delivery test pins the ledger projection of an rtc `no-leader` refusal (`rejected`, `failure: { kind: 'refused', reason: 'no-leader' }`, `attempts` 0).
- [ ] **Step 3: Checks.** `npx dprint fmt <the 32 files>` (explicit list through `xargs`); `npx tsc -p packages/shared-test/tsconfig.json --noEmit`,
      `cd apps/rallar-black-box && npx tsc --noEmit` → clean; `cd apps/rallar-black-box-control-server && deno task check` → clean and
      `deno test --allow-run --allow-net --allow-env --allow-read --allow-write test/control-generated-alm-reload.test.ts` → `32 passed | 0 failed`,
      then `rm -rf node_modules/.deno`; `node scripts/check-tests-typecheck.mjs` → PASS (it fails until `rtc-authority-recovery.test.ts`'s
      peers double gains `getRoomLeaderSessionId`); the four storage pins → `Tests  27 passed (27)`;
      `node --import tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check` → `checked 67 Hetzner distributed manifest(s)`
      and `git diff --stat c0ae57d71 HEAD -- apps/rallar-black-box/manifests/hetzner/18-*.json apps/rallar-black-box/manifests/hetzner/22-*.json`
      empty; bundles with a private `TMPDIR`: facade 241.246 KiB < 242 (unchanged), headless 306.701 KiB < 307 (306.528 before: the
      harness peer resolver).
      After the commit: `npm run check:repo-style:changed -- c0ae57d71 HEAD` → `PASS` (the contracts file's unknowns are A1's reviewed
      disposition); `node scripts/check-test-structure-coupling.mjs --changed c0ae57d71 HEAD` → three PASS lines;
      `npm run check:test-reachability` → `1771 test files, 1765 reached by CI, 6 manual` (one file more).
- [ ] **Step 4: Lane (local, unsandboxed, needs Tasks 1–3).** `RALLAR_BLACK_BOX_ALM_SCOPE=full npm run test:rallar:full-stack:memory:alm -- -g "three-agent family"`
      → per carrier the leader cells pass beside the receipted-audience and fence cells. Not run while planning (loopback EPERM); Task 7 Step 4 runs it on private ports.
- [ ] **Step 5: Commit.**

```text
Prove the leader ACK in the conformance lane

A leader-ack family runs on the three agents, in the full scope. The
receiver owns the run's group, so its own page appoints itself the
room's director with director.appoint and ends that appointment with
director.resign. The RTC origin resolves the leader from the room
snapshot its own page holds, so the sender refreshes that snapshot with
director.status until it reads the director active, or not, before it
sends; each read is a child of a first-success loop within the send
budget.

leader-confirms (ws, rtc, rtc-with-ws-fallback): the sender's room send
asks for group-leader; the receiver receives it once and confirms it,
recipient-b never receives it, and the receipt reads acknowledged in
the leader mode with the receiver alone expected. The receiver resigns
after its window. no-leader-refused (ws, rtc): with no active director
the send ends rejected, over rtc refused no-leader with no carrier
attempt, over ws relay-rejected by the trusted server's no-leader NACK
on its one attempt. leader-outside-list (ws): the sender lists
recipient-b alone, a list that leaves the leader out, and the server
NACKs it no-leader.

The conformance send helper's ack takes group-leader; the receipt
window takes its receipt mode beside its roles and ending, so every
caller names receiver or leader. The world cell's verdict reader moves
beside the send helpers, where the refusal cells share it.

The harness recipientPeer gains recipient-b: the page resolves it to the
one other live session of another principal that is not the room's
leader, which it reads from the room snapshot through the shared
director resolver; with no leader the role names no peer and the send
fails before a handle opens. The schema, the control validator, the
capability text and the harness document follow.

Manifest 22 withholds the three cells, so manifests 18 and 22 stay
byte-identical.

D8 reuse: toSendCommand, toAdmissionCommands, toServerReceiptCommands, the receipt window and the role identity assessment, the world cell's verdict reader (moved, not copied), the durable takeover's first-success poll, the browser director appoint, resign and status commands, the shared leader resolver, the lane-role peer resolution and its live-session filter, the hosted withheld list.
```

### Task 5: The Relic per-player private event (D168)

Composed commit: `final-patch-task-5.patch` (21 files, +911/−115), `git am`-able on Task 4's commit. Line anchors are on
`c0ae57d71`, equal to Task 4's commit for every file below (Tasks 1–4 touch none). It needs nothing from Tasks 1–4
(`newALPrincipalBroadcastMessage` is A1's).

**Where the hook knows the principal.** `useRelicHunters` owns `session` (`useRelicHunters.ts:59`, the `AuthSession`); its `clientId`
is the principal the server stamps on presence sessions (A1 Task 5's cite, `group-mutation-authority.ts:334`). A1's
`localPrincipalId` is an input of `useRelicPlanningAi` that App fills from `game.session?.clientId`; this hook reads
`session?.clientId` itself. Relic's `playerId` is the session id (`rules.ts:188-194`), so a hunter's other session is another player.

**Files**

- Create `apps/relic-hunter-server-v1/src/to-relic-hunter-event-message.ts`, `apps/relic-hunters-v1/src/game/subscribe-relic-hunter-events.ts`,
  `apps/relic-hunters-v1/tests/subscribe-relic-hunter-events.test.ts`.
- Modify `packages/relic-hunters/src/protocol.ts:6-18`, `packages/relic-hunters/src/model.ts` (type before the `toRelicRoundTrackKey`
  doc, guard before `isRelicGamePhase`, `:462`), `apps/relic-hunter-server-v1/src/apply-relic-ws-command.ts` (whole, 88 lines),
  `relic-game-service.ts:1-38,43,93-169,197-198,237`, `main.ts:70-71,153`, `relic-rest-auth.ts:5,7,9,14,78`, `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts:29,159,288,442`,
  `useRelicHunters.ts:1-8,36,70,300,557,816,840`, `App.tsx:4-12,205,961-966,2921-2981`, `styles.css:951-953`,
  `apps/relic-hunters-v1/docs/runtime-data-flow.md:69-71`, `docs/ui-gameplay.md:76-77`.
- Modify tests `apps/relic-hunter-server-v1/test/{relic-server-service,relic-server-browser-contract,relic-game-state-storage}.test.ts`,
  `apps/relic-hunters-v1/tests/relic-hunters-runtime.test.ts`, `packages/tests/relic-hunters/{relic-web-app.browser,use-relic-hunters-auth-lifecycle}.test.ts`.

**Interfaces**

- `RELIC_TOPICS.hunter = 'room.relic.hunter'`, `RELIC_TYPES.hunter = 'relic.hunter.v1'`. `RelicHunterEvent` exactly as the frame names it
  (`action: RelicActionInput`, `command: RelicCommand['kind']`); `isRelicHunterEvent` checks version, `gameId`, `principalId`, then per
  kind `round` + an action whose `kind` is a `RelicActionKind` (as `isRelicCommand` reads an action — a stricter target check takes
  `model.ts` to cognitive load 51 and fails the changed-style gate), or a command kind of the seven and a string `text`.
- Server builder file: `toRelicActionRecordedEvent(previous, command, principalId)` (only `submit-action`; `round: previous.round`,
  `action: command.action`), `toRelicCommandRefusedEvent(command, principalId, error)` (`text: error.message`),
  `toRelicHunterEventMessage(roomId, event, serverPeerId)` = `newALPrincipalBroadcastMessage(serverPeerId, newALRoute(RELIC_TOPICS.hunter, roomId,` ${event.gameId}:${event.principalId}`), { groupRef, principalRef: { applicationId, workspaceId, principalId } }, RELIC_TYPES.hunter, event,
  { reliability: 'at-least-once', ack: 'receiver', ttlMs: RELIC_SNAPSHOT_TTL_MS })`. The options carry no `groupRef`: the principal
  builder's options type refuses it (TS2353); the target carries it.
- `apply-relic-ws-command.ts`: `RelicSessionIdentity = Pick<AuthSession, 'clientId' | 'username'>`, `RelicCommandSender =
  Pick<AuthSession, 'clientId' | 'sessionId'>`, the one sender type: `relic-rest-auth.ts` deletes `RelicRestAuthSession` (`:9`, the
  same shape), imports `type RelicCommandSender` from `./apply-relic-ws-command.ts` for `session` (`:14`) and `actorFromSession`
  (`:78`), and drops its now-unused `AuthSession` import (`:5`) (R-A2a-21, R-A2a-24); `RelicCommandApplication` = `{ kind: 'applied'; snapshot; publishFailure }` |
  `{ kind: 'refused'; error; publishFailure }`; input `readSession` replaces `readSessionUsername`; `applyCommand(command, sender)`;
  outcome arm `{ kind: 'refused'; error; publishFailure }` (warning only when the refusal was not published:
  `` `${subject} was refused, but its refusal was not published.` ``). `not-applied` stays for storage/initializer failures.
- Service: option `readSession` (main: `readSession: (sessionId) => rallar.runtime.authSessionRepository.findBySessionId(sessionId)`);
  `applyCommand(command, sender: RelicCommandSender)` (REST passes its `session`; refused → `throw application.error`);
  `applyAndPublishCommand` runs the rules with `Try.compute(() => applyRelicCommand(previous, command, { senderId: sender.sessionId }).state)`:
  Left → publish the refusal event, write nothing; Right → `writeAndPublishCommand({ previous, next, command, principalId })`
  (namespace `RelicGameService.AppliedCommand`); `publishCommandResult` publishes snapshot → hunter `action-recorded` → round transition;
  a module `toPublishFailure(publish)` replaces the inline try/catch.
- Browser: `subscribeRelicHunterEvents(facade, roomId, { principalId, onEvent })` — `messages.room<RelicHunterEvent>({ topicId, typeId, roomRef,
  purpose: 'notification' })` (no recovery: no ordering), `onWs` filtered by `isRelicHunterEvent`, `gameId === roomId`, and
  `readALPrincipalBroadcastTarget(raw)?.principalId === principalId` in the room's `groupRef`. Runtime dep `onHunterEventMessage` +
  `subscribeHunterEvents(roomId, subscription)`. Hook: `lastHunterEvent?: RelicHunterEvent` (doc "What the server last told the
  signed-in hunter alone; a refusal's text is also the command error."), `acceptHunterEvent` sets it and, for `command-refused`,
  `setError(event.text)`; effect subscribes when `roomId`, `session?.clientId` and `middlewareConnected`.
- App: the error panel (`:1213`) is the refusal's one owner, unchanged. The round plan panel after `TurnPlanStatusCard` renders
  `<p className="hunter-recorded-action" aria-live="polite"><span className="panel-label">Recorded on another device</span><strong>{label}</strong></p>`
  when `lockedAction === undefined` and `toRecordedHunterAction(game.lastHunterEvent, game.snapshot)` (same `gameId` and `round`) gives an
  action; `LockedPlanCard`'s inline `actionLabel` becomes the module `toRelicActionLabel(action, snapshot)` both use.

**D8 reuse inspection.** `newALPrincipalBroadcastMessage`, `RELIC_SNAPSHOT_TTL_MS`, the round transition's builder/channel/effect shapes,
`Try.compute`, `readALPrincipalBroadcastTarget`, the hook's error state and panel, the locked-plan label (moved). No new store.

- [ ] **Step 1: Tests (red).** Copy the test edits and new test files. `npx vitest run packages/tests/relic-hunters apps/relic-hunters-v1/tests`
      → `Test Files  4 failed | 30 passed (34)`, `Tests  5 failed | 205 passed (210)`; `cd apps/relic-hunter-server-v1 && deno test --allow-env --allow-read --no-check`
      → `3 passed (18 steps) | 3 failed (13 steps)` (`deno task check` fails on `readSession`/`ALICE` until Step 2).
- [ ] **Step 2: Implement.** Same commands → `Test Files  34 passed (34)`, `Tests  213 passed (213)`; Deno `6 passed (33 steps) | 0 failed`.
      The browser cases deliver a planning snapshot with `roundStartedAtEpochMs: Date.now()`: the fixture's start time 4 makes the page
      auto-submit on its expired timer, which sets `lockedAction` and hides the line.
- [ ] **Step 3: Checks.** `npx dprint fmt <the 21 files>`; `cd apps/relic-hunter-server-v1 && deno task check && deno lint` → clean, then
      `rm -rf node_modules/.deno`; `cd apps/relic-hunters-v1 && npm run typecheck` → clean; `npx tsc -p packages/relic-hunters/tsconfig.json --noEmit`
      → clean; `node scripts/check-tests-typecheck.mjs` → PASS; `npx vitest run packages/tests/relic-hunters apps/relic-hunters-v1/tests packages/tests/shared-web/shared-web-app-import-boundaries.test.ts`
      → `35 passed`, `216 passed`. After the commit: `npm run check:repo-style:changed -- c0ae57d71 HEAD` → PASS;
      `node scripts/check-test-structure-coupling.mjs --changed c0ae57d71 HEAD` → three PASS lines; `npm run check:test-reachability` → `1772 test files, 1766 reached by CI, 6 manual` (one file more).
- [ ] **Step 4: Commit.**

```text
Tell the acting Relic hunter what became of its command

A WS command is acknowledged at admission, so a hunter never saw the
rule that refused one, and a plan submitted on one device reached the
hunter's other sessions only as a locked count. The server now
publishes relic.hunter.v1 on room.relic.hunter to the acting hunter's
principal in the room: a principal broadcast with the room's groupRef,
receipted, through the outbox, as long-lived as a snapshot. After a
submitted plan it carries the action recorded for the round
(action-recorded), published after the snapshot and before the round
transition; after a command a rule refused it carries the rule's text
(command-refused) and nothing is written.

The rules run apart from storage, so only a rule's refusal becomes a
hunter event: the command application is applied or refused, a REST
command still fails with the rule's own error, and a WS command whose
refusal was published ends quietly while one whose refusal could not
be published warns. A storage or session failure stays a logged value.
The session reader returns the session's username and client id, and
the service takes the sending session and its principal, under the one
sender type the REST authorizer also reads.

The browser subscribes a typed room notification channel on the hunter
topic, filtered to the room's game and the signed-in hunter's
principal; the hook keeps the last hunter event and makes a refusal's
text the command error, which the error panel shows. The round plan
panel shows an action recorded on another of the hunter's sessions for
this round until this device submits its own; the locked-plan card and
the new line share one action label. The runtime and gameplay documents
say what the hunter hears and where it shows.

D8 reuse: newALPrincipalBroadcastMessage and the snapshot's TTL, the round transition's builder and channel shape, Try.compute for the rules, the shared principal target reader, the hook's error state and panel, the locked-plan card's action label (moved into a shared function).
```

### Task 6: Docs — the leader ACK and the hunter's private event (D164–D170)

Composed commit: `final-patch-task-6.patch` (6 files, +182/−38, docs only), `git am`-able on Task 5's commit. It is the
exact text: the prototype's, with the ruled amendments listed below (R-A2a-25). Tasks 1–5 touch none of these six files, so
the line anchors at `c0ae57d71` hold at Task 5's commit. Then run the "True of the code" checks, which are the only part
that can fail. A mismatch is fixed in the doc, never in the code. No plan/task/ruling ids go
into the docs; decision ids do.

**Files (text anchors; line numbers are at `c0ae57d71`, equal to Task 5's commit for these files)**

- Modify `docs/rallar-api-reference.md`:
  - `### Director`, after "intent/output/snapshot relay around that appointment." (`:501`): a new paragraph — the
    relay's `sendIntent(...)`/`requestSync(...)` send on the room channel with `ack: 'group-leader'` over
    `rtc-with-ws-fallback`, no session named; the receipt is the director's ACK, `sent` within 30 s; a `no-leader`
    refusal returns `status: 'no-director'`; the client-side `no-director`/`stale-director`/`not-director` checks
    before the send; the director's outputs: `all-logical-recipients` when stated, best effort otherwise (D167).
  - `### Message Audiences` table, the room row's Receipts cell (`:849`) gains "; `group-leader` from the room's
    director (see Acknowledgement Modes)" (dprint re-pads the 7 table lines; nothing else in it changes).
  - The narrowing paragraph's last sentence (`:884-885`) gains "and its server publishes each hunter's recorded action
    and refused-command text to that hunter's principal in the room (D168)."
  - New `### Acknowledgement Modes` before `### Ordering, Repair And Resynchronization` (`:944`): an intro (a
    confirmation is the ALM ACK at admission, not application handling); the table (Mode / Who confirms / Audiences /
    Default for; rows `none`, `receiver`, `all-logical-recipients`, `group-leader`); the `group-leader` paragraph
    (appointed director present at admission, resolved by the admitting carrier from its snapshot, frozen alone, fenced
    as a room send, only the director delivers, its ACK confirms, `receiptAlgo` reads `leader`, RTC relay through
    non-recipients, succession, and "an RTC leg the fallback hands to WS after a succession is refused `no-leader` by the
    server, since the session it froze is no longer the director" (R-A2a-12), no epoch on the wire, heartbeat freshness is
    the application's; D164, D170); the `no-leader` paragraph (no appointment / appointed session absent / sender is the
    director / "the director is outside the audience the send names after its exclusions: a fixed list, or a principal
    other than the director's, that leaves the director's session out, or `exceptPeerIds` that name it" (R-A2a-2); RTC
    at admission before any attempt; WS at ingress with a `no-leader` NACK after the frame left; "The handle ends
    `rejected`: on RTC with `failure: { kind: 'refused', reason: 'no-leader' }`, on WS with `failure: { kind:
    'relay-rejected', rejection }` and `evidence.relayRejection` reading `{ relay: 'trusted-server', reason: 'no-leader' }`."
    (R-A2a-14); no fallback trigger; D165); the unsupported
    paragraph (unicast, `world`, `all` → `unsupported`; the browser validator refuses `peerId` or `scope: 'world'`;
    D166); a `ts` example (`messages.room<MoveIntent>` `send(..., { ack: 'group-leader' })`, then `const noLeader =
    (failure?.kind === 'refused' && failure.reason === 'no-leader') || (failure?.kind === 'relay-rejected' &&
    failure.rejection.reason === 'no-leader');` over `outcome.lifecycle.evidence.failure`).
- Modify `packages/shared/alm/inbound/README.md`: "two receipt rules. A `receiver` room message" (`:208`) → "A
  `receiver` or `leader` room message"; after "keeps the `exceptPeerIds` rule alone." (`:475-476`) the leader sentence
  (director alone, frozen at the RTC origin and admitted by the WS server, its ordinary ACK the one the `leader`
  receipt expects, RTC carriers forward and end with `subtree-complete`; D164).
- Modify `packages/shared/alm/outbound/README.md`: `:22` (`receiver` or `leader` room send has no client-tracked hop);
  `:407-409` (`leader` beside `receiver` in the row's peer lists and the ACK it confirms); `:416` (`complete` under
  `leader`); `:481-483` (`{ kind: 'leader', sessionId }` in `computeFrozenAudience`'s narrowing list); a new bullet
  before `- **The RTC room limit` (`:490`) — the narrowing derived from `delivery.ack`, `resolveRallarGroupLeaderSessionId`
  in `group-director.ts`, the RTC refusal `refused/no-leader` (none / origin is the director / "outside the audience the send names after its
  exclusions (a fixed list or a principal without it, or `exceptPeerIds` naming it)"), frozen
  `[director]` with a `leader` row, the carrier-gap hold, succession, no fallback trigger; `:499-500` (the WS server's
  narrowed `sessions` is the leader alone); `:517-519` (a `leader` send is the receiver aggregate with one expected
  recipient); after "is `membership-fenced` instead." (`:594`) the `no-leader` ingress NACK sentence (no director present, the
  sender is the director, "the send's exclusions, fixed list or principal leave the director out"; "the origin states it as
  a trusted-server `relay-rejected` with that reason and the handle reads `rejected`"); `:704`, `:926`
  (`receiver` and `leader`); `:964-965` (`refused/no-leader` hands nothing over).
- Modify `playground/alm/alm-complete-product-description.md`: `:313-314` (the server-originated principal publication
  was carried to A2a, Relic's hunter event is the first, D168; the deployment-wide principal audience stays
  state-sync, D163); `:459-460` (the relay addresses a command by role with `ack: 'group-leader'`, D167);
  `:521-524` the `**PLANNED — A2a, distinct leader ACK:**` paragraph → `**CURRENT — A2a, the leader ACK:**`
  (D164–D167, D169, D170), whose refusal sentence names both kinds: "a typed refusal that ends the handle `rejected` (on
  RTC `refused` before any attempt, on WS a trusted-server `relay-rejected` after the frame left)"; `:990` "Per-player private events from the server are carried (D163)." →
  `**CURRENT — A2a, the hunter's private event:**` (D168). The ACK-modes list (`:471-472`) and the A2b ownership
  paragraph stay. There is no separate AR Eye consumer paragraph in this document; its consumer text is the relay
  sentence and the CURRENT paragraph.
- Modify `playground/alm/alm-improvement-plan.md`, the row starting `| 6 A1, A2 |` (`:1288`), Relic column only:
  "per-player private events (A2)." → "the hunter's recorded action and rule-refusal text to the hunter's own sessions
  (A2a)." The AR Eye column already reads as the design's section 4 asks. The new text fits its column: no other row
  re-pads; no status prose; match by prefix; never a blank line inside the table.
- Modify `playground/alm/alm-static-audit.md` F16 (`:417-418`): "still maps a leader ACK request to subtree behavior"
  → past tense plus the since-A2a clause (`leader` algorithm, director resolved and frozen, `no-leader`; D164–D166).
  The summary table's F16 status row is the close's, not this task's.
- Not modified: `apps/relic-hunters-v1/docs/runtime-data-flow.md` and `ui-gameplay.md`: Task 5 owns the Relic app docs
  and its wording stands (R-A2a-23); the prototype's hunk is dropped.
- `docs/rallar-ai-recipes.md` names no ack mode: unchanged.

**True of the code (check each against the landed Tasks 1–5 before committing)**

- Task 1: `git grep -n "'leader'" packages/shared/al-contracts/al-policy.ts packages/shared/al-contracts/al-carrier-capabilities.ts packages/shared/al-contracts/normalize-al-qos-policy.ts`
  shows `ALAckAlgo`/`ALReceiptMode` with `leader`, all three carriers declaring it (`DEFAULT_AL_QOS_CAPABILITIES` does not, R-A2a-4),
  and `toAckAlgo` mapping `group-leader` → `leader`; `ALAudienceNarrowing` in `al-audience-narrowing.ts` has the arm
  `{ kind: 'leader'; sessionId: string }` (the frame's "`RtcAudienceNarrowing`" is this type); `computeFrozenAudience`
  takes it; `resolveRallarGroupLeaderSessionId` is exported from `packages/shared/api/group-director.ts` and uses
  `isRallarGroupDirectorSessionActive`; `no-leader` is in `ALDeliveryRefusalReason` and `ALNackReason`;
  `AL_DELIVERY_FALLBACK_REFUSAL_REASONS` is still `['unsupported']`; `validateALAckSupport` refuses `leader` on a
  unicast, `world` and `all` and admits room multicast/broadcast, principal with its room and a listed broadcast; the
  RTC origin refuses `no-leader` for no director, self, and an audience that leaves the director out (a list, a
  principal, `exceptPeerIds`), freezes `[director]`, writes a
  `leader` row; a durable send held for a carrier gap resolves the director when it freezes. The handle's
  `receiptAlgo` reads `leader` for an admitted `group-leader` send (`resolveALDeliveryReceiptAlgo`).
- Task 2: the room authorizer narrows `sessions` to the leader alone; ingress NACKs `no-leader` for none / sender is
  the director / a list, principal or exclusions without the director, which the WS origin reads as a trusted-server
  `relay-rejected`; the aggregate counts a `leader` send with one expected recipient and the
  server withholds its own ACK for it; `toWsQueueBoxClientAckTrackingPlan` treats `leader` as `receiver` (expects nobody
  until the `admitted` receipt) and `computeALOutboundReceiptAdmission` accepts a `leader` row.
- Task 3: the validator refuses `group-leader` with `peerId` and with `scope: 'world'`; the relay's `sendCommand` sends
  with `{ ack: 'group-leader', strategy: 'rtc-with-ws-fallback' }` and no `peerId`, maps a `no-leader` rejection to
  `status: 'no-director'`, keeps `readCommandRejection` before the send and `sendRoomEnvelope` unchanged. The `ts`
  example typechecks against `RallarTypedMessageSendOptions` and `ALDeliveryFailure`.
- Task 4: the `leader-ack` cells and carriers are `leader-confirms` (ws, rtc, rtc-with-ws-fallback),
  `no-leader-refused` (ws, rtc), `leader-outside-list` (ws); manifests 18/22 unchanged. A ruled change fixes the
  CURRENT paragraph's lane sentence.
- Task 5: `RELIC_TOPICS.hunter = 'room.relic.hunter'`, `RELIC_TYPES.hunter = 'relic.hunter.v1'`; the builder uses
  `newALPrincipalBroadcastMessage` with the room's `groupRef`, `ack: 'receiver'`, the 15 s TTL, `fanout: 'outbox'`;
  `action-recorded` carries `round` and `action`, `command-refused` carries `command` and `text`; `App.tsx` shows them
  as stated; both the REST and the WS command path publish (R-A2a-19).
- Applied rulings (R-A2a-25): the WS `no-leader` is a trusted-server `relay-rejected` (R-A2a-1, R-A2a-14), so the API
  reference, its example, the outbound README and the product description name the kind per carrier; the refusal names
  a list, a principal and `exceptPeerIds` (R-A2a-2); the succession sentence names the hand-over refusal (R-A2a-12).

- [ ] **Step 1: Apply** `final-patch-task-6.patch` (or write the text listed above). **Step 2: True-of-code checks** above.
- [ ] **Step 3: Format** `printf '%s\n' docs/rallar-api-reference.md packages/shared/alm/inbound/README.md packages/shared/alm/outbound/README.md playground/alm/alm-complete-product-description.md playground/alm/alm-improvement-plan.md playground/alm/alm-static-audit.md | xargs npx dprint fmt`
      (explicit files only), then the same list through `xargs npx dprint check` → exit 0.
- [ ] **Step 4: Checks.** `npx vitest run packages/tests/repo packages/tests/shared-web/rallar-group-public-contracts.test.ts`
      → `Test Files  92 passed (92)`, `Tests  1230 passed (1230)` on the composed tree (Tasks 1–5 add no repo test;
      `rallar-group-documentation.test.ts` resolves every backticked file citation, including the new
      `group-director.ts` link); `cd apps/api-v1 && deno test --allow-all test/swagger-routes.test.ts` →
      `14 passed | 0 failed`, then `rm -rf apps/api-v1/node_modules/.deno`; after the commit
      `npm run check:repo-style:changed -- c0ae57d71 HEAD` (PASS: no new findings) and
      `node scripts/check-test-structure-coupling.mjs --changed c0ae57d71 HEAD` (three PASS lines).
- [ ] **Step 5: Commit** (the composed commit's message):

```text
Document the leader ACK and the hunter's private event

The API reference gains an Acknowledgement Modes section: who confirms
each mode, the audiences it supports and the purpose it is the default
for; what group-leader addresses (the room's appointed director session
present at admission, resolved from the snapshot by the admitting
carrier and frozen as the one expected recipient); the no-leader refusal
on both carriers (no director, the sender is the director, a list, a
principal or exclusions that leave the director out), refused over RTC
and a trusted-server relay rejection over WS, no fallback trigger; and
the unsupported shapes. The director paragraph states the relay's
role-addressed intents and sync requests and the no-director mapping,
the audiences table and the Relic sentence follow. The inbound README
states the leader audience and the server's withheld ACK, the outbound
README the leader narrowing in the frozen audience, the leader receipt
row beside receiver, the WS server's leader aggregate with one expected
recipient and its no-leader NACK, and no-leader as no fallback trigger.
The product description's leader-ACK paragraph becomes current, the
relay sentence names the role address, and the Relic paragraph records
the hunter's private event; the roadmap's consumer row and the audit's
F16 leader clause follow.

D8 reuse: the existing acknowledgement, frozen-audience, server-receipt, director and consumer prose of each document, extended in place; one new section heading beside Message Audiences.
```

### Task 7: Close

Pins unchanged and bundles measured; the static merge bar; `npm run test:postgres:integration` (the WS server's
receipt aggregation, inbound plan and outbound planning changed); the conformance lane for the `leader-ack` scenarios
over `ws`, `rtc` and `rtc-with-ws-fallback`; the three-seat final review BEFORE one fix wave; push; the Branch Release
Gate green on the code head; hosted manifests 18 and 22 dispatched from the branch; the PR body; the close commit with
the delivered lines; this plan file deleted.

- [ ] **Step 1: Pins and bundles.** `npx vitest run` the four pins (`al-indexeddb-transaction-ledger`,
      `al-indexeddb-operation-counts`, `al-storage-snapshot`, `al-indexeddb-empty-audience-counts` under
      `packages/tests/shared/alm/`) → `Tests  27 passed (27)`, no pin file in `git diff --stat origin/main HEAD`.
      Bundles with a private `TMPDIR`: `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
      (`browser/rallar.ts` 241.246 KiB of 242 at composition) and `headless-bundle-boundary.test.ts` (306.701 KiB of 307
      at composition); a crossed budget rises to the next whole KiB, named in the PR body.
- [ ] **Step 2: Static merge bar.** `npm run typecheck`; `npm run build`; `npm run check:repo-style:changed --
      origin/main HEAD` (read the verdict line) and `node scripts/check-test-structure-coupling.mjs --changed
      origin/main HEAD`; `npm run check:test-reachability` (`1772 test files, 1766 reached by CI, 6 manual` at
      composition); `git diff --name-only origin/main HEAD | xargs npx dprint check`; `node --import tsx
      apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check` → `checked 67 Hetzner distributed
      manifest(s)` and `git diff --stat origin/main HEAD -- apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json
      apps/rallar-black-box/manifests/hetzner/22-alm-conformance-3-agent.json` empty; `cd apps/api-v1 && deno task check
      && deno test --allow-all test/` then `rm -rf apps/api-v1/node_modules/.deno`; `cd apps/relic-hunter-server-v1 &&
      deno task check && deno lint && deno test --allow-env --allow-read` then `rm -rf node_modules/.deno`.
- [ ] **Step 3: Postgres integration.** With the test Postgres up (`docker ps` first; `npm run db:test:up` only from
      this worktree), run `npm run test:postgres:integration` unsandboxed; name every red from its output.
- [ ] **Step 4: The conformance lane, unsandboxed on private ports.** `lsof -i :18480 -i :5480 -i :5481` first, so no
      other session's server is reused; then `VITE_RALLAR_API_BASE_URL=http://localhost:18480
      VITE_RALLAR_SPA_BASE_URL=http://localhost:5480 RALLAR_BLACK_BOX_CONTROL_BASE_URL=http://127.0.0.1:5481
      RALLAR_BLACK_BOX_ALM_SCOPE=full npm run test:rallar:full-stack:memory:alm -- -g "three-agent family"` (all three
      carriers; `RALLAR_BLACK_BOX_ALM_CARRIERS=ws|rtc|rtc-with-ws-fallback` runs one). Expected: `three-agent family over
      ws (full)`, `… over rtc (full)` and `… over rtc-with-ws-fallback (full)` pass, with `leader-confirms` on all three,
      `no-leader-refused` on `ws` and `rtc` (rtc `refused`/`no-leader`, 0 attempts; ws `relay-rejected`/`trusted-server`/
      `no-leader`, 1 attempt) and `leader-outside-list` on `ws`, beside the receipted-audience and fence cells. Diagnose
      a red cell from its artifact; the cells' sequencing is R-A2a-17's.
- [ ] **Step 5: Final review, then one fix wave.** Three seats (product: the leader meaning, `no-leader` per carrier,
      the AR Eye relay and the Relic hunter event against D164–D170; harness: the `leader-ack` family, `recipient-b`, the
      receipt window's mode, the withheld cells and the manifests; code quality: the code standard, D3, D8, one shared
      leader rule, `isALLogicalReceiptMode` at every logical-receipt site, one name per type) review the branch head
      before any fix; the controller rules on every finding and applies one fix wave; any fix reruns its task's checks
      and Steps 1–2.
- [ ] **Step 6: Push and gates.** Push the branch; the Branch Release Gate (`gh run list --branch <branch>`) and the
      API-v1 black-box gates (including `test:api-v1:black-box:postgres:medium-scale`) green on the code head; rerun a
      known flake once with `--failed` before diagnosing it.
- [ ] **Step 7: Hosted manifests 18 and 22 from the branch.** `gh workflow run hetzner-distributed-recipe.yml --ref
      <branch> -f ref=<branch> -f rollout_before_run=true -f
      manifest_path=apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json`, and the same with
      `22-alm-conformance-3-agent.json`; both are regression reads (the `leader-ack` cells are withheld); diagnose a red
      from its artifacts.
- [ ] **Step 8: PR body.** Goal; Changes per task; Public surface (`ALAckAlgo`/`ALReceiptMode` `leader`,
      `ALAudienceNarrowing` `leader`, `toALLeaderNarrowing`, `resolveRallarGroupLeaderSessionId`,
      `isALLogicalReceiptMode`, `no-leader` in `ALNackReason`, `ALDeliveryRefusalReason`, `ALOutboundDropReasonCode` and
      the trusted-server `ALDeliveryRelayRejection`, `computeRtcLeaderRefusal`, `AuthorizedRoomAudienceMessage`, the
      validator code `leader-requires-room-audience`, the relay's role address, `recipientPeer: 'recipient-b'`,
      `RELIC_TOPICS.hunter`/`RELIC_TYPES.hunter`/`RelicHunterEvent`; the budget `browser/rallar.ts` 241 → 242);
      Acceptance; Validation with every red named; Rulings R-A2a-1 to R-A2a-28 and any the review adds; Corrections (this
      plan's list); Limits (this plan's list); Risk and rollback; Follow-ups (A2b exclusive ownership; the server-originated
      conformance cell; the two silent paths of R-A2a-13; a typed refusal for a generic authorizer's leader send,
      R-A2a-15). End the body with the Claude Code attribution line.
- [ ] **Step 9: The close commit.** In `playground/alm/alm-improvement-plan.md`: the consumer row `| 6 A1, A2 |` gains
      "Delivered (A2a, `<head>`; #<pr>)." in both its AR Eye column (after "(A2a)") and its Relic column (after "(A2a).");
      the "Releases 4 to 8" map row `| 6 A2    |` gains "Delivered (A2a, `<head>`; #<pr>)." after the A2a sentence of its
      outcome column; the fresh-session paragraph records A2a as delivered (#<pr> as `<head>`, from
      `alm-a2a-design-proposal.md`, D164–D170; its plan file deleted with the close) and names A2b (exclusive ownership)
      as the next slice; the revision history gains an entry "<merge date> (A2a delivered): #<pr> as `<head>`; the
      release map row, the consumer row, the F16 and PC7 rows and the fresh-session paragraph record it; A2b is next.";
      the requirement matrix's `| PC7 supported target and ACK semantics |` row reads "Delivered: audiences with carrier
      parity (A1) and the group-leader mode (A2a, #<pr>)." with its owner column `A1, A2a`. In
      `playground/alm/alm-static-audit.md` the status table's `| F16 |` line records the leader ACK as delivered (A2a)
      beside fencing (R2) and audiences (A1), leaving correlation and ownership open (`I1`, `A2b`). Delete this plan file
      in the same commit. Never a blank line inside a table; `npx dprint fmt` the two files.
