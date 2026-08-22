# Rallar Recipe Console Artifact Analysis Implementation Plan

Status: Iteration 6 complete; Tasks 0–6 and the code-backed exit passed
Evidence date: 2026-07-12
Branch: `codex/rallar-black-box-spa-reimplementation`
Worktree: `tmp/worktrees/rallar-black-box-spa`

## Objective

Replace the seeded Analyze preview with a bounded, failure-first artifact
workspace. An operator must be able to import a partial distributed CI bundle
with no control-server connection, retain every usable evidence slice, identify
the first actionable failure without opening raw JSON, search normalized
failure/result/event evidence, and copy issue-ready analysis. The same
workspace must load the selected run's artifact through the existing
credential-aware control adapter and export an in-memory envelope that can be
re-imported offline.

Iteration 6 proves the distributed-artifact replacement only. It does not hide
or change the mount policy of `runner.runs`, `legacy.distributed-recipes`,
`legacy.shared-test-import`, or `legacy.run-manager`. Those routes retain
history, comparison, authoring, generic black-box-runner artifacts, replay, and
administrative workflows that are outside this bounded cut.

## Authoritative Findings

- `AnalyzePreview.tsx` is a static seeded empty state. Analyze currently has no
  file intake, control operation, inspector, artifact state, search, or URL
  filter consumer.
- `analyzeDistributedRunArtifactFiles(...)` and
  `distributedArtifactSnapshotsFromFiles(...)` already own run normalization,
  failure precedence, likely cause, next action, fix area, verification command,
  affected agents/regions, performance, parse warnings, SPA verdict/causal
  trail, and summary/fix/performance markdown. React must consume this truth,
  not duplicate it.
- The analyzer's v2 inference currently requires all five evidence files. The
  authoritative control server emits a schema-v2 seven-file distributed bundle
  with core files plus `target-resolution.json`, `report.json`,
  `failures.json`, and `metadata.json`; it intentionally links rather than
  embeds `results.jsonl` and `events.jsonl`. The inference has drifted from the
  server contract.
- Missing files are generally silent, while malformed present optional files
  can become parse warnings. A shared compatibility projection is needed to
  distinguish loaded, missing-core, missing-optional, malformed, incompatible,
  ignored, and unknown-version evidence without making every evidence file
  universally required.
- A downloaded control artifact is one JSON envelope containing a `files`
  record. The legacy directory importer only keys selected basenames and cannot
  round-trip that envelope. It also silently overwrites duplicate basenames and
  has no input bounds.
- The generic black-box-runner artifact family has a separate strict v0/v1
  handoff contract. This iteration will identify it as a separate profile and
  keep its registered legacy importer reachable; it will not weaken that public
  parser or conflate its schema versions with distributed artifact versions.
- `RunVerdictView.causalTrail` is useful likely-cause evidence, not proof of
  causality: some fallback correlations are heuristic. Analyze copy and labels
  must say "likely causal trail" and preserve source identifiers.
- The existing v1 URL codec already owns run IDs, agent/recipe/command
  selection, `historyQuery`, status, and inclusive `from`/`to`. Artifact bytes
  remain bounded in memory and are never put in URLs or local storage; reload
  without those bytes must visibly request re-import or control load.
- The root `ControlConnectionProvider` and `control-execution-api.ts` already
  provide the only allowed artifact endpoint adapter. Analyze must not call
  `fetch`, import legacy controllers, or add a poller.

## Binding Design And Safety Decisions

1. Direction A, Signal Ledger, remains the visual contract: import/control
   actions, verdict and first fix, likely causal trail/evidence quality,
   performance, then bounded searchable evidence and issue-ready markdown.
   Raw JSON is an escape hatch, never the primary answer.
2. Add a small deterministic distributed-artifact workspace projection under
   `packages/shared-test/**`. It unwraps existing export envelopes, preserves a
   claimed schema version, reports file-specific compatibility, calls the
   existing analyzer/snapshot functions once, and derives a normalized search
   index. Existing exports and signatures remain compatible; additions are
   optional/additive.
3. Schema-v2 validity follows the authoritative server payload: core files plus
   `report.json`, `failures.json`, and `metadata.json`. Missing results/events
   are explicit optional/linked evidence, not a v1 downgrade or invalid signal.
   Loose partial files remain analysable and never become a passing signal by
   absence.
4. Search entries are normalized from shared monitor failures/events/
   diagnostics plus control results. Entries carry stable IDs, source file,
   timestamp, agent, recipe, command, topic, diagnostic type, severity,
   transport, status/category, bounded payload summary, and display summary.
   Query and structured filters combine with AND semantics; time bounds are
   inclusive; ordering and omitted counts are deterministic.
5. Browser intake is a separate app boundary: at most 24 selected files,
   16 MiB per file, and 48 MiB total. It accepts a visible multi-file picker and
   drag/drop, uses basename-only allowlisting, rejects duplicate supported
   basenames and ambiguous envelope-plus-loose input, and reports ignored files.
   A rejected candidate preserves the last usable analysis and adds an error.
6. Analyze state lives in a bounded Recipe Console hook above the conditionally
   rendered view, so evidence can survive view navigation while the Analyze UI
   itself unmounts. No artifact data enters URL/localStorage and no inactive UI
   is hidden-mounted.
7. Control Load is context- and generation-bound to normalized base URL,
   control run, and distributed run. Context changes abort the request and
   abort-ignoring late responses cannot replace evidence. Identity mismatch and
   operation failure retain the prior analysis visibly. Export serializes the
   loaded in-memory envelope and does not perform a second request.
8. Importing or loading an artifact projects only safe run IDs into v1 URL
   state and clears incompatible dependent selections. Search text and
   committed filters use push; high-frequency time inputs use replace. Search
   selection may project existing agent/recipe/command fields, while local
   evidence-row identity remains in memory.
9. The first actionable failure is visibly selected in the main work region but
   import never steals DOM focus. One contextual inspector opens only on
   explicit evidence activation and follows existing desktop rail/mobile sheet
   focus behavior.
10. `AnalyzeWorkspace`, each leaf/hook/pure owner, and each CSS Module remain
    bounded. No new registry, global Recipe Console stylesheet, raw HTML
    rendering of imported markdown, or replacement monolith is allowed.

## Task 0: Baseline And Critical Review

- [x] Read the parent plan, product spec, migration register, shared distributed
      analyzer/monitor, control-server artifact producer, credential-aware client,
      legacy distributed/shared-test importers, URL codec, shell composition, and
      existing browser/structure tests.
- [x] Dispatch independent shared-contract and UI/browser/cutover audits.
- [x] Establish a green baseline: 81/81 across distributed recipes, Hetzner
      manifests, distributed artifact analysis, and legacy SPA reuse tests.
- [x] Record the server-v2 drift, envelope round-trip gap, profile distinction,
      missing compatibility/search model, causal-label limitation, input bounds,
      and no-cutover decisions before editing.

## Task 1: Normalize Distributed Artifact Compatibility

Files:

- Create bounded shared owners under
  `packages/shared-test/rallar-bb-test/distributed-artifact-workspace/**`
- Modify `packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts`
- Modify `packages/shared-test/rallar-bb-test/mod.ts`
- Add focused shared and app compatibility tests under
  `packages/tests/**/distributed-artifact-*.test.ts`

- [x] RED-test the actual seven-file control-server v2 envelope: it remains v2,
      validates core/report/failures/metadata, and labels absent results/events as
      optional/linked rather than invalid.
- [x] RED-test loose core, partial evidence, malformed present JSON/JSONL,
      unknown version, wrong envelope root, unsupported profile, ignored file, and
      missing identity distinctions. Valid sibling files and valid JSONL rows stay
      usable.
- [x] RED-test that unpacked files and a downloaded envelope converge on the
      same analysis/snapshots while declared version and generated time remain
      deterministic.
- [x] Implement only additive public types/functions and correct v2 inference
      against server behavior without changing its endpoint or payload contract.
- [x] Pass focused shared/app tests and shared-test TypeScript checks.
- [x] Commit shared compatibility and evidence as `f96b5b4` (`feat: normalize distributed artifact evidence`).

## Task 2: Derive Bounded Search And Issue Evidence

Files:

- Create shared evidence-index/search owners under the artifact workspace
  directory
- Add raw distributed artifact fixtures for complete v1, server-v2, partial
  one-agent failure, malformed optional evidence, and multi-agent evidence
- Modify focused distributed artifact tests

- [x] RED-test failure/result/event/diagnostic projection with stable IDs,
      correct provenance, bounded summaries, deduplication, stable source/time
      ordering, index/result limits, and exact omitted counts.
- [x] RED-test free text across agent, command, recipe, topic, diagnostic type,
      payload summary, and failure category; structured status/severity/transport
      and inclusive from/to filters; combined filters use AND semantics.
- [x] RED-test deterministic first actionable failure, likely causal trail
      labels/sources, evidence-quality summary, and issue-ready markdown composition
      using an injected generation epoch. Exclude unrelated evidence where shared
      correlations support it; otherwise surface the heuristic limitation.
- [x] Keep all derivation reusable and UI-agnostic under `packages/shared-test`.
- [x] Pass focused tests and shared-test TypeScript checks.
- [x] Commit the bounded index/search slice in `f96b5b4` after independent review.

## Task 3: Bind Memory-Only Import And Control Operations

Files:

- Create `src/recipe-console/analyze/analyze-file-boundary.ts`
- Create `src/recipe-console/analyze/analyze-workspace-state.ts`
- Create `src/recipe-console/analyze/use-analyze-workspace.ts`
- Modify `src/recipe-console/app/RecipeConsoleWorkspace.tsx`
- Add focused Analyze state/boundary/structure tests

- [x] RED-test file count/per-file/total limits, duplicate basenames, unknown
      files, directory selection, exported-envelope intake, ambiguous input, read
      failure, and atomic valid-candidate replacement.
- [x] RED-test idle/importing/loading/ready/error states, prior-evidence
      retention, clear, operation generations, context changes, identity mismatch,
      and abort-resistant late control responses.
- [x] RED-test that offline local import invokes no artifact export endpoint
      (the independent root control snapshot query may remain active), Control Load
      uses only `connection.execution.exportRunArtifact`, and Export downloads the
      loaded envelope with deterministic name/content that re-imports.
- [x] Keep the artifact payload memory-only above the unmounted view; project
      safe run/filter state through the existing v1 codec only.
- [x] Pass focused tests, structure checks, and app typecheck.
- [x] Commit operations with the cohesive Analyze workspace milestone `abe257e`.

## Task 4: Build Failure-First Analyze UI

Files:

- Create `AnalyzeWorkspace.tsx` and focused import/action, verdict/failure,
  causal/evidence-quality, performance, search/results, markdown, and inspector
  leaves under `src/recipe-console/analyze/**`
- Create focused CSS Modules under the same directory
- Remove `AnalyzePreview.tsx`
- Modify shell composition only through narrow Analyze callbacks/model props
- Add/modify focused structure, URL, shell, status, and seeded-preview tests

- [x] RED-test composition ownership and ordering before React implementation:
      actions -> failure verdict/fix -> likely causal trail/evidence quality ->
      performance -> search/results -> issue markdown.
- [x] Render picker plus drop zone, local/control provenance, loaded profile and
      version, first actionable failure, likely cause, next action, minimal fix,
      evidence file, affected agents/regions, verification command, likely causal
      trail, file-specific warnings, performance summary, and copyable markdown.
- [x] Render URL-backed search and bounded keyboard-operable result rows. An
      explicit row activation opens the one inspector and projects available
      agent/recipe/command context without making raw JSON the success path.
- [x] Render honest empty, reading, loaded partial/complete, malformed,
      incompatible, stale retained, offline, authorization, credential-trust,
      identity mismatch, and recovered states. Reloaded URL without bytes requests
      re-import/load explicitly.
- [x] Preserve Signal Ledger desktop/tablet/portrait/short-landscape geometry,
      44px targets, contained scrolling, status announcements, reduced motion, and
      CSS isolation.
- [x] Pass focused tests, app typecheck/build, and scoped browser RED->GREEN.
- [x] Commit `abe257e` (`feat: replace analyze preview with artifact workspace`).

## Task 5: Browser And Strangler Proof

Files:

- Create `tests/playwright/rallar-black-box/recipe-console-analyze.spec.ts`
- Add bounded import fixtures/helpers under the Playwright tree
- Modify responsive, history, status, CSS-isolation, and shell specs where
  Analyze-specific coverage belongs

- [x] Keep the canonical acceptance name exact:
      `imports a partial bundle offline and focuses the first actionable failure`.
- [x] Prove no artifact endpoint/export request during offline import; actual
      drag/drop and keyboard picker fallback; wrapper/unpacked round trip; missing optional,
      malformed present, unknown version, duplicate, bounded-input, first failure,
      performance, likely causal trail, evidence quality, markdown, and search by
      every required field/time bound.
- [x] Prove visible Control Load and in-memory Export, identity mismatch,
      prior-evidence retention, abort-ignoring late response rejection, and offline
      re-import of the exported envelope.
- [x] Prove URL copy/back/forward and reload semantics for run IDs and filters;
      prove artifact bytes do not persist and reload requests re-import.
- [x] Prove 1440x900, 900x900, 430x932, and 932x430; keyboard-only evidence and
      inspector paths; 44px targets; focus restore/Escape; reduced motion; live
      announcements; zero document overflow; and actual Analyze CSS in both load
      orders.
- [x] Preserve and test contextual links/deep links for legacy Runs and the
      Shared Test fallback. Do not hide or alter any legacy row or mount policy.
- [x] Commit the initial browser proof with `abe257e` and the final exact
      keyboard/drop/legacy-handoff proof with `47c332d`.

## Task 6: Fresh Exit, Review, And Documentation

- [x] Run the iteration's exact focused validation plus artifact workspace
      tests, complete app suite, shared/app typechecks, production build/chunk
      assertion, complete Recipe Console browser config, exact preserved legacy
      navigation/ticket pair, and control-server artifact tests if the shared
      boundary changed their expectations.
- [x] Perform desktop/mobile portrait/mobile landscape, keyboard, reduced
      motion, operational-state, CSS-isolation, and visual-hierarchy QA. Try the
      in-app Browser first and record its exact unavailable reason before fallback.
- [x] Dispatch independent shared-contract, app-state, and browser/cutover
      reviews. Cover every Critical/Important finding with RED/GREEN proof and rerun
      fresh validation after the last fix.
- [x] Update this plan, parent plan, product spec, migration register, and
      fidelity ledger with actual commits, counts, compatibility decisions,
      cutover evidence, skips, and remaining risks.
- [x] Mark `runner.artifact-analysis` code-backed only after the canonical
      offline acceptance passes. Keep `runner.runs`,
      `legacy.distributed-recipes`, `legacy.shared-test-import`, and
      `legacy.run-manager` visible, deep-linkable, and uncut.
- [x] Commit the exit documentation after the fresh proof below.

## Iteration 6 Focused Validation Contract

At minimum, run:

```sh
npx vitest run \
  packages/tests/rallar-black-box/distributed-recipes.test.ts \
  packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts \
  packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts \
  packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts \
  packages/tests/rallar-black-box/recipe-console-analyze.test.ts \
  packages/tests/rallar-black-box/recipe-console-structure.test.ts
npm --workspace @ar-eye-hunter/shared-test run check:ts
npm --workspace rallar-black-box run typecheck
npx playwright test --config apps/rallar-black-box/playwright.config.ts \
  tests/playwright/rallar-black-box/recipe-console-analyze.spec.ts
```

The parent plan's two named Vitest files remain mandatory but cannot alone prove
artifact behavior. Live services are not required for the canonical offline
exit. Any configured-service check that is unavailable is reported as skipped
with its exact reason and is never counted as passed.

## Fresh Exit Evidence

- Shared foundation: `f96b5b4`; Analyze app/browser milestone: `abe257e`;
  completed safety matrix: `9b07330`; exact keyboard/drop/legacy-handoff
  proof: `47c332d`.
- Focused shared/app contract: 15/15 files, 226/226 tests. Complete app suite:
  81/81 files, 786/786 tests with required loopback/IPC permission.
- Shared-test and app TypeScript checks pass. The production build transforms
  551 modules; Recipe Console CSS is 74.32 kB (12.10 gzip) and JS is 215.53 kB
  (58.63 gzip). The reciprocal experience closure passes; only the preserved
  large-chunk advisory remains.
- Complete Recipe Console browser configuration: 119 available tests passed;
  one configured-live test skipped. The bounded Analyze canonical, safety, and
  visual/handoff owners pass 19/19 including future-schema, bounds, exhaustive
  search, late-response, keyboard-owned picker, actual DataTransfer drop, and
  activated legacy destination proof. The exact preserved legacy
  navigation/ticket pair passes 28/28.
  Control-server contract regression passes 57/57.
- Desktop, tablet, 430×932 portrait, and 932×430 short-landscape; keyboard-only
  picker/evidence/inspector paths; 44px targets; focus trap/restore and Escape;
  reduced motion; operational announcements; zero horizontal overflow; and
  both legacy CSS load orders pass. Tablet and portrait captures were inspected
  at original detail. The in-app Browser was unavailable exactly as `No browser
  is available`; Playwright/System Chromium is fallback evidence, not an
  in-app Browser pass.
- Shared review closed three Important findings; app/state review closed six
  Important findings. Every finding received RED/GREEN proof and final
  independent re-reviews report no open Critical or Important issue.
- Ready-State #6 is satisfied. No legacy row or mount policy changed. The
  configured Postgres lifecycle remains **skipped, not passed**, for exactly:
  `Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
  apps/rallar-black-box-control-server, and apps/rallar-black-box available.`
