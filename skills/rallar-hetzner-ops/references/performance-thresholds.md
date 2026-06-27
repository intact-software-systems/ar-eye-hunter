# Performance Review

For passed runs, read `analysis/performance.md` and `analysis/analysis.json`.

Report:

- pass rate
- run duration
- agent count
- command timing count, p50, p95, p99, max
- stream timing for `rtc.stream` manifests: stream count,
  completed/planned frames, attempted frames, failed frames, dropped frames,
  backpressure count, p50, p95, p99, max, achieved Hz, and slowest stream
  agents
- reconnect count
- diagnostic count
- failed, missing, stale, and flaky agent counts

Call out risk when:

- pass rate is below 100%
- reconnects are nonzero
- stale, missing, failed, or flaky agents are nonzero
- p95 command timing is much higher than p50
- stream completed frames are below planned frames
- stream failed, dropped, or backpressured frame counts are nonzero
- stream p95 or p99 send duration is much higher than p50
- diagnostics increased compared with a known baseline

If no baseline exists, treat the report as a first baseline rather than a
regression.
