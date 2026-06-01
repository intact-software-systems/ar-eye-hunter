# Recommended Iteration Order

This document is the current ordered starting point for the next Rallar black-box testing work. It links back to the detailed iteration documents instead of duplicating their full scope.

## Recommended Order

1. [rallar-bb-test Iteration 10: Composite Result And Artifact Contract Hardening](../packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md#iteration-10-composite-result-and-artifact-contract-hardening)
   - Status: completed on 2026-06-01. Stable composite result paths, summaries, trees, timelines, and redacted display rows are now available.

2. [rallar-bb-test Iteration 11: Runtime Diagnostic Normalization For WS/RTC](../packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md#iteration-11-runtime-diagnostic-normalization-for-wsrtc)
   - Status: completed on 2026-06-01. WS/RTC warnings and adapter diagnostics now have a normalized payload contract for wait/assert and future SPA views.

3. [Distributed Recipe Iteration 51: Composite Recipe UX And Preflight](../apps/rallar-black-box/docs/distributed-recipe-execution-iterations.md#iteration-51-composite-recipe-ux-and-preflight)
   - Status: completed on 2026-06-01. The SPA now derives and displays composite recipe preflight details, live-service badges, warnings, and compact execution trees before staging.

4. [black-box-runner Runner Iteration 1: Plan Validation And Explain Mode](../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-1-plan-validation-and-explain-mode)
   - Status: completed on 2026-06-01. The runner CLI now has JSON `--explain`/`--validate` preflight, strict profile checks, env/connection/step/output diagnostics, and traffic-plan expansion metadata before live calls.

5. [rallar-bb-test Iteration 13: Cancellation, Deadline, And Cleanup Isolation Hardening](../packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md#iteration-13-cancellation-deadline-and-cleanup-isolation-hardening)
   - Reduce flaky leftovers from timers, WS connections, RTC channels, and distributed browser runs before expanding live coverage.

6. [Distributed Recipe Iteration 52: Structured WS/RTC Runtime Diagnostics In The SPA](../apps/rallar-black-box/docs/distributed-recipe-execution-iterations.md#iteration-52-structured-wsrtc-runtime-diagnostics-in-the-spa)
   - Surface the normalized runtime diagnostics from rallar-bb-test in the command-center UI.

7. [Distributed Recipe Iteration 53: Composite Run Monitor Drilldowns](../apps/rallar-black-box/docs/distributed-recipe-execution-iterations.md#iteration-53-composite-run-monitor-drilldowns)
   - Build on the composite result contract so users can inspect nested loop and parallel execution without reading raw JSON.

8. [black-box-runner Runner Iteration 2: Safe Output Transform Layer](../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-2-safe-output-transform-layer)
   - Improve recipe authoring by allowing safe derived values without turning the runner into application logic.

9. [black-box-runner Runner Iteration 3: Post-run Assertions And Thresholds](../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-3-post-run-assertions-and-thresholds)
   - Add run-level pass/fail thresholds after individual command assertions are stable.

10. [black-box-runner Runner Iteration 4: Trace Correlation And Server-log Join Keys](../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-4-trace-correlation-and-server-log-join-keys)
    - Make it easier to correlate runner artifacts with Rallar Server logs and production timing records.

11. [black-box-runner Runner Iteration 6: Live Environment Preflight Contract](../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-6-live-environment-preflight-contract)
    - Validate live server capabilities, credentials, and required endpoints before long-running tests start.

12. [rallar-bb-test Iteration 12: Pacing Accuracy, Backpressure, And Load Observability](../packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md#iteration-12-pacing-accuracy-backpressure-and-load-observability)
    - Improve timing fidelity and observability for repeated WS/RTC traffic after diagnostics and cleanup are reliable.

13. [rallar-bb-test Iteration 14: Composite Live Conformance Matrix](../packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md#iteration-14-composite-live-conformance-matrix)
    - Expand live browser coverage once the lower-level contract, diagnostics, and cleanup behavior are stable.

14. [Distributed Recipe Iteration 55: Live Distributed Warning Regression Coverage](../apps/rallar-black-box/docs/distributed-recipe-execution-iterations.md#iteration-55-live-distributed-warning-regression-coverage)
    - Lock down the warnings observed in live Playwright runs as explicit regression coverage.

15. [rallar-bb-test Iteration 15: Schema Versioning And Golden Recipe Compatibility](../packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md#iteration-15-schema-versioning-and-golden-recipe-compatibility)
    - Stabilize recipe compatibility after the core composite behavior has settled.

16. [black-box-runner Runner Iteration 5: Large-run Artifact Indexing And Compaction](../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-5-large-run-artifact-indexing-and-compaction)
    - Defer until large-run artifact volume becomes a practical issue.

17. [black-box-runner Runner Iteration 7: Static Recipe Fragments And Includes](../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-7-static-recipe-fragments-and-includes)
    - Defer until validation, transforms, and preflight semantics are stable enough to reuse safely.

18. [black-box-runner Runner Iteration 8: Traffic-plan Failure Reduction](../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-8-traffic-plan-failure-reduction)
    - Defer until seeded traffic plans are being used often enough to justify hardening replay and failure diagnosis.

19. [Distributed Recipe Iteration 54: Schema Authoring Prompt Templates In The SPA](../apps/rallar-black-box/docs/distributed-recipe-execution-iterations.md#iteration-54-schema-authoring-prompt-templates-in-the-spa)
    - Add after schemas, preflight, diagnostics, and monitor drilldowns are stable enough that generated recipes have a reliable target.

## Current Recommendation

Start with [rallar-bb-test Iteration 13](../packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md#iteration-13-cancellation-deadline-and-cleanup-isolation-hardening).

Iterations 10 and 11 completed the shared result and diagnostic foundations, and
Iteration 51 applied those foundations to the SPA Distributed Recipes UX.
Runner Iteration 1 now gives generated and human-authored black-box-runner
recipes a preflight surface before live calls. The next useful step is cleanup
and cancellation hardening in `rallar-bb-test` so larger distributed and live
runs leave fewer timers, sockets, channels, or stale browser-agent state behind.
