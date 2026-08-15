---
name: organizing-repository-structure
description: Use when adding, moving, splitting, consolidating, or reviewing repository files or folders; or when size, density, prefix, singleton, depth, ownership, or navigation findings appear.
---

# Organizing Repository Structure

## Core principle

Organize for the shortest truthful owner-to-result path. Deterministic tools expose facts; they do
not choose repository structure.

**REQUIRED SUB-SKILL:** Use `adaptive-plan-execution` when structure materially changes the current
working plan.

## Judgment workflow

1. Recover repository truth without using a plan, design, history, or PR as the map. Start from the
   command or export; locate the owner, entry, decisions, side effects, failures, result, mirrored
   tests, and any durable navigation map.
2. Read `scripts/repo-structure-check/README.md`. Run canonical style facts and
   `npm run check:repo-structure`. When the relevant comparison base is not `origin/main`, run
   `npm run check:repo-structure -- --base <base>`.
3. Give each finding one human judgment: `keep` for coherent direct ownership; `split` for
   independent responsibilities; `move` for a different owner; or `consolidate` when fragmentation
   obscures one flow.
4. Base the choice on separation of concerns, responsibility, dependencies, compatibility, and
   human navigation. Do not mechanically split on a metric. A folder needs a real domain,
   lifecycle, policy, translation, compatibility, protocol, runtime, side-effect, or ownership
   boundary.
5. Implement the smallest coherent shape. Keep an obvious entry, mirrored tests, deliberate exports
   and consumers, and compatible public paths. Re-run focused and canonical checks.
6. Explain material structural pressure and the chosen disposition in the PR review. Do not write a
   plan-owned disposition, generated navigation evidence record, ownership reservation, or shared
   catalog entry.

## Decision boundary

Automation reports changed paths, singleton folders, redundant chains, exception-registry facts,
and other reproducible findings. It does not choose `keep`, `split`, `move`, or `consolidate`.

Update the working plan only when the structural finding changes ownership, the next slice, or an
acceptance assumption. A harmless base movement or a new commit identifier does not reopen a
settled structure decision. Consolidate before further feature work when navigation is genuinely
broken; if a focused consolidation still cannot recover ownership, stop for human direction.
