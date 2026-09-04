---
name: performance-analysis
description: Use when reviewing performance, finding bottlenecks, analyzing algorithmic or resource efficiency, profiling representative workloads, investigating memory leaks, or validating an optimization.
---

# Performance Analysis Skill

**REQUIRED SUB-SKILL:** Use `rallar-code-writing` when an analysis changes,
generates, refactors, or reviews TypeScript.

Use this skill when the user asks for performance analysis, optimization, bottleneck hunting, algorithmic complexity review, CPU or memory profiling, memory leak investigation, allocation reduction, query/API call reduction, or runtime validation.

## Core rule

Treat static analysis as hypothesis generation unless the issue is obvious from code. Do not claim a runtime bottleneck is real until it is supported by profiling, benchmarks, logs, production telemetry, or a clear algorithmic proof.

For an api-v1 state mutation-path or concurrency-domain change, run
`npm run perf:api-v1:state-write` and require the comparative result gate:
`node scripts/perf/compare-api-v1-state-write-results.mjs <baseline> <candidate>`.
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

Do not move deterministic computation into a transaction to improve an
apparent timing metric. Keep
`read -> compute -> validate -> write(transaction, computed)` visible, and
treat precomputable work as non-waivable even when the computation is cheap or
a deadline is close.

For both phases, the same explicit input produces the same result. They perform
no repository reads, clocks, randomness, mutable dependency lookups, or hidden
side effects. Do not add `prepare`, `prepareWrite`, or another deterministic
transformation after `compute`; `compute` returns persistence-ready data and
`validate` checks that exact result. Adding another service mutation phase
requires explicit human approval. One queue delivery performs one mutation
attempt. A conflict exits that attempt; queue redelivery starts again from
`read`. Never improve a transaction-duration metric by adding a handler-local
or persistence-helper retry loop.

Transaction timing is not value provenance: only
actual database-returned facts justify inside-transaction refinement, while a
winner-only clock, key, random value, serialized payload, sorted collection, or
outbox remains precomputable.

The specialized ResourceInbox policy changes what work is authorized, not
whether transaction duration is measured. Continue to measure its exact
PostgreSQL reservation, result, and QueueBox owners as transaction critical
sections and compare like-for-like workloads. Timing does not establish policy
ownership: classify the resolved opener and owner first, then interpret the
measurement under `strict-domain-write` or `specialized-resource-inbox`.
Do not classify authorized bounded specialized transformations or guarded
winner-only materialization as a strict precomputable-work violation merely
because they contribute to the measured transaction duration.
Calling ResourceInbox from an AppInbox/domain transaction does not transfer the
specialized policy, and browser IndexedDB transactions remain strict. A shorter
metric never authorizes external effects, polling, unbounded work, or arbitrary
callbacks inside a specialized boundary.

When a proof-and-tooling slice has a controller-owned unchanged performance
baseline, preserve that division of responsibility: do not regenerate,
replace, or commit benchmark artifacts in the tooling slice. Record the
controller-owned unchanged performance baseline as external evidence and leave
candidate comparison to the production mutation-path change that can affect
the measured workload.

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

Common tool choices by ecosystem, when applicable:

- Python: `pytest-benchmark`, `cProfile`, `py-spy`, `scalene`, `tracemalloc`, `memory_profiler`.
- JavaScript/TypeScript/Node: `node --prof`, `node --inspect`, Chrome DevTools, `clinic`, `benchmark`, framework-specific profilers.
- Go: `go test -bench`, `-benchmem`, `pprof`, `trace`, race detector where concurrency is relevant.
- Java/Kotlin/JVM: JMH, Java Flight Recorder, async-profiler, heap dumps, GC logs.
- .NET: BenchmarkDotNet, `dotnet-counters`, `dotnet-trace`, `dotnet-gcdump`.
- Rust: Criterion, `cargo bench`, `perf`, heaptrack, DHAT/Valgrind where available.
- C/C++: `perf`, Valgrind/Callgrind, heaptrack, sanitizers, compiler optimization reports.
- Databases: query plans, query count instrumentation, slow query logs, index usage, representative fixtures.

## Report format: static audit

Use this structure:

```md
# Performance audit

## Executive summary

- Top 5 risks, ranked by expected impact and confidence.

## Hot path map

- Entry point -> critical flow -> likely expensive modules.

## Findings

| Severity |       Confidence | Category               | Location            | Why costly | Complexity/memory impact | Validation | Suggested fix |
| -------- | ---------------: | ---------------------- | ------------------- | ---------- | ------------------------ | ---------- | ------------- |
| High     | Strong suspicion | Algorithmic complexity | `path/file.ext:123` | ...        | ...                      | ...        | ...           |

## False-positive risks

- Findings that may be harmless depending on workload.

## Measurement plan

- Benchmarks, profilers, fixtures, and instrumentation needed next.

## Do first

1. Highest-impact next action.
2. Second action.
3. Third action.
```

## Report format: runtime validation

Use this structure:

````md
# Runtime performance validation

## Environment

- Branch/commit:
- Hardware/container notes:
- Runtime versions:
- Config:
- Input sizes:

## Commands run

```sh
# exact commands
```
````

## Results

| Hypothesis | Result | Evidence | Confirmed/refuted/inconclusive | Notes |
| ---------- | ------ | -------- | ------------------------------ | ----- |

## CPU profile interpretation

- Hot functions, call paths, and likely causes.

## Memory profile interpretation

- Allocation sites, retained memory, peak heap/RSS, GC pressure.

## Leak findings

- Evidence for or against leak-like growth over repeated/long-running workloads.

## Recommendations

| Rank | Fix | Expected impact | Confidence | Risk | Validation |
| ---: | --- | --------------- | ---------- | ---- | ---------- |

## Next step

- One small, safe optimization to attempt first.

````
## Report format: optimization result

Use this structure:

```md
# Performance optimization result

## Change summary
- What changed and why.

## Files changed
- `path/file.ext`

## Correctness validation
- Tests run and results.

## Performance validation
| Metric | Before | After | Delta | Notes |
|---|---:|---:|---:|---|

## Remaining risks
- Correctness, compatibility, measurement, or workload caveats.

## Follow-up opportunities
- Additional fixes that should be separate changes.
````

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
