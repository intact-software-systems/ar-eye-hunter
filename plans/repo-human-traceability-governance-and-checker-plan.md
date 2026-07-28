# Repository Human Traceability Governance And Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Use
> `rallar-repo:publishing-plan-progress` for publication and progress tracking,
> `rallar-repo:rallar-code-writing` for checker code, and
> `rallar-repo:rallar-testing` for validation selection. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Establish the repository-organization and filename rules that make
TypeScript easier to locate and trace, then expose existing structural debt
through reviewable, warning-only checker output without changing production
behavior or enabling a build gate.

**Architecture:** Keep one authoritative prose standard and one human review
guide. Extend the existing checker with a focused repository-layout scanner
that receives an exact TypeScript projection from the same load-once,
already-filtered production inventory used by file-level rules. Default layout
checks use conservative, grouped warnings; syntax- and domain-sensitive checks
are opt-in until their false-positive rate is known.

**Tech Stack:** Markdown, Node.js ESM, the directly declared `@babel/parser`
for TypeScript/TSX syntax AST inspection, npm scripts, Vitest, Prettier, and
the existing `scripts/repo-style-check.mjs` command.

**2026-07-28 execution amendment:** The human approved using the repository's
directly declared `@babel/parser` for the Tasks 2 and 3 TypeScript/TSX syntax
AST inspection because TypeScript `7.0.2` no longer exports the classic
in-process parser. TypeScript remains `7.0.2`; this changes neither
`package.json` nor a lockfile. This narrow parser substitution leaves every
other requirement in approved plan blob
`8ee56ac27189f9bed751fb6a95992830bda6be60` unchanged.

## Global Constraints

- This plan implements Wave 0 of the
  [Repository Human Traceability Refactoring Program](repo-human-traceability-refactoring-program-plan.md)
  only.
- Drafting, approval, execution, publication, and completion handoffs follow
  the [Repository Human Traceability Program Execution Plan](repo-human-traceability-program-execution-plan.md).
  That execution protocol does not itself approve this child plan.
- Do not modify production code under `apps/**` or production package code
  under `packages/**`.
- Allowed code changes are limited to the repository checker under `scripts/**`
  and its tests under `packages/tests/repo/**`.
- Do not move or rename production files. Do not update production imports,
  exports, public contracts, OpenAPI, persistence, runtime behavior, or config.
- The authoritative TypeScript standard remains
  `.agents/skills/rallar-code-writing/references/repo-code-style.md`.
- Code is written first for human developers. Correctness, safety, security,
  compatibility, and required performance remain non-negotiable; within those
  constraints, human understandability is the governing design criterion.
- Applying a mechanical rule is not success when it makes ownership, dataflow,
  decisions, side effects, failures, or call paths harder for a human to follow.
- The standard applies repo-wide. Tests and support tooling are not exempt from
  human review even though the production checker excludes them by default.
- All new checker findings remain warnings and exit with status `0`.
- `--strict` remains unavailable, exits with status `1`, and is not added as an
  npm script or CI gate.
- Default checks must be conservative. Primary-export and room/group-state
  checks remain opt-in through `--layout-details`.
- Folder density and prefix findings are ownership review prompts. They must
  never instruct an agent to create folders or pass-through modules
  mechanically.
- Preserve the current production-source exclusions for tests, specs, mocks,
  fixtures, stories, generated files, and test-runner configuration.
- Preserve unrelated working-tree changes. Stage only files named by the active
  task.
- Do not commit or push from `main`, `master`, or the local default branch. Plan
  execution starts on a fresh, descriptively named `codex/` branch from current
  `origin/main` unless the human explicitly chooses another non-default branch.
- A completed implementation still requires the repository completion and
  publication gates stated in `AGENTS.md`.

---

Date: 2026-07-28

Status: Explicitly approved for execution at Git blob
`8ee56ac27189f9bed751fb6a95992830bda6be60` and in progress on
`codex/repo-human-traceability-governance-checker-wave-0`. Governance work has
started; production code remains unchanged and checker behavior has not yet
changed.

Publication and prerequisite reconciliation:

- The human approved exactly this governance and warning-only checker child-plan
  revision on 2026-07-28. The approval does not extend to a later production
  child plan.
- The implementation branch was created from current `origin/main` and
  published at `09f4e8d7b1eb3e7a02560dc6060238bf739a03a1` before checker
  implementation began. The focused governance baseline passed 81 of 81 tests.
  The unrestricted full unit baseline passed 5,534 tests with 18 skipped.
- Draft pull-request creation remains unavailable: the GitHub connector returned
  HTTP 403 and local `gh` authentication is invalid. The branch is published,
  and the draft PR remains a required publication-envelope prerequisite rather
  than evidence of implementation completion.

- Live GitHub `main`, local `main`, and local `origin/main` resolve to
  `4ec117db1e09e00f86ed8f66cbf8adab1cdeb4a9`. That commit adds only the three
  human-traceability plan documents and has no associated pull request.
- GitHub PR #45 merged as
  `95065d769f585464b15059423057e151877fdb1a`. Its five-file diff added the
  primary human-understandability principle and integrity coverage to
  `AGENTS.md`, the code-writing skill, the canonical standard, the human guide,
  and `repo-code-style-integrity.test.ts`.
- Current-tree verification passes with 81 tests across
  `rallar-skill-integrity.test.ts`, `repo-code-style-integrity.test.ts`, and
  `repo-style-check.test.ts`; the focused code-writing checker and Prettier
  checks also pass. The complete current checker still reports exactly 4,462
  non-blocking findings and exits `0`.
- PR #45 did not add the organization/naming sections, layout rules, CLI modes,
  executable baseline, or child-plan completion evidence. Those remain pending.
- For the plan publication commit, **Run Hetzner Supported Distributed
  Manifests** run `30328273358` failed. **Push on main** run `30328273160` and
  **Deploy Web + API** run `30328273405` passed. Publication is verified, but
  the mandatory default-branch completion workflow is not green for that SHA.
- GitHub's combined commit status separately reports failed deployment contexts
  for `rallar-bb-server`, `relic-hunters`, and `rallar-server`. This
  documentation-only reconciliation records but does not diagnose them.

## 1. Scope And Success Boundary

This child plan defines governance and visibility before any production tree is
moved. It succeeds when a human can answer these questions from the standard,
review guide, and checker output:

1. Which feature owns this file?
2. Where is the obvious starting file for the feature?
3. Does the filename identify the primary exported capability?
4. Are contracts, translators, factories, persistence code, and tests beside
   the feature that owns them rather than in global technical buckets?
5. Is a dense directory hiding several feature clusters?
6. Is browser `room` vocabulary translated to authoritative `group-state` at
   the one named boundary?
7. Did an active migration add structural debt relative to its recorded
   baseline?

This plan does not decide how any production feature is moved. The browser,
shared-server, and API-v1 group-state moves remain separate child plans.

## 2. Planning Baseline

The following read-only audit used the current checker's production exclusions
and counted TypeScript extensions `.ts`, `.tsx`, `.mts`, and `.cts` under
`apps/**` and `packages/**`. It is a planning baseline, not an enforcement
threshold and not evidence that each warning requires a change.

| Measure                                                      |       2026-07-28 baseline | Meaning                                                                                      |
| ------------------------------------------------------------ | ------------------------: | -------------------------------------------------------------------------------------------- |
| Production TypeScript files                                  |                     1,372 | Files eligible for layout analysis.                                                          |
| Existing default style findings                              |                     4,462 | Current file-level checker findings; output is capped at 200.                                |
| Files over 400 physical lines                                |                       215 | Existing checker debt.                                                                       |
| Directories with more than 20 direct TypeScript files        |                        16 | Ownership review prompts.                                                                    |
| Candidate feature-prefix clusters in those dense directories |   22 across 8 directories | Initial conservative prefix heuristic.                                                       |
| Non-kebab TypeScript filenames                               | 422 across 90 directories | Excludes exact tool-discovered config names.                                                 |
| Exact generic filenames                                      |                        15 | `utils`, `types`, `helpers`, `contracts`, `runtime`, or `middleware` without a feature noun. |
| Route modules exporting generic `init`                       |                        11 | All currently under API-v1.                                                                  |
| Existing approved `mod.ts` compatibility boundaries          |                        14 | Current package or published subpath entry points.                                           |
| `mod.ts` outside that approved set                           |                         0 | A ratchet against new nested barrels.                                                        |

The initial implementation must regenerate these measures. If the production
tree changed after this draft, record both the new count and the reason for the
difference; do not alter a checker threshold merely to reproduce this table.

The two optional checks do not yet have authoritative baseline counts:

- primary exported symbol versus filename;
- room/group-state boundary vocabulary.

Task 5 records those counts after the parser-backed rules exist. Their first
inventory remains opt-in regardless of count.

## 3. Locked Checker Semantics

### 3.1 Commands

The implementation adds these commands:

```bash
npm run check:repo-style:layout
npm run check:repo-style:layout-details
```

They expand to:

```json
{
  "check:repo-style:layout": "node scripts/repo-style-check.mjs --layout-only",
  "check:repo-style:layout-details": "node scripts/repo-style-check.mjs --layout-only --layout-details"
}
```

`npm run check:repo-style` continues to run all current file-level warnings and
also the conservative default layout rules. `--layout-only` suppresses existing
file-level rules so structural warnings remain reviewable despite the current
4,462-warning debt. `--layout-details` adds noisy rules; it does not imply
strictness and does not change the exit status.

### 3.2 Stable rule identifiers and counts

Every layout finding has a stable rule identifier and an affected-item count:

| Rule ID                                | Default | Unit counted |
| -------------------------------------- | ------- | ------------ |
| `layout.directory-density`             | yes     | directories  |
| `layout.feature-prefix-cluster`        | yes     | clusters     |
| `layout.filename-style`                | yes     | files        |
| `layout.generic-filename`              | yes     | files        |
| `layout.generic-route-init`            | yes     | files        |
| `layout.unapproved-mod`                | yes     | files        |
| `layout.primary-export-name`           | opt-in  | files        |
| `layout.browser-room-boundary`         | opt-in  | files        |
| `layout.server-group-state-vocabulary` | opt-in  | files        |

High-volume findings are grouped by directory, but the summary adds their
`affectedCount` values. For example, one displayed filename warning may account
for 27 files. This keeps output readable without concealing the debt measure.

### 3.3 Exact default rules

The default scanner applies these rules only to the already-filtered production
TypeScript source set:

- Warn once per directory when it contains more than 20 direct TypeScript
  files. The message says to review ownership and explicitly says not to create
  folders mechanically.
- In a directory already above 20 direct files, warn for each meaningful
  filename prefix represented by at least four direct files. Emit one finding
  per qualifying prefix cluster with `affectedCount: 1`; the message records
  the cluster's direct-file count and at most five sorted sample filenames.
  Counts therefore measure clusters, not the number of files in clusters.
- Derive a file's candidate prefix by converting its suffix-free stem with
  `toKebabCase`, splitting on `-`, and removing ignored tokens only while they
  are leading tokens. The complete ignored-token set is `app`, `api`,
  `browser`, `cached`, `compute`, `create`, `default`, `rallar`, `read`,
  `register`, `server`, `shared`, `to`, `use`, `v1`, `v2`, `validate`, and
  `write`. The first remaining token is the candidate; a file with no remaining
  token has no candidate. Do not remove ignored tokens from the middle or end.
- Compare the candidate with the exact tokens of the immediate directory
  basename after the same `toKebabCase` conversion and `-` split. Suppress the
  cluster only for an exact token match. Do not stem, singularize, pluralize,
  or compare with ancestor-directory tokens. A file contributes at most once
  to one cluster. Sort directories and prefixes lexicographically before
  creating findings.
- Require kebab-case TypeScript stems. Normalize `.d.ts` as one suffix. Group
  non-kebab files by directory and print at most five sample names per warning.
- Accept only the exact ecosystem-discovered filenames `vite.config.ts` and
  `prisma.config.ts` in the production source set. Test-runner configs continue
  to be excluded before layout analysis. New filename exceptions require human
  approval and a fixture test.
- Warn for exact stems `utils`, `types`, `helpers`, `contracts`, `runtime`, and
  `middleware`. A descriptive filename such as
  `group-state-service-contracts.ts` does not warn.
- In files named `*-route.ts` or `*-routes.ts`, warn when the exported route
  registration function is exactly `init`. `initGroupStateRoutes` and
  `registerGroupStateRoutes` do not warn, although the canonical preferred name
  is `registerGroupStateRoutes`.
- Permit `mod.ts` only at the 14 paths present in the planning baseline. Keep
  that set in one visibly named constant in `layout-rules.mjs`. Adding an entry
  requires explicit human approval; discovering another current path is not an
  automatic reason to approve it.

### 3.4 Exact opt-in rules

`--layout-details` adds these parser-backed heuristics:

- A primary-export mismatch warns only when a file has exactly one unique,
  named, directly exported top-level function, class, interface, type alias,
  enum, or variable declaration. Convert the symbol mechanically to kebab-case
  and compare it with the file stem. Skip `mod.ts`, `index.ts`, exact tool config
  names, anonymous defaults, re-export-only files, and files with zero or more
  than one candidate. This deliberately prefers false negatives over guessing
  which of several exports is primary.
- A browser room boundary warning applies to room-owned files under
  `packages/shared-web/browser/**`, identified by a `room` or `rooms` filename
  token after `toKebabCase` and `-` splitting of the suffix-free stem, or by an
  exact repo-relative prefix of `packages/shared-web/browser/rooms/`. Outside
  the exact repo-relative path
  `packages/shared-web/browser/rooms/room-group-state-translation.ts`, inspect
  only static `ImportDeclaration` nodes whose module specifier exactly equals
  one of the following three strings. A named import is authoritative only
  when its original exported name is in the corresponding set:

  | Exact module specifier             | Authoritative original exported names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
  | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `@shared/api/group-types.ts`       | `Group`, `GroupEvent`, `GroupEventType`, `GroupJoinMode`, `GroupMember`, `GroupMemberStatus`, `GroupPresenceAdmission`, `GroupPresenceAdmissionSession`, `GroupPresenceSession`, `GroupPresenceSummary`, `GroupRole`, `GroupSnapshot`, `GroupStateCausalRevision`, `GroupStatus`                                                                                                                                                                                                                                                          |
  | `@shared/api/state-types.ts`       | `AcceptGroupInviteRequest`, `AppointGroupDirectorRequest`, `BanGroupMemberRequest`, `ConnectGroupPresenceSessionRequest`, `CreateGroupInviteRequest`, `CreateGroupRequest`, `DisconnectGroupPresenceSessionRequest`, `GroupJoinCodeResponse`, `HeartbeatGroupPresenceSessionRequest`, `JoinGroupRequest`, `RemoveGroupMemberRequest`, `RevokeGroupInviteRequest`, `RotateGroupJoinCodeRequest`, `SetGroupMemberRoleRequest`, `TransferGroupOwnershipRequest`, `UnbanGroupMemberRequest`, `UpdateGroupRequest`, `UpsertGroupMemberRequest` |
  | `@shared/api/state-event-types.ts` | `StateEventCursor`, `StateEventPage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

- For `import { GroupSnapshot as RoomSnapshot }`, classify
  `GroupSnapshot`, not the local alias `RoomSnapshot`, and show both names in
  diagnostic evidence. Exact original imported names `GroupRef` and `roomRef`
  are exempt before set lookup. A namespace import or default import from any
  of the three exact modules warns because it exposes an opaque authoritative
  surface that cannot be classified by named import; report it as
  `namespace:* as <local>` or `default as <local>`. A side-effect-only import,
  dynamic import, re-export, relative module path, or same-named import from any
  other module does not warn. Emit at most one warning per room-owned file with
  sorted, deduplicated import evidence. The rule reports direct coupling only;
  it does not claim to prove all structural construction.
- A server group-state vocabulary warning applies to files with a
  `group-state` filename token, a `GroupState` exported declaration, or
  placement under `packages/shared-server/rallar-system/group-state/**`. Warn
  when a declared identifier contains the whole token `room` or `rooms`, except
  exact established protocol identities `GroupRef` and `roomRef`. Ignore
  comments, strings, and imported identifiers.

The room/group-state rule is a migration guard, not a public-contract rewrite.
It does not authorize renaming `GroupRef`, `roomRef`, or the current
`RallarRoomsFacade` return types.

### 3.5 Strict enforcement remains a separate decision

This plan does not implement strict mode. A later proposal may nominate a
specific mechanical rule only after a human reviews 100 warnings, or every
warning when fewer exist, and finds no more than five percent false positives.
Actively migrated features must also have stable focused checks and the
repository must have no unexplained warning growth across three completed
feature migrations. The human then decides whether that one rule should block;
semantic ownership and traceability judgments remain manual.

## 4. File Responsibility Map

| File                                                               | Change                  | Single responsibility                                                                        |
| ------------------------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------- |
| `AGENTS.md`                                                        | Verify                  | PR #45 already published the always-loaded primary code goal and route to the standard.      |
| `.agents/skills/rallar-code-writing/SKILL.md`                      | Verify                  | PR #45 already published the primary principle as required TypeScript agent behavior.        |
| `.agents/skills/rallar-code-writing/references/repo-code-style.md` | Modify                  | Authoritative feature ownership, co-location, filename, symbol, and domain vocabulary rules. |
| `docs/repo-human-style-guide.md`                                   | Modify                  | Human navigation review sequence and checker commands.                                       |
| `scripts/repo-style-check/layout-rules.mjs`                        | Create                  | Pure repository-layout aggregation and TypeScript syntax heuristics over supplied sources.   |
| `scripts/repo-style-check.mjs`                                     | Modify                  | CLI flags, shared source loading, rule orchestration, and output summaries.                  |
| `package.json`                                                     | Modify                  | Warning-only layout scripts.                                                                 |
| `packages/tests/repo/repo-style-layout-rules.test.ts`              | Create                  | Direct unit tests for default and opt-in layout rules.                                       |
| `packages/tests/repo/repo-style-check.test.ts`                     | Modify                  | End-to-end CLI mode, exclusion, output, and exit-status tests.                               |
| `packages/tests/repo/repo-code-style-integrity.test.ts`            | Modify                  | Governance authority and package-script integrity assertions.                                |
| `.agents/skills/rallar-testing/SKILL.md`                           | Modify                  | Include the new repo-style test suite in focused validation.                                 |
| `.agents/skills/rallar-testing/references/test-commands.md`        | Modify                  | Include the exact new focused command.                                                       |
| `plans/repo-human-traceability-refactoring-program-plan.md`        | Modify at completion    | Record Wave 0 progress and measured baseline.                                                |
| `plans/repo-human-traceability-program-execution-plan.md`          | Modify during handoffs  | Record program publication and the exact next human approval boundary.                       |
| `plans/repo-human-traceability-governance-and-checker-plan.md`     | Modify during execution | Check off tasks and record exact evidence.                                                   |

`layout-rules.mjs` remains one cohesive module of at most 400 lines. It does not
read the filesystem, print output, parse CLI arguments, or decide process exit
status. Do not split it under this plan. If the exact rules cannot fit
cohesively, stop and revise this plan with the human instead of creating a
pass-through wrapper or generic `utils.mjs` module.

## 5. Module Interfaces

`scripts/repo-style-check/layout-rules.mjs` exports this contract:

```js
export const layoutLimits = Object.freeze({
  directTypeScriptFileCount: 20,
  featurePrefixFileCount: 4,
  displayedFileSampleCount: 5,
});

export const layoutRuleIds = Object.freeze({
  directoryDensity: 'layout.directory-density',
  featurePrefixCluster: 'layout.feature-prefix-cluster',
  filenameStyle: 'layout.filename-style',
  genericFilename: 'layout.generic-filename',
  genericRouteInit: 'layout.generic-route-init',
  unapprovedMod: 'layout.unapproved-mod',
  primaryExportName: 'layout.primary-export-name',
  browserRoomBoundary: 'layout.browser-room-boundary',
  serverGroupStateVocabulary: 'layout.server-group-state-vocabulary',
});

export function isLayoutTypeScriptFile(file) {}

/**
 * @param {{
 *   repoRoot: string,
 *   sources: readonly { file: string, raw: string }[],
 *   includeDetails?: boolean,
 * }} input
 * @returns {{
 *   findings: readonly {
 *     file: string,
 *     kind: 'warn',
 *     ruleId: string,
 *     affectedCount: number,
 *     message: string,
 *   }[],
 *   counts: Readonly<Record<string, number>>,
 * }}
 */
export function scanRepositoryLayout(input) {}

export function toKebabCase(value) {}
```

All incoming `file` paths are absolute. `repoRoot` is the absolute process
working directory and is used only to compare approved repo-relative paths.
`isLayoutTypeScriptFile` returns `true` only for `.ts`, `.tsx`, `.mts`, and
`.cts`, treating `.d.ts` as a TypeScript suffix, using the exact pattern
`/(?:\.d)?\.(?:ts|tsx|mts|cts)$/u`. The CLI supplies only this projection to
`scanRepositoryLayout`; the scanner applies the same exported predicate again
and ignores a non-TypeScript record if a direct caller supplies one. The
scanner sorts directories, prefixes, samples, findings, and summaries
lexicographically so identical input produces identical output.

### 5.1 Execution-Readiness Review And Resolution

The 2026-07-28 review found four material ambiguities. This revision resolves
them as plan contracts; the child still requires explicit human approval before
execution:

1. **Source inventory resolved.** Task 4 defines one sorted, filtered,
   load-once production inventory that preserves `.mjs` for current file-level
   checks. `isLayoutTypeScriptFile` supplies and defensively enforces the exact
   `.ts`/`.tsx`/`.mts`/`.cts` projection. The CLI fixture uses 21 direct `.mjs`
   files to prove they cannot trigger density or prefix counts while one
   overlong `.mjs` line still triggers an existing file-level warning.
2. **Prefix cardinality resolved.** Section 3.3 and Task 2 choose one finding
   per cluster with scalar `affectedCount: 1`, leading-only ignored-token
   removal, exact immediate-directory token comparison, and stable grouping and
   sorting. A generated eight-directory fixture produces exactly 22 qualifying
   findings and an affected count of 22.
3. **Browser classifier resolved.** Section 3.4 fixes three exact module
   specifiers, module-specific original-name sets, alias treatment,
   namespace/default behavior, and non-import exclusions. Task 3 covers all
   three modules, aliased imports, and both `GroupRef` and `roomRef` exemptions.
4. **Completion evidence resolved.** Task 6 and the execution protocol separate
   the immutable feature-branch tree from its PR/handoff publication envelope.
   Merge and default-workflow evidence are appended to that external envelope.
   A later evidence-only ledger branch records the completed implementation and
   has its own independently frozen tree and publication envelope; no commit is
   required to contain its own future merge SHA or workflow result.

Execution readiness is now a human review decision. No checker behavior is
approved or implemented by this revision.

## 6. Implementation Tasks

### Task 0: Confirm The Publishable Non-Default Branch

**Files:** No content changes.

**Interfaces:**

- Consumes: the approved child plan and current working tree.
- Produces: the intended non-default Wave 0 branch with unrelated user changes
  preserved.

- [x] **Step 1: Inspect the current branch and working tree**

  Run:

  ```bash
  git branch --show-current
  git status --short
  ```

  Expected: record every pre-existing modified and untracked path. As of this
  draft, `plans/rallar-rest-snapshot-read-convergence-implementation-plan.md`
  is an unrelated modified file and must not be staged by this plan.

- [x] **Step 2: Confirm or create and publish the implementation branch**

  Use `codex/repo-human-traceability-governance-checker-wave-0`, created from
  current `origin/main`, through the Codex branch action or the installed GitHub
  publication workflow. Direct plan publication created no reusable feature
  branch, and the PR #45 branch is absent from the remote, so execution creates
  this branch exactly once rather than searching for either historical branch.
  Do not commit or push the default branch.

- [x] **Step 3: Recheck scope**

  Run `git status --short` and confirm no file under `apps/**` or production
  package code under `packages/**` has been changed.

### Task 1: Add Authoritative Organization And Naming Governance

**Files:**

- Verify: `AGENTS.md`
- Verify: `.agents/skills/rallar-code-writing/SKILL.md`
- Modify:
  `.agents/skills/rallar-code-writing/references/repo-code-style.md`
- Modify: `docs/repo-human-style-guide.md`
- Modify: `packages/tests/repo/repo-code-style-integrity.test.ts`
- Modify: `plans/repo-human-traceability-governance-and-checker-plan.md`

**Interfaces:**

- Consumes: the master program's organization and naming rules plus the
  verified PR #45 prerequisite.
- Produces: one always-loaded primary principle, one operational agent rule,
  one authoritative prose definition for all checker rule names, and one human
  review sequence that later tasks can reference.

- [x] **Step 1: Verify the PR #45 prerequisite instead of repeating it**

  The 2026-07-28 reconciliation verified merge
  `95065d769f585464b15059423057e151877fdb1a` and its exact five-file diff.
  It also ran the current repository governance command and passed 81 tests
  across `rallar-skill-integrity.test.ts`,
  `repo-code-style-integrity.test.ts`, and `repo-style-check.test.ts`. This
  evidence verifies the principle in `AGENTS.md`, the code-writing skill, the
  canonical standard, the human guide, and the integrity test. Do not edit
  `AGENTS.md` or `.agents/skills/rallar-code-writing/SKILL.md` in Task 1 and do
  not recreate PR #45's completed wording.

- [x] **Step 2: Write failing assertions for only the pending governance**

  Extend `repo-code-style-integrity.test.ts` with these assertions while
  retaining the existing PR #45 assertions unchanged:

  ```ts
  expectAll(canonicalStyle, [
    '## Feature ownership and repository organization',
    '## File and primary symbol names',
    'Organize by owned feature or capability before technical role',
    'More than 20 direct production TypeScript files prompts an ownership review',
    'Four or more sibling files with the same meaningful feature prefix',
    '`room` is the product and browser term',
    '`group-state` is the authoritative API and server term',
    '`room-group-state-translation.ts`',
  ]);
  expectAll(humanGuide, [
    'obvious feature entry file',
    'primary exported symbol',
    'co-located with the feature that owns it',
    'room/group-state translation boundary',
  ]);
  ```

- [x] **Step 3: Run the integrity test and verify the pending assertions fail**

  Run:

  ```bash
  npx vitest run packages/tests/repo/repo-code-style-integrity.test.ts
  ```

  Expected: FAIL only because the organization/naming headings and human
  ownership-trace phrases are absent; the pre-existing PR #45 assertions remain
  green.

- [x] **Step 4: Add the canonical organization and naming sections**

  Add both headings to the contents list. Insert the sections after
  `## Predictable file layout`. The normative content must state all of the
  following without creating a second exception list:

  ```markdown
  ## Feature ownership and repository organization

  Organize by owned feature or capability before technical role. A feature
  folder owns its entry service, facade, or route registration; its private
  contracts; pure translations; factories; persistence adapters; and direct
  tests. Put a responsibility in a nested folder only when that folder names a
  real subfeature or boundary.

  Place cross-runtime HTTP DTOs under the owning `packages/shared/api/<feature>`
  path, browser product inputs and views under the owning
  `packages/shared-web/browser/<feature>` path, and persistence records, storage
  keys, exact reads, and snapshot assembly under the owning feature's
  `persistence/` path. Keep command, read, computed, validation, and written
  contracts beside the use case or service that owns their phase sequence.
  Keep explicit-dependency factories beside their service and production-default
  factories in application composition. Keep route request and response
  translations beside the routes that own them.

  Do not create repository-wide or package-wide `interfaces`, `types`,
  `translators`, `factories`, `helpers`, or `utils` folders. Those words name
  implementation roles, not owners. A private one-use contract stays beside
  its behavior. An intentionally shared contract uses a descriptive feature
  contract filename and is exported only through the intentional package
  boundary.

  More than 20 direct production TypeScript files prompts an ownership review.
  Four or more sibling files with the same meaningful feature prefix prompts a
  feature-folder review. These thresholds do not require a folder or permit a
  pass-through module. A new one-file folder requires a real public, runtime,
  or ownership boundary.

  Every feature folder has one obvious feature entry file named for its public
  service, facade, or route-registration function. Prefer
  `feature/subfeature/file.ts`; add another directory level only when it removes
  a genuine mixed responsibility. Tests mirror the production feature path.

  `room` is the product and browser term. `group-state` is the authoritative API
  and server term. Translate between them in the explicitly named browser
  boundary `room-group-state-translation.ts`. Established protocol identities
  `GroupRef` and `roomRef` remain unchanged unless an approved public-contract
  migration changes them.

  ## File and primary symbol names

  TypeScript filenames use kebab-case, including files whose primary export is
  a class or React component. Exact ecosystem-discovered configuration names
  such as `vite.config.ts` and `prisma.config.ts` retain the names expected by
  their tools.

  A file basename matches its primary exported class, function, interface,
  type, or capability after mechanical Pascal/camel-to-kebab conversion. An
  action module is verb-first and uses the canonical vocabulary. Route
  registration uses a descriptive name such as `registerGroupStateRoutes`, not
  an export named only `init`. Lifecycle names include their capability, for
  example `initRoomPresence`.

  Generic filenames such as `utils.ts`, `types.ts`, `helpers.ts`,
  `contracts.ts`, `runtime.ts`, and `middleware.ts` require a feature noun and
  role. Prefer `group-state-service-contracts.ts` or
  `api-v1-http-middleware.ts`.

  Established abbreviations API, CRDT, HTTP, RTC, SQL, URL, WebSocket, and WS
  are allowed. Do not introduce local abbreviations such as `svc`, `mgr`,
  `cfg`, `ctx`, `req`, `res`, `grp`, or `proc` in public or domain names.

  Do not introduce historical implementation names such as `task10-*` or
  `*-correction-17`. When the owning feature is migrated, rename existing test
  files for the behavior or invariant they prove. This remains a human review
  rule because tests are excluded from the default production checker.

  `mod.ts` is a package compatibility boundary. Do not add nested barrels to
  shorten imports. Internal code imports the owning file directly; public
  consumers use the intentional package entry point.
  ```

- [x] **Step 5: Add the pending human ownership trace**

  PR #45 already added the constitutional sentence and first-review-question
  paragraph. Leave both unchanged. Expand `### 7. Inspect layout` with an
  ownership trace that asks the
  reviewer to start at the feature entry, follow one input-to-result path,
  compare each filename with its primary symbol, verify co-location, and inspect
  the room/group-state translation boundary. Keep the checker command
  documentation for Task 4 rather than documenting commands that do not exist
  yet.

- [x] **Step 6: Run the integrity test and verify success**

  Run the command from Step 3. Expected: PASS.

- [x] **Step 7: Format and inspect the governance diff**

  Run:

  ```bash
  npx prettier --check AGENTS.md .agents/skills/rallar-code-writing/SKILL.md .agents/skills/rallar-code-writing/references/repo-code-style.md docs/repo-human-style-guide.md packages/tests/repo/repo-code-style-integrity.test.ts
  git diff --check
  git diff -- AGENTS.md .agents/skills/rallar-code-writing/SKILL.md .agents/skills/rallar-code-writing/references/repo-code-style.md docs/repo-human-style-guide.md packages/tests/repo/repo-code-style-integrity.test.ts
  ```

  Expected: formatter and diff checks pass; the diff defines one standard and
  one review workflow rather than duplicating competing rules.

- [x] **Step 8: Commit and publish the governance milestone**

  Stage only the three changed governance/test files and this checked-off plan.
  Do not manufacture changes to the already-verified `AGENTS.md` or
  `rallar-code-writing/SKILL.md` prerequisites.
  Commit message:

  ```text
  docs: define repository traceability rules
  ```

  Commit `e0e6e7fd1e2ac6c280ae2930f411af76557ccc48` was pushed and PR #47
  exists at `https://github.com/intact-software-systems/ar-eye-hunter/pull/47`.
  It is open and non-draft. This environment cannot update its metadata, so no
  draft-PR metadata update is claimed.

### Task 2: Implement Conservative Repository Layout Rules

**Files:**

- Create: `scripts/repo-style-check/layout-rules.mjs`
- Create: `packages/tests/repo/repo-style-layout-rules.test.ts`
- Modify: `packages/tests/repo/repo-style-check.test.ts`
- Modify: `.agents/skills/rallar-testing/SKILL.md`
- Modify: `.agents/skills/rallar-testing/references/test-commands.md`
- Modify: `plans/repo-human-traceability-governance-and-checker-plan.md`

**Interfaces:**

- Consumes: the `scanRepositoryLayout`, `isLayoutTypeScriptFile`,
  `layoutLimits`, and `layoutRuleIds` contract in Section 5.
- Produces: deterministic default layout findings and counts without filesystem
  reads or console output.

- [x] **Step 1: Create failing default-rule unit tests**

  Import the not-yet-existing module and add focused tests using absolute
  in-memory source records. The tests must cover these boundaries:

  ```ts
  expect(scan(makeSources(20)).counts['layout.directory-density']).toBe(0);
  expect(scan(makeSources(21)).counts['layout.directory-density']).toBe(1);

  expect(
    scan(
      denseSourcesWithFeatureFiles([
        'read-auth-session.ts',
        'compute-auth-session.ts',
        'validate-auth-session.ts',
        'write-auth-session.ts',
      ]),
    ).counts['layout.feature-prefix-cluster'],
  ).toBe(1);

  expect(
    scan(
      sources({
        'feature/ThingService.ts': 'export class ThingService {}',
        'feature/thingService.ts': 'export class OtherThingService {}',
        'feature/thing-service.ts': 'export class ThingService {}',
        'feature/vite.config.ts': 'export default {};',
      }),
    ).counts['layout.filename-style'],
  ).toBe(2);

  expect(
    scan(
      sources({
        'feature/types.ts': 'export interface Value {}',
        'feature/group-state-types.ts': 'export interface GroupStateValue {}',
      }),
    ).counts['layout.generic-filename'],
  ).toBe(1);
  ```

  Add equivalent assertions for exactly three prefix files, a prefix already
  represented by an exact token in the immediate directory basename, a prefix
  represented only in an ancestor directory, and singular/plural tokens that
  do not compare equal. Prove ignored tokens are removed only while leading,
  each file enters at most one cluster, every cluster finding has
  `affectedCount: 1`, and cluster messages contain the direct-file count plus at
  most five sorted samples. Also cover `helpers.ts`, a descriptive helper
  filename, generic route `init`, descriptive route registration, approved and
  unapproved `mod.ts`, and deterministic finding order.

  Add one generated planning-count fixture with eight dense directories and
  qualifying-cluster counts `[3, 3, 3, 3, 3, 3, 2, 2]`. Give every cluster
  four direct files and fill each directory past 20 files with stems whose
  first tokens are all distinct and do not equal a directory token. Assert:

  ```ts
  const planningResult = scanRepositoryLayout(planningCountFixture());
  const prefixFindings = planningResult.findings.filter(
    (finding) => finding.ruleId === 'layout.feature-prefix-cluster',
  );

  expect(prefixFindings).toHaveLength(22);
  expect(prefixFindings.every((finding) => finding.affectedCount === 1)).toBe(true);
  expect(new Set(prefixFindings.map((finding) => finding.file))).toHaveLength(8);
  expect(planningResult.counts['layout.feature-prefix-cluster']).toBe(22);
  ```

- [x] **Step 2: Run the new suite and verify failure**

  Run:

  ```bash
  npx vitest run packages/tests/repo/repo-style-layout-rules.test.ts
  ```

  The pre-implementation run failed because `layout-rules.mjs` did not exist;
  the preserved SDD checkpoint records that test-first evidence.

- [x] **Step 3: Implement the TypeScript predicate, normalization, and metadata**

  Create the exports from Section 5. Use these exact normalization rules:

  ```js
  const typeScriptSuffixPattern = /(?:\.d)?\.(?:ts|tsx|mts|cts)$/u;
  const kebabCasePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
  const genericFileStems = new Set([
    'utils',
    'types',
    'helpers',
    'contracts',
    'runtime',
    'middleware',
  ]);
  const conventionalToolFileNames = new Set(['prisma.config.ts', 'vite.config.ts']);
  ```

  Export `isLayoutTypeScriptFile(file)` as the only suffix predicate used by
  the CLI and scanner. At the start of `scanRepositoryLayout`, ignore any
  supplied source for which the predicate returns `false`. This defensive
  behavior is tested directly with a `.mjs` record and must produce no layout
  finding or affected count.

  `toKebabCase` must split acronym-to-word and lower/digit-to-upper boundaries,
  replace underscores and whitespace with one hyphen, collapse repeated
  hyphens, and lowercase the result. Add these direct assertions:

  ```ts
  expect(toKebabCase('RallarRoomsFacade')).toBe('rallar-rooms-facade');
  expect(toKebabCase('GroupRef')).toBe('group-ref');
  expect(toKebabCase('APIClient')).toBe('api-client');
  expect(toKebabCase('PSqlRepository')).toBe('p-sql-repository');
  ```

- [x] **Step 4: Implement directory density and meaningful-prefix grouping**

  Group only direct TypeScript children. A directory with 21 files produces
  one density finding with `affectedCount: 1`. Prefix analysis runs only in
  those dense directories. Apply Section 3.3 exactly: normalize and split the
  stem, remove ignored tokens only from the leading run, and use the first
  remaining token. Compare it with exact normalized tokens from the immediate
  directory basename only. Group direct files by candidate, then emit one
  finding for each group of at least four files, with `affectedCount: 1`.
  Sort the candidate keys and sample filenames lexicographically.

  Use this neutral warning form:

  ```text
  Review feature ownership: this directory has 27 direct production TypeScript
  files (review threshold > 20). This is not an instruction to create folders
  or pass-through modules mechanically.
  ```

- [x] **Step 5: Implement filename, generic-name, route-init, and mod rules**

  Use the approved directly declared `@babel/parser` to inspect exported route
  declarations syntactically rather than matching comments or string literals.
  Keep the approved mod paths in:

  ```js
  const approvedModCompatibilityBoundaries = new Set([
    'packages/relic-hunters/mod.ts',
    'packages/shared-graph/mod.ts',
    'packages/shared-server/game/mod.ts',
    'packages/shared-server/mod.ts',
    'packages/shared-server/rallar-ai/mod.ts',
    'packages/shared-test/rallar-bb-test/mod.ts',
    'packages/shared-web/game/mod.ts',
    'packages/shared-web/mod.ts',
    'packages/shared/crdt/mod.ts',
    'packages/shared/mod.ts',
    'packages/shared/rallar-ai/mod.ts',
    'packages/shared/rallar-game/mod.ts',
    'packages/shared/rallar-match/mod.ts',
    'packages/shared/rallar-motion/mod.ts',
  ]);
  ```

  Compare normalized repo-relative paths with `/` separators so behavior is
  stable across operating systems.

- [x] **Step 6: Make counts independent of displayed grouping**

  Initialize all default rule IDs to zero. Derive each count by summing
  `affectedCount`, not by parsing messages. Directory-density and prefix
  findings each contribute `1`; grouped filename findings contribute their
  affected file count. Sort findings by file, rule ID, then message.

- [x] **Step 7: Register the new test suite in testing guidance**

  Add `packages/tests/repo/repo-style-layout-rules.test.ts` beside the three
  existing repo-style suites in both testing skill files. Update the integrity
  test's checker implementation list to include
  `scripts/repo-style-check/layout-rules.mjs` so the 400-line and 100-character
  limits apply.

- [x] **Step 8: Run focused tests and verify success**

  Run:

  ```bash
  npx vitest run packages/tests/repo/repo-style-layout-rules.test.ts packages/tests/repo/repo-style-check.test.ts packages/tests/repo/repo-code-style-integrity.test.ts
  ```

  Verified 2026-07-28 after fix round 1: 41 focused tests passed across the
  layout-rule, checker, and code-style-integrity suites, and 96 skill-routing
  tests passed. At this point the pure scanner exists but the CLI does not
  invoke it yet.

- [x] **Step 9: Commit the default-rule milestone**

  Commit message:

  ```text
  test: define repository layout warning rules
  ```

  Commits `db5f596ef8aa835e012ecfce219b5105ef24c43c` and
  `21bf51790596d7b7b8df34d00d466beeb2877fc8` are pushed; the remote branch head
  is `21bf51790596d7b7b8df34d00d466beeb2877fc8`. PR #47 follows the branch but
  remains externally open and non-draft, and its metadata is unavailable here.

### Task 3: Add Opt-In Primary-Symbol And Vocabulary Rules

**Files:**

- Modify: `scripts/repo-style-check/layout-rules.mjs`
- Modify: `packages/tests/repo/repo-style-layout-rules.test.ts`
- Modify: `plans/repo-human-traceability-governance-and-checker-plan.md`

**Interfaces:**

- Consumes: `scanRepositoryLayout({ includeDetails: false })` from Task 2.
- Produces: the same result shape, with three additional rule families when
  `includeDetails` is `true`.

- [x] **Step 1: Write failing primary-export tests**

  Add exact matching, mismatch, and ambiguity cases:

  ```ts
  expect(
    detailCount(
      {
        'feature/thing-service.ts': 'export class ThingService {}',
      },
      'layout.primary-export-name',
    ),
  ).toBe(0);

  expect(
    detailCount(
      {
        'feature/service.ts': 'export class ThingService {}',
      },
      'layout.primary-export-name',
    ),
  ).toBe(1);

  expect(
    detailCount(
      {
        'feature/contracts.ts': [
          'export interface ThingInput {}',
          'export interface ThingOutput {}',
        ].join('\n'),
      },
      'layout.primary-export-name',
    ),
  ).toBe(0);
  ```

  Also prove the rule is absent when `includeDetails` is false and skips
  re-export-only modules, anonymous defaults, `mod.ts`, `index.ts`, and exact
  tool config filenames.

- [x] **Step 2: Write failing browser boundary tests**

  Cover every exact module, the named translation boundary, original-versus-
  local aliases, opaque imports, and established protocol identities:

  ```ts
  expect(
    detailCount(
      {
        'packages/shared-web/browser/rooms/create-room.ts': [
          "import type { CreateGroupRequest } from '@shared/api/state-types.ts';",
          'export function createRoom(input: CreateGroupRequest) { return input; }',
        ].join('\n'),
      },
      'layout.browser-room-boundary',
    ),
  ).toBe(1);

  expect(
    detailCount(
      {
        'packages/shared-web/browser/rooms/room-group-state-translation.ts':
          "import type { CreateGroupRequest } from '@shared/api/state-types.ts';",
      },
      'layout.browser-room-boundary',
    ),
  ).toBe(0);

  expect(
    detailCount(
      {
        'packages/shared-web/browser/rooms/room-ref.ts':
          "import type { GroupRef } from '@shared/api/group-types.ts';",
      },
      'layout.browser-room-boundary',
    ),
  ).toBe(0);
  ```

  Add named-import positives for `GroupSnapshot` from `group-types.ts`,
  `CreateGroupRequest` from `state-types.ts`, and `StateEventPage` from
  `state-event-types.ts`. Add
  `GroupSnapshot as RoomSnapshot` and assert its finding evidence contains both
  names. Add named-import negatives for exact original names `GroupRef` and
  `roomRef`, including `GroupRef as RoomRef`. Add namespace and default imports
  for each exact module and expect one warning per file. Prove side-effect-only
  imports, dynamic imports, re-exports, relative paths, and the same imported
  names from a different module do not warn. Prove multiple authoritative
  imports in one room file still create one finding with sorted, deduplicated
  evidence. Prove a direct import in a non-room browser module does not warn,
  and prove a same-named translation file outside the exact exempt path still
  warns when its stem makes it room-owned.

- [x] **Step 3: Write failing server vocabulary tests**

  Add a server group-state file with `RoomPolicy`, one with `GroupPolicy`, and
  one that only imports or uses `GroupRef` and `roomRef`. Expect only
  `RoomPolicy` to warn. Include strings and comments containing `room` and prove
  that neither warns.

- [x] **Step 4: Run the detailed tests and verify failure**

  Run:

  ```bash
  npx vitest run packages/tests/repo/repo-style-layout-rules.test.ts
  ```

  Verified 2026-07-28: FAIL with 8 expected detailed-rule failures and 18
  passing default-rule tests because the detailed rules were not implemented.

- [x] **Step 5: Implement conservative primary-export selection**

  Parse each source with the approved directly declared `@babel/parser`.
  Select named,
  directly-exported, top-level function, class, interface, type alias, enum, and
  variable declarations. Deduplicate overloads by symbol name. Warn only when
  exactly one unique candidate exists and its converted name differs from the
  file stem.

- [x] **Step 6: Implement browser import analysis**

  Inspect static `ImportDeclaration` nodes only. Use the three exact module
  strings and three exact original-name sets in Section 3.4. For an
  `ImportSpecifier`, classify `propertyName?.text ?? name.text`; the local alias
  never changes classification. Exempt exact original names `GroupRef` and
  `roomRef` before set lookup. Treat namespace and default imports from an exact
  module as authoritative opaque imports, ignore a declaration with no import
  clause, and ignore every other syntax or module string. Exempt only the exact
  repo-relative translation path. Report one warning per room-owned module with
  sorted, deduplicated evidence.

- [x] **Step 7: Implement server identifier analysis**

  Identify server group-state modules using the path and declaration criteria
  in Section 3.4. Traverse declaration names, excluding import declarations.
  Tokenize identifiers and report one warning per file when the whole token
  `room` or `rooms` appears outside exact `GroupRef` and `roomRef`. Include at
  most five sorted identifier samples.

- [x] **Step 8: Run the detailed suite and verify success**

  Verified 2026-07-28 after review round 2: 31 focused tests and 57 exact
  regression tests passed.

- [x] **Step 9: Commit the detailed-rule milestone**

  Commit message:

  ```text
  feat: add opt-in traceability heuristics
  ```

  Stage only this task's files and the checked-off plan. Do not push; the
  controller publishes after independent review.

  Commits `eaa61e261f995a4c8b2e566d11466c35f90c9c33`,
  `d434c3bfcc98e943d1a3da4c90a566676b21d518`, and
  `9f2c67a4a1e017ad0f0797d2db42bc83ede418bf` are pushed; the remote branch head
  is `9f2c67a4a1e017ad0f0797d2db42bc83ede418bf`. PR #47 follows the branch and
  remains open and non-draft; its metadata is unavailable here.

### Task 4: Integrate Layout Modes Into The Warning-Only CLI

**Files:**

- Modify: `scripts/repo-style-check.mjs`
- Modify: `package.json`
- Modify: `docs/repo-human-style-guide.md`
- Modify: `packages/tests/repo/repo-style-check.test.ts`
- Modify: `packages/tests/repo/repo-code-style-integrity.test.ts`
- Modify: `plans/repo-human-traceability-governance-and-checker-plan.md`

**Interfaces:**

- Consumes: `scanRepositoryLayout` and its stable result shape.
- Produces: default, layout-only, and detailed layout CLI modes with unchanged
  warning exit behavior.

- [x] **Step 1: Write failing CLI mode tests**

  Extend the existing fixture runner and assert:

  ```ts
  const layoutOnly = executeChecker(denseFixture, '--layout-only');
  expect(layoutOnly.status).toBe(0);
  expect(layoutOnly.stdout).toContain('layout.directory-density');
  expect(layoutOnly.stdout).not.toContain('Line 1 exceeds');

  const defaultRun = executeChecker(denseFixture);
  expect(defaultRun.stdout).toContain('layout.directory-density');
  expect(defaultRun.stdout).toContain('Line 1 exceeds');

  const detailsOff = runChecker(primaryNameFixture, '--layout-only');
  expect(detailsOff).not.toContain('layout.primary-export-name');
  const detailsOn = runChecker(primaryNameFixture, '--layout-only', '--layout-details');
  expect(detailsOn).toContain('layout.primary-export-name');
  ```

  Add tests proving excluded test/mock/generated paths do not contribute to
  directory counts, grouped `affectedCount` values appear in the layout
  summary, warnings still exit `0`, and `--strict` still exits `1`.

  Add one fixture containing 21 direct `.mjs` files, with exactly one file
  containing a line over 100 characters. Assert the default run contains the
  existing `Line 1 exceeds` warning, while `--layout-only` reports zero
  `layout.directory-density` and zero `layout.feature-prefix-cluster` affected
  items. This proves `.mjs` remains in file-level checking but never enters the
  TypeScript layout projection.

- [x] **Step 2: Write failing package and guide integrity assertions**

  Require both new npm scripts, prohibit `check:repo-style:strict`, and require
  the human guide to document `check:repo-style:layout`,
  `check:repo-style:layout-details`, grouped counts, and the ownership-prompt
  wording.

- [x] **Step 3: Run focused tests and verify failure**

  Run:

  ```bash
  npx vitest run packages/tests/repo/repo-style-check.test.ts packages/tests/repo/repo-code-style-integrity.test.ts
  ```

  Expected: FAIL because the CLI flags and package scripts do not exist.

  Verified 2026-07-28: FAIL with 6 expected missing-integration failures and 24
  passing tests.

- [x] **Step 4: Load each production source once**

  In `main`, preserve `checkedExtensions`, `collectSourceFiles`, and
  `isProductionCodeFile`; `.mjs` remains in `checkedExtensions`. Flatten,
  filter, and sort the absolute file paths once, then read each surviving file
  exactly once:

  ```js
  const productionFiles = nestedFiles.flat().filter(isProductionCodeFile).sort();
  const productionSources = await Promise.all(
    productionFiles.map(async (file) => ({
      file,
      raw: await fs.readFile(file, 'utf8'),
    })),
  );
  const layoutSources = productionSources.filter(({ file }) => isLayoutTypeScriptFile(file));
  ```

  Existing `scanFile` receives every `productionSources` raw value, including
  `.mjs`, when `--layout-only` is absent. `scanRepositoryLayout` receives only
  `layoutSources`. Do not perform a second traversal or read for layout checks.

- [x] **Step 5: Invoke and print layout results**

  Add:

  ```js
  const layoutOnlyMode = args.has('--layout-only');
  const layoutDetailsMode = args.has('--layout-details');
  ```

  Always invoke the default layout scan. Pass
  `includeDetails: layoutDetailsMode`. Append findings to the existing finding
  list. Print `[ruleId]` before each layout message and print a deterministic
  `Layout summary:` line that shows every active rule and its affected count.
  Keep the global 200-finding display cap and full summary count.

- [x] **Step 6: Add package scripts and human instructions**

  Add the exact scripts from Section 3.1. In the human guide:

  - add all six default layout rule families to the current warning list;
  - explain that `check:repo-style:layout` isolates structural review;
  - place `check:repo-style:layout-details` under optional noisy checks;
  - explain the exact room/group-state boundary intent;
  - explain grouped warnings and affected counts;
  - retain the exclusions and no-strict-mode sections.

- [x] **Step 7: Run focused tests and verify success**

  Run:

  ```bash
  npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts packages/tests/repo/repo-code-style-integrity.test.ts packages/tests/repo/repo-style-layout-rules.test.ts packages/tests/repo/repo-style-check.test.ts
  ```

  Expected: PASS.

  Verified 2026-07-28: PASS with all 116 tests across the exact four-file
  command.

- [x] **Step 8: Verify the checker checks itself**

  Run:

  ```bash
  npm run check:repo-style -- --root scripts/repo-style-check
  ```

  Expected: exit `0` and no new file-length or line-width warning in the checker
  modules.

  Verified 2026-07-28: exit `0`, no checker-module warning, and all six default
  layout summary counts were zero.

- [x] **Step 9: Commit and publish the CLI milestone**

  Commit message:

  ```text
  feat: report repository layout warnings
  ```

  Stage only this task's files and the checked-off plan. Push and update the
  draft pull request.

### Task 5: Record The Executable Baseline And Ratchet Procedure

**Files:**

- Modify: `plans/repo-human-traceability-governance-and-checker-plan.md`
- Modify: `plans/repo-human-traceability-refactoring-program-plan.md`

**Interfaces:**

- Consumes: stable rule IDs and affected counts from Task 4.
- Produces: an exact, reproducible Wave 0 baseline and instructions used by
  later feature child plans.

- [ ] **Step 1: Run the default layout inventory**

  Run:

  ```bash
  npm run check:repo-style:layout
  ```

  Expected: exit `0` with warning output. Compare the summary with the planning
  baseline: 16 dense directories, 22 conservative prefix clusters, 422
  filename-style files, 15 generic filenames, 11 generic route registrations,
  and zero unapproved `mod.ts` files.

- [ ] **Step 2: Run the detailed inventory**

  Run:

  ```bash
  npm run check:repo-style:layout-details
  ```

  Expected: exit `0`. Record all three detailed rule counts without approving
  exceptions or enabling those rules by default.

- [ ] **Step 3: Confirm the complete checker remains non-blocking**

  Run:

  ```bash
  npm run check:repo-style
  node scripts/repo-style-check.mjs --root scripts/repo-style-check --strict
  ```

  Expected: the first command exits `0` with known warnings. The second exits
  `1` with `strict mode is not available`.

- [ ] **Step 4: Record actual counts and the ratchet rule**

  Replace the planning counts in Section 2 with an `Implemented baseline`
  column while retaining the dated planning values. Add this rule to the master
  plan's Wave 0 record:

  ```text
  An active feature records its focused layout counts before its structure pass.
  The pass may reduce them or leave explained legacy debt unchanged; it may not
  add an unexplained warning. Repository totals are context, not a reason to
  expand the active feature scope.
  ```

  Check off the four Wave 0 implementation items only after their evidence is
  present. Do not mark Wave 0 published or the child plan complete yet.

- [ ] **Step 5: Commit and publish the baseline milestone**

  Commit message:

  ```text
  docs: record human traceability baseline
  ```

  Stage only the two plan files. Push and update the draft pull request with
  both checker summaries.

### Task 6: Complete Verification And Publication Gates

**Files:**

- Modify before the feature-tree freeze:
  `plans/repo-human-traceability-governance-and-checker-plan.md`
- Modify only on a later evidence-ledger branch:
  `plans/repo-human-traceability-refactoring-program-plan.md`
- Modify only on a later evidence-ledger branch:
  `plans/repo-human-traceability-program-execution-plan.md`
- Modify only on a later evidence-ledger branch:
  `plans/repo-human-traceability-governance-and-checker-plan.md`

The pull-request body and Mandatory Completion Handoff are the mutable
publication envelope. They are not repository files and may be updated after a
tree is frozen without invalidating that tree.

**Interfaces:**

- Consumes: final implementation content from Tasks 1-5.
- Produces: one immutable feature tree, its external publication envelope, and
  one independently gated later ledger publication without self-referential
  evidence edits.

- [ ] **Step 1: Run formatting and diff checks**

  Run:

  ```bash
  npx prettier --check AGENTS.md .agents/skills/rallar-code-writing/SKILL.md .agents/skills/rallar-code-writing/references/repo-code-style.md .agents/skills/rallar-testing/SKILL.md .agents/skills/rallar-testing/references/test-commands.md docs/repo-human-style-guide.md scripts/repo-style-check.mjs scripts/repo-style-check/layout-rules.mjs packages/tests/repo/repo-code-style-integrity.test.ts packages/tests/repo/repo-style-check.test.ts packages/tests/repo/repo-style-layout-rules.test.ts plans/repo-human-traceability-refactoring-program-plan.md plans/repo-human-traceability-program-execution-plan.md plans/repo-human-traceability-governance-and-checker-plan.md package.json
  git diff --check
  ```

  Expected: PASS.

- [ ] **Step 2: Run the focused governance and checker suites**

  Run:

  ```bash
  npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts packages/tests/repo/repo-code-style-integrity.test.ts packages/tests/repo/repo-style-layout-rules.test.ts packages/tests/repo/repo-style-check.test.ts
  ```

  Expected: PASS.

- [ ] **Step 3: Run all checker modes**

  Run:

  ```bash
  npm run check:repo-style:layout
  npm run check:repo-style:layout-details
  npm run check:repo-style
  npm run check:repo-style -- --root .
  ```

  Expected: all commands exit `0`; warnings and counts are reported honestly.

- [ ] **Step 4: Finalize and freeze the feature-branch evidence tree**

  Before running repository completion gates, update all Task 1-5 checkboxes,
  executable baseline counts, and known focused results in this plan. Set its
  implementation state to `implemented; final and publication gates pending`.
  Do not add fields for a future commit SHA, merge SHA, or workflow result.

  Confirm scope, stage the exact implementation files, and compute the tree:

  ```bash
  git status --short
  git diff --check
  git add .agents/skills/rallar-code-writing/references/repo-code-style.md docs/repo-human-style-guide.md scripts/repo-style-check/layout-rules.mjs scripts/repo-style-check.mjs package.json packages/tests/repo/repo-style-layout-rules.test.ts packages/tests/repo/repo-style-check.test.ts packages/tests/repo/repo-code-style-integrity.test.ts .agents/skills/rallar-testing/SKILL.md .agents/skills/rallar-testing/references/test-commands.md plans/repo-human-traceability-refactoring-program-plan.md plans/repo-human-traceability-program-execution-plan.md plans/repo-human-traceability-governance-and-checker-plan.md
  git diff --cached --name-only
  git diff --cached --check
  git write-tree
  git diff --name-only -- .agents/skills/rallar-code-writing/references/repo-code-style.md docs/repo-human-style-guide.md scripts/repo-style-check/layout-rules.mjs scripts/repo-style-check.mjs package.json packages/tests/repo/repo-style-layout-rules.test.ts packages/tests/repo/repo-style-check.test.ts packages/tests/repo/repo-code-style-integrity.test.ts .agents/skills/rallar-testing/SKILL.md .agents/skills/rallar-testing/references/test-commands.md plans/repo-human-traceability-refactoring-program-plan.md plans/repo-human-traceability-program-execution-plan.md plans/repo-human-traceability-governance-and-checker-plan.md
  ```

  Expected: the staged list contains only the authorized child-plan files; the
  final command prints nothing because no in-scope unstaged edit exists. Record
  the full tree ID from `git write-tree` in the draft PR and handoff, not by
  editing the now-frozen plan. Unrelated unstaged user files may remain visible
  in `git status` and remain excluded from the tree.

- [ ] **Step 5: Run the repository completion gates on the frozen tree**

  Run from the unchanged final working tree:

  ```bash
  npm run test:unit
  npm run test:ci
  npm run build
  ```

  Expected: all three commands PASS. Record exact outputs. Any content change
  to an in-scope file after a pass invalidates the tree and all local evidence;
  return to Step 4 and rerun every invalidated command.

- [ ] **Step 6: Commit and publish exactly the frozen feature tree**

  Run:

  ```bash
  git commit -m "feat: add repository traceability governance"
  git rev-parse HEAD
  git rev-parse 'HEAD^{tree}'
  ```

  Expected: `HEAD^{tree}` exactly equals the Step 4 tree ID. Push the
  non-default branch. In the draft PR and handoff, record the tree ID, final
  branch commit SHA, exact local command results, and unrelated excluded paths.
  Require **Branch Release Gate** to pass for that exact branch commit and add
  its run identifier and conclusion to the same external envelope. Do not edit
  an in-scope file to copy this evidence into the frozen tree.

- [ ] **Step 7: Record merge and default-workflow evidence externally**

  After human merge, resolve the exact resulting default-branch commit SHA; do
  not assume it equals the feature SHA. Append that SHA and the exact
  **Run Hetzner Supported Distributed Manifests** run identifier, tested SHA,
  and conclusion to the PR and Mandatory Completion Handoff. The child reaches
  execution-protocol state `complete` only when that workflow is green for the
  resulting default SHA. A pending, skipped, failed, or older-SHA run leaves it
  incomplete. No post-merge plan edit is part of this decision.

- [ ] **Step 8: Publish the completed-child ledger as a separate evidence task**

  After Step 7 is green, create a new non-default evidence-ledger branch from
  that exact default SHA. Change only the three program plan files to record the
  frozen implementation tree, final feature SHA, Branch Release Gate, PR,
  resulting default SHA, and successful default-workflow run. Mark the child
  implementation `complete` and the ledger publication `pending`.

  Run Prettier and `git diff --check`, the four focused repository governance
  tests, then `npm run test:unit`, `npm run test:ci`, and `npm run build` on the
  final ledger tree. Stage only the three plans, record its `git write-tree`
  ID, commit, push, and use a separate draft PR. Require Branch Release Gate for
  the exact ledger commit, human merge, and the distributed-manifest workflow
  for the exact ledger default SHA. Store the ledger tree, commit, merge, and
  workflow evidence in that ledger PR and its handoff.

  When the ledger workflow is green, the execution protocol state becomes
  `ledger-published`. Do not create another commit solely to put the ledger
  merge SHA or its future workflow result inside the ledger that produced it;
  the ledger PR/handoff is the canonical publication envelope for those facts.
  If a ledger gate fails, keep `ledger-published` pending and do not start the
  next child plan, but do not relabel the already verified implementation tree
  as the ledger tree.

## 7. Acceptance Checklist

- [x] `AGENTS.md`, the code-writing skill, the canonical standard, and the human
      guide all state that code is written first for human developers.
- [x] The canonical standard explains that its detailed rules derive from human
      understandability together with non-negotiable correctness and operational
      constraints.
- [x] Integrity tests prevent removal of the primary principle or the routing to
      the authoritative standard.
- [ ] The canonical standard defines feature-first organization, co-location,
      filename-to-symbol matching, descriptive route registration, package barrels,
      and the room/group-state vocabulary boundary.
- [ ] The human guide gives a reviewer a top-to-bottom navigation procedure.
- [x] Default checker output includes six conservative layout rule families.
- [x] `--layout-only` makes layout debt independently reviewable.
- [x] `--layout-details` contains primary-export and vocabulary heuristics only.
- [x] Every layout rule has a stable ID and affected-item count.
- [x] One load-once source inventory keeps `.mjs` file-level checking while the
      layout projection accepts only `.ts`, `.tsx`, `.mts`, and `.cts`.
- [x] Each qualifying prefix cluster is one finding with `affectedCount: 1`,
      and the deterministic eight-directory fixture totals 22 clusters.
- [x] Browser room import classification uses the exact module/name tables,
      original imported names, alias evidence, opaque-import behavior, and
      `GroupRef`/`roomRef` exemptions in Section 3.4.
- [x] The checker is documented as a source of review signals, not as the
      definition of understandable code.
- [x] High-volume filename findings are grouped by directory.
- [x] Tests, mocks, fixtures, stories, generated code, and test-runner configs
      remain excluded from production counts.
- [x] Existing 14 `mod.ts` paths pass and a new nested `mod.ts` warns.
- [x] No strict script or CI gate exists.
- [x] No production file moved, renamed, reformatted, or semantically changed.
- [ ] Initial default and detailed counts are recorded with the exact commit.
- [ ] Focused, completion, publication, and remote-gate evidence is complete.
- [ ] Feature and evidence-ledger trees use separate PR/handoff publication
      envelopes, with no commit required to contain its own future evidence.

## 8. Deliberately Manual Review Areas

The checker does not attempt to decide:

- whether a folder actually has more than one responsibility;
- whether a one-file folder represents a real boundary;
- whether two files should be co-located despite sharing a noun;
- whether moving a decision creates another call-stack hop;
- whether a type is a meaningful shared contract or accidental coupling;
- whether optionality represents genuine domain absence;
- whether a pass-through wrapper should be removed;
- whether a compatibility re-export is justified;
- whether a room/group-state warning is approved public compatibility debt.

These remain human judgments because automated guesses in these areas would
recreate the indirection and mechanical refactoring this program is intended to
prevent.

## 9. Progress Record

| Milestone                         | Status      | Evidence                                                                                                                                                                                                                               |
| --------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan published                    | complete    | Direct `main` commit `4ec117db1e09e00f86ed8f66cbf8adab1cdeb4a9` adds this plan and the two reciprocal program plans.                                                                                                                   |
| Execution-readiness review        | approved    | Human approval on 2026-07-28 permits only the documented `@babel/parser` substitution for Tasks 2 and 3; approved blob `8ee56ac27189f9bed751fb6a95992830bda6be60` otherwise remains binding.                                           |
| Primary-principle prerequisite    | complete    | PR #45 merge `95065d769f585464b15059423057e151877fdb1a`; current focused verification passes 81 tests.                                                                                                                                 |
| Organization and naming wording   | complete    | Commit `e0e6e7fd1e2ac6c280ae2930f411af76557ccc48` is pushed; PR #47 is open/non-draft and its metadata remains unmodifiable here.                                                                                                      |
| Conservative layout rules         | complete    | Task 2 commits `db5f596ef8aa835e012ecfce219b5105ef24c43c` and `21bf51790596d7b7b8df34d00d466beeb2877fc8` are pushed; remote head is `21bf51790596d7b7b8df34d00d466beeb2877fc8`.                                                        |
| Opt-in detailed rules             | complete    | Task 3 commits `eaa61e261f995a4c8b2e566d11466c35f90c9c33`, `d434c3bfcc98e943d1a3da4c90a566676b21d518`, and `9f2c67a4a1e017ad0f0797d2db42bc83ede418bf` are pushed; 31 focused and 57 regression tests passed after review round 2.      |
| CLI and npm commands              | in progress | Both commands and the warning-only CLI modes are implemented locally; 116 exact focused tests and the checker self-check pass, while controller publication remains pending independent review.                                        |
| Executable baseline               | pending     | Planning counts only; the existing checker independently confirms 4,462 non-blocking findings.                                                                                                                                         |
| Focused child-plan verification   | complete    | Task 3 passed 31 focused and 57 exact regression tests after review round 2; the Task 4 exact four-file suite passes all 116 tests.                                                                                                    |
| Completion gates                  | pending     | `npm run test:unit`, `npm run test:ci`, and `npm run build` were not run for child implementation.                                                                                                                                     |
| Child implementation PR and gates | in progress | PR #47 follows the implementation branch, remains open/non-draft, and has unavailable metadata; remote head is `9f2c67a4a1e017ad0f0797d2db42bc83ede418bf`; Task 4 publication and all required completion/remote gates remain pending. |

## 10. Decisions Fixed By This Draft

1. Layout warnings are included in the default checker and can be isolated with
   `--layout-only`.
2. Primary-symbol and room/group-state checks are enabled only by
   `--layout-details`.
3. Layout output uses stable rule IDs and affected-item counts.
4. Filename debt is grouped by directory rather than emitted once per file.
5. Prefix clustering starts conservatively inside directories already above 20
   direct production TypeScript files.
6. Current package and published-subpath `mod.ts` files form an explicit
   14-path compatibility allowlist; new entries require human approval.
7. Exact tool-discovered `vite.config.ts` and `prisma.config.ts` filenames are
   retained for ecosystem discoverability.
8. No production movement begins under this child plan.
9. The CLI reads one filtered production inventory once; `.mjs` stays eligible
   for file-level warnings and is excluded from the exported TypeScript layout
   projection.
10. Feature-prefix output uses one deterministically sorted finding per cluster
    with scalar `affectedCount: 1` and leading-only ignored-token removal.
11. Browser room imports are classified by three exact module specifiers and
    module-specific original-name sets; aliases do not hide coupling, while
    `GroupRef` and `roomRef` remain exempt.
12. Immutable feature and ledger trees use external PR/handoff envelopes for
    evidence that can exist only after those trees are committed or merged.
