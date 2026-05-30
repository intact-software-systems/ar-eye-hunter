# Shared-test Verification

This package mixes TypeScript modules, Deno CLIs, Playwright-backed providers,
and live-service recipes. Keep the checks explicit so local and CI runs do not
silently skip the wrong layer.

## Fast Local Checks

From the repository root:

```bash
npm run check:shared-test
npm run test:shared-black-box:matrix:quick
npm run test:shared-black-box:companion
npx vitest run packages/tests/shared-test/black-box-runner-artifact-reader.test.ts
```

From `packages/shared-test`:

```bash
npm run check
npm run bb:matrix:quick
```

`npm run check` runs:

- `check:ts`: TypeScript check for package `.ts` and `.d.ts` files.
- `check:deno`: Deno check for the scenario CLI, recipe matrix runner, and
  browser live-validation wrapper, plus the artifact reader.

## Recipe Matrix

Use the matrix when validating example recipes:

```bash
npm run test:shared-black-box:matrix:quick
npm run test:shared-black-box:matrix:dry
npm run test:shared-black-box:matrix:deterministic
npm run test:shared-black-box:matrix:soak
npm run test:shared-black-box:matrix:traffic
npm run test:shared-black-box:matrix:parallel
```

The quick matrix is intended for local confidence. The deterministic matrix also
runs expected-failure diagnostics and passes when those recipes exit with their
configured expected code.

Live recipes are gated:

```bash
npm run test:shared-black-box:matrix:live
npm run test:shared-black-box:matrix:live:soak
npm run test:shared-black-box:matrix:live:traffic
npm run test:shared-black-box:matrix:live:parallel
npm run test:shared-black-box:matrix:live:strict
```

Non-strict live mode records skip reasons for missing env vars, unavailable
services, or missing Playwright tooling. Strict live mode fails on those skips
and is the right choice for CI environments that are intentionally provisioned
with Rallar Server, browser credentials, and control-server agents.
The narrower live pattern commands are useful when the investigation is
specifically long-lived same-connection RTC, seeded generated traffic, or
bounded concurrent browser behavior.

## Existing Focused Commands

```bash
npm run test:shared-black-box:memory
npm run test:shared-black-box:memory:scale
npm run test:shared-black-box:memory:soak
npm run test:shared-black-box:memory:traffic
npm run test:shared-black-box:memory:parallel
npm run test:shared-black-box:browser:dry
npm run test:shared-black-box:browser:live
npm run test:shared-black-box:remote:dry
```

Use browser live commands only where a live Rallar environment and credentials
are configured.

## Artifacts

Generated artifacts are written under `.artifacts/`, which is ignored by git.
Recipe matrix runs write one scenario artifact bundle per entry plus
`matrix-summary.json`.

Do not commit generated reports. Attach redacted `failures.json`,
`events.jsonl`, `report.json`, and `matrix-summary.json` to bug reports or
baseline updates when they explain a failure.
