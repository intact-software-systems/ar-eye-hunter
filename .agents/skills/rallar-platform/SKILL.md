---
name: rallar-platform
description: Use when working across Rallar package boundaries, public API surfaces, shared browser/server code, app-data, CRDT, package exports, or general monorepo architecture under packages/** and apps/**.
---

# Rallar Platform

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

## Validation

Use the rallar-testing skill for command selection. At minimum, type-check the changed package and run targeted tests for the touched domain.

