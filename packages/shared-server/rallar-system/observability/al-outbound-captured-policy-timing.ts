import { ALOutboundCapturedPolicyTiming } from '@shared/alm/outbound/admission/al-outbound-captured-policy-timing.ts';

import { recordRallarTiming, type RallarTimingSink } from './timing.ts';

export interface CreateRallarALOutboundCapturedPolicyTimingInput {
    readonly timing: RallarTimingSink;
    readonly serviceId: string;
    readonly publisherId: string;
    readonly processId: number;
    readonly processStartedAtEpochMs: number;
    readonly readMonotonicMs: () => number;
    readonly readEpochMs: () => number;
}

/** Translates one owner-local policy read into process-scoped timing evidence. */
export function createRallarALOutboundCapturedPolicyTiming(
    input: CreateRallarALOutboundCapturedPolicyTimingInput
): ALOutboundCapturedPolicyTiming.Capability {
    return {
        createOwner: (namespace) =>
            new ALOutboundCapturedPolicyTiming(namespace, {
                readMonotonicMs: input.readMonotonicMs,
                readEpochMs: input.readEpochMs,
                record: (observation) => recordCapturedPolicyTiming(input, observation)
            })
    };
}

function recordCapturedPolicyTiming(
    input: CreateRallarALOutboundCapturedPolicyTimingInput,
    observation: ALOutboundCapturedPolicyTiming.Observation
): void {
    try {
        const details = {
            publisherId: input.publisherId,
            processId: input.processId,
            processStartedAtEpochMs: input.processStartedAtEpochMs,
            namespace: observation.namespace,
            policyReadSequence: observation.sequence,
            topicId: observation.key?.topicId ?? 'unavailable',
            resourceId: observation.key?.resourceId ?? 'unavailable',
            contextId: observation.key?.contextId ?? 'unavailable',
            msgId: observation.msgId ?? 'unavailable',
            rowId: observation.rowId ?? 'unavailable',
            reservationAttempt: observation.reservationAttempt ?? 'unavailable',
            reservationStartedAtEpochMs: observation.reservationStartedAtEpochMs ?? 'unavailable',
            outcome: observation.outcome,
            availability: observation.availability,
            anchorEpochMs: observation.anchorEpochMs ?? 'unavailable',
            anchorMonotonicMs: observation.anchorMonotonicMs ?? 'unavailable',
            anchorUncertaintyMs: observation.anchorUncertaintyMs ?? 'unavailable',
            ...(observation.availability === 'available'
                ? {
                    ...observation.phases
                }
                : { reason: observation.reason })
        };
        recordRallarTiming({
            sink: input.timing,
            event: {
                component: 'alm-outbound-dequeue',
                operation: 'outbox-captured-policy-phases',
                serviceId: input.serviceId,
                details
            },
            status: observation.outcome === 'failed' ? 'error' : 'ok',
            durationMs: observation.availability === 'available' ? observation.phases.ownerElapsedMs : 0
        });
    }
    catch {
        // Projection and logging are optional evidence, never policy authority.
    }
}
