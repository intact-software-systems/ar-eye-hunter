---
name: performance-analysis
description: Turns a performance question into a measured finding. Use when reviewing bottlenecks, profiling a workload, investigating a leak, or checking an optimization.
---

# Performance Analysis Skill

**REQUIRED SUB-SKILL:** Use `rallar-code-writing` when an analysis changes,
generates, refactors, or reviews TypeScript.

When the workload is WebRTC, RTC, or data channels, read
`references/webrtc-performance-focus.md`.

## Core rule

Treat static analysis as hypothesis generation unless the issue is obvious from code. Do not claim a runtime bottleneck is real until it is supported by profiling, benchmarks, logs, production telemetry, or a clear algorithmic proof.

For an api-v1 state mutation-path or concurrency-domain change, run
`npm run perf:api-v1:state-write` and require the comparative result gate:
`node apps/api-v1/scripts/perf/compare-api-v1-state-write-results.mjs <baseline> <candidate>`.
Also preserve the medium-scale correctness gate after focused tests:
`npm run test:api-v1:black-box:postgres:medium-scale`, with 100 independently
authenticated clients, five groups, three Postgres-backed API processes, 10
client lanes plus 5 control lanes; never reduce those constants.
Repository/SQL call counts and transaction duration may be reported only from
retained focused-test, trace, or performance artifacts that directly measure
them. State an uncaptured metric as uncaptured; never estimate it from source.

A three-server API-v1 black-box topology change requires its correctness and
load gates, but not a new production performance benchmark or numeric SLO by
itself. Require the state-write performance comparison only when the same
change alters a production mutation path or concurrency domain.

For `strict-domain-write`, do not move deterministic computation into a
transaction to improve an apparent timing metric. Keep
`read -> compute -> validate -> write(transaction, computed)` visible, and
treat precomputable work as non-waivable even when the computation is cheap or
a deadline is close. Apply the separately defined guarded winner-materializer
allowance only after resolving a `specialized-resource-inbox` transaction
owner.

Transaction timing is not value provenance. Under `strict-domain-write`, only
actual database-returned facts justify inside-transaction refinement; a
winner-only clock, key, random value, serialized payload, sorted collection, or
outbox remains precomputable. The convergent-service reference owns the exact,
narrow ResourceInbox winner-materializer exception.

Transaction-owner policy changes how a measured critical section is interpreted,
not whether it is measured. Classify the resolved owner using the convergent
service reference, then compare like-for-like workloads. A shorter metric never
authorizes work that its policy prohibits.

## Default workflow

Follow this sequence unless the user explicitly asks for a different phase.

1. **Frame the task**
   - Identify the target subsystem, entry points, workload, environment, and success metric.
   - Inspect repo guidance first, including `AGENTS.md`, README files, docs, build/test config, benchmark config, and existing performance notes.
   - Determine whether the task is static-only, measurement-only, or optimization.
   - If the user did not specify a phase, start with static analysis and say that runtime validation is needed later.

2. **Static performance audit**
   - Do not modify code.
   - Prefer concrete findings with file, function/class, and line references.
   - Map likely hot paths: request handlers, jobs, CLIs, batch processors, event handlers, background workers, data pipelines, import/startup paths, and loops over externally sized inputs.
   - Identify algorithmic complexity, allocation behavior, I/O behavior, and concurrency behavior.
   - Label each finding as one of:
     - `Proven from code`
     - `Strong suspicion`
     - `Needs runtime measurement`
     - `Measured`
   - Avoid generic advice. Every finding should point to a concrete code location or a specific measurement to run.

3. **Measurement plan**
   - Convert static findings into falsifiable hypotheses.
   - Define representative, large, and worst-case inputs.
   - Specify commands, profilers, benchmark harnesses, instrumentation points, and expected signals.
   - Separate cold-start measurements from steady-state measurements.
   - Include CPU time, wall time, allocation rate, peak RSS/heap, retained memory, GC pressure, I/O wait, DB/API/file/network call counts, and concurrency bottlenecks when relevant.

4. **Runtime validation**
   - Do not optimize yet unless the user explicitly asks.
   - Keep generated benchmark/profile artifacts isolated in a clearly named directory such as `perf-artifacts/`, `tmp/perf/`, or another repo-approved ignored path.
   - Record exact commands, commit/branch, environment assumptions, input sizes, config, and number of runs.
   - Run each benchmark more than once when practical.
   - Compare measurements against the hypotheses and mark each hypothesis confirmed, refuted, or inconclusive.

5. **Optimization**
   - Make one focused change at a time.
   - Preserve behavior, public APIs, persistence formats, and compatibility unless the user explicitly approves a breaking change.
   - Prefer algorithmic, batching, data-structure, I/O, and allocation fixes over micro-optimizations.
   - Add or update tests and benchmarks when practical.
   - Re-run relevant tests and before/after measurements.
   - Report performance impact honestly, including uncertainty and remaining risk.

## Static audit checklist

Look for these issue classes:

- Algorithmic complexity: nested loops over large inputs, repeated scans, repeated sorting, quadratic joins, inefficient graph traversal, repeated deduplication, and avoidable recomputation.
- Data structures: list membership where a set/map is needed, ordered structures where unordered lookup is enough, excessive copying, large temporary collections, poor key choice, and unnecessary materialization.
- CPU-heavy work: repeated parsing, repeated regex compilation, expensive regex patterns, repeated serialization/deserialization, compression/encryption/hashing on hot paths, reflection/introspection, excessive formatting, and debug work.
- Memory pressure: large objects retained too long, avoidable allocations, unbounded growth with input/user/tenant/runtime size, large buffers, full-file reads, unnecessary copies, and high-cardinality metrics/log labels.
- Leak risks: unbounded caches/maps/queues, forgotten event listeners/subscriptions, timers, background tasks, goroutines/threads, retained closures, file handles, sockets, DB connections, and lifecycle mismatches.
- I/O and network: N+1 DB/API/file calls, missing batching, missing pagination, missing streaming, no backpressure, repeated metadata reads, synchronous I/O on hot paths, and unnecessary round trips.
- Database behavior: query inside loop, missing indexes, unbounded result sets, unnecessary eager loading, excessive joins, repeated transactions, lock-heavy access patterns, and missing query count tests.
- Concurrency: coarse locks, long critical sections, lock ordering risks, thread-pool starvation, event-loop blocking, unbounded parallelism, excessive synchronization, queue contention, and missing cancellation/timeouts.
- Caching: no cache for expensive stable results, wrong cache key, unbounded cache, stale data risk, cache stampede risk, and per-request cache missed opportunities.
- Observability cost: expensive logs/metrics/traces in hot paths, string formatting before log-level checks, high-cardinality labels, and excessive span/event creation.

## Measurement checklist

For each finding, specify:

- Hypothesis
- Measurement that would confirm it
- Measurement that would falsify it
- Tool or command to use
- Input sizes and fixtures
- Expected signal
- Noise or accuracy risks

Prefer existing project tooling. If no tooling exists, propose the minimum useful harness before writing one.

When writing the static audit, runtime validation, or optimization result, read
`references/report-formats.md` and use the format for the completed phase.

## Done when

The task is complete only when:

- Every performance finding has a code location, measured artifact, or explicit reason why location is not applicable.
- Every major claim is labeled as proven, suspected, needs measurement, measured, confirmed, refuted, or inconclusive.
- Each suspected issue has a concrete validation step.
- Recommendations are ranked by expected impact, confidence, and implementation risk.
- Static-analysis tasks make no code changes.
- Runtime-validation tasks record exact commands and environment details.
- Optimization tasks include correctness validation and performance before/after data when practical.
- No optimization is accepted without a benchmark, profile, telemetry signal, or clear algorithmic proof.
- Transactional correctness and retry evidence comes from production receipts,
  outbox records/effects, and timing events. Synthetic post-call evidence cannot
  prove atomicity; legacy artifact compatibility must not weaken candidate validation.
- Synthetic prerequisite or non-invocation evidence must link to an earlier same-subject predecessor with real production exhaustion; labels alone are not causal proof.
