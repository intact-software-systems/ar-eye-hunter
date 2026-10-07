# ALM A2b: exclusive ownership as a claim on the resource key — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven development with test-driven development:
> one implementer per task, the failing tests first, the controller reviews and commits, one commit
> per task, a three-seat final review with one fix wave before the close. Steps use checkbox
> (`- [ ]`) syntax for tracking. The tasks run in the order 1 → 2 → 3 → 4 → 5 → 6 → 7.

**Goal:** Deliver Release 6, A2b (D171 to D178, `playground/alm/alm-a2b-design-proposal.md`). An
`ownership: 'exclusive'` send a WS client puts into a room claims the room-scoped resource key (the room's
`GroupRef` scope with the route `topicId`, `contextId` and `resourceId`) for the sending session. The first
claimant is admitted and delivered; another session's exclusive send on a live claim is dropped
`held-by-other` and NACKed, which its handle reads as a trusted-server `relay-rejected`; the holder's re-send
moves the claim's expiry; the claim lapses with its message. Exclusive is WS-only: the browser routes it over
WS under every strategy but `rtc`, the RTC origin refuses it `unsupported`, and the validator refuses an
exclusive send that names no resource or no room. The director relay and the game match carry a claim, and
AR Eye Hunter's pickup intents claim the pickup and show the loss. The `claim` lane family proves one
winner, the reclaim after expiry and the RTC refusal; the docs state exclusive ownership.

**Architecture:** The planner's `ALMessagePlanningObservations` gains `claimHolderPeerId`, and
`resolveMessageDrop` drops an exclusive message on another session's live claim right after the duplicate
check, with the new drop code and NACK reason `held-by-other`. The inbound admission store derives the claim
key privately for a `ws-client` admission of an exclusive room message, reads the claim row
`${namespace}:claim:<key>` beside the dedup key as a guarded observation of the commit (value: the holder's
peer id; liveness: the row's own expiry), and an admitted exclusive message writes the `set-claim` mutation
expiring at the message's deadline in the one admission transaction. The NACK leaves through the existing
`send-nack` effect; the WS origin settles it as the trusted-server relay rejection `held-by-other` before any
receipt row. The RTC origin refuses an effective-exclusive send `unsupported` in its own refusal chain
(`compute-rtc-exclusive-refusal.ts`). The browser's `isExclusiveSendInput` (the planner's precedence:
`qos.ownership` wins) drives the WS route and the validator's `validateExclusiveClaim`. The relay's public
`RallarDirectorRelayClaim { resourceId }` threads from `match.sendIntent(intent, claim?)` to the relay
transport's send options, and `held-by-other` becomes a relay and game send status.

**Tech Stack:** TypeScript on Node (Vitest, Playwright, esbuild bundle budgets) and Deno (api-v1, the
control server: `deno test`, `deno check`); dprint.

**Spec:** `playground/alm/alm-a2b-design-proposal.md`; decisions D171–D178 in
`playground/alm/alm-improvement-plan.md`; surveys `.superpowers/sdd/a2b-survey/{facts-server,facts-consumers}.md`.

## Global constraints

- **The maintainer's notes stand: "No legacy, avoid duplication, no migration code, keep the repo
  consistent, prefer existing patterns."** No wire or schema bump: `ALDelivery.ownership`, `route.resourceId`
  and the control frames keep their fields; `exclusive` was already on the wire.
- **The claim and its lease (D171, D172):** an `exclusive` send a WS client puts into a room claims the
  room-scoped resource key (the room's `GroupRef` scope: application, workspace and group, with the route
  `topicId`, `contextId` and `resourceId`) for the sending session. The first claimant is admitted and
  delivered; another session's exclusive send on a live claim is dropped `held-by-other` and NACKed; the
  holder's re-send is admitted and moves the expiry; `shared` sends are untouched. The claim's lease is the
  message's lifetime (its deadline, `constraints.expiresAtMs` or the admission's own deadline): no lease
  constant, no renewal call; an expired claim frees the key for the next claimant; an unconfirmed claimed
  message ends `expired`.
- **The admission-store claim and the drop (D173):** the claim is an admission-store key family read beside
  dedup (`${namespace}:claim:<app>/<workspace>/<group>/<topic>/<context>/<resource>`, each part URI-encoded),
  carried as the planning observation `claimHolderPeerId`, decided in `resolveMessageDrop` as the drop code
  `held-by-other` with a NACK of the same reason, and written as the `set-claim` mutation in the one admission
  transaction; it is read and written only for a `ws-client` admission source, so browser stores never read
  one; "ResourceInbox-backed" is corrected to the admission store's insert-if-absent-with-expiry.
- **WS-only and the validator issues (D174):** an exclusive send takes the WS route under every strategy but
  `rtc` (no RTC leg, no `carrierFallback` evidence); the RTC origin refuses it `refused/unsupported`; the
  browser validator refuses `exclusive-requires-resource` (no `resourceId`) and
  `exclusive-requires-room-audience` (`scope: 'world'`) on `$.ownership`. Exclusive is decided on the effective
  ownership everywhere: a `qos.ownership` request wins over the `ownership` option.
- **The surfacing (D175):** `claimed` is the admission (no claim event); `held-by-other` is a trusted-server
  `relay-rejected` reason before any receipt row (a receipt-bearing send ends `rejected` at
  `failure.rejection.reason`, a receipt-less one carries it in `evidence.relayRejection`), an authority
  refusal that asks for no repair, and not a fallback trigger (`AL_DELIVERY_FALLBACK_REFUSAL_REASONS` stays
  `['unsupported']`); `expired` is the existing lifetime failure; no release call.
- **D3:** no compatibility window. A changed contract changes everywhere in the same task; no `?:` added
  "for now" (the relay's public `claim?` is optional because absence means a shared intent; the internal
  `SendCommandInput.claim` is required, `| undefined`).
- **D8 reuse first.** Search `packages/**` for an existing pattern before writing one; delete what becomes
  unused in the same task; no raw Maps where `packages/shared/cache` repositories fit. Every task carries a
  D8 reuse inspection paragraph and its commit one `D8 reuse:` line.
- **No ids in code, tests or docs:** no plan, task, PR or ruling id in code or tests; decision ids (D171 …)
  only in docs.
- **No guarantee weakens.** The four pins (`al-indexeddb-transaction-ledger`,
  `al-indexeddb-operation-counts`, `al-storage-snapshot`, `al-indexeddb-empty-audience-counts`) stay
  unedited; hosted manifests 18 and 22 stay byte-identical (the `claim` cells withheld through
  `HETZNER_WITHHELD_ALM_SCENARIOS`).
- **Convergent-service rules** (`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`)
  bind the admission transaction: read → compute → validate → write in one transaction; the claim is a guarded
  observation, so two claimants that read a free key conflict and the loser is re-planned; the drop is a value.
- **Code standard** (`.agents/skills/rallar-code-writing/references/repo-code-style.md`): canonical verbs;
  functions ≤40 lines; ≤3 positional parameters for a new function; `interface` for object contracts;
  required fields by default; `Either` for expected failure; kebab-case filenames after the primary export;
  no role folders; no narration comments; one canonical name per type. Tests live under `packages/tests/**`
  mirroring the source; Deno app tests under `apps/<app>/test/`.
- **Formatting:** `npx dprint fmt <explicit file list>` on touched files only (pipe a list through `xargs`;
  zsh does not split `$(...)`).
- **Per-task checks:** the focused Vitest files; `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json
  --noEmit`; `deno check` from the repo root on every changed `packages/shared/**`, `packages/shared-server/**`
  and `packages/shared-test/**` file; `cd apps/api-v1 && deno task check` (it checks `src/main.ts` and `test/`)
  plus the Deno test files a task names, then `rm -rf apps/api-v1/node_modules/.deno`; for Task 5 `cd
  apps/ar-eye-hunter-v1 && npm run typecheck`; `node scripts/check-tests-typecheck.mjs`; the four pins; the
  bundle checks with a private `TMPDIR` (`mktemp -d /tmp/claude-501/b.XXXX`) after any `packages/shared`,
  `shared-web` or `shared-test` change (`npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
  and `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`; budgets: `browser/rallar.ts`
  242, headless 308 from Task 1; a crossed budget rises to the next whole KiB with the measured figure in the
  commit message); for a public shared-web change `shared-web-public-api-snapshots.test.ts` and
  `shared-web-browser-bundle-boundaries.test.ts`; after the commit `npm run check:repo-style:changed -- 0001c2527
  HEAD` (read the verdict line: the script exits 0 on FAIL), `node scripts/check-test-structure-coupling.mjs
  --changed 0001c2527 HEAD` and, when a test file is added or deleted, `npm run check:test-reachability`.
- **Sandbox notes.** Loopback binds fail (`listen EPERM`): name those suites as sandbox reds
  (`api-v1-rtc-rtt-recipe-semantics` 5, `api-v1-state-write-convergence-recipe` 4, `local-websocket-session`
  1, `live-rtc-control-client`, `headless-worker-script`); pglite and IndexedDB 5 s load timeouts pass alone;
  `npx tsx` fails on its IPC pipe (use `node --import tsx`); `pgrep` fails under the sandbox (poll for a summary
  line); `git fetch`, `gh` and the Playwright lane need the sandbox off. The api-v1 and control-server
  `node_modules` are shared across worktrees: remove `.deno` only when no other Deno suite runs. Do not run
  `npm run test:unit` per task.
- **Git.** One commit per task with one `D8 reuse:` line and no attribution lines; the controller commits
  and pushes after review; never `git stash`; the PR body is written at the close.

## File structure

| Area                      | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts and claim (1)   | `packages/shared/al-contracts/{al-policy,al-control,al-control-value-codec}.ts`; `packages/shared/alm/delivery/al-delivery-lifecycle.ts`; `packages/shared/alm/inbound/{al-inbound-admission-store,al-inbound-planner-snapshot,al-inbound-effect-intent}.ts`, `alm/inbound/admission/{al-inbound-delivery-mutations,validate-al-inbound-admission-mutation}.ts`, `alm/inbound/control/compute-al-inbound-control-admission.ts`; `alm/outbound/control/resolve-al-outbound-relay-rejection.ts`; `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts`; `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts`; `packages/tests/rallar-black-box-headless/headless-bundle-budget.json`; tests `al-inbound-exclusive-claim.test.ts` (new) and seven edited test files (22 files) |
| RTC origin and api-v1 (2) | `packages/shared/multicast/compute-rtc-exclusive-refusal.ts` (new), `web-rtc-overlay-multicast-manager.ts`; tests `packages/tests/shared/multicast/compute-rtc-exclusive-refusal.test.ts` (new), `apps/api-v1/test/services/ws-room-exclusive-claim.test.ts` (new) (4 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Browser and relay (3)     | `packages/shared-web/browser/messages/{browser-message-input-validator,browser-rallar-message-sender}.ts`; `browser/director/{rallar-director-facade,browser-director-relay-session,browser-director-relay-transport}.ts`; `browser/rallar.ts`; `packages/shared-web/game/{match,director/rallar-game-director-relay-runtime,match/rallar-game-match-contracts,transport/rallar-game-send-result}.ts`; seven edited test files under `packages/tests/shared-web/` (17 files)                                                                                                                                                                                                                                                                                                                               |
| Lane and harness (4)      | `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/claim/{claim-commands,claim-first-wins,claim-expires-reclaims,claim-refused-on-rtc}.ts` (new); the lane's step-identity, message, receipt, receiver, scenario-definition and recipe modules, `scenarios/audiences/world-routing.ts`; the harness `messages.send` contract, field list, schema, control validator, capability text, decoder, operation input and ledger; `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`; tests `alm-conformance-claim.test.ts` (new) and six edited test files (27 files)                                                                                                                                                                                                               |
| AR Eye (5)                | `apps/ar-eye-hunter-v1/src/game/{types.ts,arena-runtime/use-rallar-arena.ts,arena-runtime/game-actions/use-arena-world-actions.ts}`; `packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts` (4 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Docs (6)                  | `docs/rallar-api-reference.md`; `packages/shared/alm/{inbound,outbound}/README.md`; `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`; `playground/alm/alm-complete-product-description.md`; `examples/director-relay/README.md`; `packages/shared-web/game/README.md`; `apps/ar-eye-hunter-v1/README.md` (8 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Close (7)                 | the pins, the gates, the lane run, the review, the PR body, the roadmap's delivered lines, the audit's F16 status line, the requirement matrix's PC7 row, the roadmap's stale reuse-table row, this file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Task order

1 (contracts and the admission-store claim) → 2 (RTC origin and api-v1 pins) → 3 (browser and relay) → 4 (lane) →
5 (AR Eye) → 6 (docs) → 7 (close). Task 2 consumes Task 1's drop, NACK and `set-claim` (its api-v1 cases pin
Task 1's behaviour and are green on Task 1 alone). Task 3 consumes Task 1's trusted-server relay rejection and
Task 2's RTC refusal (its `rtc` facade proof injects that verdict). Task 4 needs nothing from Tasks 1–3 to compile
or to pass its unit pins (`held-by-other` is an expected string there); its lane cells need Tasks 1–3. Task 5
consumes exactly three Task 3 shapes: `RallarDirectorRelayClaim`, `RallarGameMatchHandle.sendIntent(intent,
claim?)` and the game send status `held-by-other`. Task 6 states what Tasks 1–5 built and is checked against them.

The composed commits (scratch tree, each `git am`-able on its predecessor from the design head `0001c2527`):
`final-patch-task-1.patch` … `final-patch-task-6.patch` under `.superpowers/sdd/a2b-plan/`. Only two files are
touched by two tasks: `web-rtc-overlay-multicast-manager.ts` (Task 1's exhaustive drop-code case, Task 2's
refusal step) and `rallar-bb-test-alm-commands.test.ts` (Task 1's decoder row at `:626`, Task 4's rows at
`:345`); every other line anchor below holds at the design head and at its task's parent alike.

## Rulings

- **R-A2b-1 (W-D D1):** the `set-claim` expiry is the message deadline (`deadlineAtMs` in
  `toALInboundAdmittedMessageMutations`), not the dedup row's expiry: `computeALInboundDedupExpiryMs` floors dedup
  at 60 s, which would make D172 false and the 3500 ms reclaim cell impossible. _Cost if wrong:_ one argument.
- **R-A2b-2 (W-D D2):** the public `RallarDirectorRelayHandle.sendIntent(intent, claim?)` gains the claim (the
  session implements that handle). _Cost if wrong:_ one signature and two doc hunks.
- **R-A2b-3 (W-D D3):** `ownership` and `resourceId` join `REPLAY_REFUSED_FIELDS` of `messages.send` and the
  control validator's replay refusal. _Cost if wrong:_ two entries.
- **R-A2b-4 (W-D D4, D5, D7, D8):** the schema doc's drifted `messages.send` field lists are fixed in the same
  sentences; one claim sentence in `packages/shared-web/game/README.md`; the API section is `### Exclusive
  Ownership` after Acknowledgement Modes; the product description folds the unchanged local callback selection
  into its CURRENT paragraph. _Cost if wrong:_ wording.
- **R-A2b-5 (W-D D6):** the question "does every admitted message have a deadline" went to W-A; decided by
  R-A2b-20. _Cost if wrong:_ one clause.
- **R-A2b-6 (W-D D9):** the claim holds across the cluster: every API process shares the WS runtime's inbound
  admission namespace (`server-ws-qbox:default-qbox-server:inbound:admission`, facts-server §2.3); Task 2's Deno
  cases run one process. _Cost if wrong:_ two doc clauses.
- **R-A2b-7 (W-B B1):** `computeRtcExclusiveRefusal` lives in its own file
  `packages/shared/multicast/compute-rtc-exclusive-refusal.ts`: a twelfth runtime export in
  `web-rtc-overlay-frozen-audience.ts` trips `file.responsibility-count`. _Cost if wrong:_ moving one function.
- **R-A2b-8 (W-B B2):** the api-v1 Deno cases live in the new `apps/api-v1/test/services/ws-room-exclusive-claim.test.ts`
  on the shared `ws-room-live-runtime.ts`, not in the 985-line authority-delivery file. _Cost if wrong:_ a file move.
- **R-A2b-9 (W-B B3):** exclusive is decided on the EFFECTIVE ownership everywhere (planner, RTC refusal, the
  browser route and validator), refined by R-A2b-23. _Cost if wrong:_ a qos-only exclusive send routed over RTC
  would be delivered without a claim.
- **R-A2b-10 (W-B B4):** Task 1 raises the headless budget 307 → 308 with its measured figure (307.175 KiB);
  later tasks add no budget edit. _Cost if wrong:_ a red boundary test from Task 1 on.
- **R-A2b-11 (W-B B5):** the RTC refusal names the refused message with the sender's own targets, not the frozen
  audience, so a fallback carrier takes over the sender's principal or list broadcast. _Cost if wrong:_ a
  sender-frozen exclusive multicast falling back keeps the sender's list; no product path sends one.
- **R-A2b-12 (W-C C1):** a recipient role sends through its own step's role (`toConnectionName(step)` in the send,
  observe, cancel, receipts, self-absence, received and payload-wait commands); a recipient's handle id is prefixed
  with its role; the successor keeps the sender's handles. _Cost if wrong:_ harness-only.
- **R-A2b-13 (W-C C2):** each cell's resource is `claim-<carrier>-<scenarioKey>`, so carriers sharing one room never
  meet another carrier's live 30 s claim. _Cost if wrong:_ cross-carrier reds in one lane run.
- **R-A2b-14 (W-C C3):** `claim-first-wins`'s recipient-b ends with a full-window received absence (count 2): the
  recipes test demands it of every three-agent cell whose sender reads acknowledged (~17 s per carrier). _Cost if
  wrong:_ one command.
- **R-A2b-15 (W-C C4):** in `claim-expires-reclaims` the sender pins no receipt (its 3 s claim may end
  `acknowledged` or `expired`); its evidence is its admission and receiving the reclaim; recipient-b's receipt
  window splits into the self-absence and the new `toReceiptReadCommands`, read after its own count-2 absence; the
  expiry hold is a 3.5 s `messages.received` absence (no sleep command exists). _Cost if wrong:_ on a loaded runner
  the 3 s claim must reach recipient-b before it expires (a Limit).
- **R-A2b-16 (W-C C5):** an AR Eye loss for a pickup the arena snapshot lacks records nothing. _Cost if wrong:_ a
  silent loss on a stale snapshot.
- **R-A2b-17 (W-C C6):** the claim cells import `world-routing.ts`'s now-exported `RTC_REFUSAL_FACTS` and
  `WS_ROUTE_FACTS`; a shared facts module trips the style gate. _Cost if wrong:_ an export pair.
- **R-A2b-18 (W-C C7):** the `claim-first-wins` sender reads its route facts (one attempt, `attemptCarriers.0`
  `ws`, no `carrierFallback`) with an `observe acknowledged` after its receipt window. _Cost if wrong:_ one command.
- **R-A2b-19 (W-C C8):** the AR Eye loss headline rides the connection's `activeEvent`; every accepted snapshot
  overwrites it, so it shows until the next snapshot or director event (a Limit). _Cost if wrong:_ a new notice
  surface.
- **R-A2b-20 (the R-A2b-5 question):** a WS-client exclusive message with no `expiresAtMs` and no expiry policy
  claims until the admission's own deadline (`nowMs + retention.durableEffectTtlMs`, 30 min): "the claim expires
  when the admitted message does" (D172); no ingress refusal; a Limit and a doc clause in Task 6. _Cost if wrong:_ a
  30 min claim by a non-browser client that names no ttl.
- **R-A2b-21 (W-A A1, A2, A3):** the claim row holds the holder peer id with the row expiry as its liveness
  (applied on read by every backend); the key function `toALInboundClaimKey(input)` is private to the admission
  store (a new file fails `layout.directory-density` and `layout.feature-prefix-cluster` in `alm/inbound`), and the
  stored key `${namespace}:claim:<key>` matches the frame; the claim is a guarded observation of the commit
  (arbitration proven on memory, IndexedDB and PGlite). _Cost if wrong:_ a file move.
- **R-A2b-22 (W-A A4):** `held-by-other` is an authority refusal: `isRoomAuthorityNackReason` becomes
  `isAuthorityRefusalNackReason`, so its NACK asks for no repair. _Cost if wrong:_ a repair request on a claim drop.
- **R-A2b-23 (W-A A5, A6, A7):** the internal `SendCommandInput.claim: RallarDirectorRelayClaim | undefined` is
  required (`requestSync` passes `undefined`), the public handle keeps `claim?`; no exclusive check in
  `create-browser-unicast-message.ts` (`validateWs` covers every peer send that reaches WS; on `rtc` the carrier
  refuses); `isExclusiveSendInput` follows the planner's precedence, `(qos.ownership?.algo ?? ownership) ===
  'exclusive'` (a contradictory pair counts as shared). _Cost if wrong:_ one predicate.
- **R-A2b-24 (W-A A8, A9):** `held-by-other` is decided right after `duplicate` in `resolveMessageDrop` (an expired
  exclusive message on a held key reads `held-by-other`); `planNack`'s `expired`, `overloaded` and `held-by-other`
  cases are one block. _Cost if wrong:_ one branch order.
- **R-A2b-25 (W-A A10):** `browser/rallar.ts` is raised to 243 only if a composed commit crosses 242; the docs say
  "exclusive claim" where a bare "claim" collides with the worker-lease partition (`al-inbound-work-entry.ts:72-75`).
  _Cost if wrong:_ a budget line; wording.
- **R-A2b-26 (assembler):** no budget is raised beyond Task 1's headless 308: the composed facade measures
  241.813 KiB after Task 1, 241.730 after Task 2 and 241.880 after Tasks 3–6 (under 242); the headless agent
  307.175, 307.114, 307.316 and 307.304 after Tasks 1, 2, 3 and 4 (under 308). Task 3's commit message states the
  composed figures (241.880 and 307.316) in place of the prototype's (241.868, 307.317). _Cost if wrong:_ a budget
  raise at the close if a review fix adds 0.12 KiB to the facade.
- **R-A2b-27 (assembler):** Task 6's prototype predated R-A2b-7, -11, -13, -15, -20, -21 and -25. The composed
  Task 6 states: the claim key is the admission store's private `toALInboundClaimKey` (no
  `al-inbound-claim-key.ts`), keyed `<namespace>:claim:<key>`, read only for a `ws-client` source as a guarded
  observation whose liveness is the row's expiry; a deadline-less message holds the key for the store's retention
  default (inbound README, API reference **Expired**, product description); `computeRtcExclusiveRefusal` in its own
  file reads the effective ownership and names the sender's targets; the cells' resource is
  `claim-<carrier>-<scenarioKey>` and the reclaim cell reads as R-A2b-15 built it; "exclusive claim" where the
  inbound and outbound READMEs and the API section would otherwise say a bare "claim"; the product description
  says the WS server admits the send (nothing changed in the room authorizer); the AR Eye README's headline lasts
  until the next snapshot or director event (R-A2b-19). The commit message stays the prototype's (still true; 8
  files, +206/−23). _Cost if wrong:_ doc wording.
- **R-A2b-28 (assembler):** Task 5 applies on Task 4 with nothing dropped: W-C's stub of the three Task 3 shapes
  was its own commit, never in the patch; Task 3 delivers the three shapes (the match contract imports
  `RallarDirectorRelayClaim` from `browser/rallar.ts`), and the app passes the claim as an object literal. _Cost if
  wrong:_ none; the composed tree compiles at every commit.
- **R-A2b-29 (assembler):** every task's changed-range gates run from the design head `0001c2527`, equivalent to
  `origin/main` (`94e72f482`) because the two design commits change only `playground/alm/` Markdown. Red/green and
  reachability counts are the composed tree's: Task 4's red is 19 failed / 204 passed (223) over eight files (Task
  1's decoder row in `rallar-bb-test-alm-commands.test.ts` and R-A2b-31's file add to the prototype's 18 / 201);
  reachability reads 1774 files after Task 1, 1776 after Task 2 and 1777 after Task 4. _Cost if wrong:_ none.
- **R-A2b-30 (assembler):** the roadmap's last "ResourceInbox" claim wording is the reuse table's `| Exclusive
  claims |` row (`playground/alm/alm-improvement-plan.md:318`, "ResourceInbox reservation with lease, expiry, and
  redelivery"); the close rewrites it to the admission store's claim with the message's lifetime as its lease (D173).
  The historical `alm-roadmap-assessment.md:138` and `alm-a2a-design-proposal.md:99` stay as written. _Cost if
  wrong:_ one table cell.
- **R-A2b-31 (assembler):** Task 4 also updates `packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts`,
  which W-C's prototype missed (the final sweep's one product-caused red: `ws: expected [ 'aggregated-receipt',
  …(10) ] to deeply equal [ 'aggregated-receipt', …(8) ]`): its per-carrier three-agent keys gain `claim-first-wins`,
  `claim-expires-reclaims` (ws), `claim-refused-on-rtc` (rtc) and `claim-first-wins` (rtc-with-ws-fallback), in
  registration order, and the title reads "selects exactly the receipted-audience, membership fence, leader and claim
  scenarios for the three-agent family on every carrier". Task 4 becomes 27 files, +798/−38. _Cost if wrong:_ none;
  without it the composed tree is red.

## Limits (carried; Task 7 states them in the PR body)

- Server publications claim nothing: they bypass the inbound authority (D178).
- The receivers' local callback selection is unchanged: an `exclusive` message reaches its typed callback or,
  failing that, the wildcard, never both (D178).
- No claim release call and no explicit `claimed` event: the admission is the claim, and a claim ends with its
  message (D175, D178).
- Scopes other than the room (process, browser session, principal, server consumer group) are not defined
  (D178).
- Relic is unchanged: its pickup is already arbitrated by the server's per-game rule (D178).
- No claim on the RTC carrier: an exclusive send over `rtc` alone is refused `unsupported` (D174).
- A WS client's exclusive message with no `expiresAtMs` and no expiry policy holds its key until the admission's
  own deadline, the store's retention default (30 min); every browser send carries a `ttlMs` (R-A2b-20).
- The AR Eye loss headline lasts until the next accepted arena snapshot or director event replaces it (R-A2b-19).
- A loss for a pickup the arena snapshot lacks records nothing (R-A2b-16).
- On a loaded runner the `claim-expires-reclaims` cell's 3 s claim must reach recipient-b before it expires; a
  late arrival reddens the cell without a product fault (R-A2b-15).
- The claim holds across the cluster through the one shared admission namespace; no multi-process case pins it
  (R-A2b-6).
- The `claim` cells are local and the hosted full read's: manifests 18 and 22 withhold them and stay
  byte-identical (D177).

## Corrections and notes (Task 7 states them in the PR body's Corrections)

- **The roadmap's "ResourceInbox-backed" wording:** the claim is an admission-store key with the expiring-set
  semantics the dedup key already has, not a ResourceInbox reservation (the resource inbox holds worker rows);
  the A2 row was corrected with the design, and the close corrects the reuse table's `| Exclusive claims |` row
  (R-A2b-30).
- **The product description's scope list:** "local process, browser session, principal, group, or server
  consumer group" is reduced to the room scope, the only one defined; "exactly one registered consumer may
  claim it" becomes "exactly one sending session holds the message's resource key in its room at a time"
  (Task 6).
- **The harness field-list drift W-D fixed:** the black-box schema doc's `messages.send` optional list lacked
  `principalId` and `recipientPeer`, and its replay-refused list lacked `principalId`, `recipientPeer`,
  `durability` and `onStorageUnavailable`, all of which `REPLAY_REFUSED_FIELDS` already refused
  (`decode-black-box-rallar-message-send-input.ts:55-75`); Task 6 lists the code's full set (R-A2b-4).
- **The frame's claim-expiry sentence contradicted itself** ("the expiry the `set-dedup` mutation uses (the
  message deadline)"): the dedup expiry is floored at 60 s; the claim uses the message deadline (R-A2b-1).
- **Not every admitted message has a deadline of its own:** `attempt()` stamps `expiresAtMs` only when an
  envelope or policy expiry exists; otherwise the admission's own deadline applies (R-A2b-20).
- **`toNackReason` mapped an unknown reason to `stale`** (`al-inbound-effect-intent.ts:243-259`): Task 1 maps
  `held-by-other`, else the NACK would have gone out as `stale`.
- **The frame's `toALInboundPlannerSnapshot :45` is `computeALInboundPlanningObservations`**, and the store input
  needed no new field: `ReadALInboundMessageInput.source` (`al-inbound-admission-store.ts:151`) already carries
  the admission source.
- **The frame placed `computeRtcExclusiveRefusal` in `web-rtc-overlay-frozen-audience.ts` and read the wire
  `delivery.ownership`:** it has its own file and reads the effective ownership (R-A2b-7, R-A2b-9).
- **"claim" already names the worker-lease partition** (`al-inbound-claim-partition.test.ts`,
  `al-inbound-work-entry.ts:72-75`): the docs say "exclusive claim" (R-A2b-25).
- **The memory note "api-v1 `deno task check` skips its tests" is out of date:** it checks `src/main.ts test/`.

## Tasks

### Task 1: Contracts, planner and the admission-store claim (D171, D172, D173, D175)

**Files** (anchors at the design head `0001c2527`, this task's parent; the composed commit is
`.superpowers/sdd/a2b-plan/final-patch-task-1.patch`, `git am`-able there; 22 files, +595/−41). Production:

- `packages/shared/al-contracts/al-policy.ts`: `ALMessagePlanningObservations` (`:212-217`) gains, after `dedupSeen`
  (`:214`), `/** The session holding a live claim on the message's resource key; present only where an admission read
  one. */ readonly claimHolderPeerId?: string;` (optional: absence has its own meaning, no claim read). The
  `ALMessageDropReasonCode` union (its last arm `:241`) and `AL_MESSAGE_DROP_REASON_CODES` (its last entry `:253`) gain
  `'held-by-other'` last. `resolveMessageDrop`, right after the `dedupSeen` branch (`:489-491`): `if
  (isHeldByOtherSession(result.effective, context)) return { code: 'held-by-other', reason: 'Exclusive resource is held
  by another session' };`; private `isHeldByOtherSession(effective: ALQosEffectivePolicy, context:
  ALMessagePlanningContext): boolean` before `computeMessageDelivery` (`:522`): `effective.ownership.algo ===
  'exclusive' && context.claimHolderPeerId !== undefined && context.claimHolderPeerId !== context.fromPeerId`.
  `planNack`: the `expired` (`:605-612`) and `overloaded` (`:614-621`) blocks become one: `if (drop?.code === 'expired'
  || drop?.code === 'overloaded' || drop?.code === 'held-by-other') return { enabled: true, toPeerId:
  context.fromPeerId, reason: drop.code, missingRanges: [] };` (R-A2b-24).
- `al-contracts/al-control.ts:40` `ALNackReason` gains `| 'held-by-other'`; `al-control-value-codec.ts:276`
  `decodeNackReason` accepts it (`&& value !== 'held-by-other'`).
- `packages/shared/alm/inbound/al-inbound-admission-store.ts`: import `readALTargetGroupRef` with `ALMessage` (`:1`)
  and `decodeALAdmissionString` beside `decodeALAdmissionNumber` (`:16`). `ALInboundAdmissionObservations` gains after
  `dedup` (`:109`) `/** Read only for an exclusive room message from a WS client: the session holding its resource
  key, if any. */ readonly claim: Readonly<{ key: string; holderPeerId: string | undefined; }> | undefined;`. The
  mutation union gains, before `set-ordering` (`:225`), `Readonly<{ kind: 'set-claim'; claimKey: string; holderPeerId:
  string; expireAtTimestamp: number; }>`. `readIncomingMessage` after the dedup read (`:424`): `const claimKey =
  toALInboundClaimKey(input); const claim = claimKey === undefined ? undefined : { key: claimKey, holderPeerId: await
  session.read(this.toClaimStoreKey(claimKey), decodeALAdmissionString) };`, passed as `claim` to
  `toALInboundAdmissionRead`. `requireOriginalObservations` re-reads it after the dedup re-read (`:645-648`) with the
  same shape from `observed.claim` and compares it in the `jsonEquals` (`:684`, after `dedup`). `applyMutation` after
  `set-dedup` (`:736-739`): `case 'set-claim': return await tx.set(this.toClaimStoreKey(mutation.claimKey),
  mutation.holderPeerId, mutation.expireAtTimestamp);`. Private `toClaimStoreKey(claimKey)` before `toOrderingKey`
  (`:814`): `` `${this.namespace}:claim:${claimKey}` ``. `ToALInboundAdmissionReadInput` (`:835`) gains `readonly
  claim: ALInboundAdmissionObservations['claim'];`; `toALInboundAdmissionRead` puts `claim` in `observations` after
  `dedup` (`:866`) and `claimHolderPeerId: claim?.holderPeerId` after `dedupExpiresAt` (`:881`); the buffered-release
  observations (`:923`) and `compute-al-inbound-control-admission.ts:109` gain `claim: undefined`. Module-private,
  before `ToALInboundAdmissionReadInput`, with the doc "The key an exclusive room message from a WS client claims: the
  room's scope and the route, each part encoded. Only the server arbitrates a claim, so no other source, no shared
  message and no roomless one claims anything. The same group id exists in other scopes, so the scope is part of the
  key.": `function toALInboundClaimKey(input: ReadALInboundMessageInput): string | undefined` → `undefined` unless
  `source.kind === 'ws-client'`, `prePlan.effective.ownership.algo === 'exclusive'` and `readALTargetGroupRef(msg)` is
  defined; else `[applicationId, workspaceId, groupId, route.topicId, route.contextId, route.resourceId]
  .map(encodeURIComponent).join('/')` (R-A2b-21). The source is already on `ReadALInboundMessageInput` (`:151`): the
  store input gains nothing.
- `al-inbound-planner-snapshot.ts`: `ALInboundPlannerSnapshot` gains after `dedupExpiresAt` (`:27`) `/** The session
  holding a live claim on an exclusive message's resource key; never read for any other message. */ readonly
  claimHolderPeerId: string | undefined;`; `computeALInboundPlanningObservations` after `dedupSeen` (`:45`):
  `claimHolderPeerId: read.admitted ? undefined : read.claimHolderPeerId,`. Liveness is the row's expiry, which every
  backend already applies on `read`, so no timestamp is compared here.
- `admission/al-inbound-delivery-mutations.ts`: doc (`:25`) "The provenance, ordering, dedup and claim rows an admitted
  message owns; its claim lasts as long as the message."; before `return mutations;` (`:60`): `if
  (read.observations.claim !== undefined) mutations.push({ kind: 'set-claim', claimKey: read.observations.claim.key,
  holderPeerId: read.fromPeerId, expireAtTimestamp: deadlineAtMs });` (`deadlineAtMs` is the message deadline the
  same function already resolves, R-A2b-1). Only an admitted message reaches it (the drop branch returns before).
  `validate-al-inbound-admission-mutation.ts:77`: `case 'set-claim': return mutation.claimKey === observed.claim?.key;`.
- `al-inbound-effect-intent.ts`: `toNackReason` (`:255`) gains `case 'held-by-other': return 'held-by-other' as
  const;` (else it would go out as `stale`); `isRoomAuthorityNackReason` (`:159`) becomes
  `isAuthorityRefusalNackReason`, doc "An authority refusal is about the receiver's roster or a claim, never the
  ordering track, so it asks for no repair.", adding `|| reason === 'held-by-other'`; the local `roomAuthorityRefusal`
  (`:142`) becomes `authorityRefusal` (R-A2b-22).
- `alm/delivery/al-delivery-lifecycle.ts:287` the trusted-server reason union gains `| 'held-by-other'` (doc
  `:278-283` names it); `alm/outbound/control/resolve-al-outbound-relay-rejection.ts:29`
  `isTrustedServerAdmissionRefusal` and the doc gain it. `resolve-al-delivery-fallback-trigger.ts` is unchanged.
- `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts:994` `case 'held-by-other':` joins the
  `planner-drop` group of `toALOutboundDropReasonCodeFromHandlingPlan` (exhaustive switch; an origin never plans this
  inbound-only code).
- `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts`: `ALM_NACK_REASONS` (`:78`) and
  `decodeAlmRelayRejection` (`:127`, doc `:116-119`) gain `held-by-other`.
- `packages/tests/rallar-black-box-headless/headless-bundle-budget.json`: `brotliBudgetKiB` 307 → 308 (measured
  307.175 KiB, R-A2b-10).

Tests: `packages/tests/shared/al-policy.test.ts` (before `:383`, helper `exclusiveRoomBroadcast` before `:710`),
`al-control.test.ts:147` (`it.each(['membership-fenced','held-by-other'])`), new
`packages/tests/shared/alm/inbound/al-inbound-exclusive-claim.test.ts`, `alm/al-shared-key-arbitration.test.ts`
(before `:153`, helper `createClaimingInboundMessage` before `:333`),
`alm/inbound/validate-al-inbound-admission-mutation.test.ts` (`claim: undefined` in the fixture observations; describe
"validateALInboundAdmissionMutation claim"), `services/ws-queue-box-client-relay-rejection.test.ts` (before `:237`,
helper `exclusiveRoomBroadcast` before `:381`), `alm/delivery/resolve-al-delivery-fallback-trigger.test.ts` (before
`:87`), `shared-test/rallar-bb-test-alm-commands.test.ts:626`.

**Interfaces produced** (Tasks 2–6 consume): the drop code, NACK reason and trusted-server relay-rejection reason
`held-by-other` with the drop reason text `'Exclusive resource is held by another session'`;
`ALMessagePlanningObservations.claimHolderPeerId`; `ALInboundPlannerSnapshot.claimHolderPeerId`;
`ALInboundAdmissionObservations.claim`; the mutation `set-claim`; the row key `${namespace}:claim:<app>/<workspace>/
<group>/<topic>/<context>/<resource>` (encoded parts), value the holder peer id, row TTL the message deadline;
`isAuthorityRefusalNackReason`; the headless budget 308. The WS server needs no wiring: its admission source is
`ws-client` (`ws-queue-box-server-service.ts:469-495`) and the NACK leaves through the existing `send-nack` effect.
**Consumed:** nothing new.

**D8 reuse inspection.** The dedup key's read, guarded observation and expiring `tx.set`, `readALTargetGroupRef`,
`decodeALAdmissionString`, the planner's drop/NACK, the NACK effect and the trusted-server relay rejection carry the
claim; no new store, file, effect or rejection path. The claim-key function lives in the store (a new file tripped
`layout.directory-density` 23 > 20 and `layout.feature-prefix-cluster` in `alm/inbound`). `planNack` loses two
duplicated blocks.

- [ ] **Step 1: Write the failing tests** (copy from the patch). Planner: "drops an exclusive message on a resource
      another session holds and NACKs the sender held-by-other" (`dropReasonCode` `held-by-other`, reason text,
      delivery, forwarding and ack disabled, nack `{ enabled: true, toPeerId: 'claimant-b', reason: 'held-by-other',
      missingRanges: [] }`); `it.each` `admits $name` (holder's re-send, shared send on a held resource, free
      resource). Claim file: describe "the exclusive claim key a WS client admission reads" (encoded key
      `app/workspace/room%2F1/arena.intent/room/pickup-1`; another workspace differs; a room unicast keys by its room;
      nothing for a shared room send, an exclusive world broadcast or a roomless unicast);
      `describe.each(['memory','pglite'])` "the exclusive claim in the inbound admission store over %s": first claim
      (`set-claim` `{ claimKey, holderPeerId: 'claimant-a', expireAtTimestamp: STARTED_AT_MS + 3_000 }`, committed);
      another session dropped `held-by-other`, no mutations, one durable effect parsing to a `nack` with reason
      `held-by-other`; the holder's re-send at +1 s moves the expiry to +4 s, so `claimant-b` at +3.5 s is still
      `held-by-other`; past +3.5 s the key is free for `claimant-b`; a shared send reads and takes no claim; an
      `rtc-peer` and a `trusted-server` source read and take none. Arbitration "decides on the inbound claim key: one
      exclusive resource, two senders" over memory/indexeddb/pglite (stale read then sequential commit; arbitrated key
      `${namespace}:claim:app/workspace/room-1/arena.intent/room/pickup-1`; re-planned loser `held-by-other`). WS
      relay: "states the server dropping an exclusive send on a resource another session holds; the receipted handle
      reads rejected" (`b` claims, `a`'s send `not-admitted` with the reason text, one NACK on socket a, lifecycle
      `rejected`, one attempt, failure `{ kind: 'relay-rejected', rejection: { relay: 'trusted-server', reason:
      'held-by-other' } }`). Fallback pin "keeps a claim held by another session out of the hand-over" (`continue`,
      `notReadyRun: 0`). Codec round-trip; decoder row; mutation validation (an unobserved key is `writes outside its
      original observations`; the observed key passes).
- [ ] **Step 2: Run red.** `npx vitest run packages/tests/shared/al-policy.test.ts packages/tests/shared/al-control.test.ts
      packages/tests/shared/alm/inbound/al-inbound-exclusive-claim.test.ts packages/tests/shared/alm/al-shared-key-arbitration.test.ts
      packages/tests/shared/alm/inbound/validate-al-inbound-admission-mutation.test.ts
      packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts
      packages/tests/shared/alm/delivery/resolve-al-delivery-fallback-trigger.test.ts
      packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`: 19 failed, 179 passed (198); e.g. `TypeError:
      Control NACK reason is invalid`, `expected undefined to be 'held-by-other'` (3), `expected 'absent' not to be
      'absent'` (3), `expected { kind: 'admitted' } to deeply equal { kind: 'not-admitted', …(1) }`.
- [ ] **Step 3: Implement** as listed. Green: `Test Files  8 passed (8)`, `Tests  198 passed (198)`.
- [ ] **Step 4: Verify.** `npx vitest run packages/tests/shared/alm packages/tests/shared/al-policy.test.ts
      packages/tests/shared/al-control.test.ts packages/tests/shared/al-inbound-message-runtime.test.ts
      packages/tests/shared/al-indexeddb-runtime-stores.test.ts packages/tests/shared/services
      packages/tests/shared/multicast packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts
      packages/tests/shared-server/rallar-system packages/tests/api-v1/psql-admission-optimistic-retry.test.ts
      packages/tests/api-v1/psql-admission-work.test.ts` → `Test Files  506 passed | 4 skipped (510)`, `Tests  4448
      passed | 12 skipped (4460)` (the four IndexedDB pins inside, unedited); `npx tsc -p
      packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit` (clean); `deno check` on the 13
      changed `packages/shared/**` and `shared-test` source files (clean); `cd apps/api-v1 && deno task check`, then
      `rm -rf apps/api-v1/node_modules/.deno`; `node scripts/check-tests-typecheck.mjs` (PASS); with a private `TMPDIR`
      `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` (`browser/rallar.ts` 241.813 KiB < 242) and
      `npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` (307.175 KiB: the budget
      is 308). `npx dprint fmt` on the touched files (through `xargs`).
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- 0001c2527 HEAD` (`PASS: no new repository style
      findings`), `node scripts/check-test-structure-coupling.mjs --changed 0001c2527 HEAD` (three PASS lines), `npm
      run check:test-reachability` (a test file is added: `1774 test files, 1768 reached by CI, 6 manual`).

```text
Claim an exclusive send's room-scoped resource key at WS admission

An exclusive message a WS client sends into a room claims its resource
key for the sending session: the room's GroupRef scope with the route
topic, context and resource. The admission store reads the claim beside
the dedup key, only for a ws-client source, so neither an RTC peer nor a
trusted server reads or takes one and a browser never drops for it. The
planner drops another session's exclusive send on a live claim as
held-by-other and NACKs the sender with that reason; the holder's own
re-send and every shared send pass. An admitted exclusive message writes
a set-claim mutation, in the one admission transaction, that expires at
the message's own deadline, so the holder renews by sending again and an
expired claim frees the key. The claim key is a guarded observation of
the commit, so two claimants that read a free key conflict and the loser
is re-planned against the winner.

held-by-other is a drop code, a NACK reason that asks for no repair, and
a trusted-server relay rejection before any receipt row, so a receipted
send ends rejected at failure.rejection.reason and a receipt-less one
carries it as evidence. It is not a fallback trigger. The black-box
decoder reads it.

Bundles: browser/rallar.ts measures 241.813 KiB against 242; the headless
agent 307.175 KiB (base 306.754) crossed 307, raised to 308.

D8 reuse: the dedup key's read, guarded observation and expiring set, readALTargetGroupRef and decodeALAdmissionString, the planner's drop and NACK, the NACK effect, and the trusted-server relay rejection carry the claim; no new store, effect or rejection path.
```

### Task 2: The RTC origin refuses an exclusive send, and the WS claim is pinned end to end over api-v1 (D173, D174)

**Files** (anchors at Task 1's commit, this task's parent; the composed commit is `final-patch-task-2.patch`, `git
am`-able on `final-patch-task-1.patch`; 4 files, +328; no server source changes: Task 1's `ws-client` source gate
needs no api-v1 or shared-server wiring, since the read DTO carries `read.source`)

- Create `packages/shared/multicast/compute-rtc-exclusive-refusal.ts` exporting
  `computeRtcExclusiveRefusal(msg: ALMessage, original: ALMessage, effective: ALQosEffectivePolicy):
  Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage>`: `effective.ownership.algo !== 'exclusive'` →
  `Either.ofRight(msg)`; else `Either.ofLeft({ msg: { ...msg, targets: original.targets }, dropReason: 'RTC cannot
  arbitrate an exclusive claim: an exclusive send is unsupported', dropReasonCode: 'unsupported', lane: 'volatile',
  preparedMessages: [] })`. Doc: "No server stands on the RTC path to arbitrate two claimants of one resource, so an
  exclusive send is refused as unsupported: the refusal a fallback carrier takes over, named with the targets its
  sender gave, and the verdict of an RTC-only send." Its own file (R-A2b-7); it reads the effective policy (R-A2b-9)
  and hands back the sender's targets (R-A2b-11).
- `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts`: import it (one line before the
  `./compute-rtc-outbound-carrier-availability.ts` import, `:72`); in `planOutgoingMessage` (`:526`) insert, right after
  `computeRtcBroadcastScopeRefusal(msg)` (`:537`), the step
  `.flatMap<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage>((refusal) => Either.ofLeft(refusal),
  (carried) => computeRtcExclusiveRefusal(carried, original, policy.effective))`, before the ack refusal.
- Create `packages/tests/shared/multicast/compute-rtc-exclusive-refusal.test.ts` (fixture
  `./rtc-origin-overlay-fixture.ts`; room `createOriginPrincipalSnapshot()`, next hops `['b', 'c']`).
- Create `apps/api-v1/test/services/ws-room-exclusive-claim.test.ts` on the shared live room runtime
  (`ws-room-live-runtime.ts:45` `createLiveRoomRuntime`, `:90` `waitForRoomSends`, `:110` `readOriginReceipts`;
  `ws-room-test-runtime.ts` `putRoomSnapshot`; `createGroupSnapshot(2, ['session-1', 'session-2', 'session-3'])`)
  (R-A2b-8). User WS topics start with `app.` or `room.`: the cases send on `room.pickup`.

**Interfaces.** Consumes from Task 1: the planner drop `held-by-other` with its reason text, its NACK reason, the
`ws-client`-gated claim read and the `set-claim` mutation expiring at the message deadline. Produces:
`computeRtcExclusiveRefusal`; an RTC `refused { reason: 'unsupported' }` verdict for every effective-exclusive send.
Task 3's `rtc`-strategy facade proof and Task 4's `claim-refused-on-rtc` cell read it.

**D8 reuse inspection.** The origin's `Either` refusal chain and its `unsupported` drop code (the scope, ack,
frozen-audience and leader refusals) carry the new refusal; no new verdict or fallback rule (`unsupported` is
already in `AL_DELIVERY_FALLBACK_REFUSAL_REASONS`). The api-v1 cases reuse the live room runtime, its receipt reader
and wait helper; no new harness.

- [ ] **Step 1: Write the tests** (copy from the patch).
  - Vitest, `describe('the RTC origin of an exclusive send')`, fake timers at `2026-01-01T00:00:00Z`; sends on route
    `{ topicId: 'room.pickup', resourceId: 'pickup-1', contextId: 'room' }`, `ack: 'all-logical-recipients'`,
    `at-least-once`, `ttlMs: 30_000`: it.each `['room multicast', 'room broadcast', 'principal', 'list', 'room
    unicast']` "refuses an exclusive %s send as unsupported with the targets its sender gave, sending nothing and
    expecting no receipt" → `verdict` toEqual `{ kind: 'refused', reason: 'unsupported', detail: 'RTC cannot arbitrate
    an exclusive claim: an exclusive send is unsupported' }`; `admitted.message.targets` toEqual the sent targets;
    channels b and c sent nothing; `readPendingAck` undefined (the unicast goes to `b` with `ack: 'receiver'` and the
    room `groupRef`); "refuses a room send that asks for exclusive ownership by quality of service alone as
    unsupported" (`qos: { ownership: { algo: 'exclusive' } }`, no `ownership`) → the same verdict, nothing sent;
    "admits and sends a shared room send on the same resource" → `admitted`, b receives `toOriginFrozenTargets(['b',
    'c', 'd'], 4)`.
  - Deno, sends `newALBroadcastMessage(sender, newALRoute('room.pickup', groupId, 'pickup-1'), 'room',
    'room.pickup.v1', { pickupId }, { groupRef, reliability: 'at-least-once', ack: 'receiver', ownership, ttlMs })`,
    ttl 30 000 ms unless `CLAIM_TTL_MS = 300`:
    - "a second session's exclusive send on a claimed resource is NACKed held-by-other, reaches no one and starts no
      receipt": session-2 claims (`{ kind: 'admitted' }`, delivered to 1 and 3); session-1's exclusive send → `right`
      `{ kind: 'not-admitted', reason: 'Exclusive resource is held by another session' }`, session-1's frames one NACK
      `held-by-other`, pickup frames only `[['session-1', claim], ['session-3', claim]]`, `readOriginReceipts` `[]`
      (the drop's acceptance is `not-admitted`, `al-inbound-message-admission.ts:253-261`, so `writeAdmittedReceipt`
      returns at `ws-queue-box-server-receipt-aggregation.ts:187-189`).
    - "the holder's exclusive re-send on its claimed resource is admitted, delivered and moves the claim's expiry to
      its own": session-1 claims with `CLAIM_TTL_MS`, re-sends with 30 s (both admitted, session-2 gets both, no NACK
      to session-1); past the first expiry session-2's exclusive send is `not-admitted` and NACKed `held-by-other`.
    - "a claim lapses with its message: the next session's exclusive send is admitted, delivered and holds the
      resource": session-1 claims with `CLAIM_TTL_MS`; after `waitPastExpiry` (`id.ts + CLAIM_TTL_MS - now + 20` ms of
      real time) session-2's exclusive send is admitted and reaches sessions 1 and 3; session-1's next exclusive send
      is `not-admitted`, NACKed `held-by-other`.
    - "a shared send on a claimed resource neither consults nor takes the claim, and is delivered": session-1 claims;
      session-2's `shared` send is admitted and reaches 1 and 3; session-1's exclusive re-send is still admitted; no
      NACK to either.
  - The cases run one API process on the in-memory admission backend (Task 1 pins PGlite); the claim holds across
    the cluster through the shared admission namespace (R-A2b-6); no multi-process case is added.
- [ ] **Step 2: Run red.** `npx vitest run packages/tests/shared/multicast/compute-rtc-exclusive-refusal.test.ts` → 6
      failed, 1 passed (the shared control). `cd apps/api-v1 && deno test --allow-env --allow-read --allow-write
      "--allow-run=$(deno eval 'console.log(Deno.execPath())')" test/services/ws-room-exclusive-claim.test.ts` → `4
      passed | 0 failed` on Task 1 (pins of Task 1's behaviour; at the design head they are 3 failed, 1 passed).
- [ ] **Step 3: Implement** as listed. Green: vitest `Tests  7 passed (7)`; Deno `4 passed | 0 failed` (~1 s).
- [ ] **Step 4: Verify.**
  - `npx vitest run packages/tests/shared/multicast packages/tests/shared/alm packages/tests/shared/al-contracts
    packages/tests/shared/al-policy.test.ts packages/tests/shared/webrtc-rx-policy.test.ts
    packages/tests/shared/multicast-policy-integration.test.ts packages/tests/shared/services
    packages/tests/shared-web/messages packages/tests/shared-web/rtc packages/tests/rallar-black-box/rtc-realtime-controller.test.ts
    packages/tests/rallar-black-box/legacy-diagnostic-recipe-copies.test.ts packages/tests/shared-test` → `Test Files
    3 failed | 393 passed (396)`, `Tests  10 failed | 4834 passed (4844)`: only the sandbox loopback `listen EPERM` set
    (`api-v1-rtc-rtt-recipe-semantics` 5, `api-v1-state-write-convergence-recipe` 4, `local-websocket-session` 1). The
    four pins pass unedited.
  - `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit`; `node
    scripts/check-tests-typecheck.mjs` (PASS); `deno check packages/shared/multicast/compute-rtc-exclusive-refusal.ts
    packages/shared/multicast/web-rtc-overlay-multicast-manager.ts`.
  - `cd apps/api-v1 && deno task check`, then `deno test --allow-env --allow-read --allow-write
    "--allow-run=$(deno eval 'console.log(Deno.execPath())')" test/` → `623 passed | 0 failed`, then `rm -rf
    apps/api-v1/node_modules/.deno`.
  - Bundles with a private `TMPDIR`: `browser/rallar.ts` 241.730 KiB < 242; headless 307.114 KiB < 308. No budget
    edit.
  - `npx dprint fmt` on the four files only, through `xargs`.
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- 0001c2527 HEAD` (PASS), `node
      scripts/check-test-structure-coupling.mjs --changed 0001c2527 HEAD` (PASS), `npm run check:test-reachability`
      (two test files added: `1776 test files, 1770 reached by CI, 6 manual`).

```text
Refuse an exclusive send on the RTC origin, and pin the WS claim end to end

No server stands on the RTC path, so nothing there can arbitrate two
claimants of one resource. The RTC origin refuses a send whose
effective ownership is exclusive as unsupported, right after the
broadcast scope refusal and before any carrier work: the refusal a
fallback carrier takes over, named with the targets its sender gave,
and the verdict of an RTC-only send, with nothing sent and no receipt
expected. Asking for exclusive by quality of service alone is refused
the same way.

The api-v1 cases drive the claim over the real router and room
authority: a second session's exclusive send on a claimed resource is
NACKed held-by-other, reaches no one and starts no receipt; the
holder's re-send is admitted, delivered and moves the claim's expiry
to its own; a claim lapses with its message and the next session's
exclusive send takes the resource; a shared send neither consults nor
takes the claim.

D8 reuse: the RTC origin's Either refusal chain and its unsupported drop code carry the exclusive refusal, and the live room runtime, receipt reader and wait helper drive the api-v1 cases; no new refusal path, server wiring or test harness.
```

### Task 3: The browser WS route, the validator, the relay claim and the game status (D174, D175, D176)

**Files** (anchors at the design head; Tasks 1–2 touch none of these files, so they hold at Task 2's commit, this
task's parent; the composed commit is `final-patch-task-3.patch`; 17 files, +439/−28)

- `packages/shared-web/browser/messages/browser-message-input-validator.ts`: exported, before the namespace (`:47`),
  with the doc "Exclusive as the policy normalizes it: a `qos.ownership` request wins over the `ownership` option
  (D174).": `export function isExclusiveSendInput(send: Pick<RallarMessageSendBase<never>, 'ownership' | 'qos'>):
  boolean` → `(send.qos?.ownership?.algo ?? send.ownership) === 'exclusive'` (R-A2b-23). `validateRtc` and `validateWs`
  push, right after `validateLeaderAudience` (`:87`, `:116`), `...validateExclusiveClaim(input, scope)`. Private at the
  end of the file, doc "An exclusive send claims the resource it names in its room (D174): a fresh resource id per send
  would claim nothing, and the world has no room to hold the claim. A principal send without a room is already refused
  as roomless.": `function validateExclusiveClaim(send: Pick<RallarMessageSendBase<never>, 'ownership' | 'qos' |
  'resourceId'>, scope: RallarMessageScope): readonly RallarValidationIssue[]` → `[]` unless `isExclusiveSendInput(send)`;
  `resourceId === undefined` pushes `{ path: '$.ownership', code: 'exclusive-requires-resource', message: 'An exclusive
  send claims a resource: it names its resourceId.' }`; `scope === 'world'` pushes `{ path: '$.ownership', code:
  'exclusive-requires-room-audience', message: 'An exclusive send claims a resource in its room: it names a room
  audience, never the world.' }`. No check in `create-browser-unicast-message.ts` (R-A2b-23).
- `browser-rallar-message-sender.ts`: the validator import (`:1-4`) becomes a value import of `isExclusiveSendInput`
  with `type` on the two types; `sendTyped` (`:204`) gets the doc "Only the WS server arbitrates a claim, so an
  exclusive send, room- or peer-addressed, and a world send go over WS under every strategy but `rtc`, whose own carrier
  refuses them as unsupported." and, right after `const strategy` (`:208`), before the peer branch: `if
  (isExclusiveSendInput(input) && strategy !== 'rtc') { return await this.sendWs(input, channel); }`.
- `browser/director/rallar-director-facade.ts`: `RallarDirectorRelaySendStatus` (`:62`) gains `'held-by-other'` before
  `'failed'`, doc "`held-by-other`: the intent claimed a resource another session holds, so the server refused it
  (D176)."; before the output-options doc (`:78`) the new public `export interface RallarDirectorRelayClaim { readonly
  resourceId: string; }`, doc "The resource an intent claims in its room (D176): while the claim lives, which is as long
  as the intent's own deadline, another session's intent claiming it reads `held-by-other`. An intent without one claims
  nothing."; `RallarDirectorRelayHandle.sendIntent` (`:109`) → `sendIntent(intent: TIntent, claim?:
  RallarDirectorRelayClaim)` (R-A2b-2). `browser/rallar.ts:106` exports `RallarDirectorRelayClaim` before
  `RallarDirectorRelayConfig`.
- `browser-director-relay-session.ts`: imports the claim type; `sendIntent` (`:78`) takes `claim?:
  RallarDirectorRelayClaim` and passes `claim`; `requestSync` (`:154`) passes `claim: undefined`.
- `browser-director-relay-transport.ts`: imports `RallarDirectorRelayClaim`, `RallarDirectorRelaySendStatus`;
  `SendCommandInput` (after `payload`, `:35`) gains `/** The resource an intent claims; undefined for a shared intent
  and every sync request. */ readonly claim: RallarDirectorRelayClaim | undefined;` (required, R-A2b-23); the send
  options (`:75-77`) gain `...(input.claim === undefined ? {} : { ownership: 'exclusive', resourceId:
  input.claim.resourceId })`. `readDirectorReceipt` doc (`:202`) adds "and the server refuses an intent claiming a
  resource another session holds `held-by-other` (D176)"; `status:` (`:213`) is
  `toDirectorCommandFailureStatus(lifecycle.evidence.failure)`, replacing `isNoLeaderFailure` (`:219-228`) with
  `function toDirectorCommandFailureStatus(failure: ALDeliveryFailure | undefined): Extract<RallarDirectorRelaySendStatus,
  'no-director' | 'held-by-other' | 'failed'>` — `refused` → `no-leader` ? `no-director` : `failed`; `relay-rejected` →
  `no-leader` → `no-director`, `held-by-other` → `held-by-other`, else `failed`; default `failed`.
- `packages/shared-web/game/director/rallar-game-director-relay-runtime.ts:78`: doc "The director's own intent is routed
  here and claims nothing: only the WS server arbitrates a claim."; `sendIntent(intent: TIntent, claim?:
  RallarDirectorRelayClaim)`; `:96` passes `claim` to `this.ensureRelay().sendIntent(envelope, claim)`.
  `game/match/rallar-game-match-contracts.ts:99` `sendIntent(intent: TIntent, claim?: RallarDirectorRelayClaim):
  Promise<RallarGameSendResult>` (the type imported from `browser/rallar.ts`); `game/match.ts:220` `sendIntent: (intent,
  claim) => this.directorRelay.sendIntent(intent, claim)`; `game/transport/rallar-game-send-result.ts:14` gains `|
  'held-by-other'` (`toRelaySendResult` passes it through unchanged).
- Tests: `packages/tests/shared-web/messages/browser-message-audiences.test.ts` (constant
  `EXCLUSIVE_UNSUPPORTED_VERDICT` before `:24`; describe "an exclusive send" before `:323`),
  `browser-message-tracked-receipt.test.ts` (imports `newALBroadcastMessage`, `ALNackReason`; describe "the claim of an
  exclusive room send reaches its handle" before `:303`; `toLeaderReceipt` `:348` becomes `toServerReceipt(msgId, phase,
  expectedRecipientPeerIds, confirmedRecipientPeerIds)`, its two callers `:273-274` pass `['director']`; helpers
  `createExclusiveWsLeg`, `createExclusiveSend`, `toServerNack`), `director/browser-director-relay-transport.test.ts`
  (`commandInput` `:46` gains `claim: undefined`; two its before `:220`), `director/director-command-storage-volume.test.ts:87`
  (`claim: undefined`), `director/browser-director-relay-runtime.test.ts` (an it before `:349`),
  `rallar-game-match.test.ts` (import `RallarDirectorRelayClaim`; the fake's `sendIntent` `:953`, `:1130` take
  `_claim?`; two its before `:781`), `shared-web-public-api-snapshots.test.ts:108` (`'RallarDirectorRelayClaim'` before
  `'RallarDirectorRelayConfig'`).

**Interfaces.** Consumes Task 1's trusted-server `held-by-other` relay rejection and NACK reason, and Task 2's RTC
origin refusal `unsupported` (the facade `rtc` proof injects that verdict). Produces (Task 5 consumes):
`match.sendIntent(intent, { resourceId })`, `RallarGameSendResult.status 'held-by-other'`, the public type
`RallarDirectorRelayClaim` (the public API snapshot changes by that one name), `RallarDirectorRelaySendStatus
'held-by-other'`, the validator codes `exclusive-requires-resource` and `exclusive-requires-room-audience`,
`isExclusiveSendInput`.

**D8 reuse inspection.** A1's world short-circuit carries the exclusive route; the validator's issue shape the two
issues; the relay's typed statuses and `toRelaySendResult` the new status; the room command channel the claimed
intent; the tracked-receipt harness (`createWsClient`, `createDispatchHarness`) the handle proofs. No new channel, send
path, result type or file. New tests avoid mock-count assertions (the coupling gate): they read sent envelopes,
lifecycles and handler deliveries.

- [ ] **Step 1: Write the failing tests** (copy from the patch). Audiences: `it.each(['ws','rtc-with-ws-fallback',
      'ws-then-rtc'])` "claims its resource over WS alone on %s, with no RTC leg and no fallback evidence" (WS message
      `route.resourceId 'pickup-1'`, room broadcast with `groupRef`, `delivery.ownership 'exclusive'`; no
      `carrierFallback`); `['rtc-with-ws-fallback','ws-then-rtc']` "… when only its qos asks for exclusive ownership";
      `['ws','rtc-with-ws-fallback']` "claims its resource for a send addressed to one peer over WS alone on %s"
      (unicast to `peer-1` with `groupRef`); "admits an exclusive send on rtc over RTC alone and ends the handle
      rejected by the injected unsupported refusal" (`attempts: []`, no fallback, failure `refused`/`unsupported`);
      the four strategies × "refuses an exclusive send that names no resource" (option and qos forms) and "refuses an
      exclusive world send". Tracked receipt (real WS client): acknowledged on the server's `admitted`/`complete`
      receipt over `['b','c']`; a receipted send rejected by NACK `held-by-other` (one attempt, failure
      `relay-rejected` trusted-server); a receipt-less send stays `transport-accepted` with `evidence.relayRejection`
      and no failure. Transport: the claimed intent's options `{ ack: 'group-leader', strategy:
      'rtc-with-ws-fallback', ownership: 'exclusive', resourceId: 'pickup-1' }`; a `held-by-other` relay rejection →
      `{ status: 'held-by-other', receipt, reason: 'The server relay refused the message: held-by-other.' }`. Relay
      runtime: the claimed intent is one WS message, `route.resourceId 'pickup-1'`, `delivery { reliability:
      'at-least-once', ack: 'group-leader', ownership: 'exclusive' }`, receipt `attempts: []`, no fallback. Game: the
      relay is called with `(envelope, { resourceId: 'pickup-1' })` and the result is `{ status: 'held-by-other',
      transport: 'director-relay', relay, reason }`; the fresh local director's intent reaches its own `onIntent` and
      reads `{ status: 'sent', transport: 'local' }`.
- [ ] **Step 2: Run red.** `npx vitest run packages/tests/shared-web/messages/browser-message-audiences.test.ts
      packages/tests/shared-web/messages/browser-message-tracked-receipt.test.ts
      packages/tests/shared-web/director/browser-director-relay-transport.test.ts
      packages/tests/shared-web/director/director-command-storage-volume.test.ts
      packages/tests/shared-web/director/browser-director-relay-runtime.test.ts
      packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`:
      17 failed, 141 passed (158); e.g. `promise resolved "{ …(6) }" instead of rejecting` (8, the validator),
      `expected { status: 'failed', …(2) } to deeply equal { status: 'held-by-other', …(2) }`, `expected "vi.fn()" to
      be called with arguments` (2), the snapshot diff `+ "RallarDirectorRelayClaim"`.
- [ ] **Step 3: Implement** as listed. Green: `Test Files  7 passed (7)`, `Tests  158 passed (158)`.
- [ ] **Step 4: Verify.** `npx vitest run packages/tests/shared-web packages/tests/ar-eye-hunter-v1
      packages/tests/rallar-black-box-headless` → `Test Files  189 passed (189)`, `Tests  1633 passed (1633)`
      (snapshots, bundle boundaries and the headless bundle inside); `npx vitest run packages/tests/shared-test` → only
      the loopback-bind sandbox reds (`api-v1-rtc-rtt-recipe-semantics` 5, `api-v1-state-write-convergence-recipe` 4,
      `local-websocket-session` 1, `listen EPERM`); `npx tsc -p packages/shared-web/tsconfig.json --noEmit`,
      shared-test; `cd apps/ar-eye-hunter-v1 && npm run typecheck`; `node scripts/check-tests-typecheck.mjs` (PASS);
      private `TMPDIR` `check:browser-bundles` (`browser/rallar.ts` 241.880 KiB < 242) and the headless boundary test
      (307.316 KiB < 308). `npx dprint fmt` on the touched files. No `packages/shared/**` change.
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- 0001c2527 HEAD` (PASS), `node
      scripts/check-test-structure-coupling.mjs --changed 0001c2527 HEAD` (PASS; 4 candidates, all classified). No test
      file is added.

```text
Send an exclusive claim over WS and let a director intent claim its resource

An exclusive browser send claims its resource where the WS server
arbitrates it. A send is exclusive as the policy normalizes it: a
qos.ownership request wins over the ownership option. Room- or
peer-addressed, it goes over WS under every
strategy but rtc, as a world send does, so it never touches RTC and
carries no fallback evidence; over rtc the carrier refuses it as
unsupported. The validator refuses before either carrier an exclusive
send that names no resourceId (exclusive-requires-resource: a fresh id
per send claims nothing) and an exclusive world send
(exclusive-requires-room-audience). The handle proofs run on the real
WS client: the server's receipt acknowledges an exclusive send, and the
server's held-by-other NACK ends a receipted one rejected as a
trusted-server relay rejection and lands on a receipt-less one as
evidence.

A director relay intent may claim a resource: RallarDirectorRelayClaim
{ resourceId } is a new public type, and the relay handle's sendIntent,
the relay session, the command transport, the game relay runtime and
the game match's sendIntent take it. The intent goes out as an
exclusive command on that resource with the leader ACK; a refusal
held-by-other reads held-by-other on the relay and the game send
result. A shared intent, a sync request, a director output and the
director's own locally routed intent claim nothing.

Bundles: browser/rallar.ts measures 241.880 KiB against 242; the
headless agent 307.316 KiB against 308.

D8 reuse: A1's world short-circuit carries the exclusive route, the validator's issue shape the two claim issues, the relay's typed command statuses and toRelaySendResult the held-by-other status, and the room command channel the claimed intent; no new channel, send path or result type.
```

### Task 4: The `claim` lane family and the harness (D177)

**Files** (anchors at the design head; Tasks 1–3 touch none of these files except
`packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`, where Task 1's row sits at `:626`, after this task's
`:345`; the composed commit is `final-patch-task-4.patch`, `git am`-able on Task 3; 27 files, +798/−38)

- Create `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/claim/{claim-commands,claim-first-wins,claim-expires-reclaims,claim-refused-on-rtc}.ts`,
  `packages/tests/shared-test/alm-conformance-claim.test.ts`.
- Modify (the `messages.send` field, facts-consumers §4.5): `rallar-bb-test/rallar-black-box-test-contracts.ts:1,335`;
  `schema/rallar-black-box-command-fields.ts:109,307`; `schema.ts:617`; `alm/validate-alm-control-command.ts:93,97`;
  `alm/rallar-black-box-alm-command-capabilities.ts:26`;
  `black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts:19,302`;
  `…/messaging/decode-black-box-rallar-message-send-input.ts:2,40,63,116,127`;
  `…/messaging/black-box-rallar-delivery-ledger.ts:308`.
- Modify (the sending recipient and the cells): `conformance/alm/alm-conformance-step-identities.ts:3,24-32,40`;
  `alm-conformance-message-commands.ts:19,44,85,104,173,183`;
  `alm-conformance-receipt-commands.ts:27,57-59,84-95,130-146,153`; `alm-conformance-receiver-commands.ts:9,43,60`;
  `alm-conformance-scenario-definition.ts:29`; `create-alm-conformance-recipes.ts:37,137`;
  `scenarios/audiences/world-routing.ts:23,29-30`; `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts:15,78`.
- Modify tests `packages/tests/shared-test/{rallar-bb-test-alm-commands.test.ts:345,rallar-browser-runtime/delivery.test.ts:514,alm-conformance-recipes.test.ts:57,236,247,255,496,519,alm-conformance-recipe-validation.test.ts:58,86,116}`,
  `packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts:171,178`,
  `packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts:65,77,79-80` (the title gains "leader and claim";
  `ws` gains `'claim-first-wins', 'claim-expires-reclaims'` after `'leader-outside-list'`; `rtc` becomes a multi-line
  list ending `'claim-refused-on-rtc'`; `rtc-with-ws-fallback` gains `'claim-first-wins'`; R-A2b-31).
- Docs: none here. `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md` is Task 6's.

**Interfaces.**

- `RallarBlackBoxTestMessagesSendCommand` gains `ownership?: ALOwnershipAlgo` and `resourceId?: string` after
  `recipientPeer`; the field list's `optional` gains `'ownership', 'resourceId'` after `'recipientPeer'`;
  `RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesOwnership = ['shared', 'exclusive']`; schema `ownership: { type:
  'string', enum: …messagesOwnership }, resourceId: stringSchema`; control validator: `resourceId` joins the
  `['topicId', 'orderingKey', 'handleId']` string list, and `validateEnumField(… 'ownership' …)` follows `recipientPeer`
  (messages `messages.send.resourceId must be a string.`, `messages.send.ownership must be one of shared,
  exclusive.`). Capability text adds after the recipientPeer sentence: `ownership (shared, exclusive) passes the send's
  ownership to the product as given; resourceId names the route's resource, which an exclusive send claims for the
  sending session; absent, the product mints a fresh resource per send.`
- `BlackBoxRallarMessageSendInput` gains required `ownership: ALOwnershipAlgo | undefined` and `resourceId: string |
  undefined`. Decoder: `MESSAGE_OWNERSHIPS: readonly ALOwnershipAlgo[] = ['shared', 'exclusive']`;
  `decodeOrdinarySend` decodes `ownership` with `decodeKnownSendOption(value.ownership, MESSAGE_OWNERSHIPS, 'ownership
  must be shared or exclusive')` right after the payload check (Left on an issue) and sets `ownership`, `resourceId:
  decodeBlackBoxCommandString(value.resourceId)`. `REPLAY_REFUSED_FIELDS` gains `'ownership', 'resourceId'` after
  `'recipientPeer'` (R-A2b-3). `toTypedSendOptions` forwards each when defined.
- A recipient role sends on its own connection (R-A2b-12). `alm-conformance-step-identities.ts`: private
  `isSenderPage(role)` (`sender` or `successor`); `toConnectionName` uses it; `toSendHandleId` =
  `alm-${carrier}-${scenarioKey}-${origin}send-${index}` with `origin` `''` on a sender page and `${role}-` otherwise.
  `toSendCommand`, `toObserveCommand`, `toCancelCommand`, `toReceiptsCommand`, `toSelfAbsenceCommand`,
  `toReceivedCommand` and `toPayloadWait` take `connection: toConnectionName(step)` (every existing caller passes a step
  whose role already selected that connection, so no recipe changes). `AlmConformanceSendDelivery` gains
  `ownership?`/`resourceId?`.
- `alm-conformance-receipt-commands.ts`: `export type AlmConformanceSendClaim = Readonly<{ ownership: 'exclusive';
  resourceId: string; }>`; `AlmConformanceAudienceSendInput.claim?: AlmConformanceSendClaim` spread after `audience`;
  `toReceiptWindowCommands(sender, window)` = `[toSelfAbsenceCommand(sender), ...toReceiptReadCommands(sender,
  window)]`, the new exported `toReceiptReadCommands(origin, window)` holding the receipts read and its five
  assertions.
- `world-routing.ts` exports its `RTC_REFUSAL_FACTS` and `WS_ROUTE_FACTS` (doc adds "An exclusive send takes the same
  route.") (R-A2b-17).
- `claim-commands.ts`: `CLAIM_WS_ROUTE_CARRIERS = ['ws', 'rtc-with-ws-fallback']`; private `HELD_BY_OTHER_FACTS`
  (relay-rejected / trusted-server / held-by-other / one-attempt, as `WS_NO_LEADER_FACTS`); `toClaim(step)` →
  ``{ ownership: 'exclusive', resourceId: `claim-${carrier}-${scenarioKey}` }`` (R-A2b-13); `toClaimSendCommand(step, ttlMs)`
  = `toAudienceSendCommand({ sender: step, ttlMs, ack: 'all-logical-recipients', claim })`;
  `toHeldByOtherVerdictCommands(step)`; `toClaimRouteCommands(step)` = rtc → `toVerdictCommands(step, 'rejected',
  RTC_REFUSAL_FACTS)`, else `toVerdictCommands(step, 'acknowledged', WS_ROUTE_FACTS)`; `toClaimExpiryWait(step,
  windowMs)` = `messages.received` `await-claim-expiry`, own connection, scenario typeId, `count: 2, absent: true,
  windowMs, timeoutMs: windowMs + RESPONSE_MARGIN_MS` (1 000).
- Cells (three-agent roles, `FULL_TAGS`, registered after `leaderOutsideList`, ids added to the union alphabetically):
  `claim-first-wins` (`CLAIM_WS_ROUTE_CARRIERS`, receipt roles receiver + recipient-b): sender `toAudienceSendCommands`
  (`NON_EXPIRING_TTL_MS` 30 s, claim), `toServerReceiptCommands`, receipt window (acknowledged, receiver),
  `toClaimRouteCommands` (R-A2b-18); receiver `toSingleArrivalReceiverCommands`; recipient-b `received-1` (count 1),
  `send-1` (claim, 30 s), `toHeldByOtherVerdictCommands`, `received-2` (count 2, absent, R-A2b-14).
  `claim-expires-reclaims` (`['ws']`): sender claims with `ttlMs: 3_000` (R-A2b-1), admission, then `received-1` on its
  own connection (the reclaim reaches the former holder); receiver `received-1` count 2, `received-2` count 3 absent;
  recipient-b `received-1`, `toClaimExpiryWait(…, 3_500)`, claim (30 s), admission, `received-2` count 2 absent,
  `toReceiptReadCommands` (sender + receiver confirmed, acknowledged, receiver) (R-A2b-15). `claim-refused-on-rtc`
  (`['rtc']`): sender claim + `toClaimRouteCommands`; both recipients `received-1` count 1 absent.
- Hosted: three rows after the leader rows in `HETZNER_WITHHELD_ALM_SCENARIOS`, comment `// The claim cells' lane
  evidence is local and the hosted full read's; manifest 22 stays as recorded.`, carriers from each definition.
  Manifests 18/22 stay byte-identical (the vitest byte test is the gate).

**Identity and attribution (checked).** `assessAlmConformanceIdentity` reads sends only from the sender recipe and
pins receipts only from the sender's `almReceiptRoles`; a recipient's send is neither, and `readParticipant` only needs
every authored command ok. The observation attribution reads `recipient-b`'s agent as `unattributed` already. Neither
needs a change.

**D8 reuse inspection.** `toAudienceSendCommand`, `toVerdictCommands`, the receipt window, `toConnectionName`,
world-routing's facts (exported, not copied), the `WS_NO_LEADER_FACTS` shape, `messages.received` absence as the timed
hold, the withheld-row pattern.

- [ ] **Step 1: Tests (red).** Copy the seven test edits/files. `npx vitest run packages/tests/shared-test/alm-conformance-claim.test.ts
      packages/tests/shared-test/alm-conformance-recipes.test.ts packages/tests/shared-test/alm-conformance-recipe-validation.test.ts
      packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts
      packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts
      packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts` → `Test Files  7 failed | 1 passed (8)`, `Tests  19
      failed | 204 passed (223)`.
- [ ] **Step 2: Implement.** Same command → `Test Files  8 passed (8)`, `Tests  223 passed (223)`. Wider: `/bin/ls
      packages/tests/shared-test/alm-*.test.ts packages/tests/shared-test/rallar-bb-test-*.test.ts
      packages/tests/rallar-black-box/hetzner-*.test.ts packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts
      | xargs npx vitest run` → `Test Files  68 passed (68)`, `Tests  1049 passed (1049)`.
- [ ] **Step 3: Checks.** `npx dprint fmt <the 27 files>`; `npx tsc -p packages/shared-test/tsconfig.json --noEmit` →
      clean; `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit` → clean; `deno check` on the changed
      `packages/shared-test/**` source files → clean; `cd apps/rallar-black-box-control-server && deno task check` →
      clean, then `rm -rf node_modules/.deno`; `node scripts/check-tests-typecheck.mjs` → PASS; bundles with a private
      `TMPDIR` (facade 241.880 KiB, headless 307.304 KiB, both under budget). After the commit: `npm run
      check:repo-style:changed -- 0001c2527 HEAD` → `PASS: no new repository style findings` (a new file directly under
      `conformance/alm/` fails `layout.directory-density`, 22 → 23 files; a fact or helper export added to
      `alm-conformance-message-commands.ts` fails `file.responsibility-count` at 12 — both were hit on the prototype);
      `node scripts/check-test-structure-coupling.mjs --changed 0001c2527 HEAD` → three PASS lines; `npm run
      check:test-reachability` → `1777 test files, 1771 reached by CI, 6 manual`.
- [ ] **Step 4: Commit.**

```text
Prove the exclusive claim in the ALM lane: the claim cells

messages.send names an ownership and a resourceId: the contract, the
field list, the JSON schema, the control validator, the capability
text, the browser decoder (a replay refuses both, as it refuses every
delivery field), the operation input and the typed send options. A
recipe can now put two sessions on one resource key.

A recipient role sends on its own connection: the send, observe,
cancel, receipts and received commands take the connection of the
step's role, and a recipient's handle names its role, so no handle of
a cell names two sends. The sender and its successor keep the sender's
connection and handles. The receipt window splits into the self-absence
and the receipt read, which a recipient's reclaim reads alone. An
exclusive send takes the route a world send takes, so the claim cells
read world-routing's WS route and RTC refusal facts, now exported.

The claim family runs on the three agents, full tag only:
claim-first-wins (ws, rtc-with-ws-fallback) has the sender claim a
named resource with a room send both recipients confirm over one WS
attempt with no hand-over, and recipient-b's claim on the same resource
read rejected, NACKed held-by-other by the trusted server;
claim-expires-reclaims (ws) has recipient-b hold past a 3 s claim and
reclaim, its receipt acknowledged by the sender and the receiver;
claim-refused-on-rtc (rtc) reads the exclusive send refused
unsupported with no attempt. The cells are withheld from hosted
manifests 18 and 22, which stay byte-identical.

D8 reuse: the leader cells' verdict commands and receipt window, the audience send, toConnectionName, world-routing's route and refusal facts (exported, not copied), the messages.received absence as the expiry hold, the withheld-manifest rows.
```

The lane run is Task 7's (`RALLAR_BLACK_BOX_ALM_SCOPE=full`, three-agent family); it needs Tasks 1–3 (the server's
claim and NACK, the WS route for exclusive, the RTC refusal) and runs unsandboxed.

### Task 5: AR Eye pickups claim the pickup (D176)

**Files** (anchors at the design head; Tasks 1–4 touch none of these files; the composed commit is
`final-patch-task-5.patch`, `git am`-able on Task 4 with nothing dropped (R-A2b-28); 4 files, +121/−7)

- Modify `apps/ar-eye-hunter-v1/src/game/types.ts:363` (`| 'pickup-taken'` after `'weapon-picked-up'`).
- Modify `apps/ar-eye-hunter-v1/src/game/arena-runtime/game-actions/use-arena-world-actions.ts:9-15,30-32,37-41,62-75,129`.
- Modify `apps/ar-eye-hunter-v1/src/game/arena-runtime/use-rallar-arena.ts:328` (`setActiveEvent: state.setActiveEvent,`
  before `setArenaSnapshot` in the `useArenaWorldActions` input).
- Modify test `packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts:38` (the type import gains
  `ArenaPickupState`, `PickupIntent`, one per line), `:353` (two new cases after `applies the local director %s
  intent…`), end of file (two helpers).
- Docs: `apps/ar-eye-hunter-v1/README.md:41-43` is Task 6's.

**Where the loss shows (checked).** The headline is `arena.activeEvent?.headline` (`arena-ui/arena-operations.tsx:159-161`),
the connection's `activeEvent` state (`state/use-arena-runtime-state.ts:54`, setter exported at `:240`). It is set from
director `arena-event` messages (`messages/use-arena-director-message-handler.ts:72`), from every accepted snapshot
(`state/use-arena-state-acceptance.ts:193`) and from the match runtime (`match/create-arena-match-runtime.ts:54`) —
never from the simulation's `activeEvent`, which only BabylonArena reads. The smallest local path is the existing
setter, passed into the world actions (R-A2b-19). `ArenaEventKind` has no exhaustive switch or runtime guard list
(`aiDirector.ts` keeps its own `ALLOWED_EVENTS`, which `pickup-taken` does not join).

**Interfaces.**

- Consumes Task 3: `RallarGameMatchHandle.sendIntent(intent, claim?: RallarDirectorRelayClaim)` and
  `RallarGameSendResult.status 'held-by-other'`; the app passes the claim as an object literal (no new import).
- `ArenaWorldActionsInput` gains `readonly setActiveEvent: Dispatch<SetStateAction<ArenaEvent | undefined>>;` (before
  `setArenaSnapshot`); module constant `/** As long as the director's own pickup headline stays up. */ const
  PICKUP_TAKEN_HEADLINE_MS = 2_800;` (`createSystemEvent`'s duration, `simulation.ts:1576-1578`). `sendPickupIntent`'s
  `useCallback` deps gain `input.isCurrentNetworkGeneration`.
- `sendArenaPickupIntent` (doc ``/** The intent claims its pickup, so a pickup another session claimed first comes back
  `held-by-other`. */``): same guards; `const generation = input.networkGenerationRef.current;` then
  `input.runBestEffortNetworkTask(async () => { const result = await match.sendIntent({ protocol: GAME_PROTOCOL, kind:
  'pickup-intent', intent: fullIntent }, { resourceId: intent.pickupId }); if (result.status === 'held-by-other') {
  setPickupTakenEvent(input, intent.pickupId, generation); } }, generation);`.
- `setPickupTakenEvent(input, pickupId, generation): void` (doc: `The loss is the local session's alone: it shows as the
  activity headline until the next arena event replaces it.`): reads `input.arenaSnapshotRef.current` and its pickup by
  id; returns when either is missing (R-A2b-16); else `input.setActiveEvent((previous) =>
  input.isCurrentNetworkGeneration(generation) ? event : previous)` with `event = toPickupTakenEvent(pickup,
  snapshot.revision, input.nowMs())`.
- `toPickupTakenEvent(pickup: ArenaPickupState, revision: number, nowEpochMs: number): ArenaEvent` (pure, before
  `toArenaMatchEndedMessage`): ``{ id: `pickup-taken:${pickup.id}`, kind: 'pickup-taken', position: pickup.position,
  durationMs: PICKUP_TAKEN_HEADLINE_MS, startsAtEpochMs: nowEpochMs, expiresAtEpochMs: nowEpochMs +
  PICKUP_TAKEN_HEADLINE_MS, revision, source: 'local', headline: `${pickup.label} was taken first` }``.
- Unchanged: `sentPickupIds`, the send-time impact/audio/haptic (`BabylonArena.tsx:2270-2284`),
  `startArenaMatchFromIntent`, the local-director route (`rallar-game-director-relay-runtime.ts:91-94` ignores the
  claim), `runBestEffortNetworkTask`.

**D8 reuse inspection.** The match `sendIntent` claim and `held-by-other` status (Task 3), the connection's
`activeEvent` state and setter, the director headline's duration, the snapshot's pickup label, the `isCurrent`
generation guard the director handlers use. No new state, store or notice surface.

- [ ] **Step 1: Tests (red).** In `describe('arena game realtime acceptance and egress')`: `sends a remote pickup intent
      claiming its pickup and shows a pickup another session claimed first as the activity headline`
      (`mockMatch.status.mockReturnValue(remoteDirectorMatchStatus())`, publish `pickupSnapshotFixture(Date.now()).snapshot`,
      `sendIntent.mockResolvedValueOnce({ status: 'held-by-other', transport: 'director-relay' })`, call
      `sendPickupIntent(fixture.intent)`; assert `sendIntent` called with `({ protocol: 'ar-eye-hunter.v1', kind:
      'pickup-intent', intent: { ...fixture.intent, sessionId: session.sessionId, sentAtEpochMs: expect.any(Number) } },
      { resourceId: fixture.pickup.id })`; `waitForState(kind === 'pickup-taken')`; `activeEvent` toMatchObject ``{ id:
      `pickup-taken:${pickup.id}`, kind: 'pickup-taken', position: pickup.position, revision: snapshot.revision,
      source: 'local', headline: `${pickup.label} was taken first` }``); `it.each(['sent', 'no-director', 'failed'] as
      const)('records no loss for a pickup intent whose send reads %s')` (the send resolves that status, a
      `Promise.withResolvers` marks the call; assert the claim argument and `activeEvent?.kind` not `pickup-taken`).
      Helpers at the end: `remoteDirectorMatchStatus()` = `{ ...localDirectorMatchStatus(), directorPeerId:
      'director-session' }`; `pickupSnapshotFixture(nowEpochMs)` = `toArenaSnapshot(spawnWeaponPickup(
      createInitialArenaState(44, nowEpochMs), nowEpochMs, 'audit-pea-shooter'), 'arena-1', nowEpochMs)`, its first
      pickup, and an intent `{ pickupId, sessionId: 'unset', position, seq: 1, sentAtEpochMs: 0 }`. `npx vitest run
      packages/tests/ar-eye-hunter-v1` → `Test Files  1 failed | 15 passed (16)`, `Tests  4 failed | 170 passed (174)`
      (each new case fails on the missing claim argument).
- [ ] **Step 2: Implement.** Same command → `Test Files  16 passed (16)`, `Tests  174 passed (174)`.
- [ ] **Step 3: Checks.** `npx dprint fmt <the 4 files>`; `cd apps/ar-eye-hunter-v1 && npm run typecheck` → clean;
      `node scripts/check-tests-typecheck.mjs` → PASS; `npx vitest run packages/tests/ar-eye-hunter-v1
      packages/tests/shared-web/shared-web-app-import-boundaries.test.ts` → `Test Files  17 passed (17)`, `Tests  177
      passed (177)`. After the commit: `npm run check:repo-style:changed -- 0001c2527 HEAD` → PASS; `node
      scripts/check-test-structure-coupling.mjs --changed 0001c2527 HEAD` → three PASS lines (12 candidates, all
      classified). No test file is added.
- [ ] **Step 4: Commit.**

```text
Claim the pickup an AR Eye pickup intent names

Two hunters walking onto one pickup both sent a shared intent with a
fresh resource; the director's event loop chose the winner, and the
loser's send read sent and was discarded, so the loser learned of the
loss only from the winner's headline. A pickup intent now claims its
pickup: the arena sends it with the pickup's id as the claim, so the
relay sends it exclusive on that resource and the WS server admits the
first claimant alone. The arena reads the send's result instead of
discarding it; a held-by-other result sets the activity headline to a
local pickup-taken event, "<label> was taken first", at the pickup's
position and the arena snapshot's revision, for the current network
generation only. A sent, no-director or failed result records nothing,
and the send-time feedback and the once-per-pickup send are unchanged.
The director's own pickups route locally and claim nothing.

D8 reuse: the match sendIntent claim and the held-by-other game status, the connection's active-event state and its headline, the director's pickup headline duration, the arena snapshot's pickup label.
```

### Task 6: Docs — exclusive ownership as a claim on the resource key (D171–D178)

**Files** (text anchors; line numbers at the design head, untouched by Tasks 1–5; the composed commit is
`final-patch-task-6.patch`, docs only, 8 files, +206/−23; it is the exact text: apply it with `git am -3`, then run
the "True of the code" checks, which are the only part that can fail. A mismatch is fixed in the doc, never in the
code. No plan/task/ruling ids go into the docs; decision ids do. The roadmap and the static audit are the close's.)

- `docs/rallar-api-reference.md`:
  - `### Director`, the relay paragraph: after "and `not-director` when the local session is the director." (`:515-516`)
    the claim sentences — `sendIntent(intent, { resourceId })` sends the intent `ownership: 'exclusive'` on that
    `resourceId`, over WS; a held resource returns `status: 'held-by-other'` before it reaches the director; without the
    claim the intent is shared; `match.sendIntent(intent, { resourceId })` passes the claim and returns the same
    status; outputs, heartbeats, snapshots, sync requests and a director-local intent claim nothing (D176).
  - New `### Exclusive Ownership` before `### Ordering, Repair And Resynchronization` (`:1046`): the key (room `GroupRef`
    scope + `topicId`, `contextId`, `resourceId`; D171), "The exclusive claim is decided where the WS server admits the
    send"; three bullets **Claimed** / **Held by another** / **Expired** (D175, D172: no handle state added, the
    holder's re-send moves the expiry, the drop writes no `admitted` receipt, `relay-rejected` with `{ relay:
    'trusted-server', reason: 'held-by-other' }`, `ack: 'none'` keeps `transport-accepted`, no fallback trigger, lease =
    `constraints.expiresAtMs`, no lease/renewal/release call, and "A send with no expiry of its own holds the key for
    the WS server's retention default; every browser send carries a `ttlMs`."); a paragraph on `shared` sends ("neither
    reads nor takes an exclusive claim"), the admission store beside dedup shared by every API process (D173), server
    publications, the unchanged local callback selection; a WS-only paragraph (D174: WS under every strategy but `rtc`,
    no RTC leg, no `carrierFallback`; `rtc` ends `rejected` with `failure: { kind: 'refused', reason: 'unsupported' }`;
    every room audience may be exclusive; `exclusive-requires-resource`, `exclusive-requires-room-audience`); a `ts`
    example (`messages.room<PickupIntent>`, `send(..., { ownership: 'exclusive', resourceId: pickupId })`, the
    `relay-rejected`/`held-by-other` check).
- `packages/shared/alm/inbound/README.md`: after "ends its subtree with `subtree-complete`." (`:479`) a new paragraph
  **Exclusive claims.** — "decides an exclusive claim … it is not the worker's claim on a work row"; the store's private
  `toALInboundClaimKey` (linked to `./al-inbound-admission-store.ts`) names `<applicationId>/<workspaceId>/<groupId>/
  <topicId>/<contextId>/<resourceId>` (each part URI-encoded) only for a `ws-client` source, an effective `exclusive`
  and a room `groupRef`; the row `<namespace>:claim:<key>` read beside dedup as a guarded observation, value the holder
  peer id, liveness the row's own expiry; `claimHolderPeerId`; `resolveMessageDrop` right after the duplicate check;
  `planNack`; no admitted receipt; `set-claim` with the sender as holder and the message's own deadline as expiry; the
  re-send moves it; a message with no deadline of its own holds the key until the admission's own deadline, the store's
  retention default; two claimants conflict at the commit and the loser is re-planned; `shared`, `rtc-peer` and
  `trusted-server` never read or write one (D171–D173).
- `packages/shared/alm/outbound/README.md`: a bullet before `- **The RTC room limit` (`:504`) — the RTC origin's
  `refused/unsupported` for exclusive, linking
  [`computeRtcExclusiveRefusal`](../../multicast/compute-rtc-exclusive-refusal.ts), which reads the effective ownership
  (a `qos.ownership` request wins) right after the scope refusal and names the sender's targets (D174); after the
  `no-leader` sentence ending "(D165)." (`:612-614`) the `held-by-other` ingress NACK sentence ("another session's live
  exclusive claim", D171, D175); `:987` "hands nothing over (D165)" gains ", nor does a trusted-server `held-by-other`
  relay rejection (D175)".
- `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`: `:154-156` the optional-field list gains
  `principalId`, `recipientPeer`, `ownership`, `resourceId` plus two sentences on the pass-through; `:208-210` the
  replay-refused list gains `principalId`, `recipientPeer`, `ownership`, `resourceId`, `durability`,
  `onStorageUnavailable` (R-A2b-4); after "withholds the leader cells too, so it stays as recorded." (`:376`) the `claim`
  family paragraph (resource `claim-<carrier>-<scenarioKey>`; a recipient role sends, its handle names the role), its
  three bullets (`claim-first-wins` with recipient-b's closing absence; `claim-expires-reclaims` with the sender pinning
  no receipt, the 3500 ms `messages.received` absence and recipient-b's receipt read after its own absence window;
  `claim-refused-on-rtc`) and "The hosted manifests 18 and 22 withhold the claim cells".
- `playground/alm/alm-complete-product-description.md` `## Ownership` (`:796-814`): the opening paragraph reduced to
  the room scope ("exactly one sending session holds the message's resource key in its room at a time"); the
  `**PARTIAL:**` and `**PLANNED — A2b, ownership scope:**` paragraphs replaced by one `**CURRENT — A2b, the claim on the
  resource key:**` paragraph ("an `exclusive` send the WS server admits from a client claims …", the deadline-less
  clause, D171–D178).
- `examples/director-relay/README.md`: inside the `if (!relay.status().isDirector)` block after the
  `showReconnectingDirectorState` check (`:55-57`) a claimed `sendIntent(..., { resourceId: 'north-gate' })` and its
  `held-by-other` branch; before "Director relay is for low-rate authority messages." (`:63`) a claim paragraph.
- `packages/shared-web/game/README.md` item 3 (`:39-40`): the `match.sendIntent(intent, { resourceId })` claim sentence
  (D176).
- `apps/ar-eye-hunter-v1/README.md` after "unused raw intent sends were removed." (`:43`): the pickup claim sentences
  (`{ resourceId: pickupId }`, `held-by-other`, the `pickup-taken` headline "until the next arena snapshot or director
  event replaces it", director pickups local; D176).

**True of the code (verified at composition; re-verify against the landed code).**

- Task 1: the admission store's private `toALInboundClaimKey(input)` returns the encoded
  `<app>/<workspace>/<group>/<topic>/<context>/<resource>` only for a `ws-client` source, effective `exclusive` and a
  room `groupRef`; the row key is `${namespace}:claim:<key>`, its value the holder peer id, its liveness the row
  expiry; `resolveMessageDrop` returns `held-by-other` right after the duplicate branch and passes the holder's
  re-send; `planNack` NACKs `held-by-other`; `set-claim`'s `expireAtTimestamp` is the message deadline;
  `resolveALOutboundRelayRejection` treats `held-by-other` as a trusted-server pre-receipt refusal;
  `AL_DELIVERY_FALLBACK_REFUSAL_REASONS` stays `['unsupported']`.
- Task 2: the api-v1 Deno cases prove two claimants, the holder's re-send, expiry and reclaim, a shared send on a
  claimed key, and no `admitted` receipt for a drop; the shared admission namespace stands (R-A2b-6);
  `computeRtcExclusiveRefusal` lives in `compute-rtc-exclusive-refusal.ts`, reads `effective.ownership.algo`, and is
  wired right after the scope refusal in `planOutgoingMessage`.
- Task 3: an exclusive send takes WS under `ws`, `rtc-with-ws-fallback` and `ws-then-rtc` with no `carrierFallback`;
  `rtc` ends `rejected`, `refused`/`unsupported`, no attempt; the validator codes and triggers; `group-leader` sends and
  room unicasts may be exclusive; `RallarDirectorRelayHandle.sendIntent(intent, claim?)` and `match.sendIntent(intent,
  claim?)` take `{ resourceId }`; `RallarDirectorRelaySendStatus` and `RallarGameSendResult.status` include
  `'held-by-other'`. Both `ts` snippets typecheck: paste each into a scratch
  `packages/shared-web/browser/zz-doc-snippet-check.ts` inside an `async` function with `import { rallar } from
  '@shared-web/browser/rallar.ts'` and `declare const` stubs for `pickupId`, `relay` (`RallarDirectorRelayHandle<{ seq:
  number; direction: string }, unknown>`), `nextInputSeq`, `showGateTaken`; `npx tsc -p
  packages/shared-web/tsconfig.json --noEmit 2>&1 | grep zz-doc` → no line; delete the file.
- Task 4: `messages.send` `ownership`/`resourceId` pass through and are refused beside a replay; the cells' carriers,
  resource `claim-<carrier>-<scenarioKey>`, `ttlMs: 3000`, the 3500 ms absence, the verdict facts and
  `attemptCarriers` `['ws']`; recipient-b's handle names the role; all three withheld from manifests 18 and 22.
- Task 5: the pickup intent passes `{ resourceId: intent.pickupId }`; the loss records `pickup-taken`; director
  pickups stay local.

**D8 reuse inspection.** The existing acknowledgement, relay-rejection, frozen-audience, fallback, director and
conformance-family prose of each document, extended in place; one new section heading beside Acknowledgement Modes.

- [ ] **Step 1: Apply** the patch. **Step 2: True-of-code checks** above.
- [ ] **Step 3: Format** `printf '%s\n' docs/rallar-api-reference.md packages/shared/alm/inbound/README.md
      packages/shared/alm/outbound/README.md packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
      playground/alm/alm-complete-product-description.md examples/director-relay/README.md
      apps/ar-eye-hunter-v1/README.md packages/shared-web/game/README.md | xargs npx dprint fmt` (explicit files only),
      then the same list through `xargs npx dprint check` → exit 0.
- [ ] **Step 4: Checks.** Doc pins: `rallar-api-reference.md` is read by
      `packages/tests/repo/rallar-group-documentation.test.ts` (resolves backticked file citations),
      `rallar-authoritative-mutation-guidance-integrity.test.ts`, `packages/tests/shared-web/rallar-group-public-contracts.test.ts`
      and `apps/api-v1/test/swagger-routes.test.ts`; no test pins the other seven files. `npx vitest run
      packages/tests/repo packages/tests/shared-web/rallar-group-public-contracts.test.ts` → `Test Files  92 passed
      (92)`, `Tests  1230 passed (1230)`; `cd apps/api-v1 && deno test --allow-all test/swagger-routes.test.ts` → `14
      passed | 0 failed`, then `rm -rf apps/api-v1/node_modules/.deno`; after the commit `npm run
      check:repo-style:changed -- 0001c2527 HEAD` (PASS) and `node scripts/check-test-structure-coupling.mjs --changed
      0001c2527 HEAD` (PASS).
- [ ] **Step 5: Commit** (the message kept verbatim):

```text
Document exclusive ownership as a claim on the resource key

The API reference gains an Exclusive Ownership section: an exclusive
send claims the room-scoped resource key (the room's GroupRef scope with
the route topic, context and resource) for the sending session; the
three outcomes (claimed is the admission, held-by-other a trusted-server
relay rejection that is no fallback trigger, expired the message's own
lifetime with no lease constant, renewal or release call); shared sends
untouched; the claim in the WS server's admission store, cluster-wide;
WS-only with the RTC origin's unsupported refusal; the two validator
issues; and an example. The director paragraph states the relay's and
the game match's claim on sendIntent and the held-by-other status. The
inbound README states the claim key, the ws-client read beside dedup,
the planner's held-by-other drop and NACK and the set-claim mutation
with the message deadline; the outbound README the held-by-other ingress
NACK, the RTC origin's exclusive refusal and no fallback trigger. The
black-box schema doc gains ownership and resourceId on messages.send and
the claim family's three cells. The product description's Ownership
section becomes current with the room scope only; the director-relay
example, the game runtime README and the AR Eye README state the claim
and the held-by-other outcome.

D8 reuse: the existing acknowledgement, relay-rejection, frozen-audience, fallback, director and conformance-family prose of each document, extended in place; one new section heading beside Acknowledgement Modes.
```

### Task 7: Close

Pins unchanged and bundles measured; the static merge bar; `npm run test:postgres:integration` (the admission store
gained a key family read and written on the PGlite and Postgres backends); the conformance lane for the `claim`
scenarios over `ws`, `rtc` and `rtc-with-ws-fallback`; the three-seat final review BEFORE one fix wave; push; the
Branch Release Gate green on the code head; hosted manifests 18 and 22 dispatched from the branch; the PR body; the
close commit with the delivered lines; this plan file deleted.

- [ ] **Step 1: Pins and bundles.** `npx vitest run` the four pins (`al-indexeddb-transaction-ledger`,
      `al-indexeddb-operation-counts`, `al-storage-snapshot`, `al-indexeddb-empty-audience-counts` under
      `packages/tests/shared/alm/`) → `Tests  27 passed (27)`, no pin file in `git diff --stat origin/main HEAD`.
      Bundles with a private `TMPDIR`: `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
      (`browser/rallar.ts` 241.880 KiB of 242 at composition) and `headless-bundle-boundary.test.ts` (307.304 KiB of 308
      at composition); a crossed budget rises to the next whole KiB, named in the PR body.
- [ ] **Step 2: Static merge bar.** `npm run typecheck`; `npm run build`; `npm run check:repo-style:changed --
      origin/main HEAD` (read the verdict line) and `node scripts/check-test-structure-coupling.mjs --changed
      origin/main HEAD`; `npm run check:test-reachability` (`1777 test files, 1771 reached by CI, 6 manual` at
      composition); `git diff --name-only origin/main HEAD | xargs npx dprint check`; `node --import tsx
      apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check` → `checked 67 Hetzner distributed
      manifest(s)` and `git diff --stat origin/main HEAD -- apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json
      apps/rallar-black-box/manifests/hetzner/22-alm-conformance-3-agent.json` empty; `cd apps/api-v1 && deno task check
      && deno test --allow-all test/` then `rm -rf apps/api-v1/node_modules/.deno`; `cd
      apps/rallar-black-box-control-server && deno task check` then `rm -rf node_modules/.deno`; `cd apps/ar-eye-hunter-v1
      && npm run typecheck`.
- [ ] **Step 3: Postgres integration.** With the test Postgres up (`docker ps` first; `npm run db:test:up` only from
      this worktree), run `npm run test:postgres:integration` unsandboxed; name every red from its output.
- [ ] **Step 4: The conformance lane, unsandboxed on private ports.** `lsof -i :18480 -i :5480 -i :5481` first, so no
      other session's server is reused; then `VITE_RALLAR_API_BASE_URL=http://localhost:18480
      VITE_RALLAR_SPA_BASE_URL=http://localhost:5480 RALLAR_BLACK_BOX_CONTROL_BASE_URL=http://127.0.0.1:5481
      RALLAR_BLACK_BOX_ALM_SCOPE=full npm run test:rallar:full-stack:memory:alm -- -g "three-agent family"` (all three
      carriers; `RALLAR_BLACK_BOX_ALM_CARRIERS=ws|rtc|rtc-with-ws-fallback` runs one). Expected: `three-agent family over
      ws (full)`, `… over rtc (full)` and `… over rtc-with-ws-fallback (full)` pass, with `claim-first-wins` on `ws` and
      `rtc-with-ws-fallback` (sender acknowledged, `attemptCarriers` `['ws']`, no `carrierFallback`; recipient-b
      `rejected`, `relay-rejected`/`trusted-server`/`held-by-other`, 1 attempt), `claim-expires-reclaims` on `ws`
      (recipient-b's reclaim acknowledged by the sender and the receiver) and `claim-refused-on-rtc` on `rtc`
      (`rejected`, `refused`/`unsupported`, 0 attempts), beside the existing three-agent cells. Diagnose a red cell from
      its artifact; a late 3 s claim on a loaded runner is R-A2b-15's risk.
- [ ] **Step 5: Final review, then one fix wave.** Three seats (product: the claim's meaning, lease and surfacing
      against D171–D178, the relay and the AR Eye loss; harness: the `claim` family, the sending recipient, the receipt
      read split, the withheld cells and the manifests; code quality: the code standard, D3, D8, one effective-ownership
      predicate per side, the admission transaction's read → compute → validate → write, one name per type) review the
      branch head before any fix; the controller rules on every finding and applies one fix wave; any fix reruns its
      task's checks and Steps 1–2.
- [ ] **Step 6: Push and gates.** Push the branch; the Branch Release Gate (`gh run list --branch <branch>`) and the
      API-v1 black-box gates (including `test:api-v1:black-box:postgres:medium-scale`, the admission transaction
      changed) green on the code head; rerun a known flake once with `--failed` before diagnosing it.
- [ ] **Step 7: Hosted manifests 18 and 22 from the branch.** `gh workflow run hetzner-distributed-recipe.yml --ref
      <branch> -f ref=<branch> -f rollout_before_run=true -f
      manifest_path=apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json`, and the same with
      `22-alm-conformance-3-agent.json`; both are regression reads (the `claim` cells are withheld); diagnose a red from
      its artifacts.
- [ ] **Step 8: PR body.** Goal; Changes per task; Public surface (`held-by-other` in `ALMessageDropReasonCode`,
      `AL_MESSAGE_DROP_REASON_CODES`, `ALNackReason` and the trusted-server `ALDeliveryRelayRejection`;
      `ALMessagePlanningObservations.claimHolderPeerId`; the admission observation `claim` and mutation `set-claim`;
      `computeRtcExclusiveRefusal`; `isExclusiveSendInput`; the validator codes `exclusive-requires-resource` and
      `exclusive-requires-room-audience`; `RallarDirectorRelayClaim`; `sendIntent(intent, claim?)` on the relay handle
      and the match; `'held-by-other'` in `RallarDirectorRelaySendStatus` and `RallarGameSendResult.status`;
      `messages.send` `ownership` and `resourceId`; the headless budget 307 → 308); Acceptance; Validation with every red
      named; Rulings R-A2b-1 to R-A2b-31 and any the review adds; Corrections (this plan's list); Limits (this plan's
      list); Risk and rollback; Follow-ups (other ownership scopes; claims by server publications; a release call or a
      claim event if a consumer needs one; an ingress refusal for a deadline-less exclusive message if R-A2b-20 bites;
      a multi-process claim pin). End the body with the Claude Code attribution line.
- [ ] **Step 9: The close commit.** In `playground/alm/alm-improvement-plan.md`: the consumer row `| 6 A1, A2 |`
      gains "Delivered (A2b, `<head>`; #<pr>)." in its AR Eye column after "Delivered (A2a, `d1d10db`; #647)."; the
      "Releases 4 to 8" map row `| 6 A2    |` replaces "A2b open." in its outcome column with "Delivered (A2b, `<head>`;
      #<pr>)."; the reuse table's `| Exclusive claims |` row reads "the WS server's admission store: a claim key beside
      dedup whose lease is the message's lifetime" in its existing-owner column (R-A2b-30); the fresh-session paragraph
      records A2b as delivered (#<pr> as `<head>`, from `alm-a2b-design-proposal.md`, D171–D178; its plan file deleted
      with the close), which completes Release 6, and names Release 7 V1 (aggregate budgets and long-run fairness) as
      the next slice; the revision history gains an entry "<merge date> (A2b delivered): #<pr> as `<head>`; the release
      map row, the consumer row, the reuse table's claim row, the F16 and PC7 rows and the fresh-session paragraph record
      it; Release 6 is complete and V1 is next."; the requirement matrix's `| PC7 supported target and ACK semantics |`
      row reads "Delivered: audiences with carrier parity (A1), the group-leader mode (A2a) and exclusive ownership as a
      claim on the room-scoped resource key (A2b, #<pr>)." with its owner column `A1, A2`. In
      `playground/alm/alm-static-audit.md` the status table's `| F16 |` line records ownership as delivered (A2b) beside
      fencing (R2), audiences (A1) and the leader ACK (A2a), leaving correlation open (`I1`). Delete this plan file in
      the same commit. Never a blank line inside a table; `npx dprint fmt` the two files.
