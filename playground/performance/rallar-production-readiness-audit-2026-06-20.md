# Rallar Production Readiness Audit

Date: 2026-06-20

## Scope

This audit evaluates production readiness for the Rallar platform surface in this
repository and its current consumer apps:

- `packages/**`: shared browser/server/runtime/AI/CRDT/game/motion surfaces.
- `apps/api-v1`: Rallar API, auth, state, WebSocket, WebRTC signaling, storage.
- `apps/rallar-black-box`: operator/test workbench and full-stack validation app.
- `apps/ar-eye-hunter-v1`: AR Eye Hunter game consumer.
- `apps/relic-hunters-v1` and `apps/relic-hunter-server-v1`: Relic Hunters web and
  server-authoritative game consumer.

This is an assessment-only document. It does not change implementation code.

## Verdict

Rallar is not production-ready as-is.

The repository has a substantial foundation: strict TypeScript/Deno checks pass,
core browser public API tests pass, server room authorization exists, state sync is
queue-backed, deterministic AI validation exists, and the black-box memory/Postgres
smoke paths mostly pass. The blocker is release confidence for real app behavior:
Relic Hunters' full-stack two-browser propagation test failed, the live RTC matrix
did not produce passing evidence, the deploy workflow does not gate production
deploys on the repo validation suite, and several production security/AI settings
are configurable but not proven hardened for the deployed environments.

Suitable current posture: internal development/demo and controlled beta behind
explicit operational gates. Not suitable for an unqualified production release.

## Blocking Findings

### 1. Relic Hunters full-stack propagation fails

`npm run test:playwright:relic:full-stack` failed in
`tests/playwright/relic-hunters/full-stack-propagation.spec.ts`.

Evidence:

- The failing scenario is explicitly the two-browser convergence path:
  `two browsers converge through join, start, submit, reset, and reload recovery`
  at `tests/playwright/relic-hunters/full-stack-propagation.spec.ts:55`.
- Page B clicks the room button and waits for the runtime room id to equal the
  selected room at `tests/playwright/relic-hunters/full-stack-propagation.spec.ts:86`.
  The helper times out after 30 seconds at
  `tests/playwright/relic-hunters/full-stack-propagation.spec.ts:265`.
- Playwright's error context shows `Expected: true`, `Received: false`, and a
  timeout at line 274.
- The captured screenshot for page B showed `Relic Hunters`, `Connection error`,
  the selected room listed as `1 online`, and the Rallar diagnostic panel in
  `error`.

Impact: Rallar cannot be called production-ready for game/realtime use while a
representative two-client full-stack app path fails before convergence.

Unknown: root cause was not traced in this audit. The observed behavior is
compatible with a client join/runtime connection problem, but that is an inference
from the test and screenshot, not a confirmed cause.

### 2. Production deploys are not gated by the validation suite

The root package defines broad validation scripts, including `test:ci` as
`test:unit`, `test:deno`, `test:e2e`, and full-stack memory tests in
`package.json:21`. The deploy workflow triggered on pushes to `main` builds and
deploys apps directly:

- AR Eye Hunter uses `npm install` and `npm run build` in
  `.github/workflows/deploy.yml:30`.
- Relic Hunters web uses `npm install` and `npm run build` in
  `.github/workflows/deploy.yml:58`.
- Rallar black-box web uses `npm install` and `npm run build` in
  `.github/workflows/deploy.yml:80`.
- API deploy validates/generates/migrates Prisma in
  `.github/workflows/deploy.yml:112`, but does not run the API Deno test suite or
  full-stack tests before the deploy step.

Impact: a broken realtime/game path can reach production from `main` without the
repo's own validation suite stopping it.

### 3. A named Postgres presence-expiry validation script is broken

`package.json:71` defines `test:postgres:presence-expiry` to run
`packages/tests/shared-server/integration/postgres/presence/presence-expiry-concurrency.test.ts`.
However, the root Vitest config excludes that same file at `vitest.config.ts:18`.

Observed result:

- `npm run test:postgres:presence-expiry` failed with `No test files found`.

Impact: a Postgres concurrency/expiry gate exists by name, but cannot currently
run through the documented root script. This leaves an important production
storage/presence path without executable evidence.

### 4. Production security posture is configurable but not proven hardened

There are good controls, but production readiness depends on deployment values and
policy decisions that were not proven in this audit.

Evidence:

- API-v1 requires auth for `/api/state/*` at `apps/api-v1/src/main.ts:41`.
- Strict read authorization for client/group state is disabled when
  `RALLAR_STATE_STRICT_READ_AUTH` is absent or empty at
  `apps/api-v1/src/routes/client-state-routes.ts:402` and
  `apps/api-v1/src/routes/group-state-routes.ts:915`.
- The environment docs say strict read auth defaults disabled and should be
  enabled for production once callers send auth on read paths at
  `docs/environment-variables.md:51`.
- Registration defaults to public in `apps/api-v1/src/routes/config-route.ts:39`
  and `docs/environment-variables.md:67`.
- Black-box operator tokens require a secret, but the allowlist defaults to any
  logged-in user and the default TTL is 24 hours in `docs/environment-variables.md:76`.

Impact: the repo can support a hardened deployment, but production readiness needs
evidence that production envs set strict state read auth, admin registration where
appropriate, constrained operator allowlists, explicit CORS origins, and real TURN
secrets. Without that proof, the default posture is closer to demo/internal than
public production.

### 5. Live RTC matrix did not produce passing evidence

The repo has live RTC matrix scripts, including
`test:rallar:full-stack:memory:live-rtc-3` in `package.json:53` and Postgres
variants in `package.json:60`. In this audit, the memory three-browser live RTC
command exited with both tests skipped despite `RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1`.

Impact: WebSocket/RTC unit and compatibility tests pass, but production readiness
for live multi-browser RTC needs a non-skipped matrix run in the target topology.

## Supporting Strengths

- Public browser entrypoints and API snapshots passed: shared-web browser
  entrypoint, bundle-boundary, and public API snapshot tests all passed.
- Core room realtime tests passed: room realtime channel, message compatibility,
  readiness, RTC wait compatibility, and server room authorizer tests all passed.
- API-v1 and Relic server Deno checks passed.
- `npm run test:unit` passed 1,728 tests with 1 skipped test.
- `npm run test:deno` passed the API-v1, black-box control server, Relic server
  check, and shared-test Deno files.
- Black-box full-stack memory smoke passed, and Postgres REST smoke passed against
  the local healthy Postgres container.
- Server room message routing rejects reserved topics, unknown topics, missing
  targets, oversized payloads, invalid JSON, and unauthorized room messages before
  fanout in `packages/shared-server/rallar-facade/ws-topic-router.ts:365`.
- Room authorization resolves scoped group identity, rejects scope mismatch, checks
  snapshot freshness, and applies `canSendGroupMessage` in
  `packages/shared-server/rallar-system/services/ws-topic-room-authorizer.ts:29`.
- Group policy requires active/live membership for room sends at
  `packages/shared-server/rallar-system/group-policy.ts:341`.
- State sync is AppInbox plus durable WS QueueBox-backed, with retry/idempotency
  described in `packages/shared-server/architecture.md:35`.
- AppData defaults to fresh reads and supports conditional writes in
  `packages/shared-server/app-data/RallarServerAppData.ts:217` and
  `packages/shared-server/postgres/app-data/PSqlAppDataRepository.ts:116`.
- RallarAI has JSON parsing/schema validation and production-governance helpers in
  `packages/shared/rallar-ai/rallar-ai-validation.ts:25` and
  `packages/shared/rallar-ai/rallar-ai-provider-governance.ts:12`.

## Non-Blocking Risks And Follow-Ups

### AI production governance is incomplete at app level

`docs/rallar-ai-governance-and-evaluation.md:5` says applications own legal and
operational suitability decisions for models, and the doc asks for a small
application-owned production provider/model registry at
`docs/rallar-ai-governance-and-evaluation.md:11`. A search outside docs/tests found
no app-owned `defineRallarAiProviderGovernanceMetadata(...)` registry. Meanwhile,
the AR Eye Hunter Cloudflare deploy enables WebLLM at
`.github/workflows/deploy.yml:35`, and the environment docs say production attempts
real browser WebLLM first at `docs/environment-variables.md:121`.

Risk: AI output is validated as proposal data in code, but production provider
approval, model/license metadata, and live provider evaluation are not yet release
evidence.

### Bundle size and browser performance need gates

Both game builds passed, but Vite warned about large chunks:

- AR Eye Hunter: `index` about 2.26 MB, gzip about 572 KB; `lib` about 6.04 MB,
  gzip about 2.17 MB.
- Relic Hunters: `index` about 1.19 MB, gzip about 296 KB; `babylon` about
  4.89 MB, gzip about 1.11 MB.

Risk: production user experience may be fragile on mobile/AR-class devices unless
bundle budgets, loading strategy, and device performance checks become gates.

### CRDT production controls require deployment integration

The CRDT hardening runbook documents rollout, admin, backup, integrity, metrics,
audit, retention, and encryption controls. It also says production deployments
should connect `RallarCrdtMetricsSink` and `RallarCrdtAuditSink`, and that
deployment-specific key custody, rotation automation, revocation UX, and
access-loss recovery remain follow-up operational work at
`docs/rallar-crdt-production-hardening-runbook.md:87` and
`docs/rallar-crdt-production-hardening-runbook.md:119`.

Risk: CRDT internals look intentionally hardened, but public production exposure
needs the operational integrations.

### Package/product surface is internal, not publish-ready

Root and package manifests are private and version `0.1.0`, including the root
`package.json:2`, `packages/shared-web/package.json:2`,
`packages/shared-server/package.json:2`, and `packages/relic-hunters/package.json:2`.
`packages/shared/mod.ts:1` is a broad barrel export across low-level contracts,
runtime services, WebRTC, cache, CRDT, AI, game, and motion modules.

Risk: this is acceptable for an internal monorepo product, but external SDK/package
production readiness would need explicit package boundaries, export maps, semantic
versioning, and compatibility policy.

### Relic room switching should be reviewed

AR Eye Hunter uses `rallar.rooms.createAndSwitch(...)` in
`apps/ar-eye-hunter-v1/src/game/useRallarArena.ts:1755`. Relic's runtime maps room
creation to `rallar.rooms.create(...)` and room entry to `rallar.rooms.enter(...)`
at `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts:387`.

Risk: this may be intentional, but it differs from the repo guidance for new
game-room flows that should replace the current room. It is a plausible stale-room
or current-room consistency risk to review while investigating the failing Relic
full-stack test.

### Warning noise should be made actionable

Validation produced warning noise that did not fail passing commands:

- Black-box director orchestration emitted unhandled heartbeat/snapshot or
  sync-request style warnings while exiting 0.
- Relic full-stack failure logs included `State sync publish missed live route`
  warnings and an Ollama fallback warning.
- Unit tests emitted localStorage availability warnings under Node.

Risk: release triage is slower when warnings are expected but not classified.

## Validation Evidence

| Command                                                                                                                                                                                                                                                                                                                   | Result                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`                                                                                                | Passed: 3 files, 17 tests.                                                                                      |
| `npx vitest run packages/tests/shared-web/rallar-room-realtime-channel.test.ts packages/tests/shared-web/rallar-message-channel-compat.test.ts packages/tests/shared-web/rallar-readiness.test.ts packages/tests/shared-web/rallar-rtc-wait-compat.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts` | Passed: 5 files, 49 tests.                                                                                      |
| `npx vitest run packages/tests/shared/rallar-ai-contracts.test.ts packages/tests/relic-hunters/relic-expedition-ai.test.ts packages/tests/ar-eye-hunter-v1/aiDirector.test.ts packages/tests/ar-eye-hunter-v1/browserAiConfig.test.ts packages/tests/ar-eye-hunter-v1/browserAiProvider.test.ts`                          | Passed: 5 files, 35 tests.                                                                                      |
| `npx tsc -p packages/shared-web/tsconfig.json --noEmit`                                                                                                                                                                                                                                                                   | Passed.                                                                                                         |
| `npx tsc -p packages/shared-server/tsconfig.json --noEmit`                                                                                                                                                                                                                                                                | Passed.                                                                                                         |
| `npx tsc -p packages/shared/tsconfig.json --noEmit`                                                                                                                                                                                                                                                                       | Passed.                                                                                                         |
| `npx tsc -p packages/shared-graph/tsconfig.json --noEmit`                                                                                                                                                                                                                                                                 | Passed.                                                                                                         |
| `npx tsc -p packages/relic-hunters/tsconfig.json --noEmit`                                                                                                                                                                                                                                                                | Passed.                                                                                                         |
| `npm --workspace ar-eye-hunter-v1 run build`                                                                                                                                                                                                                                                                              | Passed with large chunk warnings.                                                                               |
| `npm --workspace relic-hunters-v1 run build`                                                                                                                                                                                                                                                                              | Passed with large chunk warnings.                                                                               |
| `cd apps/api-v1 && deno task check`                                                                                                                                                                                                                                                                                       | Passed.                                                                                                         |
| `cd apps/relic-hunter-server-v1 && deno task check`                                                                                                                                                                                                                                                                       | Passed.                                                                                                         |
| `cd apps/rallar-black-box-control-server && deno task check`                                                                                                                                                                                                                                                              | Passed.                                                                                                         |
| `npm run test:rallar:full-stack:memory`                                                                                                                                                                                                                                                                                   | Passed: 7 tests.                                                                                                |
| `npm run test:rallar:full-stack:postgres:rest`                                                                                                                                                                                                                                                                            | Passed after approved unsandboxed run against local Postgres: 4 tests.                                          |
| `npm run test:unit`                                                                                                                                                                                                                                                                                                       | Passed: 255 files passed, 1 skipped; 1,728 tests passed, 1 skipped.                                             |
| `npm run test:deno`                                                                                                                                                                                                                                                                                                       | Passed: API-v1 118 tests, control server 37 tests, shared-test Deno files 146 tests; Relic server check passed. |
| `npm run test:rallar:full-stack:memory:director`                                                                                                                                                                                                                                                                          | Passed: 1 test.                                                                                                 |
| `npm --workspace relic-hunters-v1 run test -- tests/relic-hunters-runtime.test.ts`                                                                                                                                                                                                                                        | Passed: 8 tests.                                                                                                |
| `npx vitest run packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-game-diagnostics.test.ts packages/tests/ar-eye-hunter-v1/squadLink.test.ts packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts packages/tests/relic-hunters/relic-game.test.ts`                  | Passed: 5 files, 63 tests.                                                                                      |
| `npm run test:rallar:full-stack:memory:live-rtc-3`                                                                                                                                                                                                                                                                        | Skipped: 2 tests skipped despite the script setting the live RTC matrix gate.                                   |
| `npm run test:postgres:presence-expiry`                                                                                                                                                                                                                                                                                   | Failed: Vitest reported no test files found because the target file is excluded by root config.                 |
| `npm run test:playwright:relic:full-stack`                                                                                                                                                                                                                                                                                | Failed: the two-browser convergence test timed out waiting for page B runtime room state.                       |

Some commands that bind local ports or contact Docker/Postgres initially hit the
managed sandbox and were rerun with approved escalation. The final statuses above
reflect the meaningful reruns.

## Unknowns Requiring Product Or Ops Decisions

- What exact scope should "Rallar production" mean: platform packages only, API-v1,
  black-box workbench, AR Eye Hunter, Relic Hunters, or all of them together?
- Which deployment environment is canonical for production: Deno Deploy,
  Cloudflare Pages, Hetzner controller/headless browsers, local Postgres, or a
  combination?
- Are public registration and open room directory reads acceptable for the intended
  audience, or must all production deployments use admin registration and strict
  read auth?
- What are the production CORS origins, TURN provider settings, secret rotation
  procedures, and operator allowlists?
- Which AI providers/models are approved for production, with license notes,
  model digests/versions, structured-output support, target runtime, and timeout
  policy?
- What are the SLOs and load targets for WebSocket fanout, RTC mesh size, room
  count, presence expiry, and browser frame rate?
- What browser/device matrix is required for AR Eye Hunter and Relic Hunters,
  especially on mobile/WebGPU/WebRTC paths?
- Should live RTC matrix skips ever be acceptable in a release candidate, and what
  artifacts should prove a live matrix run?

## Release Readiness Checklist

- Fix or root-cause the Relic Hunters full-stack propagation failure and rerun
  `npm run test:playwright:relic:full-stack` to green.
- Fix `test:postgres:presence-expiry` so the named opt-in Postgres test runs
  without broadening the default unit suite, then run it against local Postgres.
- Add CI/release gates that run root `test:ci`, app builds, Deno checks, and
  selected Postgres/full-stack smoke tests before deploy jobs can publish from
  `main`.
- Prove production env hardening: strict state read auth, admin registration policy,
  explicit CORS origins, black-box operator token secret and allowlist, safe token
  TTL, and TURN secrets.
- Make the three-browser live RTC matrix non-skipped and passing in the target
  memory and Postgres topologies.
- Add app-owned RallarAI provider governance metadata and live evaluation gates for
  production WebLLM/Ollama modes, or disable those production provider modes until
  approved.
- Add bundle/performance budgets and targeted browser/device smoke checks for the
  large game bundles.
- Connect CRDT metrics, audit sinks, backup/restore drills, and key custody
  workflows before public CRDT exposure.
- Decide whether packages are internal-only or external SDK surfaces; if external,
  add explicit manifests, export maps, semantic versioning, and compatibility docs.
- Classify expected warning logs so release runs fail on new actionable warnings
  instead of burying real failures in noise.

## Suggested Next Codex Prompts

Use small, focused prompts rather than asking for all readiness work at once:

1. "Investigate, do not fix yet, why `npm run test:playwright:relic:full-stack`
   leaves page B in Rallar `error` after joining a room. Collect browser console,
   network, server logs, and runtime diagnostics; identify the first failing
   transition."
2. "Fix the root `test:postgres:presence-expiry` script/config so it runs
   `packages/tests/shared-server/integration/postgres/presence/presence-expiry-concurrency.test.ts`
   without adding that opt-in file to default `npm run test:unit`, then run it
   against local Postgres."
3. "Add a GitHub Actions release gate that runs root `test:ci`, app builds, Deno
   checks, and selected Postgres/full-stack smoke tests before any deploy job
   publishes from `main`."
4. "Audit production env hardening for API-v1, Relic server, and black-box control:
   strict read auth, admin registration, CORS, operator token settings, TURN, and
   secrets. Produce an env checklist and any code/doc fixes needed."
5. "Make the live RTC three-browser matrix produce a non-skipped pass under the
   documented gates for memory mode, then repeat for Postgres mode."
6. "Add app-owned RallarAI provider governance metadata for AR Eye Hunter WebLLM and
   Relic Ollama, plus deterministic CI evaluation and opt-in live provider
   evaluation."
