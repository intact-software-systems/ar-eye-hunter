---
name: rallar-testing
description: Use when deciding which Vitest, Deno, Vite, Playwright, package build, or black-box validation commands to run for Rallar package/app changes.
---

# Rallar Testing

## Start Here

Read `references/test-commands.md` when choosing commands. Prefer targeted checks first, then broader builds or suites based on blast radius.

## Selection Rules

- Shared contracts: run the relevant `packages/tests/shared*` Vitest files and the package `tsc`.
- Scoped storage-key changes: prove exact canonical keys and pairwise
  non-collision for absence, valid sentinels, delimiters, percent/lookalikes,
  every derived child key, prefix/list behavior, and repository isolation;
  include live Postgres when the keys guard authoritative shared state.
- Authoritative scoped-read changes: seed wrong-scope or wrong-slot values
  directly and prove direct, prefix-list, page, event, and compact-receipt reads
  fail as typed invariant corruption rather than returning misses, filtering,
  rewriting, or guessing. Cover every decoded application/workspace/group and
  principal/session/request slot at memory and live database boundaries.
- Browser facade changes: include `packages/tests/shared-web` and app builds if game apps consume the surface.
- Server/middleware changes: include `packages/tests/shared-server`, Deno checks for API apps, and focused restart/routing tests when relevant.
- REST API additions or behavior changes: add or update Rallar black-box recipes/tests in `packages/shared-test/black-box-runner` alongside the API change, then run the focused black-box command when its required services are available.
- Game changes: include the game app test/build and package tests for shared game/motion/rules code.
- Black-box runner changes: include `packages/tests/shared-test` and the relevant rallar-black-box Playwright config only when needed.
- Repo skills and active routing: after changes to `.agents/skills/**`,
  `.codex-plugin/plugin.json`, active Rallar docs/examples, or root skill/config
  routing, run
  `npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts`.

## UI Behavior Rule

When UI behavior changes, acceptance requires a Playwright test that operates visible controls a human would use and verifies resulting browser/app state. Query-string setup is allowed for deep-link or bootstrap contract tests, but it cannot be the only proof for a human-facing workflow. For popups, auth, storage, realtime, downloads, or navigation, verify the resulting state: URL cleanup, localStorage/sessionStorage, network requests, visible status, session IDs, connected agents, or artifacts.

## Reporting

Always say exactly which commands passed, failed, or were skipped. If a build emits known large-chunk warnings but exits zero, report it as pass with warning.
