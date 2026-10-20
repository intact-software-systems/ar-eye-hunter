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
        if (observation.kind === 'admission-group') {
            recordAdmissionGroupTiming(input, observation);
        }
        else if (observation.kind === 'work-batch') {
            recordWorkBatchTiming(input, observation);
        }
        else {
            for (const stage of toALOutboundDequeueTimingEvents(observation)) {
                recordDequeueStageTiming(input, stage);
            }
        }
    };
}

function recordAdmissionGroupTiming(
    input: CreateRallarALOutboundDequeueTimingInput,
    observation: Extract<ALOutboundDequeuedAdmission.TimingObservation, { kind: 'admission-group'; }>
): void {
    recordRallarTiming({
        sink: input.timing,
        event: {
            component: 'alm-outbound-dequeue',
            operation: 'admission-group',
            serviceId: input.serviceId,
            details: {
                publisherId: input.publisherId,
                lane: observation.lane,
                ...observation.entry.key,
                attempts: observation.entry.dequeueAudit.attempts,
                claimStartedAtEpochMs: observation.entry.dequeueAudit.startTs?.epochMilliseconds,
                memberCount: observation.memberCount,
                startedAtMs: observation.startedAtMs,
                decisionDurationMs: observation.decisionDurationMs,
                bundleDurationMs: observation.bundleDurationMs,
                outcome: observation.outcome
            }
        },
        status: observation.outcome === 'error' ? 'error' : 'ok',
        durationMs: observation.decisionDurationMs + observation.bundleDurationMs
    });
}

function recordWorkBatchTiming(
    input: CreateRallarALOutboundDequeueTimingInput,
    observation: Extract<ALOutboundDequeuedAdmission.TimingObservation, { kind: 'work-batch'; }>
): void {
    const { batch } = observation;
    recordRallarTiming({
        sink: input.timing,
        event: {
            component: 'alm-outbound-dequeue',
            operation: 'work-batch',
            serviceId: input.serviceId,
            details: {
                publisherId: input.publisherId,
                lane: observation.lane,
                workerId: batch.workerId,
                batchStartedAtMs: batch.batchStartedAtMs,
                runStartedAtMs: batch.startedAtMs,
                selectionDurationMs: batch.selectionDurationMs,
                claimDurationMs: batch.claimDurationMs,
                runDurationMs: batch.runDurationMs,
                releaseDurationMs: batch.releaseDurationMs,
                queueWaitMs: batch.queueWaitMs,
                claimedCount: batch.claimedCount,
                completedCount: batch.completedCount,
                rescheduledCount: batch.rescheduledCount,
                rejectedCount: batch.rejectedCount
            }
        },
        status: batch.rejectedCount > 0 ? 'error' : 'ok',
        durationMs: batch.durationMs
    });
}

function recordDequeueStageTiming(
    input: CreateRallarALOutboundDequeueTimingInput,
    stage: ALOutboundDequeuedAdmission.TimingEvent
): void {
    recordRallarTiming({
        sink: input.timing,
        event: {
            component: 'alm-outbound-dequeue',
            operation: stage.stage,
            serviceId: input.serviceId,
            details: {
                publisherId: input.publisherId,
                lane: stage.lane,
                workerId: stage.workerId,
                batchStartedAtMs: stage.batchStartedAtMs,
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

/** Per-attempt markers only; work batches and grouped operations have their own aggregate translation. */
export function toALOutboundDequeueTimingEvents(
    observation: ALOutboundDequeuedAdmission.TimingObservation
): readonly ALOutboundDequeuedAdmission.TimingEvent[] {
    if (observation.kind === 'work-batch' || observation.kind === 'admission-group') {
        return [];
    }
    if (observation.kind === 'reservation-returns') {
        const events: ALOutboundDequeuedAdmission.TimingEvent[] = [];
        for (const claim of observation.claims) {
            if (observation.dequeueTypes.has(claim.entry.typeId)) {
                events.push({
                    ...toClaimTimingEvent(claim, events.length, 'reservation-return'),
                    lane: observation.lane,
                    workerId: observation.workerId,
                    batchStartedAtMs: observation.batchStartedAtMs
                });
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
