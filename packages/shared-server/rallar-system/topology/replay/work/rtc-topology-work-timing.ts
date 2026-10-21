import { recordRallarTiming, type RallarTimingSink } from '../../../observability/timing.ts';
import type { RttReplanPromotion } from '../../planning/resolve-rtt-replan-promotion.ts';
import type { AcceptedRtcTopologyWork } from './compute-rtc-topology-work-write.ts';

export interface RecordRtcTopologyWorkTimingInput {
    readonly timing: RallarTimingSink | undefined;
    readonly serviceId: string | undefined;
    readonly accepted: AcceptedRtcTopologyWork;
    readonly computeDurationMs: number;
}

/** One line per committed recompute names its decision and reason, so a promotion after readiness is attributable. */
export function recordRtcTopologyWorkTiming(input: RecordRtcTopologyWorkTimingInput): void {
    if (input.timing === undefined) {
        return;
    }
    const { accepted } = input;
    const promotion = readRttReplanPromotion(accepted);
    const planned = 'criterionPetition' in accepted ? accepted.criterionPetition?.planned : undefined;
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
                layoutAgeMs: promotion?.layoutAgeMs ?? undefined,
                overlayVersion: planned?.version,
                groupRevision: accepted.group.causalRevision.groupRevision,
                presenceRevision: accepted.group.causalRevision.presenceRevision
            }
        },
        status: 'ok',
        durationMs: input.computeDurationMs
    });
}

function readRttReplanPromotion(accepted: AcceptedRtcTopologyWork): RttReplanPromotion | null {
    return accepted.decision === 'accepted' || accepted.decision === 'held-young-layout'
        ? accepted.rttReplanPromotion
        : null;
}
