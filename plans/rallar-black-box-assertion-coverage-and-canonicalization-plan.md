# Rallar Black-Box Assertion Coverage and Canonicalization Plan

> **For Codex/Claude:** Execute each workstream as its own PR with
> `rallar-repo:publishing-plan-progress`, `rallar-repo:rallar-code-writing`,
> and `rallar-repo:rallar-testing`. The paste-able prompt under each workstream
> is the intended starting instruction; the baked-in decision resolves the one
> choice that would otherwise block mid-task. Keep the draft PR and this record
> current after every checkpoint.

Status: in execution as a stacked PR series based on
`fix/api-v1-blackbox-authz-presence-findings` (PR #161, unmerged base).

| Workstream | Status | Branch / PR |
|---|---|---|
| W1 `expect.absent` | implemented; in review | `codex/black-box-w1-ws-rtc-absent` |
| W2 `poll-until` | runner capability implemented; recipe rewrite blocked on decision | `codex/black-box-w2-poll-until` |
| W3 comparators + `compatible-complete` | implemented; in review | `codex/black-box-w3-comparators` |
| W4 pure-API recipes | implemented; in review | `codex/black-box-w4-pure-api-recipes` |
| W5 `expect.headers` | implemented; in review | `codex/black-box-w5-expect-headers` |
| W6 `expect.maxDurationMs` | implemented; in review | `codex/black-box-w6-max-duration` |
| W7 observability-routed evidence plan | plan written; awaiting review | `codex/black-box-w7-evidence-endpoint-plan` |
| W8 recipe tiering | implemented; in review | `codex/black-box-w8-recipe-tiering` |

Base revalidation 2026-08-11: origin/main moved to e921c460 (#160, #162) while
the stack bases on 7c0aaf5d (PR #161). #162 is perf-script-only — no plan
impact. #160 rewrote `api-v1-state-topology-churn.json` (causal-convergence
fence) — material for W2 only; the W2 branch cherry-picks #160 so the
poll-until rewrite builds on the fenced recipe and never weakens it.

Plan evidence base: authored 2026-08-11 as the follow-on to the four confirmed
black-box findings fixed in PR
[#161](https://github.com/intact-software-systems/ar-eye-hunter/pull/161)
(CRDT catch-up authz bypass, CRDT admin 403→400, vacuous
`intermediateMutationIntents` assertion, presence-lease pinning). That PR fixed
the concrete defects; this plan addresses the two systemic gaps behind them:
(1) the runner cannot express whole classes of assertion, and (2) the flagship
convergence gates assert on internal persistence rather than the observable
contract. Revalidate paths, the runner's current operator set, and the recipe
matrix before starting each workstream.

## Why this exists

- The runner's step-level assertion surface is `compareJson` containment plus
  `monotonicPaths` and nothing else. There is **no way to assert absence** (a
  message did not arrive, a field is not present), no step-level numeric/string
  comparators, and no completeness check on arrays — the last of which is why
  `intermediateMutationIntents: []` silently asserted nothing.
- The `state-write-evidence` gates reach directly into Postgres
  (`resource_inbox`, outbox effect kinds, receipts, `next_ts`) and scrape server
  logs. They are valuable distributed-correctness proofs, but they are gray/
  white-box, brittle to persistence refactors, and they substitute internal
  state for the client-visible contract they are meant to protect.

## Sequencing

| # | Workstream | Priority | Depends on |
|---|---|---|---|
| W1 | WS/RTC negative expectation (`expect.absent`) | P0 | — |
| W2 | Generic `poll-until` step | P0 | — |
| W3 | Step-level value comparators + complete-array mode | P1 | — |
| W4 | Pure-API strengthening recipes | P1 | W1, W3 |
| W5 | Header-assertion operator | P2 | — |
| W6 | Per-step latency bound | P2 | — |
| W7 | Observability-routed evidence (design first) | P1-design | — |
| W8 | Recipe-corpus tiering/naming | P3 | — |

W1–W3, W5, W6 are independent runner-capability PRs and can run in parallel
sessions/worktrees. W4 consumes W1 and W3, so land those first. W7 is a
design/plan pass, not code. Recommended first two: **W1 and W2**.

## Guardrails (apply to every workstream)

- One capability per PR. Each ships with: the `schema.ts` shape, the real
  dispatch in `execute-black-box.ts` (schema is permissive and is not the source
  of truth), a unit test in `packages/tests/shared-test/`, at least one recipe
  that exercises it, and `npm run test:repo-governance` if the recipe matrix
  changes.
- Never weaken the medium-scale gate constants, operation matrix, or the
  convergence assertions to make a change pass (CLAUDE.md).
- Follow the existing operator patterns in `execute-black-box.ts`; do not invent
  a parallel assertion path.
- Validate with `npm run test:api-v1:black-box:memory` locally; the Postgres
  cluster gates run in the Branch Release Gate.

---

## W1 — WS/RTC negative expectation (`expect.absent`)

**Serves:** cross-scope non-delivery (same `groupId` in two applications),
cross-principal client-state non-leak, the damped zero-frame lease-renewal
contract (#152), and fixed-audience "a late joiner must not receive the prior
publication." All are inexpressible today.

**Baked-in decision:** always wait the full `withinMs` window (simple, fixed
cost); pass if nothing matched, fail with the offending frame if something did.
No sentinel fast-path in v1.

**Prompt:**

```
Add an `expect.absent` negative expectation to `ws.wait` (and the RTC wait
dispatch) in the black-box runner: a recipe asserts that no message matching a
partial matcher arrives within `withinMs`. Wait the full window; pass if nothing
matched, fail and report the offending frame if something did. Follow the
existing `expect.messages` dispatch in execute-black-box.ts. Add a unit test in
packages/tests/shared-test/, and add one api-v1 recipe proving that a group
mutation in application A is NOT delivered over WS to a connected session in
application B that shares the same groupId string. Run the memory black-box and
governance gates.
```

**Done when:** the isolation recipe passes, a deliberately-broken control
(same-scope delivery) fails, and the operator is documented in the recipe guide.

---

## W2 — Generic `poll-until` step

**Serves:** removes the 2k–9k-line hand-unrolled `nonBlockingFailure` poll
rounds in the convergence recipes and the flakiness they carry; it is the
runner's documented open gap.

**Baked-in decision:** bound by both max-attempts and max-duration, exponential
backoff, reusing the existing `request.retry` field names. Success is the step's
own `expect` passing; exhaustion is a failure.

**Prompt:**

```
Add a `poll-until` step to the black-box runner: repeat an HTTP request until
its `expect` passes or max-attempts/max-duration is reached, exponential
backoff, reusing the existing retry field names. Add a unit test in
packages/tests/shared-test/. Then rewrite api-v1-state-topology-churn's
hand-unrolled nonBlockingFailure poll rounds to use it, changing nothing about
what is asserted. Do not weaken the convergence gate. Run the memory black-box
and governance gates.
```

**Done when:** the rewritten recipe asserts an identical final state to before
and is materially shorter; a new recipe uses `poll-until` for read-your-writes
(see W4).

**Execution correction (2026-08-11):** the premise misnamed the target. As of
#160, `api-v1-state-topology-churn.json` contains **zero** `nonBlockingFailure`
poll rounds — it already uses revision-floor reads with transport `retry` plus
one loop-based poll, and its structure is pinned by
`api-v1-three-server-recipe-semantics.test.ts`. The hand-unrolled rounds live in
`api-v1-state-medium-scale-churn.json` (5 rounds) and
`api-v1-state-write-convergence.json` (5 rounds), and every one of them is a
`parallel` step fanning over 3–15 groups — outside what a single-request
`poll-until` can express, and both files are protected convergence gates. The
W2 PR therefore ships the runner capability, unit tests, and documentation; no
convergence recipe was rewritten. Rewriting those rounds needs either a
group-scoped poll operator or explicit approval to restructure the gates —
flagged to the plan owner as an open decision.

---

## W3 — Step-level value comparators + complete-array mode

**Serves:** fixes the vacuous-assertion class at the source — numeric/string
comparators on captured or response values, and a completeness check that flags
unexpected array elements without full-document `exact`.

**Baked-in decision:** add comparators to the ASSERT step (`gt`/`gte`/`lt`/
`lte`/`between`/`length`, plus string `contains`/`matches`). Add a new
comparison mode `compatible-complete` (all expected present AND no unexpected
elements) rather than a per-field flag, so existing recipes are untouched.

**Prompt:**

```
Extend the black-box ASSERT step with value comparators (gt, gte, lt, lte,
between, length, string contains, string matches) operating on the resolved
`actual`, following the existing monotonicPaths pattern in execute-black-box.ts.
Separately add a new CompareJson mode `compatible-complete` that requires all
expected elements present AND rejects unexpected array elements, without the
full-document strictness of `exact`. Add unit tests in packages/tests/, and
tighten the five app-inbox evidence recipes' single-element member/session
expectations to use `compatible-complete`. Run governance + memory black-box.
```

**Done when:** an array with an unexpected extra element fails
`compatible-complete`; the tightened recipes still pass on correct data.

**Execution correction (2026-08-11):** of the five app-inbox evidence recipes,
only `api-v1-state-write-convergence` has blocking single-element
member/session expectations (`activateOwnerMembership`,
`reconnectReusedSession`, `readPostExpiryGeneration` — all three tightened to
`compatible-complete`). `api-v1-admin-operations`, `api-v1-auth-session`, and
`api-v1-crdt-app-inbox` assert evidence fields, not member/session arrays —
nothing to tighten. `api-v1-state-medium-scale-churn`'s 50 single-element
`activeSessions` expects all live inside the non-blocking poll rounds of the
protected medium-scale gate and were left untouched (same open decision as
W2's poll-round rewrite).

---

## W4 — Pure-API strengthening recipes (depends on W1, W3)

**Serves:** validate the observable contract directly instead of inferring it
from the database — the gaps that exist precisely because Tier-2 gates lean on
SQL evidence.

**Baked-in decision:** new no-browser recipes in the `api-v1-black-box-recipes`
profile; no new server code. Register in the matrix + governance list.

**Prompt:**

```
Add api-v1 black-box recipes for observable-contract gaps, using expect.absent
(W1), poll-until (W2), and compatible-complete (W3): (a) read-your-writes — after
a presence connect, the receipt's causalRevision floor read must show the session
in activeSessions, not just satisfy the floor; (b) cross-principal isolation —
principal B connected in the same workspace but no shared group must NOT receive
A's client-state snapshot over WS; (c) negative-shape — a member reading group
stats must NOT receive owner-only fields. Register in recipe-matrix + governance.
Run governance and the memory black-box.
```

**Done when:** all three pass, and each has a control that fails when the
guarantee is violated.

---

## W5 — Header-assertion operator (small)

**Serves:** removes the capture-then-ASSERT contortion in
`state-read-convergence`; makes `Rallar-State-*` / `Cache-Control` assertions
first-class.

**Prompt:**

```
Add an `expect.headers` operator to the HTTP step in the black-box runner
(exact and type-token matching on named response headers, case-insensitive
names), following the existing expect.body dispatch. Add a unit test, and
simplify api-v1-state-read-convergence's header checks to use it without
changing what is asserted. Run governance + memory black-box.
```

---

## W6 — Per-step latency bound (small)

**Serves:** per-step timing assertions (`durationMs` is captured but only
assertable in aggregate today).

**Prompt:**

```
Add `expect.maxDurationMs` to the black-box HTTP/WS steps: fail the step if its
measured durationMs exceeds the bound. Add a unit test. Do not add any latency
SLO to a convergence gate. Run governance + memory black-box.
```

---

## W7 — Observability-routed evidence (design first, plan-only)

**Serves:** converts the Tier-2 gray-box gates to black-box by gathering
evidence through the API instead of raw SQL, removing persistence coupling. The
admin `explain/*` endpoints are the precedent.

This workstream is a **plan, not code**. It touches product surface (endpoint
contract, auth, what internal facts to expose) and must be reviewed before
implementation.

**Prompt:**

```
Write a plan in plans/ for exposing app-inbox evidence — persisted intermediate-
intent count, receipt/outbox identities, fairness lane, overdue-recovery status —
through an admin/debug endpoint, so the state-write-evidence gates can assert via
the API instead of reading resource_inbox/outbox directly. Cover the endpoint
contract, auth model, which facts are safe to expose, and a migration path for
the existing evidence recipes. Plan only; no code.
```

**Done when:** the plan is reviewed and either scheduled or explicitly deferred
with a recorded reason.

---

## W8 — Recipe-corpus tiering/naming (cheap)

**Serves:** name the three archetypes honestly so a Tier-2 convergence proof is
not mistaken for a Tier-1 API black-box test, and so future authors know which
kind they are writing.

**Prompt:**

```
Introduce an explicit tier label in the recipe matrix / tests README for the
api-v1 recipes: tier-1 black-box API (request/response/WS), tier-2 convergence/
durability proof (SQL evidence), tier-3 coordinator proof. Classify every
existing entry, and add a one-line convention note. No behavior change. Run
governance.
```
