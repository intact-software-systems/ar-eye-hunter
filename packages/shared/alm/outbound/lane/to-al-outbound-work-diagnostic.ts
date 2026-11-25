import type { ALStoreDurability } from '../../../al-contracts/al-policy.ts';
import type { ALWorkDiagnostics } from '../../work/al-work-handler.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '../al-outbound-message-runtime.ts';
import type { ALOutboundClaimRun } from './settle-al-outbound-claim.ts';

/**
 * A work handler's statement as the outbound lane states it, with the claims the lane's running batch settled. The
 * outbound owner reserves without reading a page, so a drain carries no selection read and no queue wait. A drain's
 * `expeditedCount` and `end` follow `claims`, so a `contains` match on the fields before them still finds it.
 */
export function toALOutboundWorkDiagnostic(
    event: ALWorkDiagnostics,
    lane: ALStoreDurability,
    claimRuns: readonly ALOutboundClaimRun[]
): ALOutboundRuntimeDiagnosticsEvent {
    switch (event.kind) {
        case 'readiness-probe':
            return {
                kind: 'readiness-probe',
                lane,
                workerId: event.workerId,
                cause: event.cause,
                readyAtMs: event.readyAtMs,
                durationMs: event.durationMs
            };
        case 'work-batch-started':
            return {
                kind: 'effect-drain-started',
                lane,
                workerId: event.workerId,
                startedAtMs: event.startedAtMs,
                claimedCount: event.claimedCount
            };
        case 'work-batch':
            return {
                kind: 'effect-drain',
                lane,
                workerId: event.workerId,
                durationMs: event.durationMs,
                claimedCount: event.claimedCount,
                completedCount: event.completedCount,
                rescheduledCount: event.rescheduledCount,
                rejectedCount: event.rejectedCount,
                claimDurationMs: event.claimDurationMs,
                runDurationMs: event.runDurationMs,
                releaseDurationMs: event.releaseDurationMs,
                startedAtMs: event.startedAtMs,
                claims: claimRuns,
                expeditedCount: event.expeditedCount,
                end: event.end
            };
    }
}
