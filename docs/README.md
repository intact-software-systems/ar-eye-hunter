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
- [RallarAI Recipes](./rallar-ai-recipes.md) Opt-in schema-guided JSON
  generation flows for browser, server, fallback, host approval, CRDT proposals,
  and local live-provider setup.
- [RallarAI Governance And Evaluation](./rallar-ai-governance-and-evaluation.md)
  Provider/model governance metadata, production review guidance, and live-gated
  evaluation practices.
- [Rallar Quickstart And Recipes](./rallar-quickstart-and-recipes.md) Short
  recipes for common application tasks.
- [Rallar CRDT Guide](./rallar-crdt-guide.md) Explicit collaborative document
  API, WS/RTC transport choices, durable append behavior, diagnostics, and
  current limitations.
- [Rallar CRDT Production Hardening Runbook](./rallar-crdt-production-hardening-runbook.md)
  Operational controls, feature flags, admin inspection, backup/restore,
  corruption recovery, metrics, and domain follow-ups for CRDT deployments.
- [Rallar Product And Implementation Evaluation](./rallar-product-and-implementation-evaluation.md)
  Current product-level assessment of the browser facade, Rallar Data, Rallar
  Server, apps, tests, and next hardening work.
- [Rallar Troubleshooting Checklist](./rallar-troubleshooting-checklist.md)
  Practical checks for auth, rooms, WS, RTC, data stores, server middleware, and
  tests.
- [Rallar API-v1 In-Memory Performance Mode](./rallar-api-v1-in-memory-performance-mode.md)
  How to run API-v1 with PGlite memory persistence and local queue pub/sub for
  single-server performance tests, including black-box SPA and RTC validation.

## Repo Codex Skills

Use the root `AGENTS.md` for lightweight agent orientation.
The repo-local Codex plugin is declared in `.codex-plugin/plugin.json` and
exposes `./skills/`. When that plugin is enabled, Codex can select the relevant
Rallar skills from each `SKILL.md` frontmatter description. Do not expect Codex
to read every file under `skills/**` on every prompt; keep skill descriptions
specific, and explicitly name a skill in the prompt when you want guaranteed
use, for example: "Use the `rallar-realtime` and `rallar-testing` skills."

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
