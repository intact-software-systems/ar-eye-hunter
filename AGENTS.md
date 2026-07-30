# Rallar Agent Guide

Use this file as the lightweight repo orientation. Detailed workflows live in
the repo-local Codex plugin under `.agents/skills/**`.

## Primary Code Goal

Code is written first for human developers. Correctness, safety, security,
compatibility, and required performance are non-negotiable. Within those
constraints, human understandability is the governing design criterion:
prefer the design whose ownership, dataflow, decisions, side effects,
failures, and call paths a human can locate and follow most directly.

Every coding and architecture rule is interpreted through this principle. A
mechanically compliant change is not successful when it makes the code harder
for a human to understand, review, debug, or modify. For TypeScript, use the
`rallar-code-writing` skill and its authoritative repo standard.

## Start Here

- Inspect the existing code and relevant `examples/**` before editing; Rallar
  package docs can lag behind active package work.
- For any TypeScript change, use the `rallar-code-writing` skill and read the
  authoritative repo standard at
  `.agents/skills/rallar-code-writing/references/repo-code-style.md`.
- For authoritative database or realtime service mutations, also read
  `.agents/skills/rallar-code-writing/references/convergent-service-writing.md`.
  Keep a functional core behind an explicitly owned stateful shell; each
  service owns one coherent business capability, one explicit owner, and one
  reason to change.
- For the human review workflow and warning-only check tooling, use
  `docs/repo-human-style-guide.md` and run `npm run check:repo-style`.
- For written implementation plans and clearly long-running repository
  implementation, including docs, scripts, and operations, use
  `publishing-plan-progress`.
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

- Run focused tests for the touched package or app before broader suites.
- When adding or changing REST API behavior, add or adjust Rallar black-box
  recipes/tests in `packages/shared-test/black-box-runner` as part of the same
  change, and run the focused black-box command when the required services are
  available.
- For shared-web public surface work, include public API snapshots and browser
  bundle-boundary checks when exports or entry points change.
- For game/realtime changes, include the relevant app tests/builds and shared
  package tests.
- A written implementation plan may be approved or marked complete only after
  the final uncommitted working tree passes `npm run test:unit`,
  `npm run test:ci`, and `npm run build`. Focused tests are feedback, not a
  substitute for these completion gates. Any change after a successful gate
  invalidates that gate and requires it to run again.
- Publication is also part of completion: keep the draft pull request current,
  require **Branch Release Gate** to pass for the final feature-branch commit,
  and require **Run Hetzner Supported Distributed Manifests** to pass for the
  resulting default-branch commit. Record the exact commit SHA validated by
  each workflow. Do not approve completion: the plan is not complete while any
  required command or workflow is pending, skipped, failed, or attached to an
  older commit.
- An explicit instruction not to commit or push postpones publication; it does
  not waive any completion gate. Continue safe uncommitted work and report the
  plan as incomplete until publication and remote gates are permitted and
  successful.
- Report commands that passed, failed, or were skipped.

## AI Handoff Contract (applies to all agents)

- End each AI task with a concise completion handoff:
  - What changed (files + behavior).
  - Why those changes were chosen (risk/compatibility rationale).
  - Validation evidence (exact command outputs and results).
  - Any follow-up needed.
- Keep the handoff structured, not just an action list. If tradeoffs were made,
  call them out explicitly.
- Every final handoff ends with a collapsed `<details>` block using exactly
  `<summary>Commands executed and what they taught us</summary>`. If no
  commands or tool actions ran, say so inside the collapsed block.
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
