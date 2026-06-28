# Codex Finish-Line Verification Plan

This document is an execution plan for using Codex Goal mode after a large feature has been implemented, especially after implementing iteration 3 through the end of a major plan.

It is designed for a Rallar group-policy implementation, but the structure can be reused for other large features.

## Purpose

Use this plan when Codex Goal mode has completed a large implementation and you want a stronger safety gate before merging.

The plan forces Codex to:

- audit completion against the original plan
- review the full diff
- discover and run the correct checks
- perform exploratory regression testing
- verify product acceptance
- challenge policy/security bypasses
- update documentation
- produce a final merge-readiness decision

## Recommended Usage

Use this document in Codex after the implementation goal has completed.

Suggested workflow:

1. Save this file as `docs/codex-finish-line-verification-plan.md`.
2. Open a new Codex thread in the same repository.
3. Use Worktree mode if you want an isolated review/QA branch.
4. Paste the Goal prompt below.
5. Let Codex execute the plan in order.
6. Review the final merge-readiness report manually before merging.

---

# Goal Prompt

Paste this into Codex:

```text
/goal Execute `docs/codex-finish-line-verification-plan.md` as a finish-line verification process for the completed Rallar group-policy implementation.

Primary inputs:
- `rallar-groups-report.md`
- `docs/rallar-groups-implementation-plan.md`
- `docs/rallar-groups-implementation-progress.md`
- the current local Git diff
- relevant source files, tests, docs, package scripts, and CI configuration

Definition of done:
- Completion audit is finished.
- Full diff review is finished.
- Static QA and test-command discovery is finished.
- Relevant checks/tests/builds have been run or clearly explained if unavailable.
- Exploratory regression test matrix is produced.
- Highest-priority missing tests are added if safe and in scope.
- Product-owner acceptance pass is completed.
- Policy-bypass challenge review is completed.
- Documentation/API consistency pass is completed.
- Final merge-readiness verification is completed.
- `docs/rallar-groups-implementation-progress.md` is updated with final status.
- Any documentation updates are committed to the local diff, but production code is not changed unless explicitly required to fix a blocker.

Working rules:
- Do not assume Goal-mode implementation was correct just because it finished.
- Prefer no-code review passes first.
- Only add or update tests when the plan explicitly allows it.
- Only change production code for blocker fixes, and keep those fixes minimal.
- Preserve existing room communication behavior unless the implementation plan explicitly changed it.
- Surface all blocker/high findings clearly.
- If a check cannot run locally, explain why and whether that creates merge risk.
- End with a final `safe to merge: yes/no` recommendation.
```

---

# Phase 1: Implementation Completion Audit

## Codex Prompt

```text
Perform a completion audit for the Goal-mode implementation.

Scope:
- Compare the final implementation against `docs/rallar-groups-implementation-plan.md`.
- Compare the final implementation against `rallar-groups-report.md`.
- Inspect `docs/rallar-groups-implementation-progress.md`.

Do not make code changes yet.

For each iteration from iteration 3 to the end, report:

- implemented: yes/no/partial
- acceptance criteria met: yes/no/partial
- files changed
- tests added or updated
- commands run
- pass/fail result
- remaining gaps
- risky assumptions
- whether the implementation drifted outside the plan

Also check that these original report gaps are explicitly handled or documented as intentionally deferred:

- admission policy
- invite/code join semantics
- capacity enforcement
- lifecycle enforcement
- membership governance
- read visibility policy
- browser-safe group administration workflows
- consistency policy for room switching
- policy-safe server-side authorization
- focused tests for missing policy cases

Final output:
- Ready for review: yes/no
- Must-fix issues before review
- Should-fix issues
- Deferred items
- Recommended next prompt
```

## Expected Output

Codex should produce:

- a per-iteration completion table
- a gap coverage table
- a list of must-fix and should-fix issues
- a recommendation for whether the implementation is ready for deeper review

---

# Phase 2: Dedicated Full Diff Review

## Codex Prompt

```text
/review

Review the full local diff from the Goal-mode implementation.

Do not make code changes.

Focus areas:
- correctness
- regressions
- policy bypasses
- authorization gaps
- unsafe browser APIs
- inconsistent REST vs state-sync behavior
- broken backwards compatibility
- missing tests
- confusing error shapes
- race conditions
- room/session lifecycle bugs
- over-broad refactoring
- dead code or unused abstractions

Pay special attention to:

- whether browser workflows can still self-upsert around server policy
- whether archived/deleted groups reject join, presence, and room messages consistently
- whether banned/removed members can rejoin incorrectly
- whether maxMembers and maxSessionsPerMember are enforced in the correct layer
- whether invite-only and code groups are actually enforced server-side
- whether last-owner rules are enforced
- whether read visibility is consistent between REST reads and state-sync routing
- whether error reason codes are stable and browser-safe

For every finding, include:
- severity: blocker/high/medium/low
- affected file/function
- exact risk
- suggested fix
- test that should catch it

End with:
- safe to merge: yes/no
- required fixes before merge
```

## Expected Output

Codex should produce a no-code review report with prioritized findings.

---

# Phase 3: Static QA and Test Command Discovery

## Codex Prompt

```text
Perform a static QA and test-command discovery pass.

Do not change code.

First inspect:
- root `package.json`
- workspace config
- package-level `package.json` files
- CI configuration
- README / AGENTS.md / docs
- existing test folders

Determine the correct commands for:
- typecheck
- lint
- formatting check
- unit tests
- service tests
- route/API tests
- browser facade tests
- build
- any e2e or integration tests

Then run the relevant commands for the changed packages/apps.

Use this strategy:
1. Run targeted tests for changed areas first.
2. Run broader package tests next.
3. Run workspace-level typecheck/build if available.
4. If any command is missing, broken, or too expensive locally, explain exactly why.

Final report:
- command
- purpose
- result
- failure summary if any
- whether failure is caused by this change or pre-existing
- recommended fix
```

## Expected Output

Codex should identify and run the appropriate local validation commands, then report exact results.

---

# Phase 4: Tester / Exploratory Regression Pass

## Codex Prompt

```text
Act as Tester for the completed Rallar group-policy implementation.

You may add tests, but do not change production code unless I explicitly approve it.

Goal:
Find regressions and missing edge-case coverage.

Inspect the implementation and create an exploratory test matrix for:

- open group join
- invite-only group join
- code group join
- expired invite
- invalid join code
- banned member rejoin
- removed member rejoin
- left member rejoin
- owner/admin bypass rules
- full group maxMembers
- maxSessionsPerMember
- archived group join
- archived group presence connect
- archived group room message
- deleted group visibility
- last owner leave/demote/remove
- REST read visibility
- state-sync visibility
- browser `rooms.join`
- browser admin workflows
- room switching with `leaveCurrent`
- failure recovery when join succeeds but leave-current fails

For each case:
- existing test coverage: yes/no/unknown
- test file if covered
- missing assertion if partially covered
- recommended test to add
- priority: blocker/high/medium/low

Then add only the highest-priority missing regression tests that fit the existing test style.

Run the relevant tests.

Final report:
- tests added
- bugs found
- commands run
- pass/fail results
- remaining test gaps
```

## Expected Output

Codex should produce:

- a regression matrix
- a list of missing tests
- added high-priority regression tests if safe
- command results

---

# Phase 5: Product Owner Acceptance Pass

## Codex Prompt

```text
Act as Product Owner for the completed Rallar group-policy implementation.

Do not change code.

Compare the implementation against:

- `rallar-groups-report.md`
- `docs/rallar-groups-implementation-plan.md`
- `docs/rallar-groups-implementation-progress.md`

Check:

1. Scope
   - Did the implementation solve the gaps identified in the report?
   - Did it stay within the planned scope?
   - Did it introduce unrelated features or abstractions?

2. User/browser behavior
   - Are browser workflows ergonomic?
   - Are policy failures surfaced with stable, understandable reason codes?
   - Are unsafe raw membership mutations avoided?
   - Are common room flows still simple?

3. Policy completeness
   - Admission policy
   - Capacity policy
   - Lifecycle policy
   - Membership governance
   - Invite/code workflows
   - Read visibility
   - Room switching consistency

4. Acceptance criteria
   - For every iteration, mark accepted/rejected/partial.
   - For partial/rejected items, explain what is missing.

5. Documentation
   - Are docs updated enough for a developer to use the new APIs?
   - Are open product decisions documented?

Final output:
- Product acceptance: accepted / accepted with caveats / rejected
- Must-fix before merge
- Acceptable deferred items
- Recommended release notes
```

## Expected Output

Codex should give a product-level acceptance decision, separate from technical test results.

---

# Phase 6: Policy-Bypass Challenge Review

## Codex Prompt

```text
Perform a policy-bypass challenge review.

Do not change code.

Assume a malicious or buggy browser client can call any exposed API route directly and can send malformed or unexpected inputs.

Try to find ways to bypass:

- invite-only join
- code join
- banned status
- removed status
- maxMembers
- maxSessionsPerMember
- archived/deleted lifecycle
- last-owner protection
- read visibility
- room message authorization
- state-sync routing authorization
- browser-only assumptions

Check both:
- REST/API routes
- shared server services
- browser facade workflows
- WebSocket/room authorization
- state-sync routing

For each possible bypass:
- describe the attack path
- identify the missing guard
- identify where the guard should live
- recommend a test that proves the bypass is closed

End with:
- blocker bypasses
- high-risk bypasses
- medium/low risks
- whether the feature is safe to merge from a policy perspective
```

## Expected Output

Codex should identify possible bypass paths and classify their severity.

---

# Phase 7: Documentation and API Consistency Pass

## Codex Prompt

```text
Perform a documentation and API consistency pass.

You may update documentation files only.
Do not change production code.

Check whether the implementation introduced or changed:

- group policy reason codes
- join modes
- invite/code workflows
- admin/member governance workflows
- browser `rooms.*` methods
- REST/API routes
- read visibility behavior
- capacity/lifecycle behavior
- room switching behavior

Update relevant docs, especially:
- `docs/rallar-api-reference.md`
- `docs/rallar-groups-implementation-progress.md`
- any README or API docs that mention rooms/groups

Documentation should include:
- short examples for common browser workflows
- error/reason-code behavior
- policy defaults
- backwards-compatibility notes
- deferred limitations

Run formatting/checks for docs if available.

Final report:
- docs updated
- public API changes documented
- remaining documentation gaps
```

## Expected Output

Codex should update only documentation and report what changed.

---

# Phase 8: Final Merge-Readiness Verification

## Codex Prompt

```text
Perform final merge-readiness verification.

Do not change code unless fixing documentation typos only.

Checklist:

1. Git status
   - Summarize changed files.
   - Identify generated/unwanted files.
   - Identify unrelated changes.

2. Plan completion
   - Confirm all completed iterations are reflected in `docs/rallar-groups-implementation-progress.md`.
   - Confirm deferred work is explicitly documented.

3. Tests/checks
   - Re-run the final agreed command set:
     - typecheck
     - lint if available
     - targeted tests
     - broader tests
     - build
   - Report exact commands and results.

4. Review findings
   - Confirm all blocker/high findings from review, QA, tester, product-owner, and policy-bypass passes are fixed or explicitly accepted as deferred.

5. Backwards compatibility
   - Confirm existing room create/join/leave/message behavior still works unless intentionally changed.
   - Confirm public API changes are documented.

6. Final recommendation
   - Safe to merge: yes/no
   - If no, list only the blockers.
   - If yes, provide a concise merge summary.

Final output must include:
- safe to merge: yes/no
- commands run
- pass/fail table
- remaining risks
- suggested commit message
```

## Expected Output

Codex should produce the final merge-readiness decision.

---

# Optional: Fix Blockers Prompt

Use this only if the verification process finds blocker or high-severity issues.

```text
Fix only the blocker and high-severity issues found in the finish-line verification process.

Inputs:
- latest review findings
- tester findings
- product-owner findings
- policy-bypass findings
- final merge-readiness findings

Rules:
- Keep the fix minimal.
- Do not implement new feature scope.
- Add or update tests for each fixed issue.
- Preserve public APIs unless the finding requires a breaking change.
- Re-run relevant targeted tests, typecheck, and build.
- Update `docs/rallar-groups-implementation-progress.md`.

Final report:
- issues fixed
- files changed
- tests added/updated
- commands run
- pass/fail results
- remaining risks
```

---

# Optional: Multi-Agent Variant

If using subagents or separate worktree threads, use this coordination prompt.

```text
Use subagents to execute finish-line verification in parallel.

Spawn these subagents and wait for all results:

1. Completion Audit subagent
   - Compare implementation against the report and implementation plan.
   - Report missing, partial, and drifted items.

2. Static QA subagent
   - Review architecture, type safety, coupling, code quality, and missing validation.
   - Do not change code.

3. Tester subagent
   - Build the exploratory test matrix.
   - Identify missing high-priority regression tests.
   - Add tests only if safe and in scope.

4. Product Owner subagent
   - Check scope, user/browser behavior, policy completeness, and acceptance criteria.
   - Do not change code.

5. Policy Bypass subagent
   - Try to identify REST, service, WebSocket, state-sync, and browser workflow bypasses.
   - Do not change code.

After all subagents finish:
- consolidate findings
- identify blocker/high issues
- recommend fixes
- update `docs/rallar-groups-implementation-progress.md`
- do not change production code unless explicitly asked
```

---

# Final Confidence Checklist

You can feel reasonably secure when all of these are true:

- Completion audit reports no missing planned iterations, or missing items are explicitly deferred.
- Full diff review has no blocker/high findings.
- Policy-bypass review has no blocker/high findings.
- Targeted policy tests pass.
- Broader package/workspace tests pass.
- Typecheck passes.
- Build passes.
- Documentation reflects the implemented behavior.
- Progress document honestly lists completed and deferred work.
- Existing room create/join/leave/message flows still work.
- You personally inspect the final diff before merging.

This process does not guarantee there are no bugs, but it creates a strong finish gate after a large Codex Goal-mode implementation.
