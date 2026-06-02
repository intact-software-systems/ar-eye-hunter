# Rallar Documentation

This directory contains user-facing and AI-facing documentation for the browser
Rallar facade, Rallar browser data stores, and Rallar server middleware.

## Documents

- [Rallar API Reference](./rallar-api-reference.md) Complete public API
  description for `rallar.ts`, `rallar-data.ts`, and `RallarMiddleware.ts`, with
  usage examples.
- [Rallar AI Skill Guide](./rallar-ai-skill.md) A skill-style operating guide
  for AI agents implementing or reviewing Rallar usage.
- [Rallar AI Prompting Guide](./rallar-ai-prompting-guide.md) Prompt templates
  and constraints for asking an AI to use Rallar, Rallar Data, or Rallar Server.
- [Rallar Quickstart And Recipes](./rallar-quickstart-and-recipes.md) Short
  recipes for common application tasks.
- [Rallar Product And Implementation Evaluation](./rallar-product-and-implementation-evaluation.md)
  Current product-level assessment of the browser facade, Rallar Data, Rallar
  Server, apps, tests, and next hardening work.
- [Rallar Troubleshooting Checklist](./rallar-troubleshooting-checklist.md)
  Practical checks for auth, rooms, WS, RTC, data stores, server middleware, and
  tests.
- [Rallar API-v1 In-Memory Performance Mode](./rallar-api-v1-in-memory-performance-mode.md)
  How to run API-v1 with PGlite memory persistence and local queue pub/sub for
  single-server performance tests, including black-box SPA and RTC validation.

## Implementation Notes

- [API-v1 In-Memory SQL Performance Mode](../iterations/rallar-api-v1-in-memory-sql-performance-mode.md)
  Work-in-progress iteration plan for running API-v1 performance tests with a
  single server process and an embedded PGlite SQL backend. The current slice
  has backend config, an idempotent ephemeral schema, and a PGlite SQL adapter
  that passes shared-server repository smoke tests. API-v1 also has configurable
  queue pub/sub with a local single-process bridge for PGlite mode plus
  black-box validation scripts for API-v1 memory mode.

## Source Files

- Browser facade: `packages/shared-web/browser/rallar.ts`
- Browser data facade: `packages/shared-web/browser/rallar-data.ts`
- Server middleware:
  `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`
- Server facade wrappers: `packages/shared-server/rallar-facade/RallarServer.ts`
  and `packages/shared-server/rallar-facade/RallarServerApplication.ts`
