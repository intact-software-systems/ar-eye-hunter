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
- `parseBlackBoxRunnerExpandedPlan(text)`
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
  'expanded-plan.json': expandedPlanText,
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
- `rtcDiagnostics`: `rtc-diagnostic` events for RTC Diagnostics.
- `rtcMessages`: `rtc-message` events for message inspection.
- `wsMessages`: `ws-message` events for WS inspection.
- `failures`: copied from `failures.json`.
- `replayRecipe`: present when `expanded-plan.json` has replay data.

The command center should reject imports with `ok: false` and display the
`file`, `path`, and `message` from each error.

## Validation Rules

Required bundle files:

- `report.json`
- `events.jsonl`
- `failures.json`
- `metadata.json`

Optional files:

- `expanded-plan.json`
- `matrix-summary.json`

Validation checks:

- JSON parse errors include the artifact file name.
- `summary.total`, `summary.success`, and `summary.failure` are required on
  report, failure, and metadata files.
- `events.jsonl` event kinds must match the handoff contract.
- `step-result` events require `name`, `status`, and `transport`.
- store-derived events require `connection` and `value`.
- `artifact-truncated` events require truncation counters.
- redaction placeholders must use `<redacted:name>`.
- `expanded-plan.json` requires seed, replay flag, decisions, steps, and a
  replay recipe with `trafficPlan.replayFrom` or `trafficPlan.expandedPlan`.
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

- Existing event kinds are stable: `step-result`, `ws-message`, `ws-close`,
  `rtc-message`, `rtc-diagnostic`, `rtc-close`, and `artifact-truncated`.
- New event kinds must be added to the handoff contract and the reader tests
  before the command center should rely on them.

Expanded-plan replay data:

- `expanded-plan.json` version 1 must include `replayRecipe.steps`.
- Replay data must be discoverable through either
  `replayRecipe.execution.trafficPlan.replayFrom` or
  `replayRecipe.execution.trafficPlan.expandedPlan`.
- Consumers should use the parsed `views.replayRecipe` instead of manually
  walking the raw expanded-plan object.

## Compatibility Changelog

### Schema Version 1

- Added typed bundle parser and individual file parsers.
- Added named redaction placeholder validation.
- Added command-center view projection for event stream, diagnostics,
  failures, and replay recipe.
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
