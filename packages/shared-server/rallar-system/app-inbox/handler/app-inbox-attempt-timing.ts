import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { ResourceInboxAttemptTelemetry } from '@shared/queuebox/ResourceInboxAttemptTelemetry.ts';

import type { RallarTimingDetails } from '../../observability/timing.ts';
import type { AppInboxEnqueueInput } from '../app-inbox-contracts.ts';

export function toAppInboxTimingDetails(
    enqueue: AppInboxEnqueueInput,
    key: Key
): RallarTimingDetails {
    return {
        type: enqueue.type,
        topicId: key.topicId,
        contextId: key.contextId,
        resourceId: key.resourceId,
        senderId: enqueue.senderId
    };
}

export function toAppInboxAttemptTimingDetails(
    enqueue: AppInboxEnqueueInput,
    entry: ResourceEntry,
    attemptTelemetry: ResourceInboxAttemptTelemetry
): RallarTimingDetails {
    return {
        ...toAppInboxTimingDetails(enqueue, entry.key),
        attempt: attemptTelemetry.attempt,
        selectedLane: attemptTelemetry.selectedLane,
        queueAgeMs: attemptTelemetry.queueAgeMs,
        dueAgeMs: attemptTelemetry.dueAgeMs
    };
}
