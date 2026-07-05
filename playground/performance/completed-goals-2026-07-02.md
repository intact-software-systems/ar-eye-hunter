# Completed Goals

Date: 2026-07-02

This note records the goals completed during the performance-analysis workstream
and points to the durable artifacts or current worktree evidence for each one.

## Completed

| Goal | Status | Evidence |
| --- | --- | --- |
| Static performance audit of `packages/**` and `apps/api-v1/src/**` | Completed | `playground/rallar-static-performance-audit-2026-07-02.md` |
| Runtime validation plan for the highest-risk hypotheses | Completed | `playground/rallar-runtime-performance-validation-plan-2026-07-02.md` |
| Runtime performance validation runs and ranked findings | Completed | `playground/rallar-runtime-performance-validation-report-2026-07-02.md`; generated artifacts under `tmp/perf/results/`, `tmp/perf/profiles/`, `tmp/perf/logs/`, and `tmp/perf/artifacts/` |
| Promote reusable perf scripts out of `tmp/perf/scripts` | Completed | Reusable harnesses now live under `scripts/perf/**`; background and how-to commands are in `scripts/perf/README.md`. Generated measurement outputs remain under `tmp/perf/**`. |
| Implement the highest-impact low-risk measured fix | Completed in the current worktree | Legacy client/group `/events` routes now use bounded recent-event reads instead of loading full history and slicing in memory. Main files: `apps/api-v1/src/routes/client-state-routes.ts`, `apps/api-v1/src/routes/group-state-routes.ts`, `packages/shared-server/postgres/rallar-system/PSqlStateEventRepository.ts`, `packages/shared-server/rallar-system/repositories/StateEventStore.ts`, and service/repository plumbing. |
| Reduce measured server/API and shared-runtime hot paths | Completed in focused slices in the current worktree | Current worktree includes focused fixes for runtime/app-data prefix reads, latest-value cache expiry, WebSocket encode-once send fanout, sparse queue selection stats/indexes, CRDT stored-byte totals, rate-limiter cleanup cadence, `/clients` and `/groups` snapshot batching, and state-sync scan reductions. See `playground/rallar-performance-optimization-progress-2026-07-02.md`. |
| Reduce measured WebRTC/RTC topology and local coordination costs | Completed in focused slices in the current worktree | Current worktree includes topology fast paths, RTT graph lookup improvements, DataChannel queue/index and close/error cleanup, WebRTC group lookup caches, topology service metrics, inactive topology snapshot cleanup, `QRtcPeerConnection` reconnect/signaling diagnostics, browser `rallar.rtc.diagnostics()` exposure for those counters, live three-browser RTC diagnostics artifacts for the simple memory-mode matrix, partial global graph cache recompute tolerance for early RTT/Vivaldi coverage, and disconnect timer coalescing under peer network flaps. See `playground/rallar-performance-optimization-progress-2026-07-02.md`. |

## Optimization Validation

Correctness checks completed:

- `deno test --config apps/api-v1/deno.json --allow-env --allow-read apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- `deno test --config apps/api-v1/deno.json --allow-env --allow-read --allow-write apps/api-v1/test/db/pglite-sql-adapter.test.ts`
- `npx vitest run packages/tests/shared-server/state-event-listing.test.ts packages/tests/api-v1/client-and-group-state-repositories.test.ts`
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
- `cd apps/api-v1 && deno task check`
- `git diff --check`

Performance comparison artifacts:

- Before: `tmp/perf/results/optimization-before-events-runs3.json`
- Before summary: `tmp/perf/results/optimization-before-events-summary.json`
- After: `tmp/perf/results/optimization-after-events-runs3.json`
- After summary: `tmp/perf/results/optimization-after-events-summary.json`

Measured signal:

| Case | Median |
| --- | ---: |
| Old legacy parse-all/slice path, 100k rows | 38.447 ms before; 38.067 ms after as contrast |
| New bounded recent-tail path, 100k rows | 0.067 ms after |

The route-equivalent hot path changed from parsing all 100k event rows to parsing
only the bounded recent tail, while preserving the legacy array response shape.

## Follow-Up Opportunities

The broad measured performance optimization workstream is complete for this
pass. Remaining ranked risks are intentionally separate follow-up goals:

- RTT-triggered topology rebuild pressure under real heartbeat cadence.
- Reconnect/renegotiation churn under stress, lossy networks, exhaustive live
  sender/receiver permutations, or longer soaks. The simple memory-mode live
  matrix now has diagnostics artifacts and showed no reconnect/offerglare/ICE
  queue churn.
- Protocol-level handling for large multicast payloads if real sessions show
  high peer-count fanout.
- High-cardinality cache lifetime validation outside RTC topology under
  long-running tenant/app churn.

Generated profiling and benchmark outputs under `tmp/perf/**` remain local
measurement artifacts and are not intended to be checked in unless explicitly
requested.
