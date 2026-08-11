# Rallar BB-Test Distributed Assertion Parity Plan

> **For Codex/Claude:** Execute each workstream as its own PR with
> `publishing-plan-progress`, `rallar-code-writing`, and `rallar-testing`;
> read `rallar-hetzner-ops` before touching manifests, rollout scripts, or
> workflow dispatch. The paste-able prompt under each workstream is the
> intended starting instruction; the baked-in decision resolves the one choice
> that would otherwise block mid-task.

Status: in progress. Implements the decision items of issue
[#176](https://github.com/intact-software-systems/ar-eye-hunter/issues/176).

| Workstream | Status | Branch / PR |
|---|---|---|
| D0 fail-closed `rtc.send.expect` + http result redaction | in review | [#180](https://github.com/intact-software-systems/ar-eye-hunter/pull/180) |
| D1 `wait` absence mode | in review | [#181](https://github.com/intact-software-systems/ar-eye-hunter/pull/181) |
| D2 assert operator extension | not started | — |
| D3 `loop` until-success polling | not started | — |
| D4 capability advertisement + preflight gating | not started | — |
| D5 parity and conformance deepening | not started | — |
| D6 coordinator-evaluated group assertions | not started | — |

Plan evidence base: authored 2026-08-11 after the W1–W8 assertion-coverage
stack landed on `main` at `93483f47` (Branch Release Gate green on
`6f763ddf`, Hetzner Supported Distributed Manifests green on `93483f47`).
The distributed availability analysis behind #176 established that the
runner and the distributed `rallar-bb-test` family are separate execution
stacks: distributed recipes are `RallarBlackBoxTestRecipe.commands[]`
evaluated agent-side by `RallarBlackBoxTestRuntime`, with no path through
`executeBlackBox` and no `compareJson` import anywhere in `rallar-bb-test`.
Revalidate the file/line references below before starting each workstream.

## Why this exists

The runner's recipe corpus can now assert absence, poll until an expectation
holds, apply value comparators and complete-array comparison, check headers,
and bound step latency. The distributed dialect cannot express any of that:

- `wait` matches only `kind/topic/commandId/connection/transport/severity` +
  payload-path `equals|contains|exists` (`types.ts:181-191`); there is no
  absence concept. The composite-conformance "negative" case is a no-peer
  *send failure*, not a non-delivery assertion.
- `assert` has six operators (`equals|notEquals|contains|exists|gte|lte`,
  `runtime.ts:2342-2366`) and its comparison primitive is
  `JSON.stringify` equality (`sameJsonValue`, `runtime.ts:420`). `gte/lte`
  are numbers-only; `notEquals` passes when the path is missing.
- `loop` cannot poll: it aborts on the first child failure
  (`RALLAR_BLACK_BOX_LOOP_CHILD_FAILED`, `runtime.ts:1154-1166`) or, with
  `continueOnFailure: true`, runs every iteration and still succeeds. There
  is no success-exit, no backoff (`intervalMs` is flat).
- `rtc.send` allowlists an `expect` field (`control-protocol.ts:1180-1182`,
  `types.ts:242`) that no agent code ever reads — a recipe carrying it
  validates green and asserts nothing. This is the same vacuous-assertion
  class the W1–W8 stack was written to kill, and it fails **silently**,
  unlike every other gap (the strict `validateKeys` allowlists otherwise
  fail closed on unknown fields).
- `http.request` results already carry a full unfiltered header record
  (`browser-adapter.ts:2356-2363`, `toHeadersRecord` at `:524-530`) — header
  assertions need documentation, not new capture. But the result `value` is
  recorded unredacted; only the mirrored `rallar.bb.http.response` event
  passes the redaction pipeline (`runtime.ts:2715`).

## Design constraints (bind every workstream)

- **Compatibility model.** `schemaVersion` stays `1`. Every addition is an
  optional field or a widened operator enum — "adding optional fields to an
  existing command is compatible" (`schema-and-capabilities.md`). New-operator
  recipes dispatched to old agents fail closed at `validateKeys` with a clear
  unsupported-field error; that is the intended behavior, not a defect. No
  `protocolVersion` bump: the strict equality check at
  `control-protocol.ts:1336/1404` has no negotiation, and the per-agent
  capability block (`RallarBlackBoxControlAgentCapabilities.crdt`,
  `distributed-run.ts:111-125`) is the established precedent for feature
  advertisement — D4 follows it.
- **Aligned-surfaces rule.** Every contract change updates, in the same PR:
  `types.ts` shape, `RALLAR_BLACK_BOX_COMMAND_CAPABILITIES` metadata, the
  command schema branch, at least one validating example, the golden
  compatibility corpus (`fixtures/schema/v1/golden-compatibility-corpus.json`),
  the AI prompt guide + `schema-and-capabilities.md`, and an upgrade note per
  the template in `schema-compatibility-guide.md`. The lockstep tests in
  `packages/tests/shared-test/rallar-bb-test-schema.test.ts` (`:166`, `:298`,
  `:347`) enforce most of this mechanically.
- **Style-gate budgets.** `runtime.ts` (2761), `schema.ts` (2100),
  `control-protocol.ts` (1540), `control-client.ts` (938), and `types.ts`
  (907) are all over the 800-line cap and **none is registered** in
  `docs/repo-code-style-exceptions.md`. The changed-findings gate forbids net
  growth of over-cap files, so new evaluator logic lands in new feature
  modules (`wait-absence.ts`, `assert-value-operators.ts`,
  `loop-until.ts` beside `runtime.ts`) with minimal dispatch wiring offset by
  equivalent extractions under a structural-lineage manifest — the exact
  pattern the W1–W8 stack used on the runner megafiles. Budget this cost into
  every estimate; it dominated the runner work.
- **Redaction.** Every new evidence payload (offending absence event,
  comparator actuals, poll attempt results) passes the runtime redaction
  pipeline before it reaches results, events, failures, or artifacts.
- **Fleet reality.** Hetzner agents rebuild from the repo checkout on every
  rollout (`08-rollout-controller.sh` → `build_rallar_black_box_spa` →
  headless workers restart), so the Hetzner fleet moves atomically with the
  repo. World-fleet agents do not — they are already-running remote agents —
  which is why D4's capability gating is required before checked-in
  world-fleet manifests may use the new operators.
- **Semantics parity.** Where an operator exists in both dialects, its
  semantics match the runner's: absence waits hold the full window and scan
  the whole buffer; polling success is the child expectation passing;
  exhaustion of either bound is a failure carrying the last attempt.

---

## D0 — Fail-closed `rtc.send.expect` + http result redaction (P0, small)

**Serves:** removes the one silent vacuous-assertion path in the distributed
dialect, and closes the unredacted http result gap found during analysis.

**Baked-in decision:** reject `expect` at the network validators only —
remove it from the `rtc.send` allowlist in `control-protocol.ts` and from the
command schema branch, keep the `types.ts:242` field with a comment marking
it in-process-only. `black-box-runner-adapter.ts` bypasses validation
entirely (`runtime.execute` directly, no `validateKeys` on that path), so the
in-process runner adapter keeps working; only control-server-delivered
commands fail closed. For redaction: pass `http.request` result `value`
through the same redaction the mirrored event already gets.

**D0 revalidation (2026-08-11):** the redaction gap does not exist —
`toResult` (`runtime.ts:2476`) already passes every command result `value`
and `error` through the redaction pipeline, with the default key substrings
applying even before any `configure` sets redaction options, at the plan's
own evidence base `93483f47` and on current `main`. D0 therefore proves the
behavior with regression tests
(`rallar-bb-test-http-result-redaction.test.ts`) and documents it instead of
adding a duplicate redaction pass. The fail-closed `expect` half proceeds as
written; the manual-workbench negative snippets stop emitting the vacuous
`expect` blobs so app-generated recipes stay dispatchable.

**Prompt:**

```
In packages/shared-test/rallar-bb-test, make rtc.send.expect fail closed on
the control-protocol path: drop 'expect' from the rtc.send validateKeys
allowlist and the rtc.send schema branch, keep the types.ts field documented
as in-process-adapter-only, and add regression tests proving a
control-dispatched rtc.send with expect is rejected while
black-box-runner-adapter still executes. Separately, redact http.request
result values (headers and body) with the runtime redaction pipeline before
they are recorded, matching the mirrored event. Update the golden corpus
invalid examples and write the upgrade note. Run the rallar-bb-test schema,
control-protocol, and conformance vitest suites plus test:repo-governance.
```

**Done when:** a control-dispatched `rtc.send` carrying `expect` is rejected
with a named validation error; the adapter parity test still passes; http
result headers show redaction placeholders for sensitive names; upgrade note
recorded.

---

## D1 — `wait` absence mode (P0)

**Serves:** fleet-scale negative delivery contracts — "no agent in room A
ever receives room-B frames", the distributed twin of the runner's
`expect.absent` and the highest-value gap.

**Baked-in decision:** an optional `absent: true` field on the existing
`wait` command (no new kind). Semantics mirror the runner: wait the full
window (`timeoutMs`/`deadlineEpochMs`, same 5s default), then scan the whole
event buffer — past events match by design, exactly like positive waits
(`findWaitEvent` walks all of `currentState.events`) — and fail with the
offending event (redacted) if anything matched, succeed otherwise. Failure
code `RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED`. Evaluation lives in a new
`wait-absence.ts` module; `runtime.ts` gains only dispatch lines.

**Prompt:**

```
Add an optional absent: true mode to the rallar-bb-test wait command: hold
the full wait window, then fail with the offending (redacted) event if any
buffered or newly arrived event matches the wait match, succeed otherwise.
Implement in a new wait-absence.ts module with dispatch wiring in runtime.ts
kept net-neutral via extraction under a structural-lineage manifest. Update
types, capability metadata, schema branch, validating example, golden corpus,
prompt guide, and schema-and-capabilities docs; add a composite-conformance
absence case with a deliberately-broken control, plus one checked-in Hetzner
manifest exercising cross-room non-delivery with a same-room positive control
first. Run the schema/conformance/companion suites, test:repo-governance, and
dispatch the manifest through the Hetzner workflow once reviewed.
```

**Done when:** the conformance absence case passes on deterministic local and
browser providers, its broken control fails with the offending event, and the
new manifest passes a real Hetzner dispatch.

**D1 revalidation (2026-08-11):** the checked-in Hetzner manifest cannot
express literal cross-room non-delivery — the Hetzner isolation contract
(`scripts/github-actions/hetzner-run-manifest-scope.mjs`) pins every
`applicationId`/`workspaceId`/`groupId`/`roomId`, state path, and
ensure-group/member request identity in a manifest to one effective group,
and the materializer fails closed on any second room. The shipped extended
manifest `16-rtc-absence-wait-2-agent` therefore proves the strongest
in-contract absence claims: a same-room positive control delivery first,
then absence of leak-probe frames on the same connection and absence of
silent `rallar.bb.rtc.send_failed` diagnostics. A true cross-room manifest
needs an isolation-contract decision (declared secondary rooms) — deferred
to a product call, not taken unilaterally. Cross-topic/cross-scope absence
remains fully expressible in recipes outside the Hetzner materializer (the
conformance cases cover it).

---

## D2 — Assert operator extension (P1)

**Serves:** kills the `JSON.stringify`-equality ceiling: numeric bounds,
string matching, length, and structural containment for distributed
evidence, matching the runner's W3 comparators.

**Baked-in decision:** widen the `assert` operator enum with `gt`, `lt`,
`between` (expected `[low, high]` inclusive), `length` (arrays/strings),
`matches` (regular-expression source), and two structural operators
`matchesShape` / `matchesShapeComplete` implemented by importing
`packages/shared-test/json-compare` (`compatible` and `compatible-complete`
modes — first `json-compare` use inside `rallar-bb-test`, browser-safe).
Existing operator quirks are documented, not changed (`notEquals` passing on
a missing path stays; `gte/lte` stay numbers-only). Evaluation moves to a new
`assert-value-operators.ts`; every failing detail passes redaction.

**Prompt:**

```
Extend the rallar-bb-test assert command with gt, lt, between, length,
matches, matchesShape, and matchesShapeComplete operators, the last two
backed by json-compare's compatible and compatible-complete modes. Implement
in a new assert-value-operators.ts module with net-neutral runtime.ts
dispatch. Update types, capability metadata, schema enum, validating
examples, golden corpus (valid and invalid), prompt guide, and docs; extend
the composite-conformance wait-assert-evidence case to exercise the new
operators including one matchesShapeComplete rejection of an unexpected
array element. Run the schema/conformance suites and test:repo-governance.
```

**Done when:** all new operators evaluate correctly on `lastResult`,
`resultCache.<commandId>`, and recent-evidence roots; an unexpected array
element fails `matchesShapeComplete`; old six-operator recipes are untouched.

---

## D3 — `loop` until-success polling (P1)

**Serves:** the distributed read-your-writes / convergence-poll shape — the
twin of the runner's `http.poll-until` — without hand-unrolled repetition.

**Baked-in decision:** optional `until: 'first-success'` mode plus optional
`backoffMultiplier` on the existing `loop` command. In until mode the loop
runs its children each iteration, exits successfully the first iteration in
which **every** child succeeds, sleeps `intervalMs × backoffMultiplier^n`
between attempts, and fails with
`RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED` (carrying the last iteration's
failure, redacted) when `count`/`durationMs`/deadline bounds exhaust.
`continueOnFailure` is rejected in until mode (contradictory). Existing
loops are untouched; pacing/threshold observability keeps working.

**Prompt:**

```
Add until: 'first-success' polling to the rallar-bb-test loop command with
exponential backoff via an optional backoffMultiplier: exit on the first
iteration whose children all succeed, fail with the last iteration's result
when count/duration bounds exhaust, and reject continueOnFailure in until
mode. Implement the mode in a new loop-until.ts module with net-neutral
runtime.ts wiring. Update types, capability metadata, schema, examples,
golden corpus, prompt guide, and docs; add a conformance case polling an
http.request+assert pair to convergence with a broken control that exhausts.
Run the schema/conformance suites and test:repo-governance.
```

**Done when:** a `[http.request, assert]` loop in until mode converges early
on success, exhausts to a failure carrying the last attempt, and the
composite result tree/pacing observability remains valid for until-mode
loops.

---

## D4 — Capability advertisement + preflight gating (P2)

**Serves:** safe rollout to fleets that do not move atomically with the repo
(world-fleet no-spawn agents): a manifest that needs the new operators must
not be staged onto agents that cannot evaluate them.

**Baked-in decision:** follow the `crdt` capability precedent — agents
advertise an `assertions` block (`absence`, `untilLoop`, `operators: [...]`)
in `RallarBlackBoxControlAgentCapabilities`; the distributed-run staging
preflight scans inline recipes for the new fields/operators and fails
staging (not the run) with a named reason when a targeted agent does not
advertise them. Hetzner flows are unaffected in practice (rollout rebuilds
agents from the checkout before dispatch); world-fleet manifests may adopt
the operators only behind this gate.

**Prompt:**

```
Add an assertions capability block to the rallar-bb-test agent capability
advertisement (absence, untilLoop, operators list), populate it from the
runtime feature set, and teach distributed-run staging preflight to reject
manifests whose inline recipes use absence waits, until loops, or extended
assert operators when a targeted agent does not advertise them, with a named
staging failure reason. Update distributed-run contract docs, the golden
corpus manifest examples, and the control-server OpenAPI examples. Run the
schema, control-protocol, distributed-run, and control-server deno suites
plus test:repo-governance.
```

**Done when:** an old-capability agent causes staging failure with the named
reason for a new-operator manifest, and a capability-complete fleet stages
and runs it; documented in `distributed-run-contract.md`.

---

## D5 — Parity and conformance deepening (P2)

**Serves:** proof that the two dialects agree — today provider-parity
compares only step presence and status (`compareRallarBlackBoxProviderParityReports`
matches by key), not assertion outcomes.

**Baked-in decision:** extend `provider-parity.ts` with outcome rows for the
ported operators — shared fixtures evaluated by both the runner
(`expect.absent`, comparators, `compatible-complete`, `http.poll-until`) and
the bb-test runtime (`wait absent`, extended `assert`, `loop until`), with
pass/fail verdicts compared, not just statuses. Extend the artifact analyzer
(`distributed-artifact-analysis.ts`) and failure-triage vocabulary with the
new failure codes so Hetzner `analysis.json`/`fix-proposal.md` name them.

**Prompt:**

```
Extend the rallar-bb-test provider-parity suite with assertion-outcome
comparisons between the black-box-runner operators and their distributed
twins on shared fixtures (absence, extended operators, complete-array,
polling), and teach distributed-artifact-analysis plus the failure-triage
vocabulary the new failure codes so Hetzner analysis artifacts name them.
Update composite-conformance provider rows and the conformance matrix doc.
Run the parity, conformance, and artifact-analysis suites plus
test:repo-governance.
```

**Done when:** a semantics divergence between the dialects fails the parity
suite, and a synthetic failing distributed run yields an `analysis.json`
naming the new failure code with a usable fix proposal.

---

## D6 — Coordinator-evaluated group assertions (P1)

**Serves:** the assertion altitude neither dialect has: invariants over the
collected evidence of every agent in the shared group. Per-agent asserts can
never state "we all agree" or "no agent saw it"; today those facts are
checked by humans reading artifacts.

**Baked-in decision:** a manifest-level `groupAssertions` block beside
`targetPolicy`/`barrier`, evaluated by the control server's distributed-run
rollup after required recipes and barriers complete — **coordinator-side
only**, so agents are unchanged and D4's capability gate does not apply.
Every assertion reads **one result value from every targeted agent** through
a typed address `{ recipeId, commandId, path }` (the coordinates
`resultCache` and composite result paths already use) and applies value
predicates drawn from the assert operator vocabulary (including D2's
extended operators — which is why D2 must ship its evaluation as pure,
runtime-agnostic functions the control server can import, so agent-side and
coordinator-side predicates cannot drift).

v1 aggregate vocabulary — fixed, strict, deterministic:

- `allMatch` — every participating agent's value satisfies a predicate
  ("every receiver observed exactly 100 messages", "every agent reports the
  expected topology revision", "every result matches the required shape").
- `noneMatch` — no participating agent's value satisfies a predicate ("no
  room-A agent received a room-B frame", "no agent reported an authorization
  failure"). Kept as a named aggregate even though it equals
  `countMatching == 0`: the intent and the diagnostics are clearer.
- `countMatching` with `equals`/`gte`/`lte` — "exactly one agent became
  leader", "at least 45 of 50 received it", "no more than two retried".
  Quorum-style checks are expressed here, against the frozen participant
  denominator — there is **no** generic `minRatio` modifier (its meaning is
  ambiguous for `allEqual`); a separately defined `consensusRatio` aggregate
  may come later if a real need appears.
- `allEqual` — every participating agent contributed the same JSON value,
  using **proper deep equality: object-key-order insensitive, array-order
  sensitive**. Explicitly not `JSON.stringify` equality (the runtime's
  `sameJsonValue` is disqualified), and not `json-compare`'s `exact` mode
  either (its array matching is order-insensitive); D6 ships a small pure
  `deepEqualJson` with exactly these semantics.
- `allEqualWithin` — numeric agreement within an absolute tolerance
  ("replicated counters differ by at most one").
- `sum` (v1.1) — the sum of numeric values satisfies a comparison ("total
  successful deliveries equal the expected fan-out", "aggregate loss is
  zero"). Pull into v1 only if delivery accounting lands in the same cycle.

Authoring rule recorded in the prompt guide: when the expected value is
known, use `allMatch equals X` — `allEqual` alone passes when every agent
agrees on the same *wrong* value; `allEqual` is for values the test cannot
predict, and the two compose ("all equal AND the first one matches X").

**Participation rules — mandatory on every group assertion:**

- The expected participant set is **frozen during target resolution** and
  recorded in the run snapshot; the assertion evaluates against that set.
- Missing, duplicate, or unresolved evidence at the address **fails by
  default** — absence of evidence is never a pass.
- `scope.role` narrows participants to a manifest role; `minParticipants`
  exists only as an explicit, visible relaxation of the frozen set.
- Failure artifacts record a redacted per-agent value table and identify
  both missing and violating agents by agent ID.

**Deferred explicitly** (hard to explain and diagnose; revisit only with a
concrete consumer): arbitrary expression languages, cross-agent temporal
ordering, joins across multiple evidence sources, fairness/distribution
analysis, percentiles and other performance calculations, and set-union /
cross-agent message-ID reconciliation.

**Open product decision (plan owner):** are group assertions exclusively
run-failing *correctness* gates, or may fleet performance/SLO checks also
fail a run? Recommendation: correctness-only in v1 — performance stays in
artifact-analysis thresholds (`performance-thresholds.md`), matching the
repo's "no latency SLOs in gates" doctrine — with a deliberate, per-contract
promotion path later if a specific performance bound becomes an explicit
product contract. Record the resolution here before implementing D6.

**Prompt:**

```
Add a manifest-level groupAssertions block to the rallar-bb-test distributed
run contract, evaluated coordinator-side in the distributed-run rollup after
required recipes and barriers complete: allMatch, noneMatch, countMatching
(equals/gte/lte), allEqual (deep equality: key-order insensitive,
array-order sensitive — a new pure deepEqualJson, not sameJsonValue and not
json-compare exact), and allEqualWithin, with typed sources
{recipeId, commandId, path}, predicates reused as pure functions from D2's
operator module, role scoping, a participant set frozen at target
resolution, and missing/duplicate/unresolved evidence failing by default
(minParticipants only as explicit relaxation). Implement evaluation in a new
distributed-run module (net-neutral wiring in existing over-cap files),
update the manifest schema + golden corpus + distributed-run-contract doc +
control-server OpenAPI examples, emit redacted per-agent value tables naming
missing and violating agents with named failure codes into failures.json and
the artifact analyzer, and add a conformance case per aggregate with a
deliberately-broken control, plus one checked-in Hetzner manifest asserting
allEqual convergence and noneMatch isolation across the fleet. Run the
schema, distributed-run, control-server deno, conformance, and
artifact-analysis suites plus test:repo-governance; dispatch the manifest
through the Hetzner workflow once reviewed.
```

**Done when:** a synthetic run with one disagreeing agent fails `allEqual`
naming that agent; one leaked frame anywhere fails `noneMatch` with the
offending evidence; a missing agent fails by default; `countMatching`
expresses the quorum cases against the frozen denominator; and the Hetzner
manifest passes a real dispatch.

## Sequencing and guardrails

| # | Depends on | Notes |
|---|---|---|
| D0 | — | ship first; pure hardening |
| D1 | — | independent of D0 |
| D2 | — | independent; introduces the json-compare dependency |
| D3 | — | independent |
| D4 | D1–D3 shapes | capability names must match shipped fields |
| D5 | D1–D3 | parity needs both sides implemented |
| D6 | D2's pure operator module + D1–D3 evidence shapes | coordinator-side only; old agents work unchanged, so D4's gate does not apply; one open product decision recorded in its section |

- One capability per PR; every PR carries its schema branch, capability
  metadata, validating example, corpus update, docs, and upgrade note — the
  lockstep tests make omissions fail.
- Never grow the five over-cap files net; land logic in new modules with
  lineage manifests, or register a deliberate exception with rationale.
- The strict validators stay fail-closed; no permissive fallbacks, no
  `additionalProperties: true` anywhere in the command schemas.
- No secrets in manifests, prompts, or workflow inputs; new evidence passes
  redaction before artifacts.
- Validation floor per PR: `rallar-bb-test-schema`, `composite-conformance`,
  `control-protocol`, and `companion-coverage` vitest suites; control-server
  `deno task test` when the protocol changes; `test:repo-governance`;
  `hetzner-distributed-manifests` vitest when manifests change; and one real
  **Run Hetzner Distributed Recipe** dispatch for D1's manifest before the
  plan is complete.
- Rollout order for adopting operators in checked-in manifests: Hetzner
  manifests only after `08-rollout-controller.sh` + worker restart paths are
  proven on the new build; world-fleet manifests only after D4's gate exists.
