---
name: rallar-code-writing
description: Use when writing, generating, refactoring, or reviewing TypeScript anywhere in the Rallar repository, including apps, packages, scripts, examples, and tests.
---

# Rallar Code Writing

## Start Here

Code is written first for human developers. Correctness, safety, security,
compatibility, and required performance remain mandatory; within those
constraints, choose the shape a human can locate, trace, understand, and
modify most directly.

A mechanically compliant change is not acceptable when it adds indirection,
hides a decision, fragments one dataflow, weakens names, or makes ownership
less obvious. When a detailed rule conflicts with human understandability,
stop and explain the conflict instead of satisfying the rule mechanically.

Always read `references/repo-code-style.md` completely before writing,
refactoring, generating, or reviewing TypeScript. It is the authoritative
repo-wide coding standard; local guidance may tighten it but may not relax it.

For authoritative database or realtime service mutations, also read
`references/convergent-service-writing.md` completely. Its repository path is
`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`.

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
2. Sketch construction order and the representative dataflow before changing
   the shape. Make each dependency available before its consumer is constructed.
3. Trace input, defaults, decisions, reads, computation, writes, and failures.
   Preserve one semantic name for each value until an explicit translation
   creates a genuinely different value.
4. Classify every callback as a genuine deferred boundary or removable control
   indirection. Keep lifecycle, event, retry, transaction, and protocol callbacks
   visible; move business workflows into direct named operations.
5. Inspect factories and extracted helpers for dependency cycles, late binding,
   pass-through layers, renamed inputs, and important decisions buried below
   callback or helper chains.
6. Reuse a well-named existing implementation when it has the same semantics.
7. Keep one canonical implementation of domain behavior. Adapters translate;
   they do not reimplement.
8. Keep defaults and policy decisions high in the call stack.
9. Prefer required contracts and explicit value flow.
10. Add or update behavior tests for changed behavior.
11. Trace one representative input from the public entry point to its result,
    including callback invocation count and timing, before considering the shape
    complete.
12. Use the `rallar-testing` skill to select focused checks, type-checks, and any
   broader consumer validation.

## Authoritative Database Mutations

- Follow the complete doctrine in `references/convergent-service-writing.md`.
- AppInbox is mandatory for incoming database mutations and owns the transaction
  and retry boundary.
- Keep a visible `read`, pure `compute`, pure `validate`, then
  `write(transaction, computed)` dataflow. The service never owns transaction
  lifecycle or retries.
- Prefer a functional core with an explicitly owned stateful shell. Model domain
  decisions and conditional-write outcomes as separate typed values.
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
- Keep a functional core and make every stateful shell narrow, explicitly owned,
  and injectable. Do not introduce hidden global
  state because nearby legacy code has it.

## AI-Generated Code Safety Checklist

- No untested behavior changes.
- No new abstraction without real duplication or complexity reduction.
- No broad public export unless it is intentionally part of the package API.
- No hidden clock, randomness, network, storage, repository, config, or
  environment dependency.
- No clever code where named helpers or explicit branches would be easier to review.
- No construction cycle hidden by a definite-assignment assertion, setter,
  mutable closure, supplier, service locator, global, or test-only wiring path.
- No callback used only to move a business workflow deeper in the call stack.
- No generic `input`, `options`, or `context` renaming that obscures which value
  is flowing through the operation.
- No pass-through factory, wrapper, or facade without a real ownership,
  lifecycle, translation, policy, or protocol boundary.
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
skipped commands in the completion handoff. For written implementation work,
also follow the `rallar-testing` plan-completion gate. Focused checks never
substitute for that final gate.
