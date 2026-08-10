# Repo Code-Style Exception Registry

This registry records approved persistent exceptions to the authoritative
[repo TypeScript coding standard](../.agents/skills/rallar-code-writing/references/repo-code-style.md).
It starts empty. Do not register all existing legacy files above the size
thresholds retroactively.

Add an entry only when a TypeScript file above 800 physical lines or a function
above 60 physical lines is materially touched and remains above its threshold.
Materially touched means behavior, contracts, control flow, state, lifecycle,
structure, or responsibility changed. Import-only, formatting-only, typo, and
path-only changes do not trigger registration.

An exception records a deliberate human decision that keeping cohesive code
together is easier to understand than the available separation. It does not
suppress checker warnings, waive future review, or justify pass-through files
and helper chains. Keep size justifications here rather than in source comments.

## Required entry fields

Each entry records:

- Repository-relative path;
- Symbol, when the exception applies to a function, method, constructor,
  accessor, or callback;
- Exception category;
- Why cohesion is clearer than the available separation;
- Approval date and reviewer;
- Review or removal condition.

Use one of the accepted categories from the canonical standard: declarative
schema or protocol definition, static lookup data, structured test scenario,
parser or state-transition table, approved export-only package barrel, or
cohesive algorithm.

## Approved exceptions

- Repository-relative path: `apps/rallar-black-box/src/hetzner-distributed-manifests.ts`
  - Exception category: static lookup data
  - Why cohesion is clearer: the file is the single ordered catalog for the
    generated Hetzner manifest suite. Keeping its manifest inventory, shared
    construction rules, and generation metadata together makes ordering and
    cross-manifest lifecycle invariants directly reviewable.
  - Approval date and reviewer: 2026-08-09, task requester
  - Review or removal condition: split the catalog when it exceeds 1,200
    physical lines or when a new independently generated manifest suite is
    added.
- Repository-relative path:
  `packages/shared-test/rallar-bb-test/browser-adapter.ts`
  - Exception category: parser or state-transition table
  - Why cohesion is clearer: this adapter is the single browser-rallar command
    dispatch and result-projection boundary. Keeping readiness result
    projection with the command execution table makes the provider call and its
    artifact-visible outcome traceable in one place; extracting only this small
    projection would add a pass-through module without separating ownership.
  - Approval date and reviewer: 2026-08-09, task requester
  - Review or removal condition: remove the exception when browser-rallar
    command families are decomposed into independently owned adapters, or
    review it again if the file exceeds 3,100 physical lines.

| Repository-relative path                               | Symbol      | Exception category | Why cohesion is clearer                                                                                                                                    | Approval date and reviewer                                                         | Owner                | Review or removal condition                                                                                                                                                                        |
| ------------------------------------------------------ | ----------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/perf/api-v1-state-write-concurrency-bench.ts` | Entire file | cohesive algorithm | Keep the unchanged measured orchestration together for this tooling wave while the named artifact owner is extracted; the file may not exceed 1,763 lines. | 2026-08-09; human approval of plan blob `b6fd5aebfa77ee489e65fa30fbee165e033c14f9` | Group-topology child | Remove in a separately approved benchmark-architecture child that splits measurement orchestration into cohesive owners without changing benchmark behavior, artifacts, timing, or governance.     |
| `scripts/perf/api-v1-state-write-concurrency-bench.ts` | `main`      | cohesive algorithm | Preserve the inherited end-to-end measurement lifecycle and cleanup order during this tooling wave; no newly introduced general function may exceed 60.    | 2026-08-09; human approval of plan blob `b6fd5aebfa77ee489e65fa30fbee165e033c14f9` | Group-topology child | Remove in the same separately approved benchmark-architecture child after `main` is split along genuine lifecycle ownership without changing benchmark behavior, artifacts, timing, or governance. |
