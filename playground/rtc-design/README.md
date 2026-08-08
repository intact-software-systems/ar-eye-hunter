# RTC Design — Group Formation Track

Working documents for how a Rallar group forms at scale: what the current
system does under a join burst, which mechanisms can fix it, and the staged
implementation plan.

| Document                                                                                               | Purpose                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [2026-08-08-group-formation-storm-scenarios.md](2026-08-08-group-formation-storm-scenarios.md)         | Evidence record: what happens today when 50 clients join within a few seconds (scenarios S1–S7, amplification map, ranked root causes, with file:line evidence). |
| [2026-08-08-group-formation-mechanism-catalog.md](2026-08-08-group-formation-mechanism-catalog.md)     | Mechanisms/algorithms/protocols that address the scenarios (M-IDs), what already exists in Rallar for each, and the scenario→mechanism matrix.                   |
| [2026-08-08-group-formation-implementation-plan.md](2026-08-08-group-formation-implementation-plan.md) | Staged plan evolving existing Rallar (groups, clients, auth, topologies) toward convergent, fault-tolerant, permissive/optimistic group formation.               |

Relationship to other documents:

- `plans/rallar-distributed-group-rtc-activation-design.md` (PR #83) designs
  server-directed edge activation with batches. The implementation plan here
  supplies the substrate that design assumes (damping, overlay precedence,
  delta dissemination, topology stability) and names the decision point where
  the two reconcile (Phase 5).
- `docs/rallar-convergent-state-and-rtc-topology.md` remains the
  architecture authority for causal revisions, durable publications, and
  multi-server fanout.

Status: analysis and planning documents; no implementation started.
