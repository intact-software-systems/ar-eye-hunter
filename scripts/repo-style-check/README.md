# Repository style checkers

[scripts/repo-style-check.mjs](../repo-style-check.mjs) scans TypeScript and prints style findings.
The full-repository run is warning-only: findings are review prompts, and the command exits 0 while
they remain. [scripts/check-changed-repo-style.mjs](../check-changed-repo-style.mjs) compares a
branch with its merge base. That comparison is the gate that can fail.

The human review sequence and the rule list live in
[docs/repo-human-style-guide.md](../../docs/repo-human-style-guide.md). Split and move manifests
are JSON files in `plans/repo-style-lineages/`, read by
[structural-lineage.mjs](./structural-lineage.mjs).

## Commands

From the repository root:

```bash
npm run check:repo-style
npm run check:repo-style:changed -- origin/main
```

`check:repo-style` scans `apps/**` and `packages/**`. Pass `--root <path>` to scan another tree,
including `--root .` for production support code. The printed list stops at 200 findings; the
summary keeps the full count. `--strict` fails the command. There is no global strict mode.

`check:repo-style:changed` requires a base ref. The optional target must be the checked-out `HEAD`.
Omit it to scan the worktree:

```bash
node scripts/check-changed-repo-style.mjs <base-ref> [HEAD|WORKTREE]
```

Focused warning-only reports:

```bash
npm run check:repo-style:layout
npm run check:repo-style:layout-details
npm run check:repo-style:construction-details
npm run check:repo-style:navigation-details
npm run check:repo-style:output-contracts
npm run check:repo-style:object-interfaces
npm run check:repo-style:src
```

Direct tests:

```bash
npx vitest run packages/tests/repo/repo-style-check.test.ts
npx vitest run packages/tests/repo/repo-style-changed-check.test.ts
```

## Shared lexer

`maskNonCodeText` in [source-text.mjs](./source-text.mjs) is the one walker for comments, strings,
templates, and regexes. `maskNonCodeLines` joins lines, masks them, and splits them again. Masked
spans become spaces of the same width, so columns and offsets stay aligned.

The walker masks:

- a `//` comment through the end of its line
- a `/* */` block comment, including a closer whose `*` and `/` sit on different lines
- single-quoted and double-quoted strings; an unpaired quote returns to code at the next newline,
  and a line that ends in an odd number of backslashes keeps the string open
- template text, while a `${ ... }` expression is scanned as code
- a regex literal where `/` can start one, including the character class, so a quote or `//` inside
  the regex stays masked

These scans read through that mask:

- `findUnknownUsages` in [contract-rules.mjs](./contract-rules.mjs)
- `extractCommandTypesWithOptionalFields` in the same file
- `findOptionalFields` in [factory-route-rules.mjs](./factory-route-rules.mjs)
- `findRuntimeMemberEntries` in [type-organization-rules.mjs](./type-organization-rules.mjs)
- `findMatchingBrace` in [source-text.mjs](./source-text.mjs), which counts only braces the mask kept

## Touched files

Other rules fail when a finding is new or worsened against the merge base. `boundary.unknown` and
`construction.forward-capture` also fail when a file in the diff still carries either finding,
including one that already existed on the base. A file the diff leaves untouched keeps the
new-or-worsened comparison. A structural-lineage target keeps that comparison too: inherited
findings are judged against the source file, and only growth fails.

`boundary.unknown` keys include the symbol. A file whose total `boundary.unknown` magnitude stays
within the merge-base total has moved `unknown` between symbols inside that total. The touched-file
rule still fails the file while either finding remains.

High-confidence `navigation.registration-indirection` and `navigation.unnamed-deferred-edge`
findings still fail only when they are new or worsened in changed product code under `apps/**` or
`packages/**`.

A reviewed disposition in [reviewed-dispositions.mjs](./reviewed-dispositions.mjs) can drop an exact
path, rule, and symbol match before the gate exits. Both sides of the comparison are scanned with
the checker at `HEAD`.
