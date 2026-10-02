# ALM I2b design proposal: `local-checkpoint`, checkpointed durability

Status: decided 2026-10-02 (D129 to D135). Spec: [the QoS product plan](alm-qos-product-plan.md)
sections 3.1, 4, 5, 6 and 7.5; [the roadmap](alm-improvement-plan.md) D84, D85, D86, D88, D115,
D118. Code survey of `main` at `5e06c6ab0` (I2a-ii merged, #630). The implementation plan is
`plans/active/alm-i2b-local-checkpoint-implementation-plan.md`.

## 1. The problem

The durability axis has three tiers today. `volatile` sends from memory and loses everything at a
reload. `local-outbox` writes every admission and every work step to IndexedDB before the carrier
sees it: after P1a and P1b a warm durable send still spends 6 chain transactions and 8 in all. There
is no tier for an app that wants cheap sends and reload survival without per-message durability.
The QoS plan names that tier `local-checkpoint` (D84): admit and dispatch from memory, checkpoint
the lane's state to IndexedDB on an interval and on page hide, restore before the first work batch.

The survey found seven things the design must settle:

1. **The code answers "persist?" with a boolean.** `shouldPersistOutbox` is `durability !==
   'volatile'` (`packages/shared/al-contracts/al-policy.ts:394`), the dispatch plan carries
   `persist: boolean` and the runtime picks a lane from it (`al-outbound-message-runtime.ts:627`).
   Adding the value to the enum alone would send the tier to IndexedDB.
2. **Every room send carries an ordering key.** The browser sender defaults `orderingKey` to the
   group key (`browser-rallar-message-sender.ts:406-407`); a position exists only with a client
   `seq`. D85's "refuse ordered sends" cannot mean "refuse any ordering key".
3. **Nothing implements a checkpoint.** `InMemoryQueueBox` has a starting-map constructor but no
   export and no change signal; the memory admission backend serializes only its own writes, while
   the work port mutates the queue directly (`al-work-queue-port.ts:106,127,230,259`) and reads
   delete expired rows lazily.
4. **Two memory lanes per session.** WS and RTC each have an outbound runtime, and the RTC-to-WS
   hand-over moves a row between them.
5. **A non-owner tab's memory lane runs its own work.** The volatile lane is built with
   `durableWorkOwnership: undefined`; on takeover the restore meets a running memory store.
6. **No page-lifecycle listener exists in shared-web**, and the harness can only `agent.reload`.
7. **The durable lane already has every storage piece a changed-rows checkpoint needs**: the
   admission row shape, P1a's queue-entry codec, the one-transaction mutation writer
   (`write-indexed-db-admission-mutations.ts`), the prefix-scoped session purge, the 60 s eviction
   loop, the operation observer and the recovery reporter.

## 2. The design, per concern

### 2.a What a checkpoint is (D129)

A checkpoint is the memory lane's dirty rows applied to the existing `entries` and `alm-work`
object stores of the session's database, under the checkpoint lane's own store id, in one readwrite
transaction. Restore is the durable lane's existing bootstrap read into the memory store. No new row
shape, no new codec, no schema-id bump (the D84 bump clause is overtaken: nothing persisted changes
shape). The cost pin is one readwrite per checkpoint with as many requests as dirty rows, and
nothing while the lane is clean. H4 refuted the full snapshot (27 ms of main thread at the
1,000-admission bound, 114 ms at 4× CPU); changed rows are what QoS 7.5 already asked for.

### 2.b Where the rows live (D130)

A third store lane, `checkpoint`, beside `durable` and `volatile`: the same `ALOutboundStoreLane`
class with a memory admission pair from the volatile factories, the session's durable-work
ownership, its own health, its own first-batch recovery event and the checkpoint writer.
`ALStoreDurability` becomes `'volatile' | 'checkpoint' | 'durable'`; one pure selector
`resolveALOutboundStoreDurability(durability)` replaces `shouldPersistOutbox` at its three consumers,
and the dispatch plan carries `lane` instead of `persist`. The volatile lane keeps its budget, its
deadline-plus-grace retention and the D55 zero pin untouched. Receivers already route the tier to
memory (`resolveALInboundStoreDurability`), and the WS server keeps awaiting the route for any
non-volatile value.

### 2.c Coherence and dirty tracking

A capture is synchronous: dirty keys, their current memory values, the resulting mutations, in one
event-loop turn with no `await` inside. `InMemoryQueueBox` gains a change notification and an
`entries()` export; the memory admission backend reports dirty keys from its writes and from lazy
expiry deletes; a per-store dirty set holds `{key, revision}`. A key dirtied several times writes
once; a key deleted since writes a delete. Completion clears only the keys whose revision it
captured, so an older completion never marks newer state saved.

### 2.d The writer

One module. The first unsaved change arms one timer at the interval target; later changes never
postpone it; nothing runs while clean (the timer is the recorded S3 waiver). At most one write is in
flight and changes during it coalesce into the next. An interrupted write leaves the prior rows
intact (IndexedDB atomicity) and re-dirties its keys. `flush()` runs the capture and starts the
write at once for the lifecycle hooks; it is best effort and not awaited (R-I2b-7). Health:
`healthy → delayed` when the oldest unsaved age exceeds the interval, `→ failing` with the new cause
`checkpoint-lag` when it exceeds the bound or a write fails, back to `healthy` on a completed write;
transitions only, with the oldest unsaved age on the state. Beyond the bound new admissions follow
`onStorageUnavailable` through the existing availability path.

### 2.e Owner-only (D132)

The per-session durable owner of I2a-ii also owns the checkpoint: only the owner writes and
restores. A non-owner tab's `local-checkpoint` sends dispatch from its own memory and die with the
tab; their `admitted` verdict reads `durable: false`, as a volatile downgrade does, so the app can
see it. On takeover the restore runs before the taken-over lane's first batch and merges into live
memory with if-absent semantics. Cross-tab checkpoint coverage is a follow-up.

### 2.f Restore

In the checkpoint lane's readiness, before its first work batch: list the rows under the checkpoint
store id, load them into the memory pair, mark nothing dirty. Reserved rows return as retryable under
the existing lease rule; rows past `expiresAtMs` settle `expired` in the first batch; the first batch
reports `restored { claimed }` on the checkpoint store id. Restored messages have no handle (D13).
The store ids are new ids (`browser-ws-client-checkpoint:<sid>`, `browser-rtc-overlay-checkpoint:<sid>`)
so the durable lane's bootstrap, purge and recovery waits never see checkpoint rows; the session
purge and the eviction loop gain the prefixes. A purge after a disconnect finds the writer disposed,
so nothing writes back.

### 2.g The refusal (D131)

A `local-checkpoint` send with `ordering.seq` is refused typed `unsupported` at admission, through
the same drop-code shape as the ACK refusal. An ordering key alone and latest-wins supersedence are
allowed: a key without `seq` carries no position, and a copy superseded after the checkpoint was
never seen outside the runtime. This narrows D85 as D118 asked.

### 2.h Settings (D133)

Interval target 1,000 ms and recovery-lag bound 10,000 ms, composition-root settings on the browser
store factory with those defaults. A crash loses at most the admissions of the last interval; a page
that cannot complete a checkpoint for ten seconds reads `failing`.

### 2.i Lifecycle (D135)

The connect lifetime registers `visibilitychange` (to hidden), `pagehide` and `freeze` listeners,
owner only, removed at release, in one named adapter; each calls `flush()` on both checkpoint
lanes. H5 (completion on phones) stays unmeasured and is stated as a limit.

### 2.j Evidence

Unit: the writer with a fake clock and a fake transaction (aborted write, held write, revisions,
`delayed`, `failing`, recovery); the capture; the lane routing; the refusal; the restore merge.
Pins: the D55 zero pin extended to the tier (zero `al-admission`, zero non-probe `al-work` during
sends; exactly one write per checkpoint; zero while clean); the warm ledger, cold, inbound and
snapshot pins unedited. Lane (full tag): `checkpoint-recovery` on the reload pair,
`checkpoint-lag` through the storage fault port, `flush-on-hide` Playwright-only through CDP
`Page.setWebLifecycleState`. Hosted manifests 18 and 22 byte-identical; the hosted full read runs
the new cells. Relic: a reload-mid-command case in the manual full-stack suite.

### 2.k Relic (D134)

The command channel moves from `local-outbox` to `local-checkpoint`, keeping
`onStorageUnavailable: 'refuse'`. A reload mid-command resumes the command from the checkpoint and
the server's msgId dedup absorbs a repeat (D125, D126). A command admitted inside the last interval
is lost with the page and reads `unobservable` after the reload; the UI's existing "did not confirm"
text covers it.

## 3. Maintainer decisions (2026-10-02)

The maintainer took seven decisions on 2026-10-02, each the recommended option. The roadmap records
them as D129 to D135.

1. **Checkpoint = changed rows in the existing row formats (D129).** Declined: one snapshot row per
   store (new codec, schema bump, a full capture each time); a hybrid of snapshot plus deltas (two
   write and two restore paths).
2. **A third `checkpoint` store lane (D130).** Declined: sharing the volatile lane with per-row tags
   (budget, eviction and the zero pin learn exclusions); the durable lane with a deferred backend
   (its lock-per-send and canonical hand-off assume synchronous persistence).
3. **Refuse only `seq` (D131).** Declined: refusing latest-wins too; refusing any explicit ordering
   key.
4. **Owner-only checkpoint; a non-owner's rows are not checkpointed, stated limit (D132).**
   Declined: relaying non-owner rows to the owner; refusing the tier in a non-owner tab.
5. **Interval 1,000 ms, lag bound 10,000 ms (D133).** Declined: 250 / 5,000 and 5,000 / 30,000.
6. **Relic moves to `local-checkpoint` with `refuse`; the proof is a reload mid-command in the Relic
   full-stack Playwright spec (D134).** Declined: keeping `local-outbox`; `onStorageUnavailable:
   'volatile'`.
7. **Lifecycle listeners in the connect lifetime, proven by a Playwright-only `flush-on-hide` cell
   through CDP (D135).** Declined: a new `agent.hide` command (proves the listener, not the browser);
   unit tests only.

## 4. Corrections to the roadmap and the QoS plan

- QoS 4 "Restrictions": the refusal is `seq` only (D131); the ordering key and latest-wins pass.
  QoS 5's "`local-checkpoint` therefore refuses ordered and latest-wins sends" reads the same way.
- QoS 4 "Capture and write": "one readwrite that replaces the previous point" is read as changed rows
  in the existing stores (D129, QoS 7.5 item 4); an interrupted write leaves the prior rows intact.
- QoS 6: the two session-store settings have defaults (D133).
- D84's "schema-id bump" clause is overtaken by D129: no persisted shape changes.
- The roadmap row "4 I2b" stands; "Relic Hunters commands as the consumer" is D134.

## 5. Carries: what I2b does not do

- Cross-tab checkpoint coverage (a non-owner's rows), D132.
- The hide flush on phones (H5), measured only when phones are available.
- A bounded FIFO per key on receive ("keep the last N copies", D118's third demand) stays a backlog
  item; I2b adds no such store.
- The frozen-owner case: a frozen page keeps its lock; the flush on `freeze` is the only mitigation.
- The inbound memory lane is not checkpointed: a receiver's dedup state for the tier dies with the
  page, as it does for `local-outbox` receivers today.
