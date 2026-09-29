# PR #566 reconciled with ALM: design

**Status:** design for maintainer review, 2026-09-29. Once approved, an implementation plan follows beside it
in `plans/active/`. Both files are deleted before #566 merges.

**Pull request:** [#566](https://github.com/intact-software-systems/ar-eye-hunter/pull/566), branch
`codex/rtc-b06-overlay-gap-plan`, head `4005e09ea` at the time of writing (base `91a09eec3`). Main is `0d5902bc6`,
which contains ALM S3c-i (#605) and S3c-ii (#606).

**Findings this design answers:**
[review comment](https://github.com/intact-software-systems/ar-eye-hunter/pull/566#issuecomment-5895046567).
Merged into main, #566 compiles but:

- breaks S3c-ii's WS volatile-bound test;
- crosses both bundle ceilings;
- fails the tests typecheck.

It also duplicates five ALM mechanisms and makes ten ALM product decisions that no ALM document records. Its
latest Branch Release Gate is red, and the ALM smoke case "durable-opt-in over WS" fails only on #566.

## Goal

#566 lands on main as one pull request, with everything product it contains, without breaking ALM:

- every ALM behaviour on main either still holds or is changed by a recorded D-row;
- every #566 decision that ALM documents do not record gets one;
- main's gates pass on the final head.

## Authorities and precedence

Two approved sources disagree:

- ALM: `playground/alm/alm-improvement-plan.md` D1–D94 and `alm-complete-product-description.md`.
- #566's own designs under `docs/superpowers/specs/`, approved 2026-09-27 and 2026-09-28.

The decisions below settle every known conflict. Where they are silent, the ALM D-table wins. A #566 behaviour
that the table does not cover is kept only with a new D-row (from D95). No decision here changes an ALM
behaviour without a row.

## Decisions (maintainer, 2026-09-29)

| Id  | Decision                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Scope:** one PR keeps all of #566's product themes, reconciled: heartbeat lease, `offerId` correlation, overlay-gap recovery, ALM scheduler, cluster live-WS notices, RTC signaling across processes, scoped provenance, game/Relic publication, principal state-sync reads, recipe fixes and state-write tooling. The experiments leave the PR (P13). |
| P2  | **E3:** the RTC-B06 100-cycle reconnect run is run once and reported. It is not part of the merge bar. The receiver-watchdog correction and the browser AL IndexedDB lifetime design stay out.                                                                                                                                                           |
| P3  | **Who builds it:** Claude takes over #566's branch; the Codex session no longer pushes to it. Main is merged in first, and fixes go on top (approach A).                                                                                                                                                                                                 |
| P4  | **Live-only fanout:** fanout is a topic declaration again (D71). An at-least-once message on a live-only topic is sent live once, cluster-wide through the notice, and its receipt ends `timed out` for unconfirmed recipients (product description 418-419). No refusal, no silent upgrade. Undeclared topics keep main's router default.               |
| P5  | **Inbound scan:** a head read after a commit replaces the scan rewind (section "Scan").                                                                                                                                                                                                                                                                  |
| P6  | **RTC authority gaps:** the gap decides the carrier; authorization fails only for an explicitly foreign or inactive overlay (section "RTC gap").                                                                                                                                                                                                         |
| P7  | **Ingress scope check** stays. A mismatch is refused with a NACK, through the same policy as S3c-i's addressee refusal.                                                                                                                                                                                                                                  |
| P8  | **Schema:** `AL_ADMISSION_SCHEMA_ID` gets a new id. Decoders are strict and there is no migration; old rows are refused, as with the S3c-i bump.                                                                                                                                                                                                         |
| P9  | **Statuses:** `sent-live`, `cluster-published` and `queued-outbox` all map to the game's `sent`, meaning handed to a carrier. Main already maps `queued-outbox` to `sent`; only `cluster-published` is new.                                                                                                                                              |
| P10 | **NOTIFY notice** is a best-effort, one-attempt cluster carrier and amends D37. Receipts keep their meaning. An oversized publication with no canonical inbound row is refused with a typed result.                                                                                                                                                      |
| P11 | **Initial control** messages skip the sender queue and the Web Lock only if a two-tab test proves no duplicate and no out-of-order control send. Otherwise the change is reverted.                                                                                                                                                                       |
| P12 | **Raw outbox rows** without producer provenance fail closed. A unicast `router.publish` without a scope returns a typed `failed`, not `skipped`.                                                                                                                                                                                                         |
| P13 | **Duplicates removed:** one D58 audience path (#566's, D58 widened), one cluster audience read (`readCapturedPolicy`), the wire `groupRef` as the scope authority for room and unicast messages, one accepted-layout predicate in `packages/shared`, and one `created_by` clamp.                                                                         |
| P14 | **Experiments out:** the RTC diagnostics harness, the ALM probes and `docs/superpowers/**` leave the PR; tag `pr566-pre-reconcile` keeps them. The E3 phase timing stays (P17).                                                                                                                                                                          |
| P15 | **State-write:** the #566 comparison workflow becomes generic (a label on any PR, base against head). The regression is attributed first; then the principal-relevant read design is built. It is accepted only if the unchanged comparator passes. If both measurement runs pass, the read is built only when the bytes show the double read.           |
| P16 | **Issue #594** (RTC redial after a reload) is fixed in this PR on top of `offerId` (section "RTC redial"). It fixes the reload case; the issue stays open for the rest.                                                                                                                                                                                  |
| P17 | **E3 phase timing** (`d211d4667`, `39c70b5ed`: named phases and non-TTY start markers in the unchanged three-browser E3 spec, list reporter `printSteps`) stays, because P2 reports E3.                                                                                                                                                                  |
| P18 | **Principal-relevant read design** (`docs/superpowers/specs/2026-09-29-principal-relevant-state-sync-read-design.md` on the branch) is the design task 10 builds. Its text moves into this file's section "State-write", and the source file leaves with P14.                                                                                            |
| P19 | **Bundle ceilings** are re-measured at the end and raised to the next whole KiB, with the figures recorded.                                                                                                                                                                                                                                              |
| P20 | **Acknowledgements across processes:** an ACK that finds no receipt aggregate on its process is relayed once over the cluster notice to the process that owns the receipt. Best effort. Amends D37 (a second notice kind).                                                                                                                               |
| P21 | **Three-process RTC browser mode** stays, with a simpler assertion: three browsers, each on its own API origin, reach RTC readiness and exchange a message. It reads nothing from the removed harness.                                                                                                                                                   |
| P22 | **E3 workflow:** #566's version of `rtc-b06-performance-observation.yml` stays, because main's cannot run the 100-cycle case from a branch.                                                                                                                                                                                                              |

## Work order

Each task is committed, reviewed and pushed to the branch before the next one starts.

| #  | Task                                                                                                                                                                                            | Done when                                                                                                                                                                                                     |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0  | Handover: tag `pr566-pre-reconcile` at `4005e09ea` and push the tag                                                                                                                             | Tag on origin; nothing else pushes to the branch                                                                                                                                                              |
| 1  | Base: merge main; resolve the 7 conflicts (bundle ceilings take the larger value for now; tests keep both sides' cases); fix the 2 TS2554 in S3c-ii's tests (`faultPort` as the third argument) | `typecheck` green including tests; `test:unit` green except S3c-ii's WS volatile-bound test, which stays red until task 3                                                                                     |
| 2  | Remove the experiments (P14) and their registry entries (test-structure-coupling, repo-style exceptions); keep P17                                                                              | Build and tests green                                                                                                                                                                                         |
| 3  | Scan head read (P5)                                                                                                                                                                             | Tests in section "Scan" pass                                                                                                                                                                                  |
| 4  | RTC gap (P6)                                                                                                                                                                                    | Tests in section "RTC gap" pass                                                                                                                                                                               |
| 5  | RTC redial, #594 (P16); manifest 18 stops withholding `delivery-reload` on `rtc` and `rtc-with-ws-fallback`                                                                                     | Tests in section "RTC redial" pass, including the counter-case; the local lane's `delivery-reload` RTC cells pass                                                                                             |
| 6  | Live-only fanout (P4)                                                                                                                                                                           | The game authority server's default publish succeeds through the real router                                                                                                                                  |
| 6b | Acknowledgements across processes (P20)                                                                                                                                                         | The cluster recipe's receipt ends `complete` for a recipient on another process; a forged relayed acknowledgement is dropped                                                                                  |
| 7  | Scope, statuses, schema (P7–P9, P12)                                                                                                                                                            | S3c-i's addressed-sends recipe passes with scoped URLs; a new step proves a mismatched-scope send gets the typed NACK; every WS client (Relic server, black-box runner, headless agent) carries the URL scope |
| 8  | Duplicates (P13)                                                                                                                                                                                | The deleted copies have no references left                                                                                                                                                                    |
| 9  | Initial control, two-tab test (P11)                                                                                                                                                             | Kept or reverted, with the result recorded                                                                                                                                                                    |
| 10 | State-write (P15, P18)                                                                                                                                                                          | The unchanged comparator passes                                                                                                                                                                               |
| 11 | CI reds: a fresh gate run; for WS durable-opt-in and the addressed-sends server receipt, read that run's artifacts before theorising                                                            | Both green, with the cause named                                                                                                                                                                              |
| 12 | ALM documents: D95 onwards, the product description, the alm READMEs, the RTC baseline plan's status, and the keep-set line in `plans/README.md`                                                | Every decision here has a row                                                                                                                                                                                 |
| 13 | Gates and final review                                                                                                                                                                          | Merge bar below                                                                                                                                                                                               |

## Scan

**The problem.** Main rewinds the whole inbound rotation to NEW page 1 on every commit (`restartScan`). F2b
needs a committed row to be taken in the batch the commit starts when the owner is idle, or in the follow-up
batch when it is busy (`alm-improvement-plan.md:411-416`, acceptance at 428-429). #566 found that continuous
commits keep resetting the rotation, so later NEW pages, RETRY and expired RESERVED rows can wait without
bound. It removed the rewind, which breaks F2b in both cases.

**The two states the code already has.** `ALWorkHandler.committed()` (`packages/shared/alm/work/al-work-handler.ts`):

- **idle** (`batch === undefined`): it runs a batch at once;
- **busy**: it sets `commitPending`, and one follow-up batch runs when the current batch ends.

**The design.** The rotation page (`read-al-inbound-work-selection.ts`) gains a pending head read, which
`commitWork()` sets in place of `restartScan()`.

- While a head read is pending, the next selection reads NEW from cursor `null`. It does not store the scan
  position it returns, so the rotation's saved cursor is untouched. The selection after that resumes the
  rotation.
- At most one head read runs between two rotation reads. A commit during a head batch waits for the batch after
  the next rotation read.
- The held page is dropped when a head read becomes pending, as `restartScan` dropped it.

**What F2b gets.** Idle: the new row is taken in the batch the commit starts. Busy: in the follow-up batch;
under back-to-back commits, at the latest the batch after that. The rotation advances at least every other
batch.

**Tests** (`packages/tests/shared/alm/`):

- F2b same-batch delivery when idle;
- follow-up-batch delivery when busy;
- S3c-ii's WS volatile-bound test, unchanged;
- #566's finite-backlog progress test;
- new: a RETRY row and an expired RESERVED row are claimed within a bounded number of batches while commits
  keep arriving.

**D-row:** replaces F2b's rewind and states the two-batch bound.

## RTC gap

`computeOutboundAuthority` in `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts` keeps #566's
checks but gives two kinds of outcome.

- **Carrier not available now:** no room snapshot, room not `flowing`, no accepted layout, presence drift with no
  overlay, or an overlay that is not the exact accepted layout.
- **Authority refused:** the selected overlay is explicitly foreign or inactive for the message's `groupRef`. It
  stays `unauthorized` for every strategy.

| Case                                         | Admission                                | Dispatch                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fallback strategies (`rtc-with-ws-fallback`) | `no-route`: WS at once, as on main (D56) | `not-ready`: WS after 3, as on main (S3 §11.1(2))                                                                                                                                                                                                                                                                        |
| `rtc` only, durable                          | Admitted                                 | Held as dequeue work with no prepared copy. The handle reads `accepted`. One `not-ready` attempt is stated when the gap begins. When the accepted overlay returns inside the deadline, the copies are planned to the audience frozen at admission and the receipt starts. Otherwise the deadline ends the send `expired` |
| `rtc` only, volatile                         | `no-route`, as on main                   | —                                                                                                                                                                                                                                                                                                                        |

A peer unicast keeps main's own admission: a missing snapshot defers it, and an unready addressee is `no-route`.
Only its dispatch sees the gap, as `not-ready`.

The message carries no strategy, so the leg tells the manager what a gap means: `hand-over` for a leg with a
fallback carrier, `hold` for a leg without one (`rtc`, and the RTC leg of `ws-then-rtc`). A copy already prepared
when a gap opens settles `not-ready` on every attempt, so a fallback strategy hands it to WS after three.

**Tests:**

- S3b's fallback suites and S3c-ii's director `{peerId}` fallback, unchanged;
- #566's overlay-gap tests with the new verdicts;
- new: an `rtc`-only durable send in a gap ends `expired`, with one `not-ready` attempt recorded for the gap;
- new: a foreign overlay stays `unauthorized`.

**D-row:** carrier versus authorization for RTC room authority; D56, D65 and D10 are cited, not changed.

## RTC redial (#594)

**The case.** Seen in S3c-ii's hosted manifest 18 runs 2 and 3 (#606), where it was deterministic.

1. S reloads. R, the impolite side, replaces the dead peer and offers within 1 s, before S has a socket. The
   offer and ICE are forwarded live-only and dropped.
2. The layout drops S. R keeps the never-established peer for the 15 s overlay grace.
3. S rejoins with the same session id inside the grace. `removeRetainedDesiredPeers`
   (`web-rtc-group-manager.ts:782`) takes back the in-flight peer. `isPeerConnectedOrInProgress` counts it as
   live, so no dial is planned.
4. S is polite and never offers. The pair recovers only at R's 30 s establishment timeout.

Manifest 18 withholds `delivery-reload` on `rtc` and `rtc-with-ws-fallback` because of it
(`apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts:57-64`).

**Why the S3c-ii attempt failed, and why `offerId` fixes that.** The S3c-ii fix (`d4dac3a20`, reverted in
`a55eba83b`) disconnected and redialled the in-flight peer. After a close and connect, the peer returned under
the same session id. The late answer to the old offer then landed on the new connection and ICE stuck. #566's
correlation settles this: an answer is accepted only when its `offerId` is the pc's outstanding offer
(`qrtc-peer-connection.ts`), so a late answer to a replaced offer is discarded.

**The design.** In `runReconcilePass`, a retained peer that becomes desired again is disconnected before
`computeOutboundDialPlan`. Its attempt budget is kept, not reset, so the redial counts as an attempt. The same pass then redials, now to a live socket.
The rule applies only when all of these hold:

- this side offers (it is the impolite side);
- its offer is still unanswered;
- the peer was retained for an overlay transition.

A peer that established, and a polite side's peer, are never touched by this rule.

**What is left.** `offerId` correlates answers, not offers. If the old offer is applied after the new one, the
pair recovers at the 30 s establishment timeout. The server drops an offer to an offline session, so this needs
the old offer to reach a page that is back online but not yet ready. The residual is recorded in D98.

**Tests:**

- A group-manager test with `native-rtc-connection-fixture.ts`:
  1. Impolite A has an established peer to polite B.
  2. B closes and B's signaling drops messages.
  3. A's fresh offer is lost.
  4. B is un-desired, then desired again within the grace, on the same session id.
  5. A sends a new offer in that pass.
- **Counter-case:** the old offer reaches B late. Its answer is discarded by `offerId`, and the pair connects on
  the new offer.
- An established peer that is re-desired is kept.

**Acceptance:** manifest 18 includes `delivery-reload` on both RTC carriers again, and the hosted run from the
branch passes it.

## Live-only fanout

- The router default goes back to `options.defaultFanout ?? 'live-only'`, and the QoS-derived fanout is removed.
- `publish-rallar-server-ws-message.ts` picks the carrier from the fanout alone:
  - `outbox`: a WS_OUTBOX row, with retries and the frozen audience;
  - `live-only`: one live attempt to local sockets plus the cluster notice, at any QoS;
  - `none`: the handler only.
- Both refusals are removed ("requires durable outbound work", "incompatible with durable outbound work"). So is
  the router's unmet-requirements refusal on a live-only topic, which #566 also added.
- The rule holds in both directions: a best-effort message on an `outbox` topic goes to the outbox, not to a
  notice.
- The oversized-live refusal stays (P10).
- **Test:** the game authority server's default snapshot, event and command-result publishes succeed through the
  real router, not a fake.

## Acknowledgements across processes

- **The gap.** A recipient's ACK is admitted on the process that holds its socket. The receipt aggregate lives on
  the process that admitted the message. When they differ, the ACK is refused, and the sender's receipt ends
  `timed out` for a recipient that did get the message. Main has this gap on every fanout.
- **The design (P20).** The recipient's process checks the connection and scope, then publishes the control
  message as a `relayed-ack` notice. The process that holds the aggregate checks that the sender is in the frozen
  audience and feeds it to the receipt aggregation. Other processes ignore it.
- **Rules.**
  - A process that holds the aggregate never relays.
  - A relayed notice is never relayed again.
  - No handler runs on a subscriber.
  - A lost notice leaves the recipient unconfirmed.
  - Only ACKs are relayed. No server code consumes a recipient's NACK.
- **Tests:** the receipt completes when the ACK arrives by notice; a forged relayed acknowledgement is dropped;
  a duplicate changes nothing; the cluster recipe ends `complete`; the medium-scale gate still passes.

## Scope, statuses, schema

- **Ingress.** `ws-queue-box-server-inbound-authority.ts` refuses a mismatched scope with a NACK through the
  wrapped authorizer's NACK policy, with its own reason.
- **Scope authority.**
  - For messages with `targets.groupRef`, the wire `groupRef` is the authority, and the captured policy stops
    storing a second copy.
  - The sender's `authenticatedScope` stays; it proves the connection, which is a different fact.
  - `recipientScope` and `principalTargetId` stay only for rows with no `groupRef`: principal, world, logout.
- **Statuses:** P9, in `install-rallar-game-authority-server.ts`.
- **Schema:** a new `AL_ADMISSION_SCHEMA_ID`, strict decoders, no migration. The PR body states that web and API
  deploy together (the `offerId` wire change and this bump).

## State-write

1. **Attribution.** Run the unchanged A-B-B-A comparator (the generic workflow) twice, both against main: the
   branch after task 9, and the same branch with the principal reads reverted.
   - If only the second passes, the reads are the cause.
   - If both fail, revert one theme at a time (cluster notice, provenance) until the cause is found.
   - If both pass, the read is built only when the bytes show the double read: the first run's uncontended
     result-bytes ratio is at least 1.01 and above its hot ratio, and the second run's is lower.
   - The second run goes through a throwaway draft pull request, because GitHub cannot dispatch a workflow that
     is not on main yet. The maintainer consented to those pull requests and to the label `measure-state-write`.
2. **The principal-relevant read.**
   - The current reader loads and validates every group in the application/workspace twice before it finds the
     actor's memberships.
   - Add a `prefix-suffix` `RuntimeStateReadBatchSelector` to memory, PGlite and PostgreSQL:
     - literal prefix `${groupStateScopeStorageKey(scope)}:` in `MEMBERS_NAMESPACE`;
     - literal suffix `:member=${encodeURIComponent(principalId)}`;
     - C-collated bounds and a literal suffix comparison, never `LIKE`.
   - `listSnapshotsForPrincipal` selects only the actor's member rows, validates them, and batch-reads their
     groups. A second pass reconciles group and member revisions.
   - An unrelated corrupt group no longer blocks this principal's publication. A selected corrupt row is still an
     error. A member row whose group is purged contributes no audience.
3. **Evidence.**
   - Capture `EXPLAIN (ANALYZE, BUFFERS)` and per-query result bytes.
   - An index is a separate decision, made only if the measurement demands it.
   - Accepted only when the unchanged comparator passes.

## Merge bar

| Where           | Green                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local           | `test:unit`, `test:ci`, `build`, `typecheck` including tests, changed-style and coupling checks, `test:deno`, api-v1 black-box (memory, Postgres, medium-scale), the full ALM lane, the director spec |
| Branch CI       | Branch Release Gate on the final head, formation and medium-scale gates, the state-write comparator                                                                                                   |
| Hosted          | Manifests dispatched from the branch, with manifest 18 including `delivery-reload` on the RTC carriers                                                                                                |
| ALM observation | Smoke green on 3 consecutive gate runs. At most 2 full reads (repo variable set before, deleted after): every WS cell green, RTC cells no worse than S3c-ii's recorded reads                          |
| Reported only   | One E3 100-cycle run, with phase timing                                                                                                                                                               |
| Bundles         | Next whole-KiB ceilings, with the measured figures                                                                                                                                                    |

Then a final whole-branch review with three seats (product, harness, tests) and one fix wave. The maintainer
merges. After the merge, main's Hetzner manifests and deploy are watched.

## Out of scope

- E3 acceptance and the receiver-watchdog correction.
- The browser AL IndexedDB lifetime design.
- B07.
- An index for the principal read, unless measured.
- A large-message carrier beyond the NOTIFY limit.
- CRDT command-format or public compatibility changes.

## Risks

- **Merge churn.** Main keeps moving: S3c-ii follow-ups and CI changes. Merge main again before task 13, not in
  between.
- **Hidden causes.** The state-write attribution can point at more than the principal reads; P15 then grows. It
  is measured, not guessed.
- **Carrier cost.** The cluster notice path for at-least-once live-only traffic (P4) adds NOTIFY volume on
  game topics, which the medium-scale gate measures.
- **Two lanes in one worktree.** The scan and RTC tasks both touch timing-sensitive browser paths. Lanes run one
  at a time on 18080/5180, and nothing is edited while a lane runs.
