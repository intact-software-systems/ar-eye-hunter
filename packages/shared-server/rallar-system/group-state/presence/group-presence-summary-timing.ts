import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';

import {
    recordRallarTiming,
    type RallarTimingDetails,
    type RallarTimingEventInput,
    type RallarTimingSink
} from '../../observability/timing.ts';
import type { GroupPresenceSummaryComputedWork } from './group-presence-summary-effects.ts';

export namespace GroupPresenceSummaryTiming {
    export type Phase = 'claim' | 'read' | 'compute' | 'write' | 'committed-output-observed';

    export interface EventInput {
        readonly work: GroupPresenceSummaryWorkData;
        readonly operation: Phase;
        readonly serviceId: string;
        readonly details: RallarTimingDetails;
    }

    export interface CommittedOutputInput {
        readonly timing: RallarTimingSink;
        readonly serviceId: string;
        readonly expansions: readonly Readonly<{
            work: GroupPresenceSummaryWorkData;
            computed: GroupPresenceSummaryComputedWork;
        }>[];
    }
}

export function toGroupPresenceSummaryTimingEvent(
    input: GroupPresenceSummaryTiming.EventInput
): RallarTimingEventInput {
    const { work, operation, serviceId, details } = input;
    return {
        component: 'group-presence-summary',
        operation,
        serviceId,
        requestId: work.commandId,
        applicationId: work.aggregateRef.applicationId,
        workspaceId: work.aggregateRef.workspaceId,
        groupId: work.aggregateRef.groupId,
        details
    };
}

/** Observes every output after the transaction returns; this clock is not the physical commit clock. */
export function recordGroupPresenceSummaryCommittedOutputs(
    input: GroupPresenceSummaryTiming.CommittedOutputInput
): void {
    for (const expansion of input.expansions) {
        for (const output of expansion.computed.downstreamOutboxWrites) {
            recordRallarTiming({
                sink: input.timing,
                event: toGroupPresenceSummaryTimingEvent({
                    work: expansion.work,
                    operation: 'committed-output-observed',
                    serviceId: input.serviceId,
                    details: {
                        outcome: 'written',
                        acceptedGroupRevision: expansion.work.acceptedCausalRevision.groupRevision,
                        acceptedPresenceRevision: expansion.work.acceptedCausalRevision.presenceRevision,
                        topicId: output.entry.key.topicId,
                        resourceId: output.entry.key.resourceId,
                        contextId: output.entry.key.contextId
                    }
                }),
                status: 'ok',
                durationMs: 0
            });
        }
    }
}
