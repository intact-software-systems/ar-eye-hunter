# Repository structure navigation map

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "scripts/repo-structure-check.mjs",
    "symbol": "readInput"
  },
  "results": [
    {
      "path": "scripts/repo-structure-check.mjs",
      "symbol": "printResult"
    }
  ],
  "failures": [
    {
      "path": "scripts/repo-structure-check.mjs",
      "symbol": "toError"
    }
  ]
}
```

[scripts/repo-structure-check.mjs#readInput](../repo-structure-check.mjs#readInput) accepts only an
optional `--base <git-ref>`. The default is `origin/main`. It calls
[repository-structure-check.mjs#checkRepositoryStructure](./repository-structure-check.mjs#checkRepositoryStructure),
which reads the current changed tree and returns deterministic, sorted review findings. It never
reads a plan, chooses folder structure, contacts GitHub, or writes repository state.

## Control-flow families

- [repository-files.mjs#readRepositoryFiles](./repository-files.mjs#readRepositoryFiles) inventories
  authored code and compares the current worktree with the merge base. Generic changed paths come
  from `scripts/repository-changes/read-git-changes.mjs`; token-aware comparison distinguishes
  material edits from unchanged or token-equivalent moves.
- [repository-structure-check.mjs#collectSingletonFindings](./repository-structure-check.mjs#collectSingletonFindings)
  and
  [repository-structure-check.mjs#collectRedundantChainFindings](./repository-structure-check.mjs#collectRedundantChainFindings)
  report changed topology. Canonical repository-style facts add changed density, prefix-cluster,
  and changed-file-size pressure.
- [structure-exceptions.mjs#readStructureExceptions](./structure-exceptions.mjs#readStructureExceptions)
  reads the optional durable `docs/repo-structure-exceptions.json` registry. Entries contain only
  the rule, target, owner, and review/removal condition. No review ID, commit SHA, plan ID, receipt,
  or network lookup is accepted.

Findings are PR review information and the command still exits successfully after printing them.
Malformed input, unsafe filesystem state, invalid Git bases, and malformed exception registries
fail closed with status 2. The agent decides whether to keep, split, move, or consolidate and
explains material judgment in the pull request. Mirrored semantic tests live under
`packages/tests/repo/repo-structure-check/` and run with `npm run test:repo-structure`.
