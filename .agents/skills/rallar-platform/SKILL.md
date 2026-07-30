---
name: rallar-platform
description: Use when working across Rallar package boundaries, public API surfaces, shared browser/server code, app-data, CRDT, package exports, new app or greenfield React/Vite/Three.js work, or general monorepo architecture under packages/** and apps/**.
---

# Rallar Platform

**REQUIRED SUB-SKILL:** Use `rallar-code-writing` when writing, generating,
refactoring, or reviewing TypeScript.

**REQUIRED SUB-SKILL:** Use `building-rallar-apps` for new consumer application
scaffolding and greenfield React, Vite, or Three.js architecture. Keep
`rallar-platform` focused on package boundaries and public-surface changes.
For selected game-authority, realtime, or validation surfaces, also use
`rallar-games`, `rallar-realtime`, or `rallar-testing`, respectively.

## Start Here

Read `references/package-map.md` when you need orientation. Then inspect the code before choosing an implementation path; this repo changes quickly and docs can lag.

Useful first searches:

```bash
rg -n "export .* from|createRallar|Rallar.*Facade|GroupRef|AppData|CRDT" packages apps
rg --files packages/shared packages/shared-web packages/shared-server packages/shared-test
```

## Boundaries

- `packages/shared` owns cross-runtime contracts: API types, AL, queues, WebRTC primitives, CRDT contracts, RallarAI, Rallar Game, Rallar Motion.
- `packages/shared-web` owns browser facades and browser persistence/transports.
- `packages/shared-server` owns middleware, repositories, server facades, Postgres adapters, auth, state sync, and server RallarAI.
- `packages/shared-test` owns black-box recipes, runners, providers, and test harness contracts.
- `apps/api-v1` composes the shared-server Rallar API.
- Game apps should consume package APIs rather than duplicating platform behavior.

## Public Surface Rules

- Preserve existing exports unless the task explicitly removes a deprecated API.
- Prefer adding narrow helpers beside the domain they belong to, then export through the local package barrel.
- Treat broad `mod.ts` barrels as compatibility surfaces; avoid moving symbols in ways that break imports.
- When editing shared contracts, inspect both browser and server consumers before changing a type.

## Contract Shape And Compatibility

- Required fields are the default for every authoritative persisted, replicated, queued, event, snapshot, and response contract.
  Use an optional field only when absence is a meaningful domain state that
  consumers are expected to handle and test. Sparse request, query, patch,
  builder, and migration input types are separate construction boundaries;
  their optionality must not leak into authoritative values.
- When a successful authoritative response always contains a value, require it
  in the shared TypeScript response and every derived response, OpenAPI
  `required` array, serializer, and consumer/schema compatibility test. Request
  omission semantics do not justify optional successful output.
- Do not weaken an authoritative output type merely because an intermediate
  builder or migration step is incomplete. Use a separate input type, a
  discriminated union, or an explicit migration adapter at the boundary.
- Backwards compatibility is a product decision, not an automatic default. If
  a design or implementation plan would retain a legacy field, work shape,
  import path, or fallback, explicitly ask the human to approve that scope
  before implementation. When approval already appears in the request, record
  the compatibility boundary and its retirement condition in the plan.

## Convergent Persistence Routing

Read
`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`
completely before changing authoritative persistence and apply it unchanged.
Platform-specific decisions remain here: this skill adds only the
package-boundary and contract-shape rules above. Use the owning domain skill
for narrower concurrency and lifecycle rules.

## Validation

Use the rallar-testing skill for command selection. At minimum, type-check the changed package and run targeted tests for the touched domain.
