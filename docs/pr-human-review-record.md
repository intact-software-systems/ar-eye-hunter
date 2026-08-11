# PR Human Review Record v1

This is the repository contract for the human-review record in a pull request.
It applies the authoritative
[repo code standard](../.agents/skills/rallar-code-writing/references/repo-code-style.md)
and the [human review guide](./repo-human-style-guide.md); it does not define a
second coding standard.

Production code is the primary design artifact; tests are secondary evidence.
Automation validates evidence and freshness; it does not approve semantic
quality or retained legacy.

Use [the pull request template](../.github/PULL_REQUEST_TEMPLATE.md) as the
record. Its labels are intentionally stable so `check:pr-human-review` can
validate presence and freshness without judging the code or approving legacy.

## Validator metadata and command

The pull request body ends with one `pr-human-review-record-v1` JSON fence.
It is evidence metadata for the surrounding narrative, not a second review
record. Fill every required string with concrete evidence; `TODO`, `TBD`,
`not applicable`, and placeholder text are invalid evidence.

The metadata contains `version: 1`, `scope`, an optional explicit exemption,
an `initialReview`, an optional `finalReview`, and `retainedLegacy`. Each review
contains its reviewer and `separate-agent-or-human` independence declaration,
exact base and head SHA, verdict, unresolved Critical and Important counts,
the six narrative evidence fields, and a legacy candidate count plus ledger.
Every ledger item has an ID, path, symbol, and one valid disposition.

Run the deterministic, read-only check locally with explicit evidence files:

```sh
npm run check:pr-human-review -- \
  --body path/to/pull-request-body.md \
  --changed-paths path/to/changed-paths.txt \
  --registry docs/production-legacy-exceptions.md \
  --base <40-character-base-sha> \
  --head <40-character-head-sha> \
  --draft true
```

In GitHub Actions, `--event "$GITHUB_EVENT_PATH"` reads the `pull_request`
payload and derives changed paths from the exact base and head commits. The
validator checks evidence completeness, exact-SHA freshness, path-valid
exemptions, ledger completeness, registry IDs, and explicit human-approval
metadata. It does not approve semantic quality, an independent reviewer, or
retained legacy.

## Scope and exemptions

Plan-, documentation-, and agent-guidance-only pull requests may use the
explicit exemption only when no production, test, script, workflow, package
metadata, or runtime files changed. The record names the exemption and the
changed-path evidence. A mixed pull request is code-changing and requires the
reviews below.

No production, test, script, workflow, package metadata, or runtime files
changed is required for an exemption.

## Required review records

Every record identifies a separate agent or human reviewer, the exact merge
base SHA, the exact candidate head SHA, unresolved Critical and Important
counts, and a verdict. Every applicable record includes a `Complete review
findings and resolution/status` field covering correctness, safety, contracts,
and other human-review findings. Each applicable review record includes a
`Legacy candidate count` beside its ledger so automation can check that every
identified candidate received a disposition. An implementation agent may supply
context but never self-certifies as the independent reviewer.

### Initial review

An initial review is required before a code-changing draft pull request is
created. It reviews the requirements, exact merge base and candidate head,
and diff. It records:

- a production owner-to-result trace for the changed behavior;
- cognitive-indirection findings across vocabulary, ownership, files,
  abstractions, dataflow, decisions, callbacks, effects, failures,
  compatibility, and legacy;
- tests rewritten or removed, plus confirmation production was not compromised
  for tests;
- behavior and judgment not proven by automation;
- complete review findings and resolution/status, plus the legacy candidate
  count and one disposition for every identified item; and
- reviewer, findings, unresolved counts, exact SHAs, and verdict.

### Milestone review

A milestone review is required when a new ownership, control-flow, or legacy
family appears. It uses the same fields as the initial review and explains the
new family. It does not replace the final review. Its complete findings status
and legacy candidate count cover the newly introduced family as well as the
current candidate tree.

### Final review

A final review is required before the pull request is ready for merge. The
separate agent or human reviewer freezes the candidate base and head, traces
every changed production path from entry owner to result, and reviews the
initial legacy baseline, automated candidates, changed files, and actual
production call paths for unnamed legacy. Its complete findings status records
the resolution of every correctness, safety, contract, and other human-review
finding; its legacy candidate count matches the final ledger.

Completed work requires zero unresolved Critical or Important findings. A
production change invalidates the final review and any retained-legacy approval;
repeat the complete code and legacy review against the new exact candidate
head SHA.

## Legacy ledger and human approval

Every legacy item in the active plan's affected production surface has exactly
one disposition:

- `removed`;
- `minimized-boundary`: a thin, explicitly named compatibility boundary that
  delegates to the canonical implementation and contains no duplicate business
  logic;
- `resolved`; or
- `retained-pending-human-approval`.

The record names the relevant legacy baseline and automated candidate report,
but a clean report is not proof that no legacy exists. The final reviewer traces
the production call path.

For each proposed retained item, present the human with its exact path and
symbol; purpose and current consumer or operational dependency; why removal is
unsafe now; minimization already performed; canonical implementation owner;
tests protecting compatibility rather than internal structure; named owner;
review or removal condition; and exact candidate head SHA.

Silence, an issue, an earlier plan approval, agent judgment, or automation is
not approval. Only explicit human approval for that exact ledger and SHA can
retain the item. Record the approval in both the pull request and the durable
[production legacy exception registry](./production-legacy-exceptions.md).

## Automation boundary

The validator verifies required narrative sections, exact-SHA freshness,
dispositions, unresolved counts, and registry references. It never approves
semantic quality or a retained item. Human approval remains a human decision.
