# Scenario matrix gap analysis (slice 6)

2026-08-20. Maps the ten named scenarios of `2026-08-08-group-lifecycle-and-policy-model.md`
(§ Test scenario matrix) against the black-box recipe corpus as it stands after slice 5
(main `637c8a90`). Method: one adversarial audit per scenario — a core assertion counts as
covered only where an actual recipe step pins it; a thematically related recipe does not count.
Everything here is api-v1 black-box recipes (JSON HTTP/WS scripts run by
`packages/shared-test/black-box-runner` against the real server — no browsers; a "50-client"
recipe is 50 identities and WS connections held by one runner process). The distributed/Hetzner
lane is untouched by slice 6 and still has no lifecycle artifact.

## Verdicts

| Scenario               | Verdict   | Missing pins                                                                                                                           |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `closed-after-active`  | covered   | — (deny outside FORMING, admit during FORMING, below-floor reopen all pinned)                                                          |
| `deadline-join`        | partial   | Join-before-T admitted (only the deny-after-T half is pinned)                                                                          |
| `capacity-join`        | partial   | Admit-under-capacity; N+1 deny at a non-degenerate N; leave-under-N reopens (no pin anywhere)                                          |
| `leader-gated-join`    | partial   | Park while ACTIVE (all park pins fire in FORMING); `member-joined` event on grant; non-manager grant → `forbidden-role`                |
| `optimistic-baseline`  | partial   | Nothing sends `preset: 'optimistic'`; absent ≡ explicit-default equivalence unpinned                                                   |
| `threshold-activation` | partial   | Activation via real fractional readiness (existing pin rides the zero-edge rate-1 case); `activated-degraded` at deadline; scale tiers |
| `data-gating`          | partial   | `allowed`-during-FORMING flow; absent-policy-during-FORMING flow; **CRDT exemption has no recipe pin at all**                          |
| `manager-succession`   | partial   | Zero-manager mid-ESTABLISHING (all zero-manager legs sit in FORMING); departure via voluntary leave; `selection: 'none'` never sent    |
| `strict-confirmation`  | uncovered | No recipe sends `strictConfirmation: true`                                                                                             |
| `managed-phased`       | partial   | Zero RTC signaling over WS during FORMING; typed body codes on the 403s; the non-manager leg aims at the wrong path (below)            |

## Weak pins discovered

- `bobCannotStartEstablishment` (`api-v1-group-lifecycle-transitions.json`) exercises the
  `member-not-active` non-member path, not the manager gate: that Bob never created client state
  or joined. The manager-gate pin needs Bob joined and active, then asserting `forbidden-role`.
- Both non-manager 403s (`ownerCannotEstablishPastAssignedManager`,
  `zeroManagerBlocksOnlyManagerActions`) pin status only; the body `code` (`forbidden-role` vs
  `lifecycle-manager-unavailable`) is what distinguishes the two denials and is unpinned.
- Grant-admits is pinned on the snapshot but not on the event stream: no recipe asserts the
  `member-joined` event a grant emits.

## Cross-cutting findings

- **WS denial opacity (drift).** `toPolicyDeniedDecision` maps every policy denial to the
  generic NACK reason; `group-data-blocked-until-active` and the admission codes are typed on
  the HTTP surface only. Decision 6.2 makes the generic NACK the pinned contract.
- **Tier wiring.** The burst recipes are exactly the doc's ladder — small = 6 clients,
  medium = 20, large = 50 (+ churn-large at 50) — but every policy-driven recipe runs once at
  2–4 principals, and the seven lifecycle recipes run only in the Postgres cluster profile;
  the memory profile (the fast dev loop) runs none of them.
- **No-policy parity is unpinned.** `createGroupWithoutLifecyclePolicy` asserts only 201.
  In v1 a policy-absent create resolves to the optimistic preset
  (`createDefaultGroupLifecyclePolicy` → `resolveGroupLifecyclePolicyPreset('optimistic')`),
  so the acceptance property "no policy document behaves exactly as on main" is properly
  pinned as absent ≡ explicit-optimistic equivalence, once (decision 6.1).
- **Preset coverage is half the vocabulary.** Recipes send only `managed` (and, after 6b,
  `optimistic`); `match` and `drop-in-social` are never sent by any recipe, although they are
  the composed products applications pick. `match` composes manager-approval admission,
  blocked-until-active data, and threshold activation with the `minimumViableRate` floor —
  the fullest single exercise of the control plane.
- **Policy-validity rejections are untyped on the wire.** Verified empirically during 6a:
  a create with `strictConfirmation: true` (or `selection: 'none'` + manager initiator)
  returns `400 {"error": "App inbox command is malformed", "code":
  "app-inbox-malformed-command"}` — the issue codes (`strict-confirmation-unsupported`,
  `manager-initiator-without-manager`) and the "not coherent" message exist only inside the
  mutation compute and never reach the HTTP response. The 6a recipes pin this current
  contract plus a not-persisted read-back (404). Whether the HTTP surface should carry the
  typed issue list is an open API-shape question, the HTTP twin of the WS NACK opacity in
  decision 6.2.
- **Scale semantics.** Fractional readiness only exists with enough planned edges: N=20 is
  ~190 mesh edges (fractional band expressible), N=50 is ~1,225 — the quadratic planned-edge
  surface where a readiness-bookkeeping cliff would show. This is why the managed variants
  land at both upper tiers (decision 6.3).

## 6b execution findings (2026-08-20)

Building the managed threshold bursts surfaced three facts the fixed-size recipes could not:

- **Planned mesh edges grow linearly, not quadratically.** The planner's mesh is k-regular
  (`meshParamK` default 2, with rendezvous fill): at 20 sessions the plan carried 37 edges,
  not ~190. Decision 6.3's "quadratic planned-edge surface (~1,225)" rationale was wrong
  about the planner; the tiers still exercise planning, acceptance, and readiness
  bookkeeping at 20/50 sessions.
- **Write-side RTT acceptance ignored the per-group degree limit** (fixed in 6b). Planning
  and the read-side readiness filter honour the per-group topology config, but acceptance
  admitted reports against the global default (5) — so for a group configured above it,
  accepted evidence could never cover the plan, and coverage stalled nondeterministically
  (observed 19–29 of 37 edges across runs). Both acceptance paths now resolve the limit
  exactly as the read side does — the group's effective topology config under the server
  reporting default — in the compositions (api-v1's durable policy inputs; the memory
  path via a `readGroupRttReportingDegreeLimit` hook wired from the topology management
  service). An explicitly configured `rttReportingDegreeLimit` still wins over any
  structural limit, which a first fix at the policy layer (overriding with the planned
  snapshot's stamped limit) got wrong and an existing topic test caught.
- **The managed burst tiers are opt-in, like the optimistic large tier.** The first CI run
  placed the medium tier in the `api-v1-black-box` profile, which the Release Gate also runs
  against Postgres on shared servers. There the recipe exposed two limits: the formation
  timer's deadline evaluation queues behind the RTT mutation backlog on a loaded runner
  (activation never evaluated inside the poll window), and one RTT mutation exhausted its
  20 optimistic-retry attempts under all-pairs endpoint contention — a single terminal
  completion that broke the _unrelated_ `api-v1-admin-operations` recipe asserting the
  shared `atomicCompletionFailures` counter is zero. A synthetic worst-case burst cannot
  share a server with recipes asserting a clean evidence counter, so both managed tiers
  live in `api-v1-black-box-formation-large` (the opt-in profile that already holds
  burst-large and churn-large). The attempt-20 exhaustion under 19-writer endpoint
  contention is noted as an observed retry-schedule limit, not fixed here.
- **The lifecycle recipes moved from the cluster profile to the memory profiles, not into
  both.** The Postgres CI job runs the `api-v1-black-box` profile and then the cluster
  profile against the same servers with one shared runId — a recipe in both profiles
  replays its requestIds with fresh login sessions and dies on app-inbox idempotency
  conflicts (409). Postgres coverage now comes from the `api-v1-black-box` phase itself,
  which that job already runs; the cluster profile keeps the genuinely multi-node recipes.
- **Threshold activation between deadline checks rides the refinement gate.** The criterion
  is petitioned by RTT-triggered topology work, which the refinement gate debounces under
  burst traffic — so a group whose evidence crosses the threshold mid-burst can sit ready
  until the deadline evaluation activates it (`activated`, not degraded, since the rate met
  `successRate`). The managed burst recipes align their deadlines inside the poll window
  and pin the recorded outcome; tightening the evidence-leg latency is a possible follow-up,
  not a v1 defect. Live `readiness` after activation legitimately decays to 0 as evidence
  ages past the 60s freshness window — the durable truth is `lastFormationOutcome`.

## Decisions

Recorded as decisions 6.1–6.4 in
`2026-08-17-group-lifecycle-control-plane-implementation-plan.md` (slice 6 planning table):
preset-labeled recipes as the organizing principle with the absent ≡ default equivalence pin
(6.1), the generic WS NACK as the pinned contract (6.2), managed burst variants at 20 and 50
plus memory-profile inclusion of single-server lifecycle recipes (6.3), and the 6a/6b/6c
delivery split (6.4).
