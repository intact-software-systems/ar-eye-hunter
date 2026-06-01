# Recommended Iteration Order

This document is the current ordered starting point for the next Rallar black-box testing work. It links back to the detailed iteration documents instead of duplicating their full scope.

## Recommended Order

1. [rallar-bb-test Iteration 10: Composite Result And Artifact Contract Hardening](../../packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md#iteration-10-composite-result-and-artifact-contract-hardening)
   - Status: completed on 2026-06-01. Stable composite result paths, summaries, trees, timelines, and redacted display rows are now available.

2. [rallar-bb-test Iteration 11: Runtime Diagnostic Normalization For WS/RTC](../../packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md#iteration-11-runtime-diagnostic-normalization-for-wsrtc)
   - Status: completed on 2026-06-01. WS/RTC warnings and adapter diagnostics now have a normalized payload contract for wait/assert and future SPA views.

3. [Distributed Recipe Iteration 51: Composite Recipe UX And Preflight](../../apps/rallar-black-box/docs/distributed-recipe-execution-iterations.md#iteration-51-composite-recipe-ux-and-preflight)
   - Status: completed on 2026-06-01. The SPA now derives and displays composite recipe preflight details, live-service badges, warnings, and compact execution trees before staging.

4. [black-box-runner Runner Iteration 1: Plan Validation And Explain Mode](../../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-1-plan-validation-and-explain-mode)
   - Status: completed on 2026-06-01. The runner CLI now has JSON `--explain`/`--validate` preflight, strict profile checks, env/connection/step/output diagnostics, and traffic-plan expansion metadata before live calls.

5. [rallar-bb-test Iteration 13: Cancellation, Deadline, And Cleanup Isolation Hardening](../../packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md#iteration-13-cancellation-deadline-and-cleanup-isolation-hardening)
   - Status: completed on 2026-06-01. Recipe cancellation now propagates through runtime abort signals, failed/cancelled/timed-out recipe runs invoke cleanup, browser-owned WS/Rallar resources close idempotently, and recipe child commands bypass stale result-cache replay between runs.

6. [Distributed Recipe Iteration 52: Structured WS/RTC Runtime Diagnostics In The SPA](../../apps/rallar-black-box/docs/distributed-recipe-execution-iterations.md#iteration-52-structured-wsrtc-runtime-diagnostics-in-the-spa)
   - Status: completed on 2026-06-01. The Distributed Recipes monitor now shows structured WS/RTC runtime diagnostics with filtering, counts, timeline entries, and command/failure correlation.

7. [Distributed Recipe Iteration 53: Composite Run Monitor Drilldowns](../../apps/rallar-black-box/docs/distributed-recipe-execution-iterations.md#iteration-53-composite-run-monitor-drilldowns)
   - Status: completed on 2026-06-01. The Distributed Recipes monitor now shows expandable composite drilldowns, nested loop/parallel/wait/assert rows, first failed child focus, group summaries, and artifact references.

8. [black-box-runner Runner Iteration 2: Safe Output Transform Layer](../../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-2-safe-output-transform-layer)
   - Status: completed on 2026-06-01. SET steps and output extraction now support safe declarative transforms, transform redaction, and actionable transform failure reports.

9. [black-box-runner Runner Iteration 3: Post-run Assertions And Thresholds](../../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-3-post-run-assertions-and-thresholds)
   - Status: completed on 2026-06-01. Final reports now support declarative post-run assertions and path-keyed thresholds over summary, metrics, diagnostics, latency, ratios, and artifact truncation evidence.

10. [black-box-runner Runner Iteration 4: Trace Correlation And Server-log Join Keys](../../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-4-trace-correlation-and-server-log-join-keys)
    - Status: completed on 2026-06-01. Runner reports, events, failures, metadata, and expanded plans now carry run/step correlation IDs, with opt-in HTTP header and WS/RTC object-payload injection.

11. [black-box-runner Runner Iteration 6: Live Environment Preflight Contract](../../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-6-live-environment-preflight-contract)
    - Status: completed on 2026-06-01. Live matrix entries now run a provisioning preflight, write `preflight-report.json`, and skip with shared env/API/auth/group/WS/ICE/control/Playwright reasons before browser runs launch.

12. [rallar-bb-test Iteration 12: Pacing Accuracy, Backpressure, And Load Observability](../../packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md#iteration-12-pacing-accuracy-backpressure-and-load-observability)
    - Status: completed on 2026-06-01. Looped WS/RTC recipes now report pacing drift, jitter, send/backpressure summaries, threshold failures, and `stats.load` summaries.

13. [rallar-bb-test Iteration 14: Composite Live Conformance Matrix](../../packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md#iteration-14-composite-live-conformance-matrix)
    - Status: completed on 2026-06-01. The shared conformance matrix now covers loop, parallel, wait/assert, cancellation, and no-peer cases across deterministic local, browser-rallar, and remote-browser/control-server provider rows.

14. [Distributed Recipe Iteration 55: Live Distributed Warning Regression Coverage](../../apps/rallar-black-box/docs/distributed-recipe-execution-iterations.md#iteration-55-live-distributed-warning-regression-coverage)
    - Status: completed on 2026-06-01. Live distributed Playwright coverage now records console artifacts, links WS/RTC/realtime receive payloads back to distributed runs, verifies realtime composite frame/drilldown evidence, and fails only on configured high-severity diagnostics.

15. [rallar-bb-test Iteration 15: Schema Versioning And Golden Recipe Compatibility](../../packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md#iteration-15-schema-versioning-and-golden-recipe-compatibility)
    - Status: completed on 2026-06-01. Recipes now support explicit v1 schema versioning, legacy unversioned recipes get compatibility warnings, and a golden corpus plus guide guard generated/external recipe compatibility.

16. [black-box-runner Runner Iteration 5: Large-run Artifact Indexing And Compaction](../../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-5-large-run-artifact-indexing-and-compaction)
    - Status: completed on 2026-06-01. Runner bundles now include `artifact-index.json`, per-kind event caps, preserved failures/diagnostics, and compact summaries for omitted repeated successes.

17. [black-box-runner Runner Iteration 7: Static Recipe Fragments And Includes](../../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-7-static-recipe-fragments-and-includes)
    - Status: completed on 2026-06-01. Runner recipes now support static inline/file fragments, include variables, safe local-path expansion during validate/explain, and `expanded-recipe.json` artifact replay material.

18. [black-box-runner Runner Iteration 8: Traffic-plan Failure Reduction](../../packages/shared-test/black-box-runner/docs/black-box-runner-followup-iterations.md#runner-iteration-8-traffic-plan-failure-reduction)
    - Status: completed on 2026-06-01. Seeded traffic failures can now be reduced offline into replay-compatible `reduced-plan.json` candidates with first-failure and removed-operation summaries.

19. [Distributed Recipe Iteration 54: Schema Authoring Prompt Templates In The SPA](../../apps/rallar-black-box/docs/distributed-recipe-execution-iterations.md#iteration-54-schema-authoring-prompt-templates-in-the-spa)
    - Status: completed on 2026-06-01. The Distributed Recipes SPA now has a Generate With AI authoring panel with copyable prompt templates, redacted context variables, schema snippets, generated-JSON validation, and copyable prompt-repair feedback.

## Current Recommendation

The 19-step recommended sequence is complete as of 2026-06-01.

Choose the next recommendation from the remaining planned work in the distributed recipe, `rallar-bb-test`, or
black-box-runner iteration documents after reviewing the latest product priorities.

Iterations 10 and 11 completed the shared result and diagnostic foundations, and
Iteration 51 applied those foundations to the SPA Distributed Recipes UX.
Runner Iteration 1 now gives generated and human-authored black-box-runner
recipes a preflight surface before live calls. Iteration 13 hardened
cancellation, deadlines, and cleanup isolation in `rallar-bb-test`. Iteration
52 surfaced normalized WS/RTC runtime diagnostics in the SPA monitor. Iteration
53 made composite run monitor drilldowns readable so users can debug nested
loop, parallel, wait, and assert results without opening raw artifacts first.
Runner Iteration 2 added a safe output transform layer for generated and
hand-authored recipes now that the runtime and monitor surfaces have better
preflight and post-run evidence. Runner Iteration 3 now lets soak, traffic,
parallel, and scale recipes fail on aggregate post-run evidence rather than
only individual step expectations. Runner Iteration 4 added trace correlation
and server-log join keys so a failed artifact can be lined up with Rallar
Server timing and runtime logs. Runner Iteration 6 added a live-environment
preflight contract before long browser and remote matrix runs launch. Rallar
bb-test Iteration 12 now adds loop pacing and backpressure observability on top
of those foundations. Rallar-bb-test Iteration 14 added the shared composite
conformance matrix so diagnostics, cleanup, drilldown, and pacing contracts can
be exercised together by provider-aware rows. Distributed Recipe Iteration 55
then locked live browser/control warning patterns into explicit regression
coverage with console artifacts, linked payload evidence, realtime composite
drilldown checks, and high-severity diagnostic policy. Rallar-bb-test
Iteration 15 then stabilized the recipe schema contract with
explicit v1 versioning, legacy compatibility warnings, a golden fixture corpus,
and compatibility guidance for AI prompt authors and external tools. The next
ordered step was Runner Iteration 5, which added artifact indexes, per-kind
caps, preserved failures/diagnostics, and compacted success summaries so longer
distributed and runner jobs stay inspectable as artifact volume grows. The next
ordered step was Runner Iteration 7: static recipe fragments and includes,
which now gives reusable setup/connect/cleanup snippets a static, local, and
preflight-visible contract plus `expanded-recipe.json` replay artifacts. The
next ordered step was Runner Iteration 8: traffic-plan failure reduction, which
now creates offline `reduced-plan.json` replay candidates from failing
`expanded-plan.json` artifacts while keeping setup, cleanup, operation order,
and first-failure context. Distributed Recipe Iteration 54 then completed the
final authoring loop by adding copyable schema-aware prompt templates, redacted
context variables, paste-back validation, preflight feedback, and Playwright
coverage for generated distributed recipe authoring in the SPA.
