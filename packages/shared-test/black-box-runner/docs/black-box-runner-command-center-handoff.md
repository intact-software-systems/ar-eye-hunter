# Black-box Runner Command-center Handoff

This document defines the stable surface that `apps/rallar-black-box` and
`apps/rallar-black-box-control-server` should consume from shared-test.

The command center should not parse runner internals or duplicate runner
execution logic. It should use the catalog and artifact contracts here to
display recipes, explain prerequisites, show copyable commands, and import
redacted artifact bundles.

## TypeScript Contract

The contract lives in:

```text
packages/shared-test/black-box-runner/handoff-contract.ts
```

It exports:

- `BlackBoxRunnerRecipeCatalog`
- `BlackBoxRunnerRecipeCatalogEntry`
- `BlackBoxRunnerArtifactBundleContract`
- `BlackBoxRunnerCoverageHandoff`
- `toBlackBoxRunnerRecipeCatalog(matrix)`
- `BLACK_BOX_RUNNER_COMMAND_CENTER_FIXTURE_CATALOG`
- `BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT`
- `BLACK_BOX_RUNNER_COVERAGE_HANDOFF`

Artifact parsing and schema compatibility helpers live in:

```text
packages/shared-test/black-box-runner/artifact-reader.ts
```

That module exports browser-safe parsers for runner artifact file text plus
recipe-catalog fixture validators. The SPA re-exports the main parser through
`shared-test-handoff-fixtures.ts`.

The SPA re-exports the small fixture catalog from:

```text
apps/rallar-black-box/src/shared-test-handoff-fixtures.ts
```

That file is intentionally static and browser-safe. It lets the SPA display a
representative recipe catalog without reading files or requiring live services.

## Recipe Catalog Shape

Every catalog entry has:

- `id`: stable catalog id matching the recipe matrix id.
- `title` and `description`: UI display text.
- `recipePath`: path under `packages/shared-test/black-box-runner`.
- `category`: source matrix category.
- `providerMode`: `rallar-memory`, `rallar-server`, `rallar-browser`,
  `rallar-remote-browser`, `rallar-signaling`, `dry-run`, `mixed`, or
  `unknown`.
- `executionMode`: `run` or `dry-run`.
- `expectedResult`: `pass` or `expected-failure`.
- `liveSupport`: `offline`, `dry-run-only`, or `gated-live`.
- `profiles`: matrix profiles such as `quick`, `deterministic`, `traffic`,
  `parallel`, `live-soak`, `live-traffic`, `live-parallel`, `browser-live`,
  `remote-live`, or `live`.
- `artifactName`: artifact directory-safe name.
- `prerequisites`: required env vars, required HTTP services, Playwright gate,
  and injected env values.
- `support`: booleans for deterministic, dry-run, live, remote browser,
  artifacts, and replay artifacts.
- `commands`: copyable root/direct commands.
- `uiHints`: badges and recommended command-center surface.

Use `toBlackBoxRunnerRecipeCatalog(recipeMatrix)` when server-side or Node-side
code already has `recipe-matrix.json`. Use
`BLACK_BOX_RUNNER_COMMAND_CENTER_FIXTURE_CATALOG` for browser-only display.

## Artifact Bundle Shape

The ordinary artifact bundle contains:

| File | Required | Purpose |
| --- | --- | --- |
| `report.json` | yes | Redacted summary, results, outputs, stores, metrics, and runner correlation IDs. |
| `events.jsonl` | yes | Redacted event stream for step results, post-run assertions, WS events, RTC events, and truncation notices. |
| `failures.json` | yes | Copyable failure bundle with step and post-run assertion correlation IDs. |
| `metadata.json` | yes | Command, config path, mode, summary, run metadata, and runner correlation IDs. |
| `artifact-index.json` | no | Event counts, first-failure pointer, step-result sequence numbers, per-run/per-connection summaries, truncation metadata, and compacted success summaries for large-run browsing. |
| `expanded-recipe.json` | no | Fully expanded recipe after static includes/fragments plus include provenance for replay/debug. |
| `preflight-report.json` | no | Live-environment provisioning checks and skip reasons before recipe execution. |
| `expanded-plan.json` | no | Seeded traffic expanded plan, pacing decisions, concrete inline-loop expansion, replay recipe, and runner correlation metadata. |
| `reduced-plan.json` | no | Reduced seeded traffic replay candidate with first-failure and removed-operation metadata. |
| `matrix-summary.json` | no | Recipe matrix aggregate summary. |

`events.jsonl` currently uses these event kinds:

- `step-result`
- `post-run-assertion`
- `ws-message`
- `ws-close`
- `rtc-message`
- `rtc-diagnostic`
- `rtc-close`
- `artifact-truncated`

`step-result` events include `runnerRunId`, `runnerStepId`, and a `correlation`
object. The same IDs are present on matching `report.resultsList` entries and
failure-bundle entries, so the command center can link an event row to server
logs without timestamp guessing.

The command center can map these directly into existing Event Stream, RTC
Diagnostics, and failure-focus views. The runner redacts known secrets across
all artifact files with placeholders shaped like `<redacted:name>`.

Use `parseBlackBoxRunnerArtifactBundle(...)` from `artifact-reader.ts` before
displaying uploaded artifact files. It validates required files, event kinds,
summary fields, artifact indexes, expanded recipes, live preflight reports,
redaction placeholders, expanded-plan/reduced-plan replay data, and
matrix-summary counts.

When `artifact-index.json` is present, command-center views should use it for
large-run navigation before loading the full event stream. The index preserves
failed step/post-run assertion pointers and RTC diagnostic availability even
when repeated successful events are compacted from `events.jsonl`.

## Coverage Ownership

Use `BLACK_BOX_RUNNER_COVERAGE_HANDOFF` to keep test ownership clear:

- `black-box-runner` owns generic recipe execution, matrix classification,
  provider-neutral assertions, reports, and artifacts.
- `rallar-bb-test` owns browser command runtime and remote browser-agent
  command execution.
- `rallar-black-box-spa` owns manual workflows, visualization, catalog display,
  and artifact browsing.
- `rallar-black-box-control-server` owns agent orchestration and uploaded
  command-center run data.
- `shared-web-shared-server` owns facade/server correctness below the
  command-center layer.

The SPA should not silently execute shell commands. It should display copyable
commands and route execution through explicit local tooling or the control
server.

## Verification

Contract coverage lives in:

```text
packages/tests/shared-test/black-box-runner-handoff-contract.test.ts
```

Useful checks:

```bash
npx vitest run packages/tests/shared-test/black-box-runner-handoff-contract.test.ts
npx vitest run packages/tests/shared-test/black-box-runner-artifact-reader.test.ts
npm run check:shared-test
```

Versioned schema fixtures live under
`packages/shared-test/black-box-runner/fixtures/schema/`.
