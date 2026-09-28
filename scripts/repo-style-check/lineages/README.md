# Structural lineage manifests

The changed-style gate, `scripts/check-changed-repo-style.mjs`, fails a branch for new or worsened
findings against its merge base. When a branch moves code out of one file into other files, the
findings that travel with the code would count as new. A lineage manifest declares where that code
came from, so the gate compares the new files with the findings their source file already had.

[structural-lineage.mjs](../structural-lineage.mjs) reads every `*.json` file in this directory,
nested folders included, from the tree the gate is checking. A manifest anywhere else is not read.

This directory is normally empty apart from this file.

## When to write a manifest

Write one for a split or a move that Git does not report as a rename. The gate already follows a
rename that Git detects, and it rejects a manifest target that Git also reports as a rename.

## Format

```json
{
  "version": 1,
  "lineages": [
    {
      "mergeBase": "<full commit ID>",
      "source": {
        "path": "packages/example/legacy-owner.ts",
        "blob": "<full blob ID>"
      },
      "targets": [
        "packages/example/first-owner.ts",
        "packages/example/second-owner.ts"
      ]
    }
  ]
}
```

- `mergeBase` is the merge base of the branch and its base branch:
  `git merge-base origin/main HEAD`.
- `source.path` is the file the code left. It must exist at the merge base.
- `source.blob` is that file at the merge base: `git rev-parse <mergeBase>:<source.path>`.
- `targets` are the files that now hold the code. Each one must exist on the branch and must differ
  from the source.
- Every path names production code and is relative to the repository root.
- A source has one entry for each merge base. A target belongs to one entry.
- No other keys are accepted.

The gate reads every manifest on each run. A malformed manifest stops the gate with exit status 2
and a list of every problem found, even when none of its entries applies to the branch.

## What an entry changes

- The source and its targets share the findings the source had at the merge base. Each of those
  findings is matched once, so two targets cannot both inherit the same one.
- `boundary.unknown` occurrences are counted as one pool. The source and its targets together may
  hold as many as the source held at the merge base.
- A layout finding stays with the path of the target. A new filename is judged as a new filename.

## Lifetime

An entry applies only while the merge base of the branch equals its `mergeBase`.

- The base branch moving ahead does not change the merge base. The entry still applies.
- Merging the base branch into the branch, or rebasing onto it, moves the merge base. Set
  `mergeBase` to the new merge base and `source.blob` to the source file at that commit.
- When the pull request merges, the entry is spent. A branch cut from `main` afterwards has a newer
  merge base, so the entry can never apply to it.

## Retirement rule

An entry is spent when its `mergeBase` is not the merge base of the branch. On a branch cut from
`main`, that is every entry `main` already holds.

- A pull request that adds or changes a manifest also deletes every spent entry, and every file
  that holds no other entry.
- Any other pull request may delete them.
- The pull request that adds an entry cannot delete it. The gate needs the entry on the commit that
  merges.
- A merged pull request creates no cleanup task. The next pull request that works in this directory
  does the cleanup.

List the manifests that hold no entry for the branch with:

```sh
grep -rL --include='*.json' "$(git merge-base origin/main HEAD)" scripts/repo-style-check/lineages
```

Git history keeps what is deleted.
