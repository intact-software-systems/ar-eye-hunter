import type { ControlRunSnapshot } from '../control-snapshots.ts';
import type { DistributedRunMonitorIndex } from '../distributed-run-monitor-index.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import {
    decodeFirstNonBlankText,
    toDistributedRunEventSummary,
    toDistributedRunPayloadSummary,
    toDistributedRunPayloadTopic
} from './distributed-run-payload-summary.ts';
import type { DistributedRunEventRow } from './distributed-run-row-contracts.ts';

type ControlEventSnapshot = ControlRunSnapshot['events'][number];

export function toDistributedRunEventRows(
    events: readonly ControlEventSnapshot[]
): readonly DistributedRunEventRow[] {
    return [...events]
        .sort((left, right) => left.atEpochMs - right.atEpochMs)
        .map((event, index) => ({
            eventId: event.eventId ?? `${event.agentId}-${event.commandId ?? 'event'}-${index}`,
            atEpochMs: event.atEpochMs,
            kind: event.kind,
            agentId: event.agentId,
            commandId: event.commandId,
            topic: toDistributedRunPayloadTopic(event.payload),
            summary: toDistributedRunEventSummary(event),
            payloadSummary: toDistributedRunEventPayloadSummary(event.payload)
        }));
}

export function toDistributedRunEventsByAgent(
    events: readonly DistributedRunEventRow[],
    index: DistributedRunMonitorIndex
): ReadonlyMap<string, readonly DistributedRunEventRow[]> {
    const eventsByAgentId = new Map<string, DistributedRunEventRow[]>();
    events.forEach((event) => {
        index.work.linkedEventAgentIndexVisitCount += 1;
        const agentEvents = eventsByAgentId.get(event.agentId) ?? [];
        if (!eventsByAgentId.has(event.agentId)) {
            eventsByAgentId.set(event.agentId, agentEvents);
        }
        agentEvents.push(event);
    });
    return eventsByAgentId;
}

function toDistributedRunEventPayloadSummary(payload: unknown): string {
    const event = decodeRecord(payload);
    const nestedPayload = decodeRecord(event.payload);
    const nestedData = decodeRecord(nestedPayload.data ?? event.data);
    const fields = [
        ['kind', decodeFirstNonBlankText(event.kind)],
        [
            'topic',
            decodeFirstNonBlankText(
                event.topic,
                nestedPayload.topic,
                nestedData.topic,
                toDistributedRunPayloadTopic(payload)
            )
        ],
        ['transport', decodeFirstNonBlankText(event.transport, nestedPayload.transport)],
        ['messageId', decodeFirstNonBlankText(event.messageId, nestedPayload.messageId, nestedData.messageId)],
        [
            'distributedRunId',
            decodeFirstNonBlankText(event.distributedRunId, nestedPayload.distributedRunId, nestedData.distributedRunId)
        ],
        ['groupId', decodeFirstNonBlankText(event.groupId, nestedPayload.groupId, nestedData.groupId)],
        ['roomId', decodeFirstNonBlankText(event.roomId, nestedPayload.roomId, nestedData.roomId)],
        ['typeId', decodeFirstNonBlankText(event.typeId, nestedPayload.typeId, nestedData.typeId)],
        ['topicId', decodeFirstNonBlankText(event.topicId, nestedPayload.topicId, nestedData.topicId)],
        ['contextId', decodeFirstNonBlankText(event.contextId, nestedPayload.contextId, nestedData.contextId)],
        ['resourceId', decodeFirstNonBlankText(event.resourceId, nestedPayload.resourceId, nestedData.resourceId)],
        ['status', decodeFirstNonBlankText(event.status, nestedPayload.status, nestedData.status)]
    ] as const;
    return fields
        .filter((entry) => Boolean(entry[1]))
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
}
