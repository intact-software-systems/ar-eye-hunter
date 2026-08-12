# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

`AGENTS.md` is the repo's canonical agent orientation and applies to Claude Code too — read it. It
owns the default-branch commit/push approval rules, the completion-gate policy, and the handoff
contract. This file adds Claude-Code-specific navigation on top of it; where the two overlap,
`AGENTS.md` wins.

Detailed workflows live in `.agents/skills/**` (a repo-local skill tree, also packaged for Codex via
`.codex-plugin/plugin.json`). These are plain Markdown — read them directly:

| Skill | Read it when |
| --- | --- |
| `rallar-code-writing` | **Any** TypeScript change. Its `references/repo-code-style.md` is the authoritative code standard. |
| `rallar-code-writing/references/convergent-service-writing.md` | Any authoritative DB or realtime mutation. |
| `rallar-code-writing/references/typescript-type-organization.md` | Naming, aliasing, or organizing TypeScript types: APIs, DTOs, type aliases, namespaces, class-owned vocabulary, public type surfaces. |
| `rallar-testing/references/test-commands.md` | Choosing which tests to run for a change. |
| `rallar-platform` | Package boundaries and public surfaces under `packages/**`. |
| `rallar-realtime` | Rooms, `GroupRef`/scoped identity, WS/RTC, presence, state sync, topology. |
| `rallar-games` | AR Eye Hunter, Relic Hunters, Rallar Game, Rallar Motion. |
| `building-rallar-apps` | Greenfield apps and React/3D architecture. |
| `rallar-ai` | RallarAI providers, schemas, deterministic helpers. |
| `rallar-hetzner-ops` | Hetzner distributed recipes, headless agents, fleet artifacts. |
| `performance-analysis` | Profiling and optimization work. |
| `publishing-plan-progress` | Executing a written plan from `plans/`. |

## Runtime split

This monorepo runs **two runtimes** and you must know which one owns the file you are editing:

- **Node + npm workspaces** — `packages/**`, browser apps (`apps/ar-eye-hunter-v1`,
  `apps/relic-hunters-v1`, `apps/rallar-black-box`, `apps/rallar-black-box-headless`). Vite + React;
  tested with Vitest and Playwright. Formatted by Prettier.
- **Deno** — `apps/api-v1`, `apps/rallar-black-box-control-server`, `apps/relic-hunter-server-v1`,
  and the `packages/shared-test/black-box-runner` `.mts` entry points. Tested with `deno test`.
  Formatted by `deno fmt` (2-space, 100 cols, single quotes, semicolons); these trees are in
  `.prettierignore` so the two formatters never fight.

Both runtimes share the same `packages/**` source via path aliases: `@shared/*`, `@shared-web/*`,
`@shared-server/*`, `@shared-graph/*`, `@shared-test/*`, `@relic-hunters/*` — declared three times
(root `tsconfig.json`, root `deno.json` imports, `vitest.config.ts` resolve.alias) plus per-app
`deno.json`. Adding a new alias means updating all of them.

## Commands

Daily confidence:

```sh
npm run test:ci      # test:unit + test:deno + test:e2e + test:full-stack:memory
```

Focused gates:

```sh
npm run test:unit    # vitest, includes packages/tests/**/*.test.ts only
npm run test:deno    # deno tasks in the three Deno apps + two shared-test files
npm run test:e2e     # Playwright: rallar-black-box app-local
npm run test:full-stack  # Playwright full-stack against in-memory API
npm run typecheck    # tsc project refs + per-workspace typecheck
npm run build        # all workspaces
```

Single test:

```sh
npx vitest run packages/tests/shared-web/rallar-data.test.ts
npx vitest run packages/tests/shared-server -t 'partial name'
cd apps/api-v1 && deno test --allow-env --allow-read test/group-state/group-state-read-routes.test.ts
npx playwright test --config apps/rallar-black-box/playwright.config.ts -g 'spec name'
```

Note: **all** Vitest tests live in `packages/tests/**`, mirroring the package/app they cover
(`packages/tests/shared-web/`, `packages/tests/api-v1/`, `packages/tests/repo/`, …) — not beside
the source. Deno app tests live in `apps/<app>/test/**`.

Per-package type check / build:

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
```

Dev servers:

```sh
npm run dev:rallar:all       # api-v1 + control server + black-box SPA on :5176
npm run dev:rallar:servers   # api-v1 + control server only
npm run dev:api-v1
npm run dev:ar-eye-hunter-v1
npm run dev:relic-hunters-v1
```

Postgres-backed work (Docker):

```sh
npm run db:test:up      # docker compose postgres + prisma migrate deploy
npm run test:integration:postgres
npm run test:integration:rallar
npm run db:down
```

Black-box API testing (see "REST changes" below):

```sh
npm run test:api-v1:black-box:memory    # fast local
npm run test:api-v1:black-box:postgres  # when Postgres is up
npm run test:api-v1:black-box:postgres:medium-scale  # convergence gate for mutation-path changes
```

Style and governance checkers (warning-only by default):

```sh
npm run check:repo-style
npm run check:repo-style:changed -- origin/main HEAD   # what branch CI enforces
npm run test:repo-governance    # after touching skills, plugin metadata, or examples
```

`npm run test:e2e` / `test:full-stack` bind loopback ports; in sandboxes that block that they fail
with `listen EPERM` even when the code is healthy.

## Architecture

`packages/**` is the reusable product surface; `apps/**` are consumers. Preserve existing public
exports and app import paths unless the task explicitly asks for a breaking change. Each package has
its own `architecture.md` — read it before changing that package's public surface.

- **`packages/shared`** — runtime-agnostic contracts and primitives. Safe from browser, server,
  tests, and apps: no DOM, no HTTP server, no Postgres, no `graphology`. Owns `api/` HTTP DTOs,
  `al-contracts/` + `alm/` (AL message shapes, QoS, multicast targeting), `queuebox/`,
  `resilience/` (including `Either`), `crdt/`, `rtc/` + `webrtc/`, `rallar-game/`, `rallar-motion/`.
- **`packages/shared-web`** — browser side. `browser/rallar.ts` is the broad compatibility facade
  and the canonical browser object; the implementation lives in unexported controllers under
  `browser/rallar-runtime/` composed by `rallar-runtime/compose.ts`. Narrow entry points
  (`rallar-core.ts`, `rallar-realtime.ts`, `rallar-data.ts`, `rallar-crdt.ts`,
  `rallar-media-calls.ts`) are preferred for new app code. Controllers must not import the
  compatibility entry point or the composer; dependencies point inward.
- **`packages/shared-server`** — reusable server domain code, independent of any one HTTP app.
  `rallar-facade/` composes REST/WS/system behavior; `rallar-system/services/` owns client/group
  state, topology, state sync, app-inbox processing, authorization, routing;
  `rallar-system/repositories/` owns durable state and queue contracts; `postgres/` supplies
  concrete adapters.
- **`packages/shared-graph`** — the only place `graphology` belongs. Topology generation, Vivaldi
  RTT helpers, graph CRDT.
- **`packages/shared-test`** — `black-box-runner/` (provider-neutral JSON recipe runner: HTTP, WS,
  RTC, ASSERT, SET, PARALLEL steps) and `rallar-bb-test/` (browser/control-agent recipe runtime).
  It owns the black-box control protocol, distributed-run artifact contracts, and artifact analysis;
  `apps/rallar-black-box` only consumes them for UI/operator flows.
- **`apps/api-v1`** — the generic Rallar Server shell (Deno + Hono + Prisma/Postgres). Owns auth,
  rooms, presence, WS topics, RTC signaling/topology, CRDT, app data, route mounting, OpenAPI
  (`resources/api-v1-openapi.yaml`). It must not become a concrete game server.

### The mutation doctrine

**AppInbox is mandatory for every incoming database mutation** — HTTP and WS, including
client/group/topology, auth/session/ticket, CRDT append/admin, and mutating admin paths. There is no
direct-mutation fallback.

```text
HTTP/WS mutation -> APP_INBOX -> read -> compute -> validate
  -> AppInbox transaction -> service.write(transaction, computed)
       -> state/event/receipt + APP_OUTBOX/WS_OUTBOX + result   (one transaction)
  -> commit -> resolve WS audience -> wake/poll workers
```

`read` loads the decision surface *outside* the write transaction. Only `compute` and `validate` are
pure. `write(transaction, computed)` receives the transaction and never opens, commits, replaces, or
retries one; its conditional guard comes first. Conflicts are typed values, not exceptions — a
conflict rolls back and AppInbox starts a fresh attempt with fresh authorization and policy checks.
The authoritative details (retry schedule, compare-and-set semantics, locking boundaries,
verification matrix) live in `convergent-service-writing.md`; the specialist skills only carry
domain deltas.

### Naming and terminology

- `room` is the product/browser term; `group-state` is the authoritative API/server term. Translate
  only in `room-group-state-translation.ts`. `GroupRef` and `roomRef` are fixed protocol identities.
- Use `GroupRef`/`roomRef` whenever application/workspace scope matters — the same `groupId` can
  exist in different scopes, so a bare id is not globally unique.
- Rallar Data = browser-local latest-value state, not live match truth. Rallar CRDT = collaborative
  authored documents, not competitive match authority. Rallar Motion = presentation smoothing, not
  simulation authority. RallarAI output is proposal data until domain code validates and accepts it.
- For room-scoped app traffic prefer `rallar.realtime.room<T>(...)` / `rallar.messages.room<T>(...)`
  over hand-wiring RTC readiness and sends.

## Code standard essentials

The authority is `.agents/skills/rallar-code-writing/references/repo-code-style.md`. Read it before
writing TypeScript. The governing principle: **code is written first for human developers** — within
correctness, safety, security, compatibility, and performance constraints, prefer the shape whose
ownership, dataflow, decisions, side effects, failures, and call paths a human can follow most
directly. A mechanically compliant change that is harder to read is not a success.

Highest-frequency rules:

- **Canonical verbs**, used consistently: `toXxx` (pure translation), `computeXxx` (pure
  calculation), `validateXxx` (pure, returns *all* issues, never throws), `readXxx`/`writeXxx`
  (crosses an observable boundary), `getXxx`/`setXxx` (in-memory only), `createXxx` (from explicit
  full input), `createDefaultXxx` (composition root), `resolveXxx` (pure selection),
  `initXxx`/`startXxx`/`stopXxx`. Banned: `handle`, `process`, `execute`, `perform`, `util`,
  `helper`, `data`, and abbreviations like `svc`, `mgr`, `cfg`, `ctx`, `req`, `res`.
- **No role folders** — no repo- or package-wide `types/`, `interfaces/`, `helpers/`, `utils/`,
  `factories/`, `translators/`. Organize by owned feature; a private one-use contract stays beside
  its behavior. `mod.ts` is a package compatibility boundary; don't add nested barrels.
- **Sizes**: file density is governed by cognitive load — warn ≥50, required review ≥110, ≥330
  needs a registered exception in `docs/repo-code-style-exceptions.md`; ≥12 runtime value exports
  prompts the same split review; physical length is only a 1,200-line navigation backstop after
  the data-literal discount. Functions ≤40 lines (>60 needs an exception); route handlers ≤30
  lines and cyclomatic complexity ≤8. Split route modules as `*-read.ts`, `*-write.ts`,
  `*-admin.ts`, `*-errors.ts`.
- **Expected failure is a value, not an exception.** Use `Either` from
  `packages/shared/resilience/Either.ts` (`Either.ofLeft` / `Either.ofRight`). Do not throw for
  validation, policy, not-found, conflict, or capacity. `assertXxx` is reserved for programmer
  invariants.
- **Required fields by default** in domain, command, persisted, event, and response contracts. An
  optional field is valid only when absence has distinct domain meaning. Sparse external input gets
  its own contract, normalized at the boundary. Contractual HTTP defaults belong in
  `api-v1-openapi.yaml` and must be reapplied by the boundary decoder.
- **Visible construction.** No definite-assignment assertions, setter injection, service locators,
  forward-captured callbacks, or test-only wiring paths. Construct dependencies before consumers;
  one required input contract plus a separate `createDefaultXxx` composition root.
- **At most three positional parameters**; at four, use one named input interface. Use `interface`
  for object contracts and `type` for unions/mapped/tuple/function types. No `I` prefix.
- **One canonical name per type.** Never add a `type` alias, import rename, or re-export that merely
  renames an existing named type; keep qualification like `CreateAccounts.Input`. Class-owned
  vocabulary may use a type-only same-name namespace immediately before the class (erasable type
  declarations only — no runtime members, no new enums).
- **Filenames are kebab-case** and match the primary export (including React components). No
  `utils.ts`/`types.ts`/`middleware.ts` without a feature noun.
- **Decisions stay high in the call stack** — a policy or default decision four helper calls below
  the boundary is a strong smell.
- Comments only for a non-obvious invariant, external constraint, or deliberate tradeoff. No
  narration comments on generated code.

## Validation expectations

- Run focused tests for the touched package/app first, then widen by blast radius.
- **REST changes**: add or adjust black-box recipes in `packages/shared-test/black-box-runner` in
  the same change, and run the focused black-box command when the services are available.
- **shared-web public surface changes**: include public API snapshots and browser bundle-boundary
  checks (`shared-web-public-api-snapshots.test.ts`, `shared-web-browser-bundle-boundaries.test.ts`,
  `check:browser-bundles`).
- **api-v1 mutation-path / concurrency changes**: run `test:api-v1:black-box:postgres:medium-scale`.
  Never weaken its constants, operation matrix, or assertions to make a change pass.
- **Skills, plugin metadata, examples, or root app-path config**: run `npm run test:repo-governance`.
- A written plan in `plans/` may be marked complete only after the final working tree passes
  `npm run test:unit`, `npm run test:ci`, and `npm run build` — plus the **Branch Release Gate**
  workflow on the final feature-branch commit and **Run Hetzner Supported Distributed Manifests** on
  the resulting default-branch commit. Any change after a passing gate invalidates it.
- Always report which commands passed, failed, or were skipped.

## Git

`AGENTS.md` requires explicit, per-operation human approval before **any** commit to or push of
`main` — including amend, merge, revert, cherry-pick, rebase, and squash. Commit approval and push
approval are separate. Read the exact disclosure requirements in `AGENTS.md` before asking.

Branch CI (`branch-release-gate.yml` → `release-gate.yml`) runs on every non-main push:
`check:repo-style:changed` against `origin/main`, `typecheck`, `test:ci`, app builds, Deno checks,
Postgres migrations, API-v1 black-box recipes, and Postgres full-stack smoke tests.
