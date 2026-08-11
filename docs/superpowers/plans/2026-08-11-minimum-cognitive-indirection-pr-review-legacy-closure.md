# Minimum Cognitive Indirection, PR Review, and Legacy Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans` to
> implement this plan task-by-task.

**Goal:** Make minimum cognitive indirection, production-over-test authority,
independent PR review, and explicit legacy closure enforceable repository
contracts.

**Architecture:** Extend the existing authority chain instead of creating a
second style standard. Pair independent semantic review with read-only PR
record validation, warning-oriented legacy discovery, and a separate test
structure-coupling audit.

**Tech Stack:** Markdown, Node.js ESM, GitHub Actions, Vitest, npm scripts.

## Global Constraints

- “The goal is not minimum syntax. The goal is minimum cognitive indirection.”
- Production code is the primary design artifact; tests are secondary evidence.
- No production runtime or wire API changes are planned.
- Automation validates evidence and candidate coverage; it never approves
  semantic quality or retained legacy.
- A separate agent or human performs every independent review. The implementation
  agent never self-certifies.
- No automated score or agent may approve retained production legacy.
- New unapproved production legacy may exist only while this active plan owns
  its disposition.

## Legacy baseline and exit criteria

This plan changes governance, scripts, tests, and GitHub workflow behavior. It
does not intentionally create or retain a production runtime compatibility
path. The affected production surface for this plan is empty.

The implementation still scans every changed code path before completion. Any
production legacy discovered because this plan creates, retains, depends on,
expands, or materially touches it is added to this section and resolved as
`removed`, `minimized-boundary`, `resolved`, or
`retained-pending-human-approval`. No unclassified affected legacy may remain at
completion, and an issue never substitutes for active-plan resolution.

---

### Task 1: Establish the canonical governance and plan-authoring contract

**Legacy impact:** Does not affect production legacy.

- Add the exact cognitive-indirection principle and its operational definition
  to `AGENTS.md` and the canonical repo code standard.
- Establish production-over-test authority and legacy completion rules in the
  code-writing, testing, publication, and human-review guidance.
- Require every production-affecting plan to include a legacy baseline, a
  `Legacy impact` field for each task, and the mandatory final review task.
- Add governance tests first and observe the expected failure before changing
  guidance.

### Task 2: Define PR Human Review Record v1 and legacy exceptions

**Legacy impact:** Does not affect production legacy.

- Add the PR template and human-readable production legacy exception registry.
- Define initial, milestone, and final exact-SHA review records, including the
  code trace, cognitive-indirection review, tests-versus-production review,
  automation gaps, legacy ledger, findings, and verdict.
- Require explicit human approval for retained legacy on the exact candidate
  tree and invalidate approval after production changes.

### Task 3: Implement read-only PR review record validation

**Legacy impact:** Does not affect production legacy.

- Add failing fixtures for exempt, missing, malformed, stale, draft, final,
  unresolved-finding, and retained-legacy approval cases.
- Implement `npm run check:pr-human-review` as a deterministic Node.js command.
- Add a read-only `pull_request` workflow covering opened, edited,
  synchronized, reopened, draft-conversion, and ready-for-review events.

### Task 4: Implement warning-oriented legacy candidate review

**Legacy impact:** Does not create production legacy; it reports changed
production legacy candidates.

- Add failing fixtures for legacy/deprecated/compatibility/fallback/shim/bridge
  vocabulary, aliases, compatibility exports, parallel paths, modes, and
  registry validation.
- Implement `npm run review:legacy -- <base> <head>` without treating a clean
  scan as proof that no legacy exists.
- Require a human disposition for every candidate in the final review ledger.

### Task 5: Implement test structure-coupling review

**Legacy impact:** Does not affect production legacy.

- Add failing fixtures for production-source reads, AST inspection, exact
  trees, symbols, hashes, line counts, migration topology, and valid durable or
  temporary registrations.
- Implement `npm run check:test-structure-coupling` with full-report and
  changed-file modes.
- Keep reporting advisory until the existing candidate inventory is classified;
  do not create a blanket grandfathered baseline.

### Task 6: Audit and retire existing structure-coupled test debt

**Legacy impact:** Reviews compatibility-oriented tests but does not change
production behavior.

- Classify the complete detector output by independently stated behavior or
  contract.
- Retire obsolete API-v1/group-state, auth/client-state/group-topology, and
  black-box/shared-web/package-boundary structure locks in reviewable batches.
- Preserve semantic and durable public/security/compatibility boundary tests.
- Update `test:repo-governance` and remove completed lineage artifacts rather
  than changing production to satisfy obsolete tests.

### Task 7: Complete Code and Legacy Review

**Legacy impact:** Final classification gate for all affected production paths.

- Freeze the candidate tree and record exact base and head SHAs.
- Dispatch an independent, read-only complete code review.
- Trace every changed production path from entry owner to result.
- Review the legacy baseline, automated candidates, diff, and call paths.
- Resolve all Critical and Important findings and repeat both reviews after any
  production change.
- Give every legacy item exactly one disposition: `removed`,
  `minimized-boundary`, `resolved`, or `retained-pending-human-approval`.
- Present every retained item to the human with its exact location, dependency,
  minimization, canonical owner, tests, owner, review/removal condition, and
  exact head SHA.
- Record explicit human approval in the PR and durable registry. Silence, an
  issue, agent judgment, or approval for older code is not approval.
- Run final validation and publication gates. Any corrective code change
  invalidates review and legacy approval and restarts this task.

## Validation

- Run focused governance and script tests during each red-green cycle.
- Run `npm run test:repo-governance`, `npm run check:repo-style:changed --
  origin/main HEAD`, `npm run review:legacy -- origin/main HEAD`,
  `npm run check:test-structure-coupling`, and `git diff --check`.
- From the final unchanged tree run `npm run test:unit`, `npm run test:ci`, and
  `npm run build`.
- Require Branch Release Gate for the exact final feature head and Run Hetzner
  Supported Distributed Manifests for the resulting default-branch commit.

