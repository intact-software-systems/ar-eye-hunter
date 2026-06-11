# Rallar Package Map

## Shared Packages

- `packages/shared`: core contracts and runtime-agnostic utilities.
- `packages/shared-web`: browser-facing Rallar facade, room APIs, RTC/WS message helpers, browser CRDT and data stores.
- `packages/shared-server`: server middleware, repositories, state sync, WS topics, Postgres adapters, server RallarAI.
- `packages/shared-graph`: graph/topology helpers for RTC and group topology.
- `packages/shared-test`: black-box recipe language, providers, runners, diagnostics, distributed test helpers.
- `packages/relic-hunters`: pure Relic Hunters game model, rules, protocol, expedition blueprints.
- `packages/tests`: Vitest and Deno tests for package and app behavior.

## Apps

- `apps/api-v1`: Deno/Hono API server that mounts Rallar WS and REST routes.
- `apps/ar-eye-hunter-v1`: React/Vite/Babylon browser game using Rallar rooms, RTC lanes, game authority, motion, and RallarAI director flows.
- `apps/relic-hunters-v1`: React/Vite/Babylon browser game consuming Relic Hunters rules and Rallar realtime.
- `apps/relic-hunter-server-v1`: Relic server app that composes API-v1 Rallar server with Relic game service and server-side RallarAI expedition generation.
- `apps/rallar-black-box`: browser black-box workbench and runner UI.
- `apps/rallar-black-box-control-server`: Deno control server for distributed black-box runs.

## High-Signal Docs

- `docs/rallar-api-reference.md`: browser facade, Rallar Motion, CRDT, data, middleware.
- `docs/environment-variables.md`: app/server env conventions.
- `docs/rallar-product-and-implementation-evaluation.md`: product review context.

