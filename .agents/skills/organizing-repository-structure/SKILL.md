---
name: organizing-repository-structure
description: Use when adding, moving, splitting, consolidating, or reviewing repository files or folders; when size, density, prefix, singleton, depth, ownership, or navigation findings appear; or when a plan is needed to understand the code.
---

# Organizing Repository Structure

## Core principle

Organize for the shortest truthful owner-to-result path. Deterministic tools expose facts;
they do not choose repository structure.

**REQUIRED SUB-SKILL:** Use `adaptive-plan-execution` when the work qualifies for an
adaptive plan or changes its ownership, folder, lifecycle, or navigation facts.

## Judgment workflow

1. Recover repository truth without using the plan, design, history, or PR as a map. Start
   from the package, app, command, route, or public export; locate callers, the capability
   owner and canonical entry, decisions and state, side effects and failures, the result or
   exit, mirrored tests, and any durable navigation map.
2. Read `scripts/repo-structure-check/README.md`. Run the applicable canonical style facts
   and `npm run check:repo-structure`. Density, prefix clustering, size, cognitive load, and
   depth come from `scripts/repo-style-check/structural-facts.mjs`; topology, capability,
   disposition, and cold-navigation validity come from the repository-structure checker.
3. Give every current fact one visible `structuralDispositions` judgment:

   | Disposition   | Use when                                                              |
   | ------------- | --------------------------------------------------------------------- |
   | `keep`        | The current placement keeps one coherent owner and direct navigation. |
   | `split`       | Independent responsibilities or lifecycles need distinct owners.      |
   | `move`        | The behavior belongs to another existing owner or boundary.           |
   | `consolidate` | Fragmentation or pass-through structure obscures one owner or flow.   |

4. Base the choice on separation of concerns, single responsibility, dependency direction,
   public compatibility, and human navigation. Do not mechanically split on a metric. Reject
   both flat dumping of unrelated responsibilities and meaningless singleton nesting. A
   folder is justified by a real domain, lifecycle, policy, translation, compatibility,
   protocol, runtime, side-effect, or ownership boundary—not by a prescribed taxonomy.
5. Implement the smallest coherent shape. Keep one obvious entry, mirror tests under the
   production owner, update exports and consumers deliberately, and preserve public paths
   unless the task authorizes a compatibility change. Re-run focused behavior checks and
   canonical structure/style checks.
6. Require a fresh cold-navigation probe. Give the reviewer only the repository and a
   capability question; require exact owner, entry, owner-to-result path, failure/exit paths,
   mirrored tests, and focused command or map. Record the evidence at its canonical plan
   owner. Passing tests or a detailed tactical plan do not replace this proof.

## Decision boundary

Automation does not choose `keep`, `split`, `move`, or `consolidate`. Explain the judgment
from current repository evidence. If a structural change or failed probe invalidates the
active horizon, checkpoint it. Consolidate before more feature work; if a fresh probe still
fails after the one allowed autonomous consolidation, stop for human direction.
