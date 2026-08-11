# Pull request

## PR Human Review Record v1

Use this record for every pull request. It preserves the evidence that an
independent reviewer examined the exact candidate tree; it is not an automated
approval form.

Production code is the primary design artifact; tests are secondary evidence.
Automation validates evidence and freshness; it does not approve semantic
quality or retained legacy.

### PR classification

- Review scope: `code-changing` | `exempt`
- Explicit exemption, if any: `none` | `plan-only` | `documentation-only` |
  `agent-guidance-only`
- Exemption evidence:

Plan-, documentation-, and agent-guidance-only pull requests may use the
explicit exemption only when no production, test, script, workflow, package
metadata, or runtime files changed. An exemption does not permit a mixed PR to
skip review.

No production, test, script, workflow, package metadata, or runtime files
changed is required for an exemption.

### Change intent and scope

- Requirements and independently stated behavior:
- Exact merge base SHA:
- Exact candidate head SHA:
- Default-branch revalidation outcome:
- Active-plan legacy baseline and changed affected surface:

### Initial independent review

An Initial independent review is required before a code-changing draft pull
request is created. Record `not yet required` only for an explicit exemption.

- Record status: `required` | `complete` | `exempt`
- Reviewer and independence (separate agent or human):
- Exact merge base SHA:
- Exact candidate head SHA:
- Production owner-to-result trace:
- Cognitive-indirection findings:
- Complete review findings and resolution/status (correctness, safety,
  contracts, and other human-review findings):
- Tests rewritten or removed:
- Production was not compromised for tests:
- Behavior and judgment not proven by automation:
- Legacy candidate count:
- Legacy ledger and dispositions:
- Critical findings unresolved: `0`
- Important findings unresolved: `0`
- Verdict: `pass` | `changes-requested` | `exempt`

### Milestone review

Add one entry for every milestone where a new ownership, control-flow, or
legacy family appears. Use `not applicable` only when no such family appeared.

- Reviewer and independence (separate agent or human):
- Exact merge base SHA:
- Exact candidate head SHA:
- New ownership, control-flow, or legacy family:
- Production owner-to-result trace:
- Cognitive-indirection findings:
- Complete review findings and resolution/status (correctness, safety,
  contracts, and other human-review findings):
- Tests rewritten or removed:
- Production was not compromised for tests:
- Behavior and judgment not proven by automation:
- Legacy candidate count:
- Legacy ledger and dispositions:
- Critical findings unresolved: `0`
- Important findings unresolved: `0`
- Verdict: `pass` | `changes-requested` | `not-applicable`

### Complete code and legacy review

Complete code and legacy review is required before the pull request is ready
for merge. It must match the current candidate head SHA and follow every
changed production path from entry owner to result.

- Reviewer and independence (separate agent or human):
- Exact merge base SHA:
- Exact candidate head SHA:
- Changed production owner-to-result trace, including decisions, effects,
  failures, callbacks, compatibility branches, and tests:
- Cognitive-indirection findings and resolution:
- Complete review findings and resolution/status (correctness, safety,
  contracts, and other human-review findings):
- Tests rewritten or removed, with independent behavior retained:
- Production was not compromised for tests:
- Behavior and judgment not proven by automation:
- Legacy candidates inspected (baseline, automated report, changed files, and
  production call paths):
- Legacy candidate count:
- Legacy ledger and dispositions:
- Critical findings unresolved: `0`
- Important findings unresolved: `0`
- Verdict: `pass` | `changes-requested`

Completed work requires zero unresolved Critical or Important findings.

### Human approval for retained legacy

List every `retained-pending-human-approval` item. Every other affected legacy
item has exactly one disposition: `removed`, `minimized-boundary`, or
`resolved`.

- Legacy exception ID:
- Exact path and symbol:
- Purpose and current consumer or operational dependency:
- Why removal is unsafe now:
- Minimization already performed:
- Canonical implementation owner:
- Compatibility tests rather than internal-structure tests:
- Named owner:
- Review or removal condition:
- Exact candidate head SHA:
- Explicit human approver and approval date:

Silence, an issue, an earlier plan approval, agent judgment, or automation is
not approval. A production change invalidates the final review and any
retained-legacy approval. Record the approved item in
[`docs/production-legacy-exceptions.md`](../docs/production-legacy-exceptions.md)
before completion.

### Validation and publication

- Passed commands and exact current-head workflow evidence:
- Failed or skipped commands and reason:
- Follow-up issues: none | links:

### Validator metadata

Replace every value in this JSON fence with the exact evidence recorded above.
The check rejects placeholder text and does not approve semantic quality or
retained legacy.

```pr-human-review-record-v1
{
  "version": 1,
  "scope": "code-changing",
  "exemption": null,
  "initialReview": {
    "reviewer": "",
    "independence": "separate-agent-or-human",
    "mergeBaseSha": "",
    "headSha": "",
    "verdict": "pass",
    "unresolvedFindings": { "critical": 0, "important": 0 },
    "narrative": {
      "productionOwnerToResultTrace": "",
      "cognitiveIndirectionFindings": "",
      "testsRewrittenOrRemoved": "",
      "productionNotCompromisedForTests": "",
      "automationGaps": "",
      "completeFindings": ""
    },
    "legacy": { "candidateCount": 0, "items": [] }
  },
  "finalReview": null,
  "retainedLegacy": []
}
```

For each review, add the exact text from the metadata as visible evidence:

```markdown
<!-- pr-human-review:initial:productionOwnerToResultTrace:start -->
<!-- pr-human-review:initial:productionOwnerToResultTrace:end -->
<!-- pr-human-review:initial:cognitiveIndirectionFindings:start -->
<!-- pr-human-review:initial:cognitiveIndirectionFindings:end -->
<!-- pr-human-review:initial:testsRewrittenOrRemoved:start -->
<!-- pr-human-review:initial:testsRewrittenOrRemoved:end -->
<!-- pr-human-review:initial:productionNotCompromisedForTests:start -->
<!-- pr-human-review:initial:productionNotCompromisedForTests:end -->
<!-- pr-human-review:initial:automationGaps:start -->
<!-- pr-human-review:initial:automationGaps:end -->
<!-- pr-human-review:initial:completeFindings:start -->
<!-- pr-human-review:initial:completeFindings:end -->
```

Repeat the same six blocks with `final` after the complete review. For retained
legacy, metadata must reference a trusted human GitHub review ID, login,
submitted date, approved production SHA, and ledger SHA-256. A later registry
recording commit is allowed only when it changes no production path.
