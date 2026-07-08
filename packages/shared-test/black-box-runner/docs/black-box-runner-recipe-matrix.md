# Black-box Runner Recipe Matrix

The recipe matrix is the post-Iteration-10 live-validation catalog for
`black-box-runner` examples. It answers two questions for every runnable recipe
variant:

- what profile should run it
- what service, browser, or environment gate is required before it can run

The catalog lives in:

```text
packages/shared-test/black-box-runner/recipe-matrix.json
```

The runner lives in:

```text
packages/shared-test/black-box-runner/recipe-matrix.mts
```

## Profiles

| Profile | Purpose |
| --- | --- |
| `quick` | Fast local confidence. Runs deterministic memory delivery plus selected dry-run browser recipes. |
| `dry` | Dry-run recipe expansion for browser/remote/signaling recipes that should not touch real services. |
| `deterministic` | Deterministic local recipes, including intentional diagnostic failures with expected exit codes. |
| `soak` | Deterministic same-connection soak recipes that keep one connection set open across repeated loop traffic. |
| `traffic` | Deterministic seeded traffic-plan recipes with replayable expanded plans. |
| `parallel` | Deterministic bounded parallel group recipes for concurrent actor behavior. |
| `failure-diagnostics` | Recipes that are expected to fail and produce useful failure artifacts. |
| `live-soak` | Gated live browser and remote-browser same-connection soak recipes. |
| `live-traffic` | Gated live browser and remote-browser seeded traffic recipes. |
| `live-parallel` | Gated live browser and remote-browser bounded parallel recipes. |
| `live-crdt` | Gated CRDT live validation for WS convergence, RTC fallback, durable catch-up, local persistence, and admin integrity. |
| `rallar-server-live` | Live Rallar Server REST/WS recipes. Skips when the configured API is unavailable. |
| `api-v1-black-box` | No-browser `apps/api-v1` REST/WS black-box recipes. Requires a running Rallar API and no Playwright/browser gate. |
| `browser-live` | Live browser-backed Rallar recipes. Requires credentials, Rallar API, and Playwright. |
| `remote-live` | Live control-server-backed browser provider recipes. Requires Rallar API, control server, and an agent. |
| `signaling-live` | Live signaling-only provider recipes. Requires `RALLAR_SIGNALING_URL`. |
| `live` | All live profiles together. Skips unavailable gates unless strict mode is used. |

## Commands

From the repository root:

```bash
npm run test:shared-black-box:matrix:quick
npm run test:shared-black-box:matrix:dry
npm run test:shared-black-box:matrix:deterministic
npm run test:shared-black-box:matrix:soak
npm run test:shared-black-box:matrix:traffic
npm run test:shared-black-box:matrix:parallel
npm run test:shared-black-box:matrix:live
npm run test:shared-black-box:matrix:live:preflight
npm run test:shared-black-box:matrix:live:soak
npm run test:shared-black-box:matrix:live:traffic
npm run test:shared-black-box:matrix:live:parallel
```

Strict live mode fails when a required env var, service, or browser dependency
is missing:

```bash
npm run test:shared-black-box:matrix:live:strict
```

List a profile without running it:

```bash
npm --workspace @ar-eye-hunter/shared-test run bb:matrix:list -- --profile=live
```

Run one entry:

```bash
npm --workspace @ar-eye-hunter/shared-test run bb:matrix:quick -- --id=browser-realtime-dry
```

Run one live pattern profile in strict mode by passing the profile directly:

```bash
npm --workspace @ar-eye-hunter/shared-test run bb:matrix:live:soak -- --require-gates
```

## Artifacts

Matrix commands write artifacts under `.artifacts/shared-test/recipe-matrix/*`.
Each executed entry gets the ordinary scenario artifact bundle:

- `report.json`
- `events.jsonl`
- `failures.json`
- `metadata.json`
- `artifact-index.json`
- `expanded-recipe.json`
- `reduced-plan.json`

The matrix runner also writes `matrix-summary.json` with passed, failed, and
skipped entries. Intentional failure entries pass when the process exits with
their configured `expectedExitCode`.

Large matrix entries can use the same `execution.artifacts.maxEvents` and
`execution.artifacts.maxEventsByKind` settings as ordinary scenarios. The
index keeps failure pointers, event counts, per-run summaries, and compacted
success summaries available for artifact browsing.

For failing seeded traffic entries, run
`black-box-runner/traffic-plan-reducer.ts --artifact-dir <entry-artifact-dir>`
to create a smaller `reduced-plan.json` replay candidate and a
`reduced-plan-summary.json` of removed operations.

Skipped live entries include exact gate reasons, for example:

- missing environment variable `RALLAR_ALICE_PASSWORD`
- `/api/config` unavailable at the configured `RALLAR_API_BASE_URL`
- configured credentials rejected by `/api/auth/login`
- group create/join permission check failed
- WS ticket or WebSocket upgrade check failed
- ICE configuration unavailable
- Playwright CLI unavailable

Each selected live entry also writes `preflight-report.json` before execution.
Use `npm run test:shared-black-box:matrix:live:preflight` to run only those
checks. The command uses `--require-gates`, so missing provisioning returns a
non-zero exit without starting browser or remote-browser recipes.

## Live Baselines

Use `bb:matrix:live:strict` in an environment where the required services and
credentials are intentionally provisioned. The produced artifact directory is
the baseline for that environment.

Use the narrower live pattern commands when investigating one RTC risk class:

- `test:shared-black-box:matrix:live:soak` for long-lived same-connection
  `messages.rtc` loops.
- `test:shared-black-box:matrix:live:traffic` for seeded generated
  `messages.rtc` operation plans and `expanded-plan.json` replay material.
- `test:shared-black-box:matrix:live:parallel` for bounded concurrent
  browser/remote-browser sends.

Refresh a baseline when Rallar or Rallar Server behavior intentionally changes:

1. Run the strict live matrix.
2. Inspect changed `matrix-summary.json`, `failures.json`, and `events.jsonl`.
3. Update recipes or expectations only when the new behavior is intended.
4. Attach the redacted artifact bundle to the change or issue that explains the
   behavior change.

The matrix is a runner validation catalog. It should not add new Rallar facade
commands; recipes still use HTTP, WS, RTC, ASSERT, and SET steps.
