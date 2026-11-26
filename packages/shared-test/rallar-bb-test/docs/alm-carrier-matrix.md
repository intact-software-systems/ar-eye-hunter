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

- `call`: the send call throws a validation issue, at `path` with `code`. No handle exists.
- `origin`: the sender's page ends the handle `rejected` before any carrier attempt.
- `trusted-server`: the WS server answers with a NACK, and the sender states a rejection by its
  trusted server.
- `peer`: an RTC peer answers with a NACK, and the sender states a rejection by that peer.
- `receiver`: the page a frame or a receipt reaches refuses its proof (`of` names which, `code`
  why). It delivers nothing and answers nothing.

Where a send is handed to WS (`at`):

- `routing`: the browser sends over WS at once. One WS attempt, and no hand-over evidence.
- `admission`: RTC refuses the send or finds no route for it, and WS follows. The RTC leg's verdict
  is the evidence.
- `after-admission`: RTC had admitted the message, and the hand-over moved it to WS for `reason`.

## Proofs

- `lane-cell`: a scenario of the conformance catalogue, by its `scenarioKey`. It runs over that
  carrier in the lane's `full` scope and asserts the outcome there.
- `unit-test`: a test file, a part of one test's title, and a sentence on what that test pins. Use it
  for an outcome the lane cannot stage or witness, such as a call that throws.
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
  who refuses its gapped send.

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

## Add a capability

1. Read the product code and decide what the send comes to on each carrier. Do not copy a plan or a
   document: where they disagree with the code, the matrix follows the code.
2. Add the row to `ALM_CARRIER_MATRIX`: its `statement` and its three cells. If an outcome needs a
   word the vocabulary lacks, add it to `AlmCarrierOutcome`, and only then.
3. Give each stated cell its proofs. Name what exists today, and add an `unproven` proof for each
   part nothing shows yet.
4. Write the same outcomes, by hand, into the test's `EXPECTED_OUTCOMES`, and each `unproven` proof
   into `UNPROVEN_CELLS`.
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
