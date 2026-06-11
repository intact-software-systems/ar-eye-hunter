---
name: rallar-testing
description: Use when deciding which Vitest, Deno, Vite, Playwright, package build, or black-box validation commands to run for Rallar package/app changes.
---

# Rallar Testing

## Start Here

Read `references/test-commands.md` when choosing commands. Prefer targeted checks first, then broader builds or suites based on blast radius.

## Selection Rules

- Shared contracts: run the relevant `packages/tests/shared*` Vitest files and the package `tsc`.
- Browser facade changes: include `packages/tests/shared-web` and app builds if game apps consume the surface.
- Server/middleware changes: include `packages/tests/shared-server`, Deno checks for API apps, and focused restart/routing tests when relevant.
- Game changes: include the game app test/build and package tests for shared game/motion/rules code.
- Black-box runner changes: include `packages/tests/shared-test` and the relevant rallar-black-box Playwright config only when needed.

## Reporting

Always say exactly which commands passed, failed, or were skipped. If a build emits known large-chunk warnings but exits zero, report it as pass with warning.

