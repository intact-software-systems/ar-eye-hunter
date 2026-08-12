# Pull request

## PR Human Review Record v2

This is one evidence record for the adaptive plan. Automation verifies its shape and
freshness; a separate agent or human owns the architectural and semantic judgment.

Production code is the primary design artifact; tests are secondary evidence.
Automation validates evidence and freshness; it does not approve semantic quality or
retained legacy.

### PR classification

- Review scope: `code-changing` | `exempt`
- Explicit exemption: `none` | `plan-only` | `documentation-only` | `agent-guidance-only`
- Exemption changed paths:

Plan-, documentation-, and agent-guidance-only pull requests may use the explicit
exemption only when no production, test, script, workflow, package metadata, or
runtime files changed. A mixed pull request is code-changing.

### Initial architecture review

- Record status: `complete`
- Reviewer and independence (separate agent or human):
- Reviewed adaptive-plan digest:
- Goal:
- Acceptance criteria:
- Capability-tree hypothesis:
- Canonical owners and entries:
- First two slices:
- Complete review findings and resolution/status:
- Behavior and judgment not proven by automation:
- Legacy candidate count:
- Legacy ledger and dispositions:
- Critical findings unresolved: `0`
- Important findings unresolved: `0`
- Verdict: `pass` | `changes-requested`

The initial verdict preserves immutable stage history and may be `changes-requested` while
the pull request remains a draft. Adaptive-plan checkpoints gate implementation progress;
only the final review must pass with zero unresolved Critical or Important findings.

### Current checkpoint review

- Current adaptive-plan digest:

### Complete code, structure, tests, and legacy review

- Reviewer and independence (separate agent or human):
- Build-affecting tree digest:
- Plan goal:
- Acceptance criteria:
- Current structural decision:
- Declared outcomes:
- Owner-to-result paths:
- Navigation evidence:
- Test evidence:
- Compatibility evidence:
- Proportional validation:
- Legacy closure:
- Complete review findings and resolution/status:
- Behavior and judgment not proven by automation:
- Legacy candidates inspected (baseline, automated report, changed files, and production call paths):
- Legacy candidate count:
- Legacy ledger and dispositions:
- Critical findings unresolved: `0`
- Important findings unresolved: `0`
- Verdict: `pass` | `changes-requested`

Completed work requires zero unresolved Critical or Important findings. An unrelated
documentation-only commit does not invalidate a review whose build-affecting tree digest,
plan goal, acceptance criteria, and structural decision remain current.

### Human approval for retained legacy

Every legacy-classified item uses `removed`, `minimized-boundary`, `resolved`, or
`retained-pending-human-approval`. Every heuristic false positive uses
`classification: not-legacy` with a concrete rationale. The legacy candidate set must be
exact: stale, extra, duplicate, and missing candidates fail validation.

For a report too large to itemize, `notLegacyAggregate` binds the exact candidate report
with `count`, the `REPORT-SHA256`, an artifact or committed evidence path, and a concrete
rationale. Every legacy item remains itemized.

Retained legacy requires the exact path and symbol, purpose, consumer dependency,
unsafe-removal reason, minimization, canonical owner, compatibility tests, named owner,
removal condition, approved production SHA, trusted human GitHub approval, and durable
registry entry. Silence, an issue, an earlier plan approval, agent judgment, or automation
is not approval.

### Validation and publication

- Passed commands and current workflow evidence:
- Failed or skipped commands and reason:
- Follow-up issues: none | links:

### Validator metadata

Replace every placeholder with concrete evidence. `checkpointReview` contains only the
current adaptive-plan digest.

```pr-human-review-record-v2
{
  "version": 2,
  "scope": "code-changing",
  "exemption": null,
  "plan": { "path": "" },
  "initialReview": {
    "status": "complete",
    "reviewer": "",
    "independence": "separate-agent-or-human",
    "adaptivePlanDigest": "",
    "mergeBaseSha": "",
    "headSha": "",
    "goal": "",
    "acceptanceCriteria": [],
    "capabilityTreeHypothesis": "",
    "canonicalOwnerEntries": [],
    "firstSlices": [],
    "completeFindings": "",
    "automationGaps": "",
    "unresolvedFindings": { "critical": 0, "important": 0 },
    "verdict": "pass",
    "legacy": { "candidateCount": 0, "items": [] }
  },
  "checkpointReview": { "adaptivePlanDigest": "" },
  "finalReview": null,
  "retainedLegacy": []
}
```
