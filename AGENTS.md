# Rallar Agent Guide

Use this file as the lightweight repo orientation. Detailed workflows live in
the repo-local Codex plugin under `.agents/skills/**`.

## Primary Code Goal

> “The goal is not minimum syntax. The goal is minimum cognitive indirection.”

Code is written first for human developers. Correctness, safety, security,
compatibility, and required performance are non-negotiable. Within those
constraints, human understandability is the governing design criterion:
prefer the design whose ownership, dataflow, decisions, side effects,
failures, and call paths a human can locate and follow most directly.

Every coding and architecture rule is interpreted through this principle. A
mechanically compliant change is not successful when it makes the code harder
for a human to understand, review, debug, or modify.

Maintenance work follows touched-file standards closure. Resolve pre-existing
and new noncompliance throughout each touched file while implementing the
requested behavior. Every support file changed by that remediation enters the
closure recursively. Independent untouched code remains outside the closure.
Do not treat warning-only full-repository checks or new/worsened changed checks
as authority to retain touched-file noncompliance.

Escalate only for a genuine exception for a remaining real standards violation,
a public compatibility or migration decision, an unresolved correctness or
safety conflict, or a failed post-consolidation navigation probe. Do not
escalate for pre-existing debt, deadline pressure, diff size, cleanup volume,
ownership recovery, package boundaries, or reprioritization alone.

Avoid cognitive indirection: semantic hops through vocabulary, ownership,
files, abstractions, dataflow, decisions, callbacks, side effects, failures,
tests, compatibility layers, or legacy paths. Keep a hop only when it exposes a
real domain, lifecycle, policy, translation, compatibility, protocol, or
side-effect boundary. The authoritative code standard defines the production,
test, and legacy-closure rules that follow from this principle.

These human-understandability rules govern all human-authored code, including
source, scripts, tests, examples, configuration code, and support tooling. A
language-specific standard may add mechanics for that language but may not
relax visible ownership, dataflow, decisions, side effects, failures, and call paths.
For TypeScript, use the `rallar-code-writing` skill and its authoritative repo
standard.

## Start Here

- Inspect the existing code and relevant `examples/**` before editing; Rallar
  package docs can lag behind active package work.
- For any TypeScript change, use the `rallar-code-writing` skill and read the
  authoritative repo standard at
  `.agents/skills/rallar-code-writing/references/repo-code-style.md`.
- TypeScript type design optimizes for human comprehension: one canonical name
  per type, and never introduce local or exported aliases that merely rename or
  shorten an existing named type. Preserve meaningful qualification such as
  `CreateAccounts.Input`. For types owned by a class, prefer a type-only
  same-name namespace immediately before the class, and keep associated
  namespaces compatible with `erasableSyntaxOnly`. Detailed rules:
  `.agents/skills/rallar-code-writing/references/typescript-type-organization.md`.
- For authoritative database or realtime service mutations, also read
  `.agents/skills/rallar-code-writing/references/convergent-service-writing.md`.
  Keep a functional core behind an explicitly owned stateful shell; each
  service owns one coherent business capability, one ownership boundary, and
  one reason to change.
- For the human review workflow and warning-only check tooling, use
  `docs/repo-human-style-guide.md` and run `npm run check:repo-style`.
- Use `adaptive-plan-execution` for written or multi-slice plans,
  `organizing-repository-structure` for repository shape, `rallar-testing` for
  surface-specific commands, and `publishing-plan-progress` for publication.
- No AI or agent may create or place a commit on `main`, `master`, or the local
  default branch without stating the exact branch, operation, staged file list,
  staged diff summary and staged Git tree ID from `git write-tree`, proposed
  commit message, and all affected full commit IDs; asking for permission
  immediately before the commit; and receiving explicit approval. This includes
  commit, amend, merge, revert, cherry-pick, rebase, and squash operations.
  Editing files or working directly on the default branch, standing preferences,
  deadlines, or task-start approval do not count. Each default-branch commit
  requires a new permission request and approval; any content, message, input,
  conflict-resolution, or target change invalidates prior approval.
- No AI or agent may push `main`, `master`, or the remote default branch
  without stating the exact remote, destination ref and refspec, resolved full
  old and new commit IDs, and whether the push is forced; asking for permission
  immediately before the push; and receiving explicit approval.
  Working or committing on the default branch, standing publication
  preferences, authentication, deadlines, or task-start approval do not count.
  Each default-branch push requires a new permission request and approval.
  Commit and push permissions are independent; approval for one never grants
  approval for the other.
- For a supported authenticated governance decision, an AI may use
  `npm run governance:decide -- apply` after showing the exact canonical request
  and expected main head and receiving one just-in-time approval for that exact
  atomic mutation. A changed request or head invalidates approval and requires
  a new one. Never hand-write governance receipts, directly edit/delete a plan,
  fabricate completion or review evidence, or construct a tracked plan overview as
  substitutes.
- For package/app changes, read the relevant repo skill in `.agents/skills/**`:
  - `building-rallar-apps` first for greenfield apps and React/3D architecture;
    then use the authority, realtime, and testing specialists for the selected
    surfaces.
  - `rallar-platform` for package boundaries and public surfaces.
  - `rallar-realtime` for rooms, presence, WS/RTC, scoped identity, and routing.
  - `rallar-games` for AR Eye Hunter, Relic Hunters, Rallar Game, and Motion.
  - `rallar-ai` for RallarAI providers, schemas, and deterministic helpers.
  - `rallar-code-writing` for package code style and testability.
  - `rallar-testing` for validation commands.
- Keep `.codex-plugin/plugin.json` as the source that exposes these skills to
  Codex. Do not add a separate `SKILLS.md` unless the plugin format changes.

## Product Truths

- Treat `packages/**` as the reusable product surface and `apps/**` as
  consumers.
- Keep Rallar black-box control protocol, distributed-run artifact contracts,
  reusable recipe fixtures, and artifact analysis in `packages/shared-test`;
  `apps/rallar-black-box` should consume those contracts for UI/operator flows.
- Preserve existing public exports and app import paths unless a task explicitly
  asks for a breaking change.
- Prefer `GroupRef`/`roomRef` when application/workspace scope matters.
- For room-scoped app/game traffic, prefer `rallar.realtime.room<T>(...)` and
  `rallar.messages.room<T>(...)` before hand-wiring RTC readiness and sends.
- Use Rallar Data for browser-local latest-value state, not live match truth.
- Use Rallar CRDT for collaborative authored documents, not competitive live
  match authority.
- Use Rallar Motion for presentation smoothing, not simulation authority.
- RallarAI output is proposal data until validated and accepted by domain code.
- AppInbox is mandatory for incoming database mutations. The canonical service
  reference owns its transaction/retry rules, optimistic compare-and-set
  semantics, permissive convergence, immutable facts, locking boundaries, and
  verification requirements. Specialist skills contain only domain deltas.
- Authoritative persisted and shared contracts use mandatory fields by default;
  sparse input and migration shapes remain separate.

## Validation

- Use `rallar-testing` to select affected checks and
  `adaptive-plan-execution` for plan-level validation scope and checkpoints.
- Run focused tests for the touched package or app before broader suites.
- When adding or changing REST API behavior, add or adjust Rallar black-box
  recipes/tests in `packages/shared-test/black-box-runner` as part of the same
  change, and run the focused black-box command when the required services are
  available.
- For shared-web public surface work, include public API snapshots and browser
  bundle-boundary checks when exports or entry points change.
- For game/realtime changes, include the relevant app tests/builds and shared
  package tests.
- Report commands that passed, failed, or were skipped.

## AI Handoff Contract (applies to all agents)

- End each AI task with a concise completion handoff:
  - What changed (files + behavior).
  - Why those changes were chosen (risk/compatibility rationale).
  - Validation evidence (exact command outputs and results).
  - Any follow-up needed, including created or reused GitHub Issue URLs, or an
    explicit statement that there were none.
- Keep the handoff structured, not just an action list. If tradeoffs were made,
  call them out explicitly.
- Every final handoff ends with a Markdown
  `### Commands executed and what they taught us` section. When commands or tool actions ran, include a concise
  grouped bullet for each repeated or consequential action. If no commands or
  tool actions ran, write `No commands or tool actions were run.` in that
  section.
- Group repeated or equivalent commands. For each command or consequential
  tool action, explain why the command or action was chosen, the important
  result or exit status, what its result means, and one useful lesson or
  reusable troubleshooting insight. Keep routine output summarized instead of
  pasting raw logs.
- Never expose secrets, tokens, credentials, authorization headers,
  environment-file contents, or other sensitive values in the learning
  summary. Describe only the safe shape and outcome of sensitive operations.

## Performance analysis repo guidance

When using the `performance-analysis` skill:

- Start static audits from `packages/**`, `apps/api-v1`,
  `apps/rallar-black-box-control-server`, and
  `apps/rallar-black-box-headless`.
- Read `scripts/perf/README.md` and the relevant existing harness under
  `scripts/perf/**` before adding a benchmark.
- Run focused correctness tests from the `rallar-testing` skill before
  accepting an optimization.
- Put generated profiles under `tmp/perf/` and do not commit them unless
  explicitly requested.
- Treat `packages/shared/webrtc`, `packages/shared/multicast`,
  `packages/shared-web/browser`, and shared-server queue/state paths as
  performance-sensitive when they are on the measured workload.
- Treat historical plans and generated black-box artifacts as context, not a
  runtime baseline unless the environment and workload match.
