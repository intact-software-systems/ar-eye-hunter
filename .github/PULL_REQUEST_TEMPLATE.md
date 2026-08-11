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
- Complete review findings and resolution/status (correctness, safety, contracts, and other human-review findings):
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

- Milestone classification: `none` | `reviewed`

When the classification is `reviewed`, add the exact heading
`#### Milestone review entry` immediately before the fields below. Copy the
complete heading-and-fields block for each additional reviewed milestone. When
the classification is `none`, leave the metadata `entries` array empty and do
not add that heading.

- Reviewer and independence (separate agent or human):
- Exact merge base SHA:
- Exact candidate head SHA:
- New ownership, control-flow, or legacy family:
- Production owner-to-result trace:
- Cognitive-indirection findings:
- Complete review findings and resolution/status (correctness, safety, contracts, and other human-review findings):
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
- Changed production owner-to-result trace, including decisions, effects, failures, callbacks, compatibility branches, and tests:
- Cognitive-indirection findings and resolution:
- Complete review findings and resolution/status (correctness, safety, contracts, and other human-review findings):
- Tests rewritten or removed, with independent behavior retained:
- Production was not compromised for tests:
- Behavior and judgment not proven by automation:
- Legacy candidates inspected (baseline, automated report, changed files, and production call paths):
- Legacy candidate count:
- Legacy ledger and dispositions:
- Critical findings unresolved: `0`
- Important findings unresolved: `0`
- Verdict: `pass` | `changes-requested`

Completed work requires zero unresolved Critical or Important findings.

### Human approval for retained legacy

List every `retained-pending-human-approval` item. Every confirmed affected
legacy item uses `classification: legacy` and exactly one disposition:
`removed`, `minimized-boundary`, `resolved`, or
`retained-pending-human-approval`. A heuristic candidate that is not legacy uses
`classification: not-legacy` with a concrete rationale; it is not a legacy
exception or an implicit disposition.

The final review's `Legacy ledger and dispositions` field is the one bound,
human-readable retained ledger. `Legacy exception ID` is the projection's `id`.
Each retained item also presents the exact path and symbol, purpose, consumer
or operational dependency, unsafe-removal
reason, minimization, canonical owner, compatibility tests, named owner,
review/removal condition, and approved production SHA. The validator hashes
that exact canonical projection. Record trusted GitHub approval provenance in
the `retainedLegacy` metadata and durable registry; do not duplicate the
approval details in another unbound visible block.

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
    "status": "complete",
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
    "legacy": { "candidateCount": 0, "items": [], "candidatesInspected": "" }
  },
  "milestoneReview": { "classification": "none", "entries": [] },
  "finalReview": null,
  "retainedLegacy": []
}
```

The visible Initial, Milestone, and Complete review sections above are the
human record. Fill each stable labeled field once with the exact matching
metadata value; do not add copied marker blocks. For retained legacy, metadata
must reference a trusted human GitHub review ID, login, submitted date,
approved production SHA, and whole-ledger SHA-256. A later registry recording
commit is allowed only when it changes no production path.
