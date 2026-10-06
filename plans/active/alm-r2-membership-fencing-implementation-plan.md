# ALM R2: membership fencing on the roster — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven development with test-driven development:
> one implementer per task, the failing tests first, the controller reviews and commits, one commit
> per task, a three-seat final review with one fix wave before the close. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Deliver Release 5, R2 (D143 to D149, `playground/alm/alm-r2-design-proposal.md`). Every
room send carries the sender's roster version beside the snapshot floor; a receiver behind it catches
up through the existing `not-yet-in-sync` path, and a receiver at or beyond it refuses a sender gone
from its roster with the typed verdict `membership-fenced`, NACKed on both carriers and terminal on
the sender's handle. The envelope version bumps to `v: 3` through one constant, the browser schema
id bumps, and the caller-invented `membershipEpoch` is deleted everywhere. The lane gains a
three-agent `membership-fence` family over `ws` and `rtc`; AR Eye Hunter's match-start notification
is pinned as fenced by construction; Relic's ordered rounds are carried to slice R2b.

**Spec:** `playground/alm/alm-r2-design-proposal.md`; decisions D143–D149 in
`playground/alm/alm-improvement-plan.md`.

## Global constraints

- **The maintainer's notes stand: "No legacy, avoid duplication, no migration code, keep the repo
  consistent, prefer existing patterns."** The wire cutover is one step (D3): `v: 3`; a `v: 2`
  envelope is refused `unsupported` in both directions until the peer reloads. The schema id bumps
  once (D147); no row is migrated. `membershipEpoch` survives nowhere (D143).
- **D8 reuse first.** Named reuses, each verified at `file:line` by its task: the room state store's
  floor resolver and its composition wiring; `resolveRoomSessionDenial` and the RTC admission's
  denial ordering; the `not-yet-in-sync` plan mapping, NACK and refresh trigger; the WS authorizer's
  floor branch and `toPolicyDeniedDecision`; the advisory NACK; the control admission's
  trusted-server refusal and relay-rejected facts; the lifecycle's `relay-rejected` and
  `hop-refused`; the three-agent lane family, the WS/RTC hold faults and the leave/rejoin steps; the
  hosted withholding list; the control-server fixture's `route()`. Every task carries a D8 reuse
  inspection paragraph and its commit one `D8 reuse:` line.
- **No guarantee weakens.** The ledger, cold, inbound, D55 and checkpoint pins stay unedited; the
  snapshot floor (D26) and the frozen audience stay; the WS server keeps its ordering gate and NACKs
  (D49, D50); presence is not the roster (an absent session with a present member stays `pending`).
- **Code standard** (`.agents/skills/rallar-code-writing/references/repo-code-style.md`): canonical
  verbs; functions ≤40 lines; ≤3 positional parameters; `interface` for object contracts; required
  fields by default (`rosterVersion` is optional only because absence means "no room snapshot was
  cached at the sender", stated in its doc line); `Either` for expected failure; kebab-case filenames
  after the primary export; no role folders; no comments but invariants, external constraints and
  tradeoffs; no plan, decision, task, PR or ruling id in code or tests; one canonical name per type,
  no renaming alias. A widened union's consumers are swept by enumeration.
- **Formatting:** `npx dprint fmt <explicit file list>` on touched files only.
- **Per-task checks:** the focused Vitest files; `npx tsc -p packages/shared/tsconfig.json --noEmit`;
  the shared-web, shared-server and shared-test typechecks; `deno check` from the repo root on every
  changed `packages/shared/**` and `packages/shared-test/**` file (then
  `rm -rf apps/api-v1/node_modules/.deno`); `node scripts/check-tests-typecheck.mjs`; the four pins
  (`al-indexeddb-transaction-ledger`, `al-indexeddb-operation-counts`, `al-storage-snapshot`,
  `al-indexeddb-empty-audience-counts`); the bundle checks with a private `TMPDIR` after any
  `packages/shared` or `shared-web` change (budgets: `browser/rallar.ts` 239, headless 305; a crossed
  budget rises to the next whole KiB with the figure in the commit message); for a public shared-web
  surface change `shared-web-public-api-snapshots.test.ts` and
  `shared-web-browser-bundle-boundaries.test.ts`; after the commit
  `npm run check:repo-style:changed -- origin/main HEAD`,
  `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD` and, when a test file
  is added or deleted, `npm run check:test-reachability`; `npm run test:postgres:integration` is owed
  by a task that changes `alm/inbound/**` or `ws-queue-box-server/**` source where a Postgres is
  available, and is otherwise read from CI's Postgres integration lane; a `ws-queue-box-server/**`
  change also runs `npm run test:api-v1:black-box:postgres:medium-scale` once at the close (D76).
- **Sandbox notes.** Known reds unrelated to this plan: `ws-room-provenance-delivery.test.ts` (one
  race case), `headless-worker-script.test.ts`; 5 s load timeouts in pglite suites that pass alone;
  `cd apps/api-v1 && deno task check` may fail on import-map discovery here (CI runs it). `git fetch`
  and `gh` need the sandbox off.
- **Git.** One commit per task with one `D8 reuse:` line and no attribution lines; the controller
  commits and pushes after review; never `git stash`; the PR body is written at the close.

## File structure

| Area                      | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract and version (1)  | `packages/shared/al-contracts/al-contract.ts`, `al-message-persistence-validation.ts`, `al-message-persistence/assert-persisted-al-targets.ts`, `al-control.ts`, `al-control-value-codec.ts`, `al-policy.ts`; `packages/shared/alm/inbound/validate-al-inbound-message.ts`, `alm/delivery/al-delivery-lifecycle.ts`, `alm/open-indexed-db-admission-database.ts`, `alm/inbound/README.md`; `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts`; `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts`; the 22 production envelope stamps, 122 fixture files and 18 black-box recipes; `scripts/repo-style-check/reviewed-dispositions.mjs`; `packages/tests/shared/al-contracts/al-room-roster-targets.test.ts` (new) |
| The sender (2)            | `packages/shared-web/browser/rooms/room-state-store.ts`, `composition/browser-communication-composition.ts`, `messages/browser-rallar-messages-controller.ts`, `browser-rallar-message-sender.ts`, `rallar-message-contracts.ts`, `browser-message-input-validator.ts`, `validate-browser-rtc-peer-send.ts`; `packages/shared-web/bundle-budgets.json`; the harness's `black-box-runner/browser/**` send paths; `docs/test-structure-coupling-exceptions.md`                                                                                                                                                                                                                                                                                          |
| The RTC receiver (3)      | `packages/shared/multicast/resolve-rtc-room-peer-denial.ts` (new), `rtc-room-snapshot-admission.ts`; `packages/shared/alm/inbound/al-inbound-effect-intent.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The WS server (4)         | `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts`, `router/decode-rallar-server-ws-ingress.ts`, `websocket/ws-topic-room-authorizer.ts`; `apps/api-v1/test/services/ws-room-authority-delivery.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The sender's handle (5)   | `packages/shared/alm/outbound/control/resolve-al-outbound-relay-rejection.ts` (new), `compute-al-outbound-control-admission.ts`, `validate-al-outbound-control-admission.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The lane (6)              | `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/membership-fence/{fenced-delivery,fenced-catch-up,fenced-rejection}.ts` (new), `scenarios/not-yet-in-sync.ts`, `alm-conformance-roles.ts`, `alm-conformance-session-commands.ts`, `create-alm-conformance-recipes.ts`, `alm-conformance-scenario-definition.ts`; `black-box-rallar-typed-channels.ts`; `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`; the harness docs; the control-server fixture; `packages/tests/shared-test/alm-conformance-membership-fence.test.ts` (new)                                                                                                                                                                                  |
| Consumer pin and docs (7) | `packages/tests/shared-web/messages/rallar-facade-test-runtime.ts` (new); the sender, relay and arena tests; `docs/rallar-api-reference.md`, the inbound, outbound and browser READMEs, the product description, the roadmap's consumer row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Close (8)                 | the pins, the gates, the live lane, the review, the PR body, this file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Task order

1 (contract and version) → 2 (the sender) → 3 (the RTC receiver) → 4 (the WS server) → 5 (the sender's handle) → 6
(the lane) → 7 (consumer pin and docs) → 8 (close). Every task compiles against Task 1's contract. Task 5 settles the
NACKs Tasks 3 and 4 send, and its recovery case extends Task 3's (both edit
`packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts`). Task 2 raises the facade budget to 240, which
Tasks 3 and 5 measure against. Task 6's pins and fixture stand alone; its cells run live only on 2–5. Task 7's pins
assert Task 2's stamp and its runtime extracts the sender test Task 2 edits. The base of every changed-range gate in
the task texts is `90425bdf8`.

## Rulings

- **R-R2-1:** Production reads `AL_MESSAGE_ENVELOPE_VERSION`; test fixtures and black-box JSON recipes carry the
  literal `3` (recipes cannot import; the #521 precedent). The sweep is 162 files (22 production, 122 fixtures, 18
  recipes), enumerated by `git grep -nE '(^|[^a-zA-Z_.])v: 2([^0-9]|$)|"v": ?2([^0-9]|$)' -- packages apps tests`.
  _Cost if wrong:_ the next bump re-sweeps ~140 fixtures.
- **R-R2-2:** Pre-existing `boundary.unknown` findings in the four files the version sweep touches only by a literal
  (`GroupPresenceSummaryEntryContract.ts`, `activation-status-clock-outbox-entry.ts`,
  `ws-queue-box-server-addressed-receipts.test.ts`, `tests/playwright/relic-hunters/web.spec.ts`; 29 findings) join
  `scripts/repo-style-check/reviewed-dispositions.mjs` (21 entries), as R1 did for its touched decoders; typing a
  nine-owner persisted decoder family and a Playwright mock backend is not R2's closure. The final review may
  contest it. _Cost if wrong:_ a follow-up types those files.
- **R-R2-3:** The dead `readALMulticastTargetGroupRef` is deleted and `toALGroupRef` is unexported so
  `al-contract.ts` stays under the 12-export review line. _Cost if wrong:_ none, no callers.
- **R-R2-4:** `RoomSendFence { minSnapshotVersion: number | undefined; rosterVersion: number | undefined }` lives in
  `packages/shared-web/browser/rooms/room-state-store.ts` beside the resolver that yields it; the sender, the
  messages controller and the harness composition import it type-only. _Cost if wrong:_ the type moves.
- **R-R2-5:** With no cached snapshot, an explicit floor travels alone and no roster is stamped (the existing
  explicit-floor semantics). _Cost if wrong:_ harness absolute floors on an uncached sender carry no roster floor.
- **R-R2-6:** `membership-fenced` maps to the outbound drop code `unauthorized`: the origin's own admission has no
  `fromPeerId` and cannot produce the fenced verdict. _Cost if wrong:_ an origin-side fence would read `unauthorized`.
- **R-R2-7:** The fallback test keeps its title (three registry `semanticCoverage` references name it).
  _Cost if wrong:_ a three-line registry edit.
- **R-R2-8:** The roster stamp covers the multicast and the room broadcast only; a room-naming unicast (a peer send,
  a WS `peerId` send) carries none — a carried limit. _Cost if wrong:_ a later slice adds it with a schema bump.
- **R-R2-9:** The `al-indexeddb-operation-counts` pin's one fixture id moves `v: 2` → `v: 3`; its counts are
  unedited, and "pins unchanged" means the counts. _Cost if wrong:_ none.
- **R-R2-10:** The inbound README's roster-fence window states that a server row an older build wrote fails strict
  decoding `unsupported` at its next read and that no row is migrated; per-row-kind TTLs are not enumerated (as the
  range-repair window did not). _Cost if wrong:_ a README paragraph.
- **R-R2-11:** The facade bundle budget rises 239 → 240 at Task 2 (239.024 KiB measured); headless stays 305.
- **R-R2-12:** A missing room cache with a roster stamp is `not-yet-in-sync` (as a missing cache with a snapshot
  floor is today). _Cost if wrong:_ a retained retry instead of a refusal, bounded by the deadline.
- **R-R2-13:** On WS the policy codes `member-not-active`, `member-removed` and `member-banned` map to
  `membership-fenced`; every other denial stays `unauthorized`. A member with no live session is therefore
  `membership-fenced` at the server (its presence is the server's own authority and the case was terminal
  `unauthorized` before), while the RTC receiver keeps an absent session with a present member `pending` (its
  presence view may lag). The asymmetry is stated in the inbound README and the Limits. _Cost if wrong:_ a
  twelve-line authorizer change makes the server answer `pending`.
- **R-R2-14:** The server's local refusal code stays `unauthorized`; the advisory NACK carries `membership-fenced`;
  every policy denial's log message names its NACK reason. _Cost if wrong:_ a log line.
- **R-R2-15 (design correction, proposal §2.b and §5):** a fenced send from a recreated group's previous
  incarnation is not refused with a reason on either carrier: its roster stamp is ahead of the new roster forever,
  so the WS server retains it `not-yet-in-sync` until the message deadline and the RTC receiver NACKs
  `not-yet-in-sync` after each refresh until the sender's retry budget exhausts into the fallback trigger. The
  proposal's "refused when its sender is not in the new roster" is corrected in the plan commit. _Cost if wrong:_
  a deadline's worth of retained retries for a message nobody can deliver.
- **R-R2-16 (amends D148):** the lane's roster moves by a self-service leave (`leave-roster`, status `left`; the
  next cell's ensure-member rejoins), never by an owner removal: group ownership in the three-agent lane is a race
  (every role POSTs ensure-group, 409 accepted), only an owner or admin may remove, a recipient cannot name the
  sender's principal in an HTTP path, and a removed member cannot rejoin itself (`member-removed`). Tasks 3 and 4
  pin `removed`/`banned` in units. _Cost if wrong:_ the lane proves the fence on a member who left, not one removed.
- **R-R2-17 (amends D148):** `fenced-rejection` runs over `ws` only: no harness step holds a page's incoming
  group-state updates (the fault port decides outgoing AL frames only) and an RTC sender re-checks its own room
  authority on every attempt, so a sender whose cache shows its leave refuses locally and no stale fenced frame can
  reach an RTC receiver from the lane. The RTC fenced NACK and the peer relay rejection are unit pins (Tasks 3, 5);
  the overlay's re-plan on a membership change is untested in the lane. _Cost if wrong:_ "both carriers" is lane-proven
  for `ws` and unit-proven for `rtc`.
- **R-R2-18 (amends D148 and the proposal §2.c/§2.f; corrected by R-R2-35):** `fenced-catch-up` sends with the
  harness floor `aboveCurrentBy: 1`, cues after the refusal's NACK reaches the sender, and recipient-b leaves as the
  move. Over `rtc` the catch-up rides the sender's NACK retries (3 × 50 ms) and then its ACK-timeout retries
  (2 000 ms) inside the receipt budget, and the receiver's cache advances by its live WS update or its refresh
  before a retry lands; the cue waits for the committed NACK. Over `ws` the server retains the floored send at
  ingress as a pending admission (`retainPending`), answers the advisory NACK and re-authorizes the send every
  50 ms until the floor is met or the deadline passes; the sender retries nothing and leaves the NACK unhandled, so
  the cue waits for the NACK's arrival. The cell proves behind → catch-up → delivery on the snapshot floor; the roster
  floor is a unit pin (Task 3). The proposal's "retained admission" sentence is corrected in the plan commit.
  _Cost if wrong:_ a receive-side WS fault on the client (product code and bundle bytes) would be needed to prove
  the roster floor live.
- **R-R2-19:** the harness's received-message event states `rosterVersion` after `typeId`; the room's roster is read
  with a plain `GET .../groups/<groupId>`; no new command kind. _Cost if wrong:_ low.
- **R-R2-20:** `fenced-catch-up` asserts no final handle state on the sender (over `rtc` the frozen audience still
  holds recipient-b, whose copy becomes `no-targets` after it leaves, so the receipt never completes); the sender's
  evidence is the committed NACK, the receiver's the arrival. _Cost if wrong:_ weaker than an assertion that proved
  nothing.
- **R-R2-21 (reverses W-D's D6):** the relay and arena pins (Task 7) do not copy the real-facade test setup a third
  time; they import the existing fixture module (`packages/tests/shared-web/messages/browser-message-sender-fixture.ts`,
  which Task 2 edits) or the one it is extracted into. _Cost if wrong:_ one fixture file.
- **R-R2-22:** style-gate shapes stand: `toSelfMembershipCommand(step, 'active' | 'left')` replaces
  `toEnsureMemberCommand` (the session-commands file stays at 11 exports); the roster read and the stamp wait stay
  private to `fenced-delivery.ts` (`conformance/alm/` stays at 22 files); the four pre-existing `boundary.unknown`
  findings in `hetzner-distributed-manifests.test.ts` are fixed with `RallarBlackBoxTestRecord` and `decodeStringLeaves`.
- **R-R2-23:** the family is withheld from hosted manifest 22 for function, not only byte identity: the combined
  hosted recipe keeps one prologue, so a leave would carry into every later cell.
- **R-R2-24 (refines D145, Task 3):** on RTC an absent sender session with a present member is `pending` at the
  stamp and `membership-fenced` in a roster beyond it (an authoritative snapshot lists live sessions of active
  members only, so a later roster without the session reads as a departure); the fence outranks a pending self, relay
  or recipient. _Cost if wrong:_ a departed sender's late copy waits instead of being refused, or the reverse.
- **R-R2-25:** Task 3 splits the admission's peer denial into `packages/shared/multicast/resolve-rtc-room-peer-denial.ts`
  (the admission file would reach the cognitive-load warn tier); `RtcRoomRosterPosition = 'behind' | 'at' | 'beyond' |
  'unstamped'` lives there. _Cost if wrong:_ one file moves back.
- **R-R2-26:** a proxied (`origin: 'proxy'`) room publication gets the roster floor as it gets the snapshot floor;
  server-originated publications stay unfenced (D146). _Cost if wrong:_ a proxy stamp waits instead of passing.
- **R-R2-21 (restated for execution order):** Task 7 runs after Task 2, so it extracts the sender test's real-facade
  scaffolding into one shared test module under `packages/tests/shared-web/messages/` and the sender, relay and arena
  tests import it; no third copy.
- **R-R2-27:** one resolver `resolveALOutboundRelayRejection(read)` in
  `packages/shared/alm/outbound/control/resolve-al-outbound-relay-rejection.ts` (beside the receipt-exhausted fact
  builder) decides which NACK refuses the whole send — a relay's `resync-required` whatever the receipt, and before any
  receipt row a `membership-fenced` refusal from the trusted server or from a peer the send owes, or the trusted
  server's `unauthorized` — and `toALOutboundRelayRejectedFact` builds the one fact; the control validation reads the
  resolver to waive the expected-peer check for the trusted server alone; `isTerminalNack` includes
  `membership-fenced`. _Cost if wrong:_ the three replaced functions return.
- **R-R2-28:** a trusted-server rejection's detail reads "The server relay refused the message: <reason>." for every
  reason (the `unauthorized` text changes in two fixtures). _Cost if wrong:_ a detail string.
- **R-R2-29 (limit):** on RTC a peer's `membership-fenced` NACK reaches the sender's handle only through a tracked
  receipt: before a receipt row exists a peer's NACK is admitted only from the unicast addressee or a composition hop,
  and an RTC room send names no hop (`validate-al-outbound-control-admission.ts:49`); a receipt-less RTC room send
  (`ack: none`) never hears the fence, and a receipted one reads `failed` / `receipt-exhausted` / `hop-refused` with
  `nackReason: 'membership-fenced'`, not `relay-rejected`. The trust is not widened (any peer could otherwise fail any
  receipt-less room send). _Cost if wrong:_ a widened peer trust.
- **R-R2-30 (limit):** a removed sender's own sends are held pending at its origin until the deadline (its own
  snapshot lacks its session after the removal); today's behaviour, stated. _Cost if wrong:_ none, a doc line.
- **R-R2-31:** `relay-rejected` settles the handle in state `rejected`, not `failed`
  (`compute-al-delivery-lifecycle.ts:289`); docs and the lane assert `rejected`. _Cost if wrong:_ a doc word.
- **R-R2-32:** the fence applies at ingress only (`fromPeerId` defined); the origin, targeted repair and held copies
  keep today's verdicts; a fenced NACK carries no ordering hints and requests no repair; the fenced diagnostic is
  `outcome: 'rejected'` with `membership-fenced: <denial>` and triggers no refresh. _Cost if wrong:_ one predicate.
- **R-R2-33 (assembler):** R-R2-21 is carried by `packages/tests/shared-web/messages/rallar-facade-test-runtime.ts`
  (the repo's `*-test-runtime.ts` shape): the hoisted doubles, the three module mocks and four exports —
  `readRallarFacadeMocks`, `resetRallarFacadeTestRuntime`, `setRallarFacadeRoomSnapshots` (the sender test's
  `mockGroupSnapshots`, moved) and `createRallarTestFacade` (over `composition/create-rallar-facade.ts`, which the AR
  Eye Hunter harness does not mock). The sender, relay and arena tests import it; no copy remains. _Cost if wrong:_ the
  runtime's names change.

## Limits (carried; Task 8 states them in the PR body)

- The lane proves the fenced rejection over `ws` only; the RTC fenced NACK and the peer relay rejection are unit pins
  (R-R2-17).
- `fenced-catch-up` proves behind → catch-up → delivery on the snapshot floor; the roster floor is a unit pin
  (R-R2-18). A room send the WS server retains behind a floor starts no receipt aggregate (its audience is unknown
  until the replay authorizes it), so its `receiver` receipt never completes and its recipients' ACKs count nothing
  (R-R2-35). The lane's roster moves by a self-service leave; `removed` and `banned` are unit pins (R-R2-16).
- A recreated group id: a send from the previous incarnation is never refused with a reason; the WS server holds it
  `not-yet-in-sync` to its deadline and the RTC receiver NACKs it until the sender's retry budget exhausts (R-R2-15).
- A room-naming unicast (a peer send, a WS `peerId` send) carries no roster stamp (R-R2-8).
- The absent-session asymmetry: on RTC a sender with no session but an active member waits at its own roster and is
  fenced only in a roster beyond its stamp; the WS server fences it at once (R-R2-13, R-R2-24).
- On RTC a peer's `membership-fenced` NACK reaches the sender's handle only through a tracked receipt (`failed`,
  `receipt-exhausted`, `hop-refused`); a receipt-less RTC room send (`ack: 'none'`) never hears it (R-R2-29).
- A removed sender's own sends are held pending at its origin until their deadline (R-R2-30).
- Server-originated room publications are unfenced, and the receiving WS client does not check a trusted-server
  delivery (D146, R-R2-26).
- A dispatch-time server refusal reaches no handle: the server completes the delivery without a NACK when the sender
  left between admission and dispatch.
- No browser setter for `ordering.epoch`: a track closes by its TTL or the receiver's resynchronization.
- Hosted manifests 18 and 22 withhold the `membership-fence` family; it runs locally and in the observation's full
  read (R-R2-23).
- 21 reviewed dispositions cover pre-existing `boundary.unknown` findings in four files the version sweep touched
  (R-R2-2).
- Relic's round transitions on an ordering key per round move to R2b.

### Task 1: The contract and the version (D143, D147)

**Files** (anchors at the plan's base `90425bdf8`)

- Modify `packages/shared/al-contracts/al-contract.ts`: before `ALMessageId` (`:9`) add
  `export const AL_MESSAGE_ENVELOPE_VERSION = 3 as const;` with the doc line "The one envelope version this build
  stamps and accepts; a decoder refuses any other as `unsupported`." (`as const` keeps the literal type where an id
  is built without a contextual type); `ALMessageId.v` (`:10`) becomes `typeof AL_MESSAGE_ENVELOPE_VERSION`. Multicast
  targets (`:42`): `membershipEpoch?` goes, `rosterVersion?: number` follows `minSnapshotVersion?`; broadcast targets
  (`:57`) gain `rosterVersion?: number` after `minSnapshotVersion?`. Both carry the doc line "The sender's cached room
  roster; absent when it held no room snapshot, and a receiver applies no roster floor." `ALOrdering.epoch`'s comment
  (`:88`) reads "ordering track epoch". `buildALMessage` stamps `v: AL_MESSAGE_ENVELOPE_VERSION` (`:215`).
  `newALMulticastMessage` options (`:279`): `rosterVersion?` replaces `membershipEpoch?`; targets (`:304-307`) write
  `minSnapshotVersion` then `rosterVersion`; the ordering block (`:324-334`) opens only on `seq` or `orderingKey` and
  writes `{ orderingKey: options?.orderingKey ?? toALGroupTargetKey(targetGroupRef), seq: options?.seq }` (no `epoch`).
  `newALBroadcastMessage` options (`:418`) and targets (`:431-436`) gain `rosterVersion` after `minSnapshotVersion`.
  Delete `readALMulticastTargetGroupRef` (`:364-371`, no caller anywhere) and drop `export` from `toALGroupRef`
  (`:344`, used only in this file): the new constant otherwise lifts the file to 12 runtime exports
  (`file.responsibility-count`, a changed-gate failure).
- Modify `al-contracts/al-message-persistence-validation.ts`: import the constant beside `type ALMessage`; the version
  gate (`:78`) and `assertId` (`:190`) compare with `AL_MESSAGE_ENVELOPE_VERSION`. The left stays
  `{ code: 'unsupported', message: 'AL envelope version is unsupported' }`.
- Modify `al-contracts/al-message-persistence/assert-persisted-al-targets.ts`: multicast field list (`:35`)
  `['mode', 'groupRef', 'minSnapshotVersion', 'rosterVersion', 'recipientPeerIds', 'snapshotVersion']`; `:39` becomes
  `requireOptionalPersistedALSafeInteger(targets.rosterVersion, 1, 'roster version')` after the minimum-snapshot line;
  the broadcast list (`:52-63`) gains `'rosterVersion'` after `'minSnapshotVersion'`, checked the same way at its end.
- Modify `alm/inbound/validate-al-inbound-message.ts:53-55`: delete the `membershipEpoch` `unsupported` branch.
- Modify `al-contracts/al-control.ts:37-38` (`ALNackReason` gains `| 'membership-fenced'`),
  `al-control-value-codec.ts:272-277` (`decodeNackReason` accepts it), `al-policy.ts:230-252`
  (`ALMessageDropReasonCode` and `AL_MESSAGE_DROP_REASON_CODES` end with `'membership-fenced'`),
  `alm/delivery/al-delivery-lifecycle.ts:276-282`: `ALDeliveryRelayRejection` becomes
  `{ relay: 'trusted-server'; reason: 'resync-required' | 'unauthorized' | 'membership-fenced' } | { relay: 'peer';
  peerId: string; reason: 'resync-required' | 'membership-fenced' }`; its doc adds "and a trusted server or a peer one
  whose sender is no longer a member of the roster it was stamped with (`membership-fenced`)".
- Modify `multicast/web-rtc-overlay-multicast-manager.ts:966-981` (the compiler flags it): in
  `toALOutboundDropReasonCodeFromHandlingPlan` add `case 'membership-fenced': return 'unauthorized';` after the
  `'overloaded'` arm. The outbound drop vocabulary does not widen.
- Modify `alm/open-indexed-db-admission-database.ts:21`: `AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-10-roster-fence'`.
- Modify `packages/shared-web/browser/messages/browser-rallar-message-sender.ts:399`: delete the
  `membershipEpoch: input.membershipEpoch,` line (the builder no longer takes it; Task 2 deletes the input field).
- Modify `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts`: `ALM_NACK_REASONS` (`:66-76`) gains
  `'membership-fenced': true`; `decodeAlmRelayRejection` (`:112-140`) accepts `membership-fenced` for a trusted server
  (no `peerId`) and for a peer (with `peerId`), passing the decoded reason through; doc updated to match.
- Modify the 22 production stamps (`v: 2` / `v: 2 as const` → `v: AL_MESSAGE_ENVELOPE_VERSION`; `id.v !== 2` in
  `admin-prune-page-codec.ts:102`), adding the constant to each file's `al-contract.ts` import (a new import in
  `to-auth-logout-outbox.ts` after `@js-temporal/polyfill`, and `'../../../al-contracts/al-contract.ts'` in
  `compute-al-inbound-control-admission.ts`). Enumerate with the grep below restricted to non-test paths: 5 in
  `packages/shared` (`prepare-al-inbound-commit-bundle.ts:154`, `compute-al-inbound-control-admission.ts:150`,
  `ws-queue-box-server-inbound-authority.ts:316`, `ws-queue-box-server-receipt-aggregation.ts:271`,
  `queuebox/GroupPresenceSummaryEntryContract.ts:79`), `submit-black-box-raw-control.ts:53`, and 16 files under
  `packages/shared-server/rallar-system/` (admin prune codec, auth inbox and logout outbox, client-state inbox, CRDT
  outbox, four group-state outbox entries, state-sync, five topology files, the WS router).
- Modify every fixture that writes the envelope version 2 (122 test files under `packages/tests/**`, `apps/api-v1/test/**`,
  `tests/playwright/**`, and 18 black-box recipes under `packages/shared-test/black-box-runner/{examples,tests/api-v1}`):
  enumerate with `git grep -nE '(^|[^a-zA-Z_.])v: 2([^0-9]|$)|"v": ?2([^0-9]|$)' -- packages apps tests`; every hit is
  an envelope id and becomes the literal `3`. Except: `packages/tests/shared/al-message-resource-limits.test.ts:23` built
  its unsupported envelope with `v: 3`; it becomes `v: 2`.
- Modify `packages/shared/alm/inbound/README.md`: `:320` names the new schema id; after `:335` add the roster-fence bump
  sentence (targets carry `rosterVersion`, envelope `AL_MESSAGE_ENVELOPE_VERSION = 3`, an older row's `id.v: 2` refused
  `unsupported`); before `:384` a "**The roster-fence window.**" paragraph: browsers reset; a server row an older build
  wrote fails decoding `unsupported` at its next read, no row is migrated; an old page's `v: 2` is refused until it
  reloads, and it refuses `v: 3` symmetrically.
- Modify `scripts/repo-style-check/reviewed-dispositions.mjs`: the sweep touches four files with pre-existing
  `boundary.unknown` debt, which the changed gate retains for any touched file (R-R2-2). After the
  `json-message-limits.test.ts` entry add, under a comment naming the Relic spec's mock backend and the
  addressed-receipt control reader, `ws-queue-box-server-addressed-receipts.test.ts` / `readControlPayloads` and
  `tests/playwright/relic-hunters/web.spec.ts` with symbols `undefined`, `installBrowserDoubles`,
  `nextCommandSnapshot`, `mockBackend`, `json`, `parseJsonBody`, `isCommandKind`, `relicSnapshotWithPlayers`,
  `continuedStoragePlanningSnapshot`, `finishedRelicSnapshot`; before the "These reviewed AL/control/snapshot/queue
  decoders" block add `GroupPresenceSummaryEntryContract.ts` with `toGroupPresenceSummaryWork`, `requireRecord`,
  `requireExactKeys`, `requireNullableNonEmptyString`, `requireNonNegativeSafeInteger`, `requirePlainTime`,
  `requirePlainDateTime`, `requireInstant`, `requireOptionalInstant`, and `activation-status-clock-outbox-entry.ts` /
  `decodeActivationStatusClockWork` (all `rule: 'boundary.unknown'`).
- Test (modify) `packages/tests/shared/al-message-persistence-decoding.test.ts`; (create)
  `packages/tests/shared/al-contracts/al-room-roster-targets.test.ts`; (modify) `packages/tests/shared/al-control.test.ts`
  (fixture id `:71` to `v: 3`), `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`.

**Interfaces.** Produces `AL_MESSAGE_ENVELOPE_VERSION` (`3`), `rosterVersion?: number` on both room target shapes and
both room builders' options, `'membership-fenced'` in `ALNackReason`/`ALMessageDropReasonCode`, the widened
`ALDeliveryRelayRejection`, the schema id. Consumes nothing new.

**D8 reuse inspection.** The one envelope decoder's version gate (`al-message-persistence-validation.ts:78`), the
persisted field-list validators (`requirePersistedALFields`, `requireOptionalPersistedALSafeInteger`), the strict
reason codec and the existing relay-rejection decoder all widen in place; the reviewed-dispositions registry is the
repo's channel for pre-existing debt in a touched file (R1 used it for its touched decoders). No new decoder or file
beyond the one builder test.

- [ ] **Step 1: Write the failing tests.** Decoding test: move its fixtures to `v: 3`; import
      `AL_MESSAGE_ENVELOPE_VERSION`; add `it.each` "decodes $label only when the roster field is a version" (multicast
      `rosterVersion: 4` accepted, `rosterVersion: 0` refused, `membershipEpoch: 1` refused; room broadcast
      `minSnapshotVersion: 7, rosterVersion: 4` accepted, `rosterVersion: 0` refused; canonical `groupRef`
      `{ applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' }`), and "stamps the current envelope
      version and refuses any other as unsupported": `AL_MESSAGE_ENVELOPE_VERSION` is `3`, the current fixture decodes,
      and `v` 2 and 4 each give `left` `{ code: 'unsupported', message: 'AL envelope version is unsupported' }`. Builder
      test (three cases): a multicast with `minSnapshotVersion: 7, rosterVersion: 4, seq: 1` has `id.v` equal to the
      constant, targets matching both fields, `ordering` equal to `{ orderingKey: toALGroupTargetKey(ROOM), seq: 1 }`,
      and decodes back to its JSON; an unordered multicast has no `ordering`; a room broadcast carries both and decodes.
      Codec: "round-trips a membership-fenced NACK and refuses a reason outside the vocabulary" (reason `'fenced'` built
      with `controlMessageWithResource` decodes `left` `{ code: 'malformed' }`). Harness: `it.each` over
      `{ relay: 'trusted-server', reason: 'membership-fenced' }` and `{ relay: 'peer', peerId: 'relay-session', reason:
      'membership-fenced' }` "reads a $relay membership-fenced refusal from a delivery observation" (copy of the
      trusted-server refusal case, `commandId: 'alm-observe-fenced-refusal'`).
- [ ] **Step 2: Run red.** `npx vitest run packages/tests/shared/al-message-persistence-decoding.test.ts
      packages/tests/shared/al-contracts/al-room-roster-targets.test.ts packages/tests/shared/al-control.test.ts
      packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`: 16 failed plus the codec file failing to load;
      e.g. `expected undefined to be 3`, `got 'AL envelope version is unsupported'`, `The page runtime returned no usable
      delivery observation.relayRejection.`
- [ ] **Step 3: Contract, decoder, field lists, unions, schema id, the switch arm, the sender line.** Typechecks green.
- [ ] **Step 4: The sweep** (production stamps, fixtures, recipes, README, dispositions). Grep above returns nothing.
- [ ] **Step 5: Verify.** Focused files green (112 tests). The swept test files (`git diff --name-only | grep
      '^packages/tests/.*\.test\.ts$'`, 103 files) and `packages/tests/{shared,shared-server,shared-test,shared-web,
      rallar-black-box,api-v1}`: green except the known sandbox reds; suites that bind loopback ports
      (`api-v1-rtc-rtt-recipe-semantics`, `api-v1-state-write-convergence-recipe`, `local-websocket-session`,
      `live-rtc-control-client`) need an unsandboxed rerun. `npx tsc -p packages/{shared,shared-web,shared-server,
      shared-test}/tsconfig.json --noEmit`; `npm run typecheck --workspaces --if-present`; `node
      scripts/check-tests-typecheck.mjs`; `deno check` on every changed `packages/shared*/**/*.ts`; in `apps/api-v1`
      `deno check` the seven changed `test/**` files and `src/main.ts`, then `rm -rf apps/api-v1/node_modules/.deno`.
      Four pins unedited and green. Bundles (private `TMPDIR`): facade 238.900 KiB (base 238.858) of 239, headless
      304.074 (base 304.218) of 305; API snapshot unchanged. `npx dprint fmt` on touched files only.
- [ ] **Step 6: Commit**, then `npm run check:repo-style:changed -- 90425bdf8 HEAD` (PASS), `node
      scripts/check-test-structure-coupling.mjs --changed 90425bdf8 HEAD` (PASS), `npm run check:test-reachability` (1757 test files, 1751 reached by CI, 6 manual).

```text
Bump the AL envelope to v3 and carry the roster on room targets

AL_MESSAGE_ENVELOPE_VERSION = 3 is the one envelope version: ALMessageId.v
is its type, the builders and every server stamp read it, and the one
decoder refuses any other number unsupported, now pinned for v2. A
multicast's targets carry rosterVersion in place of membershipEpoch and a
room broadcast's gain it beside minSnapshotVersion; the persisted field
lists follow (a safe integer of at least 1), the builders take it, and the
multicast builder no longer writes ordering.epoch. The inbound validator's
membership-epoch refusal goes with the field. The NACK reasons, the strict
codec, the drop reason codes, the relay rejection and the harness's
relay-rejection decoder name membership-fenced. The admission schema id
bumps to rallar-alm-2026-10-roster-fence; every v2 fixture and black-box
recipe frame moves to v3.

The contract module loses its unused readALMulticastTargetGroupRef and
keeps toALGroupRef private. Pre-existing boundary findings in four files
the version sweep touches (the presence-summary and activation-clock
decoders, the Relic web spec's mock backend, the addressed-receipt test's
control reader) join the reviewed dispositions.

D8 reuse: the existing envelope decoder's version gate, the persisted field-list validators and the strict reason codecs widen in place; no new decoder.
```

### Task 2: The sender stamps its roster (D143)

**Files** (anchors at Task 1's commit)

- Modify `packages/shared-web/browser/rooms/room-state-store.ts`: before `RallarRoomStateStorePort` (`:24`) add

  ```ts
  /**
   * What a room send is stamped with from the sender's cached room snapshot: its version, raised to a floor the send
   * states, and its roster. Both are absent when no room snapshot is cached, except a stated floor, which stands alone.
   */
  export interface RoomSendFence {
      readonly minSnapshotVersion: number | undefined;
      readonly rosterVersion: number | undefined;
  }
  ```

  The port member (`:37-40`) and the method (`:174-186`) become
  `resolveRoomSendFence(room: string | GroupRef | undefined, explicitMinSnapshotVersion?: number): RoomSendFence`,
  reading the snapshot once: `minSnapshotVersion` is `cachedVersion ?? explicit` when either is absent, else
  `Math.max(explicit, cachedVersion)`; `rosterVersion` is `cached?.group.rosterVersion`. `resolveRoomMinSnapshotVersion`
  is gone everywhere (one canonical function, no alias).
- Modify `browser/composition/browser-communication-composition.ts:124-125`:
  `resolveRoomSendFence: (room, explicit) => input.state.roomStateStore.resolveRoomSendFence(room, explicit)`.
- Modify `browser/messages/browser-rallar-messages-controller.ts:42-45, :80` and
  `browser-rallar-message-sender.ts:93-96`: the `Input` member is the same `resolveRoomSendFence` signature, with
  `import type { RoomSendFence } from '@shared-web/browser/rooms/room-state-store.ts';` after the
  `rallar-connection-facade.ts` import. In the sender, `createWsMessage` (`:363-365`) spreads
  `...(room ? this.input.resolveRoomSendFence(room, input.minSnapshotVersion) : { minSnapshotVersion: input.minSnapshotVersion })`
  in place of `minSnapshotVersion:`; `createRtcMessage` (`:398-402`) spreads
  `...this.input.resolveRoomSendFence(target.room, input.minSnapshotVersion)`; `toRoomFallbackMessage` (`:458-464`) adds
  `rosterVersion: message.targets.rosterVersion` after `minSnapshotVersion`; `validateRoomFallbackInput` loses its
  `$.membershipEpoch` branch (`:431-437`).
- Modify `browser/messages/rallar-message-contracts.ts:59` (delete `membershipEpoch?` from `RallarRtcSendInput`; the typed
  options are `Omit`s of it and follow), `browser-message-input-validator.ts:205` (delete the rule),
  `validate-browser-rtc-peer-send.ts:53-61` (condition `send.nextHopPeerIds !== undefined || send.overlayId !== undefined
  || send.fanoutLimit !== undefined`, message "A peer-addressed send carries no overlay routing.").
- Modify `packages/shared-web/bundle-budgets.json:2`: `"browser/rallar.ts": 240` (measured 239.024 KiB).
- Modify the harness: `packages/shared-test/black-box-runner/browser/browser-rtc-requests.ts:168` (drop the
  `membershipEpoch` field test); in `rallar-browser-runtime/`: `black-box-rallar-operation-contracts.ts:108, :158`,
  `black-box-rallar-operation-policy.ts:217`, `decode-black-box-rallar-connection-config.ts:181`,
  `messaging/decode-black-box-rallar-send-input.ts:72`, `messaging/black-box-rallar-rtc-send-controller.ts:246` (delete
  each `membershipEpoch` line); `browser-rallar-runtime-composition.ts:131-132` becomes
  `/** The fence the product stamps on a room send that states no floor: the sender's cached room and roster versions. */
  resolveRoomSendFence(roomRef: GroupRef): RoomSendFence;` (type import after the `rallar-room-formation-contracts.ts`
  import) and `:253` `resolveRoomSendFence: (roomRef) => state.roomStateStore.resolveRoomSendFence(roomRef)`;
  `messaging/black-box-rallar-delivery-ledger.ts:184-186` reads
  `this.#input.deliveries.resolveRoomSendFence(roomRef).minSnapshotVersion` (its error text stays).
- Modify `docs/test-structure-coupling-exceptions.md:3286-3296` (`browser-invalid-fallback-no-admission`): summary "An
  unsupported all-scope fallback rejects before either carrier can publish.", coverageRelation "The public room channel
  rejects the scope issue alone and remains disconnected; both carrier admission ports are observed.",
  requiredConstraint "An unsupported fallback scope must produce no WS or RTC admission."; `semanticCoverage` and the two
  candidate entries at `:7719-7738` keep the test name, which stays.
- Test (modify): `packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts`,
  `browser-message-fallback-identity.test.ts`, `browser-rtc-peer-send.test.ts:231-245, :451`,
  `browser-message-sender-fixture.ts:51`, `packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts:619`,
  `packages/tests/shared-test/rallar-browser-runtime/browser-runtime-facade-test-double.ts:203, :362`, `delivery.test.ts:473-484`.

**Interfaces.** Consumes Task 1's `rosterVersion?` builder options and targets. Produces `RoomSendFence` and
`RallarRoomStateStorePort.resolveRoomSendFence(room, explicitMinSnapshotVersion?)`; the harness dependency
`BlackBoxBrowserDeliveriesDependency.resolveRoomSendFence(roomRef: GroupRef): RoomSendFence`. `RallarRtcSendInput` loses
`membershipEpoch`; no exported name is added or removed (the public API snapshot is unchanged).

**D8 reuse inspection.** The store's `findGroupSnapshot` and its explicit-floor maximum
(`room-state-store.ts:174-186`) are the one resolver, widened to a pair read from one snapshot; the builders already
take the target fields (Task 1); the harness's `aboveCurrentBy` keeps reading the product's resolver. No second
resolver, no alias.

- [ ] **Step 1: Write the failing tests.** Sender test: the fallback-constraint case sends `{ scope: 'all' }` and expects
      `issues: [expect.objectContaining({ path: '$.scope', code: 'unsupported' })]` (title unchanged);
      `withSnapshotVersion(snapshot, snapshotVersion, rosterVersion = snapshot.group.rosterVersion)` writes both;
      "stamps the cached room snapshot and roster versions on RTC room sends" (7, 4 → targets `minSnapshotVersion: 7,
      rosterVersion: 4`) and "... on WS room sends" (11, 5); "stamps the larger of a typed send's stated floor and the
      cached version, and the cached roster either way" (cached 7/4; sends stating 42, nothing, 3 → `{42, 4}`, `{7, 4}`,
      `{7, 4}`); "stamps neither version on RTC or WS room sends when no room snapshot is cached" (no snapshot; an RTC and
      a WS send by `roomRef`; both targets `toMatchObject({ groupRef: roomRef })` and
      `toMatchObject({ minSnapshotVersion: undefined, rosterVersion: undefined })`; green before and after, it pins the
      absence). Fallback identity: `const CACHED_ROSTER_VERSION = 4`; the fake is `resolveRoomSendFence: (_room,
      explicit) => ({ minSnapshotVersion: explicit, rosterVersion: CACHED_ROSTER_VERSION })`; the envelope case also
      expects `rosterVersion: CACHED_ROSTER_VERSION`; "preserves excluded recipients and the sender fence on both
      carriers" sends `{ exceptPeerIds: ['excluded-peer'], minSnapshotVersion: 9 }` and expects both room broadcasts to
      carry `minSnapshotVersion: 9, rosterVersion: 4`; delete "rejects unsupported membership fencing before trying
      either carrier". Peer send: drop the `['a membership fence', { membershipEpoch: 1 }]` row. The other fakes become
      `resolveRoomSendFence: (_room, explicit) => ({ minSnapshotVersion: explicit, rosterVersion: undefined })` (the
      recovery fixture keeps its throwing fake under the new name); the harness double's `vi.fn` is
      `resolveRoomSendFence`, and `delivery.test.ts` returns `{ minSnapshotVersion: 12, rosterVersion: 3 }`, then
      `{ minSnapshotVersion: undefined, rosterVersion: undefined }` for the uncached refusal.
- [ ] **Step 2: Run red.** `npx vitest run packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts
      packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts
      packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts
      packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts`: 73 failed, 74 passed (the fakes no longer
      provide `resolveRoomMinSnapshotVersion`; the stamping cases miss `rosterVersion`).
- [ ] **Step 3: The resolver, the wiring, the sender, the deletions, the harness.** Typechecks green; `git grep -n
      'membershipEpoch\|resolveRoomMinSnapshotVersion' -- packages apps tests` finds only the Task 1 README sentence
      and the decoding test's refused-field case.
- [ ] **Step 4: Verify.** The four files green (147). `packages/tests/{shared-web,shared-test,rallar-black-box,
      ar-eye-hunter-v1,relic-hunters}` green apart from the budget, which rises to 240 (run unsandboxed or rerun the
      port-binding suites). Typechecks for the four packages, `node scripts/check-tests-typecheck.mjs`, `deno check` on
      the changed `packages/shared-test/**` files. Bundles with a private `TMPDIR`
      (`D=$(mktemp -d /tmp/claude-501/b.XXXX); TMPDIR=$D npx vitest run
      packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
      packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts
      packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`): facade 239.024 KiB of 240, headless 304.032
      of 305, 18 passed. The four pins unedited. `npx dprint fmt` on the touched files.
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- 90425bdf8 HEAD` and `node
      scripts/check-test-structure-coupling.mjs --changed 90425bdf8 HEAD` (both PASS; renaming the fallback test breaks
      the two candidate entries' `semanticCoverage`, so keep its title).

```text
Stamp every room send with its sender's snapshot and roster

The room state store resolves one fence from the cached room snapshot:
its version, raised to a floor the send states, and its roster;
resolveRoomSendFence replaces resolveRoomMinSnapshotVersion in the
store, the composition and the harness. The RTC multicast, the WS room
broadcast and the fallback's room broadcast carry both, and neither
when no room snapshot is cached. The caller-set membership epoch goes
from RallarRtcSendInput, the typed send options, the input validator,
the fallback and peer-send refusals and the harness's legacy rtc.send
paths. The browser facade measures 239.024 KiB brotli; its budget
rises to 240.

D8 reuse: the store's cached-snapshot lookup and its explicit-floor maximum, the builders' target options and the harness's aboveCurrentBy reader; no new resolver beside the one it replaces.
```

### Task 3: The RTC receiver fences on the roster (D144, D145)

**Files** (anchors at Task 2's commit; Task 2 touched none of these source files, and its one-line edit at `rtc-authority-recovery.test.ts:619` moved no line)

- Create `packages/shared/multicast/resolve-rtc-room-peer-denial.ts`. Without the split, the admission file's cognitive
  load reaches 63, the warn tier, and the changed-style gate fails on it. Move into the new file `RtcRoomAuthorityDenial`
  (`rtc-room-snapshot-admission.ts:41-48`) and `RtcRoomSessionObservation` (`:175-180`), both now exported. The
  denial's `cause` becomes `'authority-rejected' | 'edge-unavailable' | 'membership-fenced'`, and its doc adds "a sender
  no longer in the roster it stamped is fenced, which the receiver tells its immediate hop". Add
  `export type RtcRoomRosterPosition = 'behind' | 'at' | 'beyond' | 'unstamped'` ("Where the receiver's roster stands
  against the one the copy was stamped with."). The file exports two functions:
  - `resolveRtcRoomPeerDenial(observation, peerId, senderRoster: RtcRoomRosterPosition | undefined)` replaces
    `resolveRoomSessionDenial` (`:182-212`). With `senderRoster` undefined it returns today's verdicts unchanged. With
    `senderRoster` defined it delegates to the private `resolveRoomSenderDenial`. Its doc: "A peer needs a live session in
    the room and an active member behind it. The sender of a copy at ingress, whose roster position is given, is judged
    on the roster it stamped instead."
  - `resolveRtcRoomRosterPosition(message, snapshot)` reads the stamp from `targets.rosterVersion` on a non-unicast
    target. An absent stamp is `'unstamped'`. Against `snapshot.group.rosterVersion`, a lower held roster is
    `'behind'`, an equal one is `'at'`, and a higher one is `'beyond'`.

  The file also holds four private functions:
  - `resolveLiveSessionDenial` is `:190-199` moved out.
  - `isActiveRoomMember` checks member status `active` and the same group ref.
  - `toMembershipFence(reason)` returns `{ kind: 'unauthorized', cause: 'membership-fenced', reason }`.
  - `resolveRoomSenderDenial` carries this doc, the one non-obvious rule:

```ts
/**
 * Behind its stamped roster the floor holds the copy; at or beyond it a member that is absent or not active is fenced.
 * An authoritative snapshot lists live sessions of active members only, and presence moves no roster: so a sender
 * with no session at its own roster is awaited, while one with no session in a later roster has left the roster or
 * its session since the stamp.
 */
// session absent: roster === 'beyond' ? toMembershipFence('Room sender has no live session in a roster beyond its stamp')
//                                     : { kind: 'pending', reason: 'Awaiting room session authority' }
// resolveLiveSessionDenial(...) defined, or roster === 'behind' → return it (undefined when behind and live)
// member absent or not isActiveRoomMember → toMembershipFence('Room sender is not an active member of the room roster')
```

- Modify `packages/shared/multicast/rtc-room-snapshot-admission.ts`. Import the moved names, and keep
  `import type { GroupRef, GroupSnapshot }`. After `RtcRoomSnapshotHandlingInput` add the private
  `interface RtcRoomRefusal { readonly code: Extract<ALMessageDropReasonCode, 'not-yet-in-sync' | 'membership-fenced' | 'unauthorized'>; readonly dropReason: string; }`.
  `computeRtcRoomSnapshotAdmission` (`:54-113`, 59 lines) builds `authority` after the snapshot check and returns
  `resolveRoomObservationDenial(...) ?? resolveRoomAuthorityDenial(input, authority, snapshot) ??
  resolveRoomFloorDenial(input, snapshot) ?? toAuthorizedRoomAdmission(input, authority, snapshot)`. The pieces:
  - `resolveRoomAuthorityDenial` is `:80-89` with the same peers, the same edge denial and the same ranking. Each peer
    goes through `resolveRtcRoomPeerDenial(authority, peerId, peerId === senderId ? roster : undefined)`, where
    `roster` is the position when `fromPeerId` is defined and undefined otherwise. A fence is `unauthorized`, so it
    outranks a pending self, relay or recipient. Its doc: "An unauthorized denial outranks a pending one, so a fenced
    sender is refused even while another peer is awaited."
  - `resolveRoomFloorDenial` holds `:93-98`. After the snapshot floor it adds a roster position of `'behind'` →
    `{ kind: 'pending', reason: 'Awaiting the required room roster version' }`. It applies only when `fromPeerId` is
    defined, and its doc replaces the `:95` comment: "The target floors apply at receiver/relay ingress; the origin's
    own authority is checked above."
  - `toAuthorizedRoomAdmission` is `:99-112`, calling `resolveRtcRoomPeerDenial(authority, sessionId, undefined)`.
  - `toRtcRoomSnapshotHandlingPlan` (`:119-148`) uses `refusal = toRtcRoomRefusal(admission)` for `dropReason`,
    `dropReasonCode` and `nack: { enabled: refusal.code !== 'unauthorized' && fromPeerId !== undefined, toPeerId:
    fromPeerId, reason: refusal.code, missingRanges: [] }`.
  - `toRtcRoomRefusal` maps a pending denial to `` `not-yet-in-sync: ${reason}` ``, the cause `membership-fenced` to
    ``{ code: 'membership-fenced', dropReason: `membership-fenced: ${reason}` }``, and anything else to
    `{ code: 'unauthorized', dropReason: 'unauthorized' }`. Its doc is the `:133-134` comment.
- Modify `packages/shared/alm/inbound/al-inbound-effect-intent.ts`.
  - `toNackReason` (`:237-252`) gains `case 'membership-fenced': return 'membership-fenced' as const;`. Without it, its
    `default` sends `stale`, and the compiler does not flag that.
  - In `toALInboundNegativeControlEffects` (`:134-155`), `const roomAuthorityRefusal = isRoomAuthorityNackReason(reason)`
    replaces both `reason === 'not-yet-in-sync'` tests, so a fenced NACK carries no ordering and no repair.
  - The private `isRoomAuthorityNackReason` checks for `'not-yet-in-sync'` or `'membership-fenced'`. Its doc: "A room
    authority refusal is about the receiver's roster, never the ordering track, so it asks for no repair."
- No budget edit: Task 2 raised `browser/rallar.ts` to 240 in `packages/shared-web/bundle-budgets.json`.
- Verified unchanged:
  - The manager's `membership-fenced → 'unauthorized'` (R-R2-6) stays. An origin has no `fromPeerId`, and
    `planForwarding` drops a fenced ingress plan before `createForwardingPlan`.
  - `rtc-group-snapshot-refresh.ts` stays. It refreshes on a `not-yet-in-sync…` reason through
    `targets.minSnapshotVersion`, which brings the roster within one incarnation. A `membership-fenced: …` reason
    reads nothing.
  - `al-inbound-runtime-diagnostics.ts:197-201` gives the fence `outcome: 'rejected'` with the full reason.

**Interfaces.** Consumes Task 1's `rosterVersion` and `'membership-fenced'`. Produces the RTC NACK
`reason: 'membership-fenced'`, which Task 5 settles, and the admission-outcome reason `membership-fenced: <denial>`,
which Task 6 reads. No package-public name changes.

**D8 reuse inspection.** The fence reuses:

- the denial ranking (`:88-89`);
- the `not-yet-in-sync` plan mapping and NACK effect;
- the refresh trigger;
- the `admission-outcome` port (`al-inbound-message-runtime.ts:251-262`, fed by the streamer's `inboundDiagnostics`);
- the server's `assembleGroupStateSnapshot`, which builds the realistic removal for the end-to-end test.

The one new file is a split of existing logic. No new port, field or constant.

- [ ] **Step 1: Write the failing tests.** Keep `rtc-group-snapshot-refresh.test.ts`'s "does not read authority after
      a denial the refresh cannot repair" byte-identical, because it is a registered coupling entry. Add no new mock
      count or absence assertion; the coupling gate blocks each one.
  - `packages/tests/shared/multicast/rtc-room-snapshot-admission.test.ts`.
    - `:92` becomes `toMatchObject({ kind: 'unauthorized', cause: 'membership-fenced' })`.
    - Add `describe('the room roster fence at RTC ingress')`, with `selfPeerId 'receiver'` and `fromPeerId 'origin'`.
    - Helpers: `stampedMessage(min, roster)`; `rosterSnapshot(n)`, which sets roster and snapshot to `n`;
      `withSenderMember(s, 'left'|'removed'|'absent')`; `withoutSenderSession(s)`.
    - Thirteen tests:
      - Stamp 1/2 on roster 1 → `toEqual({ kind: 'pending', reason: 'Awaiting the required room roster version' })`;
        stamp 2/2 → the snapshot reason.
      - A `left` sender behind the stamp → the roster pending.
      - `it.each` at roster 2 and beyond (roster 3) with the sender `removed` →
        `toEqual({ kind: 'unauthorized', cause: 'membership-fenced', reason: 'Room sender is not an active member of the room roster' })`.
      - Beyond the stamp with no sender session → the reason `'Room sender has no live session in a roster beyond its stamp'`.
      - At the stamp with no sender session → `{ kind: 'pending', reason: 'Awaiting room session authority' }`.
      - Unstamped: member absent → fenced; session absent → that pending.
      - A `left` sender with no receiver session → fenced.
      - Behind the stamp: an expired sender session → `authority-rejected`; from `'relay'` with overlay hops
        `['downstream']` → `edge-unavailable`.
      - Origin (`fromPeerId: undefined`): stamp 1/2 on roster 1 → `authorized`; its own member `left` →
        `authority-rejected`.
      - Plan of a fenced admission → `dropReasonCode: 'membership-fenced'`,
        `dropReason: 'membership-fenced: Room sender is not an active member of the room roster'`, local delivery and
        forwarding off, `nack: { enabled: true, toPeerId: 'origin', reason: 'membership-fenced', missingRanges: [] }`.
        With `fromPeerId` undefined, `nack.enabled` is false.
      - Plan of `authority-rejected` → `'unauthorized'` / `'unauthorized'`, with the NACK off.
  - `rtc-multicast-snapshot-admission.test.ts:175-176`: the case becomes `'a receiver session whose principal has no
    member row'` with `withoutMember(createSnapshot(), 'self')`.
  - `packages/tests/shared/rtc-snapshot-floor-admission.test.ts`.
    - The `:226` `it.each` drops `'removed-member'` and lines `:245-249`.
    - Helpers: `connectSenderAndReceiver()`; `observeRoster(endpoint, n, toSnapshot)`, which observes `n` and then sets
      `rosterVersion: n`; `withSenderRemoved`; `roomMessage(min, rosterVersion?)`.
    - New "holds a copy behind the roster it was stamped with, then delivers it once the receiver reaches that roster":
      roster 1 with `roomMessage(1, 2)` → no delivery and one `not-yet-in-sync` NACK; after
      `observeRoster(receiver, 2, s => s)`, a resend → delivered once.
    - New `it.each` "NACKs a fenced sender $label and delivers nothing", with `roomMessage(2, 2)`: held at roster 2
      with the member removed, and at roster 3 also with no sender session. Expect nothing delivered,
      `receiver.sent` of length 1, and `sender.nacks` → `[{ msgId, fromPeerId: 'receiver', toPeerId: 'sender', reason: 'membership-fenced' }]`.
  - `packages/tests/shared/rtc-snapshot-nack.test.ts`.
    - The fixture message gains `rosterVersion: 1`.
    - `createSnapshotAdmissionFixture(seq, persist, diagnostics?: ALInboundRuntimeDiagnosticsSink)` passes the sink.
    - `createRemovedSenderSnapshot()`: roster 2, snapshot 6, the sender `removed`, no sender session.
    - `it.each([1, 2])` "NACKs a fenced sender membership-fenced with no ordering hints or repair for sequence %s": the
      controls are exactly `[{ type: 'nack', payload: { fromPeerId: 'receiver', toPeerId: 'sender', msgId, reason:
      'membership-fenced', observedAtEpochMs: expect.any(Number) } }]`, nothing is delivered, and the events contain
      `{ kind: 'admission-outcome', msgId, carrier: 'rtc', outcome: 'rejected', reason: 'membership-fenced: Room sender has no live session in a roster beyond its stamp' }`.
    - "sends no NACK for a copy with no immediate RTC hop to answer": source `{ kind: 'trusted-server' }`, then
      `waitForOwnedQueueWork(fixture.stores.workQueue)` → no controls and nothing delivered.
  - `packages/tests/shared-web/state-read/rtc-group-snapshot-refresh.test.ts`. These are pins and pass before the change.
    - `roomMessage(min, rosterVersion?)`.
    - "reads authority through the snapshot floor for a copy behind its stamped roster": `roomMessage(6, 4)` with the
      roster reason → resolves `true`, and the port is `toHaveBeenCalledWith(roomRef, 6, expect.any(AbortSignal))`.
    - "permits no re-entry for a membership-fenced denial although its refresh would succeed": a refresh port that
      resolves → the fenced reason resolves `false`.
  - `packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts`, before `:314`: add
    `describe('the roster fence at an RTC receiver')` with "fences a sender the server-assembled roster removed after
    its stamp, NACKs it and reads no authority".
    - The sender holds `createAcceptedRoomSnapshot()`. The receiver holds `assembleSenderRemoval(stamped)`.
    - `assembleSenderRemoval` calls `assembleGroupStateSnapshot` (already imported) with:
      - snapshot and roster versions + 1, `activeMemberCount - 1`, and the owner moved to `'receiver'` (the stored-roster
        invariant needs one active owner);
      - the sender `removed`, and both sessions in the summary and in `authoritativeSessions`;
      - `sessionLeaseFields: 'authoritative'` and `observedAtEpochMs: 1_000`.
    - The receiver's refresh is a real `RtcGroupSnapshotRefresh` that pushes into `refreshedFloors`.
    - Send stamped from the sender's snapshot, with `ack: 'all-logical-recipients'` and hop QoS.
    - Expect: nothing delivered; the fenced `admission-outcome` in `receiver.admissions`; the receiver's only frame is
      the `membership-fenced` NACK to `'sender'`; `refreshedFloors` equals `[]`.
- [ ] **Step 2: Run red** with `npx vitest run` on the six files.
  - The admission file: 9 failed, e.g. `expected { kind: 'authorized', …(4) } to deeply equal { kind: 'pending', …(1) }`.
  - The two floor-admission fence cases, which show `"reason": "stale"` once only the admission is implemented.
  - The two NACK cases.
  - The recovery case, because no `membership-fenced` admission outcome is recorded.
- [ ] **Step 3: Implement** the new file, the admission split, the plan mapping and the two effect-intent edits.
- [ ] **Step 4: Verify.**
  - Run `npx dprint fmt` on the touched files.
  - The six files pass: 64 tests across the four shared files, 9 refresh tests and 33 recovery tests.
  - `packages/tests/shared`, `packages/tests/shared-web/{state-read,state-cache,messages}` and
    `packages/tests/shared-test/rallar-browser-runtime` pass, except the known sandbox reds and the loopback suites.
  - `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit` and
    `node scripts/check-tests-typecheck.mjs` pass.
  - `deno check` passes on the three changed source files.
  - The four pins pass unedited.
  - Bundles, with a private `TMPDIR`: the facade measures 239.231 KiB (Task 2: 239.024) of 240. Headless measures
    304.259 of 305 (Task 2: 304.032). `check:browser-bundles` passes.
- [ ] **Step 5: Commit.** Then run `npm run check:repo-style:changed -- 90425bdf8 HEAD`, `node
      scripts/check-test-structure-coupling.mjs --changed 90425bdf8 HEAD` and `npm run check:test-reachability`. All
      three pass.

```text
Fence an RTC room copy on the roster its sender stamped

An RTC receiver or relay holds a copy whose stamped rosterVersion its
own room roster has not reached, after the snapshot floor, as
not-yet-in-sync, with the same NACK and one refresh through the
snapshot floor that brings the roster along. At or beyond the stamp it
judges the sender: a member that is absent or not active, or no live
session in a roster later than the stamp (an authoritative snapshot
lists live sessions of active members only, so that is how a removal
reads), is refused membership-fenced. The fence outranks a pending
peer, NACKs the immediate hop with membership-fenced and no ordering or
repair hints, and the admission outcome states
"membership-fenced: <denial>". A sender with no session at its own
roster is still awaited; an origin keeps its own verdicts and the
outbound drop code stays unauthorized. The browser facade measures
239.231 KiB of 240; headless measures 304.259 of 305.

D8 reuse: the existing denial ranking, the not-yet-in-sync plan mapping and NACK effect, the refresh trigger and the inbound admission-outcome diagnostic carry the fence; no new port or field.
```

### Task 4: The WS server (D145, D146)

**Files** (anchors at Task 3's commit; Tasks 2 and 3 touch none of these files)

- Modify `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts:107`: after
  `minSnapshotVersion?` in `RallarServerWsRoomAuthorizationInput` (`:99-108`) add
  `/** The sender's roster stamp; absent when it stamped none, and no roster floor applies. */` and
  `readonly rosterVersion?: number;`. `RallarServerWsRoomAuthorizationDenied.reason` (`:117-122`) is already
  `ALNackReason`, which Task 1 widened: no contract change there.
- Modify `.../websocket/router/decode-rallar-server-ws-ingress.ts`: add `RallarServerWsRoomAuthorizationInput` to the
  type import (`:9-17`, alphabetical, after `...AuthorizationDecision`); `:122` becomes
  `...toRallarServerWsRoomFloors(input.message)`; replace `readRallarServerWsMinSnapshotVersion` (`:159-164`) with
  `function toRallarServerWsRoomFloors(message: ALMessage): Pick<RallarServerWsRoomAuthorizationInput,
  'minSnapshotVersion' | 'rosterVersion'>` returning `{ minSnapshotVersion: targets.minSnapshotVersion, rosterVersion:
  targets.rosterVersion }` for a `multicast` or `broadcast` target and `{}` otherwise.
- Modify `packages/shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts`: import `GroupPolicyReasonCode`
  beside `GroupPolicyDenied` (`:10`). In `readRoomAuthorizationSnapshot` (`:139-191`) replace `:159-190` with the
  three lines below and add the two pure helpers after it (the function shrinks from 53 to 30 lines):

```ts
if (!snapshot) {
    return { kind: 'denied', decision: toMissingRoomCacheDecision(input) };
}
const floorDenial = resolveRoomFloorDenial(input, snapshot);
if (floorDenial) {
    return { kind: 'denied', decision: floorDenial };
}
return { kind: 'ready', snapshot, serverSnapshotVersion: readGroupVersion(snapshot) };
```

`toMissingRoomCacheDecision(input): RallarServerWsRoomAuthorizationDecision` collects
`snapshot version ${minSnapshotVersion}` and `roster version ${rosterVersion}` for the floors present; none →
`false` (unchanged); otherwise `{ authorized: false, reason: 'not-yet-in-sync', logMessage: \`Room ${roomId} cache
is missing; requires ${floors.join(' and ')}\` }`(no`serverSnapshotVersion`).`resolveRoomFloorDenial(input,
snapshot): RallarServerWsRoomAuthorizationDenied | undefined`: the snapshot floor exactly as today (same log text),
  then`input.rosterVersion !== undefined && snapshot.group.rosterVersion < input.rosterVersion`→`{ authorized: false, reason: 'not-yet-in-sync', logMessage: \`Room ${roomId} cache roster version
${snapshot.group.rosterVersion} is older than required roster version ${rosterVersion}\`, serverSnapshotVersion }`.`toPolicyDeniedDecision`(`:218-229`) computes`const reason = resolveRoomPolicyDenialReason(denial.code);`, sets`reason`, and its log becomes` `Rejected room message for ${roomId}: ${reason}: ${denial.code}: ${denial.message}` `;
  new`function resolveRoomPolicyDenialReason(code: GroupPolicyReasonCode): 'membership-fenced' | 'unauthorized'`returns`membership-fenced`for`member-not-active`,`member-removed`,`member-banned`, else`unauthorized`.

- Not changed (verified): `canSendGroupMessage` (`group-message-policy.ts`; its live-session denial `:66-71` and the
  inactive-member denial `group-policy-primitives.ts:61-65` share `member-not-active`, so both fence);
  `computeServerRoomPublicationAudience` (`:54-69`); `ws-queue-box-server-inbound-authority.ts` (`:309` copies
  `authorization.reason` into the advisory NACK, `:288-293` refuses with `rejectionCode ?? 'unauthorized'`, `:280`
  gives `'completed'`; its reason type is `ALNackReason`, `ws-queue-box-server-contracts.ts:127`). The local refusal
  code stays `unauthorized`: `ALMessageRejection['code']` (`al-message-persistence-validation.ts:26`) is the envelope
  decoders' four-code vocabulary, never reaches the sender; the fence travels on the NACK and the log names it.
- Consumer sweep (by enumeration; no exhaustive switch, tsc finds nothing): `decode-rallar-server-ws-ingress.ts:176-183`
  and `rallar-server-ws-router.ts:228, 267` copy the reason; `rallar-server-ws-publication-audience.ts:34-40` (proxy
  publish) reads `logMessage` only and now applies a proxied room target's roster floor too;
  `rallar-server-ws-publish-result.ts:53` is the outbound verdict vocabulary (unrelated).
- Tests: `packages/tests/shared-server/rallar-system/{websocket/ws-topic-room-authorizer,rallar-server-ws-router}.test.ts`,
  `packages/tests/shared/services/ws-queue-box-server-{ingress,inbound-delivery}.test.ts`,
  `apps/api-v1/test/services/ws-room-authority-delivery.test.ts` (Deno), and
  `packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts:238-241` (the restored room original's
  sender has no live session: its expected `reason` becomes `'membership-fenced'`; added at composition).

**Interfaces.** Consumes Task 1's `targets.rosterVersion` (multicast and broadcast) and `'membership-fenced'` in
`ALNackReason`. Produces the WS advisory NACK `reason: 'membership-fenced'` (Task 5 settles it `relay-rejected`
trusted-server) and `not-yet-in-sync` with `serverSnapshotVersion` for a roster behind the stamp.

**D8 reuse inspection.** The authorizer's snapshot-floor path carries the roster floor (same reason, same
`serverSnapshotVersion`, same retained 50 ms retry, `ws-queue-box-server-inbound-authority.ts:79, 236-247`); the
policy's existing `GroupPolicyReasonCode`s decide the fence (no policy change); the inbound authority's NACK and
dispatch paths need no edit; `readRallarServerWsMinSnapshotVersion` is replaced in place.

- [ ] **Step 1: Failing tests.** Authorizer test: lines `:278, :354, :555, :623` expect `reason: 'membership-fenced'`
      and the four titles say "fences" (`:227` "refreshes a warm snapshot and fences a sender whose embedded session
      has expired", `:284` "fences room sends when a summary session is stale behind an authoritative disconnect",
      `:486` "fences missing live sessions and blocked members with stable policy details", `:561` "refreshes stale
      snapshots and fences banned members without a live session"); halted (`:403`), lifecycle (`:480`) and scope
      (`:671`) stay `unauthorized`. Add after `:674`, each with `createGroupSnapshot({ …, workspaceId: 'workspace-b',
      sessionIds: ['session-b'] })` and a helper `withRosterVersion(snapshot, rosterVersion)` after
      `withoutActiveSessions` (`:693`): "holds a send stamped beyond the cached roster as not-yet-in-sync with the
      server snapshot version" (room `roster-behind-room`, snapshot 3, roster 1, broadcast stamped `3`/`2` → `toEqual`
      `{ authorized: false, reason: 'not-yet-in-sync', logMessage: 'Room roster-behind-room cache roster version 1 is
      older than required roster version 2', serverSnapshotVersion: 3 }`); "holds a roster-stamped send as
      not-yet-in-sync while the room cache is missing" (reader returns `undefined`, multicast `{ rosterVersion: 2 }` →
      `{ authorized: false, reason: 'not-yet-in-sync', logMessage: 'Room roster-missing-room cache is missing; requires
      roster version 2' }`); "fences a sender removed from the roster it was stamped with" (`withMemberStatus(…,
      'removed')`, snapshot 4, roster 2, multicast stamped `4`/`2` → `{ authorized: false, reason: 'membership-fenced',
      logMessage: 'Rejected room message for roster-removed-room: membership-fenced: member-removed: Group member has
      been removed.', serverSnapshotVersion: 4 }`); "authorizes an active member whose cached roster is at or beyond
      the stamp" (snapshot 5, roster 3, stamps 2 and 3 → `authorizedDecision`); "keeps a pre-activation data denial
      unauthorized" (`lifecycleState: 'forming'`, policy `blocked-until-active` → `unauthorized`, log contains
      `group-data-blocked-until-active`). Router test: `:501-532` becomes `it.each(['multicast', 'broadcast'] as
      const)('passes the %s target groupRef and both floors into room authorization context', …)` stamping
      `{ minSnapshotVersion: 4, rosterVersion: 2 }` and expecting both in `objectContaining` (import
      `newALMulticastMessage` at `:12`). Ingress test: before the `describe` (`:21`) `const PENDING_ADMISSION_DENIALS =
      ['unauthorized', 'membership-fenced', 'not-yet-in-sync'] as const;` feeds `:139` (keeps the one-line `it.each`,
      so dprint does not re-indent the body); `:173, :179` become `reason === 'not-yet-in-sync' ? 'RETRY' :
      'COMPLETED'`; before `:235` add "answers a membership-fenced sender with a fenced NACK and refuses it as
      unauthorized" (authorizer denial `membership-fenced`, `sendNack: true`, `serverSnapshotVersion: 4`, `logMessage: 'Rejected room
      message for room-1: membership-fenced: member-removed: Group member has been removed.'`; left `toEqual`
      `{ code: 'unauthorized', message }` with that log message; exactly one control whose decoded NACK matches `{ fromPeerId:
      'server', toPeerId: 'session-1', msgId: 'message-1', reason: 'membership-fenced', serverSnapshotVersion: 4 }`;
      no admission data, no work, nothing delivered). Delivery test: `:180-203` becomes `it.each(['unauthorized',
      'membership-fenced'] as const)('completes already queued messages without delivery or a NACK when current room
      authority is %s', …)` with `sendNacks: true`, `sendNack: true`, ending `expect(fixture.socket.sent).toEqual([])`.
      Durable-owner recovery: `:240` expects `reason: 'membership-fenced'` (the log still contains
      `member-not-active`). Deno: `:114` becomes "current room denial emits its typed NACK without using a permissive recipient cache" over
      `{ denial, reason }` rows — `missing`, `scope`, `group`, `policy`, `halted` → `unauthorized`; `member`,
      `session` → `membership-fenced`; `version`, new `roster` → `not-yet-in-sync`; `roomMessage` (`:447`) takes
      `floors: Readonly<{ minSnapshotVersion?: number; rosterVersion?: number; }> = {}` spread into its options;
      `:138` passes `{ minSnapshotVersion: denial === 'version' ? 3 : undefined, rosterVersion: denial === 'roster' ?
      2 : undefined }`; `:145` becomes `assert.equal(decodeALNackPayload(JSON.parse(nack.payload.resource)).reason,
      reason, denial)` (import beside `decodeALReceiptPayload`, `:10`).
- [ ] **Step 2: Run red.** `npx vitest run packages/tests/shared-server/rallar-system/websocket/ws-topic-room-authorizer.test.ts
      packages/tests/shared-server/rallar-system/rallar-server-ws-router.test.ts
      packages/tests/shared/services/ws-queue-box-server-ingress.test.ts
      packages/tests/shared/services/ws-queue-box-server-inbound-delivery.test.ts`: `9 failed | 98 passed (107)` —
      the two router cases (`rosterVersion` absent from the call) and seven authorizer cases (`+ "reason":
      "unauthorized"`, or `false`/authorized where `not-yet-in-sync` is expected). The ingress and delivery additions
      and the "at or beyond" and pre-activation cases pass already: they pin behaviour the inbound authority keeps.
      `cd apps/api-v1 && deno test --allow-env --allow-read test/services/ws-room-authority-delivery.test.ts`:
      `12 passed | 1 failed`, `AssertionError: member` (`+ 'unauthorized'` / `- 'membership-fenced'`).
      `npx vitest run packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts`: `1 failed | 7 passed`
      (`- "reason": "membership-fenced"`, `+ "reason": "unauthorized"`).
- [ ] **Step 3: Implement** the contract field, the ingress floors and the authorizer as above. Run green: `107
      passed`, Deno `13 passed`.
- [ ] **Step 4: Verify.** `npx vitest run packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts` (8 passed);
      `npx vitest run packages/tests/shared-server packages/tests/shared/services` green (2862
      passed, 12 skipped); `npx tsc -p packages/{shared,shared-server}/tsconfig.json --noEmit`; root `deno check` on the
      three changed files; `node scripts/check-tests-typecheck.mjs`; in `apps/api-v1` `deno task check` and `deno test
      --allow-env --allow-read --allow-write --allow-run=$(deno eval 'console.log(Deno.execPath())') test/services/
      test/ws-routes.test.ts` (127 passed), then `rm -rf apps/api-v1/node_modules/.deno`. The four pins green,
      unedited. No `packages/shared`/`shared-web` change: no bundle check. Format with `git diff --name-only | xargs
      npx dprint fmt` (zsh does not split a `$FILES` variable).
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- 90425bdf8 HEAD` (PASS) and `node
      scripts/check-test-structure-coupling.mjs --changed 90425bdf8 HEAD` (PASS). No test file added or deleted.

```text
Fence WS room sends on the roster at the server

The WS server reads a room send's rosterVersion from its multicast or
room broadcast targets beside minSnapshotVersion and holds it
not-yet-in-sync, with the server snapshot version, while its cached
roster is behind the stamp; a missing room cache holds a send that
carries either floor. Behind the floor the retained admission retries
as before. At or beyond it, the policy's live-session and active-member
denials (member-not-active, member-removed, member-banned) answer the
sender with a membership-fenced advisory NACK; lifecycle, halted,
pre-activation and scope denials stay unauthorized. The local refusal
code stays unauthorized and a policy denial's log message names its
NACK reason; the dispatch-time re-authorization completes a fenced
message undelivered as it does any other denial.

D8 reuse: the authorizer's snapshot-floor path, the existing policy denial codes and the advisory NACK carry the roster fence; no new policy code, refusal code or retry path.
```

### Task 5: The sender's handle settles the fence (D145)

**Files** (anchors at Task 4's commit)

- Create `packages/shared/alm/outbound/control/resolve-al-outbound-relay-rejection.ts`, beside
  `to-al-outbound-receipt-exhausted-fact.ts`, which is the same kind of fact builder. The split keeps
  `compute-al-outbound-control-admission.ts` under the cognitive-load warn tier; inlined, it measures 51 and the
  changed-style gate fails. The file has type imports of `ALDeliveryRelayRejection`, `ALOutboundSettlementFact` and
  `ALControlAdmissionRead`. It exports two functions:
  - `resolveALOutboundRelayRejection(read: ALControlAdmissionRead): ALDeliveryRelayRejection | undefined` replaces
    `isALServerRefusalBeforeReceipt` (`compute-al-outbound-control-admission.ts:167-175`) and the hard-coded
    `resync-required` test at `:126`. One function decides, with the NACK's reason passed through as a value:

```ts
/**
 * A NACK that refuses the whole send rather than one receipt: a relay's `resync-required` whatever the receipt,
 * and before any receipt row exists a `membership-fenced` refusal or the trusted server's `unauthorized` one.
 * Only the trusted server speaks without being a peer the send owes, so only its rejection waives that check.
 */
// not a nack → undefined; beforeReceipt = read.sent !== undefined && read.pending === undefined
// trusted-server: resync-required || (beforeReceipt && (unauthorized || membership-fenced))
//                 → { relay: 'trusted-server', reason: nack.reason }
// peer:           resync-required || (beforeReceipt && membership-fenced)
//                 → { relay: 'peer', peerId: nack.fromPeerId, reason: nack.reason }
```

- `toALOutboundRelayRejectedFact(msgId, relayRejection)` merges `toServerRefusalFact` (`:177-184`) and
  `toRelayRejectedFact` (`:186-201`). The relay text is `'The server relay'` for the trusted server and
  `` `Hop ${peerId}` `` for a peer, with `` detail: `${relay} refused the message: ${reason}.` ``. As a result, the
  server's `unauthorized` detail becomes "The server relay refused the message: unauthorized." (R-R2-28).
- Modify `packages/shared/alm/outbound/compute-al-outbound-control-admission.ts`.
  - `toALOutboundControlSettlements` (`:117-146`) starts with `const relayRejection =
    resolveALOutboundRelayRejection(read)`. When it is defined, it returns
    `[toALOutboundRelayRejectedFact(read.targetMsgId, relayRejection)]`.
  - Its doc becomes: "The delivery facts a committed control states: a relay's refusal of the whole send, or the receipt
    the control moved -- followed by `receipt-exhausted` when a hop refused the message for good and so ended a receipt
    it still owed. A control that changed no receipt states nothing."
  - Delete the three replaced functions.
  - `isTerminalNack` (`:301-305`) gains `|| nack.reason === 'membership-fenced'`.
  - Doc comments: `toRefusedReceiptFact` (`:148`) reads "An `expired`, `unauthorized`, `stale` or `membership-fenced`
    NACK…", and `(D50)` is dropped from `isTerminalNack`'s doc.
- Modify `validate-al-outbound-control-admission.ts`.
  - The import (`:6-10`) becomes a type import of the two contracts plus `resolveALOutboundRelayRejection` from
    `./control/resolve-al-outbound-relay-rejection.ts`.
  - `isTrustedRelayRejection` (`:113-121`) becomes `return resolveALOutboundRelayRejection(read)?.relay ===
    'trusted-server';`.
  - Its doc: "The trusted server speaks for the relay it is, so its `resync-required` NACK needs no expected peer, and
    neither does its `unauthorized` or `membership-fenced` refusal of a message before any receipt row exists."
  - A peer's fenced NACK still needs to be an expected peer: the unicast addressee, a receipt peer or a composition hop.
- Not changed, verified:
  - `al-delivery-failure.ts` and `compute-al-delivery-lifecycle.ts`: the failure carries the widened union, and
    `relay-rejected` maps to the state `rejected` (`:289`), which is not `failed`. No switch narrows the rejection
    reason.
  - `ws-queue-box-client-service.ts` passes server controls to the same admission as `trusted-server`.
  - `al-delivery-receipt-ends.test.ts` pins no terminal NACK set.
  - `grep -rn isALServerRefusalBeforeReceipt packages apps` is empty after the change.

**Interfaces.** Consumes Task 1's `ALDeliveryRelayRejection` and `'membership-fenced'` in `ALNackReason`, and Task 3's
RTC NACK. Produces these settlements:

- a trusted server's fence before a receipt row: `relay-rejected { relay: 'trusted-server', reason: 'membership-fenced' }`;
- a peer's fence before a receipt row, when the peer is one the send owes: `relay-rejected { relay: 'peer', peerId, reason: 'membership-fenced' }`;
- a fence with a receipt row: `acknowledgement` followed by `receipt-exhausted { cause: 'hop-refused', hopPeerId, nackReason: 'membership-fenced' }`.

**D8 reuse inspection.** The fence reuses the `relay-rejected` settlement and its lifecycle mapping, the terminal-NACK
receipt path, and the `hop-refused` failure. The trusted-server refusal predicate and the two fact builders become one
resolver and one builder. No new settlement kind, field or rule.

- [ ] **Step 1: Write the failing tests.**
  - `packages/tests/shared/alm/al-outbound-control-admission.test.ts`.
    - `TERMINAL_NACK_REASONS` (`:57`) gains `'membership-fenced'`. Its `it.each` at `:584` then asserts `acknowledgement`
      followed by `receipt-exhausted` with `nackReason: 'membership-fenced'` and `detail: 'Hop receiver refused the
      message: membership-fenced.'`.
    - `refusalNack`'s reason (`:240`) widens to `'unauthorized' | 'expired' | 'membership-fenced'`.
    - `:680`'s detail becomes `'The server relay refused the message: unauthorized.'`.
    - Add `seedReceiptlessUnicastObligation`: a unicast to `'receiver'` that is committed with no `set-pending-ack`.
    - Add three tests after `:682`:
      - "admits the trusted server membership-fenced NACK for a sent message with no receipt row, stating the fence":
        `seedReceiptlessRoomObligation`, `refusalNack('ws-server-1', 'membership-fenced')` from `'trusted-server'` →
        `committed`, with settlements `[{ kind: 'relay-rejected', msgId: 'message', relayRejection: { relay:
        'trusted-server', reason: 'membership-fenced' }, detail: 'The server relay refused the message:
        membership-fenced.' }]`.
      - "states a peer membership-fenced NACK before any receipt row as rejected by that peer": the receiptless unicast,
        `refusalNack('receiver', 'membership-fenced')` from `'peer'` → `relayRejection: { relay: 'peer', peerId:
        'receiver', reason: 'membership-fenced' }`, with `detail: 'Hop receiver refused the message: membership-fenced.'`.
      - "still refuses a membership-fenced NACK from a peer the send owes nothing": the receiptless room send and
        `'other-session'` → `{ kind: 'rejected', reason: 'AL repair sender has no retained outbound obligation' }`,
        with the state unchanged and no settlements.
  - `packages/tests/shared/alm/delivery/compute-al-delivery-lifecycle.test.ts`. These are pins.
    - The `:637` `it.each` adds the two fenced rejections. Its title becomes "settles a queued send as rejected by a
      $relay relay ($reason), with that relay as its evidence". `detail` is built from the reason, and it adds
      `expect(next.evidence.failure).toEqual({ kind: 'relay-rejected', rejection })`.
    - New "fails a receipted send whose hop refused it membership-fenced, naming the hop and the reason": a
      `receipt-exhausted` hop-refused settlement → `failed`, `evidence.failure` is `{ kind: 'receipt-exhausted', cause:
      'hop-refused', hopPeerId: 'relay-1', nackReason: 'membership-fenced' }`, and `relayRejection` is undefined.
  - `packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts`.
    - `:130`'s detail changes to "The server relay…".
    - Before `:169`, add "states the room authorizer fencing a sender no longer in the roster; the receipted handle reads
      rejected":
      - The authorizer returns `{ authorized: false, reason: 'membership-fenced', rejectionCode: 'unauthorized',
        logMessage: 'Rejected room message for room-1: the sender is no longer an active member.', sendNack: true }`.
      - The room broadcast `'broadcast-fenced'` carries `minSnapshotVersion: 3, rosterVersion: 2`.
      - Expect the server left `unauthorized`, then the relayed frames.
      - Expect one `relay-rejected` for `{ relay: 'trusted-server', reason: 'membership-fenced' }` with detail "The
        server relay refused the message: membership-fenced.".
      - Expect the lifecycle `rejected`, with `evidence.failure` `{ kind: 'relay-rejected', rejection: … }`.
  - `packages/tests/shared/alm/delivery/al-delivery-failure.test.ts:103,146`: the fixture detail follows the new text.
  - `packages/tests/shared-test/rallar-browser-runtime/rtc-message-nack-diagnostics.test.ts`: the test becomes
    `it.each(['not-yet-in-sync', 'membership-fenced'] as const)` "reads the admitted %s receiver receipt…", with the
    reason used in both the NACK and the expectation.
  - `packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts`: the Task 3 roster-fence test goes on with
    `await receiver.transferTo(sender); await vi.advanceTimersByTimeAsync(0);`. Then `sender.settlements` filtered to
    `receipt-exhausted` equals `[expect.objectContaining({ msgId, cause: 'hop-refused', hopPeerId: 'receiver',
    nackReason: 'membership-fenced' })]`.
- [ ] **Step 2: Run red** with `npx vitest run` on the six files. Expect 7 failed, for example:
  - `expected [] to deeply equal [ { kind: 'relay-rejected', …(3) } ]`;
  - `expected { kind: 'rejected', …(1) } to deeply equal { kind: 'committed' }`;
  - `expected { msgId: 'message', mode: 'hop', …(6) } to be undefined`;
  - the recovery test's empty `receipt-exhausted` list;
  - the two changed detail strings.
- [ ] **Step 3: Implement** the new control module, the settlement rewiring, `isTerminalNack`, the validator, and the
      deletions.
- [ ] **Step 4: Verify.**
  - Run `npx dprint fmt` on the touched files.
  - The six files pass: 42, 164, 7, 24, 2 and 33 tests.
  - `packages/tests/shared/`, `packages/tests/shared-web/`, `packages/tests/shared-test/` and
    `packages/tests/shared-server/` pass, except the loopback suites.
  - The typechecks of the four packages and `node scripts/check-tests-typecheck.mjs` pass.
  - `deno check` passes on the three changed source files.
  - The four pins pass.
  - Bundles, with a private `TMPDIR`: the facade measures 239.222 KiB of 240 and headless 304.382 of 305.
- [ ] **Step 5: Commit.** Then run `npm run check:repo-style:changed -- 90425bdf8 HEAD`, `node
      scripts/check-test-structure-coupling.mjs --changed 90425bdf8 HEAD` and `npm run check:test-reachability`. All
      three pass.

```text
Settle a membership-fenced refusal on the sender's handle

One resolver decides which NACK refuses a whole send rather than one
receipt: a relay's resync-required whatever the receipt, and before
any receipt row exists a membership-fenced refusal from the trusted
server or from a peer the send owes, or the trusted server's
unauthorized one. Its answer is the relay rejection the handle states,
with the NACK's own reason, and the control validation reads it to
waive the expected-peer check for the trusted server alone. With a
receipt row a membership-fenced NACK is terminal like unauthorized:
it ends the receipt hop-refused with that reason. A trusted server
rejection reads "The server relay refused the message: <reason>." for
every reason. The facade measures 239.222 KiB of 240, headless 304.382
of 305.

D8 reuse: the existing relay-rejected settlement, the terminal-NACK receipt path and the hop-refused failure carry the fence; the server-refusal predicate becomes the one relay rejection resolver beside the receipt-exhausted fact in control/
```

### Task 6: The lane: `fenced-delivery`, `fenced-catch-up`, `fenced-rejection`; the red refresh variant goes (D148)

Anchors at Task 5's commit (22 files, +1160/−241). Paths below are relative to
`packages/shared-test/rallar-bb-test/conformance/alm/` unless rooted.

**Files**

- Create `scenarios/membership-fence/fenced-delivery.ts` (`fencedDelivery`), `fenced-catch-up.ts` (`fencedCatchUp`),
  `fenced-rejection.ts` (`fencedRejection`); ids = keys `fenced-delivery`, `fenced-catch-up`, `fenced-rejection`;
  `tags: FULL_TAGS`, `laneFamily: 'three-agent'`, `roles: ALM_CONFORMANCE_THREE_AGENT_ROLES`. Carriers:
  `ALM_CONFORMANCE_SINGLE_HOP_CARRIERS` for delivery and catch-up; a private `FENCED_REJECTION_CARRIERS = ['ws']` for
  the rejection (R-R2-17; its doc comment states why).
- Modify `alm-conformance-roles.ts`: add `ALM_CONFORMANCE_THREE_AGENT_ROLES` (`['sender','receiver','recipient-b']`);
  `scenarios/receipted-audience.ts` uses it and deletes `RECEIPTED_AUDIENCE_ROLES` (no other user).
- Modify `alm-conformance-session-commands.ts`: `toEnsureMemberCommand(step)` becomes
  `toSelfMembershipCommand(step, status: AlmConformanceSelfMembershipStatus /* 'active' | 'left' */)` driven by a private
  `SELF_MEMBERSHIP_WRITES` table — `active` → command `ensure-member`, request `member`, the old purpose string;
  `left` → command `leave-roster`, request `leave-roster`, purpose `'Leave the group, so its roster version
  advances.'`; body `{ status }`. `toEnsureRequestId`'s operation type is `'group' | 'member' | 'leave-roster'`.
  Adding a separate export instead trips `file.responsibility-count` (base 11 runtime exports; 12 fails).
- Modify `create-alm-conformance-recipes.ts`: `toSelfMembershipCommand(recipe, 'active')` replaces
  `toEnsureMemberCommand(recipe)`; register `fencedDelivery, fencedCatchUp, fencedRejection` right after
  `...receiptedAudience`; `notYetInSync` (no spread). `alm-conformance-scenario-definition.ts`: the three ids in the union.
- Rewrite `scenarios/not-yet-in-sync.ts` to one definition, key `not-yet-in-sync-expires`, `RTC_CARRIERS` (the
  variant array, `delivered-after-refresh` and its sender/receiver branches deleted; payload, delivery and waits
  byte-identical to the old `expires` branch).
- Modify `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-typed-channels.ts`:
  `#recordMessage`'s `data` gains `rosterVersion: toRosterStamp(message.raw.targets)` **right after `typeId`**; private
  `toRosterStamp(targets: ALTargets | undefined)` returns `undefined` for no targets or `unicast`, else
  `targets.rosterVersion`.
- Modify `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts` `HETZNER_WITHHELD_ALM_SCENARIOS`: delete the
  `not-yet-in-sync-delivered-after-refresh` entry and its comment; append `fenced-delivery`
  (`ALM_CONFORMANCE_SINGLE_HOP_CARRIERS`, "lane evidence is local and the hosted full read's; manifest 22 stays as
  recorded"), `fenced-catch-up` (same carriers, "A combined recipe keeps only its first prologue, so the recipient that
  leaves here would miss every later cell"), `fenced-rejection` (`['ws']`, "The same for the sender, which leaves
  before it sends").
- Docs: `../../docs/schema-and-capabilities.md` (a `membership-fence` block before `cross-carrier-duplicate`; the
  not-yet-in-sync paragraph rewritten to the expiry cell), `../../docs/alm-observation-artifact.md` (the red sentence
  goes; `fenced-catch-up` over `rtc` shares the refusal reading), `../../docs/runtime-diagnostic-contract.md` (six
  room-authority branches incl. the roster floor; `membership-fenced` — wording follows Task 3's strings).
- Tests: create `packages/tests/shared-test/alm-conformance-membership-fence.test.ts`; modify
  `alm-conformance-recipes.test.ts`, `alm-conformance-recipe-validation.test.ts`, `rallar-browser-runtime/messaging.test.ts`
  (shared-test), `packages/tests/rallar-black-box/{hetzner-alm-manifest-entries,hetzner-distributed-manifests,
  full-stack-three-agent-run}.test.ts`, and the fixture `apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts`.
  `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts` needs nothing: its three-agent test runs every
  `three-agent` cell of the carrier.

**The cells (exact command names; prologue `ensure-group, ensure-member, connect` and the trailing `stats` omitted)**

- `fenced-delivery` sender: `storage-counters-connected`, `toAudienceSendCommands({ sender, ttlMs: NON_EXPIRING_TTL_MS })`
  (`send-1` `all-logical-recipients`, at-least-once, ttl 30 000, no floor; `observe-admitted-1`, `assert-admitted-1`).
  Receiver and recipient-b: `received-1` (count 1), `read-roster` (private `http.request` GET
  `/api/state/apps/<app>/workspaces/<ws>/groups/<groupId>`, `response: { body: 'json', acceptedStatusCodes: [200] }`,
  timeout `toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, deadline)`), `roster-stamp` (private wait: `kind: 'message'`,
  `connection: receiverConnection`, `payloadPath: 'data'`, `contains: '"typeId":"<cell type>","rosterVersion":{resultCache.<read-roster id>.value.body.group.rosterVersion},'`,
  timeout 5 000), `received-2` (count 2 absent).
- `fenced-catch-up` sender: `send-1` (payload `{ marker, carrier, send: 'floored' }`, `ack: 'receiver'`, at-least-once,
  ttl 30 000, commandTimeoutMs 10 000, `minSnapshotVersion: { aboveCurrentBy: 1 }`), `observe-admitted-1`,
  `assert-admitted-1`, `catch-up-nack` (`toCommittedControlAdmissionWait` on `AL_CONTROL_NACK_TYPE_ID`, index 1),
  `send-2` (`send: 'roster-move'`, at-least-once, ttl 30 000, no floor), `observe-admitted-2`, `assert-admitted-2`.
  recipient-b: `received-roster-move` (`toPayloadWait` on the cue's payload), `leave-roster`
  (`toSelfMembershipCommand(recipient, 'left')`). Receiver: over `rtc` only `not-yet-in-sync-outcome`
  (`toAdmissionOutcomeWait`, `'"carrier":"rtc","outcome":"rejected","reason":"not-yet-in-sync'`, `toVerdictTimeoutMs`),
  then `received-floored` (payload wait on `send: 'floored'`), `received-3` (count 3 absent).
- `fenced-rejection` sender: `storage-counters-connected`, `leave-roster`, `send-1` (`ack: 'receiver'`, at-least-once,
  ttl 30 000, commandTimeoutMs 10 000), `fenced-nack` (committed NACK wait), `observe-rejected-1`
  (`toObserveCommand(..., state: 'rejected')`), then `toResultAssertion` named `assert-<expected>-1` on
  `failure.kind = 'relay-rejected'`, `relayRejection.relay = 'trusted-server'`, `relayRejection.reason = 'membership-fenced'`.
  No admission read: the NACK may settle the handle first. Both recipients: `received-1` (count 1 absent).

**Fixture** (`GeneratedAlmPorts`): `type PortRole = 'sender' | 'receiver' | 'recipient-b'` replaces every
`'sender' | 'receiver'` signature; a `recipientB` runtime; `writes: Record<PortRole, number>`; `group: PortGroup`
(`snapshotVersion: 7, rosterVersion: 4, left: Set<PortRole>`). `http.request` → `requestGroup(role, command)`: GET returns
`{ status: 200, body: { group: { snapshotVersion, rosterVersion } } }`; PUT `{status}` → `moveRoster(role, status === 'left')`,
which on a change bumps both versions and delivers every message `isFloorLifted`. `PortMessage` gains `rosterVersion`
(stamped at send), `floor` (`toPortFloor(minSnapshotVersion, group.snapshotVersion)`), `relayRejection`; `failure` gains
`{ kind: 'relay-rejected'; rejection }`. `route()`: sender in `left` → `refuseFenced` (asserts `ws`; NACK event; state
`rejected`; failure and `relayRejection`), else `floor > snapshotVersion` → `refuseNotYetInSync` (now: `recordSenderNack`
on both carriers, the receiver diagnostic over RTC only), else as before. `recordSenderNack` replaces the two inline
NACK events. `recordReceiverMessage` states `rosterVersion` after `typeId` and records on recipient-b unless it left.
`observe` returns `relayRejection`. Seven new `Deno.test`s (delivery ×2, catch-up ×2, catch-up-without-move fails ×2 with
`received-floored` shortened to 50 ms, rejection ×1).

**D8 reuse inspection.** Reused: the ensure-member request (one builder for both writes), `{resultCache…}` tokens in a
wait's `contains` (`wait/resolve-wait-match-result-references.ts`), `toAudienceSendCommands`, `toPayloadWait`,
`toAdmissionOutcomeWait`, `toCommittedControlAdmissionWait`, `toSingleArrivalReceiverCommands`, the withholding list,
`decodeStringLeaves` (below). Searched and absent: a group-state path helper in `packages/shared-test` (two private
copies exist; the GET path stays private to `fenced-delivery.ts`), an inbound group-state fault (R-R2-17), a barrier
outside a distributed run (the lane's control runs have none).

- [ ] **Step 1: Failing pins.** Write the new test file (25 cases: catalog per carrier, identities and validity,
      command names, send shapes, `read-roster`, `roster-stamp` exact, a run that passes with roster 4 and fails with 44,
      `catch-up-nack` exact (timeout 27 000), the leave's PUT path
      `.../members/{auth.clientId}/requests/alm-conformance-{runtimeIdentity}-<carrier>-fenced-catch-up-recipient-b-leave-roster`,
      the rtc refusal wait, ws-only rejection, the rejection assertions and a run that fails on reason `unauthorized`).
      Update the pins: recipes test (`MEMBERSHIP_FENCE_KEYS_BY_CARRIER` after the receipted keys; the variant out of
      `SCENARIO_KEYS_BY_CARRIER`; one `not-yet-in-sync` in the fallback full-only list; the rtc tag list 24 entries; three
      not-yet-in-sync tests rewritten to the expiry cell; recipient-b on `receipted-audience` and `fenced-*`), validation
      test (`CARRIER_SCENARIO_IDS`; skip GET requests in the request-id test), hosted entries (variant out; 3-agent entry
      withholds the fence cells), `full-stack-three-agent-run.test.ts` (ws adds the three keys, rtc two), `messaging.test.ts`
      (the RTC copy's raw carries `targets: { mode: 'multicast', groupRef: roomRef, rosterVersion: 4 }`; its `data`
      expects `rosterVersion: 4`), the fixture tests. `hetzner-distributed-manifests.test.ts`: delete the vacuous
      `delivered-after-refresh` assertion and its comment; touching the file enforces its four `boundary.unknown`
      findings: `RallarBlackBoxTestRecord` for `rallar`, `metadata`, `thresholds`, and `decodeStringLeaves`
      (`browser/browser-command-placeholders.ts`) replaces the local `toNestedStringValues`.
- [ ] **Step 2: Red.** `npx vitest run packages/tests/shared-test/alm-conformance-membership-fence.test.ts packages/tests/shared-test/alm-conformance-recipes.test.ts packages/tests/shared-test/alm-conformance-recipe-validation.test.ts packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts packages/tests/shared-test/rallar-browser-runtime/messaging.test.ts`
      → `Tests  32 failed | 66 passed (98)`; `cd apps/rallar-black-box-control-server && deno test --allow-run --allow-net --allow-env --allow-read --allow-write test/control-generated-alm-reload.test.ts`
      → `23 passed | 7 failed` (`AssertionError: fenced-catch-up over rtc`).
- [ ] **Step 3: Implement** the files above. **Step 4: Format** `npx dprint fmt <the 22 files>`.
- [ ] **Step 5: Green.** The six files plus `hetzner-distributed-manifests.test.ts` → `Tests  124 passed (124)`
      (25/40/5/10/26/2/16); the fixture → `30 passed | 0 failed`; `node --import tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check`
      → `checked 67 Hetzner distributed manifest(s)` (`npx tsx` fails in the sandbox on its IPC pipe);
      `npx tsc -p packages/shared-test/tsconfig.json --noEmit`, the four pins, the bundle checks with a private `TMPDIR` (the received event is in the headless agent: facade 239.222 KiB of 240, headless 304.573 of 305), `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit`,
      `deno check` on the changed `packages/shared-test/**` files, `node scripts/check-tests-typecheck.mjs` clean.
- [ ] **Step 6: Commit**, then `npm run check:repo-style:changed -- 90425bdf8 HEAD` (PASS),
      `node scripts/check-test-structure-coupling.mjs --changed 90425bdf8 HEAD` (PASS), `npm run check:test-reachability`
      (`1758 test files, 1752 reached by CI, 6 manual`). Sandbox reds, green unsandboxed: `live-rtc-control-client`,
      `api-v1-rtc-rtt-recipe-semantics`, `api-v1-state-write-convergence-recipe`, `local-websocket-session`,
      `headless-worker-script`; the control-server suite (220) needs loopback binds.

```text
The lane fences room sends on the roster: delivery, catch-up, rejection

A three-agent membership-fence family runs over ws and rtc. fenced-delivery
reads the group roster over HTTP after the arrival and finds it on the
delivered message's rosterVersion, which the received event now states
right after typeId. fenced-catch-up floors its first send one snapshot
past the sender's, waits for the not-yet-in-sync NACK, then sends the cue
on which recipient-b leaves the group; the move lifts the floor and the
receiver gets the floored send once (over rtc after its own refusal).
fenced-rejection (ws) leaves the group, sends, and reads the trusted
server's membership-fenced rejection on the handle; over rtc the sender's
own room authority refuses first and no harness step holds its group-state
stream, so the cell does not run there. The roster moves by the
self-service membership route ensure-member already uses. The
not-yet-in-sync delivered-after-refresh red is deleted with its hosted
withholding; manifests 18 and 22 withhold the new cells and stay
byte-identical; the control-server fixture models the group's versions,
the floor's release on a roster move and the fenced refusal.

D8 reuse: the self-service membership request ensure-member sends (one builder for both writes), the result-cache tokens a wait resolves in contains, the receipted-audience three-agent roles, the not-yet-in-sync refusal wait, the committed-control wait and the hosted withholding list; no new command kind.
```

### Task 7: The consumer pin and the docs (D149)

Anchors at Task 6's commit (10 files, +309/−104). Both pins assert what Task 2 built: on a tree without Task 2 they
read red on `rosterVersion` only (`-   "rosterVersion": 4,` / `+   "rosterVersion": undefined,` with
`"minSnapshotVersion": 9` matched); at this point in the plan they read green on the first run.

**Files**

- Create `packages/tests/shared-web/messages/rallar-facade-test-runtime.ts` (R-R2-21, R-R2-33): the real-facade
  scaffolding moved out of `browser-rallar-message-sender.test.ts:1-49` once, in the shape of
  `packages/tests/shared-web/rooms/room-workflow-test-runtime.ts`. A private `rallarFacadeMocks = await vi.hoisted(...)`
  holds `ctx: createDefaultApiMiddlewareTestDouble()` (dynamic import of `../api-middleware-test-double.ts`) and three
  `vi.fn`s typed from `GroupStateSnapshotsRepositoryModule`: `findFirstGroupStateSnapshotRefSessionIdIsIn`,
  `findGroupStateSnapshotByRef`, `getAllGroupStateSnapshots`. Three `vi.mock(import(...), async (original) => ({
  ...await original(), ... }))`: `initialise-browser-middleware.ts` → `initialiseMiddleware` resolves
  `{ middleware: rallarFacadeMocks.ctx.middleware, checkpoints: [] }`; `@shared/api/auth.ts` → `readSession` returns
  `rallarFacadeMocks.ctx.session`, `isLoggedIn` → `true`; `group-state-snapshots-repository.ts` → the three `vi.fn`s.
  The module body then calls `setRallarFacadeRoomSnapshots([])`. Four exports, each with a one-line doc:
  - `readRallarFacadeMocks(): typeof rallarFacadeMocks` — "The doubles behind a real facade: its middleware and session,
    renewed per test, and its room snapshot reads."
  - `resetRallarFacadeTestRuntime(): void` — `configureTestCacheRepositories()`, a fresh
    `createDefaultApiMiddlewareTestDouble()` (static import) into `ctx`, `setRallarFacadeRoomSnapshots([])`.
  - `setRallarFacadeRoomSnapshots(snapshots: readonly GroupSnapshot[]): void` — the sender test's `mockGroupSnapshots`
    body, moved (the three implementations over `snapshots`).
  - `createRallarTestFacade(): RallarFacade` — `createRallarFacade()` from
    `@shared-web/browser/composition/create-rallar-facade.ts` (not `rallar.ts`: the AR Eye Hunter harness mocks it)
    with `onTestFinished(() => facade.disconnect())`.
- Modify `packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts`: delete the three `typeof` module
  imports, the `rallar.ts` import, `onTestFinished`, `configureTestCacheRepositories`, the hoisted block and the three
  mocks (`:21-44`), `mockGroupSnapshots` (`:571-583`) and `createFacade` (`:615-619`); import the four names from
  `./rallar-facade-test-runtime.ts`; `const mocks = readRallarFacadeMocks();`; the `beforeEach` (`:52-61`) becomes
  synchronous: `vi.clearAllMocks(); resetRallarFacadeTestRuntime();` then the three `vi.mocked` rebinds;
  `createFacade()` → `createRallarTestFacade()`, `mockGroupSnapshots(` → `setRallarFacadeRoomSnapshots(`;
  `mockGroupSnapshot(snapshot)` stays as the one-snapshot call. Still 21 tests.
- Modify `packages/tests/shared-web/director/browser-director-relay-transport.test.ts`: import the four names from
  `../messages/rallar-facade-test-runtime.ts`, `createGroupSnapshotFixture` from `../authoritative-group-fixtures.ts`,
  `type GroupSnapshot`, `beforeEach`; `const mocks = readRallarFacadeMocks();` before `current` (`:12`). A new
  `describe('director notification fence')` after `describe('director command')` with
  `beforeEach(() => resetRallarFacadeTestRuntime())` and one case (below), and a private
  `toDirectorRoomSnapshot(versions: Readonly<{ snapshotVersion: number; rosterVersion: number; }>): GroupSnapshot`
  over `createGroupSnapshotFixture({ applicationId: 'app', workspaceId: 'workspace', groupId: 'room', sessionIds:
  [mocks.ctx.session.sessionId, 'peer-1'] })` with the two versions overridden on `group`.
- Modify `packages/tests/ar-eye-hunter-v1/arena-director-delivery.test.ts`: import `arenaRoomRef` from the harness,
  `BrowserDirectorRelayTransport`, `GAME_DIRECTOR_TOPIC_ID` from `apps/ar-eye-hunter-v1/src/game/types.ts`, `type
  GroupSnapshot`, `createGroupSnapshotFixture` and the four runtime names (`../shared-web/messages/...`);
  `const directorRallar = readRallarFacadeMocks();` (doc: "The director's own Rallar session and room cache, for the
  one case that sends a match output through the real relay."); one case in `describe('arena match lifecycle
  delivery')` and a private `toArenaRoomSnapshot(versions)` over `{ ...arenaRoomRef, sessionIds:
  [directorRallar.ctx.session.sessionId, 'peer-b'] }`. The 24 existing cases stay green under the runtime's mocks (the
  arena reads only `readAuthSessionStorageKind` from `@shared/api/auth.ts`).
- Docs: `docs/rallar-api-reference.md`, `packages/shared/alm/inbound/README.md`, `packages/shared/alm/outbound/README.md`,
  `packages/shared-web/browser/README.md`, `playground/alm/alm-complete-product-description.md`,
  `playground/alm/alm-improvement-plan.md` (consumer table only).

**The two pins (exact)**

- Relay: `it('stamps the snapshot and the roster of the director\'s cached room snapshot on a receipted room output')`:
  `setRallarFacadeRoomSnapshots([toDirectorRoomSnapshot({ snapshotVersion: 9, rosterVersion: 4 })])`;
  `const facade = createRallarTestFacade()`; `new BrowserDirectorRelayTransport({ messages: facade.messages,
  readSession: () => mocks.ctx.session }).sendRoomEnvelope({ ...envelopeInput, ack: 'all-logical-recipients' })`; then
  `vi.mocked(mocks.ctx.middleware.rtcRxStreamer).enqueueOutboxIfAbsent.mock.calls[0][0].targets` `toMatchObject`
  `{ mode: 'multicast', groupRef: current.roomRef, minSnapshotVersion: 9, rosterVersion: 4 }`.
- AR Eye Hunter: `it('fences the published match start on the director\'s roster: its relay output carries the cached snapshot and roster')`:
  `renderDirector(arena, toArenaSnapshot(createInitialArenaState(44, now), 'arena-1', now))`, the existing
  `sendIntent` → `config.onIntent(directorEnvelope(...))` loop-back, `startArenaMatch(60_000)`; take
  `[started, options]` from the `mockMatch.publishEvent` call whose event kind is `director-match-started`; then
  `resetRallarFacadeTestRuntime()`, `setRallarFacadeRoomSnapshots([toArenaRoomSnapshot({ snapshotVersion: 9,
  rosterVersion: 4 })])`, `createRallarTestFacade()`, a relay as above, and
  `relay.sendRoomEnvelope({ current: { ...freshDirectorStatus(), roomRef: arenaRoomRef }, topicId: GAME_DIRECTOR_TOPIC_ID,
  typeId: \`${GAME_DIRECTOR_TOPIC_ID}.event.v1\`, payload: started, ack: options?.ack })`. Assert`options`equals`{ ack: 'all-logical-recipients' }`and the enqueued RTC targets match`{ mode: 'multicast', groupRef: arenaRoomRef, minSnapshotVersion: 9, rosterVersion: 4 }`.

**Docs (factual, no decision ids)**

- API reference, "Ordering, Repair And Resynchronization": drop "an RTC send's `membershipEpoch` is the position's
  epoch"; add "No browser send sets the epoch: a browser sender's track ends by its TTL or by the receiver's
  resynchronization." New `### Membership Fencing` before `### RTC Status And Readiness`: the two stamps on every room
  send (RTC multicast, WS room broadcast, the fallback's room broadcast), absent together without a cached snapshot, no
  caller roster; behind either stamp `not-yet-in-sync` and the bounded catch-up per carrier; at or beyond them with the
  member absent or not `active`, `membership-fenced` NACKed to the hop. From the WS server before a receipt row the
  handle settles `rejected` (R-R2-31) with `failure: { kind: 'relay-rejected', rejection }` and
  `evidence.relayRejection` `{ relay: 'trusted-server', reason: 'membership-fenced' }`; a peer's refusal reads
  `{ relay: 'peer', peerId, reason }` the same way only when the peer is the unicast addressee or a composition hop. An
  RTC room send names no hop, so its sender hears a peer's fence only through a tracked receipt: `failed` with
  `{ kind: 'receipt-exhausted', cause: 'hop-refused', hopPeerId, nackReason: 'membership-fenced' }`; with
  `ack: 'none'` never (R-R2-29). On RTC an absent session with a present member waits at its own roster and is fenced
  in a roster beyond its stamp; the WS server fences a sender with no live session at once (R-R2-13, R-R2-24). The
  fence applies where a copy arrives from a hop: an origin keeps its verdicts, so a removed sender's own sends wait at
  its origin until their deadline (R-R2-30); a fenced NACK carries no ordering hints, asks for no repair and triggers
  no refresh (R-R2-32). WS fenced at the server, the WS client trusts it, server publications unfenced;
  `AL_MESSAGE_ENVELOPE_VERSION` (3), any other refused `unsupported`.
- Inbound README: a `**Room authority and the membership fence.**` paragraph after "Ordering gaps and
  resynchronization" stating the RTC receiver's verdicts (behind either floor `pending` → `not-yet-in-sync`, NACK, one
  refresh, one re-admission; at or beyond both an absent or inactive member `membership-fenced`, NACKed with no
  ordering hints, repair or refresh; an absent session with a present member `pending` at its own roster and fenced
  beyond it; every other denial `unauthorized`, no NACK), that the fence applies at ingress only (a copy with a
  `fromPeerId`; the origin, targeted repair and held copies keep their verdicts), and that the WS server applies both
  floors and fences a sender with no live session or no active member at admission and dispatch. The roster-fence
  schema bump and cutover window are Task 1's text; do not repeat them.
- Outbound README: the trusted-server pre-admission refusal reads "`unauthorized` or `membership-fenced`"; a peer's
  `membership-fenced` NACK before any receipt row is a peer `relay-rejected` only from the unicast addressee or a
  composition hop, while an RTC room send hears a peer's fence only through a tracked receipt (`receipt-exhausted`,
  `hop-refused`) and an `ack: 'none'` room send never; "a sender that is not an active member" moves out of the
  `unauthorized` list (a sender without a live session or an active member is `membership-fenced`); "A hop that refuses
  for good" lists `membership-fenced`.
- Browser README, the `BrowserRallarMessageSender` bullet: every room send carries both stamps from the cached room
  snapshot through one resolver of the room state store; none without a cached snapshot; no caller roster.
- Product description: "The v2 envelope" → "The v3 envelope"; the R2 rename sentence becomes past tense with
  `targets.rosterVersion` and `AL_MESSAGE_ENVELOPE_VERSION`; the Multicast "Membership fencing must use … explicitly
  unsupported" sentences become the roster fence on every room send; `**PLANNED — R2, fencing:**` →
  `**CURRENT — R2, fencing:**` (stamps, verdicts; from the WS server the handle reads `rejected` (`relay-rejected`)
  before a receipt row, and an RTC room send hears a peer's fence only through a tracked receipt, which ends
  `receipt-exhausted` with `hop-refused`; WS at the server, the lane's three cells and the `rtc` rejection as a unit
  pin); PC6 "when requested and supported" → "on every room send".
- Roadmap consumer table row `5 R1, R2`: AR Eye Hunter "The match-start notification is fenced on the director's
  roster by construction: the director relay's room send stamps it (no rounds exist)."; Relic "Moves to R2b: round
  transitions on an ordering key per round with range repair need a server-assigned sequence per track, which the
  server's publish path lacks." Format with `npx dprint fmt` on that one file only.

**D8 reuse inspection.** The sender test's real-facade scaffolding is extracted once into the shared test runtime the
sender, relay and arena tests import (the repo's `*-test-runtime.ts` pattern: a module whose hoisted `vi.mock`s apply
to every test that imports it); `createGroupSnapshotFixture`, `configureTestCacheRepositories`, the harness's
`freshDirectorStatus`, `arenaRoomRef`, `renderDirector`, `directorEnvelope`. The match-start message and options come
from the arena's own `publishEvent` call.

- [ ] **Step 1: The runtime and the pins.** Create the runtime, move the sender test onto it
      (`npx vitest run packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts` → `Tests  21 passed (21)`),
      then write both pins.
- [ ] **Step 2: Run.** `npx vitest run packages/tests/shared-web/director/browser-director-relay-transport.test.ts
      packages/tests/ar-eye-hunter-v1/arena-director-delivery.test.ts` → `Tests  42 passed (42)` (17 and 25). A red here
      means the stamp is not read from the same cached snapshot the floor is.
- [ ] **Step 3: Docs** as above; `npx dprint fmt <the six docs, the runtime and the three tests>`; `npx dprint check` on
      them clean.
- [ ] **Step 4: Checks.** `npx vitest run packages/tests/shared-web/director packages/tests/ar-eye-hunter-v1
      packages/tests/shared-web/messages packages/tests/shared-web/rallar-group-public-contracts.test.ts
      packages/tests/repo/rallar-group-documentation.test.ts packages/tests/repo/rallar-authoritative-mutation-guidance-integrity.test.ts
      packages/tests/repo/validation-evidence/build-affecting-tree.test.ts` (`44 files, 553 tests`, green);
      `node scripts/check-tests-typecheck.mjs` (PASS); no source change, so no bundle check.
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- 90425bdf8 HEAD` (PASS),
      `node scripts/check-test-structure-coupling.mjs --changed 90425bdf8 HEAD` (PASS) and `npm run check:test-reachability`
      (1758 test files, 1752 reached by CI, 6 manual; the runtime is not a test file).

```text
Pin AR Eye Hunter's match start on the director's roster and document the fence

The director relay's receipted room output, and AR Eye Hunter's match-start
notification sent through it, carry the director's cached snapshot and
roster on their room target: two pins over a real messages facade whose
room cache holds the director's room. The sender test's real-facade
scaffolding moves into one test runtime that the sender, relay and arena
tests import. The API reference states the membership fence (the two
stamps on every room send, not-yet-in-sync catch-up behind them,
membership-fenced at or beyond them, the handle rejected by a relay or
failed hop-refused through a tracked receipt, WS fenced at the server)
and drops the ordering epoch's membershipEpoch setter; the inbound README
states the RTC receiver's verdicts, the outbound README the fenced NACK on
the handle, the browser README the stamp. The product description's R2
fencing is CURRENT, PC6 fences every room send, and the roadmap's consumer
row names the match-start notification and moves Relic's ordered rounds
to R2b.

D8 reuse: the sender test's real-facade scaffolding (the middleware, auth and snapshot repository mocks), extracted once and shared, the authoritative group snapshot fixture and the existing relay transport; no second copy.
```

### Task 8: Close

Pins unchanged and bundles measured; the static merge bar (typecheck, build, changed-range gates,
reachability, dprint, manifests `--check`); the local lane `npm run test:rallar:full-stack:memory:alm`
with the three `membership-fence` cells over `ws` and `rtc` (scope `full`), every red named from its
artifact; `npm run test:postgres:integration` and the api-v1 medium-scale gate once (the WS server's
admission changed); the three-seat final review (product, harness, code quality) with one fix wave;
push; the Branch Release Gate, the API gates and CodeQL green on the code head; hosted manifests 18
and 22 dispatched from the branch as regression reads (`hetzner-distributed-recipe.yml` with
`-f ref=claude/alm-r2-membership-fencing`); the PR body (Goal, Changes, Public surface, Acceptance, Validation with every red
named, Rulings, Corrections, Limits, Risk and rollback, Follow-ups incl. R2b); the last commit records
"Delivered (R2, " followed by the merged code head's short sha and "; #642)" on the roadmap's "Releases 4 to 8" row, updates the fresh-session
paragraph (R2b next) and the revision history, and deletes this plan file.

**What each live cell must show.** Run:
`RALLAR_BLACK_BOX_ALM_SCOPE=full RALLAR_BLACK_BOX_ALM_CARRIERS=ws,rtc npm run test:rallar:full-stack:memory:alm -- -g "three-agent family"`
(the cells run after the four receipted-audience cells, about 25 s each, inside the 540 s budget).

| Cell             | Carrier | The live run must show                                                                                                                                                                                                                                                                           |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fenced-delivery  | ws, rtc | Send admitted. Both recipients get `received-1` within 27 s. `read-roster` returns 200 with roster R. `roster-stamp` matches `"typeId":"alm.conformance.ws.fenced-delivery","rosterVersion":R,` (`rtc` in place of `ws` over RTC) (Task 2's stamp on both carriers). No second arrival.          |
| fenced-catch-up  | ws      | `send-1` admitted. The server's advisory not-yet-in-sync NACK reaches the sender (`catch-up-nack`, any outcome). The cue reaches both recipients. recipient-b's leave returns 200. The server's replay of the retained `send-1` passes at S+1. `received-floored` within 27 s. No third arrival. |
| fenced-catch-up  | rtc     | The receiver logs `rejected` / `not-yet-in-sync` for `send-1`. The NACK commits. Cue, then the leave. The receiver reaches S+1 (WS update or refresh). A retry within the ≈8 s receipt budget is admitted. `received-floored`. No third arrival.                                                 |
| fenced-rejection | ws      | The leave returns 200. `send-1` is admitted locally. A `membership-fenced` NACK commits. The handle is `rejected` with `failure.kind` `relay-rejected` and `relayRejection {trusted-server, membership-fenced}`. Neither recipient receives anything for 17 s.                                   |

Risks to check first on a red: the sender's cache is behind the server (a layout re-plan) so the floor is met at once
and `catch-up-nack` times out; the WS server refuses a left member's room publish before its room authorizer runs (a
different NACK reason); on RTC the receipt budget runs out before the move.

- [ ] **Step 1: Pins and bundles.** The four pins green and unedited; the facade at 239.222 KiB of 240, headless
      304.573 of 305 (or the next whole KiB with the figure in the PR body).
- [ ] **Step 2: Static merge bar.** `npm run typecheck`, `npm run build`, the changed-range gates against `origin/main`,
      `npm run check:test-reachability`, `npx dprint check`, `node --import tsx
      apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check` (`checked 67`).
- [ ] **Step 3: The live lane** as above, every red named from its artifact.
- [ ] **Step 4: Postgres.** `npm run test:postgres:integration` and `npm run test:api-v1:black-box:postgres:medium-scale`
      once.
- [ ] **Step 5: Final review** (three seats, one fix wave), push, CI green on the code head, hosted manifests 18 and 22
      dispatched from the branch.
- [ ] **Step 6: PR body and the delivered line;** delete this plan file in the last commit.
