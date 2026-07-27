---
name: rallar-code-writing
description: Use when writing, generating, refactoring, or reviewing TypeScript anywhere in the Rallar repository, including apps, packages, scripts, examples, and tests.
---

# Rallar Code Writing

## Start Here

Always read `references/repo-code-style.md` completely before writing,
refactoring, generating, or reviewing TypeScript. It is the authoritative
repo-wide coding standard; local guidance may tighten it but may not relax it.

Inspect nearby code, tests, and relevant `examples/**` before choosing a shape.
Existing implementation is useful context but is not precedent when it violates
the standard.

Useful first searches:

```bash
rg -n "export function|export const|export interface|export type|export class|createRallar|Readonly<|GroupRef|StateSync|RallarAi" apps packages
rg --files apps packages examples scripts
```

## Workflow

1. Identify the owning domain and side-effect boundary.
2. Trace input, defaults, decisions, reads, computation, writes, and failures
   before changing the shape.
3. Reuse a well-named existing implementation when it has the same semantics.
4. Keep one canonical implementation of domain behavior. Adapters translate;
   they do not reimplement.
5. Keep defaults and policy decisions high in the call stack.
6. Prefer required contracts and explicit value flow.
7. Add or update behavior tests for changed behavior.
8. Use the `rallar-testing` skill to select focused checks, type-checks, and any
   broader consumer validation.

## Authoritative Database Mutations

- AppInbox is mandatory for incoming database mutations. AppInbox owns the
  transaction and retry boundary; `compute` and `validate` phases are pure.
- Keep `read`, `compute`, `validate`, then `write(transaction, computed)`
  explicit. Computed persistence data is not called a plan. The service write
  receives the transaction and never opens, commits, replaces, or retries one.
- Write authoritative state, event, receipt, durable result, and final
  `APP_OUTBOX`/`WS_OUTBOX` entries through `ResourceInboxRepository` in the same
  transaction. There is no intermediate mutation outbox.
- ResourceInbox permits 20 total processing attempts with increasing jittered
  backoff and a separately rate-limited overdue fairness lane. Queue locks are
  coordination-only for bounded ResourceInbox claims, never domain authority.
- Authoritative persisted and shared contracts use mandatory fields by default.
  Sparse input and migration shapes remain separate from complete outputs.
- A compatibility fallback requires explicit human approval and a documented
  lifetime; nearby legacy behavior is not precedent.

## Shape Decision

- Use a pure function for validation, translation, calculation, routing
  decisions, key building, and policy checks.
- Use a factory returning a plain interface only for narrow, explicitly owned
  in-memory state exposed through clear `get` and `set` operations.
- Use a class when the code explicitly owns lifecycle, cache state,
  subscriptions, persistence, connection state, or long-lived coordination.
- Keep stateful objects narrow and injectable. Do not introduce hidden global
  state because nearby legacy code has it.

## AI-Generated Code Safety Checklist

- No untested behavior changes.
- No new abstraction without real duplication or complexity reduction.
- No broad public export unless it is intentionally part of the package API.
- No hidden clock, randomness, network, storage, repository, config, or
  environment dependency.
- No clever code where named helpers or explicit branches would be easier to review.
- No parallel implementations of the same algorithm.
- No app-local duplicate of behavior that already belongs in `packages/**`.
- No unconditional authoritative upsert after a read-derived decision.
- No lock-based concurrency test where a conflict, rebase, retry exhaustion,
  and final-convergence test is required.
- No compatibility fallback unless the human explicitly approved its purpose and
  lifetime.

## Validation

Run the focused tests and type-check for the touched surface. Run
`npm run check:repo-style` and review warnings in changed production files. For
output that reaches the display cap, rerun with `--root` set to the smallest
directory containing changed production files. For public API or cross-runtime
changes, check both browser and server consumers. Report passed, failed, and
skipped commands in the completion handoff.
