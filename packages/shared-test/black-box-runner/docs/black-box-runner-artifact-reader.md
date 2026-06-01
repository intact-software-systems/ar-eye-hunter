# Black-box Runner Artifact Reader

The artifact reader is the command-center-safe import layer for
`black-box-runner` artifacts. It parses file text supplied by the caller; it
does not read from disk or execute recipes.

Source:

```text
packages/shared-test/black-box-runner/artifact-reader.ts
```

## Public Surface

Use these exports when importing uploaded artifacts in the SPA or control
server:

- `parseBlackBoxRunnerArtifactBundle(files)`
- `parseBlackBoxRunnerReport(text)`
- `parseBlackBoxRunnerEventsJsonl(text)`
- `parseBlackBoxRunnerFailures(text)`
- `parseBlackBoxRunnerMetadata(text)`
- `parseBlackBoxRunnerArtifactIndex(text)`
- `parseBlackBoxRunnerExpandedRecipe(text)`
- `parseBlackBoxRunnerLivePreflightReport(text)`
- `parseBlackBoxRunnerExpandedPlan(text)`
- `parseBlackBoxRunnerReducedPlan(text)`
- `parseBlackBoxRunnerMatrixSummary(text)`
- `validateBlackBoxRunnerRecipeCatalog(value)`
- `validateBlackBoxRunnerRecipeCatalogEntryFixture(value)`

`parseBlackBoxRunnerArtifactBundle` expects text keyed by artifact filename:

```ts
const parsed = parseBlackBoxRunnerArtifactBundle({
  'report.json': reportText,
  'events.jsonl': eventsText,
  'failures.json': failuresText,
  'metadata.json': metadataText,
  'artifact-index.json': artifactIndexText,
  'expanded-recipe.json': expandedRecipeText,
  'preflight-report.json': preflightReportText,
  'expanded-plan.json': expandedPlanText,
  'reduced-plan.json': reducedPlanText,
  'matrix-summary.json': matrixSummaryText,
});
```

Every parser returns:

- `ok`: true when there are no errors.
- `value`: typed parsed value when `ok` is true.
- `errors`: actionable import blockers.
- `warnings`: compatible legacy or migration notes.
- `issues`: errors and warnings in one ordered list.

## Command-center Views

Successful bundle parsing returns `views`:

- `eventStream`: all parsed event records.
- `postRunAssertions`: `post-run-assertion` events for aggregate-threshold
  review.
- `rtcDiagnostics`: `rtc-diagnostic` events for RTC Diagnostics.
- `rtcMessages`: `rtc-message` events for message inspection.
- `wsMessages`: `ws-message` events for WS inspection.
- `failures`: copied from `failures.json`.
- `artifactIndex`: optional `artifact-index.json` data for large-run
  browsing, including first failure, step-result sequence pointers, and
  compaction summaries.
- `expandedRecipe`: optional `expanded-recipe.json` data for replay and
  include/fragments provenance.
- `replayRecipe`: present when `expanded-plan.json` has replay data.
- `reducedPlan`: optional `reduced-plan.json` data produced by the offline
  traffic-plan reducer.
- `reducedReplayRecipe`: present when `reduced-plan.json` has replay data.

The command center should reject imports with `ok: false` and display the
`file`, `path`, and `message` from each error.

## Validation Rules

Required bundle files:

- `report.json`
- `events.jsonl`
- `failures.json`
- `metadata.json`

Optional files:

- `artifact-index.json`
- `expanded-recipe.json`
- `preflight-report.json`
- `expanded-plan.json`
- `reduced-plan.json`
- `matrix-summary.json`

Validation checks:

- JSON parse errors include the artifact file name.
- `summary.total`, `summary.success`, and `summary.failure` are required on
  report, failure, and metadata files.
- `events.jsonl` event kinds must match the handoff contract.
- `step-result` events require `name`, `status`, and `transport`.
- `post-run-assertion` events require `name`, `status`, `operator`, and
  `actual`.
- store-derived events require `connection` and `value`.
- `artifact-truncated` events require truncation counters.
- `artifact-index.json` requires summary, counts, step result pointers, run and
  connection summaries, and truncation counters.
- `expanded-recipe.json` requires `generatedAtEpochMs` and a recipe object;
  `recipe.steps` must be an array when present.
- redaction placeholders must use `<redacted:name>`.
- `preflight-report.json` requires `mode: "live-environment"`, boolean `ok`,
  `summary`, `checks`, `issues`, and `skipReasons`.
- `expanded-plan.json` requires seed, replay flag, decisions, steps, and a
  replay recipe with `trafficPlan.replayFrom` or `trafficPlan.expandedPlan`.
- `reduced-plan.json` uses the same replay validation as `expanded-plan.json`
  and may include `reduction` metadata.
- `matrix-summary.json` requires `PASSED`, `FAILED`, and `SKIPPED` counts.

## Version Fixtures

Schema fixtures live in:

```text
packages/shared-test/black-box-runner/fixtures/schema/
```

Current fixtures:

- `v1/catalog-entry.json`
- `v1/artifact-bundle/*`
- `v0/catalog-entry.json`
- `v0/artifact-bundle/*`

The `v0` fixtures represent legacy artifacts without explicit schema versions.
The reader treats them as compatible and returns warnings so the command center
can show that older data was normalized.

## Migration Rules

Catalog fields:

- `schemaVersion` 1 catalog-entry fixtures wrap the entry in
  `{ kind, schemaVersion, entry }`.
- Legacy entries without a wrapper are treated as schema version 0.
- Legacy `recipe` is normalized to `recipePath`.
- Missing `title`, `liveSupport`, `support`, `commands`, and `uiHints` are
  derived from ids, profiles, provider mode, and execution mode.

Event kinds:

- Existing event kinds are stable: `step-result`, `post-run-assertion`,
  `ws-message`, `ws-close`, `rtc-message`, `rtc-diagnostic`, `rtc-close`, and
  `artifact-truncated`.
- New event kinds must be added to the handoff contract and the reader tests
  before the command center should rely on them.

Expanded-plan replay data:

- `expanded-plan.json` version 1 must include `replayRecipe.steps`.
- Replay data must be discoverable through either
  `replayRecipe.execution.trafficPlan.replayFrom` or
  `replayRecipe.execution.trafficPlan.expandedPlan`.
- Consumers should use the parsed `views.replayRecipe` instead of manually
  walking the raw expanded-plan object.

Reduced-plan replay data:

- `reduced-plan.json` is optional and generated by
  `black-box-runner/traffic-plan-reducer.ts`.
- It keeps a replay-compatible `steps` array plus `reduction` metadata that
  names the first failure, removed operation decisions, and step-count delta.
- Consumers should use `views.reducedReplayRecipe` when offering replay from a
  reduced traffic failure.

Live preflight data:

- `preflight-report.json` is optional and may be present for executed or
  skipped live matrix entries.
- Consumers should show `skipReasons` and check rows from the parsed
  `preflightReport` before showing recipe runtime failures.

Expanded recipe data:

- `expanded-recipe.json` is optional and generated by current runner artifacts
  when `--artifact-dir` is used.
- It stores the expanded recipe after static `include` and `fragments`
  resolution, plus `includeMetadata.includes` rows for provenance.
- Consumers should use `views.expandedRecipe` when offering replay or "copy
  expanded recipe" actions, because artifact replay must not require resolving
  local fragment files.

Large-run artifact index data:

- `artifact-index.json` is optional and generated by current runner artifacts.
- `counts` summarizes total, emitted, and omitted event counts by kind,
  transport, and status.
- `firstFailure` points to the first failed step or post-run assertion.
- `stepResults` contains stable sequence numbers and emitted/omitted flags so a
  UI can browse step rows without loading every raw event.
- `perRun` and `perConnection` give compact aggregate rows for scale and
  distributed traffic runs.
- `compaction.repeatedSuccessSummaries` summarizes omitted successful step
  results while failures and RTC diagnostics remain available in `events.jsonl`.

## Compatibility Changelog

### Schema Version 1

- Added typed bundle parser and individual file parsers.
- Added named redaction placeholder validation.
- Added command-center view projection for event stream, diagnostics,
  failures, and replay recipe.
- Added optional live preflight report parsing.
- Added optional artifact index parsing for large-run browsing and compaction
  summaries.
- Added optional expanded recipe parsing for include/fragments replay
  provenance.
- Added optional reduced traffic-plan parsing for failure-reduction replay
  candidates.
- Added explicit v1 catalog-entry and artifact-bundle fixtures.

### Schema Version 0

- Represents artifacts and catalog entries without explicit `schemaVersion`.
- Still accepted for existing generated artifacts.
- Catalog entries are normalized into the current command-center shape.
- Artifact bundles are marked `compatibility.legacy: true`.

## Verification

```bash
npx vitest run packages/tests/shared-test/black-box-runner-artifact-reader.test.ts
npm run check:shared-test
```
