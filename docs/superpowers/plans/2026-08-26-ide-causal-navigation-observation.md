# IDE Causal Navigation Observation Plan

## Summary

Implement an observation-first, tooling-only rollout. The first delivery defines IDE navigability, adds a non-blocking cross-file analyzer, runs it locally and in CI, and calibrates it against representative mutations. It does not refactor production code or fail CI for navigation findings.

Execution starts from `main` in:

- Branch: `codex/ide-navigation-observation`
- Worktree: `/Users/knuthelge/.codex/worktrees/ide-navigation-observation/ar-eye-hunter`

## Slice 1: Doctrine and navigation analyzer

- Extend the canonical code standard and convergent-mutation guidance with an “IDE causal navigation” contract. A cold probe starts at a concrete registration and must reach:
  1. Concrete operation entry.
  2. Domain/update policy.
  3. First conditional write guard.
  4. Exact durable result.
  5. After-commit effect.
- Permit only Go to Definition and Find Usages during the probe. Record search escapes, ambiguous pivots, and named deferred boundaries. Do not impose a global call-depth limit.
- Update the code-writing and testing skills so agents run the report and perform the cold probe when changing authoritative mutation control flow.
- Preserve functional style: named functions passed to `Either` or pipeline operators count as navigable edges. Do not require controllers, classes, or fluent APIs.
- Add project-level analysis under `scripts/repo-style-check/`, using lazily loaded `ts-morph` without importing TypeScript compiler APIs directly.
- Add stable observational rule IDs:
  - `navigation.registration-indirection`
  - `navigation.unnamed-deferred-edge`
  - `navigation.interface-pivot`
- Treat repository, transaction-writer, queue, clock, gateway, and sink contracts as named effect ports. Report them as boundary facts rather than business-interface pivots.
- Follow direct internal definitions with cycle detection and a 24-edge safety ceiling. Emit an `analysis truncated` diagnostic rather than a code-quality violation when the ceiling is reached.
- Recognize AppInbox registrations as primary seeds. Reuse Hono route-handler discovery as upstream seeds for `apps/api-v1` without duplicating route length or complexity findings.
- Add a dedicated `--navigation-details` report mode. It supports repeated `--root` arguments, deterministic findings and per-rule counts, at most 200 detailed entries, and exit code zero for clean runs or navigation findings. Invalid arguments, project-construction failures, and analyzer errors remain fatal.
- Add `check:repo-style:navigation-details` to `package.json`.

## Slice 2: Calibration and CI observation

- Add synthetic tests for concrete and generic registrations, transparent and dynamic deferred boundaries, business interfaces and effect ports, inline transaction work, named functional pipeline callbacks, cycles, aliases, method references, deterministic sorting, root filtering, output caps, and fatal analyzer errors.
- Add the suite to `test:repo-governance` and integrity-test the CLI flag, rule IDs, package script, and reusable release-gate integration.
- Run `Report IDE navigation details` after `npm ci` in the reusable release gate. Navigation findings remain non-blocking; analyzer failures fail CI.
- Run focused reports for:
  - `GROUP_UPDATE`
  - `CLIENT_SESSION_CONNECT`
  - `AUTH_USER_REGISTER`
  - `TOPOLOGY_CONFIG_PUT`
  - `CRDT_UPDATE_APPEND`
  - `apps/api-v1/src`
- Perform a manual 5/5 cold probe for every representative family and summarize actionable findings, legitimate boundaries, false positives, search escapes, and ambiguous pivots in the delivery handoff or pull-request body. Do not add a tracked disposition registry or evidence ledger.
- Convert each false-positive class into a focused fixture and analyzer correction. Do not suppress individual production symbols by pathname or implementation name.

## Subsequent enforcement rollout

Use a separate follow-up change after this observation delivery merges. Promote registration-indirection and unnamed-deferred-edge into the existing new/worsened changed-range gate only after every representative finding is classified, known false-positive classes have fixtures, the candidate rules have zero known false positives in those scopes, three repeated full reports are identical, and CI output remains complete below the detail cap.

Keep interface-pivot observational until business orchestration is distinguished from legitimate effect ports without symbol-specific exceptions. Automate landmark coverage only after it agrees with manual 5/5 probes across all representative families.

## Test and acceptance plan

Use test-first cycles for doctrine integrity, analyzer fixtures, CLI behavior, and the CI workflow contract. Final validation:

```bash
npx vitest run packages/tests/repo/repo-style-navigation-check.test.ts
npm run test:repo-governance
npm run check:repo-style:navigation-details
npm run check:repo-style:navigation-details -- --root packages/shared-server/rallar-system/group-state
npm run check:repo-style:navigation-details -- --root packages/shared-server/rallar-system/client-state
npm run check:repo-style:navigation-details -- --root packages/shared-server/rallar-system/auth
npm run check:repo-style:navigation-details -- --root packages/shared-server/rallar-system/topology
npm run check:repo-style:navigation-details -- --root packages/shared-server/rallar-system/crdt
npm run check:repo-style:navigation-details -- --root apps/api-v1/src
npm run typecheck
npm run format:check
npm run check:repo-structure -- --base main
```

API black-box, Postgres mutation, and performance gates are skipped because this delivery changes no production mutation behavior.

Acceptance requires deterministic reports, passing fixtures and governance tests, successful full-project analysis, completed representative cold probes, and documented false-positive classification.

## Assumptions and constraints

- The first delivery is non-blocking and tooling-only.
- Reports use CI logs and stdout. No artifact, baseline snapshot, suppression manifest, or navigation ledger is added.
- No production mutation, public API, persisted contract, or protocol behavior changes.
- Existing cognitive-load, pass-through, callback, structure, type, and functional-core rules remain authoritative.
- Every changed human-authored file is reviewed and remediated in full. Every support file changed by remediation enters closure recursively; independent untouched code remains outside closure.
- The requested navigation-report behavior remains the intended outcome throughout closure. The analyzer fixture suite is the direct validation; `test:repo-governance` and full typecheck are the affected repository validation.
