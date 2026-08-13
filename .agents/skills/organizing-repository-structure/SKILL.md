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
   from the command or export; locate the owner, entry, decisions, side effects, failures,
   result, mirrored tests, and map.
2. Read `scripts/repo-structure-check/README.md`. Run canonical style facts and
   `npm run check:repo-structure`, then run
   `node scripts/repo-structure-check.mjs --navigation-evidence <capability-owner>`.
   Density, prefix, size, load, and depth come from
   `scripts/repo-style-check/structural-facts.mjs`; topology and navigation evidence come
   from the structure checker.
3. Give every fact one visible `structuralDispositions` judgment: `keep` for coherent direct
   ownership; `split` for independent responsibilities; `move` for a different owner; or
   `consolidate` when fragmentation obscures one flow.

4. Base the choice on separation of concerns, single responsibility, dependencies,
   compatibility, and human navigation. Do not mechanically split on a metric. Reject
   both flat dumping of unrelated responsibilities and meaningless singleton nesting. A
   folder is justified by a real domain, lifecycle, policy, translation, compatibility,
   protocol, runtime, side-effect, or ownership boundary—not by a prescribed taxonomy. Do
   not make a current disposition permanent; state which changed facts would reopen it.
5. Implement the smallest coherent shape. Keep an obvious entry, mirrored tests, deliberate
   exports and consumers, and compatible public paths. Re-run focused and canonical checks.
6. Use the generated navigation-evidence record as the canonical fact proof; do not
   transcribe facts the checker already owns. Explain the actual structural pressure from
   recovered responsibilities and dependencies, the disposition, reopening conditions, and
   adaptive-plan effect. Record the judgment at its canonical plan owner. Passing tests or
   a detailed tactical plan do not replace repository-owned evidence.

## Decision boundary

Automation does not choose `keep`, `split`, `move`, or `consolidate`. Explain the judgment
from current repository evidence. If a structural change or failed probe invalidates the
active horizon, checkpoint it. Consolidate before more feature work; if a fresh probe still
fails after the one allowed autonomous consolidation, stop for human direction.
