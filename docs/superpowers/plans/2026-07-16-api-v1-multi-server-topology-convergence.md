# API-v1 Multi-Server Topology Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-process PostgreSQL API-v1 black-box test proving exact-revision RTC topology publication and raw WebSocket fanout without browsers or WebRTC.

**Architecture:** Extend the existing managed API-v1 runner with an optional secondary port, keeping one-server behavior intact. A dedicated matrix entry uses two HTTP endpoints and two raw WebSocket connections to assert that concurrent group revisions each publish to sessions local to both servers through durable PostgreSQL-backed cluster fanout.

**Tech Stack:** TypeScript, Deno subprocesses, PostgreSQL, GitHub composite actions, JSON black-box recipes, Vitest, raw WebSocket and HTTP runner steps.

## Global Constraints

- Do not use browsers, Playwright, `RTCPeerConnection`, RTC providers, or WebRTC data channels.
- Run two API processes only for the PostgreSQL backend.
- Keep the existing PGlite-memory run single-server.
- Preserve current one-server runner arguments, recipes, artifacts, and public imports.
- Use a dedicated cluster matrix entry rather than adding topology-specific runner commands.
- Stage and commit only files belonging to this feature; preserve unrelated working-tree edits.

---

### Task 1: Specify Managed Two-Server Orchestration

**Files:**
- Modify: `packages/tests/shared-test/api-v1-black-box-run.test.ts`
- Modify: `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`

**Interfaces:**
- Extend `ApiV1BlackBoxOptions` with `secondaryPort?: number`.
- Accept `--secondary-port=<1..65535>` only when `backend` is `postgres` and it differs from `port`.
- Emit `RALLAR_API_BASE_URL_SECONDARY` and `RALLAR_WS_BASE_URL_SECONDARY` only when configured.
- Write the second process log to `api-v1-server-secondary.log`.
- Run matrix entry `api-v1-rtc-topology-convergence` under `<artifactDir>/cluster` after the standard profile.

- [ ] Write tests asserting secondary-port parsing, validation, environment URLs, and unchanged one-server defaults.
- [ ] Run `npx vitest run packages/tests/shared-test/api-v1-black-box-run.test.ts` and confirm the new assertions fail because the option is unsupported.
- [ ] Implement the option and pure environment derivation.
- [ ] Add a managed-server plan helper that returns primary and optional secondary process descriptors with per-process port, base URLs, and log path.
- [ ] Refactor startup/readiness/cleanup to operate on all descriptors without changing existing readiness diagnostics.
- [ ] Invoke the dedicated cluster matrix ID only when the secondary server is configured.
- [ ] Re-run the focused suite and confirm it passes.

### Task 2: Specify The No-Browser Cluster Recipe

**Files:**
- Create: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-rtc-topology-convergence.json`
- Modify: `packages/shared-test/black-box-runner/recipe-matrix.json`
- Modify: `packages/tests/shared-test/recipe-matrix.test.ts`

**Interfaces:**
- Consume `RALLAR_API_BASE_URL`, `RALLAR_WS_BASE_URL`, `RALLAR_API_BASE_URL_SECONDARY`, and `RALLAR_WS_BASE_URL_SECONDARY`.
- Register matrix ID `api-v1-rtc-topology-convergence` under profile `api-v1-black-box-cluster`.
- Declare two HTTP service requirements and no Playwright requirement.
- Use only `http`, `ws.open`, `ws.wait`, `ws.close`, `set`, `assert`, and `parallel` steps.

- [ ] Add matrix tests requiring the cluster entry, two HTTP services, and absence of RTC/browser providers.
- [ ] Run `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts` and confirm failure because the entry does not exist.
- [ ] Add the recipe and matrix entry.
- [ ] Validate the recipe with `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/tests/api-v1/api-v1-rtc-topology-convergence.json --validate --strict`.
- [ ] Re-run the matrix tests and confirm they pass.

### Task 3: Wire GitHub Actions To Two PostgreSQL API Processes

**Files:**
- Modify: `.github/actions/api-v1-black-box-test/action.yml`
- Modify: `.github/workflows/api-v1-black-box.yml`
- Modify: `.github/workflows/release-gate.yml`
- Create: `packages/tests/repo/api-v1-black-box-workflow.test.ts`

**Interfaces:**
- Add composite-action input `secondary-api-port`, defaulting to an empty string.
- Pass `--secondary-port` only when the input is non-empty.
- Set `secondary-api-port: "18081"` in both Postgres workflow callers.
- Leave the PGlite-memory caller without a secondary port.

- [ ] Add a repository test that parses the action/workflows and asserts the Postgres and memory contracts.
- [ ] Run `npx vitest run packages/tests/repo/api-v1-black-box-workflow.test.ts` and confirm failure before the input exists.
- [ ] Implement the action and workflow changes.
- [ ] Parse all three YAML files and run the repository test.

### Task 4: Verify Real Two-Process Convergence

**Files:**
- Modify if required by observed failures: only files listed in Tasks 1-3 and the architecture documentation.

- [ ] Run focused runner, matrix, and workflow suites.
- [ ] Run shared-test TypeScript/Deno checks.
- [ ] Start PostgreSQL and run `npm run test:api-v1:black-box:postgres` outside the sandbox if local network or Docker access requires it.
- [ ] Inspect both server logs, the ordinary matrix summary, and the cluster recipe report for two distinct revisions delivered to both WebSocket connections.
- [ ] Run `npm run test:api-v1:black-box:memory` and confirm it remains one-server and passes.
- [ ] Run broader package tests affected by workflow and documentation changes.

### Task 5: Publish To PR #37

**Files:**
- Stage only the files from Tasks 1-4.

- [ ] Inspect `git diff` and prove unrelated recipe-console/artifact-analysis edits remain unstaged.
- [ ] Commit with message `Test multi-server topology convergence`.
- [ ] Push `codex/convergent-state-topology`.
- [ ] Verify PR #37 points to the new commit and update its body with the two-server black-box coverage and validation evidence.
