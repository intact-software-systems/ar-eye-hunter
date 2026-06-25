# Artifact Analysis

Read `analysis/analysis.json` first.

Important files:

- `distributed-run.json`: lifecycle state, rollup, manifest, command links.
- `control-run.json`: agents, commands, results, events, stats, reports.
- `results.jsonl`: redacted command results.
- `events.jsonl`: redacted runtime and diagnostic events.
- `failures.json`: failure bundle.
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

For local SPA review, download the raw artifact directory from GitHub Actions
and import its JSON/JSONL files in the `rallar-black-box` Runs panel with
`Import CI artifact`.
