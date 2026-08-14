# Rallar Documentation

This directory contains user-facing and AI-facing documentation for the browser
Rallar facade, Rallar browser data stores, and Rallar server middleware.

## API-v1 Database Mutation Doctrine

**AppInbox is mandatory for incoming database mutations**, including all HTTP
and WebSocket client/group/topology, authentication/session/ticket, CRDT
append/admin, and mutating admin paths. AppInbox owns the transaction and retry
boundary. The `read` stage loads the repository decision surface outside the
write transaction. Only `compute` and `validate` are pure, and they produce
computed persistence data, not a plan. Service `write(transaction, computed)`
applies it: service write receives the transaction and never opens or retries
one.

State/event/receipt/result and final `APP_OUTBOX`/`WS_OUTBOX` rows commit in the
same transaction; write final queue rows directly through
`ResourceInboxRepository`. There is no intermediate mutation outbox. Resource
inbox uses 20 total processing attempts, staged from 1, 2, 4, 8, and 16 ms to
seconds capped at 30 seconds with jitter, plus a separate best-effort fairness
lane for retries more than 30 seconds overdue. Queue locks are coordination-only
and authoritative persisted/shared contracts use mandatory fields by default.

## Documents

- [Production Deployment And Branch Controls](./production-deployment.md)
  Main-only Cloudflare and Deno deployment policy, staged Deno Actions cutover,
  and human verification steps for provider configuration drift.
- [Repo Human Style Review Guide](./repo-human-style-guide.md) Human review
  sequence and warning-only checker usage for the authoritative repo TypeScript
  standard in
  [repo-code-style.md](../.agents/skills/rallar-code-writing/references/repo-code-style.md).
- [PR-Centered Governance](./superpowers/specs/2026-08-14-pr-centered-governance-design.md)
  Live pull-request delivery state, conflict-first finalization, and zero post-merge bookkeeping.
- [Production Legacy Exception Registry](./production-legacy-exceptions.md)
  Durable human approvals for retained affected-surface production legacy.
- [Repo Code-Style Exception Registry](./repo-code-style-exceptions.md)
  Human-approved persistent exceptions for materially touched files and
  functions that remain above the hard size tiers.
- [Rallar API Reference](./rallar-api-reference.md) Complete public API
  description for `rallar.ts`, `rallar-data.ts`, and `RallarMiddleware.ts`, with
  usage examples.
- [Rallar AI Skill Guide](./rallar-ai-skill.md) A skill-style operating guide
  for AI agents implementing or reviewing Rallar usage.
- [Rallar AI Prompting Guide](./rallar-ai-prompting-guide.md) Prompt templates
  and constraints for asking an AI to use Rallar, Rallar Data, or Rallar Server,
  including the required completion handoff format.
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
- [Production Env Hardening Checklist](./production-env-hardening-checklist.md)
  Fail-closed environment profile for API-v1, Relic server, and black-box
  control production deployments.
- [Rallar Product And Implementation Evaluation](./rallar-product-and-implementation-evaluation.md)
  Current product-level assessment of the browser facade, Rallar Data, Rallar
  Server, apps, tests, and next hardening work.
- [Rallar Troubleshooting Checklist](./rallar-troubleshooting-checklist.md)
  Practical checks for auth, rooms, WS, RTC, data stores, server middleware, and
  tests.
- [Rallar API-v1 In-Memory Performance Mode](./rallar-api-v1-in-memory-performance-mode.md)
  How to run API-v1 with PGlite memory persistence and local queue pub/sub for
  single-server performance tests, including black-box SPA and RTC validation.
- [Rallar RTC RTT Reporting](./rallar-rtc-rtt-reporting.md) Browser to server
  RTC RTT reporting flow, server acceptance policy, and bounded per-client RTT
  reporting degree.
- [Convergent State And RTC Topology Architecture](./rallar-convergent-state-and-rtc-topology.md)
  Durable causal revisions, optimistic snapshot reads, atomic topology
  execution, cross-server authorization, fanout, and retry guarantees.

## Repo Codex Skills

Use the root `AGENTS.md` for lightweight agent orientation.
The repo skills under `.agents/skills/**` are directly discoverable in this
checkout. The repo-local Codex plugin declared in `.codex-plugin/plugin.json`
packages that same canonical tree. For a new consumer application, start with
the `building-rallar-apps` skill and inspect the relevant `examples/**`. Codex
can select specialist skills from each `SKILL.md` frontmatter description;
explicitly name a skill in the prompt when you want to guarantee its use, for
example: "Use the `rallar-realtime` and `rallar-testing` skills."

## Source Files

- Browser facade: `packages/shared-web/browser/rallar.ts`
- Browser data facade: `packages/shared-web/browser/rallar-data.ts`
- Server middleware:
  `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`
- Server facade wrappers: `packages/shared-server/rallar-facade/RallarServer.ts`
  and `packages/shared-server/rallar-facade/RallarServerApplication.ts`

## Run Environment Notes

- `npm run test:e2e` and `npm run test:full-stack` start local HTTP servers via Playwright (`127.0.0.1` + local ports).
- In sandboxed environments that block loopback binds, these commands can fail with `listen EPERM` / `Operation not permitted` even when code is healthy.
- In normal local or CI environments with loopback bind allowed, both suites pass.
