# ALM Carrier Matrix

Some ALM capabilities come to a different end on each carrier on purpose: the same send can be
delivered over one carrier, refused over another, and handed to WS under the fallback strategy. The
carrier matrix is the one place that says, for each such capability and each carrier, what a send
comes to and what proves it. It lives in
[`conformance/alm/carrier-matrix/alm-carrier-matrix.ts`](../conformance/alm/carrier-matrix/alm-carrier-matrix.ts)
as `ALM_CARRIER_MATRIX`. Read the cells there: this page explains how to read and change them, and
does not repeat them.

A capability is one row: a `statement` and one cell for each of `ws`, `rtc` and
`rtc-with-ws-fallback`. A cell is `stated`, with one outcome and at least one proof, or
`not-applicable`, with the reason the capability means nothing on that carrier.

## Outcomes

| Outcome        | What happened to the send                                                                     |
| -------------- | --------------------------------------------------------------------------------------------- |
| `delivered`    | It reached its audience.                                                                      |
| `refused`      | Someone said no. `by` names who, below.                                                       |
| `handed-to-ws` | The fallback strategy left RTC and sent it over WS. `at` names where, below.                  |
| `undelivered`  | It reached no recipient, and its handle ended on the `failure` the cell names, not a refusal. |

Who refuses (`by`):

- `call`: the send call throws a validation issue, at `path` with `code`. No handle exists. A reply
  wait's refusal is its call's resolved value instead: the request has a handle, whose `awaitReply`
  never throws and resolves `unanswerable` with that issue.
- `origin`: the sender's page ends the handle `rejected` before any carrier attempt.
- `trusted-server`: the WS server refuses the send at its own admission and answers the sender with a
  NACK.
- `peer`: an RTC peer refuses the send at its own admission and answers the hop that sent it with a
  NACK.
- `receiver`: the page a frame or a receipt reaches refuses its proof (`of` names which, `code`
  why). It delivers nothing and answers nothing. A frame the page's room admission refuses keeps the
  room's refusal instead.

`refused` by the `trusted-server` or a `peer` says who refused and why. What the sender's page then
states is decided by two conditions:

- **Is the NACK from a peer the send owes?** The origin admits a peer's NACK only from a unicast's
  addressee, a peer its receipt expects, a session a server admitted the send to, or a hop its
  carrier sends every frame through. A NACK from any other peer is refused and the origin states
  nothing: a room send that asked no receipt owes no peer an answer. The trusted server's rejection
  needs no such check.
- **Does the send hold a receipt row?** The origin states an admitted NACK as a rejection by that
  relay. But a `membership-fenced` NACK, and the trusted server's `unauthorized` or `no-leader`, is a
  rejection only while the send has no receipt row. With one, an admitted `membership-fenced` or
  `unauthorized` NACK ends the send's receipt instead: `receipt-exhausted`, cause `hop-refused`.

Where a send is handed to WS (`at`):

- `routing`: the browser sends over WS at once. One WS attempt, and no hand-over evidence.
- `admission`: RTC refuses the send or finds no route for it, and WS follows. The RTC leg's verdict
  is the evidence.
- `after-admission`: RTC had admitted the message, and the hand-over moved it to WS for `reason`.

## Proofs

- `lane-cell`: a scenario of the conformance catalogue, by its `scenarioKey`. It runs over that
  carrier in the lane's `full` scope and asserts the outcome there. When the scenario shows only a
  part of the outcome, its `because` names that part and what the run leaves open, and another proof
  of the cell covers the rest.
- `unit-test`: a test file, a part of one test's title, and a sentence on what that test pins. Use it
  for an outcome the lane cannot stage or witness, or beside a lane cell for what only a unit test
  reads, such as both carriers' admission ports. A call the product refuses with a validation issue
  is witnessed in the lane by a send that observes `call-refused`.
- `documented-limit`: a document and the phrase in it that states the limit. Use it for a property
  no test can show, such as what a relay is able to read.
- `unproven`: nothing proves this part of the outcome yet. `closedBy` names what will.

A cell may list several proofs. An `unproven` proof beside others says which part is still open.

## How the catalogue reads the matrix

- **Carriers.** A scenario that a cell names as a lane proof states no carriers of its own. Its
  definition writes `carriers: resolveAlmCarrierMatrixCellCarriers('<scenarioKey>')`, which returns
  each carrier whose cell names it. A scenario that needs a world broadcast to leave the sender's
  page takes `resolveAlmWorldSendCarriers()`. The hosted manifests are built from the same catalogue,
  and their withheld list reads `<definition>.carriers`, so they follow the matrix too.
- **Verdict facts.** `toAlmCarrierOutcomeFacts(outcome)` turns an outcome into the facts the
  sender's handle must hold. It takes the three outcomes whose evidence is on that handle: refused by
  the `origin`, and handed to WS at `routing` or `after-admission`. For any other outcome the scenario
  asserts its own evidence, and reads its cell where the carriers differ, as `ordering-resync` reads
  who refuses its gapped send. `toAlmCallRefusalFacts(refusal)` turns a refusal by the `call` into
  the facts the refusal a witnessed send returns must hold: one issue, at the cell's path, with its
  code.

## What keeps the matrix honest

The second check runs in the lane. The others, and the tests of the second's validator, run in
`packages/tests/shared-test/alm-carrier-matrix.test.ts`.

1. **Agreement with the catalogue.** `validateAlmCarrierMatrix` reports a lane cell the catalogue
   does not run over the carrier that names it, a lane cell outside the `full` scope, and a named
   scenario the catalogue runs over a carrier where no capability names it.
2. **The lane's own plan.** The lane's `lane plan over <carrier>` test asserts
   `validateAlmCarrierMatrixPlan`: a `full` run must plan every lane cell the matrix names over its
   carrier. A `smoke` run, and a run narrowed by `RALLAR_BLACK_BOX_ALM_ONLY` or
   `RALLAR_BLACK_BOX_ALM_SKIP`, is not judged.
3. **Outcomes written twice.** The test holds a second table of every outcome, written by hand from
   the product code. A cell that changes in one place only fails.
4. **Test names.** Every `unit-test` proof's `testName` must appear in its `testFile`.
5. **Document phrases.** Every `documented-limit` proof's `limit` must appear in its `document`.
6. **The unproven list.** The test pins every `unproven` proof by capability, carrier and `closedBy`.
   Nobody adds or removes one without changing that list.
7. **The partial lane cells.** The test pins every `lane-cell` proof that carries a `because`, by
   capability, carrier, scenario and sentence. Nobody narrows what a lane cell is said to show
   without changing that list.

## Add a capability

1. Read the product code and decide what the send comes to on each carrier. Do not copy a plan or a
   document: where they disagree with the code, the matrix follows the code.
2. Add the row to `ALM_CARRIER_MATRIX`: its `statement` and its three cells. If an outcome needs a
   word the vocabulary lacks, add it to `AlmCarrierOutcome`, and only then.
3. Give each stated cell its proofs. Name what exists today, and add an `unproven` proof for each
   part nothing shows yet.
4. Write the same outcomes, by hand, into the test's `EXPECTED_OUTCOMES`, each `unproven` proof
   into `UNPROVEN_CELLS`, and each lane cell that carries a `because` into `PARTIAL_LANE_CELLS`.
5. For each scenario a cell newly names, make its definition take
   `resolveAlmCarrierMatrixCellCarriers('<scenarioKey>')`, delete the carriers it stated, and add it
   to the test's `EXPECTED_CELL_CARRIERS`. The scenario must carry the `full` tag.
6. Run `npx vitest run packages/tests/shared-test/alm-carrier-matrix.test.ts` and
   `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check`. A scenario
   that now runs over another carrier can change a hosted manifest unless
   `HETZNER_WITHHELD_ALM_SCENARIOS` withholds it.

## Close an unproven cell

1. Build what `closedBy` names, test first: an assertion in a lane scenario, a scenario over one more
   carrier, or a unit test.
2. In the cell, replace the `unproven` proof with the proof that now holds. If a proof the cell
   already lists now covers that part, as when its lane scenario gains the assertion, just remove the
   `unproven` proof. Reread the row's `statement` and each `because`, and correct any that is no
   longer exact.
3. Remove the entry from `UNPROVEN_CELLS`. The list shrinks by exactly the proofs you closed.
4. If a scenario now runs over one more carrier, update `EXPECTED_CELL_CARRIERS` and run the manifest
   check of step 6 above.
5. Run the cell in the lane, over the carrier you closed. For `ordering-resync` over `ws`:

   ```sh
   RALLAR_BLACK_BOX_ALM_SCOPE=full RALLAR_BLACK_BOX_ALM_CARRIERS=ws \
     RALLAR_BLACK_BOX_ALM_FAMILIES=two-agent RALLAR_BLACK_BOX_ALM_ONLY=ordering-resync \
     npm run test:rallar:full-stack:memory:alm
   ```

   [`docs/environment-variables.md`](../../../../docs/environment-variables.md) describes these
   variables.
