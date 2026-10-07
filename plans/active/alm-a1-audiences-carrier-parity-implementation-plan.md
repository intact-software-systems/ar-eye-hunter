# ALM A1: audiences with carrier parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven development with test-driven development:
> one implementer per task, the failing tests first, the controller reviews and commits, one commit
> per task, a three-seat final review with one fix wave before the close. Steps use checkbox
> (`- [ ]`) syntax for tracking. The tasks run in the order 1 → 3 → 2 → 4 → 5 → 6 → 7 and appear
> below in that order.

**Goal:** Deliver Release 6, A1 (D156 to D163, `playground/alm/alm-a1-design-proposal.md`). Every
audience a client addresses has one meaning on both carriers: `room`, `principal` (the principal's
live sessions in the addressed room) and a fixed list (`recipientPeerIds` inside the addressed room)
are room audiences, frozen at the RTC origin and admitted as the narrowed room audience by the WS
server, so receipts, the roster fence and repair work as for any room send; `world` is bound to the
sender's authenticated scope on every WS path and is refused `unsupported` on RTC, so the browser
routes it to WS when the strategy allows; a client's `all` is refused. The conformance lane proves
the audiences on three carriers with a second session of the sender's principal, Relic's AI
suggestions ride a principal broadcast in the room, and the docs state the audiences.

**Architecture:** The AL contract gains the principal-broadcast builder and the listed room broadcast;
the shared planner honours a broadcast's list. The RTC origin carries the narrowing in the envelope and
converts a principal or listed room broadcast to the frozen narrowed room multicast at the plan that
first reads an authorized room (held until then, as a room multicast is). The browser sender routes by
audience; the WS server's ingress, room authorizer, target resolver, outbox, cluster bridge and live
notice bind each audience. The harness send and a `same-principal` lane family prove it per carrier.

**Tech Stack:** TypeScript on Node (Vitest, Playwright, esbuild bundle budgets) and Deno (api-v1,
`deno test`, `deno check`); dprint.

**Spec:** `playground/alm/alm-a1-design-proposal.md`; decisions D156–D163 in
`playground/alm/alm-improvement-plan.md`; survey `.superpowers/sdd/a1-survey/facts.md`.

## Global constraints

- **The maintainer's notes stand: "No legacy, avoid duplication, no migration code, keep the repo
  consistent, prefer existing patterns."** No wire or schema bump: `ALTargets` keeps its fields.
- **D3:** no compatibility window. A changed contract changes everywhere in the same task; no `?:`
  added "for now"; `'all'` leaves the browser input in the task that stops the browser sending it.
- **D8 reuse first.** Search `packages/**` for an existing pattern before writing one; delete what
  becomes unused in the same task; no raw Maps where `packages/shared/cache` repositories fit. Every
  task carries a D8 reuse inspection paragraph and its commit one `D8 reuse:` line.
- **The audience meanings (D156):** one meaning per audience: `room` is the room's live sessions at the
  sender's snapshot; `principal` is the principal's live sessions in the addressed room; a fixed list
  is the sender's session ids in the addressed room, resolved to the list ∩ the room's live sessions;
  `world` is every authenticated live connection in the sender's authenticated scope (application +
  workspace, the server's scoped-world meaning); `all` is every authenticated connection the server
  holds, a server and proxy audience, refused `unauthorized` from a client. "Own plus co-group
  sessions" is the server's state-sync fan-out, not a client audience.
- **The carrier matrix (D157):**

  | Audience   | RTC                                                             | WS                                    | Default strategy (`rtc-with-ws-fallback`) |
  | ---------- | --------------------------------------------------------------- | ------------------------------------- | ----------------------------------------- |
  | room       | multicast, frozen audience (unchanged)                          | room broadcast (unchanged)            | RTC, WS on a fallback trigger             |
  | principal  | multicast, frozen audience narrowed to the principal's sessions | `broadcast/principal` + `groupRef`    | RTC, WS on a fallback trigger             |
  | fixed list | multicast, frozen audience narrowed to the list                 | `broadcast/room` + `recipientPeerIds` | RTC, WS on a fallback trigger             |
  | world      | refused `unsupported`                                           | `broadcast/world`                     | WS directly                               |
  | all        | refused `unsupported`                                           | refused `unauthorized` (client)       | WS directly, then `rejected`              |

  "Carrier-unsupported" is the existing typed refusal `unsupported` on the carrier that cannot carry
  the audience; no new state or value (D122). A client's `all` is no browser input after Task 3.
- **Task order 1 → 3 → 2 → 4 → 5 → 6 → 7 (R-A1-6):** the browser stops emitting `all` (Task 3) before
  the server refuses it (Task 2), so no commit refuses what the browser still sends. Between Task 1
  and Task 2 the ingress compares a principal broadcast's room scope but not yet its principal scope;
  no client can build that shape before Task 3, and Task 2 follows it at once.
- **No ids in code, tests or docs:** no plan, task, PR or ruling id in code or tests; decision ids
  (D156 …) only in docs.
- **No guarantee weakens.** The four pins (`al-indexeddb-transaction-ledger`,
  `al-indexeddb-operation-counts`, `al-storage-snapshot`, `al-indexeddb-empty-audience-counts`) stay
  unedited; hosted manifests 18 and 22 stay byte-identical (the family withheld, as D148).
- **Convergent-service rules** (`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`)
  bind the WS ingress and the outbound admission.
- **Code standard** (`.agents/skills/rallar-code-writing/references/repo-code-style.md`): canonical
  verbs; functions ≤40 lines; ≤3 positional parameters for a new function (the AL builder family's
  positional style is the named exception for `newALPrincipalBroadcastMessage`); `interface` for object
  contracts; required fields by default; `Either` for expected failure; kebab-case filenames after the
  primary export; no role folders; no narration comments; one canonical name per type. Tests live under
  `packages/tests/**` mirroring the source; Deno app tests under `apps/<app>/test/`.
- **Formatting:** `npx dprint fmt <explicit file list>` on touched files only (pipe a list through
  `xargs`; zsh does not split `$(...)`).
- **Per-task checks:** the focused Vitest files; `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json
  --noEmit`; `deno check` from the repo root on every changed `packages/shared/**` and
  `packages/shared-server/**` file; `cd apps/api-v1 && deno task check` then
  `rm -rf apps/api-v1/node_modules/.deno`; `cd apps/relic-hunters-v1 && npm run typecheck` for the
  Relic task; `node scripts/check-tests-typecheck.mjs`; the four pins; the bundle checks with a private
  `TMPDIR` (`mktemp -d /tmp/claude-501/b.XXXX`) after any `packages/shared`, `shared-web` or
  `shared-test` change (`npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` and
  `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`; budgets after Task 1:
  `browser/rallar.ts` 241, headless 306; a crossed budget rises to the next whole KiB with the measured
  figure in the commit message); for a public shared-web change `shared-web-public-api-snapshots.test.ts`
  and `shared-web-browser-bundle-boundaries.test.ts`; after the commit
  `npm run check:repo-style:changed -- eef7fd9b1 HEAD` (read the verdict line: the script exits 0 on
  FAIL), `node scripts/check-test-structure-coupling.mjs --changed eef7fd9b1 HEAD` and, when a test
  file is added or deleted, `npm run check:test-reachability`.
- **Sandbox notes.** Loopback binds fail (`listen EPERM`): name those suites as sandbox reds
  (`live-rtc-control-client`, `api-v1-rtc-rtt-recipe-semantics`, `api-v1-state-write-convergence-recipe`,
  `local-websocket-session`, `headless-worker-script`); pglite 5 s load timeouts pass alone; `npx tsx`
  fails on its IPC pipe (use `node --import tsx`); `git fetch`, `gh` and the Playwright lane need the
  sandbox off. Do not run `npm run test:unit` per task.
- **Git.** One commit per task with one `D8 reuse:` line and no attribution lines; the controller
  commits and pushes after review; never `git stash`; the PR body is written at the close.

## File structure

| Area                  | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts and RTC (1) | `packages/shared/al-contracts/{al-contract,validate-al-ack-support,al-policy,resolve-al-owned-child-peer-ids,al-frozen-multicast-audience}.ts`; `packages/shared/multicast/{rtc-room-snapshot-admission,web-rtc-overlay-frozen-audience,compute-rtc-outbound-carrier-availability,web-rtc-overlay-multicast-manager}.ts`; `packages/shared/alm/outbound/{admission/al-outbound-admission-reads,al-outbound-dispatch-admission,al-outbound-canonical-message,al-outbound-canonical-storage}.ts`; `packages/shared/services/ws-queue-box-server/ws-queue-box-server-inbound-plan.ts`; the two bundle budgets; tests `al-audience-targets.test.ts` (new), `validate-al-ack-support.test.ts`, `web-rtc-overlay-frozen-audience.test.ts`, `rtc-outbound-overlay-readiness.test.ts`, `browser-message-fallback-identity.test.ts`, `rallar-server-ws-default-fanout.test.ts` (22 files)                                                                                                                                                        |
| Browser (3)           | `packages/shared-web/browser/messages/{rallar-message-contracts,browser-message-input-validator,browser-rallar-message-sender}.ts`, `composition/browser-communication-composition.ts`, `rallar-ai.ts`, `ai/browser-rallar-ai-result-delivery.ts`, `calls/browser-call-signal-runtime.ts`, `crdt/browser-crdt-transport.ts`; the harness's `'all'` sites in `packages/shared-test/**`; `apps/rallar-black-box/src/direct-rallar-operations.ts` and the legacy WS console under `apps/rallar-black-box/src/legacy/diagnostics/websocket/`; `docs/test-structure-coupling-exceptions.md`; tests `browser-message-audiences.test.ts` (new), `crdt/browser-crdt-transport-scopes.test.ts` (new) and the shared-web and rallar-black-box tests that named `'all'` (38 files)                                                                                                                                                                                                                                                                 |
| WS server (2)         | `packages/shared/services/ws-queue-box-server/scope/{to-ws-queue-box-server-scope-authorization,resolve-ws-queue-box-server-recipient-scope}.ts`, `ws-queue-box-server-{target-resolution,recipient-selection,live-delivery}.ts`; `packages/shared-server/rallar-system/websocket/{ws-topic-room-authorizer,targets/create-ws-server-target-resolver,targets/resolve-ws-group-target}.ts`, `websocket/router/{rallar-server-ws-router,rallar-server-ws-router-contracts,publish-rallar-server-ws-message,publish-rallar-server-live-ws-notice,validate-rallar-server-ws-publish-scope}.ts`, `queue-pubsub/{live-ws-notice,live-ws-audience,decode-live-ws-notice-shape,live-ws-notice-subscriber,queue-box-pub-sub-bridge}.ts`; `packages/shared-server/rallar-ai/{rallar-server-ai-result-publication,install-rallar-server-ai-websocket-topic}.ts`; `apps/api-v1/src/services/filter-eligible-live-ws-session-ids.ts`; tests under `packages/tests/shared/services/`, `packages/tests/shared-server/`, `apps/api-v1/test/` (35 files) |
| Lane and harness (4)  | `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/audiences/{principal-delivery,fixed-list-delivery,world-routing}.ts` (new); the harness send contract, schema, validator, capability, decoder, ledger and peer resolver; the lane roles, scenario definition, recipes, message, session and receipt commands, step identities, `receipted-audience.ts`; `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`; `tests/playwright/rallar-black-box/{full-stack-three-agent-run.ts,full-stack-alm-conformance.spec.ts}`; `scripts/repo-style-check/reviewed-dispositions.mjs`; tests `alm-conformance-audiences.test.ts` (new) and the recipe, command, runtime and manifest tests (34 files)                                                                                                                                                                                                                                                                                                                |
| Relic (5)             | `apps/relic-hunters-v1/src/game/ai/useRelicPlanningAi.ts`, `src/App.tsx`, `src/styles.css`, `docs/ui-gameplay.md`, `docs/runtime-data-flow.md`; `packages/tests/relic-hunters/relic-web-app.browser.test.ts` (6 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Docs (6)              | `docs/rallar-api-reference.md`, `docs/rallar-ai-recipes.md`; `packages/shared/alm/inbound/README.md`, `outbound/README.md`; `playground/alm/{alm-complete-product-description,alm-improvement-plan,alm-static-audit}.md` (7 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Close (7)             | the pins, the gates, the lane run, the review, the PR body, the roadmap's delivered lines, the audit's F16 status line, the requirement matrix's PC7 row, this file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Task order

1 (contracts and RTC) → 3 (browser) → 2 (WS server) → 4 (lane) → 5 (Relic) → 6 (docs) → 7 (close).
Task 3 consumes Task 1's builders, the RTC leg conversion and the `unsupported` refusal; it stops every
browser `'all'` send (R-A1-6, R-A1-17), so Task 2's refusal of a client's `all` breaks no commit.
Task 2 consumes Task 1's `readALTargetGroupRef`, `isRoomScopedALMessage`, `validateALAckSupport` and
the WS server's router-delivered plan of a listed room broadcast (R-A1-28). Task 4 consumes Task 3's
browser inputs and Task 2's server bindings (its lane cells need Tasks 1–3). Task 5 consumes Task 3's
`broadcastJson` principal scope. Task 6 states what Tasks 1–5 built and is checked against them.

## Rulings

- **R-A1-1 (W-D D1):** the roadmap's Relic consumer cell reads "AI suggestions addressed to the asking
  hunter's sessions (A1); per-player private events (A2)." _Cost if wrong:_ a cell edit.
- **R-A1-2 (W-D D2):** a browser WS send naming neither a room nor a scope defaults to `world` (the
  sender's authenticated scope), replacing today's `'all'` default: the only client audience that fits a
  scope-less send under D156; Task 3 implements it in the sender and the docs say so. _Cost if wrong:_ a
  scope-less send reaches the sender's scope, which is the binding A1 intends.
- **R-A1-3 (W-D D3):** `principalId` without `scope: 'principal'` is a validation issue (the scope is
  explicit; a room channel's send defaults to room, so a principal send says `scope: 'principal'`);
  likewise `recipientPeerIds` with `scope: 'principal'`. _Cost if wrong:_ one explicit field per call.
- **R-A1-4 (W-D D4):** D162 is a product change: AI proposals are private to the asking hunter; the
  "Party Notes" rendering of other hunters' proposals and its test injection from another session are
  deleted in Task 5 (D3/D8: no dead UI path), and the PR body's Corrections names the removal for the
  maintainer. _Cost if wrong:_ a feature removal the maintainer may reverse (one revert of Task 5's UI
  hunk).
- **R-A1-5:** the `realtime` transport of `broadcastJson` with scope principal is not in A1 (a validation
  issue at `$.transport`; messages.ws and messages.rtc only); the docs make no realtime carrier claim.
  _Cost if wrong:_ none now.
- **R-A1-6 (W-B B1):** the browser's room-less default becomes `world` in Task 3 at all three sites
  (`sendWs`, the CRDT transport's scope type and sends, the call-signal scope beside `peerId`); task order
  1 → 3 → 2 → 4 → 5 → 6 so no commit refuses what the browser still sends; the weakened principal-scope
  comparison between Task 1 and Task 2 is recorded (no client can build the shape before Task 3; Task 2
  follows at once). _Cost if wrong:_ an ordering note.
- **R-A1-7 (W-B B2):** the double delivery of a client's non-room broadcast (the WS service's own
  forwarding plus the router) is pre-existing and stays out of A1: a documented limit and a follow-up;
  both copies are scope-bound now. _Cost if wrong:_ duplicate frames as today.
- **R-A1-8 (W-B B3):** a world publication without a scope is refused as a failed publish on every
  fanout (parity over leniency); `createRallarServerAiResultPublisher`'s world option therefore takes the
  scope (`worldScope`), and the AI topic publishes a requester's world result to the requester's
  authenticated scope. _Cost if wrong:_ the AI publisher's option shape (no consumer today).
- **R-A1-9 (W-B B4):** a principal broadcast with no room is refused `malformed` with NACK `no-route` (the
  router's no-targets twin); the browser validator refuses it first. _Cost if wrong:_ the refusal's name.
- **R-A1-10 (W-B B5):** the world binding lands at the send boundary from `source.authenticatedScope`; no
  new field on the ingress authorization result. _Cost if wrong:_ none.
- **R-A1-11 (W-B B6):** the audience narrowing lives in the room authorizer's `toAuthorizedRoomAudience`
  (one place for ingress, retained, proxy and server publications); a narrowed set may exclude the sender
  and may be empty, and an empty set means no recipients (pinned). _Cost if wrong:_ a multicast-style
  rule reading empty as unrestricted, which the pin would catch.
- **R-A1-12 (W-C C1):** no `all-refused` lane cell; the client `all` refusal is proven by Task 2's api-v1
  case (`unauthorized`), Task 1's RTC pin (`unsupported`) and Task 3's validator; the family runs three
  cells. _Cost if wrong:_ no lane witness for a shape no page can send.
- **R-A1-13 (W-C C2):** the harness names the fixed list by role (`recipientPeer: 'receiver'`), roles not
  session ids. _Cost if wrong:_ a literal-id field later if a cell lists a non-member.
- **R-A1-14 (W-C C3):** the family is withheld from hosted runs by its lane family (`same-principal`
  outside `HOSTED_ALM_LANE_FAMILIES`, as `same-context`), pinned. _Cost if wrong:_ none.
- **R-A1-15 (W-C C4):** a proposal received from the hunter's own principal (another device) renders where
  the local proposal renders, one owner, so the principal audience is visible; Task 5 adds it with a pin
  (the Party Notes block is replaced, not merely deleted). _Cost if wrong:_ about 20 lines.
- **R-A1-16 (W-C C5):** a world broadcast does not echo to its own sender (as a room broadcast's audience
  excludes its origin); Task 2 pins it at the server and the world cell asserts the sender's own channel
  never receives it. _Cost if wrong:_ one resolver line and the cell.
- **R-A1-17 (W-C C6):** Task 3 owns every `'all'` scope-union site, including the harness contracts and
  the rallar-black-box types (type-only edits there), so every commit typechecks in order 1 → 3 → 2 → 4;
  Task 4 keeps the behavioural harness changes (and `rallar-black-box-test-contracts.ts`, R-A1-20).
  _Cost if wrong:_ Task 3 touches harness files.
- **R-A1-18 (W-C C7):** a `room.` topic is room-scoped by topic (the existing contract); a world broadcast
  on a `room.` topic is refused `malformed` at WS ingress (Task 2 pins it) and the lane's world cell
  publishes on its own topic `app.alm-conformance.world`. _Cost if wrong:_ a second lane topic.
- **R-A1-19 (W-B, amending R-A1-16's premise):** a client's WS room broadcast excludes its origin session
  at delivery (the router's admitted fanout), as its receipt already does and as the RTC multicast does;
  server and proxy room publications are unchanged. The WS client already answers its own `senderId` as
  `duplicate` (`ws-queue-box-client-service.ts:450-452`), so nothing an app sees changes. _Cost if
  wrong:_ a client that relied on its own WS echo (none found).
- **R-A1-20 (revised):** the typed closure of `rallar-black-box-test-contracts.ts`'s pre-existing JSON
  `unknown`s (22 non-exempt; retyping breaks about 400 sites in about 45 files: shared-test 169 tsc errors,
  black-box app 232) is its own follow-up slice; Task 4 registers a reviewed disposition for the file's
  `boundary.unknown` findings in `scripts/repo-style-check/reviewed-dispositions.mjs`, and the
  changed-style gate passes. _Cost if wrong:_ a follow-up slice.
- **R-A1-21 (W-A A1):** the narrowing travels in the envelope (a principal broadcast in a room or a listed
  room broadcast); the RTC leg converts it to the frozen narrowed multicast before admission; no
  `audience` field on the manager input (the frame's name is withdrawn). _Cost if wrong:_ none; a side
  input would be lost on replay and hand-over.
- **R-A1-22 (W-A A2):** `newALBroadcastMessage` writes `recipientPeerIds` as given; the canonical decoder
  refuses a non-room list as `malformed` at admission (no `Either` builder across 188 call sites). _Cost
  if wrong:_ a later builder-level refusal.
- **R-A1-23 (W-A A3, A4, A6, A9):** `RallarRtcSendInput` takes `scope` too (one `RallarMessageScope`);
  `computeFrozenAudience` keeps its input object with a required `narrowing: RtcAudienceNarrowing |
  undefined`; a narrowed RTC send also honours `exceptPeerIds`; a world send ignores its channel's room.
  _Cost if wrong:_ one optional public field.
- **R-A1-24 (W-A A5):** after an RTC leg admits a narrowed send, the WS hand-over carries the frozen
  multicast verbatim (D80); the server's narrowed-audience path is exercised by direct WS sends and by
  legs that hand over before freezing. _Cost if wrong:_ none.
- **R-A1-25 (W-A A7, rejected as proposed):** a narrowed send whose RTC leg has no authorized room HOLDS as
  a room multicast does (the replan from the stored row freezes it once the room is authorized); it does
  not answer `no-route` at once. _Cost of the rejected form:_ an RTC-only private send failing while the
  snapshot loads.
- **R-A1-26 (W-A A8, limit):** an RTC peer receiving a `broadcast/principal` relayed by another peer
  delivers it to the whole room; browser origins never send that shape on RTC (converted to a multicast)
  and the server never sends on RTC. A documented limit.
- **R-A1-27 (W-A A10):** the touched-file closures change public AI types (the `= unknown` generic
  defaults go; `generateJson`'s `TContext` defaults to `RallarAiJsonValue`), named in the PR body's
  Public surface. _Cost if wrong:_ an external caller adds a type argument.
- **R-A1-28 (assembler):** the WS server whose router owns the room fanout hands a listed room broadcast
  that leaves the server out to its router, as it hands a room unicast to another session: Task 1's
  `toRouterDeliveredPlan` reads a private `isAddressedPastServer(message, serverPeerId)` in
  `ws-queue-box-server-inbound-plan.ts`, pinned in `rallar-server-ws-default-fanout.test.ts`. On the
  composition Task 1's planner rule made the server, which no list names, disable its own local
  delivery, so the router never fanned out a listed send (Task 2's api-v1 case "a room broadcast with a
  fixed list reaches the listed sessions in the room alone, and its receipt expects them" failed with
  carol `[]`; W-B's tree had only a stub of Task 1). The pin is green at the base and red with the
  planner rule alone. _Cost if wrong:_ one predicate moves (for example to a server-side planner input).
- **R-A1-29 (assembler):** `apps/relic-hunters-v1/docs/runtime-data-flow.md` and `ui-gameplay.md` keep
  Task 5's wording; Task 6 no longer touches them: its prototype said the hunter's other sessions show
  proposals "as party notes", which R-A1-4 and R-A1-15 remove. _Cost if wrong:_ none.
- **R-A1-30 (assembler):** Task 6's text is made true of the composed code: the hand-over sentence follows
  R-A1-24 (a frozen send goes to WS as the frozen multicast; one handed over before its freeze as the
  principal or listed room broadcast it was sent as); the product description's lane sentence names the
  `same-principal` family's three cells and no `all-refused` cell (R-A1-12); "the sender's handle reads
  `rejected`" for a client `all` becomes "reaches no one" (no browser can send it); the API reference
  states that no client room, principal, list or world send returns to its own session (R-A1-16,
  R-A1-19); the inbound README states R-A1-28's server rule. _Cost if wrong:_ doc wording.
- **R-A1-31 (assembler):** no budget is crossed after Task 1: the composed head measures
  `browser/rallar.ts` 240.6 KiB (240.562 by W-A's measure) of 241 and the headless agent 305.807 KiB of
  306 (0.19 KiB headroom). Task 4 therefore no longer edits `headless-bundle-budget.json` (Task 1 raised
  it) and its commit message carries the measured 305.807. _Cost if wrong:_ the next slice raises the
  headless budget.
- **R-A1-32 (assembler):** every task's changed-range gates run from the plan base `eef7fd9b1`;
  `origin/main` (`b751caebf`) is equivalent, because the two design commits change only three Markdown
  files under `playground/alm/`. _Cost if wrong:_ none; a narrower range checks a subset.

## Limits (carried; Task 7 states them in the PR body)

- Server-originated per-player private events (no server principal publish helper, no
  server-originated conformance cell, D155) are carried to A2's consumer work (D163).
- The deployment-wide principal audience (a principal's sessions across rooms) stays the server's
  state-sync machinery; no client send addresses it (D163).
- A list longer than 256 entries is refused by the collection limit (the browser validator's
  `invalid-fixed-audience`); no batching (D163).
- A listed session outside the room is narrowed away silently, as a multicast's intended audience is;
  an empty audience settles as an empty room audience does (one empty `admitted` receipt on WS) (D163).
- A client's non-room broadcast is still delivered twice on WS (the service's own forwarding and the
  router), as before A1; both copies are scope-bound now (R-A1-7; follow-up).
- A server-originated principal broadcast with no room has no room-bounded meaning: in memory it reaches
  the state-sync audience or every connection, on Postgres the principal's own sessions. No client can
  send it (the browser validator and WS ingress refuse it, R-A1-9); a server-only gap.
- An RTC peer that receives a `broadcast/principal` relayed by another peer delivers it to the whole
  room; no browser origin sends that shape on RTC and the server never sends on RTC (R-A1-26).
- The Relic "Party Notes" panel is replaced by the one suggestion card that shows the hunter's newest
  proposal from any of the hunter's sessions; other hunters' proposals no longer reach a browser
  (R-A1-4, R-A1-15; a product change for the maintainer).
- The typed closure of the harness contracts (`rallar-black-box-test-contracts.ts`'s JSON `unknown`s,
  under a reviewed disposition) is a follow-up slice (R-A1-20).
- A principal-scoped AI result does not travel over `realtime` (R-A1-5).
- No lane cell sends a client `all`, because no page can (R-A1-12); the `same-principal` family is not in
  the hosted manifests (R-A1-14).
- `world` has no receipts (`ack: 'none'`, D159).

## Corrections and notes (Task 7 states them in the PR body's Corrections)

- **A defect on `main`, fixed in Task 1:** a durable room multicast held before its room snapshot was
  sent unfrozen at the replan (`admission/al-outbound-admission-reads.ts:420` rebuilt the copies from the
  stored unfrozen row) and every RTC receiver refused it (`validate-al-inbound-message.ts:53-56`). The
  replan now replaces the row through the canonical replacement a minted replay already uses; pinned for
  room, principal and list.
- **CRDT room-less sends took the current room before Task 3:** the CRDT transport's app and principal
  documents and catch-up requests sent with `scope` undefined, which the WS sender read as the current
  room; Task 3 sends them to `world`.
- **The Party Notes removal** (R-A1-4, R-A1-15).
- **A client's WS room send no longer echoes to its own session** (R-A1-19); no app-visible change.
- **The WS server's router-delivered plan** covers a listed room broadcast (R-A1-28), found at
  composition.
- **Open at the lane run:** the ws-only prototype run logged many "Rejected RTC message malformed"
  console warnings (undiagnosed; Task 7 Step 4 classifies them as pre-existing or not).

## Tasks

### Task 1: Contracts, planner and the narrowed RTC audience (D156, D159, D160)

**Files** (anchors at the design commit `eef7fd9b1`; the composed commit is `.superpowers/sdd/a1-plan/final-patch-task-1.patch`, `git am`-able there; 22 files)

- Modify `packages/shared/al-contracts/al-contract.ts`: comments `principalRef` (`:59`) "Scope 'principal': the
  principal's live sessions in the room `groupRef` names." and `recipientPeerIds` (`:64`) "The sender's fixed audience
  inside the room, or the audience a server captured for replayable work; never wider than the room.". Before `:177` the
  private `type ALBroadcastMessageBuilderOptions` (today's broadcast options minus `groupRef`); `newALBroadcastMessage`
  (`:398`) takes it `& { groupRef?; recipientPeerIds? }` (doc: "Room scope only: the canonical decoder refuses a list
  with another scope as malformed.") and writes `recipientPeerIds` after `rosterVersion` (`:436`); no `Either`,
  `assertPersistedALTargets:74-76` is the refusal (R-A1-22). `isRoomScopedALMessage` (`:370`) and `readALTargetGroupRef`
  (`:378`) also take a principal broadcast with `groupRef`. At the end export `newALPrincipalBroadcastMessage<T>(senderId,
  route, target: { groupRef; principalRef }, typeId, resource, options?: ALBroadcastMessageBuilderOptions)` (six
  positional parameters, the builder family's exception): the room broadcast with its `targets` replaced by `{ mode:
  'broadcast', scope: 'principal', groupRef, principalRef, exceptPeerIds, minSnapshotVersion, rosterVersion }`.
- Modify `validate-al-ack-support.ts`: the doc (`:25`) names "a multicast, a room broadcast with or without its fixed
  list, or a principal broadcast that names its room; a world or all broadcast has none"; `hasLogicalReceiverAudience`
  (`:55`) also accepts `targets.scope === 'principal' && targets.groupRef !== undefined`.
- Modify `al-policy.ts:739-740` (`isLogicalRecipient`): a broadcast is a recipient when not excepted and
  `targets.recipientPeerIds === undefined || targets.recipientPeerIds.includes(selfPeerId)`.
- Modify `resolve-al-owned-child-peer-ids.ts:30`: a broadcast's list filters the owned children beside the member set.
- Modify `packages/shared/multicast/rtc-room-snapshot-admission.ts`: the `authorized` arm (`:36`) gains `readonly
  memberSessions: readonly GroupPresenceSession[];` beside `memberPeerIds`, filled at `:181-190`.
- Modify `web-rtc-overlay-frozen-audience.ts`: export `type RtcAudienceNarrowing = { kind: 'principal'; principalId }
  | { kind: 'list'; recipientPeerIds }` before `:16`; `ComputeFrozenAudienceInput` gains the required `narrowing:
  RtcAudienceNarrowing | undefined` (input object kept, R-A1-23) and `computeFrozenAudience` filters `memberSessions`
  less self by it. Export `toRtcAudienceNarrowing(message)` (principal broadcast with room → principal; listed room
  broadcast → list), `isRtcUnfrozenRoomMessage` (a narrowing, or a multicast without its frozen audience) and
  `toRtcFrozenRoomMessage(message, admission, selfPeerId)` (no narrowing → today's freeze; else `targets: { mode:
  'multicast', groupRef, minSnapshotVersion, rosterVersion, recipientPeerIds: <narrowed> less exceptPeerIds,
  snapshotVersion }`); `toRtcOriginFrozenMessage` (`:33`) freezes through them. Export
  `computeRtcBroadcastScopeRefusal(msg)` (left for a non-room broadcast without a narrowing: `` `RTC carries room
  audiences only: a ${scope} broadcast is unsupported` ``, `unsupported`, `volatile`, no copies);
  `computeRtcFrozenAudienceRefusal(msg, original)` (`:64-72`) refuses with the original broadcast's targets, so a
  fallback keeps the narrowed audience.
- Modify `compute-rtc-outbound-carrier-availability.ts`: `toRtcCarrierGapFrozenMessage` (`:86`) freezes any
  `isRtcUnfrozenRoomMessage` through `toRtcFrozenRoomMessage`; `isRtcCarrierGapHeld` drops the exclusion of a listed
  broadcast (`:117-118`): a listed send holds as a multicast does.
- Modify `web-rtc-overlay-multicast-manager.ts:534-541`: the refusal chain starts with the scope refusal and passes
  `original` to `computeRtcFrozenAudienceRefusal`.
- Modify `al-contracts/al-frozen-multicast-audience.ts`: `toALFreezeComparableMessage` (`:38`) maps a narrowed
  broadcast frozen as its room's multicast (same room and floors, list inside the list and outside the exceptions:
  private `isALNarrowedBroadcastFrozenAs`) back to the original targets; export `isALFreezeOfMessage(original,
  candidate)` before `:51` (original unfrozen, candidate frozen, equal after the freeze comparison).
- Held rows freeze on replan (the ruling on R-A1-25; a defect today: a durable room multicast held before its room
  snapshot was sent unfrozen, and RTC receivers refuse it, `validate-al-inbound-message.ts:53-56`):
  `admission/al-outbound-admission-reads.ts:420` keeps the planner's message when `isALFreezeOfMessage(canonical,
  selected.msg)`; `al-outbound-dispatch-admission.ts:540` builds the entry from `read.msg` when
  `isALFreezeOfMessage(read.originalMsg, read.msg)`; `al-outbound-canonical-message.ts:184` replaces
  `isALOutboundMintOfPendingRequest` with `isALOutboundCanonicalReplacement(activatesPendingRow, expected, entry)` (a
  freeze of the held row, or today's mint rule); `al-outbound-canonical-storage.ts:133,161` read one `replacing`
  (the split keeps both files under the changed-gate tiers).
- Modify `packages/shared/services/ws-queue-box-server/ws-queue-box-server-inbound-plan.ts` (R-A1-28): the doc
  (`:17-20`) reads "A room unicast to another session, and a room broadcast whose fixed list leaves the server out, is
  the router's to deliver (Q4)"; `toRouterDeliveredPlan` (`:50-51`) computes `routerDelivers =
  input.routerOwnsRoomFanout && isAddressedPastServer(message, input.serverPeerId) && plan.dropReasonCode === undefined`;
  at the end of the file a private `isAddressedPastServer(message: ALMessage, serverPeerId: string): boolean` (`unicast`
  → `!isALUnicastAddressedTo(message, serverPeerId)`; `broadcast` → `targets.recipientPeerIds !== undefined &&
  !targets.recipientPeerIds.includes(serverPeerId)`; otherwise `false`). Without it the planner's list rule leaves the
  server, which no list names, without its local delivery, and the router never fans a listed send out.
- Modify `packages/shared-web/bundle-budgets.json` (`browser/rallar.ts` 240 → 241) and
  `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` (305 → 306).
- Tests: create `packages/tests/shared/al-contracts/al-audience-targets.test.ts`; modify
  `packages/tests/shared/al-contracts/validate-al-ack-support.test.ts`,
  `packages/tests/shared/multicast/web-rtc-overlay-frozen-audience.test.ts`,
  `rtc-outbound-overlay-readiness.test.ts:296` (`'fixed-audience'` leaves the never-held list: a listed send holds),
  `packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts:118` (the refusal's second argument),
  `packages/tests/shared-server/rallar-system/websocket/router/rallar-server-ws-default-fanout.test.ts` (a case before
  `createLiveRoomFixture`, `:92`).

**Interfaces.** Produces for Tasks 2–4: `newALPrincipalBroadcastMessage(senderId, route, { groupRef, principalRef },
typeId, resource, options?)`; `newALBroadcastMessage(..., { groupRef, recipientPeerIds })`; `readALTargetGroupRef` and
`isRoomScopedALMessage` read a principal broadcast's room; `RtcAudienceNarrowing`; `computeFrozenAudience({ admission,
selfPeerId, narrowing })`; the authorized admission's `memberSessions`; `toRtcAudienceNarrowing`,
`isRtcUnfrozenRoomMessage`, `toRtcFrozenRoomMessage`, `computeRtcBroadcastScopeRefusal`; `isALFreezeOfMessage`;
`isALOutboundCanonicalReplacement`; the WS server's router-delivered plan of a listed room broadcast that leaves the
server out (R-A1-28), which Task 2's api-v1 fixed-list case relies on. **The RTC rule** (R-A1-21, R-A1-25 as ruled): the narrowing travels in the
envelope — the principal broadcast in a room or the listed room broadcast. The RTC origin freezes it as the narrowed
room multicast at the plan that first reads an authorized room, exactly where it freezes a room multicast: at
admission when the room is authorized, else the send is held (`hold`, durable) or handed over unchanged (`hand-over`
gap: no-route), and the replan from its stored row freezes it and replaces the row, so every copy, the receipt and a
WS hand-over carry the frozen audience (D80). A world, all or roomless principal broadcast is refused `unsupported`
(today it ends `unroutable`/`no-route` "without overlay context", manager `:573`).

**D8 reuse inspection.** The authorized room admission, `computeFrozenAudience`, the origin and carrier-gap freezes,
the freeze comparison, the canonical-row replacement a minted replay already uses (one predicate now), the
`unsupported` refusal plan of the RTC room limit and the canonical decoder's room-scope rule carry it; the planner's except and member-set filters carry the list; the router-delivered plan a room unicast already takes
carries a listed broadcast past the server. No new state, no `Either` builder, no new decoder rule.

- [ ] **Step 1: Write the failing tests** (copy from the patch). `al-audience-targets.test.ts`: "names the room and the
      principal, keeps the room send options, and decodes" (targets toEqual the principal shape with except `['b']`,
      floors 7/4; delivery `at-least-once`/`receiver`; decodes); "is room-scoped by its room, and a principal broadcast
      that names no room is not"; "carries the sender's list beside the room and decodes"; "keeps a list given with
      another scope, which the canonical decoder refuses as malformed" (`{ code: 'malformed', message: 'Persisted AL
      fixed recipient audience requires room scope' }`); planner "delivers to a listed session and forwards only to
      listed children" (next hops `['c']`); "delivers nothing to a session the list leaves out". Ack support: "admits
      receiver on a principal broadcast in a room and on a listed room broadcast, over both carriers"; "refuses receiver
      on a principal broadcast that names no room and on an all broadcast" (green at base: the guard). Frozen audience
      (fixture `rtc-origin-overlay-fixture.ts`, snapshot `a b c d` where `a b d` belong to `principal-1`, leg
      `enqueueLegIfAbsent(message, 'hold')`): `computeFrozenAudience` "narrows the authorized sessions except the origin
      to 'a principal'" (`['b','d']`) / "'a list'" (list `a c z` → `['c']`); "freezes a principal broadcast in its room
      as the principal's other sessions, the multicast every copy and the receipt carry" (`toOriginFrozenTargets(['b',
      'd'], 4)` on b and c, receipt `['b','d']`); "freezes a listed room broadcast as the listed sessions the room holds,
      less the excepted ones" (list `c d z`, except `d` → `['c']`); the hold pins, `it.each` room / principal / list,
      "holds a durable $audience send admitted before its room snapshot and freezes it to $recipientPeerIds when the
      snapshot arrives" (`fixture.groups.delete('room')`, `local-outbox`, verdict `{ kind: 'admitted', durable: true,
      queuedAttempts: 0 }`, nothing sent after 200 ms; `groups.accept('room', snapshot)`, 200 ms; b received
      `toOriginFrozenTargets(<b c d | b d | c>, 4)`, receipt expects the same); `it.each(['world','all','principal'])`
      "refuses a %s broadcast that names no room as unsupported, sending nothing" (`{ kind: 'refused', reason:
      'unsupported', detail: 'RTC carries room audiences only: a world broadcast is unsupported' }`). The existing pure
      case passes `narrowing: undefined`. Fanout (`rallar-server-ws-default-fanout.test.ts`, router-owned fixture,
      receivers `receiver-a` and `receiver-b`): "sends a room send with a fixed list live to the listed receiver alone
      and expects it alone" (`createReceiverRoomSend('listed-live', …)` with `targets: { mode: 'broadcast', scope:
      'room', groupRef: ROOM, exceptPeerIds: ['origin'], recipientPeerIds: ['receiver-a'] }`; receiver-a one delivery,
      origin receipts `[{ phase: 'admitted', expected: ['receiver-a'], confirmed: [] }]`, receiver-b none) — green at
      the base, red with the planner rule alone (`expected +0 to be 1`).
- [ ] **Step 2: Run red.** `npx vitest run packages/tests/shared/al-contracts/al-audience-targets.test.ts
      packages/tests/shared/al-contracts/validate-al-ack-support.test.ts
      packages/tests/shared/multicast/web-rtc-overlay-frozen-audience.test.ts
            packages/tests/shared/multicast/rtc-outbound-overlay-readiness.test.ts
      packages/tests/shared-server/rallar-system/websocket/router/rallar-server-ws-default-fanout.test.ts`: 17 failed,
      97 passed (114); e.g.
      `TypeError: newALPrincipalBroadcastMessage is not a function`, `expected [ 'b', 'c' ] to deeply equal [ 'c' ]`,
      `expected { kind: 'unroutable', …(2) } to deeply equal { kind: 'refused', …(2) }`, and the room hold pin red on
      today's code: `expected [ { mode: 'multicast', …(1) } ] to deeply equal [ { mode: 'multicast', …(3) } ]` (the held
      multicast goes out unfrozen).
- [ ] **Step 3: Implement** (contract, ack support, planner, admission sessions, narrowing, origin and gap freezes,
      refusals, freeze comparison, held-row replacement). Green: 114 passed.
- [ ] **Step 4: Verify.** `npx vitest run packages/tests/shared/multicast packages/tests/shared/al-contracts
      packages/tests/shared/alm packages/tests/shared/services packages/tests/shared/al-policy.test.ts
      packages/tests/shared/al-message-persistence-decoding.test.ts packages/tests/shared/ws-server-qos-policy.test.ts
      packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts
      packages/tests/shared/rtc-snapshot-nack.test.ts packages/tests/shared/al-inbound-message-runtime.test.ts
            packages/tests/shared-web/messages packages/tests/shared-server/rallar-system/websocket
      packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
      packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
      packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` (216 files, 2545 passed; the four pins
      inside, unedited). `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/
      tsconfig.json --noEmit`; `node scripts/check-tests-typecheck.mjs` (PASS); `deno check` on the fourteen changed
      `packages/shared/**` files; `cd apps/api-v1 && deno task check`, then `rm -rf apps/api-v1/node_modules/.deno`.
      Bundles (private `TMPDIR`): facade 240.155 KiB (base 239.759) → budget 241; headless 305.290 (base 304.905) →
      306; `shared-web-public-api-snapshots.test.ts` unchanged. `npx dprint fmt` on touched files (pipe the list through
      `xargs`; zsh does not split `$(...)`).
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- eef7fd9b1 HEAD` (read the verdict line: PASS),
      `node scripts/check-test-structure-coupling.mjs --changed eef7fd9b1 HEAD` (PASS), `npm run
      check:test-reachability` (a test file was added: `1764 test files, 1758 reached by CI, 6 manual`).

```text
Give principal and listed room audiences one shape over both carriers

A principal broadcast names its room: newALPrincipalBroadcastMessage builds
broadcast/principal with groupRef and principalRef, and a principal
broadcast with groupRef is room-scoped and reads its room like a room
broadcast. newALBroadcastMessage carries the sender's fixed list
(recipientPeerIds) as given; the canonical decoder refuses a list with
another scope as malformed at every carrier admission. receiver and
all-logical-recipients have a logical audience for a principal broadcast in
a room and for a room broadcast with or without its list. The shared
planner delivers a listed broadcast only to a listed session and owns only
listed children; a WS server whose router owns the room fanout still hands
a listed room broadcast that leaves the server out to its router, as it
hands a room unicast addressed to another session.

On RTC the authorized room admission carries the sessions it admitted, and
computeFrozenAudience narrows them to one principal or to a list. The
origin freezes a principal or listed room broadcast as the room multicast
of that narrowed audience, less the excepted sessions, at the plan that
first reads an authorized room; until then it is held exactly as an
unfrozen room multicast is, and a hand-over leg answers no-route with the
broadcast unchanged. A held room send whose replan freezes its audience
now replaces its canonical row, so the copy it sends carries the frozen
audience: before, a durable room multicast held without its room snapshot
went out unfrozen and every RTC receiver refused it. The freeze comparison
accepts a narrowed broadcast frozen as its room's multicast within its
list. A world, all or roomless principal broadcast is refused unsupported
at the RTC origin instead of ending no-route.

Bundle budgets raised: browser/rallar.ts measures 240.155 KiB (base
239.759) against 240, now 241; the headless agent measures 305.290 KiB
(base 304.905) against 305, now 306.

D8 reuse: the authorized room admission, computeFrozenAudience, the origin and carrier-gap freezes, the canonical replacement a minted replay already uses and the unsupported refusal plan of the RTC room limit carry the narrowed audience; the planner's exceptPeerIds and member-set filters carry the list; the router-delivered plan of a room unicast carries a listed broadcast past the server.
```

### Task 3: The browser surface and the routed decision (D157, D160)

**Files** (anchors at Task 1's commit, identical to `eef7fd9b1` for every file below except `browser-message-fallback-identity.test.ts`, whose `:118` Task 1 edits; the composed commit is
`.superpowers/sdd/a1-plan/final-patch-task-3.patch`, cut on top of Task 1; 38 files)

- Modify `packages/shared-web/browser/messages/rallar-message-contracts.ts`: before `RallarRtcSendInput` (`:56`) export
  `type RallarMessageScope = 'room' | 'world' | 'principal'` (doc: room = the room's live sessions; principal = one
  principal's live sessions in the room; world = the sender's authenticated scope; RTC carries room audiences only, a
  world send takes WS when its strategy allows WS and is refused `unsupported` on RTC alone) and the private `interface
  RallarRoomAudienceInput { scope?: RallarMessageScope; principalId?: string; recipientPeerIds?: readonly string[]; }`
  (docs: principalId "With `scope: 'principal'` and a room"; list "With room scope: at most 256 distinct session ids; a
  listed session outside the room is not reached"). `RallarRtcSendInput` and `RallarWsSendInput` (`:67-78`, whose own
  `scope` line goes) extend it: one scope type on both inputs, so the typed options' `Partial` union stays one type and
  R-A1-3's explicit scope applies on both carriers (R-A1-23).
- Modify `browser-message-input-validator.ts`: `ResolvedWsMessageInput.scope: RallarMessageScope` (`:26`);
  `validateRtc` (`:79`) and `validateWs` (`:111-115`) call `pushAudienceIssues(audience, scope, issues)` (RTC with
  `input.scope ?? 'room'`); `validateWs` pushes the room issues for `room` and `principal`; `pushWsScopeIssues`
  (`:238-244`) accepts `room, world, principal` with "WS scope must be room, world, or principal.". Before
  `pushRoomIdentityIssue` (`:271`) add `pushAudienceIssues` (`$.principalId` `missing-principal-id` "A principal-scoped
  send names its principalId."; `$.principalId` `principal-scope-required` "A principalId is sent with scope
  principal."; the route-id check) and `pushFixedAudienceIssues` (`$.recipientPeerIds`
  `fixed-audience-requires-room-scope` "A fixed recipient list is sent with room scope."; `invalid-fixed-audience`
  "A fixed recipient list names 1 to 256 distinct session ids." from `AL_MESSAGE_RESOURCE_LIMITS.collectionEntries`;
  each id a route id). Every issue is returned together.
- Modify `browser-rallar-message-sender.ts`: `Creation` (`:72-77`) gains `createPrincipalBroadcast: typeof
  newALPrincipalBroadcastMessage`; private `interface RoomSendAudience { exceptPeerIds?; principalId?;
  recipientPeerIds? }`. `sendRtc` (`:106`) sends a `world` input through `sendScoped(input, 'rtc', channel)` and wraps
  its room message in `toRoomFallbackMessage(..., input)`. `sendWs` (`:130-171`) becomes `sendScoped(input, 'ws',
  channel)`: a world send names no room (`room` undefined for `scope: 'world'`), `scope = input.scope ?? (roomId ?
  'room' : 'world')` (R-A1-2), `roomRef` resolved unless world, `carrier` from the argument. `sendTyped` (`:187`) sends
  `scope: 'world'` through `sendWs` before the switch unless the strategy is `rtc`. `sendRoomWithFallback` (`:247-261`)
  drops `validateRoomFallbackInput` (deleted, `:414-426`), validates WS with `input.scope ?? 'room'` and passes `input`
  to `toRoomFallbackMessage`. `createWsMessage` (`:338-375`): `hasLogicalAudience: scope !== 'world'`, contextId
  `input.contextId ?? roomId ?? scope`, the shared options object, then `createBroadcast(..., scope, ..., { ...options,
  groupRef: roomRef, recipientPeerIds })` or, for principal, `createPrincipalBroadcast(..., toPrincipalTarget(roomRef,
  input.principalId), ..., options)`. `toRoomFallbackMessage(message, audience)` (`:439-454`) keeps a multicast with no
  except, principal or list; else a room broadcast (`groupRef`, floors, except, `recipientPeerIds`) or a principal
  broadcast (`principalRef` = the room's application and workspace + `principalId`). Private
  `toPrincipalTarget(roomRef, principalId)` throws `Error('A validated principal send names its room and its
  principal.')` (a programmer invariant after validation).
- Modify `packages/shared-web/browser/composition/browser-communication-composition.ts:25,109` (import, `createPrincipalBroadcast:
  newALPrincipalBroadcastMessage`).
- Modify `packages/shared-web/browser/rallar-ai.ts:31-39`: `RallarBrowserAiBroadcastInput` gains `scope?: 'room' |
  'principal'` and `principalId?: string`; the `= unknown` generic defaults go (`:31,47,59,62`; touched-file
  `boundary.unknown` closure), `generateJson<TValue, TContext = RallarAiJsonValue>` (`:56`). `ai/browser-rallar-ai-result-
  delivery.ts:117-149`: `realtime` with `scope: 'principal'` → `throwRallarValidation([{ path: '$.transport', code:
  'unsupported', message: 'A principal-scoped AI result is broadcast over messages.ws or messages.rtc.' }])` (R-A1-5);
  the message input carries `scope: input.scope ?? 'room'` and `principalId`.
- `'all'` leaves the browser (R-A1-6, R-A1-17), type-only outside the lanes: `calls/browser-call-signal-runtime.ts:128`
  `'world'` (a unicast beside `peerId`); `crdt/browser-crdt-transport.ts:32` `'room' | 'world'`, its room-less WS sends
  name `'world'` (`:361`, `:548`, `:651-653`), and its five `<unknown, TPayload>` envelopes become
  `<RallarCrdtJsonValue, TPayload>` (closure); harness `black-box-rallar-operation-contracts.ts:278,298`,
  `black-box-rallar-runtime-contract.ts:41`, `decode-black-box-rallar-send-input.ts:41`,
  `decode-black-box-rallar-message-send-input.ts:33`, `rallar-bb-test/schema/rallar-black-box-command-fields.ts:296`,
  `rallar-bb-test/browser/browser-rallar-command-input.ts:12,159,180`, `black-box-rallar-ws-send-controller.ts:170`
  (default `'world'`); `apps/rallar-black-box/src/direct-rallar-operations.ts:46`; the legacy WS console
  (`websocket-contracts.ts` wsScope `'room' | 'world'`, `closeCode?: number`, `closeReason?: string`, payloads typed
  `RallarBlackBoxTestEvent['payload']`; `websocket-diagnostics.ts` narrows close code/reason; `websocket-routing.ts`
  drops the all branches, `webSocketSendData(values, payload: RallarMessagePayload): RallarMessagePayload`, default
  contextId `'world'`; `websocket-presets.ts` ping → world; `web-socket-command-center-view.tsx` drops the `all` option;
  `web-socket-command-center-actions.ts:326,330`). `rallar-black-box-test-contracts.ts:327` stays for Task 4 (R-A1-17).
- Tests: create `packages/tests/shared-web/messages/browser-message-audiences.test.ts`,
  `packages/tests/shared-web/crdt/browser-crdt-transport-scopes.test.ts`; modify `ai/browser-rallar-ai.test.ts`,
  `crdt/rallar-crdt-test-runtime.ts` (`scope?` input, `sentScopes(transport)`), the sender fixture and the two inline
  `Creation` literals (`browser-message-fallback-identity.test.ts`, `browser-rtc-peer-send.test.ts`), `scope: 'all'`
  → `'world'` in the shared-web tests (contextId `'world'`), the deleted fallback-throw tests
  (`browser-rallar-message-sender.test.ts` "reports every unsupported fallback constraint…",
  `browser-message-fallback-identity.test.ts` "rejects a fallback strategy that would change a global audience…"),
  `packages/tests/rallar-black-box/websocket-command-center{,-controller}.test.ts` (world; commands typed
  `RallarBlackBoxTestCommand`); `docs/test-structure-coupling-exceptions.md` (contract
  `browser-invalid-fallback-no-admission` and its two entries replaced by `browser-invalid-scope-no-admission`,
  `browser-world-send-on-rtc-refused-alone`, `browser-ai-principal-result-not-realtime` with four entries).

**Interfaces.** Consumes Task 1's builders and the RTC leg conversion. Produces for Tasks 4 and 5:
`RallarWsSendInput`/`RallarRtcSendInput` `scope?: 'room' | 'world' | 'principal'`, `principalId?`,
`recipientPeerIds?`; the room channel's typed options carry them; `broadcastJson({ scope: 'principal', principalId })`.
**Routing:** principal and list sends with a room are the room path on every strategy (WS shape on `ws`; the same
broadcast to the RTC leg, which freezes it); `world` on `rtc-with-ws-fallback`/`ws-then-rtc` → WS at once, no RTC leg,
no `carrierFallback`; `world` on `rtc` → the world broadcast to the RTC leg (`hold`), refused `unsupported`, handle
`rejected`. After this task `grep -rn "'all'" packages/shared-web/browser packages/shared-test/rallar-bb-test
packages/shared-test/black-box-runner apps/rallar-black-box/src` shows no send scope except: `rooms/room-events.ts:335`
and `people/browser-rallar-people-events.ts:401` (local replay envelopes for listeners, never sent),
`rallar-black-box-test-contracts.ts:327` (Task 4), and non-scope `'all'` (media `stopLocal`, AL cleanup policy,
recipe `join`, UI filters).

**D8 reuse inspection.** The existing except-list conversion (`toRoomFallbackMessage`) carries principal and list,
the WS builder family builds them, the RTC leg's `unsupported` refusal is the rejected verdict of a world send on
`rtc`, the CRDT fake network records the scope it already receives. No new carrier path, no dispatch change.

- [ ] **Step 1: Write the failing tests** (copy from the patch). Audiences (facade, `rallar-facade-test-runtime.ts`,
      room `room-1` with `session-1`, `peer-1`): `it.each(['rtc-with-ws-fallback','ws-then-rtc'])` "admits a world send on
      %s over WS at once, with no RTC leg and no fallback evidence" (RTC port not called; WS `{ route: { contextId:
      'world' }, targets: { mode: 'broadcast', scope: 'world' } }`; state `queued`; `carrierFallback` undefined); "admits a
      world send on rtc over RTC alone, which refuses it unsupported, and the handle ends rejected"; "defaults a WS send
      that names neither a room nor a scope to the sender's world"; `it.each` four strategies "addresses the principal in
      its room as a principal broadcast on %s" (ack `all-logical-recipients`); three strategies "addresses a fixed list in
      its room as a listed room broadcast on %s"; "hands the principal broadcast to WS as it came when the RTC leg cannot
      freeze it"; "returns every audience issue together before connecting" (missing-room, missing-room-ref,
      missing-principal-id, fixed-audience-requires-room-scope, invalid-fixed-audience); "requires the principal scope
      beside a principal id"; "refuses a fixed list with 'a repeated session' / 'more than 256 sessions'"; "names the
      three scopes a browser WS send may take". AI: "broadcasts a principal-scoped result to the principal over a message
      transport, and never over realtime". CRDT: "sends an app document to the sender's world and a room document to its
      room".
- [ ] **Step 2: Run red.** `npx vitest run packages/tests/shared-web/messages/browser-message-audiences.test.ts
      packages/tests/shared-web/crdt/browser-crdt-transport-scopes.test.ts packages/tests/shared-web/ai/browser-rallar-ai.test.ts`:
      19 failed, 8 passed (27); e.g. `RallarValidationError: $.scope: RTC/WS fallback requires the same scoped room
      audience on both carriers.` (the throw at `browser-rallar-message-sender.ts:414-425`).
- [ ] **Step 3: Implement**; update the touched tests and the registry as listed. Green: 27 passed.
- [ ] **Step 4: Verify.** `npx vitest run packages/tests/shared-web packages/tests/shared-test packages/tests/rallar-black-box
      packages/tests/rallar-black-box-headless packages/tests/shared/multicast packages/tests/shared/al-contracts
      packages/tests/shared-server/rallar-ai packages/tests/relic-hunters packages/tests/ar-eye-hunter-v1` (604 files; 6092 passed, 25 failed,
      all sandbox reds: `live-rtc-control-client`, `api-v1-rtc-rtt-recipe-semantics`,
      `api-v1-state-write-convergence-recipe`, `local-websocket-session` `listen EPERM`, `headless-worker-script`; the
      headless bundle test can time out under that load and passes alone). `npx tsc -p
      packages/{shared,shared-web,shared-test}/tsconfig.json --noEmit`; `npm run typecheck --workspaces --if-present` (all
      apps, rallar-black-box included); `node scripts/check-tests-typecheck.mjs` (PASS). Bundles (private `TMPDIR`):
      facade 240.562 KiB of 241, headless 305.646 of 306 (0.35 KiB headroom; no budget crossed); API snapshot and
      bundle-boundary tests pass. dprint on touched files.
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- eef7fd9b1 HEAD` (PASS: touching a file enforces its
      `boundary.unknown`, hence the closures above), `node scripts/check-test-structure-coupling.mjs --changed eef7fd9b1
      HEAD` (PASS, six candidates classified), `npm run check:test-reachability` (`1766 test files, 1760 reached by CI, 6 manual`).

```text
Route browser sends by their audience: room, principal, list or world

RallarWsSendInput and RallarRtcSendInput share one audience: scope room,
world or principal, principalId with scope principal and a room, and a
fixed recipientPeerIds list with room scope (1 to 256 distinct sessions).
'all' leaves the browser surface: a WS send that names neither a room nor
a scope reaches the sender's world, and the CRDT transport, the harness,
the operator console and call signalling send world where they sent all. The validator returns
every audience issue together: a principal scope without its principalId,
a principalId without the principal scope, a list outside room scope or
outside its bounds, and the room a principal send needs.

sendWs builds the principal broadcast in the room with
newALPrincipalBroadcastMessage and a listed room broadcast with
newALBroadcastMessage. A room send on rtc or a fallback strategy is the
principal or listed room broadcast both carriers take
(toRoomFallbackMessage): the RTC origin freezes it as a narrowed room
multicast, and a hand-over leg in a carrier gap gives it to WS unchanged. The
fallback validation throw for a non-room scope is gone: a world send on
rtc-with-ws-fallback or ws-then-rtc is admitted on WS at once, with no RTC
leg and no carrierFallback evidence, and on rtc alone it is the world
broadcast RTC refuses unsupported, so the handle ends rejected. A world
send names no room, even from a room channel. broadcastJson takes scope
room or principal with principalId over messages.ws or messages.rtc, and
refuses principal over realtime.

Bundles: browser/rallar.ts 240.562 KiB of 241, headless 305.646 KiB of
306; no budget crossed.

D8 reuse: the existing exceptPeerIds room-broadcast conversion carries the principal and list shapes, the room channel's typed options carry the new inputs through Partial, the WS builder family builds them and the RTC leg's unsupported refusal is the rejected verdict of a world send on rtc.
```

### Task 2: The WS server binds client audiences — room-bounded principal and list, scoped world, refused all (D158, D159)

**Files** (anchors at `eef7fd9b1`; Tasks 1 and 3 touch none of them; the composed commit is
`.superpowers/sdd/a1-plan/final-patch-task-2.patch`, `git am`-able on Task 3; 35 files)

- `packages/shared/services/ws-queue-box-server/scope/to-ws-queue-box-server-scope-authorization.ts`: after the proof check (`:26-31`) a
  private `readClientAudienceRefusal(message)` (doc in the patch): `broadcast/all` → `{ reason: 'unauthorized', rejectionCode: 'unauthorized',
  logMessage: 'AL message <msgId> addresses every scope, which only the server may address' }`; `broadcast/world` on a `room.` topic (room-scoped
  by name, `al-contract.ts:370-371`) → `{ reason: 'no-route', rejectionCode: 'malformed', logMessage: 'AL message <msgId> addresses the world on
  room topic <topicId>' }`; `broadcast/principal` without `groupRef` → the same `no-route`/`malformed` with 'AL message <msgId> addresses a
  principal without the room it is addressed in' (the router's refusal of a message lacking its addressing, `rallar-server-ws-router.ts:315-321`).
  `readAddressedScope` (`:47-53`) → `readAddressedScopes(message): readonly StateScope[]` (`groupRef` and `principalRef`, each compared,
  `:32-43`, existing text); `toScopeRefusal(input, cause: ScopeRefusalCause)` (`:55-66`) spreads `{ reason, rejectionCode, logMessage }`.
  World needs nothing here: the proof's scope already travels as `source.authenticatedScope` → the router's `inboundScope`.
- `.../ws-queue-box-server/scope/resolve-ws-queue-box-server-recipient-scope.ts:15-27`: `resolveWsQueueBoxServerUnicastScope` → renamed
  `resolveWsQueueBoxServerProvenScope`, returning `provenScope` for `broadcast/world` first; callers rename, locals → `provenScope`:
  `ws-queue-box-server-recipient-selection.ts:47-50`, `ws-queue-box-server-live-delivery.ts:112-177` (live send and the service's own
  forwarding, `sendToResolvedPeer`), `publish-rallar-server-live-ws-notice.ts:188`.
- `.../ws-queue-box-server/ws-queue-box-server-target-resolution.ts:57-67`: the broadcast branch of `resolveOutboundRecipients` (where world
  recipients resolve for live, outbox and notice sends) also drops `message.id.senderId` for `scope === 'world'`. Forwarding already skips the
  sender (`ws-queue-box-server-inbound-delivery.ts:191-192`).
- `.../websocket/router/rallar-server-ws-router.ts:207`: the admitted fanout passes `admittedPeerIds: toClientDeliveryPeerIds(message,
  admittedPeerIds)`, a private function at the end of the file (doc "A client's room send reaches the audience it was admitted to, never its own
  origin session.") filtering out `message.id.senderId`. Only the admitted client path reads `source.groupRecipientPeerIds`, so server and proxy
  publications keep their audiences; live send, outbox `admittedAudience` and the room notice ids all derive from it.
- `packages/shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts:133`: `toAuthorizedRoomAudience` also filters by a private
  `isAddressedRoomSession(targets, session)` — non-broadcast → true; `principal` → same `principalId`; else not listed out by `recipientPeerIds`.
  It feeds `roomAudience` (`rallar-server-ws-router.ts:236-245`), the retained, proxy and server-publication audiences.
- `.../websocket/targets/create-ws-server-target-resolver.ts:63-65`: a message with `readALTargetGroupRef` (room or principal-in-room) → the
  group resolver. `resolve-ws-group-target.ts:89-105` `resolveLiveGroupSessions`: filter by `principalId` for `broadcast/principal`, then pass the
  ids through `filterLiveWsRoomRecipientSessionIds(targets, senderId, ids)` (`live-ws-audience.ts:60-76`: drops a multicast's origin, applies
  `exceptPeerIds` and a list) in place of the multicast-origin filter.
- `.../router/publish-rallar-server-ws-message.ts:134-138`: outbox `recipientScope: readALTargetGroupRef(message) === undefined ?
  resolveWsQueueBoxServerProvenScope(message, inboundScope) ?? undefined : undefined` (a scoped unicast as before, plus world).
  `validate-rallar-server-ws-publish-scope.ts:14-16`: a `broadcast/world` with an invalid `inboundScope` → `['A world publication requires the
  application and workspace scope it reaches']`; the doc there and at `rallar-server-ws-router-contracts.ts:20` name the world (patch).
- `.../router/publish-rallar-server-live-ws-notice.ts`: `toLiveWsPublicationInput` (`:90`) leaves only `targetMode: 'all'` unscoped (world then
  takes `resolveLiveWsPublicationScope`'s proven scope); `readLiveWsPublicationAudience` (`:126-169`) sends multicast, room and `principal` +
  `groupRef` to a new private `readRoomLiveWsPublicationAudience(input, targets)` (no audience or groupRef → undefined; ids =
  `resolveAuthorizedRoomSessionIds`; principal → `{ mode: 'principal', principalRef, recipientSessionIds }`, else `{ mode: 'room', … }`).
- `.../queue-pubsub/live-ws-notice.ts:12-81`: broad `LiveWsAudience` splits into `targetMode: 'all' | 'world'` members; only `all` is unscoped
  (private `UnscopedLiveWsAudience`/`ScopedLiveWsAudience`/`ListedLiveWsAudienceMode`, key variants to match). `live-ws-audience.ts:29-34`:
  exported `decodeBroadLiveWsAudience(targetMode, scope)` (`all` ⇔ no scope, `world` ⇔ scope) for `decode-live-ws-notice-shape.ts:51-112`. `live-ws-notice-subscriber.ts:146-151`: a keyed world notice is recovered only for a source whose
  `authenticatedScope` equals `notice.scope`.
- `.../queue-pubsub/queue-box-pub-sub-bridge.ts:407`: `recipientScope` for `directBroadcast || isWorldBroadcast(message) || principalTargetId`
  (private `isWorldBroadcast`); the unused `isWsQueueBoxServerDirectWorldBroadcastRow` import (`:22`) goes.
- `packages/shared-server/rallar-ai/rallar-server-ai-result-publication.ts:35`: the input's scoped arm splits into `{ scope: 'world';
  worldScope: StateScope; roomRef?: never }` (named like the room arm's `roomRef`) and `{ scope: 'all'; roomRef?: never }`; the publisher
  (`:96`) publishes via a new exported `toRallarServerAiPublishInput(message, fanout, worldScope)` (adds `scope` only when given);
  `ToRallarServerAiResultMessageInput.publication` (`:118`) narrows to `RallarServerAiResultPublicationBase`. `install-rallar-server-ai-websocket-topic.ts`:
  the context gains `authenticatedScope?: StateScope` (the router's context carries it); the handler (`:124-143`) publishes
  `toRallarServerAiPublishInput(…, target.scope === 'world' ? context.authenticatedScope : undefined)`; `toResultPublicationInput` (`:146-166`)
  and its two type imports are deleted.
- `apps/api-v1/src/services/filter-eligible-live-ws-session-ids.ts:64-74`: drop `isBroad`; apply `notice.scope` whenever it is present.
- Tests (existing files; fixtures in the patch): `packages/tests/shared/services/{to-ws-queue-box-server-scope-authorization,ws-queue-box-server-scope-nack,
  ws-queue-box-server-ingress}.test.ts` (ingress `:61-75` gains `groupRef` app/workspace/room-1), `packages/tests/shared-server/rallar-ai/rallar-server-ai-result-publication.test.ts`,
  `packages/tests/shared-server/rallar-system/websocket/{ws-topic-room-authorizer,targets/ws-server-target-resolver,router/rallar-server-ws-live-publication}.test.ts`
  (resolver `:577` → `toEqual([])`; live publication `:96-104` world passes `scope`), `…/rallar-system/rallar-server-ws-router.test.ts` (`:74`,
  `:124` ingress sends `world`, not `all`; `:778`, `:792`, `:889`, the large-room count → no origin session, each with a one-line intent
  comment), `apps/api-v1/test/crdt/crdt-websocket-authority.test.ts:341` (`'all'` → `'world'`, intent comment: the browser's app-document send), `…/queue-pubsub/{live-ws-notice,live-ws-notice-subscriber,queue-box-pub-sub-bridge}.test.ts`,
  `apps/api-v1/test/services/{ws-room-authority-delivery,filter-eligible-live-ws-session-ids}.test.ts` (harness `connectionScopes`).

**Interfaces.** Consumes Task 1's `readALTargetGroupRef`, `isRoomScopedALMessage`, `validateALAckSupport` for `principal` + `groupRef`
and its router-delivered plan of a listed room broadcast (R-A1-28), and Task 3's browser, which no longer sends `all`;
produces what "True of the code" lists. **D8 reuse inspection.** No new resolver, audience type or refusal: the room authorizer narrows, the
group resolver and `filterLiveWsRoomRecipientSessionIds` route, the proven-scope resolver, `scoped-recipient` send and the notice's `scope`
(read by `create-rallar-middleware-infrastructure.ts:122`) bind world.

- [ ] **Step 1: Write the tests** (copy from the patch). Scope authorization: it.each "refuses a principal broadcast whose $outside is in another
      scope" (principal/room → log `…addresses other/workspace|app/other, outside…`), "authorizes a principal broadcast in a room of its connection
      scope", "refuses a principal broadcast that names no room as malformed", "refuses an all broadcast, which only the server may address",
      "refuses a world broadcast on a room topic as malformed", "authorizes a world broadcast, which reaches its connection scope". Scope NACK
      (fixture with `sendNacks: true`): "refuses a world broadcast on a room topic as malformed with a no-route NACK" (`left { code: 'malformed',
      message: 'AL message message-1 addresses the world on room topic room.notification' }`, one NACK `reason: 'no-route'`, nothing admitted).
      Ingress fixture: "never sends a client's room broadcast back to its sender" (standalone service, roomAudience session-1/session-2;
      session-2 one room frame, session-1 none — green on arrival: the service's own forwarding skips `fromPeerId`,
      `ws-queue-box-server-inbound-delivery.ts:191-192`), "never sends a world broadcast back to the session that sent it" (second socket `session-2`; `sendToTargetsWithResult`
      recipients `['session-2']`, the sender's socket sent nothing). Ingress: "refuses %s from a client with its typed code and admits nothing"
      (all → `unauthorized`, principal without room → `malformed`; `admission.data.size === 0`, nothing delivered). Authorizer: "narrows the
      audience of a principal broadcast to the live sessions of that principal in the room" (sessions a, a-2 of `session-a`), "narrows the
      audience of a room broadcast with a fixed list to the listed live sessions in the room" (list `['session-c', 'outsider']` → session-c).
      Resolver: "routes a principal broadcast in a room to the live open sessions of that principal in the room alone" (`['session-a1',
      'session-a2']`; open a3 outside the room), "…fixed list to the listed live open sessions in the room alone" (`['session-c']`). Notice codec:
      "round trips a world notice inline and as a canonical key with the scope it reaches, and refuses one without it". Subscriber: "resolves a
      world canonical key against the local audience at receipt, for a sender in the scope it names" (an `all` source and an `other` scope
      source deliver nothing). Bridge: "hands a world row the scope it captured on the local and the remote send" (`[scope, scope]`). Live
      publication: "publishes a world notice with the scope it reaches and sends it here to the live connections of that scope alone", it.each
      `live-only|outbox|none` "fails a %s world publication that names no scope and publishes nothing", "publishes an admitted principal
      broadcast in a room as a principal notice naming the room sessions of that principal" (`['carol-1', 'carol-2']`). api-v1 filter: "a world
      notice keeps the authenticated sockets of the scope it names alone". api-v1 delivery, through `service.acceptIncomingMessage` and the
      real router: "a principal broadcast in a room reaches the live sessions of that principal in the room alone, and its receipt and outbox
      row expect them" (over `live-only` and `outbox`: alice and alice-2 one frame each; alice-elsewhere, bob, carol none; admitted receipt
      `expectedRecipientPeerIds ['alice', 'alice-2']`; outbox `admittedAudience ['alice', 'alice-2']`), "a principal broadcast stamped beyond
      the server roster is retained at ingress and delivered to that principal once the roster advances" (`pending-admission`, NACK
      `not-yet-in-sync`, then alice/alice-2 only), "a room broadcast with a fixed list reaches the listed sessions in the room alone, and its
      receipt expects them" (`['carol']`), "a world broadcast reaches the live connections of the authenticated scope of its sender alone"
      (both fanouts; bob's distinct ids `[msgId]`, foreign and the sender alice none; outbox `recipientScope` = room scope), "an all broadcast
      from a client is refused unauthorized and reaches no one", "a room broadcast from a client reaches the other live sessions in the room and
      never its sender" (both fanouts: bob and carol one frame, alice none, receipt expects `['bob', 'carol']`), "a principal broadcast whose principal has no live session in the room reaches no
      one and is answered with one empty admitted receipt" (carol a member without a session: no chat frame anywhere, bob's receipts
      `[['admitted', []]]` after the wait — the empty-audience rule `ws-queue-box-server-receipt-aggregation.ts:140-149`: one `admitted`
      receipt, no aggregate, so nothing to complete or time out). RallarAI: "hands a world result the scope it names, beside targets that name
      none"; through the router: "is delivered to the live connections of the scope it names alone" (`sent-live`, in-scope 1 frame, foreign
      none) and "is refused as a failed publish when it names no scope, and reaches no one" (`worldScope` removed with `Reflect.deleteProperty`;
      `{ status: 'failed', reason: 'A world publication requires the application and workspace scope it reaches' }`).
- [ ] **Step 2: Run red.** The eleven vitest files → 31 failed, 212 passed (6 are the router's echo pins). `cd apps/api-v1 && deno test
      --allow-env --allow-read --allow-write "--allow-run=$(deno eval 'console.log(Deno.execPath())')" test/services/ws-room-authority-delivery.test.ts
      test/services/filter-eligible-live-ws-session-ids.test.ts test/crdt/crdt-websocket-authority.test.ts` fails type checking (the filter
      test's world notice); `--no-check` → 7 failed, 23 passed (the fixed-list case is green on arrival through Task 1's router-delivered plan, R-A1-28; world shows foreign two copies and the
      sender its echo).
- [ ] **Step 3: Implement** as listed. Green: 243 vitest; Deno 30 (delivery 22, filter 6, CRDT authority 2).
- [ ] **Step 4: Verify.** `npx vitest run packages/tests/shared/services packages/tests/shared/alm packages/tests/shared/ws-qos-policy.test.ts
      packages/tests/shared/ws-server-qos-policy.test.ts       packages/tests/shared-server packages/tests/shared/al-contracts packages/tests/shared/multicast packages/tests/shared-web/websocket
      packages/tests/shared-web/messages` (582 files: 578 passed, 4 skipped; 4979 passed, 12 skipped; the four pins inside, unedited); `cd apps/api-v1 && deno test --allow-env --allow-read --allow-write
      "--allow-run=$(deno eval 'console.log(Deno.execPath())')" test/` (612 passed); `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit`; `node
      scripts/check-tests-typecheck.mjs`; `deno check` on the changed `packages/shared`/`shared-server` files; `cd apps/api-v1 && deno task
      check`, then `rm -rf apps/api-v1/node_modules/.deno`; bundle checks with a private `TMPDIR` (`check:browser-bundles` passes,
      `shared-web-browser-bundle-boundaries` and `headless-bundle-boundary` pass: no browser-reached file changes). `npx dprint fmt` on the
      35 files only (pipe the list through `xargs`).
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- eef7fd9b1 HEAD` (PASS), `node scripts/check-test-structure-coupling.mjs
      --changed eef7fd9b1 HEAD` (PASS, all 20 candidates classified); no test file added, so no reachability run.

**True of the code after this task** (for the docs task and review): a client's `all` → `unauthorized`; a principal without a room and a world
on a `room.` topic → `malformed` + NACK `no-route`; principal and list audiences are the room authorizer's narrowed sessions on both modes, an
empty one answered by one empty `admitted` receipt; a world send reaches the sender's authenticated scope, never the sender, on the live send,
forwarding, outbox, cluster bridge and live notice; every world publication names its scope or fails, the RallarAI world result via
`worldScope` and the AI topic via the requester's `authenticatedScope`; a client's room send never returns to its origin session (server and proxy room publications
unchanged); a client's non-room broadcast is still sent twice (forwarding + router, R-A1-7's documented limit). The browser's WS receive
path already dropped its own echo before this task: `WsQueueBoxClientService.acceptIncomingMessage` answers a message whose `senderId` is its
own session `duplicate` without admitting it (`packages/shared/services/ws-queue-box-client-service.ts:450-452`), so the server-side change
saves the wasted frame and egress and gives `room` parity with the RTC multicast; no app-visible delivery changes.

```text
Bind client audiences on the WS server: room-bounded principal and list, scoped world, refused all

A client's WS ingress now refuses an all broadcast as unauthorized, and
a principal broadcast that names no room or a world broadcast on a room
topic as malformed, and compares both the room and the principal a
principal broadcast names with the connection's authenticated scope. A
principal broadcast in a room is authorized as a room send: the room
authorizer narrows its audience to that principal's live sessions in
the room, as it narrows a room broadcast with a fixed list to the listed
sessions in the room, so the receipt, the roster fence and the outbox
row's admitted audience follow unchanged; a principal with no live
session in the room is reached by no one and answered with one empty
admitted receipt, as an empty room audience is. A client's room send
reaches the audience it was admitted to but never its own origin
session, as its receipt already expects and as the RTC multicast
delivers; server and proxy room publications are unchanged. The target
resolver routes both shapes the same way. A world broadcast reaches the scope its
sender proved on every path, never the session that sent it: the live
send and the server's own forwarding filter by the scope, the outbox
row captures it and the cluster bridge hands it on, and the cluster
live notice for a world broadcast carries it, which every receiving
instance and the api-v1 eligibility filter apply; only the server's all
stays unscoped. A world publication that names no scope is refused as
a failed publish, so the RallarAI world result names the scope it
publishes to and the AI topic publishes a requester's world result to
that requester's authenticated scope.

D8 reuse: the room authorizer, the group resolver, filterLiveWsRoomRecipientSessionIds, the proven-scope resolver of a scoped unicast, the scoped-recipient prepared send and the notice's existing scope field carry every new binding; no new resolver or audience type.
```

### Task 4: The audiences lane family and the harness send (D161)

Composed commit: `.superpowers/sdd/a1-plan/final-patch-task-4.patch` (one commit on Task 2; 34 files, +967/−146). Line
anchors are on the design commit `eef7fd9b1` and hold on Task 2's commit (Task 3 replaced three of the lines below in place:
`black-box-rallar-operation-contracts.ts:298`, `decode-black-box-rallar-message-send-input.ts:33`,
`rallar-black-box-command-fields.ts:296` read `'room' | 'world'` there, and this task adds `'principal'`). The prototype ran
on a local stub of Task 3's browser inputs; on the assembled branch Task 3 already
provides `RallarWsSendInput.scope: 'room' | 'world' | 'principal'`, `principalId`, `recipientPeerIds` and the AI
delivery option, so this task touches no `packages/shared-web` file.

**Files**

- Create `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/audiences/principal-delivery.ts`,
  `fixed-list-delivery.ts`, `world-routing.ts`; `packages/tests/shared-test/alm-conformance-audiences.test.ts`.
- Modify (harness send) `rallar-bb-test/rallar-black-box-test-contracts.ts:327`, `schema/rallar-black-box-command-fields.ts:101-121,296,303`,
  `schema.ts:615`, `alm/validate-alm-control-command.ts:95`, `alm/rallar-black-box-alm-command-capabilities.ts:21`,
  `black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts:298-310`,
  `.../messaging/decode-black-box-rallar-message-send-input.ts:27-67,109,129-139,170`,
  `.../messaging/black-box-rallar-delivery-ledger.ts:32,101,120,219,266-281`, `.../messaging/resolve-black-box-rallar-message-peer.ts`
  (whole, 38 lines), `.../messaging/black-box-rallar-delivery-error-message-prefixes.ts:13`.
- Modify (lane) `conformance/alm/alm-conformance-roles.ts:1-15`, `alm-conformance-scenario-definition.ts:25-53,70-93`,
  `create-alm-conformance-recipes.ts:34,73,123,177`, `alm-conformance-message-commands.ts:19,39,80`,
  `alm-conformance-step-identities.ts:6-8`, `alm-conformance-session-commands.ts:20,138`,
  `alm-conformance-receipt-commands.ts:1,14,35-83,92-118`, `scenarios/receipted-audience.ts:1,15,21,158-172`,
  `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts:153-156`,
  `tests/playwright/rallar-black-box/full-stack-three-agent-run.ts` (whole), `full-stack-alm-conformance.spec.ts:53-60,160-191,282-303`.
- Modify tests (the recipes test's topic case becomes `'routes every carrier over one room WS topic the product admits, and the world
  cell over its own app topic'`) `packages/tests/shared-test/{alm-conformance-recipes,alm-conformance-recipe-validation,rallar-bb-test-alm-commands}.test.ts`,
  `rallar-browser-runtime/{delivery,resolve-black-box-rallar-message-peer}.test.ts`, `rallar-browser-runtime/browser-runtime-facade-test-double.ts:502-513`,
  `packages/tests/rallar-black-box/{full-stack-three-agent-run,hetzner-alm-manifest-entries}.test.ts`. No budget
  changes: the headless agent measures 305.807 KiB of the 306 Task 1 set (R-A1-31).
- Modify `scripts/repo-style-check/reviewed-dispositions.mjs`: after the `execute-local-ws-interaction.ts` `boundary.unknown` entry,
  add `// Pre-existing JSON-shaped harness contract; the typed closure is a separate slice.` and
  `Object.freeze({ path: 'packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts', rule: 'boundary.unknown', symbol: undefined })`.

**Interfaces**

- Harness `messages.send`: `scope?: 'room' | 'world' | 'principal'` (Task 3 already removed `all`, D160; this task adds `principal`); `principalId?: string` (doc: "With scope
  `principal`: the principal whose live sessions in the room the send addresses."); `recipientPeer?: 'receiver'` — a fixed audience
  of one by lane role (R-A1-13, accepted: no recipe knows a session id; `messagesToPeer` already says "Roles, not session ids"). Values:
  `messagesScope: ['room', 'world', 'principal']`, `messagesRecipientPeer: ['receiver']`; JSON schema `principalId: stringSchema`,
  `recipientPeer: { type: 'string', enum: …messagesRecipientPeer }`; control validator `validateStringField(command, 'principalId', path)`
  and `validateEnumField({ …, key: 'recipientPeer', allowed: values.messagesRecipientPeer })`; both join `REPLAY_REFUSED_FIELDS`.
- Decoder: `decodeMessagePeerRole` becomes `decodeMessageAudience(record): Either<BlackBoxRallarInputIssue, MessageSendAudience>`
  (`type MessageSendAudience = Pick<BlackBoxRallarMessageSendInput, 'toPeer' | 'principalId' | 'recipientPeer'>`); issues
  `'messages.send.toPeer must be server or receiver.'`, `'messages.send.recipientPeer must be receiver.'`,
  `'messages.send.scope must be room, world, or principal.'`. Operation input gains required-`| undefined` `principalId` and `recipientPeer`.
- Resolver file gains `ResolveBlackBoxRallarRecipientPeerInput { ownSessionId; ownPrincipalId; roomSessions; nowMs }` and
  `resolveBlackBoxRallarRecipientPeer(input): Either<string, string>` — the one other live session whose `principalId !==
  ownPrincipalId`, else `` `the room holds ${n} other live sessions of another principal, not exactly one` ``; the live filter both
  resolvers use is a private `toOtherLiveSessions` (no duplication). Ledger: private `#resolveRecipientPeerIds(send, roomRef)` (own
  principal = `peers.session()?.clientId`) throws `` `${peerUnresolved}: messages.send.recipientPeer receiver names no peer: ${detail}.` ``;
  `toTypedSendOptions(send, { peerId, recipientPeerIds })` also passes `principalId`.
- Roles: `ALM_CONFORMANCE_ROLES` gains `'sibling'` ("a second session of the sender's principal: a browser context and sign-in of its
  own as the sender's user"); `ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES = ['sender', 'receiver', 'sibling']`. Lane family
  `'same-principal'` (exactly when `roles` declares `sibling`). Scenario ids `'fixed-list-delivery' | 'principal-delivery' |
  'world-routing'` (alphabetical). `AlmConformanceScenario.sibling: RallarBlackBoxTestRecipe | undefined`; the three scenarios
  register after `fencedRejection`.
- `alm-conformance-receipt-commands.ts`: `export type AlmConformanceSendAudience = Readonly<{ scope: 'principal'; principalId: string; }>
  | Readonly<{ recipientPeer: … }>`; `toAudienceSendCommands({ sender, ttlMs, audience? })` spreads it into the delivery;
  `toServerReceiptCommands` moves here from `receipted-audience.ts:158-172` verbatim and is exported (D8); the receipt window's
  inline `received-self-1` becomes the exported `toSelfAbsenceCommand(sender)` ("The scenario window spent proving the sender's own
  channel never receives its send.") that the window and world-routing share.
- Topic (amendment to R-A1-18: a `room.` topic stays room-scoped by topic, and Task 2 refuses a world broadcast on one as `malformed`):
  beside `ALM_CONFORMANCE_TOPIC_ID` (`alm-conformance-step-identities.ts:6`), doc "A `room.` topic makes any send room-scoped, so the
  world cell publishes under `app.`." on `export const ALM_CONFORMANCE_WORLD_TOPIC_ID = 'app.alm-conformance.world';`, and
  `export function toScenarioTopicId(step: AlmConformanceStepInput): string` (world topic for `world-routing`, else the room topic);
  `toSendCommand` (`message-commands.ts:80`) and `toConnectCommand` (`session-commands.ts:138`) use it instead of the constant.
- Scenarios (all `FULL_TAGS`, `ALM_CONFORMANCE_CARRIERS`, same-principal roles): principal-delivery = audience send with
  `{ scope: 'principal', principalId: '{auth.clientId}' }` + server receipt wait + `toReceiptWindowCommands(sender, { confirmed:
  ['sibling'], unconfirmed: [] }, 'acknowledged')`, `toReceiptRoles` the same; sibling `toSingleArrivalReceiverCommands`, receiver one
  `received-1` absent. fixed-list-delivery the mirror with `{ recipientPeer: 'receiver' }` and receiver confirmed. world-routing: send
  `delivery: { scope: 'world' }`; ws → admission commands; rtc → `observe-rejected-1` then asserts `refused` (`failure.kind`),
  `unsupported` (`failure.reason`), `rtc-attempt` (`attemptCarriers.0`); rtc-with-ws-fallback → `observe-transport-accepted-1` then
  `one-attempt` (`attempts` = 1), `ws-attempt` (`attemptCarriers.0` = `ws`), `no-fallback` (`carrierFallback` exists `false`);
  recipients single arrival except over rtc (absent); every carrier ends the sender with `toSelfAbsenceCommand` (no echo, ruling on
  R-A1-16). No `all-refused` cell (R-A1-12, accepted).
- Lane run: `ThirdAgentRole = Extract<AlmConformanceRole, 'recipient-b' | 'sibling'>`; `ThreeAgentRun.third`, `RecipeTrio.third`,
  `RecipeTrioOutcome.third` replace `recipientB`; `createThreeAgentRun({ …, thirdRole })` opens user C or user A
  (`openThirdAgent`). Spec: `THIRD_AGENT_ROLES` map, one loop `for (const family of ['three-agent', 'same-principal'] as const)`
  (titles `three-agent family over …` unchanged), `runThreeAgentScenarios(run, carrier, family)` via `toAlmConformanceRoleRecipe`.
- Manifests: the hosted family filter already leaves `same-principal` out; the comment at `hetzner-alm-manifest-entries.ts:153-156`
  says it is withheld as the membership fence cells are. No `HETZNER_WITHHELD_ALM_SCENARIOS` entry (R-A1-14, accepted).

**D8 reuse inspection.** `toAudienceSendCommands`, `toReceiptWindowCommands`, `toServerReceiptCommands` (moved, not copied), the role
identity assessment (`readAlmReceiptRolesEntries`/`assessAlmReceiptRoleIdentity`), `createThreeAgentRun` and its start order, the lane-role
peer resolution and its live filter, `HOSTED_ALM_LANE_FAMILIES`. No new run helper file.

- [ ] **Step 1: Tests (red).** Copy the new test file and the test edits from the patch (titles there). Red against Task 3's tree:
      `npx vitest run packages/tests/shared-test/alm-conformance-audiences.test.ts packages/tests/shared-test/alm-conformance-recipes.test.ts packages/tests/shared-test/alm-conformance-recipe-validation.test.ts packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts packages/tests/shared-test/rallar-browser-runtime/resolve-black-box-rallar-message-peer.test.ts packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts`
      → `Test Files  8 failed (8)`, `Tests  26 failed | 171 passed (197)`.
- [ ] **Step 2: Implement.** Same command plus `alm-conformance-membership-fence.test.ts`, `hetzner-distributed-manifests.test.ts`
      and `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` → `Test Files  11 passed (11)`, `Tests  249 passed (249)`.
      The headless boundary passes at 305.807 KiB of 306.
- [ ] **Step 3: Checks.** `npx dprint fmt <the 34 files>`; `npx tsc -p packages/shared-test/tsconfig.json --noEmit`;
      `cd apps/rallar-black-box && npx tsc --noEmit`; the lane spec through the app's tsconfig (a throwaway `tsconfig.pw-check.json`
      extending `./tsconfig.json` with `include` of the spec and `../../types/**/*.d.ts`; delete it after) → clean;
      `node scripts/check-tests-typecheck.mjs` → PASS; the four storage pins → `Tests  27 passed (27)`;
      `node --import tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check` → `checked 67 Hetzner distributed manifest(s)`.
      After the commit: `node scripts/check-test-structure-coupling.mjs --changed HEAD~1 HEAD` → three PASS lines;
      `npm run check:repo-style:changed -- HEAD~1 HEAD` → `PASS: no new repository style findings`. Without the disposition it reads
      `FAIL: 6 new or worsened`, all on the contracts file's pre-existing file-owned unknowns, which the touched-file rule re-reports on
      any touch (`check-changed-repo-style.mjs:370-388`): lines 70 (`RallarBlackBoxTestRecord`), 306 (`send?`), 307 (`expect?`), 452
      (`send`), 478 (`data`) and the summary "… and 14 additional unknown occurrences for this owner"; all carry `symbol: undefined`,
      so the one entry matches them (`isReviewedDisposition`, `reviewed-dispositions.mjs:909-918`). Closing them is a ~45-file typing
      slice (measured 169 tsc errors in shared-test, 232 in the black-box app). `npx vitest run packages/tests/repo/repo-style-reviewed-dispositions.test.ts packages/tests/repo/repo-code-style-checker-integrity.test.ts`
      → `Tests  21 passed (21)`;
      `npm run check:test-reachability` → `1767 test files, 1761 reached by CI, 6 manual` (one file added).
- [ ] **Step 4: Lane (local).** `RALLAR_BLACK_BOX_ALM_SCOPE=full npm run test:rallar:full-stack:memory:alm -- -g "same-principal family"`
      (the spec filters by `RALLAR_BLACK_BOX_ALM_SCOPE`, `RALLAR_BLACK_BOX_ALM_CARRIERS`, `RALLAR_BLACK_BOX_ALM_SKIP`, spec `:101-110`, and
      by title per family × carrier, `:169`). Binds loopback ports (sandbox: `listen EPERM`); needs Tasks 1–3. Expected: three passing
      cells per carrier; on the composed branch it runs at the close (Task 7 Step 4). Prototype run (ws, on the stub of Task 3, unsandboxed): the sibling signed in and connected as a third live
      session, the receiver resolved by principal; principal-delivery red at the browser validator (`WS scope must be room, world, or
  all`), fixed-list-delivery red (the stub ignores the list: the sibling received, expected count 2), world-routing red (the send was
      queued, neither session received it) — each is Task 1–3 behaviour, not the harness.
- [ ] **Step 5: Commit.**

```text
Prove the room-bounded and world audiences in the conformance lane

The harness messages.send gains scope principal beside room and world
(a client all leaves it), principalId for a principal send, and
recipientPeer, a fixed audience of one named by lane role: the page
resolves receiver to the one other live session of the room whose
principal is not the sender's and hands the typed channel that list as
recipientPeerIds; a role no one session answers fails the send before a
handle opens. The schema, the control validator and the capability text
follow.

A new role, sibling, signs the sender's user in a second time on an
agent of its own, and a same-principal lane family runs it beside the
sender and the receiver: the three-agent run takes its third agent's
role, so the lane opens recipient-b as user C or the sibling as user A
with one helper. Its audiences family runs on every carrier:
principal-delivery (the sibling receives once, the receiver never, the
receipt expects the sibling alone), fixed-list-delivery (the listed
receiver receives once, the sibling never, the receipt expects the
receiver alone) and world-routing, which publishes on an app topic of
its own, app.alm-conformance.world, because a room topic makes any send
room-scoped (ws delivers to both other sessions; rtc ends rejected,
refused unsupported on its rtc attempt, and nobody receives;
rtc-with-ws-fallback sends on one ws attempt with no hand-over; on every
carrier the sender's own channel never receives it). The receipt pins
join to sessions through the role identity assessment. The server
receipt wait and the sender's self-absence window move beside the
audience send so both families share them. No hosted entry carries the same-principal
family, so manifests 18 and 22 stay byte-identical.

The headless agent measures 305.807 KiB, within its 306 KiB budget.

The harness contracts file carries pre-existing JSON-shaped unknown
fields that the touched-file style rule reports whenever the file
changes; a reviewed disposition records them, since typing that
contract is a separate slice.

D8 reuse: toAudienceSendCommands, the receipt window, toServerReceiptCommands, the self-absence window and the role identity assessment, the three-agent run and its recipient start order, the lane-role peer resolution and its live-session filter, the hosted lane family filter.
```

### Task 5: Relic's AI suggestions on a principal audience (D162)

Composed commit: `.superpowers/sdd/a1-plan/final-patch-task-5.patch` (one commit on Task 4; 6 files, +44/−59). Line anchors are on the design commit `eef7fd9b1`.
It needs Task 3's `broadcastJson` input `scope?: 'room' | 'principal'` and `principalId?` (the prototype ran on a local stub of it).

**Where the hook learns the principal.** The hook's `localPlayerId` is the auth session id (`App.tsx:145`,
`localPlayerId: game.session?.sessionId`); `game.session` is the `AuthSession` (`useRelicHunters.ts:29`), whose `clientId` is the
principal id the server stamps on every presence session (`group-mutation-authority.ts:334`, `principalId: session.clientId`). The App
passes it as a new hook input; the hook does not read the facade singleton for it.

**Product change (coordinator rulings).** AI proposals become private to the asking hunter's sessions. "Party Notes", the read-only
rendering of other hunters' proposals (`App.tsx:2098, 2133-2147`, `styles.css:1364-1368`, described at `docs/ui-gameplay.md:39-41`
and `docs/runtime-data-flow.md:245-250`), is **replaced, not merely deleted**: the panel's one suggestion card — the place the local
proposal renders, one owner — shows the hunter's newest proposal, whichever of the hunter's sessions asked for it; one received from
another session of the same principal renders there read-only, without Prime. The browser case that injected another hunter's
proposal (`relic-web-app.browser.test.ts:489-518`) becomes a case that injects a proposal from a sibling session of the same
principal and pins it in that card. The hook's receive path (`useRelicPlanningAi.ts:159-176`) is unchanged.

**Files**

- Modify `apps/relic-hunters-v1/src/game/ai/useRelicPlanningAi.ts:1-10,34,57-60,186,267,277,289,380-382`, `apps/relic-hunters-v1/src/App.tsx:145,2098,2133-2147`,
  `apps/relic-hunters-v1/src/styles.css:1364-1369`, `apps/relic-hunters-v1/docs/ui-gameplay.md:39-41`,
  `apps/relic-hunters-v1/docs/runtime-data-flow.md:245-250`, `packages/tests/relic-hunters/relic-web-app.browser.test.ts:420-438,489-518`.

**Interfaces**

- `UseRelicPlanningAiInput` gains, after `localPlayerId?: string;`, `/** The signed-in hunter's principal: a suggestion reaches that
  principal's sessions in the room only. */ localPrincipalId?: string;` (optional like its neighbours: absent before sign-in). The
  destructuring takes it; the `ask` guard (`:186`) adds `|| !localPrincipalId` (status `disabled`); the `broadcastJson` call (`:264-270`)
  adds `scope: 'principal', principalId: localPrincipalId` after `roomId: currentRoomId,`; the `useCallback` deps add `localPrincipalId`
  after `localPlayerId`. The receive filter is unchanged. The touched file trips the changed-style gate on `toErrorMessage(error:
  unknown)` (`:380-382`, `boundary.unknown`): delete it and write `setError(toError(err).message)` (`:277`) with
  `import { toError } from '@shared/resilience/to-error.ts';` (as `useRelicHunters.ts:11` does; dprint places the import).
- `App.tsx:143-150`: `localPrincipalId: game.session?.clientId,` after `localPlayerId`. `RelicAiCompanionPanel` (`:2097-2131`): `localSuggestion`/`remoteProposals`
  give way to `const proposal = state.proposals[0] ?? state.localProposal; const suggestion = proposal?.result.value; const canPrime =
  state.status === 'ready' && proposal?.local === true && !!suggestion?.action;` (`proposals` is newest-first,
  `relic-planning-ai.ts:504`, and holds the local proposal too); the card renders `proposal`/`suggestion`; the
  `{remoteProposals.length > 0 && (…)}` block goes; delete `.relic-ai-party-notes` from `styles.css`.
- Docs: `ui-gameplay.md` — "The suggestion is sent to the hunter's own sessions in the room only; other hunters never receive it."
  plus "The panel shows the hunter's newest suggestion in one card: one asked on another of the hunter's sessions replaces it there,
  read-only, without Prime." replace "Shared AI proposals from other browsers appear as read-only party notes."; `runtime-data-flow.md` — "…are sent over Rallar WS on
  `room.relic.ai.planning` / `relic.ai.planning-proposal.v1` as a principal broadcast in the room: only the asking hunter's own sessions
  in the room receive it, and other hunters never do. The panel's one suggestion card shows the hunter's newest proposal, whichever of
  the hunter's sessions asked for it." replaces the broadcast and party-notes sentences.

**D8 reuse inspection.** `broadcastJson`'s principal scope (Task 3) and through it the room channel's principal broadcast; the game
session's `clientId`; the existing `addRelicPlanningAiProposal` acceptance and its pin. No new subscription, no new filter.

- [ ] **Step 1: Tests (red).** In `relic-web-app.browser.test.ts`, rename `:420` to `'asks the browser AI companion for a legal planning
  suggestion and sends it to the hunter\'s own sessions in the room'` and add `scope: 'principal', principalId: 'client-1'` to its
      `expect.objectContaining` (the fixture session's `clientId`, `:655`). Replace the case at `:489-518` by `'renders a proposal from
  another of the hunter\'s own sessions where the local suggestion renders, read-only'`: one player, ask, wait for one
      `.relic-ai-card.local`; inject through `rallarMock.wsAiMessageHandler` (kept) `{ payload: { ...sent.payload, generationId:
  'sibling-generation-1', dedupeKey: 'sibling-dedupe-1' }, senderId: 'alice-tablet-session', roomId: 'room-1', receivedAtEpochMs:
  Date.now() + 1_000 }`; then no `.relic-ai-card.local`, exactly one `.relic-ai-card`, its `.relic-ai-card-head` contains `alice-ta`
      (the label's `shortId`), no `.relic-ai-prime`, no `Party Notes`. Run `npx vitest run packages/tests/relic-hunters/relic-web-app.browser.test.ts`
      → `Tests  2 failed | 12 passed (14)` (the send pin, and the sibling card: the card stays the local one).
- [ ] **Step 2: Implement** the hook, App, stylesheet and docs. Same command → `Tests  14 passed (14)`.
- [ ] **Step 3: Checks.** `npx vitest run packages/tests/relic-hunters apps/relic-hunters-v1/tests packages/tests/shared-web/shared-web-app-import-boundaries.test.ts`
      → `Test Files  34 passed (34)`, `Tests  205 passed (205)`; `cd apps/relic-hunters-v1 && npm run typecheck` (`tsc --noEmit`) → clean;
      `node scripts/check-tests-typecheck.mjs` → PASS; `npx dprint fmt <the 6 files>`; after the commit
      `node scripts/check-test-structure-coupling.mjs --changed HEAD~1 HEAD` → three PASS lines; `npm run check:repo-style:changed -- HEAD~1 HEAD`
      → `PASS: no new repository style findings` (FAIL on `toErrorMessage` until it is gone).
- [ ] **Step 4: Commit.**

```text
Send Relic's AI suggestions to the asking hunter's own sessions

A planning suggestion was a room broadcast every hunter's browser
received. It becomes a principal broadcast in the room over WS
(scope principal, principalId the signed-in hunter's client id, passed
to the hook as localPrincipalId beside localPlayerId): the server
delivers it to the asking hunter's live sessions in the room and to
nobody else. The hook asks for nothing without a principal, and its error message
comes from the shared toError.

This is a product change: AI proposals are private to the asking
hunter. The companion panel's "Party Notes", the read-only rendering of
other hunters' proposals, is replaced by one suggestion card that shows
the hunter's newest proposal, whichever of the hunter's sessions asked
for it: one received from another of the hunter's sessions renders
there, read-only, without Prime. The Party Notes block, its stylesheet
rule and the browser test that injected another hunter's proposal go;
the browser test now injects a proposal from a sibling session of the
same principal and pins it in that card. The UI and data-flow documents
say the suggestion reaches the hunter's own sessions only and where it
shows.

D8 reuse: broadcastJson's principal scope and the room channel's principal broadcast, the game session's client id, the existing proposal acceptance and suggestion card, the shared toError.
```

### Task 6: Docs — audiences with carrier parity (D156–D163)

Composed commit: `.superpowers/sdd/a1-plan/final-patch-task-6.patch` (one commit on Task 5; 7 files, +199/−37, docs
only). It is the exact text: apply it with `git am -3` after Task 5; if a hunk no longer applies, replay that hunk by its
text anchor below. The writer's prototype also edited the two Relic docs; composition keeps Task 5's wording there
(R-A1-29) and makes five sentences true of the composed code (R-A1-30), all included in the composed patch. Then run the
"true of the code" checks, which are the only part that can fail. A mismatch is fixed in the doc, never in the code.

**Files (text anchors; line numbers are at `eef7fd9b1`)**

- Modify `docs/rallar-api-reference.md`:
  - `### WS And RTC Messages`, the channel paragraph (`:674-676`): "A WS send with scope `world` or `all`, and a
    `best-effort` send, ask for no receipt unless the send states `ack`." becomes "A `world` send and a `best-effort`
    send ask for no receipt unless the send states `ack`; a `world` send that states `receiver` or
    `all-logical-recipients` is refused `unsupported`, since `world` names no logical audience (see Message Audiences
    below)."
  - New `### Message Audiences` before `### Ordering, Repair And Resynchronization` (`:838`): an intro (room, principal
    and fixed list are room audiences resolved from the room's live sessions at the sender's snapshot minus
    `exceptPeerIds`; world and all name no room; D156); the audiences table (columns Audience / Who receives it / Send
    input / RTC / WS / Receipts; rows room, principal, fixed list, world, all); the input paragraph (`principalId`,
    `recipientPeerIds` on `messages.rtc.send`, `messages.ws.send` and a room channel's options; WS `scope` is `'room'`,
    `'world'` or `'principal'`; the validator rules and the message "WS scope must be room, world, or principal.");
    the narrowing paragraph (empty audience, silent drop, room fence, RTC freeze, WS room audience, receiver
    enforcement; D159); the strategy table (rows room/principal/list and world × `ws`, `rtc`, `rtc-with-ws-fallback`,
    `ws-then-rtc`; D157); the carrier-unsupported paragraph (refusal `unsupported`, no new state; the hand-over keeps
    the audience, D80: "once the RTC origin has frozen it, WS carries the frozen multicast verbatim; handed over before
    its freeze, it goes as the principal broadcast naming its room or the listed room broadcast it was sent as", R-A1-24);
    the scope-binding paragraph (world bound to the sender's scope on every instance via the scoped cluster notice,
    principal must name its room's `groupRef`, a client `all` refused `unauthorized` at ingress "and reaches no one", "No
    client room, principal, list or `world` send returns to the session that sent it." (R-A1-16, R-A1-19); `all` is not
    a browser input; D100, D158); a `ts` example (`messages.room<PartyNote>`
    `send` with `{ principalId }` and with `{ recipientPeerIds }`, `messages.ws.send` with `scope: 'world'` on
    `app.news`); the `ai.broadcastJson` paragraph (`scope: 'room' | 'principal'`, default `'room'`, `principalId`
    required with principal).
  - `### Membership Fencing` first paragraph (`:979-985`): "an RTC multicast, a WS room broadcast, and the room
    broadcast a fallback send becomes" → "an RTC multicast, a WS room or principal broadcast that names its room, and
    the broadcast a fallback send becomes"; the paragraph is rewrapped, not reworded.
  - `### Target Resolver` bullet (`:1880`): the room route narrowed to the principal's sessions (principal broadcast
    naming its room) and to the listed sessions (room broadcast with `recipientPeerIds`); a client's `world` reaches
    only the sender's authenticated scope.
- Modify `packages/shared/alm/inbound/README.md`, before "A commit announces the work it wrote" (`:464`): a
  `**Room-bounded audiences.**` paragraph (the RTC freeze of the narrowed audience; the planner's `recipientPeerIds`
  rule in `al-policy.ts`; relay children narrowed by `resolveALOwnedChildPeerIds`; a listed room broadcast delivered
  only at listed sessions over WS as over RTC; "a WS server whose router owns the room fanout hands a listed broadcast
  that leaves it out to its router, as it hands a room unicast to another session" (R-A1-28); D156, D159).
- Modify `packages/shared/alm/outbound/README.md`, `### The frozen audience`:
  - a new bullet before `- **The RTC room limit (R-S2c-ii-13).**` (`:480`): `computeFrozenAudience` with
    `RtcAudienceNarrowing` (`{ kind: 'principal', principalId }`, `{ kind: 'list', recipientPeerIds }`) in the origin
    freeze (`toRtcOriginFrozenMessage`) and the carrier-gap path; silent drop; RTC refuses world/all
    `refused/unsupported` (D157, D159, D160);
  - the WS-server bullet (`:487`) gains the narrowed room audience (principal by `activeSessions[].principalId`, list
    by `recipientPeerIds`), receipts and repair over it, the room fence (D143, D159); the rest of the bullet is
    rewrapped, not reworded;
  - the `unauthorized` refusal list (`:577`) gains "a client's `all` broadcast (D158)";
  - after "...returns `failed` (D103)." (`:590`): the scope-binding paragraph (world row keeps `recipientScope`, scoped
    cluster notice, unscoped `all` notice, principal scoped by its `groupRef`, client `all` refused; D158).
- Modify `playground/alm/alm-complete-product-description.md`:
  - `### Broadcast`: the `**PARTIAL:**` paragraph (`:290-291`) and the `**PLANNED — A1, general scope semantics:**`
    paragraph are replaced by one `**CURRENT — A1, audiences with carrier parity:**` paragraph (D156–D161, D163); its
    lane sentence reads "The conformance lane's `same-principal` family, which signs the sender's principal in on a
    second agent, runs `principal-delivery`, `fixed-list-delivery` and `world-routing` over `ws`, `rtc` and
    `rtc-with-ws-fallback`; a client's `all` is no browser input, so its refusal is pinned at the server, the RTC origin
    and the browser validator rather than in a lane cell; manifests 18 and 22 are unchanged (D161)." (R-A1-12).
  - QoS (`:377`): "so it keeps `ack: 'none'` until A1." → "so it keeps `ack: 'none'`; a principal or listed room
    broadcast has its narrowed room audience (D159)."
  - Public surface (`:920-925`): the marker becomes `**PLANNED — I1, I2a, and I2b, complete safe surface:**`, the A1
    bullet goes, and a sentence names `newALPrincipalBroadcastMessage`, `recipientPeerIds` on `newALBroadcastMessage`
    and the browser inputs; "Four parts" → "Three parts".
  - Relic paragraph, after "(D155)." (`:965`): `**CURRENT — A1, AI suggestions on a principal audience:**` (D162) and
    the carried private events (D163); the paragraph's last lines are rewrapped.
- Modify `playground/alm/alm-improvement-plan.md`, the row starting `| 6 A1, A2 |` (`:1266`), Relic column only: "AI
  suggestions addressed to the asking hunter's sessions (A1); per-player private events (A2)." Match by prefix; no
  status prose; never a blank line inside the table.
- Modify `playground/alm/alm-static-audit.md` F16 (`:417-419`): the audience sentence moves to the past tense and gains
  the since-A1 clause (D156–D159); the finding body otherwise stays.
- Modify `docs/rallar-ai-recipes.md` (`:108-119`): the Relic `broadcastJson` sample gains `scope: 'principal'` and
  `principalId`, and the paragraph after it states the principal scope and that Relic addresses the asker's sessions.
- Do not modify `apps/relic-hunters-v1/docs/runtime-data-flow.md` or `ui-gameplay.md`: Task 5 already states where the
  suggestion goes and where it shows (R-A1-29).

**True of the code (check each against Tasks 1–5 before committing)**

- Task 1: `git grep -n "export function newALPrincipalBroadcastMessage\|recipientPeerIds" packages/shared/al-contracts/al-contract.ts`
  shows the builder and the `recipientPeerIds` option; `isLogicalRecipient` in `al-policy.ts` reads a broadcast's
  `recipientPeerIds`; `resolveALOwnedChildPeerIds` narrows children by it; `RtcAudienceNarrowing` has exactly the kinds
  `principal { principalId }` and `list { recipientPeerIds }`; `computeFrozenAudience` takes it and both
  `toRtcOriginFrozenMessage` and `compute-rtc-outbound-carrier-availability.ts` pass it; Task 1's manager pin refuses
  a world/all broadcast `unsupported`; `validateALAckSupport` admits `receiver` for a principal broadcast with
  `groupRef` and a listed room broadcast and still refuses it for `world`; `ws-queue-box-server-inbound-plan.ts`'s
  `isAddressedPastServer` hands a listed room broadcast that leaves the server out to the router.
- Task 3: the WS input's `scope` union is `'room' | 'world' | 'principal'` and both inputs carry `principalId?` and
  `recipientPeerIds?` (the API snapshot shows them on the room channel's options); the validator message is exactly
  "WS scope must be room, world, or principal."; a principal or list send without a room yields `missing-room`; the
  list rules (non-empty, unique, ≤ 256) and the mutual exclusion return all issues; `sendRoomWithFallback` sends a
  world send on `rtc-with-ws-fallback` and `ws-then-rtc` to WS with no `carrierFallback` evidence and on `rtc` ends
  `rejected` with refusal `unsupported`; `toRoomFallbackMessage` turns the unfrozen room multicast of a principal send
  into the principal broadcast naming its room and of a list send into the room broadcast with the sender's list,
  which the RTC leg freezes into a narrowed multicast that a later WS hand-over carries verbatim; the principal WS envelope carries `minSnapshotVersion` and
  `rosterVersion`; `broadcastJson` takes `scope` (default `'room'`) and `principalId`. The `ts` example's room-channel
  `send(payload, { principalId })` and `{ recipientPeerIds }` typecheck against the typed options.
- Task 2: a client world row stores `recipientScope`; the live world notice carries the scope and `all` stays
  unscoped; a principal broadcast without `groupRef` is refused (whatever reason Task 2 chose; the doc names none);
  `roomAudience` is narrowed by principal and by list; a client `all` is refused `unauthorized` at ingress; the
  target resolver narrows principal and list as the Target Resolver bullet states; neither a client's room send nor
  its world broadcast reaches the session that sent it.
- Task 4: the `same-principal` lane family runs the `scenarios/audiences/` cells `principal-delivery`,
  `fixed-list-delivery` and `world-routing` over `ws`, `rtc` and `rtc-with-ws-fallback`; there is no `all-refused`
  cell (R-A1-12), and the product description's lane sentence says so.
- Task 5: `useRelicPlanningAi.ts` calls `broadcastJson` with `transport: 'messages.ws'`, `scope: 'principal'` and a
  `principalId`; the receive filter is unchanged.

- [ ] **Step 1: Apply** the patch (or replay the hunks above). **Step 2: True-of-code checks** above.
- [ ] **Step 3: Format** `npx dprint fmt docs/rallar-api-reference.md docs/rallar-ai-recipes.md packages/shared/alm/inbound/README.md packages/shared/alm/outbound/README.md playground/alm/alm-complete-product-description.md playground/alm/alm-improvement-plan.md playground/alm/alm-static-audit.md`
      (explicit files only), then `npx dprint check` on the same seven → clean (exit 0). The roadmap row fits its column,
      so no other row re-pads.
- [ ] **Step 4: Checks.** `npx vitest run packages/tests/repo packages/tests/shared-web/rallar-group-public-contracts.test.ts`
      → `Test Files  92 passed (92)`, `Tests  1230 passed (1230)` on the composed branch (more if Tasks 1–5 add repo tests;
      `rallar-group-documentation.test.ts` resolves every backticked file citation); `cd apps/api-v1 && deno test
      --allow-all test/swagger-routes.test.ts` → `14 passed | 0 failed`, then `rm -rf apps/api-v1/node_modules/.deno`;
      after the commit `npm run check:repo-style:changed -- eef7fd9b1 HEAD` (PASS: no new findings) and
      `node scripts/check-test-structure-coupling.mjs --changed eef7fd9b1 HEAD` (PASS, all 20 candidates classified).
- [ ] **Step 5: Commit.**

```text
Document audiences with carrier parity

The API reference gains a Message Audiences section: what room,
principal, a fixed list, world and all reach, the send input each takes,
how RTC and WS carry it and which receipts it supports; the validator
rules for principalId and recipientPeerIds; the narrowing of a principal
or list audience and its room fence; the routed decision per strategy,
with a world send on rtc refused unsupported and on the fallback
strategies taken by WS at once; the WS server's scope binding and its
refusal of a client's all; and the AI delivery's principal scope. The
membership-fencing and target-resolver paragraphs name the principal and
listed broadcasts. The inbound README states the planner's
recipientPeerIds rule, the outbound README the frozen-audience
narrowing, the WS server's narrowed room audience and the world scope
binding with its scoped cluster notice. The product description's
Broadcast section records A1 as current, its Relic paragraph the AI
suggestions on a principal audience; the roadmap's consumer row, the
audit's F16 audience line and the RallarAI recipe follow.

D8 reuse: the existing messaging, frozen-audience, scope and consumer prose of each document, extended in place; one new section heading beside Membership Fencing.
```

### Task 7: Close

Pins unchanged and bundles measured; the static merge bar; `npm run test:postgres:integration` (the outbound
store, the WS server and its cluster notice changed); the conformance lane for the `same-principal` family over
three carriers; the three-seat final review BEFORE one fix wave; push; the Branch Release Gate green on the code
head; hosted manifests 18 and 22 dispatched from the branch; the PR body; the close commit with the delivered lines;
this plan file deleted.

- [ ] **Step 1: Pins and bundles.** `npx vitest run` the four pins (`al-indexeddb-transaction-ledger`,
      `al-indexeddb-operation-counts`, `al-storage-snapshot`, `al-indexeddb-empty-audience-counts` under
      `packages/tests/shared/alm/`) → `Tests  27 passed (27)`, no pin file in `git diff --stat origin/main HEAD`.
      Bundles with a private `TMPDIR`: `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
      (`browser/rallar.ts` 240.6 of 241 at composition) and `headless-bundle-boundary.test.ts` (305.807 KiB of 306 at
      composition); a crossed budget rises to the next whole KiB, named in the PR body.
- [ ] **Step 2: Static merge bar.** `npm run typecheck`; `npm run build`; `npm run check:repo-style:changed --
      origin/main HEAD` (read the verdict line) and `node scripts/check-test-structure-coupling.mjs --changed
      origin/main HEAD`; `npm run check:test-reachability`; `git diff --name-only origin/main HEAD | xargs npx dprint
      check`; `node --import tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check` →
      `checked 67 Hetzner distributed manifest(s)` and `git diff --stat origin/main HEAD --
      apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json
      apps/rallar-black-box/manifests/hetzner/22-alm-conformance-3-agent.json` empty; `cd apps/api-v1 && deno task
      check && deno test --allow-all test/` then `rm -rf apps/api-v1/node_modules/.deno`.
- [ ] **Step 3: Postgres integration.** With the test Postgres up (`npm run db:test:up`; `docker ps` first), run
      `npm run test:postgres:integration` unsandboxed; name every red from its output.
- [ ] **Step 4: The conformance lane, unsandboxed on private ports.** `VITE_RALLAR_API_BASE_URL=http://localhost:18480
      VITE_RALLAR_SPA_BASE_URL=http://localhost:5480 RALLAR_BLACK_BOX_CONTROL_BASE_URL=http://127.0.0.1:5481
      RALLAR_BLACK_BOX_ALM_SCOPE=full npm run test:rallar:full-stack:memory:alm -- -g "same-principal family"` (all
      three carriers; `RALLAR_BLACK_BOX_ALM_CARRIERS=ws|rtc|rtc-with-ws-fallback` runs one; `lsof -i :18480 -i :5480 -i
      :5481` first, so no other session's server is reused). Expected: `same-principal family over ws (full)`, `… over
      rtc (full)` and `… over rtc-with-ws-fallback (full)` pass, three cells each. Then run `-g "three-agent family over
      ws"` once on the same tree and compare the count of "Rejected RTC message malformed" console warnings between the
      two runs; the PR body classifies them as pre-existing or as A1's.
- [ ] **Step 5: Final review, then one fix wave.** Three seats (product: the audiences, the routed decision and the
      Relic change against D156–D163; harness: the lane family, the sibling role, the manifests; code quality: the
      code standard, D3, D8, the reviewed disposition) review the branch head before any fix; the controller rules on
      every finding and applies one fix wave; any fix reruns its task's checks and Steps 1–2.
- [ ] **Step 6: Push and gates.** Push the branch; the Branch Release Gate (`gh run list --branch <branch>`) and the
      API-v1 black-box gates (including `test:api-v1:black-box:postgres:medium-scale`) green on the code head; rerun a
      known flake once with `--failed` before diagnosing it.
- [ ] **Step 7: Hosted manifests 18 and 22 from the branch.** `gh workflow run hetzner-distributed-recipe.yml --ref
      <branch> -f ref=<branch> -f rollout_before_run=true -f
      manifest_path=apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json`, and the same with
      `22-alm-conformance-3-agent.json`; both are regression reads (A1 adds no hosted cell); diagnose a red from its
      artifacts.
- [ ] **Step 8: PR body.** Goal; Changes per task; Public surface (`RallarMessageScope`, `principalId` and
      `recipientPeerIds` on both inputs and the room channel, `'all'` gone from the browser input, the WS room-less
      default `world`, `broadcastJson`'s `scope`/`principalId`, `newALPrincipalBroadcastMessage`, the
      `recipientPeerIds` builder option, the AI generic defaults of R-A1-27, the server AI publisher's `worldScope`);
      Acceptance; Validation with every red named; Rulings R-A1-1 to R-A1-32 and any the review adds; Corrections (the
      held durable room multicast sent unfrozen on `main`, fixed; the CRDT room-less sends that took the current room;
      the Party Notes removal; the room send's own-session echo removed; the router-delivered listed broadcast); Limits
      (this plan's list); Risk and rollback; Follow-ups (the typed closure of the harness contracts, the double
      delivery of a client's non-room broadcast, the server-only principal broadcast without a room, a relayed
      `broadcast/principal` on RTC, A2's server-originated private events). End the body with the Claude Code
      attribution line.
- [ ] **Step 9: The close commit.** In `playground/alm/alm-improvement-plan.md`: the consumer row `| 6 A1, A2 |`
      (Relic column) reads "AI suggestions addressed to the asking hunter's sessions (A1). Delivered (A1, `<head>`;
      #<pr>). Per-player private events (A2)."; the "Releases 4 to 8" map row `| 6 A1    |` gains "Delivered (A1,
      `<head>`; #<pr>)." at the end of its exit-evidence column; the fresh-session paragraph records A1 as delivered
      (#<pr> as `<head>`, from `alm-a1-design-proposal.md`, D156–D163; its plan file deleted with the close) and names
      A2 as the next slice; the revision history gains an entry "<merge date> (A1 delivered): #<pr> as `<head>`; the release map row, the
      consumer row, the PC7 row and the fresh-session paragraph record it; A2 is next."; the requirement matrix's
      `| PC7 supported target and ACK semantics |` row reads "Partial: one meaning per audience over both carriers
      (A1, #<pr>); ACK semantics remain." owned by A2. In `playground/alm/alm-static-audit.md` the status table's
      `| F16 |` line drops "Audiences" and A1 from its remainder. Delete this plan file in the same commit. Never a
      blank line inside a table; `npx dprint fmt` the two files.
