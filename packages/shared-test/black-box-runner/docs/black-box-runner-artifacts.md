# Black-box Runner Artifacts

Use scenario artifacts when a recipe failure needs to become a bug report or a
repeatable investigation.

## Generic Scenario Artifacts

The generic scenario CLI accepts `--artifact-dir`, `--artifacts`, or
`--record-dir`:

```bash
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-memory-delivery-semantics.json \
  --artifact-dir=.artifacts/shared-test/rallar-memory-delivery
```

The directory contains:

| File                    | Purpose                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report.json`           | Full redacted runner report with summary, metrics, and runner correlation IDs.                                                                                                           |
| `events.jsonl`          | One JSON event per line, including step results, post-run assertions, WS events, RTC messages, diagnostics, and close events.                                                            |
| `failures.json`         | Copyable failure bundle with summary, failed steps, post-run assertion failures, expected/actual data, outputs, and correlation IDs.                                                     |
| `metadata.json`         | Run metadata, config path, mode, summary, runner correlation IDs, and redacted command line.                                                                                             |
| `artifact-index.json`   | Optional browser-friendly index with event counts, first-failure pointers, step-result sequence numbers, run/connection summaries, truncation metadata, and compacted success summaries. |
| `expanded-recipe.json`  | Optional fully expanded recipe after static includes/fragments, variable merge metadata, traffic/soak expansion, and redaction.                                                          |
| `preflight-report.json` | Optional live-environment provisioning report written by matrix live entries before recipe execution.                                                                                    |
| `reduced-plan.json`     | Optional replay-compatible traffic-plan candidate written by the offline reducer after a failing seeded traffic run.                                                                     |

Artifacts are written before the CLI exits. A failing recipe still exits with
code `1`, but the artifact bundle remains available.

## Convenience Commands

From the repository root:

```bash
npm run test:shared-black-box:dry
npm run test:shared-black-box:memory
npm run test:shared-black-box:memory:scale
npm run test:shared-black-box:memory:soak
npm run test:shared-black-box:memory:traffic
npm run test:shared-black-box:memory:parallel
npm run test:shared-black-box:matrix:quick
npm run test:shared-black-box:matrix:soak
npm run test:shared-black-box:matrix:traffic
npm run test:shared-black-box:matrix:parallel
npm run test:shared-black-box:matrix:live
npm run test:shared-black-box:matrix:live:soak
npm run test:shared-black-box:matrix:live:traffic
npm run test:shared-black-box:matrix:live:parallel
npm run test:shared-black-box:remote:dry
npm run test:shared-black-box:browser:dry
```

Live browser validation requires a real Rallar environment and credentials:

```bash
npm run test:shared-black-box:browser:live
```

The live browser command writes redacted baseline artifacts under
`.artifacts/rallar-browser-rtc` using the existing
`rallar-browser-live-validation.mts` wrapper.

Dry-run commands do not invoke RTC providers. RTC `send` and `wait` steps with
message expectations still expose synthetic `sendResult` and `matchedMessage`
fields marked with `dryRun: true`, which keeps artifact bundles useful for
checking recipe output wiring before a live run.

Scale commands write the same artifact files, but `report.json` is an aggregate
report. It includes `runs`, flattened `resultsList` entries with `runIndex`,
`outputsByRun`, and `metrics` for latency, failures, reconnects, and cleanup.

Same-connection soak commands write ordinary scenario artifact files for one
long-lived execution context. `report.json` includes `summary.soak`,
`metrics.soak`, and `artifactLimits`. `events.jsonl` is capped by
`maxArtifactEvents`; when the cap is reached, the runner appends an
`artifact-truncated` event with total, emitted, and omitted counts.
`artifact-index.json` still records sequence pointers for emitted and omitted
step results so the command center can show what was compacted without loading
the full raw event stream.

Seeded traffic commands also write `expanded-plan.json`. It contains the seed,
generator summary, pacing configuration, operation decisions, concrete expanded
steps, a replay recipe, and runner correlation metadata. Inline loops inside
traffic operations are expanded before the artifact is written. Use this file with
`execution.trafficPlan.replayFrom` to rerun a failure exactly.

After a failing seeded traffic run, reduce post-failure noise offline:

```bash
deno run -A packages/shared-test/black-box-runner/traffic-plan-reducer.ts \
  --artifact-dir=.artifacts/shared-test/rallar-memory-traffic
```

The reducer reads `expanded-plan.json` plus available failure evidence from the
artifact directory and writes `reduced-plan.json` and
`reduced-plan-summary.json`. The reduced plan keeps setup, cleanup, operation
order, and all generated traffic through the first failing step while removing
later generated operations. Replay it with `execution.trafficPlan.replayFrom`.

Runner artifacts include a `runnerRunId` and per-step `runnerStepId` values.
When `execution.correlation.injectHeaders` is enabled, HTTP requests also carry
`x-rallar-black-box-run-id` and `x-rallar-black-box-step-id`, making the same
IDs searchable in Rallar Server timing logs. `injectPayloads` can add the IDs
to object-shaped WS/RTC send payloads under `blackBoxRunner`.

Live matrix entries write `preflight-report.json` before recipe execution. The
report captures provisioning checks for env vars, `/api/config`, auth, group
permissions, WS ticket and upgrade, ICE config, control-server reachability,
and Playwright. When preflight fails, the matrix entry is skipped and the same
messages are copied into `matrix-summary.json`.

Parallel group commands use the ordinary artifact files. Parent `PARALLEL`
step results include group summaries and child result keys, while child step
events remain ordinary step-result records.

Recipes that use static `include` or top-level `fragments` write
`expanded-recipe.json` when artifacts are enabled. The file records the resolved
include list and the executable recipe shape, so an artifact bundle remains
replayable even when the local fragment files have changed or are not attached.

Live soak, traffic, and parallel matrix commands use the same artifact files
when gates are satisfied. When gates are missing, `matrix-summary.json` records
the skipped live entry and its exact skip reasons.

## Indexing And Compaction

Large runs can configure event caps under `execution.artifacts`,
`execution.artifact`, or `execution.artifactLimits`:

```json
{
  "execution": {
    "artifacts": {
      "maxEvents": 5000,
      "maxEventsByKind": {
        "step-result": 1000,
        "rtc-message": 500
      }
    }
  }
}
```

Caps compact non-critical event rows in `events.jsonl`. Failed `step-result`
and `post-run-assertion` events are preserved, and RTC diagnostics are kept so
operator-visible warnings/errors remain inspectable. Repeated successful step
results omitted by caps are summarized in `artifact-index.json` under
`compaction.repeatedSuccessSummaries`.

Plain JSON/JSONL remains the default artifact format. Compressed artifact files
are intentionally deferred until local debugging and command-center import
flows need them.

Recipe matrix commands write one artifact bundle per selected entry plus
`matrix-summary.json`. See `black-box-runner-recipe-matrix.md` for profile
selection, live skip gates, strict mode, and baseline refresh instructions.

## Artifact Use

For a bug report, attach at least:

- `failures.json`
- `events.jsonl`
- `report.json`

Use `metadata.json` when the command shape or mode matters. Keep raw local
server logs separate unless they are already redacted. Search server logs by
`runnerRunId` first, then narrow to a failed `runnerStepId` from
`failures.json` or `events.jsonl`.

The command-center-facing TypeScript contract for these files is documented in
`black-box-runner-command-center-handoff.md`. The browser-safe parser and
schema fixtures are documented in `black-box-runner-artifact-reader.md`.
