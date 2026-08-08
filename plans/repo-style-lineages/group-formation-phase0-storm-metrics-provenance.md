# Group Formation Phase 0 Storm Metrics — Structural Lineage Provenance

Phase 0 of `plans/rallar-group-formation-phase0-storm-metrics-plan.md` adds
never-throw storm counters inside owners that were already at or above the
400-line file budget at merge base `05cec262`. Growing those files would raise
worsened `file.length` findings, so each instrumented owner released budget by
extracting one cohesive sub-responsibility into a sibling module. Every split
is behavior-preserving; public import paths are kept through re-exports from
the original owner.

| Source | Extracted target | Extracted responsibility |
| --- | --- | --- |
| `packages/shared/services/WsQueueBoxServerService.ts` | `ws-queue-box-server-contracts.ts` | Exported WS server delivery contracts (recipients, live-send results, target resolver, options, delivery outcomes, delivery diagnostics). |
| `packages/shared/services/WebRtcGroupManager.ts` | `webrtc-group-manager-contracts.ts` | Manager state/options/diagnostics contracts plus the pure `clonePeerOwners` projection. |
| `packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts` | `admin-operations-request-reading.ts` | Pure admin request/boundary decoding helpers (`readObject`, category, document, and timing readers). |
| `apps/api-v1/src/middleware.ts` | `apps/api-v1/src/services/init-api-rtc-topology-scalar-recompute-worker.ts` | The RTC topology scalar recompute worker registration (process callback plus outbox write). |
| `packages/shared-web/browser/rallar-rtc-facade.ts` | `packages/shared-web/browser/rtc-diagnostics/rallar-rtc-diagnostics-contracts.ts` | RTC status and diagnostics contracts (peer/lane status, candidate-pair and RTC diagnostics shapes). |
| `packages/shared-web/browser/rallar-runtime/rtc.ts` | `packages/shared-web/browser/rtc-diagnostics/rtc-candidate-pair-diagnostics.ts` | Pure WebRTC getStats candidate-pair diagnostics reading. |

The new `packages/shared-web/browser/rtc-diagnostics/` folder owns the RTC
diagnostics feature boundary shared by the facade contract and the runtime
stats reader.
