---
name: rallar-code-writing
description: Use when writing, generating, refactoring, or reviewing any human-authored code in the Rallar repository, including TypeScript APIs, interfaces, DTOs, type aliases, namespaces, classes with associated types, public type surfaces, and TypeScript type organization; TypeScript-specific rules also apply to TypeScript surfaces. It governs all human-authored code.
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

Production code is the primary design artifact; tests are secondary evidence.
Tests protect independently stated observable behavior, public contracts, safety
and correctness invariants, and approved architecture boundaries. Classify a
failing test as a production regression or obsolete test coupling before changing
production. Never restore inferior production structure merely to make a coupled
test pass. Apply the canonical standard's cognitive-indirection and
affected-surface legacy-closure rules to every changed production path.

The first principle, construction and callback rules, responsibility boundaries,
explicit dataflow, and testability doctrine apply to all human-authored code.
Always read `references/repo-code-style.md` completely before writing,
refactoring, generating, or reviewing code. It is the authoritative repo-wide
coding standard; local guidance may tighten it but may not relax it.

TypeScript changes must also follow every TypeScript-specific rule in
`references/repo-code-style.md`.

**REQUIRED SUB-SKILL:** Use `organizing-repository-structure` for repository shape decisions.

**REQUIRED SUB-SKILL:** Use `adaptive-plan-execution` for written or multi-slice code work.

When TypeScript work creates, changes, reviews, or refactors named types — APIs,
interfaces, DTOs, type aliases, namespaces, classes with associated types, or
public type surfaces — also read `references/typescript-type-organization.md`
completely. It is authoritative for canonical type naming, alias discipline,
qualification, and type-only class namespaces.

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

For every materially different callback, transaction, retry, protocol, or
lifecycle family, produce a family-level code-derived trace as two distinct
timelines:

The two timelines separate registration from invocation.

1. A construction and registration timeline names each required or captured
   dependency's creation and owner, the callback registration point, the first
   point at which it can be invoked, and proves every required dependency exists
   before that point.
2. A runtime invocation timeline names:

- the external or protocol entry;
- callback registration owner and registration time;
- runtime invoker and callback invocation count or retry rule;
- representation translation and read, compute, validate, and write owners;
- transaction and retry owner and the first conditional guard;
- receipt, event, exact durable result, and final outbox writes;
- commit-return point and private after-commit data;
- after-commit effects, early exits, failures, and cleanup; and
- final caller-visible result and canonical versus compatibility paths.

Variants that share one control-flow family use one trace plus an explicit
variant inventory. A plan, file inventory, source-text assertion, or passing
checker does not substitute for following production symbols.

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
- The fail-closed rule is that mutable values do not escape a transaction
  callback unless the callback contract proves invocation count, retry
  behavior, commit semantics, failure behavior, and why mutation is safe.
  Prefer an immutable callback result that visibly separates the durable result
  from private after-commit data.
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

Use `rallar-testing` to select the focused tests, type-checks, and high-risk
proofs for the touched surface. Run
`npm run check:repo-style` and review warnings in changed production files. For
output that reaches the display cap, rerun with `--root` set to the smallest
directory containing changed production files. For public API or cross-runtime
changes, check both browser and server consumers. Report passed, failed, and
skipped commands in the completion handoff. For written or multi-slice work,
`adaptive-plan-execution` owns working-plan and proportional-validation judgment.

For every construction-detail warning in changed production code, record its
path, rule, and symbol plus one human disposition: fixed, demonstrated false
positive, or accepted existing debt with no new/worsened magnitude and an
owner. The review rule is that silence or a warning-only exit code is not a
disposition. This review does not make every optional warning globally
blocking.

## Affected Production Legacy

For written work that affects production, require a legacy baseline and exit criteria, a legacy
impact judgment for each capability slice, and a final complete code and legacy review. The
working plan owns when that review runs; this skill owns the code judgment. Trace every
changed production path from canonical entry to result and classify affected legacy as `removed`,
`minimized-boundary`, `resolved`, or `retained-pending-human-approval`. Unclassified affected
legacy blocks code completion. A retained item requires explicit human approval of its purpose,
consumer, unsafe-removal reason, minimization, owner, tests, review/removal condition, and current
retained implementation. An issue or agent judgment does not replace that approval.
