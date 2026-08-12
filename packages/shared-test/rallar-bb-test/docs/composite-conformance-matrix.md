# Composite Conformance Matrix

`packages/shared-test/rallar-bb-test/composite-conformance.ts` owns the shared
matrix for proving composite command semantics across local, browser-backed,
and remote-browser execution paths.

The matrix is intentionally small. It checks representative behavior, not every
transport permutation:

- `looped-rtc-send`: looped RTC sends, pacing/send summaries, `stats`, cleanup.
- `parallel-ws-rtc-groups`: bounded parallel WS and RTC send branches.
- `wait-assert-evidence`: send evidence consumed by `wait` and `assert`.
- `cancel-during-loop`: cancellation propagation from inside a loop.
- `wait-absence-hold`: a same-topic positive control delivery followed by an
  `absent: true` wait on a different topic that holds the full window and
  passes.
- `wait-absence-violated`: the deliberately-broken control — the absence wait
  targets the topic that was just delivered and must fail with
  `RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED` carrying the offending redacted
  event.
- `assert-shape-complete-violated`: the shape-operator broken control — a
  delivered frame carries an unexpected array element and the
  `matchesShapeComplete` assert must fail with
  `RALLAR_BLACK_BOX_ASSERT_FAILED`.
- `loop-until-convergence`: an `until: 'first-success'` loop polls an
  `http.request`/`assert` pair and exits on the first fully passing attempt.
- `loop-until-exhausted`: the polling broken control — a never-converging
  until loop must exhaust its bounds with
  `RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED` carrying the last attempt.
- `negative-no-peer`: no-peer send failure separated from local composite
  orchestration.

Case recipes are built in
`conformance/create-rallar-black-box-composite-conformance-recipe.ts`
(absence cases in `wait/wait-absence-conformance-recipes.ts`, assert shape
cases in `assert/assert-shape-complete-violated-recipe.ts`, polling cases in
`loop/loop-until-conformance-recipes.ts`) from the shared command fixtures
in `conformance/composite-conformance-command-fixtures.ts`.

Provider rows are:

- `in-memory-local`: deterministic local runtime with fake transport evidence.
- `browser-rallar`: live-gated browser adapter path, requiring Rallar API
  credentials and Playwright.
- `remote-browser-control`: live-gated control-server path, requiring a Rallar
  API, control server, and target browser agent.

Live rows are skip-safe. They carry explicit `requires` metadata for
environment variables, HTTP services, Playwright, and control-server needs.
Provider differences are recorded as capability differences on each row so
artifacts can distinguish real capability gaps from accidental regressions.

## Assertion Outcome Parity

`conformance/assertion-outcome-parity.ts` proves the two dialects agree on
assertion verdicts, not just step statuses: shared fixtures are evaluated by
the black-box-runner engines (`expect.comparators`, `compatible-complete`,
`expect.absent`, `http.poll-until`) and by the `rallar-bb-test` runtime
(extended `assert` operators, `matchesShapeComplete`, `wait absent: true`,
`loop until: 'first-success'`), and every row must agree with the expected
pass/fail verdict. A semantics divergence between the dialects fails
`rallar-bb-test-assertion-outcome-parity.test.ts` by contract. The
step-presence/status comparison in `provider-parity.ts` remains the
transport-level companion.

## Reports

Use `toRallarBlackBoxCompositeConformanceReport(...)` to build an artifact
summary from a matrix entry, command result, and runtime state. Reports include:

- expected status, command kinds, composite kinds, event topics, and failure
  codes
- observed status, command IDs/kinds, event topics, diagnostics/failure counts,
  failure codes, and composite result summary
- provider capability differences
- redacted diagnostic and failure snippets

Reports deliberately omit raw child result arrays. Use normal
`rallar-bb-test` result artifacts when a failure needs deep inspection.

## Local Verification

Run the deterministic conformance matrix:

```bash
npm run test:shared-black-box:composite-conformance
```

For full shared-test type coverage:

```bash
npm --workspace @ar-eye-hunter/shared-test run check:ts
```

## Live Usage

The shared matrix does not itself launch browsers. Live runners should import
the matrix, preflight the `requires` metadata, dispatch each recipe through the
selected provider path, then write the conformance report beside ordinary
command/result/event artifacts.

For local live browser rows, provide:

```text
RALLAR_API_BASE_URL
RALLAR_ALICE_USERNAME
RALLAR_ALICE_PASSWORD
RALLAR_BOB_USERNAME
RALLAR_BOB_PASSWORD
```

For remote-browser rows, also provide:

```text
RALLAR_BLACK_BOX_CONTROL_BASE_URL
RALLAR_BLACK_BOX_AGENT_ID
```
