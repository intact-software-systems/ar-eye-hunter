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

    /** A unit of summary work and the trace of the queued message it came from. */
    export interface TracedWork {
        readonly work: GroupPresenceSummaryWorkData;
        readonly traceId: string;
    }

    export interface EventInput {
        readonly item: TracedWork;
        readonly operation: Phase;
        readonly serviceId: string;
        readonly details: RallarTimingDetails;
    }

    export interface CommittedOutputInput {
        readonly timing: RallarTimingSink;
        readonly serviceId: string;
        readonly expansions: readonly (TracedWork & Readonly<{ computed: GroupPresenceSummaryComputedWork; }>)[];
    }
}

export function toGroupPresenceSummaryTimingEvent(
    input: GroupPresenceSummaryTiming.EventInput
): RallarTimingEventInput {
    const { item: { work, traceId }, operation, serviceId, details } = input;
    return {
        component: 'group-presence-summary',
        operation,
        serviceId,
        requestId: work.commandId,
        traceId,
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
            try {
                recordRallarTiming({
                    sink: input.timing,
                    event: toGroupPresenceSummaryTimingEvent({
                        item: expansion,
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
            catch {
                // Timing detail failure after commit must not change the committed queue work.
            }
        }
    }
}
