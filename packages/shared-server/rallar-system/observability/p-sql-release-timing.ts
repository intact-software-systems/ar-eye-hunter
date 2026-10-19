import type { PSqlQueueReleaseTiming } from '../../queuebox/postgres/p-sql-queue-release-timing.ts';
import { recordRallarTiming, type RallarTimingDetails, type RallarTimingSink } from './timing.ts';

export interface CreateRallarPSqlReleaseTimingInput {
    readonly timing: RallarTimingSink;
    readonly serviceId: string;
    readonly publisherId: string;
    readonly processId: number;
    readonly processStartedAtEpochMs: number;
    readonly transactionScope: 'root' | 'savepoint';
    readonly readMonotonicMs: () => number;
    readonly readEpochMs: () => number;
}

/** One identity-only aggregate after repository return; root commit interpretation requires verified composition. */
export function createRallarPSqlReleaseTiming(input: CreateRallarPSqlReleaseTimingInput): PSqlQueueReleaseTiming.Port {
    return {
        readMonotonicMs: input.readMonotonicMs,
        readEpochMs: input.readEpochMs,
        record: (observation) => recordReleaseTiming(input, observation)
    };
}

function recordReleaseTiming(
    input: CreateRallarPSqlReleaseTimingInput,
    observation: PSqlQueueReleaseTiming.Observation
): void {
    try {
        recordRallarTiming({
            sink: input.timing,
            event: {
                component: 'alm-outbound-dequeue',
                operation: 'postgres-release',
                serviceId: input.serviceId,
                details: {
                    publisherId: input.publisherId,
                    processId: input.processId,
                    processStartedAtEpochMs: input.processStartedAtEpochMs,
                    namespace: observation.namespace,
                    releaseSequence: observation.sequence,
                    outcome: observation.outcome,
                    availability: observation.availability,
                    transactionScope: input.transactionScope,
                    ...toReleaseTimingDetails(observation)
                }
            },
            status: observation.outcome === 'failed' ? 'error' : 'ok',
            durationMs: observation.availability === 'available' ? observation.phases.releaseOwnerElapsedMs : 0
        });
    }
    catch {
        // Projection and serialization are optional output, never part of release success.
    }
}

function toReleaseTimingDetails(observation: PSqlQueueReleaseTiming.Observation): RallarTimingDetails {
    if (observation.availability === 'unavailable') {
        return { reason: observation.reason };
    }
    return {
        memberCount: observation.memberCount,
        eligible: observation.eligible,
        truncated: observation.truncated,
        fallbackCount: observation.fallbackCount,
        anchorEpochMs: observation.anchorEpochMs,
        anchorMonotonicMs: observation.anchorMonotonicMs,
        anchorUncertaintyMs: observation.anchorUncertaintyMs,
        ...observation.boundaries,
        ...observation.phases,
        releaseMembersJson: JSON.stringify(observation.members)
    };
}
