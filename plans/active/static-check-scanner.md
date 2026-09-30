# Static check scanner

The comment-masking fix already on this pull request stays. This spec is the next
work on the same branch. Landing this file does not rewrite the scanners.

The red release gate on the earlier run is an ALM Playwright smoke failure. It
does not use this scanner, and it is out of scope. The duplicated validators in
`packages/shared/api/group-state-delta.ts` are product code, and they are out of
scope too.

## Slice 1 — one lexer

One walker in `scripts/repo-style-check/source-text.mjs` owns strings, templates,
`//`, and `/* */`. It replaces the separate walks that disagree today.

`findUnknownUsages` in `scripts/repo-style-check/contract-rules.mjs` already
masks comments inside `codeTextStep` and no longer splits on `//`. Fold that
mask into the shared walker. The other three splits stay, and they are the
remaining copies:

- `extractCommandTypesWithOptionalFields` at line 108 of
  `scripts/repo-style-check/contract-rules.mjs`
- `findOptionalFields` at line 151 of
  `scripts/repo-style-check/factory-route-rules.mjs`
- `findRuntimeMemberEntries` at line 128 of
  `scripts/repo-style-check/type-organization-rules.mjs`
- `findMatchingBrace` in `scripts/repo-style-check/source-text.mjs`, which
  currently treats `{` and `}` inside strings and comments as real braces

Tests in `packages/tests/repo/repo-style-check.test.ts` assert the finding line.
A bare `toContain('[boundary.unknown]')` is not enough. Cases:

- A possessive inside a block comment (`mutation's`) does not hide a later
  `unknown`
- `unknown` inside a block comment is not a finding
- A regexp containing `//` does not delete the rest of the line, and `unknown`
  inside a regexp is not a finding
- A backslash-continued string is not reset to code at the newline
- `*/` split across lines still closes the comment

Direct check: `npx vitest run packages/tests/repo/repo-style-check.test.ts`.
Affected package check:
`npx vitest run packages/tests/repo/repo-style-changed-check.test.ts`.

## Slice 2 — changed-range matching

In `scripts/check-changed-repo-style.mjs`, `findingVariant` maps every
`... and N additional` line to the same key `summary`. Match `boundary.unknown`
on the symbol, or compare the file's total magnitude, so moving `unknown`
between symbols is not reported as growth.

For the two test-enforced rules (`boundary.unknown` and
`construction.forward-capture`), any occurrence in a touched file fails.
Untouched files stay warning-only. Both sides of a pull request are scanned
with the HEAD checker, so the comment fix will not fail existing debt by
itself. This rule is what makes a later edit of
`packages/shared/api/group-state-delta.ts` report its hidden `unknown`
parameters.

Direct check:
`npx vitest run packages/tests/repo/repo-style-changed-check.test.ts`.
The affected-package run is the same as slice 1.

## Later, not in the next two slices

- Stop scanning the whole tree twice in `toBaseSources`. Scan the diff for
  per-file rules.
- Take `npm run check:repo-style:navigation-details` off the blocking lane in
  `.github/workflows/release-gate.yml`. It always exits 0.
- Stop flagging `Controller`, `Gateway`, and `Facade` in `service.name`.
- See a `*Command` type whose `{` is not on the same line.
- When only the checker changes, publish an old-versus-new finding list as a
  CI artifact.
- A rule that `validateXxx` must not throw is a new check, separate from the
  lexer.

## Closure

Each implementation slice reviews every touched script and its tests in full.
Files that remediation pulls in enter the same closure. Untouched product code
stays outside it.
