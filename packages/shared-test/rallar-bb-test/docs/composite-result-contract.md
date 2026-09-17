# Composite Result Contract

`packages/shared-test/rallar-bb-test/composite-results.ts` defines shared
helpers for inspecting `loop` and `parallel` command output, and
`composite-result-paths.ts` owns the path grammar that the loop and parallel
runtimes record on each child. The helpers are
intended for the SPA, control-server artifacts, and automated analysis code
that needs a stable view of nested command results.

The runtime still keeps raw child result values available for debugging and
artifact export. UI-facing summaries should use the display helpers so result
values and errors pass through the same redaction rules as ordinary
`rallar-bb-test` results.

## Path Format

Composite result paths use version `1` and start at `$`.

Loop child results append:

```text
.iterations[<one-based-iteration>].commands[<zero-based-command-index>]
```

Parallel child results append:

```text
.groups[<zero-based-group-index>=<encoded-group-id>].commands[<zero-based-command-index>]
```

Examples:

- `$`
- `$.iterations[2].commands[0]`
- `$.groups[0=sender].commands[1]`
- `$.groups[0=left].commands[0].iterations[2].commands[0]`

The source recipe path intentionally omits runtime loop iterations and maps
back to the recipe template:

- `$.commands[0]`
- `$.groups[0].commands[1]`
- `$.groups[0].commands[0].commands[0]`

## Child Results

Every loop child records `commandId`, `parentCommandId`, `path`,
`sourceRecipePath`, `childIndex`, `commandIndex` and its one-based `iteration`;
every parallel child records the same fields plus `groupId` and `groupIndex`.
`originalCommandId` is present when the recipe template names a command id.
Paths are recorded relative to the composite root (`$`) and rebased under the
parent path when nested composites are walked. A loop or parallel value whose
children do not all carry these fields and a decodable command result
contributes no child entries.

## Helpers

Every helper takes the list of root results; a single root keeps the `$` path.
Use:

- `toRallarBlackBoxCompositeResultFlatEntries(...)` for a stable flat tree order.
- `toRallarBlackBoxCompositeResultTimeline(...)` for chronological display.
- `toRallarBlackBoxCompositeResultTree(...)` for parent/child drilldowns.
- `computeRallarBlackBoxCompositeResultSummary(...)` for pass/fail/cancel counts
  and first-failure focus, redacted with the given redaction options.
- `resolveRallarBlackBoxCompositeFirstFailure(...)` for failure focus.
- `toRallarBlackBoxCompositeDisplayResults(...)` for redacted UI/artifact
  summaries.

The flat entries include both `path` and `sourceRecipePath`, the depth, and a
`position`: `root`, or a `loop-child` (parent path and command ID, child and
command index, iteration, original command ID) or `parallel-child` (the same
with group ID and group index instead of the iteration), plus the raw result.
Display entries omit the raw result object and expose only redacted `value` and
`error` fields.

Loop parent result values may also include:

- `pacing`: requested interval/rate, actual iteration timestamps, elapsed time,
  drift, jitter, skipped iterations, and cancelled iterations.
- `sends`: send counts, success ratio, duration statistics, queued/enqueued/
  backpressure counts, dropped/replaced payload counts, per-transport failure
  counts, and adapter send observations.
- `thresholdFailures`: transport-neutral pacing, delivery, or backpressure
  failures when `loop.thresholds` marks the parent command failed.

These fields are additive to the composite result contract. Helpers should keep
flattening children from `value.results`; UI and artifact views can read the
parent `pacing`, `sends`, and `thresholdFailures` fields for load summaries.

## Artifact Fixtures

The fixture
`packages/tests/shared-test/fixtures/rallar-bb-test/composite-result-summary-v1.json`
locks the current path, source-path, tree, summary, and redacted-failure shape
for a nested `parallel -> loop -> rtc.send` recipe with `wait` and `assert`
children. Update the fixture only when intentionally changing the public
composite result contract.

## Compatibility

Adding optional fields to composite child results is compatible. Child results
missing a field listed under Child Results no longer decode.

Changing path syntax, source path syntax, summary field names, or redacted
display-entry semantics is a contract change. Update this document, the fixture
test, and command-center iteration documents in the same change.
