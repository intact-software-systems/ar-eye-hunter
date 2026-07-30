---
name: rallar-ai
description: Use when changing RallarAI shared contracts, browser/server AI providers, deterministic AI helpers, AR Eye AI director, Relic expedition AI, prompt schemas, provider governance, or AI result lifecycle behavior.
---

# RallarAI

**REQUIRED SUB-SKILL:** Use `rallar-code-writing` when writing, generating,
refactoring, or reviewing TypeScript.

## First Pass

Search both shared contracts and concrete consumers:

```bash
rg -n "RallarAi|createRallarAi|generateJson|schemaId|provider|lifecycle|AI_DIRECTOR|EXPEDITION" packages/shared packages/shared-web packages/shared-server apps/ar-eye-hunter-v1 apps/relic-hunter-server-v1 apps/relic-hunters-v1 packages/tests
```

## Boundaries

- `packages/shared/rallar-ai`: shared JSON contracts, hashing, schemas, lifecycle, governance, mock/fake providers, deterministic helpers.
- `packages/shared-web/browser/rallar-ai.ts`: browser facade and provider execution policy.
- `packages/shared-server/rallar-ai`: server AI facade and providers such as Ollama.
- `apps/ar-eye-hunter-v1/src/game/aiDirector.ts`: AR Eye gameplay event proposals.
- `apps/relic-hunter-server-v1/src/relic-expedition-ai.ts`: server-side Relic expedition generation with procedural fallback.
- `apps/relic-hunters-v1/src/game/ai`: Relic browser planning assistant.

## Rules Of Thumb

- Keep schemas strict and result validation explicit.
- Browser code must not depend on server-only providers.
- Server AI must have deterministic fallback behavior for gameplay-critical flows.
- Deterministic helpers belong in shared RallarAI when they are reusable and do not call live providers.
- Preserve lifecycle and dedupe semantics when accepting generated results.

## Validation

Run RallarAI shared contract tests plus the concrete game/provider tests touched by the change. For server provider changes, include the server package type-check and any live-gated tests only when their env gates are enabled.
