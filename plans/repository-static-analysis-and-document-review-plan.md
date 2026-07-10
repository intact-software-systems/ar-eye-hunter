# Repository Static Analysis, Documentation Review, And Remediation Execution Plan

Date: 2026-07-10

Status: Reviewed and ready for execution

Baseline observed while planning: `7c32dbec6a34309e75b7640ec4b2a2bfd4b04476`

> **For agentic reviewers:** Execute one iteration at a time and update the
> coverage ledger before moving on. Use `superpowers:using-git-worktrees` to
> create the immutable audit source and the repo-local `performance-analysis`
> skill for the performance pass. Keep Phases A–F read-only against the frozen
> audit source. In Phase G, use `superpowers:systematic-debugging`,
> `superpowers:test-driven-development`, and
> `superpowers:verification-before-completion` to implement confirmed bounded
> fixes in a separate writable remediation worktree. Major or breaking changes
> require follow-up plans and manual approval instead of implementation.

**Goal:** Perform a complete, evidence-backed static review of all first-party
code and repository documentation, add missing behavior coverage, implement
confirmed bounded fixes, and produce manual-review plans for major or breaking
remediation, with the deepest effort assigned to `packages/**` and
`apps/api-v1/**`.

**Architecture:** The program uses two isolated stages. Phases A–F audit an
immutable baseline through vertical domain iterations and horizontal risk
sweeps, then seal the evidence. Phase G creates a separate writable remediation
worktree from a recorded, delta-audited target head, classifies every finding,
adds tests and minimal fixes for bounded work, and writes follow-up plans for
changes requiring architectural, breaking, migration, investigation, runtime,
or external decisions. Central coverage, findings, remediation, and change
ledgers make completion measurable.

**Technology:** TypeScript, TSX, Deno, Node.js/npm workspaces, React, Vite,
Babylon.js, Hono, Vitest, Playwright, PostgreSQL, PGlite, Prisma/SQL, shell,
GitHub Actions, Markdown, JSON, and YAML.

## Global Constraints

- All tracked first-party code is in scope.
- Review an immutable detached worktree at the frozen commit. Do not read audit
  evidence from a mutable working tree, and verify source commit and cleanliness
  at every iteration gate.
- `packages/**` and `apps/api-v1/**` receive Tier A depth: every code,
  configuration, schema, migration, and test file is reviewed semantically, and
  critical paths receive a second cross-cutting pass.
- Other first-party code receives Tier B depth: every file is reviewed at least
  once, and high-risk entry points receive the same cross-cutting passes as
  Tier A.
- Current, authoritative documentation receives a semantic accuracy review.
- Historical and experimental material receives complete inventory, status,
  duplication, supersession, link, and staleness review; it does not receive the
  same line-by-line product-truth review as current documentation.
- Phases A–F are read-only with respect to product code and current docs.
  Curated audit reports may be added; raw output belongs under
  `tmp/repo-audit/` and must not be committed.
- Phase G may change product code, tests, and current documentation only for a
  confirmed bounded finding that passes the remediation eligibility rules in
  Section 9. Preserve public exports, import paths, protocols, persisted
  formats, configuration contracts, and supported behavior unless a separately
  approved follow-up plan explicitly authorizes a change.
- Every production fix follows root-cause investigation and a verified failing
  regression test before implementation. Correct-but-uncovered behavior uses a
  characterization-test path and does not require a production change.
- Never leave a newly added test failing, skipped, todo-only, focused with
  `.only`, or otherwise hidden. Deferred failing reproducers remain temporary
  audit evidence, not committed suite content.
- Major refactors, breaking changes, migrations, coordinated rollouts,
  unresolved investigations, runtime-measurement work, destructive/data
  repair, and external actions are plan-only until manual approval.
- Do not upload source, lockfiles, secrets, or findings to an external scanner
  without explicit approval.
- Do not run live services, production calls, browser workflows, Postgres
  integration, profiling, or load tests as part of Phases A–F. Phase G may run
  local focused tests, builds, browser tests, and ephemeral memory/Postgres
  services when required and authorized; production/external calls and live RTC
  remain approval-gated.
- Type checks, linters, format checks, bundle-boundary checks, local SAST, and
  dependency metadata scans are allowed because they do not exercise live
  product behavior.
- Static performance findings must use one of these labels: `Proven from code`,
  `Strong suspicion`, or `Needs runtime measurement`. Do not call an issue a
  measured bottleneck without runtime evidence.
- Code, tests, generated schemas/OpenAPI, package scripts, and public API
  snapshots outrank prose when sources disagree.
- Every finding must identify an exact file and line or explain why a precise
  location is not applicable.
- Record commands as passed, failed, unavailable, or skipped. Never silently
  omit a requested check.
- A finding cannot be marked fixed when a required validation failed, was
  skipped, or was unavailable. It remains blocked or is routed to a follow-up
  plan with the missing proof identified.
- Do not stage, commit, push, open a pull request, or integrate remediation
  changes unless the user separately requests it. Record the remediation
  worktree, branch, HEAD, deterministic worktree-state ID, and change manifest
  so uncommitted changes can be reviewed and reproduced manually.
- Preserve unrelated working-tree changes. At planning time, the checkout
  contained an unrelated modification to
  `plans/rallar-browser-match-support-implementation-plan.md`; audit execution
  must record the current dirty baseline and must not overwrite any such change.

---

## 1. Scope And Review Depth

### 1.1 Tier A: priority code

Review these paths file by file and then revisit their high-risk flows during
the horizontal passes:

- `packages/shared/**`
- `packages/shared-web/**`
- `packages/shared-server/**`
- `packages/shared-graph/**`
- `packages/shared-test/**`
- `packages/relic-hunters/**`
- `packages/tests/**`
- `apps/api-v1/**`

Tier A review includes:

- public contracts, barrels, entry points, and compatibility
- correctness, invariants, validation, and error semantics
- authentication, authorization, tenant/workspace/application/room scoping
- asynchronous ordering, cancellation, retries, idempotency, and lifecycle
- persistence, transactions, migrations, indexes, cache semantics, and recovery
- WebSocket/WebRTC routing, backpressure, presence, and reconnect behavior
- CRDT convergence and durability boundaries
- RallarAI proposal validation and deterministic fallbacks
- Game authority and Motion presentation-versus-simulation boundaries
- algorithmic complexity, allocation, retained-resource, and I/O hypotheses
- observability, privacy, logging, and operational failure modes
- tests, test gaps, docs, examples, and public API claims

### 1.2 Tier B: all remaining first-party code and configuration

Every code/configuration file in these areas must appear in the coverage ledger
and receive at least one manual pass:

- remaining `apps/**`
- `examples/**`
- `scripts/**`
- `tests/**`
- `.github/actions/**` and `.github/workflows/**`
- root TypeScript, Deno, npm, Docker, shell, Git, and editor/run configuration
- `.codex-plugin/**`, `.agents/**`, `AGENTS.md`, and `skills/**` as executable
  agent guidance

High-risk Tier B entry points—authentication, remote execution, deployment,
shell commands, control tokens, browser lifecycle, network transports, artifact
handling, and game authority—also receive the relevant horizontal review.

### 1.3 Documentation scope

Deep semantic review:

- `README.md`, `AGENTS.md`, and `docs/**`
- package architecture/README files
- app current-state, user, operational, and API documentation
- `examples/**/README.md` as executable teaching material
- current black-box recipe and contract documentation
- environment-variable, deployment, troubleshooting, and runbook documents

Inventory/status review:

- `plans/**`
- `iterations/**`
- `playground/**`
- `projects/**`
- historical implementation logs and dated performance reports

### 1.4 Specialized rather than line-by-line treatment

- `package-lock.json` and `deno.lock`: integrity, reproducibility, dependency,
  and supply-chain review.
- generated schemas, OpenAPI, recipe matrices, and manifests: validate against
  their producers/consumers and schemas.
- tracked generated output such as `test-results/.last-run.json`: record as a
  repository-hygiene issue; do not semantically review its generated content.
- binary/media assets: inventory path, size, provenance/license metadata, and
  references; do not perform source-code review.

### 1.5 Exclusions

Exclude generated or local-only directories that are not tracked product
sources:

- `node_modules/**`
- `dist/**` and `build/**`
- `.artifacts/**`, `artifacts/**`, `coverage/**`
- `playwright-report/**`, untracked `test-results/**`
- `tmp/**`, `*.tsbuildinfo`, editor caches, and OS files

An excluded path still belongs in the scope manifest with an exclusion reason.

## 2. Known Baseline And Planning Hypotheses

The planning inventory found approximately:

- 1,455 tracked files in the current checkout
- 201 tracked Markdown/MDX files
- about 418k tracked code-like lines across TypeScript/TSX, JavaScript modules,
  shell, SQL, Prisma, HTML, and CSS
- about 76k documentation lines
- about 285k code-like lines under `packages/**`
- about 17k code-like lines in `apps/api-v1/**`
- about 128k test lines in `packages/tests/**`

The following are seed hypotheses to verify, not accepted findings:

- root TypeScript references/scripts may still mention nonexistent `apps/web`
  or `apps/api`, and active projects may be missing from the root reference set
- `npm run lint` may be a type-check alias rather than a repository lint gate,
  and several app workspaces have no lint script
- ESLint and Prettier are installed without a repository-wide enforced config
- release CI may omit formatting, genuine linting, Relic unit tests, AR/Relic
  Playwright, dependency scanning, secret scanning, and SAST
- `apps/relic-hunter-server-v1` imports implementation from
  `apps/api-v1/src/**`, creating cross-app coupling
- large files such as `apps/rallar-black-box/src/App.tsx` and
  `packages/shared-web/browser/rallar.ts` may concentrate responsibilities
- current documentation indexes contain missing or stale links, and unchecked
  plans may describe work that already exists
- package/app documentation coverage is uneven

Each hypothesis must be confirmed, narrowed, or rejected during execution.

## 3. Audit Artifacts

Create curated outputs under:

```text
docs/repository-audit/2026-07-10-7c32dbe/
├── README.md
├── audit-snapshot.json
├── remediation-snapshot.json
├── scope-manifest.csv
├── findings.csv
├── findings.md
├── remediation-ledger.csv
├── change-manifest.csv
├── tool-baseline.md
├── architecture-map.md
├── public-surface-map.csv
├── public-surface-map.md
├── route-topic-control-matrix.csv
├── stateful-resource-matrix.csv
├── persistence-parity-matrix.csv
├── test-and-validation-map.csv
├── test-and-validation-map.md
├── documentation-manifest.csv
├── documentation-defects.md
├── audit-report.md
├── audit-remediation-candidates.md
├── final-report.md
├── resolution-report.md
├── fix-verification.md
├── follow-up-plans-index.md
├── remediation-backlog.md
└── iterations/
    ├── 00-scope-and-baseline.md
    ├── 01-automated-static-baseline.md
    ├── 02-architecture-and-public-surfaces.md
    ├── 03-shared-core.md
    ├── 04-shared-domain-systems.md
    ├── 05-server-and-api-v1.md
    ├── 06-shared-web-and-graph.md
    ├── 07-shared-test-and-package-tests.md
    ├── 08-remaining-packages.md
    ├── 09-games-and-relic-server.md
    ├── 10-black-box-apps.md
    ├── 11-ci-scripts-and-configuration.md
    ├── 12-cross-cutting-risk-sweeps.md
    ├── 13-current-documentation.md
    ├── 14-historical-documentation.md
    ├── 15-audit-reconciliation-and-sealing.md
    ├── 16-remediation-classification.md
    ├── 17-test-first-bounded-fixes.md
    ├── 18-follow-up-plans.md
    └── 19-final-verification-and-publication.md
```

Create manual-review follow-up plans under:

```text
plans/repository-audit-follow-ups/
└── YYYY-MM-DD-<finding-id>-<slug>-implementation-plan.md
```

Keep raw command output and temporary analyzers outside the curated tree:

```text
tmp/repo-audit/7c32dbe/
├── commands/
├── dependency-graphs/
├── static-tools/
├── docs/
├── reproducers/
├── remediation-evidence/
├── curated-draft/
└── scratch/
```

Draft all curated artifacts under `tmp/repo-audit/7c32dbe/curated-draft/` while
the review is in progress. Seal the baseline audit evidence in Iteration 15,
then keep the explicit immutable set below unchanged while Phase G writes
separate remediation artifacts. Publish the verified final set to
`docs/repository-audit/2026-07-10-7c32dbe/` only after Iteration 19 passes and
from the writable report/remediation worktree, never the user's dirty checkout.
If execution starts from a different commit or date, replace the date/SHA
suffixes and record the new baseline in the audit `README.md`.

The Iteration 15 immutable set is exactly: `scope-manifest.csv`, `findings.csv`,
`findings.md`, `tool-baseline.md`, `architecture-map.md`,
`public-surface-map.csv`, `public-surface-map.md`,
`route-topic-control-matrix.csv`, `stateful-resource-matrix.csv`,
`persistence-parity-matrix.csv`, `test-and-validation-map.csv`,
`test-and-validation-map.md`, `documentation-manifest.csv`,
`documentation-defects.md`, `audit-report.md`,
`audit-remediation-candidates.md`, and iteration notes `00` through `15`.
`audit-snapshot.json` records a path and SHA-256 for each of those files but
does not hash itself. Phase G must not edit any file in that set.

The Phase G publication set is exactly: `README.md`,
`remediation-ledger.csv`, `change-manifest.csv`, `final-report.md`,
`resolution-report.md`, `fix-verification.md`, `follow-up-plans-index.md`,
`remediation-backlog.md`, iteration notes `16` through `19`, and every plan
listed in `follow-up-plans-index.md`. `remediation-snapshot.json` records the
`audit-snapshot.json` SHA-256 plus path/SHA-256 entries for that set; it excludes
itself to avoid a recursive hash. Product/test/doc changes are covered by the
recorded final worktree-state ID and `change-manifest.csv`. The final validator
prints the remediation snapshot's own SHA-256 for the handoff record.

The two sets are intentionally disjoint. Audit/report metadata under
`docs/repository-audit/2026-07-10-7c32dbe/**` and manual-review plans under
`plans/repository-audit-follow-ups/**` are publication files covered by the
audit/remediation snapshots. They never enter `change-manifest.csv` or
`remediation_state_id`. The latter cover only finding-linked product, test,
configuration, script, and current-document remediation outside those roots.

### 3.1 Scope manifest schema

`scope-manifest.csv` must contain one row for every tracked file with these
columns:

```text
path,commit,blob_sha,kind,domain,depth,source_status,generated,owner_area,
primary_iteration,static_checks,manual_review,docs_crosscheck,
secondary_pass,review_state,findings,disposition,reviewer,reviewed_at,notes
```

Allowed review states:

- `not-started`
- `in-review`
- `reviewed`
- `excluded-with-reason`
- `generated-specialized-review`
- `blocked`

No blank terminal state is allowed.

### 3.2 Finding schema

`findings.csv` is the sortable source; `findings.md` is the readable rendering.
Use these columns:

```text
id,severity,confidence,finding_kind,audit_status,category,domain,location,title,
evidence,impact,trigger,root_cause_status,root_cause,reproducer,
hypothesis,hypothesis_result,validation,recommendation,compatibility_risk,
related_findings,owner_area,source_iteration,independent_challenge_status,
challenger,challenged_at
```

Allowed finding kinds are `defect`, `test-gap`, `documentation-defect`,
`tooling-gap`, `risk-hypothesis`, `design-choice`, and `positive-control`.

Allowed audit states are `candidate`, `confirmed`, `narrowed`, `refuted`,
`inconclusive`, and `duplicate`. No `candidate` state may remain when Iteration
15 seals the audit. A recommendation is not fix authorization.

Allowed root-cause states are `not-investigated`, `proven-from-code`,
`reproduced`, `inconclusive`, and `not-applicable`. A production fix requires
`proven-from-code` or `reproduced`; an `inconclusive` finding is validation or
follow-up work, never a speculative fix.

Allowed independent challenge states are `not-required`, `pending`,
`confirmed`, `narrowed`, and `rejected`. Critical/High findings may not finish as
`not-required` or `pending`; `challenger` and `challenged_at` are mandatory when
a challenge is complete.

Finding IDs use stable category prefixes:

- `ARCH`: package boundaries and architecture
- `API`: public contracts and compatibility
- `COR`: correctness and invariants
- `SEC`: security, auth, privacy, and secrets
- `CON`: concurrency, ordering, and lifecycle
- `DATA`: persistence, migrations, recovery, and consistency
- `PERF`: CPU, memory, I/O, allocation, and scalability
- `TEST`: test quality and coverage
- `OPS`: CI, deployment, observability, and operations
- `SUP`: dependencies, licenses, and supply chain
- `DOC`: documentation and examples
- `MAINT`: complexity, duplication, dead code, and maintainability

### 3.3 Entity coverage schemas

File coverage alone cannot prove that routes, topics, resources, persistence
objects, public APIs, or suites were enumerated. Maintain these registries:

`public-surface-map.csv`:

```text
entity_id,domain,public_name,entrypoint,definition_locations,consumer_locations,
tests,docs,compatibility_status,primary_review,secondary_review,findings,state
```

`route-topic-control-matrix.csv`:

```text
entity_id,transport,method_or_topic,path_or_name,definition_location,
authentication,authorization,scope,validation,bounds,rate_limit,side_effects,
persistence,events_or_fanout,error_contract,tests,black_box_recipe,
black_box_test,docs,primary_review,secondary_review,findings,state
```

`stateful-resource-matrix.csv`:

```text
entity_id,domain,type_or_factory,definition_location,owner,creation,
mutable_state,concurrency_model,cleanup_or_disposal,timeout_or_cancellation,
growth_bound,recovery,tests,docs,primary_review,secondary_review,findings,state
```

`persistence-parity-matrix.csv`:

```text
entity_id,domain,schema_or_table,definition_locations,migrations,repositories,
consumers,transaction_model,indexes,postgres_behavior,pglite_behavior,
memory_behavior,retention_or_recovery,tests,docs,primary_review,
secondary_review,findings,state
```

`test-and-validation-map.csv`:

```text
entity_id,domain,suite_path,test_kind,production_targets,behaviors,
negative_paths,environment_gate,determinism,cleanup,ci_command,ci_gate,
owner_area,findings,state
```

Every registry uses the same terminal states as the file ledger. Entity IDs are
stable across reruns, and every row links back to exact source locations.

### 3.4 Remediation and change schemas

`remediation-ledger.csv` preserves resolution history without rewriting the
sealed baseline findings. Use these columns:

```text
finding_id,owner_area,trigger,audit_baseline,target_branch,target_head,
remediation_base,merge_base,baseline_locations,source_blob_shas,evidence_refs,
reproducer_ref,
remediation_disposition,eligibility_reason,major_refactor_triggers,
breaking_change,root_cause_status,test_strategy,test_paths,
focused_red_command,focused_red_result,focused_green_command,
focused_green_result,characterization_command,characterization_result,
sensitivity_command,sensitivity_result,static_validation_command,
static_validation_result,route_entity_ids,black_box_recipe_paths,
black_box_test_paths,memory_validation_command,memory_validation_result,
changed_files,post_fix_commands,post_fix_results,broader_validation,
remediation_head,remediation_state_id,follow_up_plan,approval_status,
remediation_status,residual_risk,reviewer,verified_at
```

Allowed dispositions are `bounded-fix`, `test-only`, `documentation-fix`,
`investigation-plan`, `runtime-validation-plan`, `major-refactor-plan`,
`external-action-plan`, `accepted-risk`, and `no-action`. `No-action` is invalid
for a confirmed defect. `Accepted-risk` requires a recorded user decision.

Allowed test strategies are `regression-red-green`, `characterization`,
`static-validation`, and `not-applicable-with-reason`. Allowed remediation
states are `not-started`, `red-verified`, `implemented`, `verified-fixed`,
`verified-test-only`, `verified-documentation-fix`, `follow-up-plan-ready`,
`accepted-risk`, `verified-no-action`, and `blocked`. Only the `verified-*`,
`follow-up-plan-ready`, and `accepted-risk` states are terminal; `blocked`
prevents full program completion and must name the missing decision or proof.

Disposition-to-terminal-state mapping is exact: `bounded-fix` to
`verified-fixed`; `test-only` to `verified-test-only`; `documentation-fix` to
`verified-documentation-fix`; every `*-plan` disposition to
`follow-up-plan-ready`; `accepted-risk` to `accepted-risk`; and `no-action` to
`verified-no-action`.

Allowed approval states are `not-required`, `pending`, `approved`, and
`rejected`. `Accepted-risk` requires `approved`; an unexecuted follow-up plan is
normally `pending`; bounded/test/docs/no-action work uses `not-required` unless
the checkpoint rules require a decision.

Command-result columns contain RFC 4180-quoted JSON objects with at least
`command`, `head`, `stateId`, `exitCode`, `expected`, `observed`, and
`evidencePath`. `broader_validation` is a quoted JSON array of the same objects.
This makes RED, GREEN, sensitivity, static-validation, and black-box evidence
independently machine-checkable rather than embedding it only in prose.

`change-manifest.csv` contains one row per finding-linked remediation target
file. It excludes audit/report artifacts, follow-up plans, snapshot files, and
temporary evidence:

```text
path,finding_ids,change_kind,remediation_base,before_blob_sha,after_sha256,
tests_or_validators,review_status,notes
```

Define the remediation target set as every modified, deleted, and untracked
path outside `docs/repository-audit/2026-07-10-7c32dbe/**`,
`plans/repository-audit-follow-ups/**`, and
`tmp/repo-audit/7c32dbe/**`. Define `remediation_state_id` as SHA-256 over the
remediation `HEAD`, followed by the sorted canonical tuples `path`,
`change_kind`, `before_blob_sha`, and `after_sha256` for exactly that target
set. Use `DELETED` for a removed file and `ABSENT` as the before value for a new
file. Recompute file hashes from disk before calculating the ID;
ordinary `git diff` is insufficient because it omits untracked tests. Preserve
the canonical state manifest used by every RED, GREEN, sensitivity, and final
validation under `tmp/repo-audit/7c32dbe/remediation-evidence/<finding-id>/`.
The final canonical tuples are the rows in `change-manifest.csv`; publication
files cannot affect this ID and therefore cannot create a hash cycle.

`audit-snapshot.json` contains the full audit baseline SHA, audit date, tool
versions, and SHA-256 for every file in the explicit Iteration 15 immutable set;
it excludes itself. `remediation-snapshot.json` contains the audit-snapshot
hash, target branch/head, remediation base/head, final worktree-state ID,
validator version plus pre-publication result, and SHA-256 for every Phase G
artifact and follow-up plan; it excludes itself. The final validator result and
snapshot's own hash are terminal handoff evidence outside the self-referential
manifest. Phase G must not modify a sealed baseline artifact.

### 3.5 Severity and confidence

Severity:

- `Critical`: plausible compromise, cross-tenant exposure, irreversible data
  loss/corruption, or routinely triggered total outage; interrupt the audit and
  notify the user with redacted evidence.
- `High`: serious correctness, security, durability, or availability defect on
  a realistic path; prioritize before the next release.
- `Medium`: meaningful defect or accumulating risk with bounded impact or a
  non-default trigger.
- `Low`: localized quality, clarity, hygiene, or defensive-hardening issue.
- `Info`: observation, positive control, or modernization opportunity without a
  demonstrated defect.

Confidence:

- `Proven from code`: a deterministic path or contradiction demonstrates it.
- `Strong suspicion`: code and configuration strongly support the conclusion,
  but one environmental/runtime fact remains.
- `Needs runtime measurement`: static review supplies a falsifiable hypothesis,
  not production impact.
- `Uncertain`: retain only while actively investigating; resolve before final
  triage.

### 3.6 Evidence standard

Every finding must include:

1. exact location and relevant call/data path
2. violated invariant, documented contract, or concrete risk mechanism
3. trigger/precondition and affected scope
4. existing mitigation or test coverage
5. a way to validate or falsify the finding
6. a narrowly scoped recommendation
7. compatibility and migration risk if fixed

Avoid generic advice, style-only preferences, and duplicate symptoms.

## 4. Standard Iteration Protocol

Use this protocol for every code-review iteration:

1. Freeze the manifest slice and count its files by kind.
2. Read entry points, exports, configuration, architecture docs, and nearest
   tests before reading implementation details.
3. Map inputs, outputs, state owners, side effects, persistence, network calls,
   and lifecycle/disposal paths.
4. Run applicable static checks and preserve exact output.
5. Review every file in the slice; update the ledger immediately rather than
   reconstructing coverage later.
6. Enumerate and update all applicable public-surface, route/topic, stateful
   resource, persistence, and test/validation registry rows.
7. Cross-check public behavior against tests, docs, examples, schemas, and app
   consumers.
8. Record findings with severity, confidence, evidence, and validation.
9. Challenge every Critical/High finding with an independent second read.
10. Merge duplicate root causes and link downstream symptoms.
11. Write the iteration summary: coverage, top risks, rejected hypotheses,
    blocked checks, and recommended next slice.
12. Verify the detached source still points to the frozen commit and has no
    tracked or untracked drift:

    ```bash
    git -C /tmp/rallar-repo-audit-source-7c32dbe rev-parse HEAD
    git -C /tmp/rallar-repo-audit-source-7c32dbe status --porcelain
    ```

13. Pass the iteration gate before beginning the next dependent iteration.

Parallel reviewers may work on independent slices, but they must write separate
iteration notes. One integrator owns the shared findings register and resolves
duplicates and severity disagreements.

### 4.1 Root-cause confirmation protocol

Before a finding becomes eligible for any production fix:

1. Read the complete error, trace, relevant code path, contract, and recent
   changes.
2. Reproduce the issue with the smallest deterministic test or establish a
   deterministic code-path proof when execution is unavailable.
3. Trace the invalid value/state/decision backward to its earliest origin and
   across every relevant component boundary.
4. Find a working analogue in the repository and enumerate meaningful
   differences.
5. Write one falsifiable root-cause hypothesis and the smallest experiment that
   confirms or rejects it.
6. Record the reproducer, hypothesis, result, and root cause in `findings.csv`.
7. If three fix hypotheses fail, stop changing code and reclassify the work as
   `major-refactor-plan` for architectural review.

An unconfirmed static concern may remain a risk hypothesis with a measurement
or investigation plan, but it cannot authorize a speculative production edit.

## 5. Review Lenses

Apply all relevant lenses to Tier A code and the matching lenses to Tier B.

### 5.1 Architecture and public API

- package/app dependency direction and forbidden cross-layer imports
- barrel exports, stable import paths, and accidental public surfaces
- browser/server/runtime-neutral separation
- duplicate algorithms or app-local implementations of package behavior
- hidden global state, ownership, creation, disposal, and dependency injection
- configuration and path-alias drift between npm, TypeScript, Deno, and Vite
- circular dependencies and initialization-order assumptions

### 5.2 Correctness and resilience

- validation, parsing, narrowing, defaulting, and exhaustive state handling
- error propagation versus swallowing, retry classification, and idempotency
- cancellation, timeout, cleanup, and partial-failure behavior
- clock, randomness, identifier, and ordering determinism
- pagination, bounds, quotas, overflow, empty input, and malformed input
- compatibility between old and new APIs and persistence formats

### 5.3 Security and privacy

- authentication and authorization on HTTP, WebSocket, RTC, admin, and control
  paths
- workspace/application/room/principal scoping and object-level authorization
- token creation, storage, logging, expiry, rotation, and redaction
- CORS, trusted hosts, origin checks, redirects, URL parsing, and SSRF paths
- injection into SQL, shell, HTML, JSON, regex, logs, paths, and workflows
- rate limiting, replay resistance, brute force, resource exhaustion, and abuse
- sensitive environment variables, defaults, demo modes, and production gates
- GitHub Actions permissions, untrusted inputs, secret exposure, and action pinning
- dependency integrity, provenance, license obligations, and known vulnerabilities

### 5.4 Concurrency, realtime, and lifecycle

- races between reads/writes, subscribe/unsubscribe, connect/disconnect, and
  reconnect
- listener, timer, socket, stream, task, cache, and browser-resource cleanup
- queue ordering, reservation, retry, dedupe, and at-least/at-most-once behavior
- backpressure, unbounded concurrency, unbounded queues/maps, and fanout
- presence expiry and durable read-through behavior
- signaling readiness versus RTC data-channel readiness
- peer admission, topology, attempt budgets, routing, and scoped identity

### 5.5 Data and persistence

- transaction boundaries, locking, isolation assumptions, and atomicity
- migration parity among Prisma, PostgreSQL, PGlite, and in-memory schemas
- indexes for filters, joins, ordering, queues, prefixes, and pagination
- retention, archival, tombstones, quotas, compaction, and destructive operations
- serialization, versioning, hash/checksum claims, encryption, and recovery
- cache invalidation, TTL cleanup, hydration, stale reads, and memory retention

### 5.6 Static performance

- externally sized loops, repeated scans/sorts/parsing/serialization, and
  algorithmic complexity
- N+1 database/API/file calls and unbounded `Promise.all`
- large materializations, copies, buffers, payload fanout, and response sizes
- maps/caches/listeners/timers with input- or lifetime-proportional growth
- event-loop blocking, synchronous I/O, contention, and serialized queues
- high-cardinality or high-frequency logs/metrics
- cold-start imports and browser bundle-boundary violations

Every suspected performance issue must specify representative, large, and
worst-case inputs plus the later benchmark/profile that would confirm or refute
it. Runtime validation belongs in a follow-up plan under `tmp/perf/`.

### 5.7 Tests and maintainability

- whether tests assert product behavior rather than implementation details
- missing negative, authorization, recovery, restart, concurrency, and boundary
  coverage
- deterministic clocks, seeds, fake providers, repositories, transports, and
  storage
- skipped, opt-in, flaky, environment-dependent, and unowned suites
- dead code, stale aliases, duplicate helpers, oversized files, and unclear
  responsibilities
- unsafe `any`, ignored type errors, non-null assertions, catch-all behavior,
  and unexplained suppressions

### 5.8 Documentation

- audience, purpose, source-of-truth status, owner area, and last-reviewed date
- file links, anchors, commands, paths, API names, env vars, schemas, and examples
- current versus implemented/deferred/historical status
- duplication, contradictions, supersession, missing navigation, and archive
  placement
- snippets that compile/typecheck against current public surfaces
- claims that should instead be generated or tested

## 6. Execution Phases And Iterations

## Phase A — Foundation

### Iteration 0: Freeze Scope And Create The Coverage System

**Purpose:** Establish a reproducible baseline and make omissions visible.

**Files read:**

- `AGENTS.md`
- `.codex-plugin/plugin.json`
- `package.json`, `package-lock.json`, `deno.json`, `deno.lock`
- `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- all workspace manifests and TypeScript/Deno/Vite/Playwright configs

**Actions:**

- Record commit, branch, dirty state, OS, architecture, Node/npm, Deno, and
  TypeScript versions.
- Create a detached worktree for the baseline commit and run every source read
  and static check from that worktree.
- Enumerate tracked files and blob hashes from the frozen commit, never from an
  unrestricted filesystem walk or the mutable checkout.
- Classify every path into code, test, config, schema, docs, generated, lockfile,
  or asset.
- Assign domain, Tier A/B, primary iteration, and source-status taxonomy.
- Record excluded paths and reasons.
- Create the temporary audit artifact tree and initial draft `README.md` outside
  the detached source worktree.

**Commands:**

```bash
BASELINE=7c32dbec6a34309e75b7640ec4b2a2bfd4b04476
AUDIT_SOURCE=/tmp/rallar-repo-audit-source-7c32dbe
AUDIT_OUTPUT=/Users/knut-helgevik/ProjectLocker/ar-eye-hunter/tmp/repo-audit/7c32dbe
git worktree add --detach "$AUDIT_SOURCE" "$BASELINE"
mkdir -p "$AUDIT_OUTPUT/curated-draft" "$AUDIT_OUTPUT/commands" "$AUDIT_OUTPUT/dependency-graphs" "$AUDIT_OUTPUT/static-tools" "$AUDIT_OUTPUT/docs" "$AUDIT_OUTPUT/reproducers" "$AUDIT_OUTPUT/remediation-evidence" "$AUDIT_OUTPUT/scratch"
git -C "$AUDIT_SOURCE" rev-parse HEAD
git -C "$AUDIT_SOURCE" status --porcelain
git -C "$AUDIT_SOURCE" ls-tree -r --full-tree "$BASELINE"
node --version
npm --version
deno --version
```

**Gate:**

- baseline worktree `HEAD` equals the full frozen commit
- detached source worktree has no tracked or untracked drift
- tracked-file count in the manifest equals the `ls-tree` entry count
- every manifest row records the Git blob SHA from `ls-tree`
- every row has `kind`, `domain`, `depth`, and `primary_iteration`
- the mutable checkout's dirty baseline is recorded separately and no existing
  change is modified
- exclusions have explicit reasons

### Iteration 1: Automated Static Baseline

**Purpose:** Capture current compiler, format, lint, bundle, dependency, and
tooling signals without treating tool output as automatically correct.

Run the setup in the detached audit worktree with network access disabled. Use
the local npm binaries; never let `npx` download a missing tool. First attempt
an offline install/cache preflight:

```bash
cd /tmp/rallar-repo-audit-source-7c32dbe
npm ci --offline
test -x ./node_modules/.bin/tsc
test -x ./node_modules/.bin/esbuild
DENO_NO_UPDATE_CHECK=1 deno cache --frozen --deny-import apps/api-v1/src/main.ts apps/relic-hunter-server-v1/src/main.ts apps/rallar-black-box-control-server/src/main.ts
./node_modules/.bin/tsc --version
```

`npm ci --offline` prevents registry access, and Deno's `--deny-import` prevents
remote dependency retrieval while still allowing cached dependencies. If either
preflight or a later command reports a cache miss/import denial, record the
command as `blocked-network-approval`; do not retry with network access until
the user approves it.

**Run the existing checks independently:**

```bash
./node_modules/.bin/tsc -p packages/shared/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/shared-graph/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/shared-web/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/shared-server/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/shared-test/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/relic-hunters/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/tests/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/ar-eye-hunter-v1/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/rallar-black-box/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/rallar-black-box-headless/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/relic-hunters-v1/tsconfig.json --noEmit
DENO_NO_UPDATE_CHECK=1 deno check --frozen --deny-import packages/shared-test/black-box-runner/scenario-black-box.ts packages/shared-test/black-box-runner/recipe-matrix.mts packages/shared-test/black-box-runner/live-preflight.ts packages/shared-test/black-box-runner/rallar-browser-live-validation.mts packages/shared-test/black-box-runner/artifact-reader.ts packages/shared-test/black-box-runner/traffic-plan-reducer.ts packages/shared-test/black-box-runner/api-v1-black-box-run.mts
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
(cd apps/api-v1 && DENO_NO_UPDATE_CHECK=1 deno task check --frozen --deny-import)
(cd apps/relic-hunter-server-v1 && DENO_NO_UPDATE_CHECK=1 deno task check --frozen --deny-import)
(cd apps/rallar-black-box-control-server && DENO_NO_UPDATE_CHECK=1 deno task check --frozen --deny-import)
deno fmt --check
deno lint
git diff --check
```

Run dependency metadata checks only when network access is approved and save
JSON/text output under `tmp/repo-audit/7c32dbe/static-tools/`:

```bash
npm audit --json
deno outdated --recursive --compatible --frozen=true
```

Do not pretend the following currently exist as enforced gates:

- repository-wide ESLint configuration
- repository-wide Prettier configuration
- CodeQL/Semgrep or another configured SAST scanner
- secret scanning
- license/SBOM scanning
- coverage thresholds

Record each as a tooling gap. If the user approves installing/configuring a
scanner, pin its version, document its rules and exclusions, run it first in
report-only mode, and preserve the raw report. Scanner configuration is a
separate change and cannot silently alter the codebase during this audit.

**Manual review of tool coverage:**

- compare root TypeScript references with actual workspaces
- compare `npm run lint` behavior with its name
- compare Deno include/exclude rules with all Deno source paths
- compare release CI checks with local scripts and every test owner
- document false-negative areas not parsed by any current tool

**Gate:** Every command has status, exit code, environment, output path, and an
owner for failures. Tool gaps are findings, not reasons to stop manual review.

### Iteration 2: Architecture, Dependency Direction, And Public Surfaces

**Purpose:** Build the map used by every later reviewer.

**Actions:**

- Map package/app entry points, barrels, exported types, runtime boundaries,
  consumers, aliases, and dependency direction.
- Map HTTP routes, WebSocket topics, RTC lanes, queues, repositories, database
  adapters, schemas, and migrations.
- Map browser/server/shared-only imports and cross-app imports.
- Map public API snapshots and bundle-boundary tests to their owned exports.
- Identify cycles, duplicate canonical algorithms, compatibility bridges, and
  entry points not exercised by a consumer/test.
- Produce `architecture-map.md` and `public-surface-map.md`.

**High-signal searches:**

```bash
rg -n "export .* from|export \*|createRallar|Rallar.*Facade|GroupRef|roomRef" packages apps
rg -n "from ['\"]\.\./|from ['\"]@shared|from ['\"]@shared-web|from ['\"]@shared-server" packages apps
rg -n "Deno\.serve|new Hono|\.get\(|\.post\(|\.put\(|\.delete\(|defineTopic|WebSocket|RTC" apps/api-v1 packages
rg -n "apps/api-v1/src|packages/.*/src|browser/rallar|mod\.ts" apps packages
```

**Gate:** Every Tier A public entry point has an owner, consumer set, test set,
documentation set, and compatibility classification.

## Phase B — Priority Deep Review

### Iteration 3: `packages/shared` Core Runtime

**Scope:** Cross-runtime API contracts, AL/QueueBox primitives, persistence,
resilience, async tasks, services, identity/scoping, WebRTC primitives, and
shared utilities not assigned to Iteration 4.

**Review emphasis:**

- discriminated unions, validation, serialization, and public compatibility
- queue admission/reservation/retry/dedupe/order guarantees
- timeout, cancellation, cleanup, clocks, randomness, and deterministic tests
- cache/map growth, listener ownership, and connection lifecycle
- complexity on externally sized collections and high-frequency paths
- browser/server compatibility and hidden runtime dependencies

**Cross-check:** Matching files under `packages/tests/shared/**`, package exports,
architecture docs, and downstream browser/server consumers.

**Gate:** Every in-scope `packages/shared` file is reviewed; every public symbol
cluster has tests or a recorded gap; stateful objects have documented ownership
and disposal conclusions.

### Iteration 4: Shared Domain Systems

**Scope:**

- CRDT contracts, algorithms, snapshots, encryption, persistence contracts,
  compaction, and recovery
- RallarAI contracts, schemas, lifecycle/dedupe, deterministic helpers, and
  provider boundaries
- Rallar Game authority and browser/server contracts
- Rallar Motion smoothing/presentation contracts
- realtime/RTC shared algorithms not closed in Iteration 3

**Review emphasis:**

- convergence, causal/dependency behavior, replay, quotas, hashes, encryption,
  tombstones, retention, and destructive operations
- AI output validation before acceptance, schema strictness, provider isolation,
  and deterministic fallback
- authoritative simulation versus presentation and proposal data
- backward compatibility of stored and transported envelopes
- adversarial and property-oriented test coverage

**Cross-check:** Relevant shared, shared-web, shared-server, graph, game, and
black-box tests plus `docs/rallar-crdt-*`, `docs/rallar-ai-*`, API reference,
and recipes.

**Gate:** Each domain has a written invariant list, transport/storage boundary,
consumer map, and test-gap assessment.

### Iteration 5: `packages/shared-server` And `apps/api-v1`

This is the highest-value end-to-end iteration and receives two deliberate
passes: implementation/data flow first, security/durability second.

**Scope:**

- server facade and middleware composition
- all API-v1 routes, services, middleware, startup, and configuration
- auth, CORS, rate limits, admin surfaces, and environment modes
- AppInbox, QueueBox, state sync, WebSocket topics, presence, and RTC topology
- repositories, PostgreSQL/PGlite adapters, Prisma schema, SQL migrations, and
  in-memory parity
- CRDT, app-data, graph, group/client state, events, diagnostics, operations,
  and statistics endpoints
- API-v1 tests, OpenAPI/Swagger generation, black-box recipes, and operational
  documentation

**Pass 1 — flow and correctness:**

- trace every route from request validation and authorization through service,
  repository, transaction, response, events, and documentation
- map all list/page/export endpoints and externally controlled bounds
- verify status/error mapping, retry/idempotency semantics, and partial failures
- compare Postgres, PGlite, in-memory, and schema/migration behavior

**Pass 2 — security, durability, and scale:**

- object- and scope-level authorization on every route/topic
- demo/default modes and production hardening
- SQL construction, transactions, row locks, indexes, isolation, and recovery
- queue/pubsub delivery guarantees, recipient resolution, and reconnect/cold
  cache behavior
- rate-limit cardinality and cleanup
- N+1/fanout/full-history/full-materialization hypotheses
- logging of tokens, identifiers, payloads, and sensitive state

**High-signal searches:**

```bash
rg -n "AUTH|Authorization|Bearer|token|password|secret|CORS|origin|rate.?limit" apps/api-v1 packages/shared-server
rg -n "SELECT|INSERT|UPDATE|DELETE|transaction|BEGIN|COMMIT|ROLLBACK|FOR UPDATE" apps/api-v1 packages/shared-server
rg -n "Promise\.all|JSON\.(parse|stringify)|list|page|limit|offset|cursor|prefix" apps/api-v1 packages/shared-server
rg -n "GroupRef|groupId|roomId|workspaceId|applicationId|principal|admin" apps/api-v1 packages/shared-server
rg -n "setTimeout|setInterval|subscribe|unsubscribe|close|dispose|Abort" apps/api-v1 packages/shared-server
```

**Gate:**

- every API route/topic is represented in a route-control matrix with auth,
  scope, validation, bounds, side effects, persistence, tests, and docs
- every REST route records existing black-box recipe/test coverage or an
  explicit coverage gap that Phase G must resolve when behavior changes
- every route/topic row has a terminal primary/secondary review state
- every migration/schema object is represented in the persistence matrix with a
  repository/route consumer and parity result
- every stateful service/repository/queue/cache is represented in the resource
  matrix with ownership and lifecycle conclusions
- every `apps/api-v1` and `packages/shared-server` source/test/config file is
  reviewed
- Critical/High findings have a recorded independent confirmation or rejection

### Iteration 6: `packages/shared-web` And `packages/shared-graph`

**Scope:** Browser facade and narrow entry points, auth/room/data/CRDT/game/media
facades, storage, WS/RTC transports, topology/graph algorithms, and browser
bundle boundaries.

**Review emphasis:**

- full-facade versus narrow-entry compatibility and accidental imports
- lifecycle of sockets, peer connections, streams, timers, listeners, stores,
  and subscriptions
- scoped identity, room switching, cached state, auth expiry, and reconnect
- RTC readiness, fallback, backpressure, peer admission, topology, and failure
  diagnostics
- browser storage isolation, quota, corruption, and cross-tab behavior
- graph correctness, complexity, pathological inputs, and deterministic output
- large facade responsibilities and duplication without prescribing a rewrite

**Cross-check:** Public API snapshots, entrypoint/bundle tests, shared-web tests,
AR/Relic/Black Box consumers, API reference, and examples.

**Gate:** Every browser public surface is traced to implementation, consumers,
tests, docs, and bundle boundary; all stateful resources have a lifecycle verdict.

### Iteration 7: `packages/shared-test` And `packages/tests`

This iteration is priority code, not an afterthought. Test infrastructure and
tests together account for a large share of the repository.

**Scope:** Black-box contracts/runners/providers/recipes/artifacts/distributed
execution and every test under `packages/tests/**`.

**Review emphasis:**

- shared-test ownership boundaries versus app UI/control concerns
- schema validation, untrusted manifests, command execution, host/token policy,
  artifact paths, redaction, and distributed lifecycle
- deterministic dry/memory/live provider parity
- test isolation, cleanup, timeouts, fake clocks, seeds, retries, and flakiness
- assertions that can pass vacuously, excessive mocks, snapshots, and hidden
  environment gates
- production module-to-test mapping, negative paths, and missing risk coverage
- very large test/helper files and duplicated harness logic

**Required output:** `test-and-validation-map.csv` with one row per test suite or
test file using the Section 3.3 schema, plus `test-and-validation-map.md` with a
production-domain rollup across unit, Deno, browser, database, black-box, live,
and performance coverage.

**Gate:** Every test/harness file has a terminal CSV row, every opt-in/excluded
suite is documented, and every Tier A production domain has a test-coverage
verdict.

### Iteration 8: Remaining Package Surface

**Scope:** `packages/relic-hunters/**`, package manifests/configuration, package
architecture files, and any package file not closed in Iterations 3–7.

**Review emphasis:** Pure game rules, protocol/blueprint validation,
determinism, package isolation, exports, dependency metadata, and consumer/test
alignment.

**Gate:** No `packages/**` manifest row remains `not-started` or `in-review`.
Run a second-pass ledger query to confirm all Tier A package rows are terminal.

## Phase C — Remaining Code

### Iteration 9: Game Apps And Relic Server

**Execution status (2026-07-10): completed in audit workspace.** All 112
manifest rows were reviewed and recorded in
`tmp/repo-audit/fd0f4e9/curated-draft/iterations/09-game-apps-relic-server.md`.
Focused Relic tests (101), both app production builds, and the Relic server
type check passed. The server test task has no test modules; `PERF-003` records
the oversized production chunks for a bounded follow-up performance plan.

**Scope:**

- `apps/ar-eye-hunter-v1/**`
- `apps/relic-hunters-v1/**`
- `apps/relic-hunter-server-v1/**`

**Review emphasis:**

- simulation and authority versus render/presentation state
- React hook effects, dependency arrays, cleanup, stale closures, and race paths
- Babylon scene/resource ownership, disposal, asset failure, and input lifecycle
- room creation/join/switch, presence, realtime, AI, and offline/degraded modes
- cross-app import from API-v1 and server composition boundaries
- UI accessibility and security-relevant browser state where visible statically
- build/test configuration and documentation gaps

**Gate:** Every code/config file is reviewed; each app has an entrypoint/data-flow
map, resource-lifecycle verdict, test-gap summary, and docs-gap summary.

### Iteration 10: Black Box UI, Control Server, And Headless App

**Scope:**

- `apps/rallar-black-box/**`
- `apps/rallar-black-box-control-server/**`
- `apps/rallar-black-box-headless/**`

**Review emphasis:**

- separation between reusable shared-test contracts and operator UI flows
- remote command/control authorization, token/host policy, CORS, and redaction
- manifest/schema validation and safe process/shell execution
- artifact path traversal, retention, partial writes, and cleanup
- browser worker lifecycle, reconnection, distributed run state, and cancellation
- the oversized SPA component/style surface, duplicate logic, and testability
- UI/manual/recipe consistency

**Gate:** Every remote-control and artifact boundary has a security/data-flow
trace; every file is reviewed; shared-test/app ownership violations are listed.

### Iteration 11: CI, Scripts, Examples, And Repository Configuration

**Scope:**

- `.github/**`
- `scripts/**`, root shell scripts, and `docker-compose.yml`
- `examples/**`
- `tests/**` outside `packages/tests`
- root/workspace config, `.run/**`, `.vscode/**`, and tracked `.idea/**`

**Review emphasis:**

- GitHub Actions triggers, permissions, secret handling, untrusted inputs,
  environment protection, concurrency, artifact retention, and action pinning
- shell quoting, `set -euo pipefail`, injection, cleanup, remote hosts, SSH, curl,
  and destructive operations
- CI/local parity, missing gates, version pinning, caches, optional/live suites,
  and manual skip paths
- performance harness assumptions and representativeness
- examples that reference stale APIs or cannot be extracted/typechecked
- dead config paths, stale aliases, generated artifacts, and ignored files

**Gate:** Every remaining first-party code/config file has a terminal coverage
state. At this checkpoint, all code is covered even though docs work remains.

## Phase D — Horizontal Risk Sweeps

### Iteration 12: Cross-Cutting Security, Performance, And Maintainability

Revisit Tier A and high-risk Tier B paths by concern rather than domain. This
is the required second pass for priority code.

**Search pack:**

```bash
rg -n "\bany\b|@ts-ignore|@ts-expect-error|eslint-disable|deno-lint-ignore|!\." packages apps
rg -n "catch\s*\(|catch\s*\{|\.catch\(|TODO|FIXME|HACK|XXX" packages apps scripts
rg -n "setInterval|setTimeout|addEventListener|removeEventListener|subscribe|unsubscribe|AbortController" packages apps
rg -n "new Map|new Set|cache|queue|buffer|Promise\.all|JSON\.(parse|stringify)|structuredClone" packages apps
rg -n "Deno\.env|process\.env|eval\(|new Function|Deno\.Command|child_process|exec\(|spawn\(" packages apps scripts .github
rg -n "http://|https://|Authorization|Bearer|token|secret|password|private.?key" packages apps scripts .github
```

Do not file a finding from a search match alone. Trace control/data flow and
existing mitigations.

**Required sweeps:**

1. security and scope isolation
2. async/concurrency and retained-resource lifecycle
3. static performance and scalability hypotheses
4. public compatibility and architecture-boundary violations
5. maintainability, duplication, dead code, and oversized responsibilities
6. test-gap reconciliation against the final code-risk map

**Gate:** Every Tier A manifest row has `secondary_pass=reviewed` or an explicit
reason the lens is not applicable. All Critical/High findings are challenged
and all performance findings use the required confidence labels.

## Phase E — Documentation

### Iteration 13: Current And Authoritative Documentation

**Purpose:** Verify current docs against executable truth after code review has
established that truth.

**Actions:**

- Build `documentation-manifest.csv` with:

```text
path,taxonomy,audience,domain,owner_area,current_status,last_reviewed,
canonical_source,superseded_by,code_tests_used_for_validation,links,
link_verdict,commands,env_vars,api_symbols,snippets,staleness_evidence,
staleness_verdict,duplicate_group,duplication_verdict,supersession_verdict,
findings,review_state
```

Documentation `review_state` uses the Section 3.1 states. Verdict values are:

- `link_verdict`: `valid`, `broken`, or `not-applicable`
- `staleness_verdict`: `current`, `partially-stale`, `stale`, or
  `not-determinable`
- `duplication_verdict`: `unique`, `duplicate`, or `partial-overlap`
- `supersession_verdict`: `canonical`, `superseded`, `not-superseded`, or
  `not-determinable`

Any `not-determinable` value requires evidence and a user-decision entry before
final sign-off.

- Review root navigation, canonical docs, package architecture, app manuals,
  operations/runbooks, examples, and black-box contract docs.
- Validate local file links and anchors.
- Validate referenced repository paths.
- Validate `npm run` and `deno task` names against the correct manifest.
- Compare environment-variable names/defaults with actual loaders and CI/deploy
  configuration.
- Compare documented API symbols with exports and public API snapshots.
- Compare routes and payload claims with OpenAPI/schema/tests.
- Extract TypeScript snippets and examples into temporary files and typecheck
  them against the intended public entry point.
- Identify missing current docs for code areas that require operator or consumer
  guidance.

Use a temporary local link analyzer under `tmp/repo-audit/7c32dbe/docs/` that:

1. enumerates Markdown using `git ls-files '*.md' '*.mdx'`
2. resolves relative links from the containing file
3. normalizes Markdown heading anchors consistently
4. reports missing targets, missing anchors, case mismatches, and paths into
   generated/untracked output
5. excludes remote HTTP status checks unless network access is approved

**Gate:** Every current/authoritative doc has semantic, link, command, env/API,
and ownership verdicts. Every code/doc contradiction identifies the executable
source of truth.

### Iteration 14: Plans, Iterations, Playground, Projects, And Agent Guidance

**Purpose:** Make historical and experimental material navigable without
mistaking it for current product truth.

**Actions:**

- Classify every document as current, active plan, implemented, completed,
  deferred, superseded, historical evidence, experimental, or archive candidate.
- Give every historical/experimental document an explicit link, staleness,
  duplication, and supersession verdict, including evidence for `not-stale`,
  `unique`, and `not-superseded` conclusions.
- Verify status claims with targeted code/test evidence; do not trust unchecked
  boxes as proof of missing implementation.
- Record canonical replacement/supersession links and stable duplicate-group IDs.
- Identify obsolete paths/anchors, misleading current-tense claims, and
  completed work outside completed/archive locations.
- Review `AGENTS.md`, plugin manifest, `.agents/**`, and every exposed
  `skills/**` entry for routing consistency and current package/app facts.
- Produce archive/move/update recommendations without moving files during the
  audit.

**Gate:** Every tracked Markdown/MDX file has a terminal classification and
review state. Every historical/experimental row has nonblank link, staleness,
duplication, and supersession verdicts with evidence. No archive recommendation
is executed automatically.

## Phase F — Reconciliation And Decision Support

### Iteration 15: Reconcile, Rank, And Seal The Audit

**Actions:**

- Query the ledger for missing, blocked, or contradictory states.
- Re-read Critical/High findings and representative Medium findings.
- Merge duplicates around root causes and retain links to downstream effects.
- Reconcile code, tests, docs, schemas, examples, scripts, and CI findings.
- Separate proven defects from design choices, tooling gaps, and runtime
  hypotheses.
- Resolve every `candidate` to `confirmed`, `narrowed`, `refuted`,
  `inconclusive`, or `duplicate`.
- Complete root-cause evidence where the immutable code path proves it; leave
  runtime-dependent hypotheses explicitly inconclusive.
- Rank remediation by severity, confidence, reach, effort, compatibility risk,
  and dependency order.
- Write immutable `audit-report.md` and `audit-remediation-candidates.md`;
  reserve `final-report.md` and `remediation-backlog.md` for Phase G.
- Add a decision log for disputed severity, accepted risk, deferred validation,
  and user choices.
- Create `audit-snapshot.json` with the full baseline SHA and path/SHA-256 for
  every file in the explicit immutable set from Section 3, excluding the
  snapshot itself; then make that set immutable for Phase G.

**Baseline report structure:**

1. executive summary and top risks
2. scope, baseline, exclusions, and limitations
3. architecture and hot-path map
4. findings by severity and domain
5. security and supply-chain posture
6. correctness, concurrency, durability, and data findings
7. static performance hypotheses and measurement plan
8. public API and compatibility findings
9. test/CI/tooling gaps
10. documentation health and canonical navigation recommendations
11. rejected hypotheses and positive controls
12. candidate remediation order
13. runtime validations that remain necessary

**Gate:** The audit-snapshot criteria in Section 7.1 pass, no candidate finding
remains, and `audit-snapshot.json` validates every sealed artifact hash.

## Phase G — Tests, Bounded Fixes, And Follow-Up Plans

### Iteration 16: Classify Findings And Create The Remediation Worktree

**Purpose:** Convert each sealed finding into an explicit resolution path while
preserving the audit evidence.

**Actions:**

- Apply the decision model in Section 9 to every sealed finding.
- Create one `remediation-ledger.csv` row per finding, including non-actionable
  and refuted findings so disposition coverage is complete.
- Freeze and record the intended local integration branch and its current head.
  Verify that head descends from the audited baseline. If it is newer, perform
  and record a delta audit of every changed file that overlaps findings,
  contracts, tests, or generated/public surfaces. If it does not descend from
  the baseline, or the delta cannot be reconciled confidently, pause for the
  user's base-selection decision.
- Use the delta-audited target head—not a stale baseline—as the remediation
  base. When the target head equals the baseline, these values are identical.
  Create the writable branch/worktree from that recorded remediation base:

```bash
BASELINE=7c32dbec6a34309e75b7640ec4b2a2bfd4b04476
TARGET_BRANCH="<approved-local-target-branch>"
TARGET_HEAD="$(git rev-parse "$TARGET_BRANCH")"
git merge-base --is-ancestor "$BASELINE" "$TARGET_HEAD"
git diff --name-status "$BASELINE..$TARGET_HEAD"
MERGE_BASE="$(git merge-base "$BASELINE" "$TARGET_HEAD")"
REMEDIATION_BASE="$TARGET_HEAD"
TARGET_SHORT="$(git rev-parse --short=7 "$TARGET_HEAD")"
REMEDIATION_BRANCH="codex/repository-audit-remediation-2026-07-10-$TARGET_SHORT"
REMEDIATION_SOURCE=/tmp/rallar-repo-audit-remediation-7c32dbe
git worktree add -b "$REMEDIATION_BRANCH" "$REMEDIATION_SOURCE" "$REMEDIATION_BASE"
git -C "$REMEDIATION_SOURCE" status --porcelain
git -C "$REMEDIATION_SOURCE" rev-parse HEAD
```

- Install/cache dependencies offline using the Iteration 1 approach.
- Record `audit_baseline`, `target_branch`, `target_head`, `merge_base`,
  `remediation_base`, remediation branch/worktree, delta-audit evidence, tool
  versions, and initial clean status.

**Gate:** Every sealed finding has exactly one allowed disposition and an
allowed status; every `bounded-fix`, `test-only`, or `documentation-fix` passes
eligibility; every investigation/major/breaking/runtime/external finding is
plan-only; the target-to-baseline ancestry and any delta audit are recorded;
and the clean remediation worktree starts at the recorded remediation base.

### Iteration 17: Test-First Bounded Remediation

Work one finding or tightly coupled root-cause cluster at a time. One writer
owns the remediation worktree; parallel agents may investigate or review but
must not edit overlapping files concurrently.

**Confirmed defect — regression red/green/refactor:**

1. Reproduce or re-establish the sealed root cause on the remediation base.
2. Add the smallest behavior-level test in the owning suite.
3. Run the exact focused command and record that the new test fails for the
   intended behavioral reason, not a syntax/setup error, in the structured
   `focused_red_*` fields.
4. Implement the smallest root-cause fix; do not bundle adjacent cleanup.
5. Re-run the focused test and record green output in the structured
   `focused_green_*` fields.
6. Refactor only while the test remains green.
7. Run the owning package/app checks and every blast-radius check required by
   Section 9.5.
8. Record tests, changed files, commands, exit codes, warnings, and residual
   risk in the remediation and change ledgers.

**Correct-but-uncovered behavior — characterization:**

1. Ground the expected behavior in a public contract, executable schema, or
   existing consumer.
2. Add a behavior-level characterization test without changing production code.
3. Prove the test is non-vacuous using a temporary mutation/sensitivity check,
   restore the source, and rerun the test green.
4. Record `test_strategy=characterization`, the normal characterization
   command/result, and the temporary-mutation command/result in the dedicated
   sensitivity fields.

**Documentation/configuration defect:**

- Fix the canonical source or generator rather than generated output.
- Add/run an automated link, schema, type, snapshot, or config validator where
  practical. Otherwise record `not-applicable-with-reason` and independent
  manual verification. Use the dedicated static-validation fields.
- Current-document corrections are eligible; archive/delete/move operations
  remain follow-up-plan work.

**Deferred defect:**

- Never leave the repository with a failing test or a new `.skip`, `.todo`, or
  `.only` that hides the issue.
- Store the exact failing reproducer/test patch under
  `tmp/repo-audit/7c32dbe/reproducers/`, restore the remediation worktree to
  green, and link it from the follow-up plan.

**Gate:** Every eligible bounded/test/docs item is `verified-fixed`,
`verified-test-only`, or `verified-documentation-fix`; all required validation
passes on the recorded remediation worktree state (`HEAD` plus
`remediation_state_id`); and the change manifest contains only files linked to
remediation-ledger findings.

### Iteration 18: Create Investigation, Refactor, Runtime, And External Plans

Create one plan per root-cause cluster under
`plans/repository-audit-follow-ups/`. Group findings only when they share one
root cause, ownership boundary, migration, and validation path.

Every plan starts with `Status: Draft — manual approval required` and contains:

- finding IDs, audit baseline, remediation base, source blob/evidence references
- disposition plus triggered investigation/major-refactor/breaking/runtime/
  external criteria and why direct remediation is ineligible
- goal, non-goals, invariants, affected files, owners, public/data contracts,
  and alternatives
- exact failing test/reproducer to add first, followed by staged implementation
- compatibility, migration/backfill, feature-flag, rollout, and rollback design
- security, data, operations, performance, and consumer impact
- exact validation commands and expected results
- worktree/branch, integration order, unresolved decisions, and residual risk
- an explicit statement that plan creation does not authorize implementation

**Gate:** Every `investigation-plan`, `major-refactor-plan`,
`runtime-validation-plan`, and `external-action-plan` ledger row links to a
complete follow-up plan and `follow-up-plans-index.md`; no such plan has been
executed without explicit approval.

### Iteration 19: Final Verification, Resolution Report, And Publication

**Actions:**

- Review the complete remediation worktree change set, including untracked
  files, by finding ID and reject unrelated changes.
- Compare the current local integration-branch head with recorded
  `target_head`. If it advanced, delta-audit the change. Recreate a replacement
  worktree from the new target head, reapply each bounded finding change, and
  rerun all affected validation before handoff; do not rebase or publish
  blindly. Update `target_head`, `merge_base`, and `remediation_base` only with
  that evidence. If safe replay is not possible, leave the program incomplete
  and request a base/integration decision.
- Recompute the final `remediation_state_id`, then run fresh focused and broader
  validation on that exact worktree state.
- Verify no newly added failing, skipped, todo-only, or focused-only tests.
- Run the audit validator plus a pre-publication remediation-validator pass from
  Section 7.3.
- Write `resolution-report.md`, `fix-verification.md`, the final
  `remediation-backlog.md`, and completed remediation sections of
  `final-report.md`.
- Generate `remediation-snapshot.json` from the complete Phase G publication
  set, excluding itself, and run the remediation validator again to verify both
  snapshots, target/remediation ancestry, the final worktree state, ledgers,
  evidence, follow-up plans, and publication hashes.
- Publish curated reports and follow-up plans from the writable remediation
  worktree; do not touch the user's pre-existing dirty checkout.

**Final report additions:**

14. implemented fixes and additional tests by finding ID
15. remediation worktree/branch/HEAD/state ID and file-change manifest
16. verification commands and results
17. investigation/major-refactor/runtime/external follow-up plans awaiting
    manual review
18. blocked or external actions, urgent containment, accepted risk, and
    residual risk

**Gate:** All program-completion criteria in Section 7.2 pass, both final
validator runs return zero violations, `remediation-snapshot.json` covers every
Phase G artifact, and the final validator prints its own SHA-256.

## 7. Definition Of Complete

### 7.1 Audit snapshot complete

The immutable audit snapshot is complete only when:

- `scope-manifest.csv` contains every tracked file from the frozen commit
- every code/config row is `reviewed`, `excluded-with-reason`, or
  `generated-specialized-review`
- every `packages/**` and `apps/api-v1/**` code/config/test row has a manual
  semantic review and applicable second-pass verdict
- every remaining first-party code/config row has at least one manual review
- every public Tier A entry point maps to implementation, consumers, tests,
  docs, and compatibility status
- every API-v1 route/topic maps auth, scope, validation, bounds, side effects,
  persistence, tests, and docs
- every stateful Tier A component has ownership, lifecycle, cleanup, and
  retained-resource conclusions
- every persistence schema/migration/repository path has parity and transaction
  conclusions
- every test and opt-in/excluded suite has an owner and coverage purpose
- every tracked Markdown/MDX file has taxonomy, status, ownership, and review
  disposition
- current docs have code/test-backed semantic verdicts
- every historical/experimental doc has explicit link, staleness, duplication,
  and supersession verdicts
- local links, anchors, referenced paths, commands, env vars, API symbols, and
  snippets have validation results
- every finding meets the evidence schema and Critical/High findings have an
  independent challenge
- every performance claim has confidence and a falsifiable measurement plan
- automated commands have pass/fail/unavailable/skipped status
- no product code or current documentation changed in the detached audit source
- every finding has a terminal audit status and root-cause status
- `audit-snapshot.json` records the baseline and every path/hash in the explicit
  immutable set, excludes itself, and verifies cleanly
- `audit-report.md` and `audit-remediation-candidates.md` list limitations and
  unresolved blockers explicitly

### 7.2 Remediation lifecycle complete

The full program is complete only when:

- every sealed finding has exactly one remediation-ledger row, one nonblank
  allowed disposition, and the disposition-compatible terminal status
- every confirmed/narrowed actionable finding is `verified-fixed`,
  `verified-test-only`, `verified-documentation-fix`, `follow-up-plan-ready`,
  or `accepted-risk` with a recorded user decision
- no row remains `not-started`, `red-verified`, `implemented`, or `blocked`
- no confirmed defect uses `no-action`
- every production fix has `root_cause_status=proven-from-code` or `reproduced`
- every behavior fix records machine-checkable focused RED and GREEN commands/
  results, minimal changed files, affected-package checks, and broader
  blast-radius validation
- every correct-but-uncovered behavior records a passing characterization test
  and machine-checkable non-vacuous sensitivity evidence
- every current-document/config fix records an automated validator or an
  independently reviewed not-applicable reason
- no new test is failing, `.skip`, `.todo`, `.only`, or otherwise hidden
- every REST API behavior fix adds/updates the matching
  `packages/shared-test/black-box-runner` recipe/test, passes its focused
  route/service test and API-v1 Deno check, and passes
  `npm run test:api-v1:black-box:memory`
- every required validation for a verified item passes on the final recorded
  remediation worktree-state ID; optional Postgres/live checks have explicit
  availability-based status
- every investigation/major/breaking/runtime-validation/external-action finding
  links to a complete manual-review follow-up plan and index entry
- every accepted-risk row records the user decision, owner area, trigger, and
  residual risk
- every changed remediation-target file appears in `change-manifest.csv` and
  links to at least one finding; every audit/report/follow-up-plan path belongs
  to the matching snapshot publication set; the two sets are disjoint and no
  unrelated Git change remains
- the recorded target branch/head descends from the audit baseline, the
  remediation base equals the last delta-audited target head, and the final
  remediation HEAD descends from that base
- the frozen audit source and sealed audit artifact hashes remain unchanged
- no breaking, migration, destructive data, production, credential, or external
  action occurred without explicit approval
- `resolution-report.md`, `fix-verification.md`, `follow-up-plans-index.md`,
  final report, and remediation backlog reflect the final remediation HEAD and
  worktree-state ID
- `remediation-snapshot.json` references the audit-snapshot hash and records
  every final Phase G/follow-up-plan path and hash, excluding itself

### 7.3 Required validators

Create `tmp/repo-audit/7c32dbe/validate-audit-ledgers.mjs` during Iteration 0.
It must parse the frozen Git tree and every CSV using RFC 4180 quoting, reject
duplicate IDs/paths, reject unknown states, apply the assertions below, print a
JSON summary, and exit nonzero if any violation exists.

Run before sign-off:

```bash
cd /Users/knut-helgevik/ProjectLocker/ar-eye-hunter
node tmp/repo-audit/7c32dbe/validate-audit-ledgers.mjs \
  --baseline 7c32dbec6a34309e75b7640ec4b2a2bfd4b04476 \
  --source /tmp/rallar-repo-audit-source-7c32dbe \
  --audit-root tmp/repo-audit/7c32dbe/curated-draft
```

Expected: exit code `0` and JSON containing `"violationCount": 0` for these
required assertions:

```text
count(tracked Git files) == count(scope-manifest rows)
count(code/config rows with nonterminal review_state) == 0
count(Tier A rows without manual_review=reviewed) == 0
count(Tier A applicable rows without secondary_pass=reviewed) == 0
count(public-surface rows with nonterminal state) == 0
count(route/topic rows with nonterminal state) == 0
count(stateful-resource rows with nonterminal state) == 0
count(persistence-parity rows with nonterminal state) == 0
count(test/validation rows with nonterminal state) == 0
count(Markdown/MDX rows without terminal documentation review_state) == 0
count(historical/experimental docs missing link/staleness/duplication/supersession verdicts) == 0
count(document not-determinable verdicts without a recorded user decision) == 0
count(findings with audit_status=candidate or invalid status) == 0
count(Critical/High findings whose independent_challenge_status is not confirmed/narrowed/rejected) == 0
count(PERF findings without confidence or validation) == 0
count(findings with Uncertain confidence at final triage) == 0
set(audit-snapshot paths) == set(explicit Iteration 15 immutable paths)
count(immutable paths whose SHA-256 does not match audit-snapshot) == 0
audit-snapshot does not list itself
```

Create `tmp/repo-audit/7c32dbe/validate-remediation-ledger.mjs` during Iteration 16. It must verify the sealed artifact hashes, parse both ledgers and the change
manifest, inspect the complete worktree change set and Git ancestry, enforce the
lifecycle/evidence criteria, print a JSON summary, and exit nonzero for any
violation. `--mode pre-publication` omits only final publication-manifest checks;
all other assertions still apply.

Run on the final remediation worktree state before writing the snapshot:

```bash
cd /Users/knut-helgevik/ProjectLocker/ar-eye-hunter
node tmp/repo-audit/7c32dbe/validate-remediation-ledger.mjs \
  --mode pre-publication \
  --audit-snapshot tmp/repo-audit/7c32dbe/curated-draft/audit-snapshot.json \
  --audit-root tmp/repo-audit/7c32dbe/curated-draft \
  --remediation-source /tmp/rallar-repo-audit-remediation-7c32dbe \
  --remediation-ledger tmp/repo-audit/7c32dbe/curated-draft/remediation-ledger.csv \
  --change-manifest tmp/repo-audit/7c32dbe/curated-draft/change-manifest.csv
```

After reports and `remediation-snapshot.json` are generated, repeat in final
mode:

```bash
cd /Users/knut-helgevik/ProjectLocker/ar-eye-hunter
node tmp/repo-audit/7c32dbe/validate-remediation-ledger.mjs \
  --mode final \
  --audit-snapshot tmp/repo-audit/7c32dbe/curated-draft/audit-snapshot.json \
  --remediation-snapshot tmp/repo-audit/7c32dbe/curated-draft/remediation-snapshot.json \
  --audit-root tmp/repo-audit/7c32dbe/curated-draft \
  --remediation-source /tmp/rallar-repo-audit-remediation-7c32dbe \
  --remediation-ledger tmp/repo-audit/7c32dbe/curated-draft/remediation-ledger.csv \
  --change-manifest tmp/repo-audit/7c32dbe/curated-draft/change-manifest.csv
```

Expected: exit code `0` and `"violationCount": 0` for at least these
assertions:

```text
count(sealed findings) == count(remediation-ledger rows)
count(sealed findings without exactly one nonblank allowed disposition) == 0
count(rows without a disposition-compatible terminal remediation status) == 0
count(candidate findings) == 0
count(confirmed defects with no allowed disposition) == 0
count(confirmed defects with disposition=no-action) == 0
count(fixed findings without proven/reproduced root cause) == 0
count(regression fixes without machine-checkable RED and GREEN results) == 0
count(RED/sensitivity results whose stateId does not match preserved evidence manifest) == 0
count(final GREEN/characterization/static/memory/broader results whose stateId != remediation_state_id) == 0
count(required confirmed test gaps without verified test-only coverage or follow-up plan) == 0
count(test-only findings without characterization command/result and sensitivity command/result) == 0
count(documentation/config fixes without static-validation command/result or reviewed N/A reason) == 0
count(REST behavior fixes without route IDs, recipe paths, test paths, and passing memory command/result) == 0
count(verified items with failed/skipped/unavailable required validation) == 0
count(new failing/skip/todo/only tests) == 0
count(investigation/major/breaking/runtime/external findings without complete follow-up plans) == 0
count(accepted-risk findings without a recorded user decision) == 0
count(remediation-target files missing from change-manifest or finding IDs) == 0
set(change-manifest paths) == set(Git modified/deleted/untracked paths outside publication roots)
set(Git changes under publication roots) == union(audit-snapshot paths, audit-snapshot itself, remediation-snapshot paths, remediation-snapshot itself)
intersection(change-manifest paths, publication paths) == empty
count(tracked or unignored tmp/repo-audit changes) == 0
count(rows where merge_base != audit_baseline or remediation_base != target_head) == 0
count(rows whose target/remediation base ancestry does not match recorded Git SHAs) == 0
count(rows whose remediation_head does not descend from remediation_base) == 0
count(rows whose remediation_state_id does not match recomputed worktree state) == 0
count(sealed audit artifacts whose SHA-256 changed) == 0
set(remediation-snapshot paths) == set(published Phase G artifact and follow-up-plan paths)
count(remediation-snapshot paths whose SHA-256 does not match) == 0
remediation-snapshot references the verified audit-snapshot hash and excludes itself
```

## 8. Checkpoints And User Clarifications

Pause for a short checkpoint after:

1. Iteration 1: scope/tooling baseline
2. Iteration 5: shared-server and API-v1 deep review
3. Iteration 8: all `packages/**` complete
4. Iteration 11: all first-party code/config complete
5. Iteration 14: all documentation classified/reviewed
6. Iteration 15: immutable audit sealed
7. Iteration 16: remediation dispositions and worktree ready
8. Iteration 17: bounded fixes/tests complete
9. Iteration 18: manual-review follow-up plans complete
10. Iteration 19: final verification and publication

Ask the user before continuing when:

- two sources plausibly compete as product truth and code/tests do not resolve it
- an active-versus-historical classification changes product commitments
- external tooling, network access, or source upload would be required
- a likely secret, active credential, or confirmed Critical vulnerability is
  found
- runtime or production access is required to validate impact
- a finding would be marked `accepted-risk`
- the intended integration branch moved beyond the audited baseline and a delta
  audit cannot safely reconcile it
- emergency containment requires credential rotation, disclosure, deployment,
  destructive data repair, or another external/production action

Breaking, migration, architectural, runtime-validation, and archive/delete/move
work does not block unrelated audit/remediation. Create its follow-up plan for
manual review and continue other eligible work.

Do not block on minor taxonomy or wording decisions; record the assumption and
continue.

## 9. Remediation Decision Model

### 9.1 Required dispositions

Assign exactly one disposition to each sealed finding:

- `bounded-fix`: confirmed defect with a proven/reproduced root cause and a
  localized, non-major, non-breaking fix
- `test-only`: behavior is correct but required behavior coverage is absent
- `documentation-fix`: current canonical documentation/configuration is wrong
  and executable truth is unambiguous
- `investigation-plan`: the finding remains inconclusive or lacks a locally
  available reproducer/contract decision, and a bounded evidence-gathering plan
  is needed before fix classification
- `runtime-validation-plan`: impact/root cause cannot be established without
  benchmark, profiling, load test, browser/device measurement, live service, or
  another runtime environment
- `major-refactor-plan`: any major/breaking criterion in Section 9.3 applies
- `external-action-plan`: validation or containment requires credential
  rotation, disclosure, production/deployment access, destructive data repair,
  third-party coordination, or source upload
- `accepted-risk`: user explicitly accepts the confirmed risk
- `no-action`: refuted, duplicate, design-choice, positive-control, or Info-only
  modernization finding; invalid for a confirmed defect

Every accepted defect or required regression gap defaults to remediation. A
backlog entry alone does not close a bounded defect.

A confirmed Tier A test gap, or any gap covering security, authorization,
durability, recovery, concurrency, public compatibility, or externally visible
behavior, must become `test-only` unless adding the harness itself crosses a
major-refactor boundary. Lower-value Info-only coverage opportunities may be
`no-action` with rationale.

### 9.2 Bounded-fix eligibility

All conditions must be true:

- audit status is `confirmed` or `narrowed`
- root cause is `proven-from-code` or `reproduced`
- expected behavior is grounded in code contracts, tests, executable schemas,
  or current authoritative docs
- the change can be isolated with one behavior-level regression test
- no public contract, persisted/wire/artifact format, migration, coordinated
  rollout, external action, or major-refactor criterion changes
- the relevant local test/build path is available
- the fix is minimal and reversible and does not add an unapproved dependency
- the required verification can run locally without production access

If eligibility stops being true during implementation, revert the incomplete
fix, preserve the reproducer under temporary evidence, and reclassify the
finding to the applicable investigation, runtime, major-refactor, or
external-action follow-up plan. Never broaden the edit opportunistically.

### 9.3 Mandatory major-refactor or breaking-change triggers

Any one trigger makes the finding plan-only:

- removes or changes a public export, entrypoint, route/topic,
  request/response/error/default contract, protocol, wire format,
  persisted/artifact format, required configuration, or supported operational
  interface
- requires consumers or independently deployed processes to update in lockstep
- moves ownership across package/app boundaries or redesigns auth/scoping,
  authority, concurrency/delivery, transaction, cache, or persistence models
- archives, deletes, or moves tracked documentation/code, or changes canonical
  documentation ownership/navigation across domains
- requires migration, backfill, dual-read/write, feature flag, coordinated
  rollout, compatibility window, or rollback procedure
- adds/replaces a runtime dependency, deployed component, database, queue,
  external service, browser permission, or production secret
- cannot be isolated and validated with a bounded regression test
- affects at least three workspaces, more than ten production files, or more
  than 500 non-generated production changed lines; tests/docs/generated files
  do not count toward the numeric threshold
- three root-cause/fix hypotheses failed

Any breaking change is automatically major. Undocumented invalid, insecure, or
unauthorized behavior is not automatically a compatibility guarantee, but its
behavior delta and consumer risk must still be documented and independently
reviewed.

### 9.4 Critical containment

For a confirmed Critical `SEC`, `DATA`, or `OPS` finding:

- pause the affected slice and notify the user with redacted evidence
- preserve the immutable audit source
- prioritize the smallest repository-local, reversible, non-breaking
  containment plus regression test in an isolated remediation worktree
- require explicit approval before credential rotation, disclosure, deployment,
  destructive migration/backfill/data repair, production access, or any
  major/breaking containment
- continue independent audit slices while approval is pending and list any
  unresolved exposure prominently

### 9.5 Required validation by blast radius

Use `skills/rallar-testing/references/test-commands.md` to select exact focused
commands. Record command, remediation HEAD, worktree-state ID, exit code,
pass/fail count, warnings, and skip/block reason.

- Every fix/test: exact focused Vitest/Deno/Playwright test first, then changed
  package/app typecheck.
- Shared contracts: relevant `packages/tests/shared*` tests plus
  `./node_modules/.bin/tsc -p packages/shared/tsconfig.json --noEmit`.
- Shared web/public exports: relevant `packages/tests/shared-web` tests, public
  API snapshots, entrypoint/bundle-boundary checks,
  `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`, and
  affected app builds.
- Shared server/API-v1: focused shared-server/API route/service tests,
  `(cd apps/api-v1 && DENO_NO_UPDATE_CHECK=1 deno task check --frozen --deny-import)`,
  plus restart/routing tests when relevant.
- REST behavior: add/update the matching recipe/test under
  `packages/shared-test/black-box-runner` in the same change; run the focused
  route/service test and `npm run test:api-v1:black-box:memory`. Run
  `npm run test:api-v1:black-box:postgres` when Postgres is available and
  `npm run test:api-v1:black-box:recipes` only against an already-running API;
  record explicit optional-service skips.
- Game/shared game/motion: relevant package tests plus affected game app test
  and build.
- Black-box runner/control: relevant `packages/tests/shared-test` and control
  server checks; use Playwright only for changed human-visible workflows.
- UI behavior: a Playwright test must operate visible controls and assert the
  resulting browser/app state, not only query-string bootstrap.
- Cross-package/cross-app behavior: run `npm run test:unit`; add
  `npm run test:deno` or `npm run test:rallar:full-stack:memory` when the blast
  radius requires it.
- Documentation/config: run link/snippet/schema/snapshot/static validators and
  any existing docs-compat tests.

A required command that fails, is unavailable, or is skipped prevents
`verified-*`; the item remains blocked or plan-only.

### 9.6 Remediation priority

Within the bounded set, use this order:

1. approved Critical containment
2. High correctness, authorization, durability, data, and lifecycle defects
3. Tier A Medium defects in `packages/**` and `apps/api-v1/**`
4. other confirmed bounded defects
5. required test-only gaps
6. current documentation/configuration fixes
7. Low maintainability cleanup only when it directly supports a confirmed fix

Info-only modernization and unrelated cleanup do not enter Phase G.

## 10. Recommended Execution Order And Parallelism

The dependency order is:

```text
Iterations 0 → 1 → 2
                 ├→ 3 → 4
                 ├→ 5
                 ├→ 6
                 └→ 7
3–7 → 8
2 → 9, 10, 11
8–11 → 12 → 13 → 14 → 15 → 16
                              ├→ 17
                              └→ 18
17, 18 → 19
```

After Iteration 2, independent reviewers may run Iterations 3, 5, 6, and 7 in
parallel. Iterations 9, 10, and 11 may also run in parallel. Iteration 12 waits
for all code passes; documentation semantic reconciliation waits for the code
truth map; and the audit is sealed before normal remediation begins. Iteration
18 plan writing may run in parallel with Iteration 17 only when the findings and
files do not overlap. Critical containment is the sole early-remediation
exception and must retain separate evidence and worktrees.

One writer owns the mutable remediation worktree. Serialize fixes that overlap
files, contracts, or validation state. Before handoff, revalidate the final
worktree state and change manifest against the intended integration branch; if
it moved, perform the required delta audit rather than rebasing blindly.

For consistent quality, use one reviewer per bounded domain, one independent
challenger for Critical/High findings, one remediation implementer at a time,
and one integrator for the central ledgers, change manifest, and final report.

## 11. Audit execution addendum (2026-07-10)

The first complete passes over the shared core, API/server, shared-web/graph,
Relic package, and test/harness surfaces exposed several cross-boundary risks
that require explicit sequencing in Iterations 16–18:

- authenticated WebSocket ingress must bind the AL sender to the ticket-bound
  connection before admission, room authorization, persistence, or RTC
  signaling;
- CRDT HTTP catch-up needs object-scope authorization, bounded page sizes, and
  multi-page browser convergence tests;
- public Relic snapshots need a redacted hidden-state contract before any scene
  or AI consumer fix is attempted;
- shared facade isolation, destructive CRDT compaction, graph algorithm
  disconnected semantics, recipe trust/budget policy, and state-event
  retention are manual-review/refactor candidates;
- browser control destinations, request paths, and remote-provider artifacts
  require origin binding and token-free result projections;
- workspace-prefix, QueueBox fencing, Postgres wildcard, and idempotency
  boundaries require backend-parity and hostile-identifier tests.

Iteration 16 must classify these findings separately as `bounded-fix`,
`test-only`, `major-refactor`, `security-policy`, or `investigation-plan`.
Iterations 17–18 must not apply a scene-only or caller-only workaround where a
public protocol, authorization boundary, or persisted contract is the root
cause. Each High finding requires the independent challenge already recorded in
the audit ledger; the sender-binding reproducer is retained as a Critical
containment candidate if deployment review confirms cross-tenant room state.

The Iteration 7 gate is now explicit: the 329 test/support rows in the scope
manifest must have terminal review fields, and the generated
`test-and-validation-map.md` must list environment-gated suites, focused
commands, negative-path gaps, and finding links. This is in addition to the
existing `packages/tests` aggregate typecheck and coverage-gate findings.
