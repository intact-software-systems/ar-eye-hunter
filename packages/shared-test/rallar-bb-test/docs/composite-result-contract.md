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
parent path when nested composites are walked.

Each child decodes on its own. A child that lacks one of these fields or a
decodable command result is not walked, and its parent entry records a child
decode issue: the recorded object (`value.results[1]`,
`value.groups[0].results[2]`) and every field of it that is missing or
invalid. Its decodable siblings are still walked. A recorded loop or parallel
value without its child list, or a parallel group without its `results`,
records one issue for that object (`value` or `value.groups[0]`). A composite
result that records no value holds no children, and neither does a loop value
the control server compacted (`resultsOmitted: true` beside `resultCount` and
`failureCount`). Undecodable children are never dropped silently:

- the summary counts the issues in `childDecodeIssueCount`;
- the distributed run monitor lists them on each composite drilldown and
  reports each one as a `RALLAR_BLACK_BOX_COMPOSITE_CHILD_UNDECODABLE` failure;
  a `recipe.run` result item that does not decode as a command result is
  listed and reported the same way, at `value.results[N]` under the `$` path;
- a group assertion whose addressed command is not among an agent's decodable
  results reports that agent's evidence as `undecodable` instead of `missing`
  when any of the agent's recorded results or children did not decode.

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
- `decodeRallarBlackBoxTestResult(...)` to decode one recorded command result,
  naming every missing or invalid field when it does not decode;
  `isRallarBlackBoxTestResult(...)` is the same check as a type guard.

The flat entries include both `path` and `sourceRecipePath`, the depth, a
`position`: `root`, or a `loop-child` (parent path and command ID, child and
command index, iteration, original command ID) or `parallel-child` (the same
with group ID and group index instead of the iteration), the entry's
`childDecodeIssues` (empty unless it is a composite holding undecodable
children), plus the raw result.
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
missing a field listed under Child Results no longer decode; they are reported
as child decode issues, as described there.

Changing path syntax, source path syntax, summary field names, or redacted
display-entry semantics is a contract change. Update this document, the fixture
test, and command-center iteration documents in the same change.
