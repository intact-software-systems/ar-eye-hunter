import type { ALOutboundDequeuedAdmission } from '@shared/alm/outbound/lane/al-outbound-dequeued-admission.ts';
import type { ALWorkClaim } from '@shared/alm/work/al-work-queue-port.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { recordRallarTiming, type RallarTimingSink } from './timing.ts';

export interface CreateRallarALOutboundDequeueTimingInput {
    readonly timing: RallarTimingSink;
    readonly serviceId: string;
    readonly publisherId: string;
}

interface ToEntryTimingEventInput {
    readonly entry: ResourceEntry;
    readonly attempts: number;
    readonly batchIndex: number;
    readonly stage: ALOutboundDequeuedAdmission.TimingStage;
}

/** Server-only translation from claimed work facts to identity-only process timing. */
export function createRallarALOutboundDequeueTiming(
    input: CreateRallarALOutboundDequeueTimingInput
): ALOutboundDequeuedAdmission.TimingSink {
    return (observation) => {
        for (const stage of toALOutboundDequeueTimingEvents(observation)) {
            recordRallarTiming({
                sink: input.timing,
                event: {
                    component: 'alm-outbound-dequeue',
                    operation: stage.stage,
                    serviceId: input.serviceId,
                    details: {
                        publisherId: input.publisherId,
                        topicId: stage.key.topicId,
                        resourceId: stage.key.resourceId,
                        contextId: stage.key.contextId,
                        attempts: stage.attempts,
                        claimStartedAtEpochMs: stage.claimStartedAtEpochMs,
                        batchIndex: stage.batchIndex,
                        publicationTopicId: stage.publicationKey?.topicId,
                        publicationResourceId: stage.publicationKey?.resourceId,
                        publicationContextId: stage.publicationKey?.contextId,
                        outcome: stage.outcome,
                        verdict: stage.verdict,
                        reason: stage.reason
                    }
                },
                status: stage.outcome === 'error' || stage.outcome === 'rejected' ? 'error' : 'ok',
                durationMs: 0
            });
        }
    };
}

/** Reservation groups can yield multiple markers; every other observation yields one. */
export function toALOutboundDequeueTimingEvents(
    observation: ALOutboundDequeuedAdmission.TimingObservation
): readonly ALOutboundDequeuedAdmission.TimingEvent[] {
    if (observation.kind === 'reservation-returns') {
        const events: ALOutboundDequeuedAdmission.TimingEvent[] = [];
        for (const claim of observation.claims) {
            if (observation.dequeueTypes.has(claim.entry.typeId)) {
                events.push(toClaimTimingEvent(claim, events.length, 'reservation-return'));
            }
        }
        return events;
    }
    if (observation.kind === 'attempt-settled') {
        const { settlement } = observation;
        return [{
            ...toClaimTimingEvent(settlement.claim, settlement.batchIndex, observation.kind),
            outcome: observation.outcome,
            verdict: settlement.observed.verdict,
            reason: settlement.observed.terminalReason
        }];
    }
    const { member } = observation;
    return [{
        ...toEntryTimingEvent({
            entry: member.effect.entry,
            attempts: member.effect.attempts,
            batchIndex: member.batchIndex,
            stage: observation.stage
        }),
        outcome: observation.outcome,
        publicationKey: observation.publicationKey
    }];
}

function toClaimTimingEvent(
    claim: ALWorkClaim,
    batchIndex: number,
    stage: ALOutboundDequeuedAdmission.TimingStage
): ALOutboundDequeuedAdmission.TimingEvent {
    return toEntryTimingEvent({ entry: claim.entry, attempts: claim.attempts, batchIndex, stage });
}

function toEntryTimingEvent(input: ToEntryTimingEventInput): ALOutboundDequeuedAdmission.TimingEvent {
    const { entry, attempts, batchIndex, stage } = input;
    return {
        stage,
        key: entry.key,
        attempts,
        claimStartedAtEpochMs: entry.dequeueAudit.startTs === undefined
            ? undefined
            : Number(entry.dequeueAudit.startTs.epochMilliseconds),
        batchIndex
    };
}
