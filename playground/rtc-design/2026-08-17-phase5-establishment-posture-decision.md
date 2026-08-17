# Phase 5 Decision — Establishment Posture

Status: **the ruling already exists; this is the evidence behind it.**

`2026-08-08-group-lifecycle-and-policy-model.md` recorded decision 2 as a product-owner decision on
2026-08-08: threshold-based **observed convergence is the default** activation criterion, with the
per-edge confirm-or-fail batch machinery retained as the establishment-phase implementation and the
strict-policy option, surfaced as `ActivationCriterion.strictConfirmation`. That decision was taken
on design judgment before Phases 3 and 4 had been measured.

This brief was first drafted as a request for a ruling. It is not one. What it supplies is the
Phase 0–4 measurement evidence that the earlier decision was made without, and a ground-truth audit
of what is actually implemented. Both support the recorded decision.

**What remains outstanding is the recording.** The lifecycle document says the activation design
"records this at its Phase 5 decision point ... to be reflected there when that document is next
revised." That revision has not happened: `plans/rallar-distributed-group-rtc-activation-design.md`
still presents the posture as an open decision.

## What is being decided

Whether **per-edge confirmations are the default or the exception** when a group establishes its RTC
overlay.

- **Observed convergence.** The server publishes the planned overlay as the accepted, desired
  topology. Browsers converge toward it under the existing budgeted/retained/damped reconciler. The
  server derives activation status from observed edge state — RTT and liveness reports — against a
  readiness threshold.
- **Per-edge command/confirm.** The server keeps the planned topology out of the accepted store,
  commands each edge through `group_batch` and `ASYNC_REMOTE_QUEUE`, collects per-edge confirmations,
  and promotes the plan to accepted only on an acceptable terminal batch result.

This is not a choice about whether `group_batch` exists. Both options keep it as the plan, audit and
readiness record. What is being decided is whether **per-edge confirmation gates promotion**.

## Ground truth in the code today

The decision is often framed as "keep the design we already have, or replace it." That framing is
wrong, and it is the single most important input here:

| Component | Status |
| --- | --- |
| `group_batch` | **Not implemented.** No table, no type, no reference in `packages/**` or `apps/**`. |
| `ASYNC_REMOTE_QUEUE` | **Not implemented.** Same. |
| RTC activation status projection (`INITIALISING` / `RECONFIGURING` / `ACTIVE` / `DEGRADED`) | **Not implemented.** No occurrence of `INITIALISING` anywhere in the codebase. |
| Retained-peer machinery in `WebRtcGroupManager` | **Exists.** `retainedPeerConnections`, `retainedOrder`, `disconnectExpiredRetainedPeers`, budget-preserving eviction. |
| RTT / liveness reporting | **Exists.** `RttMeasurementInfo` flows through the RTT topic and refinement service. |

The activation design is 1,638 lines of specification with **zero** implementation. Choosing per-edge
confirm means building Flows 1–7 plus the abort sweep, the five-lane work table, conditional remote
transitions, retry/timeout and capacity predicates from scratch. Choosing observed convergence means
building the status projection and a readiness threshold over signals that already flow.

Neither option is the status quo. One is markedly more construction than the other.

## How Phases 0–4 changed the economics

The activation design was written when publishing a desired overlay was expensive and unstable.
Phases 1–4 removed both objections — which is precisely why the plan defers this decision to now.

**Publishing the desired topology is now cheap.** Phase 3 took the N=50 burst from 254,951,157 bytes
to 13.2 MB under `delta-primary`, a 19.3× reduction, and `delta-primary` is now the default since
#231. Snapshot traffic had been 96.1% of baseline egress at N=50; it is gone.

**Republishing is now rare.** Phase 2 collapsed burst recomputes to 1–5 executed/published, and an
idle formed group produces 0 expansions, 0 broadcasts and 0 recomputes.

**Republishing is now stable.** This is the decisive one. Before Phase 4, planning was a function of
*arrival order*, not of the member set: a same-set reorder at N=50 churned 180 edges, about 93% of
the combined edge slots of the two plans, and the tree tier full-rebuilt on every join in the 5–15
band. Observed convergence against a plan that reshuffles on reorder would have thrashed
indefinitely. M6 made planning a function of the member set, which is what makes "publish desired and
let them converge" terminate at all.

**The flap loop that would prevent settling is closed.** Every teardown used to reset the peer's
connection-attempt budget. M11 closed that reset-on-removal hazard in Phase 4.

Read together: the four preconditions observed convergence needs — cheap publication, rare
publication, stable plans, and non-resetting retry budgets — were each delivered by a different
landed phase. That is not a coincidence; it is what the plan meant by "the substrate the activation
design assumed exists."

## Option A — observed convergence as default

**What it buys.** Far less machinery to build, and one fewer distributed-consistency surface. It also
**eliminates two mandatory browser-side rules**: the design requires commanded-edge retention and
command-origin validation *only because* it deliberately keeps the planned topology out of the
accepted store. If planned equals accepted, there is no divergence window, so there is nothing to
retain against and no command channel to authenticate. The design states plainly that without those
rules "the reconciler closes commanded connections on the next presence-triggered reconcile and
activation cannot complete" — a failure mode Option A does not have.

**What it costs.** Readiness becomes a threshold over reported state rather than a completion signal.
A group can sit in `DEGRADED` without a precise per-edge reason. There is no proof that a specific
edge was attempted and failed, only that the group did not reach threshold. Establishment pacing is
whatever the browser's existing dial budget provides, not a server-controlled rate.

## Option B — per-edge command/confirm as default

**What it buys.** A hard per-edge audit trail; server-controlled establishment pacing; a deterministic
completion signal; and `PARTIAL` promotion gated on proving the confirmed edges still satisfy the
configured connectivity and degree invariants.

**What it costs.** The full construction listed above, plus the two mandatory browser-side rules and
the divergence window they exist to manage. Every one of those is a new place for the system to get
stuck between planned and accepted.

## Assessment against the recorded decision

The evidence supports decision 2 as recorded: **Option A as the default, Option B as an opt-in policy
preset** for groups needing a per-edge audit trail or strict establishment pacing. The lifecycle
model already expresses exactly that shape as `ActivationCriterion.strictConfirmation`, defaulting to
`false`.

The substantive argument is not "less code." It is that Option B's hardest requirements are
consequences of its own central choice. The retention rule, the origin-validation rule, the
divergence window, and the stale-promotion handling all exist because planned topology is withheld
from the accepted store. Paying that complexity is right when per-edge auditability is the goal, and
wrong when it is not.

The `group-lifecycle-and-policy-model.md` document already frames activation criteria as declarative
policy presets, so "confirm-gated establishment" fits as a preset without a second code path.

## What the ruling unblocks

Either way, Phase 5 then implements: the formation window (hold planning while `INITIALISING` until
join-rate quiescence or a window cap, plan once, publish epoch 1), and the activation status
projection. The ruling determines whether epoch-1 publication is confirmation-gated.

Validation bar is unchanged: time-to-usable ≈ immediate, time-to-epoch-1 ≈ window + one plan, total
recomputes during formation ≈ 1–3, convergence to epoch 1 across all browsers, and a Hetzner
small-tier distributed manifest.

## Questions I cannot answer for you

1. **Is there a product or compliance requirement for a per-edge audit trail?** If yes, Option B is
   the default regardless of cost, and this brief is moot.
2. **What readiness threshold makes a group `ACTIVE`?** Option A needs a number — all planned edges,
   a fraction, or connectivity-invariant satisfaction. The invariant check already exists for
   Option B's `PARTIAL` path and could serve both.
3. **Does establishment pacing matter at the target scale?** Option A inherits the browser dial
   budget. If N=50 bursts need server-side pacing beyond that, the case for Option B strengthens.
