# Artifact Analysis

Read `analysis/analysis.json` first.

Important files:

- `distributed-run.json`: lifecycle state, rollup, manifest, command links.
  For manifests with `groupAssertions`, the rollup carries per-assertion
  results with redacted per-agent value tables naming missing and violating
  agents.
- `control-run.json`: agents, commands, results, events, stats, reports.
- `results.jsonl`: redacted command results.
- `events.jsonl`: redacted runtime and diagnostic events.
- `failures.json`: failure bundle. Group-assertion failures appear as
  `source: distributed-rollup` entries with
  `RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_*` codes.
- `fleet-report.json`: grouped agent/region/failure/timing summary.
- `analysis/summary.md`: human summary.
- `analysis/fix-proposal.md`: failure-only proposal.
- `analysis/performance.md`: success-only performance report.

Prefer `fleet-report.json.failureSignatures` for grouped root-cause analysis.
Use `results.jsonl` and `events.jsonl` to ground the first concrete command or
diagnostic evidence.

`analysis/analysis.json` includes `parseWarnings` for malformed optional JSON or
JSONL rows. Treat warnings as evidence quality issues; only malformed required
`distributed-run.json` blocks analysis.

For realtime `rtc.stream` manifests, read
`analysis/analysis.json.performance.streamTiming` and
`analysis/performance.md` before drawing performance conclusions. The stream
section reports frame completion, drops, backpressure, p50/p95/p99/max send
duration, achieved Hz, and slowest stream agents. If a run times out without a
failed result, `events.jsonl` stream progress can still become the first failure
evidence instead of falling back to generic distributed-run state.

For local SPA review, download the raw artifact directory from GitHub Actions
and import its JSON/JSONL files in the `rallar-black-box` Runs panel with
`Import CI artifact`.
