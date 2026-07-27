# Rallar Agent Guide

Use this file as the lightweight repo orientation. Detailed workflows live in
the repo-local Codex plugin under `.agents/skills/**`.

## Start Here

- Inspect the existing code and relevant `examples/**` before editing; Rallar
  package docs can lag behind active package work.
- For any TypeScript change, use the `rallar-code-writing` skill and read the
  authoritative repo standard at
  `.agents/skills/rallar-code-writing/references/repo-code-style.md`.
- For the human review workflow and warning-only check tooling, use
  `docs/repo-human-style-guide.md` and run `npm run check:repo-style`.
- For written implementation plans and clearly long-running repository implementation,
  including docs, scripts, and operations, use `publishing-plan-progress`.
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
- **AppInbox is mandatory for incoming database mutations.** Every incoming
  HTTP and WebSocket database mutation goes through it, including client/group/
  topology, authentication/session/ticket, CRDT append/admin, and mutating
  admin operations. A synchronous result wait never falls back to a direct
  mutation.
- AppInbox owns the transaction and retry boundary. Keep direct `read`,
  `compute`, and `validate` phases, then open the AppInbox transaction. The
  `compute` and `validate` phases are pure. Computed persistence data is not
  called a plan. The service
  `write(transaction, computed)` applies it: service write receives the
  transaction and never opens, commits, replaces, or retries one. A conflict
  returns to AppInbox for a fresh read and complete revalidation.
- The received transaction commits state, event, receipt, durable result, and
  final `APP_OUTBOX`/`WS_OUTBOX` rows directly through
  `ResourceInboxRepository` in the same transaction. There is no intermediate
  mutation outbox. Resolve logical WebSocket audiences and wake workers after
  commit.
- Resource inbox allows 20 total processing attempts. Attempts one through five
  wait 1, 2, 4, 8, and 16 ms; later waits rise through seconds, cap at 30
  seconds, and use jitter. A separate best-effort fairness lane claims retries
  more than 30 seconds overdue independently from timeout recovery.
- Optimistic compare-and-set writes with bounded retries are the default for
  authoritative shared database state. Conditional insert owns creation;
  expected-revision compare-and-set owns updates; expected-revision conditional
  delete owns deletion and expiry. The runtime-state operations are
  `insertIfAbsent`, `upsertIfRevision`, and `deleteIfRevision`.
- Every optimistic retry must re-read and rerun authorization, policy, capacity,
  lifecycle, and invariant checks. Never retry only a stale final write.
- Keep authoritative mutation control flow as direct, named `read`, `compute`,
  `validate`, and `write` statements. The conditional guard is the first write.
  Measure direct phases and the AppInbox transaction separately. Final outbox
  insertion is insert-only: a collision rolls back and never loads a winner.
  The `MutationReceipt` family remains compact authority, and group effects
  carry `GroupStateCausalRevision`.
- Preserve caller omission as explicit `null` in the semantic command and hash
  that intent before applying server clock or random defaults. Capture any
  volatile candidate once in mandatory immutable facts only after a validated
  ledger miss, and never regenerate it during compare-and-set retries. Matching
  replays and conflicting key reuse must return or fail without invoking random,
  clock-default, verifier, or other volatile materialization callbacks.
- Internal maintenance command/request identity must be a collision-safe
  canonical projection of every semantic field other than the derived
  command/request identity itself: operation, full scope,
  principal/session/generation fences, observed predecessor values, and all
  cleanup or expiry timestamps. A payload hash does not make an incomplete or
  raw-delimiter-joined idempotency key safe.
- Authoritative user-write authentication dependencies are mandatory and fail
  closed; do not add optional authority repositories, missing-authority
  fallbacks, or production overloads shaped only for tests.
- Keep internal cleanup/expiry behind a separately wired narrow maintenance
  capability. Never expose it through public group service or app-inbox types,
  and never accept caller-provided actor, reason, or bypass fields.
- Queue locks are coordination-only for bounded reservation claims. They do not
  approve domain row, table, advisory, or CRDT document locks. Existing direct
  handlers, service-owned transactions/retries, intermediate outboxes, and
  domain locks are migration debt, not precedent. Deadline, sunk-cost, or
  authority pressure does not waive these rules or required verification.
- Authoritative persisted, replicated, queued, event, snapshot, and response
  contracts use mandatory fields by default. Optional fields require meaningful
  domain absence and consumer tests; sparse request, query, patch, builder, and
  migration inputs use separate types. In other words, authoritative shared
  fields are mandatory except documented input or migration exceptions.
- Successful authoritative responses must require every field that the service
  always populates, with shared TypeScript, derived response types, OpenAPI
  `required` arrays, serializers, and consumer/schema tests kept in agreement.
- Validate canonical storage key, stored value identity, and trusted
  command-slot relationships before every authoritative compare-and-set.
  Never derive the expected actor, target, principal, session, or request
  identity from the candidate row being validated.
- Validate decoded identity on every authoritative direct, prefix-list, page,
  event, and compact-receipt read. Derive the expected scope and slot from the
  trusted request or decoded canonical key, never from the stored value. A
  mismatch is typed invariant corruption: fail the whole read rather than
  treating it as a miss, filtering it, rewriting it, or guessing its scope.
- Scoped storage keys must be injective over field name, value type/presence,
  and value. URI escaping strings is not absence encoding: an absent scope may
  never alias any valid explicit identifier. Test delimiter, percent, sentinel,
  child-key, prefix/list, and repository-boundary cases. Migrate an ambiguous
  legacy row only after its stored value proves the intended scope and the new
  key is claimed conditionally; never fan one row into two scopes or add an
  unbounded dual-read fallback.
- Validate the complete operation-specific candidate by canonical deterministic
  recomputation and exact comparison, including guards, dependent rows, events,
  receipts, and outbox intents. Shared shape checks alone are insufficient.
- Snapshot assemblers must treat optimistic presence summaries as hints. At one
  captured observation time, intersect summary sessions with the latest group
  being active and unexpired, current active membership, and connected,
  unexpired session state. Preserve causal revisions while reporting zero live
  presence for archived, deleted, or expired groups.
- Group presence mutations use a per-session guard and do not contend on the
  group row; aggregate metadata and roster mutations use the group guard.

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
