# RTC Design — Group Formation Track

Working documents for how a Rallar group forms at scale: what the current
system does under a join burst, which mechanisms can fix it, and the staged
implementation plan.

| Document                                                                                                                             | Purpose                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [2026-08-08-group-formation-storm-scenarios.md](2026-08-08-group-formation-storm-scenarios.md)                                       | Evidence record: what happens today when 50 clients join within a few seconds (scenarios S1–S7, amplification map, ranked root causes, with file:line evidence).                                                                                                                                                                   |
| [2026-08-08-group-formation-mechanism-catalog.md](2026-08-08-group-formation-mechanism-catalog.md)                                   | Mechanisms/algorithms/protocols that address the scenarios (M-IDs), what already exists in Rallar for each, and the scenario→mechanism matrix.                                                                                                                                                                                     |
| [2026-08-08-group-formation-implementation-plan.md](2026-08-08-group-formation-implementation-plan.md)                               | Staged plan evolving existing Rallar (groups, clients, auth, topologies) toward convergent, fault-tolerant, permissive/optimistic group formation.                                                                                                                                                                                 |
| [2026-08-08-group-lifecycle-and-policy-model.md](2026-08-08-group-lifecycle-and-policy-model.md)                                     | Control plane: explicit formation lifecycle (FORMING/ESTABLISHING/ACTIVE), manager roles, and declarative policies (admission, activation criterion, data gating) as presets over the mechanisms — plus the policy-driven test scenario matrix.                                                                                    |
| [2026-08-08-rallar-system-planes-catalog.md](2026-08-08-rallar-system-planes-catalog.md)                                             | Beyond formation: the system planes a distributed group communication system needs (P1–P14 — time, room log, repair, failure detection, flow control, agreement-lite, interest management, trust, evolution, governance, operational truth, and more), each with mechanisms, Rallar seeds, scenario families, and a priority view. |
| [baselines/2026-08-08-formation-burst-baseline.md](baselines/2026-08-08-formation-burst-baseline.md)                                 | Phase 0 measured baseline: the storm quantities recorded by the `group-formation` admin metrics family and the 6/20/50 formation-burst black-box tiers on memory and Postgres backends — the "before" numbers for Phases 1+.                                                                                                       |
| [baselines/2026-08-09-phase1-overlay-precedence-results.md](baselines/2026-08-09-phase1-overlay-precedence-results.md)               | Phase 1 measured results: server-overlay adoption and bounded outbound dials at the 6/20/50 tiers (in-process simulation + live three-browser diagnostics), plus the recipe reruns showing server-side storm quantities unchanged vs the Phase 0 baseline.                                                                         |
| [baselines/2026-08-11-phase2-server-damping-results.md](baselines/2026-08-11-phase2-server-damping-results.md)                       | Phase 2 measured results: coalesced recomputes, the topology-input fingerprint change gate, heartbeat/presence separation, and scoped state-sync audiences — idle groups at ≈ 0 recomputes/broadcasts, burst recomputes in low single digits.                                                                                      |
| [baselines/2026-08-13-phase3-delta-dissemination-results.md](baselines/2026-08-13-phase3-delta-dissemination-results.md)             | Phase 3 measured results: delta envelopes, overlay read-through, and join admission — N=50 burst egress 255 MB → 13.2 MB under `delta-primary` (19.3×), with the dual-emit divergence oracle and the convergence/perf gates re-verified.                                                                                           |
| [baselines/2026-08-15-phase4-stable-topology-evolution-results.md](baselines/2026-08-15-phase4-stable-topology-evolution-results.md) | Phase 4 baseline + results: planner edge churn per membership change (join/leave/reorder), the formed-N=50 churn-stream recipe, and the stable-topology-evolution candidate evidence (M6/M8/M11/M9).                                                                                                                               |

Relationship to other documents:

- `plans/rallar-distributed-group-rtc-activation-design.md` (PR #83) designs
  server-directed edge activation with batches. The implementation plan here
  supplies the substrate that design assumes (damping, overlay precedence,
  delta dissemination, topology stability) and names the decision point where
  the two reconcile (Phase 5).
- `docs/rallar-convergent-state-and-rtc-topology.md` remains the
  architecture authority for causal revisions, durable publications, and
  multi-server fanout.

Status: Phases 0–3 (storm metrics + baseline, overlay precedence + bounded
bootstrap, server damping, delta dissemination + read-through + admission)
are merged. Phase 4 (stable topology evolution) is in progress; phases 5–6
remain planning documents.
