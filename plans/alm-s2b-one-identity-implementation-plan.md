# ALM S2b One Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give one logical message one inbound identity per browser session whatever carried it, so an
RTC-then-WS (or WS-then-RTC) arrival of the same message reaches the page exactly once, the control and
ACK history rows say which carrier each entry arrived on, the browser database resets once on the
schema move, and the already-implemented `not-yet-in-sync` behaviour finally has a conformance
scenario.

**Architecture:** The two browser inbound admission stores (`browser-ws-client:<sid>` inbound and
`browser-rtc-rx:<sid>`) become one session inbound store, resolved once in the composition root and
handed to both carrier services. The two inbound runtimes stay (shape A, decision S2b-1 below): each
claims only the work rows whose QueueBox type names its carrier, so dedup, message-owner, ordering,
supersedence and control rows are session-logical while planning, delivery, control sends and
forwarding keep their carrier. Carrier is a required field on every `pending` and `acks` control value
the inbound store writes; the control/ACK row family moves out of `al-inbound-admission-store.ts` into
its own file. `AL_ADMISSION_SCHEMA_ID` moves to `rallar-alm-2026-09-s2b` and every existing browser
database resets on mismatch. Two harness fields on `messages.send` make the two scenarios expressible.

**Tech Stack:** TypeScript across Node, Deno and browser; Vitest with `fake-indexeddb`; Playwright;
dprint; the black-box recipe generator in `packages/shared-test/rallar-bb-test/conformance/alm/`.

**Spec:** [playground/alm/alm-improvement-plan.md](../playground/alm/alm-improvement-plan.md), section
"Release 3, Slice 2: outcomes" (the S2 paragraph) and decisions D3, D8, D17, D18, D20, D30 in its decision
table; the shapes are [playground/alm/alm-s2-design-proposal.md](../playground/alm/alm-s2-design-proposal.md)
§1.2, §1.4, §2.2, §4 (decisions 3 and 13), §5 "S2b" and §6 "S2b". The code survey this plan argues from is
`.superpowers/s2b-survey.md` in the executing worktree (git-ignored; its findings are restated here where
a task depends on them). S2b starts from merged `main` `4c4634841` (S2a, PR #583) and precedes S2c
(D18).

## Decisions this plan takes, for the maintainer to confirm before Task 1

The proposal and D18–D31 settle the merged store, the schema bump and the measured pins. The survey
found four things they do not settle. Each is decided below with the plan's recommendation; a different
answer changes the named tasks and nothing else.

- **S2b-1 — two runtimes over one store, carrier-partitioned work types (shape A).** Each
  `ALInboundMessageRuntime` claims exactly one QueueBox work type
  (`al-inbound-message-runtime.ts:143-149`), re-plans stored rows with its own carrier's planner (the
  RTC planner applies room authority, the WS one does not), delivers to its own carrier's consumers,
  sends control messages on its own outbound and, for RTC, forwards. Sharing one work type would let
  the WS runtime claim an RTC row and skip room authority, deliver on the wrong transport, ACK on the
  wrong carrier, and claim reloaded RTC rows before the RTC runtime exists (it is built later,
  `initialise-browser-middleware.ts:318-326` after `:235-262`). Shape A keeps every one of those
  semantics: the work row's QueueBox `typeId` gains the carrier
  (`AL_INBOUND:<carrier>:<fnv(namespace)>`), each runtime claims its own type, and the key layout stays
  session-logical so dedup and owner rows are shared. Shape B (one runtime per session with
  carrier-dispatching ports) moves the runtime out of both services into the middleware, needs the RTC
  ports bound after construction — which collides with visible construction — and rewrites the
  standalone test construction of `WsQueueBoxClientService`. Recommended: **A**.
- **S2b-2 — the carrier field is required on the shared control value, and the server's ≤ 30-minute
  decode window is accepted under D3.** `ALControlPersistenceValue` and `decodeALAdmissionControlValue`
  (`al-contracts/al-control.ts:94-98`, `al-admission-value-validation.ts:46-92`) are shared with the
  outbound store and with the WS server's PostgreSQL inbound store
  (`packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts:71-87`), which has no
  schema id and no reset. A required field makes a pre-deploy `pending`/`acks` row undecodable until its
  TTL passes (`controlHistoryTtlMs` and `controlPendingTtlMs` default to 30 min, `ALStoreRetention.ts:41-42`).
  D3 records that there are no real users and D8 forbids retained legacy, so the plan takes the required
  field and states the deploy-time window in the PR body; the decoder's failure stays the typed
  `ALAdmissionCorruptionError` it already is. The alternatives — an optional field (rejected by the
  required-fields rule, absence has no domain meaning) or a browser-only wrapper row (a second control
  value shape the outbound store would then not share) — are not taken. Recommended: **required field,
  window accepted**.
- **S2b-3 — two harness fields on `messages.send`, in this slice.** The product never sends one logical
  message over both carriers (fallback happens only when the first carrier refuses admission,
  `browser-rallar-message-dispatch.ts:145-154`), and the generator cannot express a snapshot floor
  (`messages.send` has no `minSnapshotVersion`; the only precedent is the legacy runner recipe
  `rtc-rallar-browser-not-yet-in-sync.json` over `rtc.send`). Task 4 adds `replayOnCarrier` (submit the
  same envelope of an earlier handle to the named carrier) and Task 5 adds `minSnapshotVersion` with a
  relative form (`{ aboveCurrentBy: 1 }`), both as harness capabilities under the black-box control
  protocol, never as product behaviour. Recommended: **both fields, here**.
- **S2b-4 — acceptance wording follows the code.** (a) The storage reset cannot be observed in the
  conformance lane (agents run in fresh Playwright contexts, so no database ever mismatches); the
  evidence is the unit reset test with the previous schema id. (b) At admission a `not-yet-in-sync`
  verdict writes no rows — it sends the NACK and triggers the receiver's one-shot in-memory refresh and
  re-admit (`web-rtc-rx-streamer-service.ts:182-190`, `rtc-group-snapshot-refresh.ts:31-64`); the
  durable retention covers rows already admitted whose re-plan regressed. The scenario therefore
  proves NACK → sender retry → delivery after the snapshot advances, and NACK → expiry → absence; it
  does not claim a durable receiver-side retention at admission. (c) The three named pins may read
  "unchanged, measured" (D30). Recommended: **as stated**.
- **S2b-5 — the ws-client scope becomes outbound-only.** `browser-ws-client:<sid>` also names the WS
  outbound store. The inbound side moves to the new session inbound id; the outbound id, its keys and
  its tests do not move. `toBrowserWsClientALRuntimeStoreId` keeps its name and gains the doc line "WS
  outbound only since S2b"; `toBrowserRtcRxALRuntimeStoreId` is deleted with its last consumer.
  Recommended: **as stated**.

## Global Constraints

- Decision D8: search `packages/**` before writing anything; ask before an internal library; no new
  third-party dependency.
- No retained legacy: every replaced path is removed in the commit that replaces it, including its
  tests; obsolete coupled tests are rewritten in the same commit. `toBrowserRtcRxALRuntimeStoreId`
  and the rtc-rx inbound scope leave with Task 1.
- No migration and no old-format fallback (D3, D17). The browser database resets on the schema-id
  mismatch (`open-indexed-db-admission-database.ts:59-72`); the server's Postgres rows expire under
  their TTL (S2b-2). No dual decode, no compatibility read.
- Touched-file standards closure: every touched human-authored file is reviewed and remediated in
  full; a support file changed by that remediation enters closure recursively.
- No duplicated logic: a private reader that already exists is widened, never re-implemented.
- Canonical verbs (`readXxx`, `computeXxx`, `validateXxx`, `resolveXxx`, `toXxx`); `handle`,
  `process`, `execute`, `util`, `helper`, `data` do not appear in the touched files.
- Expected failure is an `Either` value or a typed outcome; `assertXxx` is reserved for programmer
  invariants. A conflict stays a value; `ALAdmissionCorruptionError` only across the backend boundary
  that already throws it.
- Required fields by default in every contract this slice extends (`carrier` is required everywhere it
  appears); at most three positional parameters; `interface` for object contracts and `type` for
  unions; one canonical name per type. The carrier type is the existing
  `ALDeliveryCarrier = 'rtc' | 'ws'` (`alm/delivery/al-delivery-lifecycle.ts:38`); no new carrier union.
- No new `file.cognitive-load` pin on an ALM file and no new disposition entry. Files at the edge:
  `web-rtc-rx-streamer-service.ts` is at cognitive load 49 (warn is 50) and
  `ws-queue-box-client-service.ts` is already at 54; a task that adds a branch to either splits the
  branch into its own file instead. `al-inbound-admission-store.ts` is at 882 net lines against the
  1 200-line backstop and only shrinks in this slice.
- **Never weaken a harness budget or a lane constant to make a run pass.** The harness constants of
  the S2a plan stay (`CONNECT_READINESS_TIMEOUT_MS` 30 000, `CONFORMANCE_DEADLINE_MS` 18 000,
  `NON_EXPIRING_SEND_TIMEOUT_MS` 10 000, `EXPIRY_TTL_MS` 7 500, the 3 000 ms observe class; regimes
  30/35 ms per operation and 20/50 ms per probe).
- **No new timer, queue, coalescing window, registry or scheduler.** The claim partition is a QueueBox
  type string; the shared store is one object resolved once.
- Every new diagnostic field rides an existing payload (`admission-outcome`, `claim-settled`,
  `effect-drain`); no event kind is added; nothing is relayed per claim.
- Bundle ceilings in force: `browser/rallar.ts` < 215 KiB brotli (measured 214.27,
  `shared-web-browser-bundle-boundaries.test.ts:42-46`) and headless < 273 KiB (measured 272.27,
  `headless-bundle-boundary.test.ts:60-62`). Both have under 1 KiB of headroom; a crossed ceiling is
  raised to the next whole KiB with the measured figure recorded in the commit and the PR body
  (maintainer rule, 2026-09-05).
- The ALM lane stays the Release Gate's non-blocking observation job. The full scope is read by
  setting the repository variable `RALLAR_BLACK_BOX_ALM_SCOPE=full` for the read and clearing it after.
- D30: the three named pins are measured and recorded, never pre-declared; "unchanged" is a valid
  measurement. One default send's and one admission's operation counts (10 / 15 and 6 + 2, plus
  "admit + deliver one message = 8") must not change.
- Every commit keeps focused Vitest, `npx dprint check <files>` (explicit file list, never a glob) and
  the package typecheck green; before pushing: `npm run test:unit`, the three Deno checks,
  `npm run test:deno` (the WS server's Postgres inbound store shares the changed shapes),
  `node scripts/check-tests-typecheck.mjs`, `node scripts/check-test-structure-coupling.mjs --changed
  origin/main HEAD`, `npm run check:repo-style:changed -- origin/main HEAD`,
  `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`. Every push goes to the PR at
  once.
- PRs land through the maintainer's review: no `pr:delivery -- ready`, no auto-merge.

---

## File structure

**Identity and composition (shared-web):**

- `packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts` (64 lines): loses the rtc-rx
  inbound id, gains `toBrowserSessionALInboundRuntimeStoreId(sessionId)`; the session prefix and work
  namespace lists follow.
- `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts` (157): one inbound scope per
  session; `resolveBrowserSessionALInboundRuntimeStores` replaces the two inbound resolvers; in memory
  mode one shared inbound backend, mirroring the outbound precedent at `:128-130`.
- `packages/shared-web/browser/connection/initialise-browser-middleware.ts` (515 net): resolves the
  session inbound store once and passes it into the WS queue box and the RTC rx streamer.
- `packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts` (119) and
  `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts` (153): take `inboundStores` as
  input instead of resolving.
- `packages/shared/alm/al-runtime-stores.ts` (232): `inboundBackend` input beside the existing
  `outboundBackend`.
- `packages/shared/alm/open-indexed-db-admission-database.ts` (211): the schema id.

**Claim partition (shared/alm/inbound):**

- `packages/shared/alm/inbound/al-inbound-work-entry.ts` (260): the work type carries the carrier; the
  decoder and `validateALInboundWorkWrites` accept it.
- `packages/shared/alm/inbound/al-inbound-message-runtime.ts` (537): the runtime is constructed with
  its carrier and claims its type; `admitControlMessage` threads the source.
- `packages/shared/alm/inbound/al-inbound-effect-intent.ts`: every effect intent names its carrier.

**Carrier-tagged control rows (shared/alm/inbound):**

- New `packages/shared/alm/inbound/control/al-inbound-control-rows.ts`: the control/ACK row family
  moved out of `al-inbound-admission-store.ts` (keys, `PendingControlValue`, `AcksControlValue`,
  `readStoredAcknowledgements`, `readStoredControlOwnerIndex`, `readControlDecisionSurface`,
  `resolveALInboundAcknowledgedSenderId`, the `set-control-*` mutation arms).
- `packages/shared/al-contracts/al-control.ts` (268): `ALAckPayload` and `ALPendingAckSnapshot` gain
  `carrier` (required); `packages/shared/alm/al-admission-value-validation.ts` (156) decodes it.
- `packages/shared/alm/inbound/control/al-inbound-control-admission.ts` (156) and
  `compute-al-inbound-control-admission.ts` (155): `admit` takes the arrival source; the
  `admit-control` retained payload carries the carrier.
- `packages/shared/alm/inbound/admission/compute-al-inbound-admission.ts` (387) and
  `validate-al-inbound-admission-mutation.ts` (93): `pending` values carry the data message's carrier.
- `packages/shared/alm/inbound/al-inbound-runtime-diagnostics.ts` (199): `carrier` on
  `admission-outcome`.

**Harness and scenarios (shared-test):**

- `packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts` (1 068 net): the two
  `messages.send` fields.
- `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts`
  (698), `messaging/black-box-rallar-delivery-ledger.ts` (153), the input decoder
  `decode-black-box-rallar-messaging-input.ts`, the schema `schema/rallar-black-box-command-fields.ts`
  and the validator `control/validate-rallar-black-box-test-command.ts`.
- `packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts` (839 net): the
  two scenarios.
- `packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts` (381): inbound
  outcomes keep `msgId`, `reason` and `carrier`.

**Docs:** `packages/shared/alm/inbound/README.md`,
`packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`, the roadmap.

---

### Task 1: One inbound store per session, resolved once, and the schema move

**Files:**

- Modify: `packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts:12-64`
- Modify: `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts:57-157`
- Modify: `packages/shared/alm/al-runtime-stores.ts` (the `configure…` input that already carries
  `outboundBackend`; add `inboundBackend` beside it)
- Modify: `packages/shared-web/browser/connection/initialise-browser-middleware.ts:229,244-256,318-326`
- Modify: `packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts:27-41,80`
- Modify: `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts:77-99`
- Modify: `packages/shared/alm/open-indexed-db-admission-database.ts:16`
- Modify: `packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts:103,112-113` (the
  identity lists it consumes)
- Test: `packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts:18-19,358-418`,
  `packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts:24,215-216,333-334`,
  `packages/tests/shared-web/al-runtime/browser-al-storage-reset.test.ts:15,20-68`, and a new test in
  `packages/tests/shared-web/al-runtime/browser-session-inbound-store.test.ts`

**Interfaces:**

- Produces `toBrowserSessionALInboundRuntimeStoreId(sessionId: string): string` returning
  `browser-session-inbound:${sessionId}`; `toBrowserSessionALRuntimeEntryKeyPrefixes` and
  `toBrowserSessionALRuntimeWorkNamespaces` list the session inbound id, the ws-client id (outbound
  only) and the rtc-overlay id (outbound only).
- Produces `resolveBrowserSessionALInboundRuntimeStores(sessionId): ALInboundRuntimeStores` in
  `browser-al-runtime-stores.ts`, replacing `resolveBrowserWsClientALInboundRuntimeStores` and
  `resolveBrowserRtcRxALInboundRuntimeStores`.
- Produces on `CreateBrowserWebSocketQueueBox.Input` and `InitialiseRtcRxStreamerInput` a required
  `inboundStores: ALInboundRuntimeStores` (the caller resolves once).
- Produces `AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-09-s2b'`.
- Consumes nothing from later tasks. Task 2 relies on both services receiving the same
  `ALInboundRuntimeStores` object.

- [ ] **Step 1: RED — two resolves of the session inbound store share one state in memory mode.**
      In the new test file, configure the browser runtime stores with `indexedDb: undefined` (memory
      mode) for one session, resolve the session inbound store twice, admit one message through the
      first store's admission port and read its dedup row through the second. Expected today: the
      second read misses, because `resolveALInboundRuntimeStores` builds a fresh
      `InMemoryAdmissionBackend` per resolve (`ALRuntimeStoreRegistry.ts:57-68`). Run:
      `npx vitest run packages/tests/shared-web/al-runtime/browser-session-inbound-store.test.ts`.
      Expected: FAIL at the type level first (`resolveBrowserSessionALInboundRuntimeStores` does not
      exist), then, once the name exists, the dedup read returns `undefined`.
- [ ] **Step 2: The identity.** In `browser-al-runtime-identity.ts` replace
      `toBrowserRtcRxALRuntimeStoreId` (18-22) with:

```ts
/** One inbound admission store per browser session, whichever carrier delivered the message (S2b). */
export function toBrowserSessionALInboundRuntimeStoreId(sessionId: string): string {
    return `browser-session-inbound:${sessionId}`;
}
```

    `toBrowserWsClientALRuntimeStoreId` keeps its name and gets one doc line: WS outbound only.
    `toBrowserSessionALRuntimeEntryKeyPrefixes` (34-42) and `toBrowserSessionALRuntimeWorkNamespaces`
    (53-64) list the three ids `[session-inbound, ws-client, rtc-overlay]`; the work-namespace list
    gives the session inbound id only `:inbound:admission` and the two outbound ids only
    `:outbound:admission`.

- [ ] **Step 3: The composition.** In `browser-al-runtime-stores.ts` replace the three scopes (57-91)
      with: session inbound `{ inbound }`, ws-client `{ outbound }`, rtc-overlay `{ outbound }`. In
      `configureBrowserALRuntimeStores` (118-133) create, in memory mode, one shared inbound
      `InMemoryAdmissionBackend` exactly as the outbound one is created at 128-130 and pass it as
      `inboundBackend`. Add the `inboundBackend` input to `al-runtime-stores.ts` beside
      `outboundBackend` so the inbound factory (`:76-96`) reuses it when given, and threads it to the
      IndexedDB path unchanged (IndexedDB rows are shared by the database, so one backend per resolve
      stays correct there). Replace the two inbound resolvers (135-139, 147-151) with
      `resolveBrowserSessionALInboundRuntimeStores`.
- [ ] **Step 4: Resolve once, inject twice.** In `initialise-browser-middleware.ts`, after
      `configureBrowserALRuntimeStores` (229), resolve `const sessionInboundStores =
      resolveBrowserSessionALInboundRuntimeStores(sessionId)` once and pass it to
      `createBrowserWebSocketQueueBox` (244-256) and to `initialiseRtcRxStreamer` (318-326). In both
      inputs `inboundStores` becomes a required field and the internal resolve calls (`:80`, `:93`) are
      deleted. Construction stays visible: the store exists before either consumer.
- [ ] **Step 5: The schema move and the reset test.** Set `AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-09-s2b'`
      (`open-indexed-db-admission-database.ts:16`). In `browser-al-storage-reset.test.ts` set
      `PREVIOUS_SCHEMA_ID = 'rallar-alm-2026-09-f2c'` (15); the test at 20-68 must still show exactly
      one `ALStorageResetEvent` with reason `schema-id-mismatch` on the first open and none on reopen.
      Add a case that opens a database written with the f2c id containing one inbound `dedup` row under
      the old `browser:browser-rtc-rx:<sid>:inbound:admission` key and asserts the row is gone after
      the reset (no migration, no read of the old key).
- [ ] **Step 6: Rewrite the coupled pins.** `browser-al-runtime-stores.test.ts` imports and rtc-rx
      prefix/count pins (18-19, 358-418: `scanned 11 / deleted 11`, the rtc-rx key at 372-376, 392-394,
      418) move to the session inbound id; re-measure the scanned/deleted counts and record them in the
      commit message. `browser-outbound-cleanup.test.ts` (24, 215-216, 333-334) uses the new resolver
      name. Delete every reference to `toBrowserRtcRxALRuntimeStoreId` (`git grep` must return none
      outside `playground/`).
- [ ] **Step 7: GREEN.** Run
      `npx vitest run packages/tests/shared-web/al-runtime packages/tests/shared/alm/al-runtime-stores.test.ts`
      (add the exact file names Vitest lists). Expected: PASS, including Step 1's test and the reset
      case. Run `npx tsc -p packages/shared-web/tsconfig.json --noEmit` and
      `npx tsc -p packages/shared/tsconfig.json --noEmit`.
- [ ] **Step 8: Commit.**

```bash
git add packages/shared-web/browser/al-runtime packages/shared-web/browser/connection/initialise-browser-middleware.ts packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts packages/shared/alm/al-runtime-stores.ts packages/shared/alm/open-indexed-db-admission-database.ts packages/tests/shared-web/al-runtime
git commit -m "feat(alm): one inbound admission store per browser session, resolved once; schema id rallar-alm-2026-09-s2b"
```

    Record in the commit body the reset case, the re-measured cleanup counts, and that the WS
    runtime would now claim RTC rows — which Task 2 closes before any push carries both.

**Note for the executor:** Tasks 1 and 2 land in one push. Between them the merged store is
correct for keys but not yet for claims (both runtimes claim the merged work type), so the local ALM
lane is not run until Task 2 is green.

---

### Task 2: Carrier-partitioned work types — each runtime claims only its carrier's rows

**Files:**

- Modify: `packages/shared/alm/inbound/al-inbound-work-entry.ts:52-62,92-106,225-260`
- Modify: `packages/shared/alm/inbound/al-inbound-message-runtime.ts:82-103,143-149`
- Modify: `packages/shared/alm/inbound/al-inbound-effect-intent.ts:64,86,102,120,127,175-179` (the
  intents name the carrier of the effect they persist)
- Modify: `packages/shared/alm/inbound/admission/compute-al-inbound-admission.ts` (the effect writes
  carry the data source's carrier), `packages/shared/alm/inbound/control/compute-al-inbound-control-admission.ts:123-151`
  (the relay's completed-ACK `send-control` carries the owner's carrier)
- Modify: `packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts` (the runtime's
  required `carrier` input), `packages/shared/services/ws-queue-box-client-service.ts:229-245`
  (`carrier: 'ws'`), `packages/shared/services/web-rtc-rx-streamer-service.ts:115-136` (`carrier: 'rtc'`)
- Modify: `packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts` only if the
  server's inbound runtime construction names a carrier (it is `'ws'`); run the Deno checks.
- Test: `packages/tests/shared/alm/inbound/al-inbound-work-entry.test.ts` (or the file that pins
  `decodeALInboundWorkEntry` today — locate with `grep -rln decodeALInboundWorkEntry packages/tests`),
  `packages/tests/shared/alm/inbound-runtime-test-fixture.ts:1-300`, a new
  `packages/tests/shared/alm/inbound/al-inbound-claim-partition.test.ts`

**Interfaces:**

- Produces `toALInboundWorkType(namespace: string, carrier: ALDeliveryCarrier): string` returning
  `AL_INBOUND:${carrier}:${fnv1a64(namespace)}`; the decoder at `al-inbound-work-entry.ts:92-106`
  rejects a row whose namespace or type differs from the claiming runtime's.
- Produces on `ALInboundMessageRuntime.Dependencies` a required `carrier: ALDeliveryCarrier`; the
  runtime's `workTypes` is `new Set([toALInboundWorkType(namespace, carrier)])`.
- Produces on every `ALInboundDurableEffectWrite` (the effect intents) a required
  `carrier: ALDeliveryCarrier`; `persistEffect` (`al-inbound-durable-effect-store.ts:115-128`) writes
  the work row with that carrier's type. Data effects (`dispatch-local`, `forward-message`,
  `release-buffered`, the NACK) take the admitted data source's carrier (`rtc-peer → 'rtc'`,
  `trusted-server → 'ws'`, `ws-client → 'ws'`); the relay's completed-ACK `send-control` takes the
  message owner's carrier (`owner.source`).
- The carrier mapping from `ALInboundMessageRuntime.Source` is one function,
  `toALDeliveryCarrier(source: ALInboundMessageRuntime.Source): ALDeliveryCarrier`, in
  `al-inbound-source-validation.ts`; Task 3 consumes it.

- [ ] **Step 1: RED — two runtimes over one store each claim only their own rows.** In the new
      partition test, build one in-memory inbound store (the Task 1 shape) and two runtimes over it
      from `inbound-runtime-test-fixture.ts`, one with `carrier: 'ws'` and one with `carrier: 'rtc'`,
      each with a spy `dispatchInboxEntry`. Admit one message through the RTC runtime with source
      `{ kind: 'rtc-peer', peerId: 'p1' }` and one through the WS runtime with `{ kind: 'trusted-server' }`
      (distinct msgIds). Run `queueEngine.executeOnce()` until idle. Assert the RTC spy saw exactly the
      RTC message and the WS spy exactly the WS message. Expected today: FAIL — with one work type
      both runtimes claim both rows (whichever reserves first dispatches both), and the `carrier`
      input does not exist. Run: `npx vitest run packages/tests/shared/alm/inbound/al-inbound-claim-partition.test.ts`.
- [ ] **Step 2: RED — the same message over both carriers is admitted once and dispatched once.**
      In the same file: admit msgId `m1` from sender `s1` through the RTC runtime, drain, then admit the
      identical envelope through the WS runtime and drain. Assert exactly one dispatch across both
      spies and that the second admission's acceptance is the duplicate outcome
      (`toAdmissionAcceptance`, `al-inbound-message-runtime.ts:202-204`). Expected today: this already
      holds for the keys once Task 1 shares the store, but fails on the `carrier` type error; keep it
      as the slice's dedup pin in both orders (add the WS-then-RTC case).
- [ ] **Step 3: The work type and the decoder.** In `al-inbound-work-entry.ts` change
      `toALInboundWorkType` (52-54) to take the carrier and produce `AL_INBOUND:${carrier}:${fnv}`; the
      decoder (92-106) compares against the type the claiming runtime passes; `validateALInboundWorkWrites`
      (225-260) checks each write's type is one of the two carriers' types for the namespace. The work
      key (56-62) is unchanged, so `browser-al-work-cleanup.ts` ranges keep working.
- [ ] **Step 4: The runtime and the intents.** `ALInboundMessageRuntime.Dependencies` gains
      `readonly carrier: ALDeliveryCarrier`; `workTypes` (143-149) uses it. Each effect intent in
      `al-inbound-effect-intent.ts` gains `readonly carrier: ALDeliveryCarrier` and
      `computeALInboundAdmissionChanges` fills it from `toALDeliveryCarrier(read.source)`; the relay's
      completed ACK (`compute-al-inbound-control-admission.ts:123-151`) fills it from the owner's
      source. `persistEffect` writes the row under `toALInboundWorkType(namespace, effect.carrier)`.
      Add `toALDeliveryCarrier` to `al-inbound-source-validation.ts` (it is a pure translation; the
      three source kinds map as the Interfaces block states; an unknown kind is a programmer invariant
      — `assertNever`).
- [ ] **Step 5: The services.** `WsQueueBoxClientService` constructs its runtime with `carrier: 'ws'`
      (`:229-245`); `WebRtcRxStreamerService` with `carrier: 'rtc'` (`:115-136`). Both are one literal
      each — no branch — so neither file's cognitive load moves. The server-side inbound runtime (the
      Deno WS server) names `'ws'`; run `cd apps/api-v1 && deno task check`.
- [ ] **Step 6: GREEN.** Run the partition test, the fixture's suite, and
      `npx vitest run packages/tests/shared/alm packages/tests/shared/services` (rerun timed-out files
      alone if the machine is loaded, and say so). Expected: PASS, including the reloaded-row case the
      executor adds: persist an RTC row with only the WS runtime alive, run the engine, assert the row
      stays reserved-free until an RTC runtime is constructed over the same store and claims it.
- [ ] **Step 7: Measure the pins (D30).** Run
      `npx vitest run packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-storage-snapshot.test.ts packages/tests/shared/alm/inbound/al-inbound-admission-transactions.test.ts`.
      Expected: all three pass unchanged — the default send stays 10 / 15, admit + deliver one message
      stays 8, the inbound leg's row count stays 72. If any moves, record before/after in the commit
      body with the reason; the default send and admission counts may not move.
- [ ] **Step 8: Local lane.** `npm run -s test:rallar:full-stack:memory:alm` (smoke, all carriers) —
      report each cell's `ALM observation … regime=… outcome=… page=…` line; then
      `RALLAR_BLACK_BOX_ALM_SCOPE=full RALLAR_BLACK_BOX_ALM_CARRIERS=rtc-with-ws-fallback npm run -s test:rallar:full-stack:memory:alm`.
- [ ] **Step 9: Commit and push (with Task 1).**

```bash
git add packages/shared/alm/inbound packages/shared/services/ws-queue-box-client-service.ts packages/shared/services/web-rtc-rx-streamer-service.ts packages/tests/shared/alm
git commit -m "feat(alm): each inbound runtime claims only its carrier's work rows over the shared session store"
```

---

### Task 3: Carrier on the control and ACK rows, the row family split out of the store

**Files:**

- Create: `packages/shared/alm/inbound/control/al-inbound-control-rows.ts`
- Modify: `packages/shared/alm/inbound/al-inbound-admission-store.ts:63-64,756-773,804-858,876-878,998-1015`
  (moved out), `packages/shared/al-contracts/al-control.ts:35-41,85-92`,
  `packages/shared/alm/al-admission-value-validation.ts:46-92`,
  `packages/shared/alm/inbound/control/al-inbound-control-admission.ts:40-44,70-86,118-128`,
  `packages/shared/alm/inbound/control/compute-al-inbound-control-admission.ts:75-103`,
  `packages/shared/alm/inbound/admission/compute-al-inbound-admission.ts:227-276,298-365`,
  `packages/shared/alm/inbound/admission/validate-al-inbound-admission-mutation.ts:41,63-67`,
  `packages/shared/alm/inbound/al-inbound-message-runtime.ts:327-329,363-380`,
  `packages/shared/alm/inbound/al-inbound-work-entry.ts:186-194` (`admit-control` replay),
  `packages/shared/alm/inbound/al-inbound-runtime-diagnostics.ts:21-30`,
  `packages/shared/alm/outbound/admission/al-outbound-admission-reads.ts:289` (the shared decoder's
  caller — the outbound writer of `ALAckPayload` names its carrier too), and every producer of
  `ALAckPayload` (`grep -rn "AL_CONTROL_ACK_TYPE_ID\|ALAckPayload" packages apps --include=*.ts` ignoring dist)
- Test: `packages/tests/shared/alm/inbound/al-inbound-admission-transactions.test.ts:290-299`
  (`control.admit(ack, source)`), `packages/tests/shared/alm/al-outbound-control-admission.test.ts`,
  `packages/tests/shared/alm/outbound-control-version-candidate.test.ts`, the ACK fixtures under
  `packages/tests/shared/alm/` and `packages/tests/shared-web/messages/`, a new
  `packages/tests/shared/alm/inbound/al-inbound-control-rows.test.ts`, the Deno tests
  (`npm run test:deno`)

**Interfaces:**

- Produces on `ALAckPayload` (`al-control.ts:35-41`) a required `carrier: ALDeliveryCarrier` — the
  carrier the ACK **arrived on** at the store that records it; on `ALPendingAckSnapshot` (`:85-92`) a
  required `carrier` — the carrier the **data message** arrived on. Both decoders in
  `al-admission-value-validation.ts` require it (a missing field is `ALAdmissionCorruptionError`, the
  S2b-2 window).
- Produces `ALInboundControlAdmission.admit(msg: ALMessage, source: ALInboundMessageRuntime.Source)`;
  the runtime's `admitControlMessage` (`al-inbound-message-runtime.ts:363-380`) passes the source it
  already receives at `:327-329`; the `admit-control` retained payload
  (`al-inbound-control-admission.ts:40-44,118-128`) gains `carrier`, and its replay decoder
  (`al-inbound-work-entry.ts:186-194`) requires it.
- Produces `admission-outcome.carrier: ALDeliveryCarrier` (`al-inbound-runtime-diagnostics.ts:21-30`),
  emitted at `al-inbound-message-runtime.ts:301-312` from the admitted source.
- Produces the new file's exports: `toALInboundPendingControlKey`, `toALInboundAcksControlKey`,
  `toALInboundControlOwnersKey`, `PendingControlValue`, `AcksControlValue`,
  `readStoredAcknowledgements`, `readStoredControlOwnerIndex`, `readControlDecisionSurface`,
  `resolveALInboundAcknowledgedSenderId`, `applyALInboundControlMutation` — the same names the store
  uses today, moved, plus the carrier. `al-inbound-admission-store.ts` imports them; no re-export.

- [ ] **Step 1: RED — an ACK's history entry names the carrier it arrived on.** In the new rows test,
      over memory and IndexedDB (`fake-indexeddb`): admit a data message from `s1` over `rtc-peer` (so
      the `pending` value is written with `carrier: 'rtc'`), then admit an ACK for it through
      `control.admit(ack, { kind: 'trusted-server' })`. Read the `acks` row and assert its one entry has
      `carrier: 'ws'`, and the `pending` row `carrier: 'rtc'`. Expected: FAIL — `admit` takes one
      argument and neither value has a carrier. Run:
      `npx vitest run packages/tests/shared/alm/inbound/al-inbound-control-rows.test.ts`.
- [ ] **Step 2: Move the family.** Create `al-inbound-control-rows.ts` with the key builders
      (store 876-878, 1009-1015), the two value types (63-64), the three readers (804-858), the
      sender resolver (998-1006) and the `set-control-*` mutation arms (756-773) as one
      `applyALInboundControlMutation(backendWrite, mutation)` the store's `applyMutation` delegates to.
      Move the tests that pin those readers with them. `al-inbound-admission-store.ts` shrinks; its
      cognitive load stays under 50 (it is 35 today).
- [ ] **Step 3: The contracts.** Add `readonly carrier: ALDeliveryCarrier` to `ALAckPayload` and
      `ALPendingAckSnapshot`; require it in `decodeALAdmissionControlValue` (46-92) — the outbound
      store shares this decoder, so its `pending` writer (`compute-al-outbound-dispatch.ts`,
      `computeAckTrackingWrites`) names the carrier of the dispatch (`'ws'` for the WS outbound,
      `'rtc'` for the overlay) and its ACK producer (the receiver's `toALInboundControlCommitBundle`,
      `compute-al-inbound-control-admission.ts:83-90`) names the arrival carrier. Every ACK fixture in
      the tests names a carrier. Validation: `validate-al-inbound-admission-mutation.ts:41,63-67`
      rejects a control mutation without one (a typed issue, not a throw).
- [ ] **Step 4: Thread the source.** `ALInboundControlAdmission.admit(msg, source)`;
      `admitControlMessage` passes it; `toALInboundControlCommitBundle` (75-103) writes
      `carrier: toALDeliveryCarrier(source)` on the `acks` entry and keeps the `pending` value's
      carrier (the data message's) untouched when it updates the acked set. `toAckTransitionChanges`
      (`compute-al-inbound-admission.ts:337-365`) and `computeBufferedAcknowledgements` (298-335) write
      `pending` with `toALDeliveryCarrier(read.source)`. The `admit-control` retained payload and its
      replay carry the carrier.
- [ ] **Step 5: The diagnostic.** `admission-outcome` gains `carrier`; update
      `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` (the
      `admission-outcome` entry) and the observation decoder in Task 4 consumes it.
- [ ] **Step 6: GREEN.** Run the rows test, `npx vitest run packages/tests/shared/alm
      packages/tests/shared-web/messages`, `npx tsc -p packages/shared/tsconfig.json --noEmit`,
      `cd apps/api-v1 && deno task check`, `npm run test:deno` (the Postgres inbound store decodes the
      new field; its tests' ACK fixtures name `'ws'`). Expected: PASS.
- [ ] **Step 7: Measure the pins again** (the three files of Task 2 Step 7); the transactions pin at
      `al-inbound-admission-transactions.test.ts:290-299` changes only its call signature, not its
      transaction-mode sequence. Record.
- [ ] **Step 8: Commit and push.**

```bash
git add packages/shared/alm packages/shared/al-contracts/al-control.ts packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md packages/tests/shared/alm packages/tests/shared-web/messages
git commit -m "feat(alm): carrier on every pending and ACK control value; the control row family moves out of the inbound store"
```

    The commit body states the S2b-2 deploy window: server `pending`/`acks` rows written before this
    deploy are undecodable for at most 30 minutes (`controlHistoryTtlMs`, `controlPendingTtlMs`).

---

### Task 4: The cross-carrier duplicate scenario, in both orders

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts:291-309`
  (`messages.send` gains `replayOnCarrier`), the input decoder
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts`,
  the schema `packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts`, the
  validator `packages/shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts`,
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts:271-286`,
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-ledger.ts:143-153`
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts:24-31,162-205,868-888`
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts:49-55,233-247`
- Test: `packages/tests/shared-test/alm-conformance-recipes.test.ts:163-170`,
  `packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts:1066-1074`, the command
  validator's tests, `packages/tests/shared-test/alm-observation-snapshot.test.ts` (or wherever the
  decoder is pinned — locate with `grep -rln alm-observation-snapshot packages/tests`)

**Interfaces:**

- Produces on `messages.send` a field `replayOnCarrier?: { handleId: string; carrier: 'ws' | 'rtc' }`
  — the only optional field this slice adds, because absence has domain meaning (an ordinary send);
  when present, the runtime submits the **same envelope** the named handle captured to the named
  carrier's outbound (`rtcRxStreamer.enqueueOutboxIfAbsent` / `webSocketQueueBox.enqueueOutboxIfAbsent`,
  as `admitCapturedMessage` does at `browser-rallar-message-dispatch.ts:133-136`) and returns that
  admission's verdict in the command result. Documented as a harness capability in the command
  capability registry (`RALLAR_BLACK_BOX_ALM_COMMAND_CAPABILITIES`).
- Produces the scenario id `cross-carrier-duplicate` (tags `['full']`, carriers
  `rtc-with-ws-fallback` only — the only cell with both transports connected) with two recipe
  pairs, `rtc-then-ws` and `ws-then-rtc`.
- Produces on `ALMObservationInboundOutcome` (`alm-observation-snapshot.ts:49-55`) the fields
  `msgId`, `reason` and `carrier` (required), decoded at `:233-247`.

- [ ] **Step 1: RED — the generator has the scenario.** In `alm-conformance-recipes.test.ts` assert
      the full scope over `rtc-with-ws-fallback` contains recipes `alm-rtc-with-ws-fallback-cross-carrier-duplicate-rtc-then-ws-sender`
      and `…-receiver`, and the `ws-then-rtc` pair; assert the smoke scope does not. Expected: FAIL.
- [ ] **Step 2: RED — the harness field.** In the command validator's test, a `messages.send` with
      `replayOnCarrier: { handleId: 'h1', carrier: 'ws' }` validates, and one with `carrier: 'x'` is
      refused with a typed issue. Expected: FAIL (unknown field).
- [ ] **Step 3: The field.** Add it to the contract (293-309), the schema, the validator, the input
      decoder and `BlackBoxRallarMessageSendInput` (271-286). In the delivery ledger (143-153), when
      `replayOnCarrier` is present, look the handle up in `BrowserRallarDeliveryRegistry`, take its
      captured envelope, and submit it through the named carrier's `enqueueOutboxIfAbsent`; the result
      names the verdict. The sender's outbound sees no duplicate (its `sent` row is per outbound
      namespace); verify with a unit test that the second admission on the other carrier is
      `admitted`, not `duplicate`, on the sender.
- [ ] **Step 4: The scenario.** In `create-alm-conformance-recipes.ts` add `cross-carrier-duplicate`
      to the union (24-31) and the table (162-205) with `tags: FULL_TAGS`, carriers
      `['rtc-with-ws-fallback']`. Sender, order rtc-then-ws: connect; `messages.send` carrier `rtc`
      payload `{ marker: 'cross-carrier-duplicate', order: 'rtc-then-ws' }` (`ack: 'receiver'`, TTL
      30 000); `messages.observe` until `delivered`-class state is visible on the receiver (use the
      existing receipt-on-receiver pattern from S2a Task 4, never a cross-page `acknowledged` poll);
      then `messages.send` with `replayOnCarrier: { handleId: <the first send's handle>, carrier: 'ws' }`.
      Receiver: `messages.received count: 1 absent: false` for the payload, then
      `messages.received count: 2 absent: true` over the observe window (the typed receiver subscribes
      to both transports, `black-box-rallar-typed-channels.ts:100-118`, so a double delivery shows as
      2). Order ws-then-rtc: the mirror; **do not assert the RTC handle `acknowledged`** — the
      duplicate RTC copy earns no ACK (a pre-existing protocol property; S2c's territory).
- [ ] **Step 5: The decoder.** `ALMObservationInboundOutcome` keeps `msgId`, `reason`, `carrier`;
      the artifact analysis can then answer "one `committed/admitted` and one `not-handled/duplicate`
      for the same `msgId`, on different carriers". Update the registries the new scenario touches:
      `hetzner-distributed-manifests.test.ts:1066-1074` (scenario list; `rtcConnects` count if the
      catalog expands) and `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`.
- [ ] **Step 6: GREEN.** `npx vitest run packages/tests/shared-test packages/tests/rallar-black-box`;
      the local lane full scope over the fallback carrier:
      `RALLAR_BLACK_BOX_ALM_SCOPE=full RALLAR_BLACK_BOX_ALM_CARRIERS=rtc-with-ws-fallback npm run -s test:rallar:full-stack:memory:alm`.
      Expected: both orders green, each with one `admitted` and one `duplicate` outcome for the marker's
      msgId in the artifact.
- [ ] **Step 7: Commit and push.**

```bash
git add packages/shared-test packages/tests/shared-test packages/tests/rallar-black-box apps/rallar-black-box/src/hetzner
git commit -m "test(alm): the cross-carrier duplicate scenario in both orders; messages.send replayOnCarrier"
```

---

### Task 5: The `not-yet-in-sync` scenario

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts:293-309`
  (`messages.send` gains `minSnapshotVersion`), the same decoder/schema/validator files as Task 4,
  `black-box-rallar-operation-contracts.ts:271-286`, `black-box-rallar-delivery-ledger.ts:143-153`,
  `packages/shared-web/browser/messages/browser-rallar-message-sender.ts:299-302`
  (`resolveRoomMinSnapshotVersion` takes the explicit floor when given — a typed send option, not a
  harness hook in product code)
- Modify: `create-alm-conformance-recipes.ts` (scenario `not-yet-in-sync`, tags full, carriers `rtc`
  and `rtc-with-ws-fallback`)
- Test: `alm-conformance-recipes.test.ts`, the validator's tests, the sender's option test under
  `packages/tests/shared-web/messages/`

**Interfaces:**

- Produces on `messages.send` a field
  `minSnapshotVersion?: { absolute: number } | { aboveCurrentBy: number }` (optional: absence means the
  sender's own version, the product default). The runtime resolves `aboveCurrentBy` against the
  sender's current room snapshot version at send time and passes an absolute floor to the typed send
  option `minSnapshotVersion` on `RallarTypedSendOptions` (a real product option: a caller may state a
  floor; `resolveRoomMinSnapshotVersion` uses it when present, else the sender's version).
- Produces the scenario `not-yet-in-sync` with two variants: **delivered after the refresh** (floor
  `aboveCurrentBy: 1`, then the sender's recipe advances the group version with the presence PUT the
  prologue already uses, `create-alm-conformance-recipes.ts:816-841`; the receiver asserts the payload
  received once) and **expires undelivered** (floor `absolute: 999999`, `ttlMs: EXPIRY_TTL_MS`; the
  receiver asserts absence over the window and the sender observes `expired`).

- [ ] **Step 1: RED — the generator has both variants** (as Task 4 Step 1, recipe ids
      `alm-rtc-not-yet-in-sync-delivered-after-refresh-{sender,receiver}` and
      `alm-rtc-not-yet-in-sync-expires-{sender,receiver}`, and the fallback carrier's).
- [ ] **Step 2: RED — the typed send option.** In the sender's test: `sendTyped` with
      `minSnapshotVersion: 42` produces an envelope whose room floor is 42 (assert on the captured
      `minSnapshotVersion`), and without it the sender's version. Expected: FAIL (option unknown).
- [ ] **Step 3: The option and the field.** Add `minSnapshotVersion` to the typed send options and
      `resolveRoomMinSnapshotVersion` (`:299-302`); add the harness field with the two forms; the
      ledger resolves `aboveCurrentBy` from the sender page's current snapshot (the same read
      `resolveRoomMinSnapshotVersion` performs) and passes the absolute value.
- [ ] **Step 4: The scenario.** Sender, delivered-after-refresh: connect; `messages.send` carrier
      `rtc`, `minSnapshotVersion: { aboveCurrentBy: 1 }`, `ack: 'receiver'`, TTL 30 000, retry
      tracking enabled with the default 50 ms spacing (the product default); `http.request` presence
      PUT (the prologue's) to advance the group version; `messages.observe` the handle to
      `acknowledged` **on the receiver** per D28's pattern is not available — observe on the sender
      only the sender-local state (`transport-accepted`), and let the receiver prove delivery.
      Receiver: `messages.received count: 1 absent: false` within the 27 s window. Expires: floor
      `absolute: 999999`, `ttlMs: EXPIRY_TTL_MS`; receiver `count: 1 absent: true` over
      `EXPIRY_TTL_MS + MINIMUM_POST_EXPIRY_OBSERVATION_MS`; sender `messages.observe` state `expired`.
      Evidence in the artifact: an `admission-outcome` with reason prefix `not-yet-in-sync` and carrier
      `rtc` on the receiver, and the sender's `control-admission` diagnostic for the NACK
      (`al-outbound-repair-admission.ts:86-104`).
- [ ] **Step 5: GREEN.** The generator tests; the full-scope local lane over `rtc`; the artifact
      shows the `not-yet-in-sync` reason on an `alm.conformance.*` typeId for the first time.
- [ ] **Step 6: Commit and push.**

```bash
git add packages/shared-test packages/shared-web/browser/messages packages/tests
git commit -m "test(alm): the not-yet-in-sync scenario (delivered after refresh, expires undelivered); messages.send minSnapshotVersion"
```

---

### Task 6: Docs, the hosted read, the pins' record and the PR

**Files:**

- Modify: `packages/shared/alm/inbound/README.md` (session namespace, the claim partition, carrier on
  control rows, the S2b-2 window), `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`,
  `playground/alm/alm-improvement-plan.md` ("Release 3, S2b" section and the revision history),
  the PR body

- [ ] **Step 1: Docs.** The inbound README's store section states: one inbound store per session,
      keys session-logical, work rows typed per carrier, control values carrier-tagged (`pending` =
      the data message's carrier, `acks[i]` = the ACK's arrival carrier), the schema id
      `rallar-alm-2026-09-s2b` and the reset. The diagnostic contract documents `admission-outcome.carrier`.
- [ ] **Step 2: Push, set `RALLAR_BLACK_BOX_ALM_SCOPE=full`, read the artifact under the two-regime
      rule** (a red counts only against a same-regime green baseline; S2a's 237f0b3f3 read is the
      both-normal baseline: all three cells green, receiver reservation 1 334 / 1 062 / 1 886 ms).
      Record per cell: outcome, `regime` with `perOperation.medianMs`, `pageRegime` with
      `storageProbeMedianMs` and `sampleCount`, the receiver's `reservationWaitMedianMs`, and for the
      new scenarios the `admitted`/`duplicate` pair and the `not-yet-in-sync` reason. Clear the variable
      after the read. A red in a slow regime is a measurement: rerun once, then route to the maintainer
      with a session record.
- [ ] **Step 3: The pins' record (D30).** The PR body lists the three pins with "unchanged" or the
      measured before/after and why; one default send stays 10 / 15 and one admission 6 + 2.
- [ ] **Step 4: The PR body** in the F2b shape: Goal, Changes (per task), Acceptance (§5 "S2b" with the
      S2b-4 wording: dedup pair in both orders; the reset proven by the unit test; the
      `not-yet-in-sync` reason in the corpus; the pins), Validation (the local list on the final head,
      the hosted reads with run ids), Risk and rollback (the schema move resets browser databases; the
      server's ≤ 30-minute window; a revert restores two inbound stores and carrier-blind control
      rows), Follow-up (S2c). `npm run pr:delivery -- status` decides the next action; `ready` and
      auto-merge are not used.
- [ ] **Step 5: The full local list on the final tree**: `npm run test:unit`, `npm run typecheck`,
      `npm run check:repo-style:changed -- origin/main HEAD`, `node scripts/check-tests-typecheck.mjs`,
      `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`, the three
      `deno task check`, `npm run test:deno`, `npm run test:e2e`, `npm run test:full-stack:memory`,
      `npm run build`, `npm run test:repo-governance`, `check:browser-bundles`, and the medium-scale
      Postgres black-box gate (`npm run db:test:up && npm run test:api-v1:black-box:postgres:medium-scale`)
      because the WS server's inbound store decodes a changed shape.
- [ ] **Step 6: Branch Release Gate** green on the final commit; any later change invalidates it.

---

## Rulings during execution

(Empty at planning time. The executor records controller and maintainer rulings here as R-S2b-n, with
"Changed in the plan" lines, exactly as the S2a plan did.)

## Self-review

- **Spec coverage.** §2.2 A (one merged store, carrier a field on control/ACK rows, composition root
  changes, shared fence) → Tasks 1–3. Schema-id bump and reset (D3, D17) → Task 1 Step 5. §1.4 /
  "S2b owes it a scenario" → Task 5. §5 "S2b" dedup pair in both fallback orders keyed on `msgId` →
  Task 4 (with the decoder keeping `msgId`); "one `alm.storage.reset`" → S2b-4(a), unit evidence;
  `not-yet-in-sync` reason in the corpus → Task 5; the three moved pins re-measured, default send and
  admission counts unchanged → Task 2 Step 7, Task 3 Step 7, Task 6 Step 3. §6 "S2b" items 1–6 →
  Tasks 1, 1, 3, 1, 5, 4. D30 → Global Constraints and Task 6.
- **Placeholder scan.** No TBD/TODO; every code step names the file, the symbol and the assertion; the
  one "locate with grep" appears only where the survey did not record a test file's name.
- **Type consistency.** `ALDeliveryCarrier` is the only carrier type; `toALDeliveryCarrier` is defined
  in Task 2 and consumed in Task 3; `toALInboundWorkType(namespace, carrier)` is defined in Task 2
  and used by `persistEffect` in the same task; `resolveBrowserSessionALInboundRuntimeStores` and
  `toBrowserSessionALInboundRuntimeStoreId` are defined in Task 1 and consumed by Task 1's middleware
  change only; `admit(msg, source)` is Task 3's signature, used by Task 3's tests; the two harness
  fields are optional by domain meaning and stated so.
- **Open decisions** S2b-1..5 are recorded at the top and must be confirmed before Task 1; every task
  is written for the recommended answers.
