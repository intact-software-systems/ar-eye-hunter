import { readResourceInboxAttemptTelemetry } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

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
    nowEpochMs: number
): RallarTimingDetails {
    const telemetry = readResourceInboxAttemptTelemetry(entry);
    return {
        ...toAppInboxTimingDetails(enqueue, entry.key),
        attempt: telemetry?.attempt ?? entry.dequeueAudit.attempts,
        selectedLane: telemetry?.selectedLane,
        queueAgeMs: telemetry?.queueAgeMs ?? toQueueAgeMs(entry, nowEpochMs),
        dueAgeMs: telemetry?.dueAgeMs ?? toDueAgeMs(entry, nowEpochMs)
    };
}

function toQueueAgeMs(entry: ResourceEntry, nowEpochMs: number): number | undefined {
    try {
        return Math.max(
            0,
            nowEpochMs - entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds
        );
    }
    catch {
        return undefined;
    }
}

function toDueAgeMs(entry: ResourceEntry, nowEpochMs: number): number {
    const dueAtEpochMs = entry.dequeueAudit.nextTs
        ? Number(entry.dequeueAudit.nextTs.epochMilliseconds)
        : Number(entry.dequeueAudit.startTs?.epochMilliseconds ?? nowEpochMs);
    return Math.max(0, nowEpochMs - dueAtEpochMs);
}
