import { recordRallarTiming, type RallarTimingSink } from '../../../observability/timing.ts';
import type { RttReplanPromotion } from '../../planning/resolve-rtt-replan-promotion.ts';
import type { AcceptedRtcTopologyWork } from './compute-rtc-topology-work-write.ts';

export interface RecordRtcTopologyWorkTimingInput {
    /** Present only while timing is on; absent, no event is built and no clock is read. */
    readonly timing: RallarTimingSink | undefined;
    readonly serviceId: string | undefined;
    readonly accepted: AcceptedRtcTopologyWork;
    readonly computeDurationMs: number;
}

/**
 * One line per committed recompute names its decision and reason, so a promotion after readiness is attributable.
 * The refinement gate's skips arrive once per accepted RTT report and decide nothing about the layout, so they carry
 * no line.
 */
export function recordRtcTopologyWorkTiming(input: RecordRtcTopologyWorkTimingInput): void {
    const { accepted } = input;
    if (input.timing === undefined || accepted.decision === 'skipped-rtt-refinement') {
        return;
    }
    const promotion = readRttReplanPromotion(accepted);
    recordRallarTiming({
        sink: input.timing,
        event: {
            component: 'rtc-topology-work',
            operation: 'recompute',
            serviceId: input.serviceId,
            applicationId: accepted.group.group.applicationId,
            workspaceId: accepted.group.group.workspaceId,
            groupId: accepted.group.group.groupId,
            details: {
                workKind: accepted.work.kind,
                decision: accepted.decision,
                outcome: accepted.decision === 'accepted' ? accepted.computed.outcome : undefined,
                reason: promotion?.reason,
                layoutAgeMs: promotion !== null && 'layoutAgeMs' in promotion ? promotion.layoutAgeMs : undefined,
                overlayVersion: readCommittedOverlayVersion(accepted),
                groupRevision: accepted.group.causalRevision.groupRevision,
                presenceRevision: accepted.group.causalRevision.presenceRevision
            }
        },
        status: 'ok',
        durationMs: input.computeDurationMs
    });
}

type TimedRtcTopologyWork = Exclude<AcceptedRtcTopologyWork, { decision: 'skipped-rtt-refinement'; }>;

function readRttReplanPromotion(accepted: TimedRtcTopologyWork): RttReplanPromotion | null {
    return accepted.decision === 'accepted' || accepted.decision === 'held-young-layout'
        ? accepted.rttReplanPromotion
        : null;
}

/** The layout version the decision left stored; a superseded attempt committed none of its own. */
function readCommittedOverlayVersion(accepted: TimedRtcTopologyWork): number | undefined {
    if (accepted.decision !== 'accepted') {
        return accepted.criterionPetition?.planned.version;
    }
    const { computed } = accepted;
    if (computed.outcome === 'write') {
        return computed.snapshotGuard.candidate.version;
    }
    return computed.outcome === 'publish-superseded' ? computed.currentGuard.current.version : undefined;
}
