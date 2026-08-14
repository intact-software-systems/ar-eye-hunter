# PR Human Review Record v2

This is the repository contract for one adaptive-plan review record in a pull request. It
applies the authoritative repo code standard and human review guide; it does not define a
second code standard.

Production code is the primary design artifact; tests are secondary evidence. Automation
validates evidence and freshness; it does not approve semantic quality or retained legacy.

## Record lifecycle

The pull request body ends with exactly one `pr-human-review-record-v2` JSON fence. The
visible fields bind directly to this metadata. Placeholder evidence is invalid.

- The initial architecture review records the goal, acceptance criteria, capability-tree
  hypothesis, canonical owners and entries, and first two slices. A separate fresh reviewer
  supplies the verdict before implementation publication.
- The checkpoint review contains only the current adaptive-plan digest. It links to the
  rolling plan judgments without copying milestone narratives into the pull request.
- The complete code, structure, tests, and legacy review is required before readiness. A
  fresh reviewer verifies declared outcomes, every declared owner-to-result path,
  navigation evidence, test evidence, compatibility evidence, proportional validation,
  touched-file standards closure, legacy closure, and all correctness, safety, contract, and
  structural findings.

Only the final review gates readiness: it must pass with zero unresolved Critical or
Important findings.

### Initial architecture review

The fresh reviewer challenges the plan hypothesis and first horizon before implementation.
Its immutable stage verdict may remain `changes-requested` while the pull request is a draft;
adaptive-plan checkpoints decide whether implementation may progress. This preserves honest
review history instead of rewriting an earlier verdict after the plan changes.

### Current checkpoint review

This section contains only the current adaptive-plan digest.

### Complete code, structure, tests, and legacy review

The fresh final reviewer follows every declared capability from owner and entry to result.
Its required `finalReview.touchedFileStandardsClosure` string has exact visible-field
agreement and confirms every changed human-authored code file reviewed in full, recursive
modified-support-file remediation complete, and every remaining signal is a demonstrated false
positive or linked human-approved exception.

## Content-sensitive freshness

Initial and checkpoint evidence bind to canonical adaptive-plan record digests. Final
freshness binds all of these values:

- the build-affecting tree digest;
- the current plan goal;
- the current acceptance criteria; and
- the current structural decision.

The build-affecting tree includes authored code, tests, scripts, examples, workflows,
package metadata, lockfiles, plugin or agent contracts, active plans, and this review
contract. Unrelated documentation changes do not invalidate final-review evidence when
those four bound values are unchanged. A new commit SHA is not by itself invalidation.
The recorded final-review head must be an ancestor whose independently computed
build-affecting tree digest matches the current digest.

## Validator command and trust boundary

Run the deterministic read-only validator with explicit evidence:

```sh
npm run check:pr-human-review -- \
  --body path/to/pull-request-body.md \
  --changed-paths path/to/changed-paths.txt \
  --registry docs/production-legacy-exceptions.md \
  --reviews path/to/trusted-github-reviews.json \
  --merge-base <40-character-merge-base-sha> \
  --head <40-character-head-sha> \
  --draft true \
  --pr-author <pull-request-author-login> \
  --plan plans/current-plan.md
```

The `pull_request_target` workflow executes trusted base-branch code, fetches candidate Git
objects as data, reads the candidate plan and registry with `git show`, and reads GitHub
reviews through the read-only API. It never checks out or executes candidate code.

Existing open pull requests migrate on their next synchronization. A synchronized v1 body
is rejected; there is no v1 parser, compatibility validator, or transition mode. The
introducing pull request is the sole bootstrap exception because `pull_request_target`
cannot execute its own candidate replacement. It records the same fresh initial and final
reviews outside the unavailable base-branch v2 gate.

## Scope and exemptions

Plan-, documentation-, and agent-guidance-only pull requests may use the explicit exemption
only when no production, test, script, workflow, package metadata, or runtime files changed.
The exemption path set must exactly equal the observed changed paths. Mixed changes require
the full record. Plan-only scope includes implementation-plan Markdown and canonical
`plans/<plan-id>.closure.json` receipts. Adaptive governance authenticates the receipt against
the deleted base record and generated registry transition; the exemption validates only its path.

## Exact legacy candidate evidence

Run `npm run review:legacy -- <merge-base> <review-head>` for each initial and final stage.
The supplied ledger must equal the exact candidate report: no stale, extra, duplicate, or
missing IDs, and its count must equal the covered set. Each item uses `classification:
legacy` and one of `removed`, `minimized-boundary`, `resolved`, or
`retained-pending-human-approval`; a heuristic false positive uses `classification:
not-legacy` with a concrete rationale.

Large false-positive sets may use `notLegacyAggregate` with the report candidate count,
whole `REPORT-SHA256`, a workflow artifact or committed evidence file, and a concrete
rationale. The stage validator recomputes the report and rejects a digest or count mismatch.
Every legacy item remains individually listed.

## Trusted retained-legacy approval

The visible final ledger is the canonical approval projection. Each retained item includes
its exact path and symbol, purpose, current consumer, unsafe-removal reason, minimization,
canonical implementation owner, compatibility tests, named owner, review/removal condition,
and approved production SHA.

Silence, an issue, an earlier plan approval, agent judgment, or automation is not approval.
Only a trusted human GitHub approval by an authorized reviewer who is not the pull request
author may retain an item. The review binds the production SHA, complete sorted legacy IDs,
and whole-ledger SHA-256. The durable registry records the immutable review provenance. A
later non-registry production change invalidates that approval.

## Automation boundary

Automation verifies record shape, visible/metadata agreement, adaptive-plan and build-tree
freshness, owner coverage, unresolved counts, exact candidate reports, registry agreement,
and trusted review provenance. It never supplies architectural judgment, approves semantic
quality, or decides whether legacy should remain.
