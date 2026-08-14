# Validation evidence navigation map

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "scripts/validation-evidence.mjs",
    "symbol": "runValidationEvidenceCommand"
  },
  "results": [
    {
      "path": "scripts/validation-evidence/validation-evidence-selection.mjs",
      "symbol": "selectReusableValidationEvidence"
    },
    {
      "path": "scripts/validation-evidence/validation-evidence-record.mjs",
      "symbol": "createValidationEvidence"
    },
    {
      "path": "scripts/validation-evidence/branch-release-result.mjs",
      "symbol": "validateBranchReleaseConclusion"
    }
  ],
  "failures": [
    {
      "path": "scripts/validation-evidence.mjs",
      "symbol": "toError"
    }
  ]
}
```

[scripts/validation-evidence.mjs#runValidationEvidenceCommand](../validation-evidence.mjs#runValidationEvidenceCommand)
is the only command entry. It owns three explicit operations: `select` either earns reuse or
falls back to broad validation, `create` writes evidence after broad validation, and `conclude`
produces one stable Branch Release Gate result for either successful route.

## Control-flow families

- Build-tree digest computation remains owned by
  [build-affecting-tree.mjs#computeBuildAffectingTreeDigest](./build-affecting-tree.mjs#computeBuildAffectingTreeDigest).
  Selection and creation call that fact contract directly; this capability has no second path
  classifier.
- Trusted prior-run validation starts at
  [github-validation-evidence.mjs#readGithubWorkflowRuns](./github-validation-evidence.mjs#readGithubWorkflowRuns),
  downloads only the named v2 artifact. Then
  [validation-evidence-selection.mjs#selectReusableValidationEvidence](./validation-evidence-selection.mjs#selectReusableValidationEvidence)
  checks the exact pull request, base, source branch, repository, workflow run, lifetime, ancestry,
  and digest facts.
- Evidence production starts at
  [validation-evidence-record.mjs#createValidationEvidence](./validation-evidence-record.mjs#createValidationEvidence).
  The PR workflow uploads the transient artifact only after its broad Release Gate succeeds.
- Branch-workflow convergence ends at
  [branch-release-result.mjs#validateBranchReleaseConclusion](./branch-release-result.mjs#validateBranchReleaseConclusion).
  It accepts either trusted reuse with broad jobs skipped or successful broad validation plus
  fresh evidence publication, giving branch protection one unambiguous result. It accepts no App,
  receipt, or external deviation input.

The v2 artifact lifetime is seven days and reuse is limited to earlier successful runs of the same
PR. Missing, malformed, expired, untrusted, cross-PR, non-ancestor, or digest-mismatched evidence
never skips broad validation. The artifact stays in GitHub Actions and is never copied into the PR,
branch, plan, or agent input. Deterministic tests inject GitHub run envelopes and downloaded
artifacts without network access.
