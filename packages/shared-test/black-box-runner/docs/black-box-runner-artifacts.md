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

| File | Purpose |
| --- | --- |
| `report.json` | Full redacted runner report. |
| `events.jsonl` | One JSON event per line, including step results, WS events, RTC messages, diagnostics, and close events. |
| `failures.json` | Copyable failure bundle with summary, failed steps, expected/actual data, and outputs. |
| `metadata.json` | Run metadata, config path, mode, summary, and redacted command line. |

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

Seeded traffic commands also write `expanded-plan.json`. It contains the seed,
generator summary, pacing configuration, operation decisions, concrete expanded
steps, and a replay recipe. Inline loops inside traffic operations are expanded
before the artifact is written. Use this file with
`execution.trafficPlan.replayFrom` to rerun a failure exactly.

Parallel group commands use the ordinary artifact files. Parent `PARALLEL`
step results include group summaries and child result keys, while child step
events remain ordinary step-result records.

Live soak, traffic, and parallel matrix commands use the same artifact files
when gates are satisfied. When gates are missing, `matrix-summary.json` records
the skipped live entry and its exact skip reasons.

Recipe matrix commands write one artifact bundle per selected entry plus
`matrix-summary.json`. See `black-box-runner-recipe-matrix.md` for profile
selection, live skip gates, strict mode, and baseline refresh instructions.

## Artifact Use

For a bug report, attach at least:

- `failures.json`
- `events.jsonl`
- `report.json`

Use `metadata.json` when the command shape or mode matters. Keep raw local
server logs separate unless they are already redacted.

The command-center-facing TypeScript contract for these files is documented in
`black-box-runner-command-center-handoff.md`. The browser-safe parser and
schema fixtures are documented in `black-box-runner-artifact-reader.md`.
