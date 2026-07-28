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
that consumes the same already-filtered source inventory as the file-level
rules. Default layout checks use conservative, grouped warnings; syntax- and
domain-sensitive checks are opt-in until their false-positive rate is known.

**Tech Stack:** Markdown, Node.js ESM, TypeScript compiler API, npm scripts,
Vitest, Prettier, and the existing `scripts/repo-style-check.mjs` command.

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

Status: Draft for human review. No production code or checker implementation has
started.

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
  filename prefix represented by at least four direct files. Remove canonical
  action prefixes such as `read`, `compute`, `validate`, `write`, `to`,
  `create`, and `register` before selecting the feature token. The complete
  ignored-token set is `app`, `api`, `browser`, `cached`, `compute`, `create`,
  `default`, `rallar`, `read`, `register`, `server`, `shared`, `to`, `use`,
  `v1`, `v2`, `validate`, and `write`. Do not warn when the selected prefix is
  already represented in the directory name.
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
  token or by placement under `browser/rooms/**`. Outside
  `room-group-state-translation.ts`, warn when the file directly imports
  authoritative group-state request, response, snapshot, event, status, role,
  or member contracts. Exact protocol identity imports `GroupRef` and `roomRef`
  remain allowed. The rule reports direct coupling only; it does not claim to
  prove all structural construction.
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
| `AGENTS.md`                                                        | Modify                  | Always-loaded statement of the repository's primary code goal and route to the standard.     |
| `.agents/skills/rallar-code-writing/SKILL.md`                      | Modify                  | Translate the primary code goal into required agent behavior for TypeScript work.            |
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
The scanner sorts directories, samples, findings, and summaries
lexicographically so identical input produces identical output.

## 6. Implementation Tasks

### Task 0: Confirm The Publishable Non-Default Branch

**Files:** No content changes.

**Interfaces:**

- Consumes: the approved child plan and current working tree.
- Produces: the intended non-default Wave 0 branch with unrelated user changes
  preserved.

- [ ] **Step 1: Inspect the current branch and working tree**

  Run:

  ```bash
  git branch --show-current
  git status --short
  ```

  Expected: record every pre-existing modified and untracked path. As of this
  draft, `plans/rallar-rest-snapshot-read-convergence-implementation-plan.md`
  is an unrelated modified file and must not be staged by this plan.

- [ ] **Step 2: Confirm or create and publish the implementation branch**

  Use `codex/repo-human-traceability-governance-checker-wave-0`, created from
  current `origin/main`, through the Codex branch action or the installed GitHub
  publication workflow. If Prompt 1 in the program execution plan already
  created and published that branch, verify its base and upstream instead of
  creating another branch. Do not reuse the deleted branch from merged PR #45.
  Do not commit or push the default branch.

- [ ] **Step 3: Recheck scope**

  Run `git status --short` and confirm no file under `apps/**` or production
  package code under `packages/**` has been changed.

### Task 1: Add Authoritative Organization And Naming Governance

**Files:**

- Modify: `AGENTS.md`
- Modify: `.agents/skills/rallar-code-writing/SKILL.md`
- Modify:
  `.agents/skills/rallar-code-writing/references/repo-code-style.md`
- Modify: `docs/repo-human-style-guide.md`
- Modify: `packages/tests/repo/repo-code-style-integrity.test.ts`
- Modify: `plans/repo-human-traceability-governance-and-checker-plan.md`

**Interfaces:**

- Consumes: Sections 3.3 and 3.4 of this plan.
- Produces: one always-loaded primary principle, one operational agent rule,
  one authoritative prose definition for all checker rule names, and one human
  review sequence that later tasks can reference.

- [ ] **Step 1: Write failing integrity assertions**

  Add assertions that `AGENTS.md`, the code-writing skill, the canonical
  standard, and the human guide all contain the constitutional sentence. Keep
  the detailed interpretation authoritative in the standard:

  ```ts
  const primaryCodeGoal = 'Code is written first for human developers.';

  expectAll(agents, [
    primaryCodeGoal,
    'human understandability is the governing design criterion',
    canonicalStylePath,
  ]);
  expectAll(codeWriting, [
    primaryCodeGoal,
    'A mechanically compliant change is not acceptable',
    'references/repo-code-style.md',
  ]);
  expectAll(canonicalStyle, [
    primaryCodeGoal,
    '## First principle: code is for human developers',
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
    primaryCodeGoal,
    'obvious feature entry file',
    'primary exported symbol',
    'co-located with the feature that owns it',
    'room/group-state translation boundary',
  ]);
  ```

- [ ] **Step 2: Run the integrity test and verify failure**

  Run:

  ```bash
  npx vitest run packages/tests/repo/repo-code-style-integrity.test.ts
  ```

  Expected: FAIL because the new headings and phrases are absent.

- [ ] **Step 3: Add the always-loaded principle to `AGENTS.md`**

  Insert this immediately after the opening orientation and before
  `## Start Here` so every future agent sees it before domain details:

  ```markdown
  ## Primary Code Goal

  Code is written first for human developers. Correctness, safety, security,
  compatibility, and required performance are non-negotiable. Within those
  constraints, human understandability is the governing design criterion:
  prefer the design whose ownership, dataflow, decisions, side effects,
  failures, and call paths a human can locate and follow most directly.

  Every coding and architecture rule is interpreted through this principle. A
  mechanically compliant change is not successful when it makes the code
  harder for a human to understand, review, debug, or modify. For TypeScript,
  use the `rallar-code-writing` skill and its authoritative repo standard.
  ```

- [ ] **Step 4: Turn the principle into code-writing agent behavior**

  Add this directly below `## Start Here` in
  `.agents/skills/rallar-code-writing/SKILL.md`:

  ```markdown
  Code is written first for human developers. Correctness, safety, security,
  compatibility, and required performance remain mandatory; within those
  constraints, choose the shape a human can locate, trace, understand, and
  modify most directly.

  A mechanically compliant change is not acceptable when it adds indirection,
  hides a decision, fragments one dataflow, weakens names, or makes ownership
  less obvious. When a detailed rule conflicts with human understandability,
  stop and explain the conflict instead of satisfying the rule mechanically.
  ```

  Keep the existing instruction to read `references/repo-code-style.md`
  completely. Do not repeat the detailed standard in this skill.

- [ ] **Step 5: Add the authoritative first-principle interpretation**

  Add the heading to the canonical contents and insert this section before
  `## Scope and adoption`:

  ```markdown
  ## First principle: code is for human developers

  Code is written first for human developers. Correctness, safety, security,
  compatibility, and required performance are non-negotiable constraints.
  Within those constraints, human understandability is the governing design
  criterion for this standard.

  Prefer code whose owner, inputs, defaults, decisions, side effects, failures,
  and result can be located and followed directly from descriptive filenames,
  symbols, and call paths. Do not apply a rule mechanically when doing so adds
  pass-through abstractions, hides a decision, fragments one coherent dataflow,
  or otherwise makes the code harder to review, debug, or change.

  The rules below are defaults derived from this principle together with the
  repository's correctness and operational requirements. When two rules pull
  in different directions, state the concrete tradeoff and ask the human rather
  than inventing another abstraction.
  ```

- [ ] **Step 6: Add the canonical organization and naming sections**

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

- [ ] **Step 7: Make the principle the human review criterion**

  Add the constitutional sentence near the top of
  `docs/repo-human-style-guide.md`, followed by this review rule:

  ```markdown
  The first review question is whether a human can locate the owner and follow
  the dataflow, decisions, side effects, failures, and result without
  unnecessary jumps. Mechanical compliance does not compensate for code that
  became harder to understand.
  ```

  Then expand `### 7. Inspect layout` with an ownership trace that asks the
  reviewer to start at the feature entry, follow one input-to-result path,
  compare each filename with its primary symbol, verify co-location, and inspect
  the room/group-state translation boundary. Keep the checker command
  documentation for Task 4 rather than documenting commands that do not exist
  yet.

- [ ] **Step 8: Run the integrity test and verify success**

  Run the command from Step 2. Expected: PASS.

- [ ] **Step 9: Format and inspect the governance diff**

  Run:

  ```bash
  npx prettier --check AGENTS.md .agents/skills/rallar-code-writing/SKILL.md .agents/skills/rallar-code-writing/references/repo-code-style.md docs/repo-human-style-guide.md packages/tests/repo/repo-code-style-integrity.test.ts
  git diff --check
  git diff -- AGENTS.md .agents/skills/rallar-code-writing/SKILL.md .agents/skills/rallar-code-writing/references/repo-code-style.md docs/repo-human-style-guide.md packages/tests/repo/repo-code-style-integrity.test.ts
  ```

  Expected: formatter and diff checks pass; the diff defines one standard and
  one review workflow rather than duplicating competing rules.

- [ ] **Step 10: Commit and publish the governance milestone**

  Stage only the five changed governance/test files and this checked-off plan.
  Commit message:

  ```text
  docs: define repository traceability rules
  ```

  Push the non-default branch and open or update the draft pull request with the
  focused test result.

### Task 2: Implement Conservative Repository Layout Rules

**Files:**

- Create: `scripts/repo-style-check/layout-rules.mjs`
- Create: `packages/tests/repo/repo-style-layout-rules.test.ts`
- Modify: `packages/tests/repo/repo-style-check.test.ts`
- Modify: `.agents/skills/rallar-testing/SKILL.md`
- Modify: `.agents/skills/rallar-testing/references/test-commands.md`
- Modify: `plans/repo-human-traceability-governance-and-checker-plan.md`

**Interfaces:**

- Consumes: the `scanRepositoryLayout`, `layoutLimits`, and `layoutRuleIds`
  contract in Section 5.
- Produces: deterministic default layout findings and counts without filesystem
  reads or console output.

- [ ] **Step 1: Create failing default-rule unit tests**

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
  represented in the directory name, `helpers.ts`, a descriptive helper
  filename, generic route `init`, descriptive route registration, approved and
  unapproved `mod.ts`, deterministic finding order, and five-name sample caps.

- [ ] **Step 2: Run the new suite and verify failure**

  Run:

  ```bash
  npx vitest run packages/tests/repo/repo-style-layout-rules.test.ts
  ```

  Expected: FAIL because `layout-rules.mjs` does not exist.

- [ ] **Step 3: Implement source normalization and stable result metadata**

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

  `toKebabCase` must split acronym-to-word and lower/digit-to-upper boundaries,
  replace underscores and whitespace with one hyphen, collapse repeated
  hyphens, and lowercase the result. Add these direct assertions:

  ```ts
  expect(toKebabCase('RallarRoomsFacade')).toBe('rallar-rooms-facade');
  expect(toKebabCase('GroupRef')).toBe('group-ref');
  expect(toKebabCase('APIClient')).toBe('api-client');
  expect(toKebabCase('PSqlRepository')).toBe('p-sql-repository');
  ```

- [ ] **Step 4: Implement directory density and meaningful-prefix grouping**

  Group only direct TypeScript children. A directory with 21 files produces
  one density finding with `affectedCount: 1`. Prefix analysis runs only in
  those dense directories. Tokenize both legacy Pascal/camel names and
  kebab-case names, remove the action and qualifier tokens from Section 3.3,
  and count the first remaining token. A directory warning contains all
  qualifying clusters and uses one `affectedCount` per cluster.

  Use this neutral warning form:

  ```text
  Review feature ownership: this directory has 27 direct production TypeScript
  files (review threshold > 20). This is not an instruction to create folders
  or pass-through modules mechanically.
  ```

- [ ] **Step 5: Implement filename, generic-name, route-init, and mod rules**

  Use the TypeScript compiler API to inspect exported route declarations rather
  than matching comments or string literals. Keep the approved mod paths in:

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

- [ ] **Step 6: Make counts independent of displayed grouping**

  Initialize all default rule IDs to zero. Derive each count by summing
  `affectedCount`, not by counting warning records. Sort findings by file,
  rule ID, then message.

- [ ] **Step 7: Register the new test suite in testing guidance**

  Add `packages/tests/repo/repo-style-layout-rules.test.ts` beside the three
  existing repo-style suites in both testing skill files. Update the integrity
  test's checker implementation list to include
  `scripts/repo-style-check/layout-rules.mjs` so the 400-line and 100-character
  limits apply.

- [ ] **Step 8: Run focused tests and verify success**

  Run:

  ```bash
  npx vitest run packages/tests/repo/repo-style-layout-rules.test.ts packages/tests/repo/repo-style-check.test.ts packages/tests/repo/repo-code-style-integrity.test.ts
  ```

  Expected: PASS. At this point the pure scanner exists but the CLI does not
  invoke it yet.

- [ ] **Step 9: Commit and publish the default-rule milestone**

  Commit message:

  ```text
  test: define repository layout warning rules
  ```

  Stage only the files listed in this task and the checked-off plan. Push and
  update the draft pull request with the focused test evidence.

### Task 3: Add Opt-In Primary-Symbol And Vocabulary Rules

**Files:**

- Modify: `scripts/repo-style-check/layout-rules.mjs`
- Modify: `packages/tests/repo/repo-style-layout-rules.test.ts`
- Modify: `plans/repo-human-traceability-governance-and-checker-plan.md`

**Interfaces:**

- Consumes: `scanRepositoryLayout({ includeDetails: false })` from Task 2.
- Produces: the same result shape, with three additional rule families when
  `includeDetails` is `true`.

- [ ] **Step 1: Write failing primary-export tests**

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

- [ ] **Step 2: Write failing browser boundary tests**

  Cover direct authoritative imports, the named translation boundary, and
  established protocol identities:

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

- [ ] **Step 3: Write failing server vocabulary tests**

  Add a server group-state file with `RoomPolicy`, one with `GroupPolicy`, and
  one that only imports or uses `GroupRef` and `roomRef`. Expect only
  `RoomPolicy` to warn. Include strings and comments containing `room` and prove
  that neither warns.

- [ ] **Step 4: Run the detailed tests and verify failure**

  Run:

  ```bash
  npx vitest run packages/tests/repo/repo-style-layout-rules.test.ts
  ```

  Expected: FAIL because detailed rules are not implemented.

- [ ] **Step 5: Implement conservative primary-export selection**

  Parse each source with `typescript.createSourceFile`. Select named,
  directly-exported, top-level function, class, interface, type alias, enum, and
  variable declarations. Deduplicate overloads by symbol name. Warn only when
  exactly one unique candidate exists and its converted name differs from the
  file stem.

- [ ] **Step 6: Implement browser import analysis**

  Inspect `ImportDeclaration` nodes only. A direct import is authoritative when
  its module path is an authoritative group/state contract module and at least
  one imported name is not `GroupRef` or `roomRef`. Report one warning per room
  module with the sorted imported names in the message. Exclude exactly
  `room-group-state-translation.ts`.

- [ ] **Step 7: Implement server identifier analysis**

  Identify server group-state modules using the path and declaration criteria
  in Section 3.4. Traverse declaration names, excluding import declarations.
  Tokenize identifiers and report one warning per file when the whole token
  `room` or `rooms` appears outside exact `GroupRef` and `roomRef`. Include at
  most five sorted identifier samples.

- [ ] **Step 8: Run the detailed suite and verify success**

  Run the command from Step 4. Expected: PASS in both default and detailed
  modes.

- [ ] **Step 9: Commit and publish the detailed-rule milestone**

  Commit message:

  ```text
  feat: add opt-in traceability heuristics
  ```

  Stage only this task's files and the checked-off plan. Push and update the
  draft pull request.

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

- [ ] **Step 1: Write failing CLI mode tests**

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

- [ ] **Step 2: Write failing package and guide integrity assertions**

  Require both new npm scripts, prohibit `check:repo-style:strict`, and require
  the human guide to document `check:repo-style:layout`,
  `check:repo-style:layout-details`, grouped counts, and the ownership-prompt
  wording.

- [ ] **Step 3: Run focused tests and verify failure**

  Run:

  ```bash
  npx vitest run packages/tests/repo/repo-style-check.test.ts packages/tests/repo/repo-code-style-integrity.test.ts
  ```

  Expected: FAIL because the CLI flags and package scripts do not exist.

- [ ] **Step 4: Load each production source once**

  In `main`, preserve `collectSourceFiles` and `isProductionCodeFile`. Replace
  the per-file read loop with one filtered source list:

  ```js
  const productionFiles = nestedFiles.flat().filter(isProductionCodeFile);
  const sources = await Promise.all(
    productionFiles.map(async (file) => ({
      file,
      raw: await fs.readFile(file, 'utf8'),
    })),
  );
  ```

  Existing `scanFile` receives those same `raw` values when `--layout-only` is
  absent. Do not perform a second filesystem traversal for layout checks.

- [ ] **Step 5: Invoke and print layout results**

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

- [ ] **Step 6: Add package scripts and human instructions**

  Add the exact scripts from Section 3.1. In the human guide:

  - add all six default layout rule families to the current warning list;
  - explain that `check:repo-style:layout` isolates structural review;
  - place `check:repo-style:layout-details` under optional noisy checks;
  - explain the exact room/group-state boundary intent;
  - explain grouped warnings and affected counts;
  - retain the exclusions and no-strict-mode sections.

- [ ] **Step 7: Run focused tests and verify success**

  Run:

  ```bash
  npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts packages/tests/repo/repo-code-style-integrity.test.ts packages/tests/repo/repo-style-layout-rules.test.ts packages/tests/repo/repo-style-check.test.ts
  ```

  Expected: PASS.

- [ ] **Step 8: Verify the checker checks itself**

  Run:

  ```bash
  npm run check:repo-style -- --root scripts/repo-style-check
  ```

  Expected: exit `0` and no new file-length or line-width warning in the checker
  modules.

- [ ] **Step 9: Commit and publish the CLI milestone**

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

**Files:** No intended content changes. Any correction invalidates prior final
gate results and requires rerunning them.

**Interfaces:**

- Consumes: final uncommitted working tree from Tasks 1-5.
- Produces: exact local and remote evidence required to mark this plan complete.

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

- [ ] **Step 4: Run the repository completion gates**

  Run from the unchanged final working tree:

  ```bash
  npm run test:unit
  npm run test:ci
  npm run build
  ```

  Expected: all three commands PASS. Record exact outputs. Any content change
  after a pass invalidates all affected evidence and requires a rerun.

- [ ] **Step 5: Review scope before final publication**

  Run:

  ```bash
  git status --short
  git diff --stat
  git diff --name-only
  ```

  Expected: no changed production file under `apps/**` or production package
  code under `packages/**`; unrelated user changes remain unstaged.

- [ ] **Step 6: Publish the final feature-branch state**

  Commit any final in-scope plan evidence on the non-default branch, push it,
  and update the draft pull request with exact passed, failed, unavailable, and
  skipped results. Do not squash structural evidence into unrelated work.

- [ ] **Step 7: Verify required remote gates**

  Require **Branch Release Gate** to pass for the exact final feature-branch
  commit. After the change reaches the default branch through the human-approved
  repository process, require **Run Hetzner Supported Distributed Manifests**
  to pass for that exact default-branch commit. Record both full commit SHAs.

- [ ] **Step 8: Mark completion only after publication evidence exists**

  Update this plan and the master plan to `complete` only when focused checks,
  all three local completion gates, the current draft pull request, and both
  required remote workflows are complete for the exact published commits.

## 7. Acceptance Checklist

- [ ] `AGENTS.md`, the code-writing skill, the canonical standard, and the human
      guide all state that code is written first for human developers.
- [ ] The canonical standard explains that its detailed rules derive from human
      understandability together with non-negotiable correctness and operational
      constraints.
- [ ] Integrity tests prevent removal of the primary principle or the routing to
      the authoritative standard.
- [ ] The canonical standard defines feature-first organization, co-location,
      filename-to-symbol matching, descriptive route registration, package barrels,
      and the room/group-state vocabulary boundary.
- [ ] The human guide gives a reviewer a top-to-bottom navigation procedure.
- [ ] Default checker output includes six conservative layout rule families.
- [ ] `--layout-only` makes layout debt independently reviewable.
- [ ] `--layout-details` contains primary-export and vocabulary heuristics only.
- [ ] Every layout rule has a stable ID and affected-item count.
- [ ] The checker is documented as a source of review signals, not as the
      definition of understandable code.
- [ ] High-volume filename findings are grouped by directory.
- [ ] Tests, mocks, fixtures, stories, generated code, and test-runner configs
      remain excluded from production counts.
- [ ] Existing 14 `mod.ts` paths pass and a new nested `mod.ts` warns.
- [ ] No strict script or CI gate exists.
- [ ] No production file moved, renamed, reformatted, or semantically changed.
- [ ] Initial default and detailed counts are recorded with the exact commit.
- [ ] Focused, completion, publication, and remote-gate evidence is complete.

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

| Milestone                  | Status  | Evidence              |
| -------------------------- | ------- | --------------------- |
| Plan reviewed and approved | pending | No approval recorded. |
| Governance wording         | pending | Not started.          |
| Conservative layout rules  | pending | Not started.          |
| Opt-in detailed rules      | pending | Not started.          |
| CLI and npm commands       | pending | Not started.          |
| Executable baseline        | pending | Planning counts only. |
| Focused verification       | pending | Not run.              |
| Completion gates           | pending | Not run.              |
| Draft PR and remote gates  | pending | Not published.        |

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
