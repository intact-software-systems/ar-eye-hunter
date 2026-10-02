# ALM I2a design proposal: storage lifetime

Prepared 2026-10-01 against merged `main` `c86ee9519` (#628, P1b merged). Release 4's third slice,
I2a "storage lifetime", from the [QoS plan](alm-qos-product-plan.md) sections 4 ("One writer"), 5,
8 and 9.2, the [roadmap](alm-improvement-plan.md) decisions D3, D8, D13, D17, D84 to D90, D105,
D108 and D112 to D118, and the [product description](alm-complete-product-description.md)'s
completion criteria 5 and 10. The code survey behind sections 1 and 3 is read-only and cites `main`
at that commit. Paths below: `alm/` is `packages/shared/alm/`, `qb/` is `packages/shared/queuebox/`,
`sw/` is `packages/shared-web/browser/`, `bb/` is
`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/`, `cf/` is
`packages/shared-test/rallar-bb-test/conformance/alm/` and `t/` is `packages/tests/`.

## 1. The problem

The roadmap's I2a row promises a per-session durable-work claim across tabs, typed storage outcomes,
recovery outcomes and health on the public sink, scoped keys with one purge, and dedup retention
that covers the deadline. Grounding each against this checkout gives seven gaps. The second, the
seventh and the two-page half of the sixth set I2a-ii; the rest set I2a-i.

### 1.1 A missing IndexedDB falls back to memory silently, and a failing one ends untyped

- **The fallback.** `sw/al-runtime/browser-al-runtime-stores.ts:107-113`, `:122-124` and `:155-166`
  give the durable pairs memory stores whenever `typeof indexedDB === 'undefined'`
  (`packages/shared/persistence/indexed-db-string-persistence-provider.ts:47-49`), with no
  diagnostic, event or handle note.
- **A failing IndexedDB.** Quota, abort, unknown and closed-database errors are rethrown raw
  (`alm/write-indexed-db-admission-mutations.ts:91-109`,
  `packages/shared/persistence/indexed-db-request.ts:10-17`). The commit turns only a
  `NonRetryableException` into a verdict (`alm/outbound/al-outbound-dispatch-admission.ts:189-214`);
  the rest is caught by the browser dispatch as `{ kind: 'failed', detail }`
  (`sw/messages/browser-rallar-message-dispatch.ts:78-89`, `:180-185`) and read as `failed` with
  `admission-failed` (`alm/delivery/compute-al-delivery-lifecycle.ts:175-176`). A full disk looks like
  a bug. A failed work batch reaches only `console.error` (`alm/work/al-work-handler.ts:492-494`).
- **No setting, no persistence request.** The channel definition has no `onStorageUnavailable`
  (`sw/messages/rallar-message-contracts.ts:109-116`), and `navigator.storage.persist()` is called
  nowhere; the only `navigator.storage` use is `.estimate()`
  (`sw/data/repository-backed-rallar-data-store.ts:337`).

### 1.2 Ownership is per runtime instance: two tabs both drain, and a foreign row waits for the idle bound

- Worker ids are `al-outbound:<uuid>` and `al-inbound:<uuid>`
  (`alm/outbound/create-default-al-outbound-message-runtime.ts:117`,
  `alm/inbound/create-default-al-inbound-message-runtime.ts:51`); a reserved row records no owner
  (`qb/ResourceEntry.ts:49-54`). Two tabs of one session claim from the same `alm-work` store, each
  row fenced only by optimistic conflicts and a 10 s lease (`alm/outbound/al-outbound-work-entry.ts:23`,
  `alm/inbound/al-inbound-work-entry.ts:41`), as `t/shared/alm/outbound/al-outbound-control-handoff-two-tabs.test.ts`
  proves (`:42`, `:65`, `:103`).
- A row another tab committed is found only when the remembered readiness answer ages out
  (`alm/work/al-work-handler.ts:120`, `:181-186`), at most 6.6 s after P1b (D112).
- The only Web Lock is the per-sender commit lock `rallar:al-outbound-commit:${senderId}`
  (`alm/outbound/al-outbound-dispatch-admission.ts:576-611`), behind a port with no `ifAvailable`
  or `signal` (`alm/outbound/al-outbound-message-runtime.ts:326-329`). It guards the commit, never
  the drain.

### 1.3 There is no recovery vocabulary, and the reset sink does nothing in production

- The only typed storage events are `ALStorageResetEvent` and `ALStorageResetBlockedError`
  (`alm/open-indexed-db-admission-database.ts:22-42`). `restored`, `expired-at-recovery`,
  `storage-created` and any health word exist nowhere.
- `RallarDiagnosticsPorts.onStorageReset` defaults to `() => {}`
  (`sw/connection/rallar-diagnostics-ports.ts:55`) unless the app passes
  `RallarDefaults.diagnosticsPorts` (`sw/rallar-connection-facade.ts:97`); only the harness maps it,
  to `rallar.browser.alm.storage_reset` (`bb/black-box-rallar-diagnostics.ts:129-130`).
- `ALWorkHandler.ready()` runs one bootstrap batch that claims pending rows and recovers expired
  leases (`alm/work/al-work-handler.ts:187-195`), and reports nothing. The 60 s sweep only logs
  (`sw/al-runtime/browser-al-runtime-cleanup.ts:124-126`).

### 1.4 One global database, session-only keys, and login over a session leaves the rows

- The database is `'ar-eye-hunter-al-runtime'` for the whole origin
  (`sw/al-runtime/browser-al-runtime-identity.ts:8`); store ids and work namespaces embed only the
  session (`:16`, `:23`, `:29`, `:52-60`).
- The connect knows its `StateScope` (`sw/connection/initialise-browser-middleware.ts:91`, defaulted
  at `:631`) and writes it into the WS URL (`:113-115`), but the stores never see it. A session that
  reconnects under another scope drains the first scope's durable rows over the second scope's
  connection.
- Logout deletes the session's rows, best-effort (`sw/session/session-auth-lifecycle.ts:308-322`).
  Login over a session (`:125-143`) and a session switch in `connect` (`:224-240`) only disconnect.
- Work rows cannot be purged by prefix: `toAppQueueKey` hash-truncates long parts, so the cleanup
  needs each exact namespace (`sw/al-runtime/browser-al-work-cleanup.ts:32-34`).

### 1.5 Dedup holds a fixed 60 s while the deadline-plus-grace helper exists and the server shares the code

- `set-dedup` expires at `nowMs + windowMs` (`alm/inbound/admission/al-inbound-delivery-mutations.ts:37-41`),
  60 s by default (`packages/shared/al-contracts/normalize-al-qos-policy.ts:168-174`), clamped to
  5 min (`:108`, `:632`). A duplicate is decided by that row alone
  (`alm/inbound/al-inbound-planner-snapshot.ts:45`).
- `computeALReceiptRetentionExpiryMs` adds the 30 s grace
  (`alm/delivery/compute-al-receipt-retention-expiry-ms.ts:3-5`,
  `packages/shared/al-contracts/al-control.ts:97`) and already sets the volatile message-owner row in
  the same function (`al-inbound-delivery-mutations.ts:44-51`).
- A purpose's default deadline is 30 s (`packages/shared/al-contracts/resolve-al-channel-send-defaults.ts:25`,
  `:31`), so a default send is already covered. The gap bites when a deadline lies more than 30 s
  after admission: a replay after 60 s inside the deadline is delivered twice. I found no cap on a
  send's `ttlMs` or `expiresAtMs`.
- The WS server runs the same admission store over PostgreSQL
  (`packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts:70-89`).

### 1.6 The harness faults carriers, not storage, and no two agents share a browser context

- `fault.inject` takes `carrier: 'ws' | 'rtc'` (`packages/shared-test/rallar-bb-test/schema.ts:646-656`);
  the IndexedDB seam only counts (`packages/shared/persistence/indexed-db-operation-observer.ts:1-62`).
- Every agent gets its own `browser.newContext()`: the Playwright helpers
  (`tests/playwright/rallar-black-box/full-stack-helpers.ts:574-575`), the hosted headless worker
  (`apps/rallar-black-box/scripts/headless-worker.ts:100-101`) and the runner's session
  (`packages/shared-test/black-box-runner/browser/rallar-browser-session.ts:82-84`).
- The scenario union has neither `durable-takeover` nor `storage-unavailable`
  (`cf/alm-conformance-scenario-definition.ts:18-36`); the lane families are `two-agent`, `addressed`
  and `three-agent` (`:54`).

### 1.7 Relic's commands are volatile, carry no idempotency key, and the server re-applies a repeat

- `apps/relic-hunters-v1/src/game/send-relic-ws-command.ts:27-34` defines the command channel
  without `durability` and waits 30 s for the receipt (`:5`, `:35`).
- `RelicCommand` has no command id (`packages/relic-hunters/src/model.ts:226-232`). The server applies
  each admitted command (`apps/relic-hunter-server-v1/src/relic-game-service.ts:155-191`): a
  repeated `join-expedition` is harmless (`packages/relic-hunters/src/rules.ts:196-201`), a repeated
  `pickup-relic` throws "Relic has already been claimed." (`rules.ts:596`), and `submit-action`
  overwrites the pending action (`rules.ts:289`). Only msgId dedup stops a second application.

## 2. The slice as two PRs

### 2.1 Why one PR is too large

I2a touches about 30 production files across `packages/shared/persistence`, `alm/`, `qb/`, `sw/` and
the black-box runtime, plus the conformance catalog, two harness launchers and one game. It adds
about nine contracts: the storage-unavailable value, a verdict arm, a failure arm, the durability
downgrade, the channel setting, the storage event union, the storage fault, the ownership port and
the cross-tab message. The halves carry different risks: the first changes what the application is
told, the second changes which tab does the work. One review should not hold both.

### 2.2 Decided (D119): I2a-i storage truth, then I2a-ii one durable owner

- **I2a-i, storage truth** (3.a to 3.e, 3.h per lane, 3.i, 3.j without the takeover): the typed
  `storage-unavailable` outcome and `onStorageUnavailable` (D86); availability decided per connect
  and re-decided on a storage error; `navigator.storage.persist()` on the first durable admission;
  the storage port with reset, recovery, health and persist events; the per-scope database, with
  no migration or delete code; the purge on login over a session; dedup retention covering
  deadline plus grace; the storage fault port;
  `storage-unavailable`; `delivery-reload` reading the recovery outcome.
- **I2a-ii, one durable owner** (3.f, 3.g, 3.h per owner, the takeover of 3.j, 3.k): the per-session
  owner claim on Web Locks with takeover on release, over the session's outbound and inbound durable
  lanes, volatile lanes and the server untouched; the cross-tab wake and settlement relay; recovery
  counted by the owner's bootstrap; `durable-takeover` with two pages in one context; Relic to
  `local-outbox` (D115).

I2a-i goes first: the takeover is proven through its recovery event, and a resumed Relic command is
trusted only once dedup covers the deadline. Each PR passes the full gate alone.

### 2.3 Options (b) and (c)

- **(b) Three PRs**, scope, purge and dedup split from I2a-i: small and server-shared, so it could pass
  the medium-scale gate alone; cost, a third set of lane and manifest runs for about six files.
- **(c) One PR**: D6 allows it where a cutover couples contracts; the halves share only the recovery
  event.

## 3. The design, per concern

Each concern states what changes, the contract, where the decision sits, what the server shares and
the evidence; section 1 states what exists. Contracts use required fields; `| undefined` appears only
where absence has domain meaning, as on `ALDeliveryEvidence` today
(`alm/delivery/al-delivery-lifecycle.ts:275-296`).

### 3.a Storage availability and the typed outcome (I2a-i)

- **The value.** `ALStorageUnavailable { cause, detail: string }`, made by one pure
  `toALStorageUnavailable(error: unknown): ALStorageUnavailable | undefined` beside
  `alm/open-indexed-db-admission-database.ts`. Causes:
  - `missing`: no `indexedDB`, today's fallback trigger;
  - `open-failed`: the open request's error (`packages/shared/persistence/open-indexed-db.ts:182-203`);
  - `reset-blocked`: `ALStorageResetBlockedError` (`open-indexed-db-admission-database.ts:37-42`);
  - `quota`: `QuotaExceededError` from a transaction (`indexed-db-request.ts:10-17`);
  - `closed`: `InvalidStateError` on a connection a `versionchange` closed (`open-indexed-db.ts:55-58`);
  - `evicted`: the database vanished under an open document (3.h);
  - `transaction-failed`: `UnknownError` or an abort that is neither quota nor a write deadline.

  `PersistenceWriteExpiredError`, `ALAdmissionCorruptionError` and the backend conflict keep their
  meanings.
- **Where it becomes a value.** `ALAdmissionWorkBackend` is shared with the memory and PostgreSQL
  backends (`alm/al-admission-backend.ts:63`,
  `packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts:37`), so the backends
  keep their I/O shape. Each lane's admission boundary, which already turns `NonRetryableException`
  into a verdict (`al-outbound-dispatch-admission.ts:189-214`), classifies there, and a durable
  lane's `ready()` returns `Either<ALStorageUnavailable, void>`
  (`packages/shared/resilience/Either.ts`) instead of rejecting. No storage error leaves a lane as a
  raw throw. Making the backends themselves return `Either` would change the PostgreSQL backend for
  a failure it never has.
- **The verdict.** A new arm `{ kind: 'storage-unavailable'; cause; detail }` in
  `ALDeliveryAdmissionVerdict` (`alm/delivery/al-delivery-lifecycle.ts:76-91`), read as state
  `failed` with a new failure arm `{ kind: 'storage-unavailable'; cause }`
  (`alm/delivery/al-delivery-failure.ts`). The twelve states and their decoders are unchanged.
- **The setting.** `RallarTypedMessageChannelDefinition` gains `onStorageUnavailable?: 'refuse' |
  'volatile'`, sparse public input whose absence means `refuse`. The validator
  (`sw/messages/validate-rallar-typed-channel-policy.ts:12-41`) adds `invalid-on-storage-unavailable`;
  `BrowserTypedChannelPolicy` (`sw/messages/to-browser-message-send-defaults.ts:10-13`, built at
  `sw/messages/browser-typed-message-channels.ts:43`) carries it as a required field. It is not an
  envelope field, so the persisted-QoS validator and the server do not change.
- **The decision sits in the browser dispatch**, the highest point holding both the channel policy
  and the carrier admission. `refuse` settles the handle typed. `volatile` admits the same message
  once on the volatile lane, since the durable lane committed nothing, and the evidence gains
  `durabilityDowngrade: { requested, cause } | undefined`, modelled on `receiptDowngrade`
  (`al-delivery-lifecycle.ts:261-264`, `:289`); `admittedDurable` reads `false`.
- **Availability.** `configureBrowserALRuntimeStores` (`browser-al-runtime-stores.ts:150-169`) decides
  `ALStorageAvailability = { kind: 'available' } | { kind: 'unavailable'; reason }` once per connect
  and no longer wires memory backends into durable pairs. While `unavailable`, the dispatch skips
  the durable lane. A classified error re-decides it: `missing` holds for the document; any other
  cause is retried by the next admission, since quota can free and a closed connection reopens.
- **Work batches.** `reportBatchFailure` classifies, and a storage failure emits `health` (3.b)
  instead of `console.error`. The failed transaction wrote nothing, so the rows wait for the next
  batch, or after I2a-ii the next owner.
- **Persistence.** The session's first durable admission calls `navigator.storage.persist()` once,
  not awaited on the send path, and reports `persist`. No IndexedDB operation, so no pin moves.
- **Server.** Nothing; PostgreSQL never produces the value.
- **Evidence.** A unit test per cause through the real IndexedDB owners and the fault port (3.i); one
  per `onStorageUnavailable` value at the dispatch; the lane's `storage-unavailable` (3.j).

### 3.b The public storage port (I2a-i)

- `RallarDiagnosticsPortsInput` is public (exported from `sw/rallar.ts` and `sw/rallar-core.ts`,
  pinned by `t/shared-web/shared-web-public-api-snapshots.test.ts`).
- **Decided (D121): widen `onStorageReset` into `storage: (event: ALStorageEvent) => void`.** Each arm
  names its `storeId`:
  - `reset`, carrying today's `ALStorageResetEvent` unchanged;
  - `recovery`, with `outcome` one of `restored { claimed, expired }`,
    `expired-at-recovery { expired }`, `storage-created` and `storage-reset { reason }`;
  - `health`: `status: 'healthy' | 'failing'`, `lastFailure: ALStorageUnavailable | undefined`,
    `lastRecoveryPointAtMs: number | undefined`; emitted on transitions only, never per send. For the
    durable tiers every commit is a recovery point. I2b adds `delayed`, the oldest unsaved age and
    its checkpoint events to the same union;
  - `persist`: `outcome: 'granted' | 'denied' | 'unsupported'`.
- **State.** One `ObservableLatestValue` per store from `packages/shared/cache` holds the health; its
  change listener emits.
- **Cost.** One public field, the API snapshot, five `sw/` sites (`initialise-browser-middleware.ts:279`,
  `browser-al-runtime-stores.ts:159`, `browser-al-runtime-cleanup.ts`, `session-auth-lifecycle.ts:315`,
  the ports file) and about ten test files. The `alm/` factory input `onStorageReset` stays; the
  browser composition adapts it into `reset`.
- **Harness.** `rallar.browser.alm.storage_reset` keeps the reset arm, so the reload identity
  assessment (`t/shared-test/alm-identity-assessment.test.ts:331-349`) is untouched; a new topic
  `rallar.browser.alm.storage` carries the other three.
- **Evidence.** A unit test per kind on the sink; the lane observation reads it (QoS 9.2).

### 3.c Scope (I2a-i)

- **Decided (D120): one database per scope**, `rallar-al-runtime:${applicationId}:${workspaceId}`,
  from the scope the connect resolves (`initialise-browser-middleware.ts:91`, `:631`) and passed to
  `configureBrowserALRuntimeStores` (`:274-283`). Keys inside stay session-scoped.
- **Against one database with scoped keys.**
  - _Purge._ Either way the purge needs the session's scopes (1.4). Per-scope names list them through
    `indexedDB.databases()`; one database would need a scope index row or a store scan.
  - _Connections._ One per scope a tab uses, which is one for every current app, plus a short-lived
    one per extra database during a purge, against one in all.
  - _Code._ `dbName` is already an input of the store factories (`browser-al-runtime-stores.ts:41`,
    `:110`, `:123`) and the cleanup's delete (`browser-al-runtime-cleanup.ts:66`, constant at `:186`,
    `:406`); scoped keys would change every builder in `browser-al-runtime-identity.ts` and lengthen
    hashed keys.
- **Cutover.** No row shape changes, so `AL_ADMISSION_SCHEMA_ID` stays; only the name changes. The
  legacy database `ar-eye-hunter-al-runtime` is left to the browser's eviction, with no delete code
  (decision 9).
- Without `databases()` the purge covers the current and the default scope, and the rest age out
  under the 60 s sweep; rows of a session id no later connect uses are never claimed.
- **Evidence.** `t/shared-web/al-runtime/browser-al-runtime-stores.test.ts`: two scopes of one session
  see disjoint rows.

### 3.d Purge (I2a-i)

- `activateLoginSession` (`session-auth-lifecycle.ts:125-143`) and the session switch (`:224-240`)
  call `deleteBrowserALRuntimeEntriesForSession` (`sw/al-runtime/browser-al-runtime-cleanup.ts:107-118`)
  for the previous session after the disconnect, as logout does (`:308-322`), when the session key
  differs. Memory and the volatile pairs die with the middleware (`browser-al-runtime-stores.ts:139-141`).
- A purge failure is no longer swallowed (`session-auth-lifecycle.ts:318-320`): it emits `health`,
  and the session ends anyway. I2b's checkpoint joins the same call.
- **Evidence.** `t/shared-web/session/browser-auth-session-cleanup.test.ts`: login over a session and
  a session switch leave no rows of the previous session; `:80` stays.

### 3.e Dedup retention (I2a-i, server-shared)

- **The change.** The `set-dedup` expiry becomes `max(nowMs + windowMs,
  computeALReceiptRetentionExpiryMs(deadline))`, the second term capped at
  `nowMs + retention.msgOwnerTtlMs` (decision 7). `windowMs` keeps its default, its cap and its
  meaning as the floor. `deadline` is the message's own `resolveALMessageExpireAtMs`
  (`packages/shared/al-contracts/al-policy.ts:418`), not the 30 min fallback of
  `al-inbound-delivery-mutations.ts:16-17`; a message without one keeps the window.
- **Identity dedup only.** `msg-id` and `msg-id+sender` take the floor. `semantic-key` dedups on the
  caller's key (`al-policy.ts:748-749`); stretching it to the deadline would drop new messages that
  share the key.
- **The message-owner row.** Durable rows live 60 min (`al-inbound-delivery-mutations.ts:44-51`,
  `alm/ALStoreRetention.ts:2`, `:42`), so any deadline under 60 min is covered. Above it the owner
  row lapses first; the dedup row still catches the duplicate and only the cross-carrier
  classification is lost (`isCrossCarrierCopy` in `compute-al-inbound-duplicate-changes.ts`). The
  cap keeps both rows on one bound and keeps a client-chosen deadline from setting server row
  lifetime.
- **Evidence.** Unit: a replay after 60 s inside a 120 s deadline is re-acknowledged without a second
  delivery, on memory and IndexedDB; `semantic-key` keeps its window. Tests that may move:
  `t/shared/al-indexeddb-runtime-stores.test.ts:110`, `t/shared/al-durable-runtime.test.ts:56`,
  `t/shared/al-inbound-message-runtime.test.ts:225`, `t/shared/al-policy.test.ts:383`. Server: the
  api-v1 cluster profile and `test:api-v1:black-box:postgres:medium-scale`.

### 3.f The durable owner (I2a-ii)

- **The claim.** One Web Lock, `rallar:al-durable-owner:${applicationId}:${workspaceId}:${sessionId}`,
  requested once per connect by the browser composition with the middleware's `signal`. Its callback
  is the takeover: it starts the session's durable work tasks and holds the lock until disconnect.
  `ifAvailable` is not needed, since a non-owner never needs to know earlier than its callback.
- **The port.** `BrowserLocks` moves out of `ALOutboundMessageRuntime` into one shared module, widened
  by `signal` only. The commit lock is unchanged; the owner claim is a second name on the same port.
- **A non-owner** commits admissions under the commit lock as today, but its durable lanes'
  `ALWorkHandler` tasks stay out of the engine. The engine also serves the volatile lanes
  (`sw/websocket/create-browser-web-socket-queue-box.ts:87`, `sw/rtc/initialise-browser-rtc-runtime.ts:74`),
  so the gate is per durable task. The lanes take an `ALDurableWorkOwnership` input (`owned`,
  `isOwned()`, `announceCommit(rows)`, `onForeignCommit(listener)`); the server and the Node tests pass
  the always-owned value, today's behaviour.
- **Takeover** includes the tasks and runs today's bootstrap batch. A row the old owner held is
  recovered at its lease end plus at most 19.1 s (D113).
- **A non-owner's handles.** Today a tab usually dispatches its own rows, since its `committed()`
  starts a batch (`alm/work/al-work-handler.ts:216-225`). With one owner they dispatch in the owner
  tab, whose settlements never reach the sending tab. Decision 11 takes the relay (D123).
- **Inbound.** A durable inbound row a non-owner admitted reaches the owner tab's handlers, as it does
  today whenever the other tab claims first.
- **Without the Locks API** every tab owns, as today. The server changes nothing.
- **Pins.** The lock is taken per connect, never per send, and a single-runtime fixture has no Locks
  API: the ledger (6 chain, 8 in all, 37 requests, 10 plus 5), the cold 10 plus 9 and inbound
  11 to 13 and 5 to 7 cannot rise.
- **Evidence.** Unit on the existing lock fake (`al-outbound-control-handoff-two-tabs.test.ts:215-235`):
  two runtimes of one session, one drains, the other takes over on dispose, each row sent once.

### 3.g Cross-tab wake (I2a-ii)

- **Decided (D123): one `BroadcastChannel` per session and scope**, `rallar-alm:${applicationId}:
  ${workspaceId}:${sessionId}`, after the `rallar-data:` and `rallar-crdt:` channels and their guard
  (`sw/data/install-browser-rallar-data-broadcast-sync.ts:8-12`, `sw/crdt/browser-crdt-tab-sync.ts:24-31`).
- A non-owner posts the `ALWorkCommittedRows` its commit computed. The owner hands them to its own
  lane's `work.committed(rows)`, the path for "any write of its own rows it made outside `runBatch`"
  (`al-work-handler.ts:209-225`), so D112's restore holds.
- Not `wakeAfterExternalWrite`: it makes every owner on the engine drop its answer
  (`packages/shared/services/InboxOutboxEngine.ts:118-136`), a probe for each other lane.
- **Cost** against the 6.6 s idle bound (D112): one browser API already in the bundle and one message
  per foreign commit, no IndexedDB operation. The same channel carries decision 11's relay.
- **Evidence.** Unit with a channel fake: a non-owner's commit is dispatched within one engine pass.

### 3.h Recovery outcomes (I2a-i, owner-counted in I2a-ii)

- Exactly one outcome per durable store per connect, so restart is observable (criterion 10).
- `storage-created`: the open ran `upgradeneeded`, which happens only on creation
  (`open-indexed-db.ts:182-203`). It is never presented as a restore.
- `storage-reset`: today's reset (`open-indexed-db-admission-database.ts:81-94`) wins over
  `storage-created`.
- A creation on a reopen within one document means the database vanished under the tab. After a
  `versionchange` it was another tab's reset and reads `storage-reset`; otherwise it reads
  `storage-unavailable` with cause `evicted`.
- `restored { claimed, expired }` from the bootstrap batch: its claims plus the expired rows its
  reservation already deletes (`qb/indexed-db-queue-box.ts:415-421`), returned as a count;
  `expired-at-recovery` when nothing was claimed and something expired. No new IndexedDB operation.
- In I2a-i each durable lane reports its own bootstrap; in I2a-ii only the owner bootstraps, so the
  counts are the session's and a takeover reports `restored`.
- **Evidence.** A unit test per outcome; `delivery-reload` reads it.

### 3.i The storage fault port (I2a-i, harness only)

- The observer becomes an interceptor: `observe(operation)` may return a pending decision that delays
  or rejects with a `DOMException` by name. Call sites await only a returned decision, so the
  production pass-through adds no microtask. The roughly twenty sites in
  `alm/indexed-db-admission-backend.ts`, `alm/indexed-db-admission-read-session.ts` and
  `qb/indexed-db-queue-box.ts` sit before a transaction opens or between a finished read and its
  write, so a fault never half-writes.
- `ScriptedStorageFaultPort` follows `ScriptedTransportFaultPort`
  (`packages/shared/transport-faults/transport-fault-port.ts:31-49`): `inject({ faultId, match: {
  owner, kind }, action: 'fail' | 'quota' | { delayMs }, remaining })`, `clear()`,
  `getObservations()`; `quota` fails writes only.
- `fault.inject` gains `carrier: 'storage'` (`schema.ts:646-656`), wired beside the counting observer
  (`bb/browser-rallar-runtime-composition.ts:137-140`, `:182-183`). Production's observer stays a
  no-op; never product behaviour.

### 3.j Lane scenarios and the harness capability

- **`storage-unavailable`** (I2a-i, `two-agent`, every carrier, `full`): a `quota` fault on
  `al-admission` writes; a `refuse` channel's send reads `failed` with `storage-unavailable`; a
  `volatile` channel's send is delivered with `durabilityDowngrade`; health reads `failing`, then
  `healthy` after `fault.clear`.
- **`delivery-reload`** (I2a-i) keeps its assertions (`cf/scenarios/delivery-reload.ts:69-107`) and
  reads one `recovery` per durable store after the reload.
- **`durable-takeover`** (I2a-ii, every carrier, `full`): the sender opens a second page in its own context with the
  same session; page one, the owner, holds a send under a hold fault and closes; page two takes over
  and the receiver gets the message once. The send's deadline must exceed the lease plus D113's
  19.1 s. A new family `same-context` and a `pages: 2` agent option in the Playwright helpers and the
  headless worker.
- **Hosted.** The Hetzner entries pick families explicitly
  (`apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts:64`, `:106`), so manifests 18 and
  22 skip the new family (decision 6).

### 3.k Relic (I2a-ii)

- `durability: 'local-outbox'` on the channel in `send-relic-ws-command.ts:27-34`, nothing else;
  `apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts` pins it.
- A command resumed after a reload keeps its msgId and deadline. For the 30 s command deadline the
  60 s floor already covers deadline plus grace, so the server re-acknowledges the repeat without
  applying it; after the deadline it is dropped `expired`.
- No idempotency key in I2a; I2b's Relic Playwright proof decides whether AppInbox request-id
  idempotency must join (decision 8).

## 4. Maintainer decisions (2026-10-01)

The maintainer took the twelve decisions on 2026-10-01. The [roadmap](alm-improvement-plan.md)
records them as D119 to D128.

1. **The PR split (D119).** Two serial PRs, I2a-i then I2a-ii, each passing the full gate alone.
   Declined: three PRs, a third gate and manifest run for six files; one PR, one review holding two
   risks. Amends D88's I2a line, as D108 did for P1.
2. **Where the scope goes (D120).** One database per scope,
   `rallar-al-runtime:${applicationId}:${workspaceId}`, keys unchanged inside. Declined: one
   database with scoped keys, every identity builder changed and a scope index row for the purge.
   The maintainer's adjustment: the name prefix is `rallar`, not `ar-eye-hunter`. Amends the
   roadmap's "Storage, cutover" section and QoS 8.
3. **The storage port (D121).** `onStorageReset` widens into one `storage` port of four kinds:
   `reset`, `recovery`, `health` and `persist`. Declined: a `storage` port beside it, two ports for
   one concern. Amends D86's sink wording.
4. **The typed outcome (D122).** A new verdict kind, read as state `failed` with a new failure arm
   carrying the cause. Declined: a `refused` reason, which reads as the sender's fault and carries
   no cause; a new state, which touches every state decoder and the capability prose. Applies D86.
5. **Foreign rows (D123).** The cross-tab wake hands a non-owner's commit to the owner's
   `work.committed(rows)`. Declined: the idle bound, a second tab's send waiting up to 6.6 s. Amends
   D112 for the browser.
6. **`durable-takeover` placement (D124).** The Playwright lane only, `full`, a family the hosted
   entries skip. Declined: hosted as well, multi-page agents in the headless worker and new manifest
   entries.
7. **Dedup retention (D125).** `max(window, deadline + grace)` for identity dedup, the deadline term
   capped at `msgOwnerTtlMs`, `semantic-key` unchanged; deadlines beyond 60 min stay uncovered,
   stated. Declined: no cap, a client's deadline setting server row lifetime; replacing the window,
   `windowMs` losing its meaning and `semantic-key` changing. Amends D85 ("replacing").
8. **Relic idempotency (D126).** Later: msgId dedup now, I2b's proof decides. Declined: a command
   id now, a model and server change no failure needs. Amends D115's Relic line.
9. **The legacy database (D120).** Left: `ar-eye-hunter-al-runtime` is not deleted, and no delete
   code is written; its stale rows sit at rest until the browser evicts them. Declined: a one-time
   delete at the first scoped open, reported as `reset`. The maintainer's adjustment: option (b)
   over the recommended (a). Applies D3.
10. **When to ask for persistence (D127).** On the session's first durable admission, not awaited,
    reported as `persist`. Declined: at connect, where apps that never send durably ask too and
    Firefox asks the user. Restates QoS 8.
11. **A non-owner's handles (D123).** The owner relays settlements of messages it holds no handle
    for on the session channel. Declined: settling `unobservable` after admission, second tabs
    losing evidence they have today; each tab dispatching its own fresh rows, two drainers again.
    Beside D13.
12. **AR Eye Hunter's I2a proof (D128).** Dropped: its channels are volatile since S3c-ii, so there
    is no durable store to claim; `durable-takeover` and Relic's move prove I2a. Declined: a durable
    AR Eye channel, a game change for a proof the lane gives. Amends the roadmap's consumer-proof
    row and QoS 10.4.

## 5. Acceptance evidence

**Both PRs.** The PR body's D8 reuse inspection against `packages/shared/cache` (the health value,
3.b) and `packages/shared/resilience` (`Either`, 3.a). Pins unchanged: the ledger (6 chain, 8 in
all, 37 requests, 10 `al-admission` plus 5 `al-work`), the cold 10 plus 9, inbound 11 to 13 transactions and 5 to 7 `al-work`. The ALM lane on
every carrier with the observation smoke and full reads green by regime; the api-v1 cluster profile
and `npm run test:api-v1:black-box:postgres:medium-scale`; hosted manifests 18 and 22 from the PR
branch; bundle figures against `packages/shared-web/bundle-budgets.json` (`rallar.ts` 231 KiB) and
`t/rallar-black-box-headless/headless-bundle-budget.json` (294 KiB), a crossed budget raised to the
next whole KiB and reported; the storage snapshot per message state.

**I2a-i.** Unit, by behaviour (QoS 9.2): a typed outcome per cause; `refuse` and `volatile` at the
dispatch with the downgrade; a recovery outcome per kind; the sink per event kind; a replay after
60 s inside the deadline is not delivered twice; `semantic-key` keeps its window; login over a
session and a session switch leave no rows; two scopes see disjoint rows. Lane: `storage-unavailable`, `delivery-reload` reading the outcome. The public API snapshot and
the bundle-boundary checks for the port.

**I2a-ii.** Unit: one of two runtimes drains and the other takes over on dispose, each row sent once;
without the Locks API every runtime drains; a foreign commit reaches the owner within one pass; a
relayed settlement reaches the sending tab's handle; takeover reports `restored`. Lane:
`durable-takeover` in the Playwright lane; every I2a-i scenario still green. Relic: the send test pins
`local-outbox`.

## 6. Rough task decomposition (for sizing only)

**I2a-i** (9 tasks)

1. `ALStorageUnavailable` and its classifier, a test per cause.
2. The verdict and failure arms, the lanes' boundary, the work-batch health path.
3. `onStorageUnavailable`: definition, validator, policy, the dispatch decision, the downgrade.
4. Availability per connect, the end of the silent fallback, the persistence request.
5. The `storage` port and union, the rename across `sw/`, the harness topic.
6. The per-scope database, the purge on login and session switch.
7. Dedup retention with its cap, the moved tests, the server gates.
8. The storage fault port and `carrier: 'storage'`.
9. `storage-unavailable`, `delivery-reload`'s read, pins, bundle, manifests, PR body.

**I2a-ii** (7 tasks)

1. The shared `BrowserLocks` module with `signal`; the commit lock moved onto it unchanged.
2. `ALDurableWorkOwnership` and the gated durable tasks in both lanes.
3. The session claim in the browser composition, takeover, the owner's recovery outcome.
4. The session `BroadcastChannel`: the commit wake and the settlement relay.
5. The two-page agent option in the Playwright helpers and the headless worker.
6. `durable-takeover` and its family.
7. Relic to `local-outbox`; pins, gates, manifests, bundle, PR body.

## 7. Corrections to the roadmap and the QoS plan

1. QoS 8 and the reuse inventory say the owner claim "extends the existing per-sender commit lock".
   It is a second lock name on the same port, which moves to a shared module; the commit lock is
   unchanged (3.f).
2. QoS 8's "blocked upgrade" cannot happen: the open names no version, so the only blocking is the
   reset's delete (`open-indexed-db.ts:182-203`); the cause is `reset-blocked`.
3. QoS 8 calls the scope rename "a D3 reset", and the roadmap says the keys and the name take the
   scope. Under 2(a) only the name does and no schema id is bumped; the legacy database is left to
   the browser's eviction (3.c, decision 9).
4. D85 says deadline dedup "replaces" the 60 s default; under 7(a) the window is the floor and
   `semantic-key` keeps it, as QoS 5 and 6 already say "floors".
5. QoS 8's `storage-created` holds for a first open; a creation on a reopen within a document is
   `evicted` or another tab's reset (3.h).
6. "Non-owners do not start their engines" does not fit the browser: one engine serves volatile and
   durable lanes, so the gate is per durable task (3.f).
7. One owner moves a second tab's dispatch into the owner tab; neither document says what the second
   tab's handle then sees (decision 11).
8. The roadmap's AR Eye Hunter I2a proof names a multi-tab claim with no durable channel to claim
   (decision 12).

## 8. Carries: what I2a does not do

- **I2b**: the checkpoint, `delayed` health, the oldest unsaved age, the recovery-lag bound and its
  scenarios. The owner also owns the checkpoint (QoS 4), and the event union gains arms.
- **A lock-proven early reclaim.** A released lock proves the old owner stopped only if its dispose
  awaits its in-flight batch; until then the lease rule and D113's bound stand.
- **A frozen owner** keeps its lock; I2b's page-lifecycle work handles freeze, after measurement.
- **The paging limit** (16 RESERVED rows per type in the readiness scan) and **inbound cadence**, as
  P1b left them.
- **The Temporal polyfill's bundle removal** and a native alias (QoS 7.6).
- **The addressed-sends deadline race** and the other S3 and P1b carries.
- **A Relic idempotency key and the Relic Playwright spec** (I2b, decision 8).
- **Hosted takeover** (decision 6) and **per-session quota budgets** (V1).
