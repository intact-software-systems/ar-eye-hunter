import type { ControlRunSnapshot } from '../control-snapshots.ts';
import { toDistributedRunEventSummary, toDistributedRunPayloadTopic } from './distributed-run-payload-summary.ts';
import type { DistributedRunEventRow } from './distributed-run-row-contracts.ts';
import { toDistributedRunIdentitySummary } from './to-distributed-run-identity-summary.ts';

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
            identitySummary: toDistributedRunIdentitySummary(event.payload)
        }));
}

export function toDistributedRunEventsByAgent(
    events: readonly DistributedRunEventRow[]
): ReadonlyMap<string, readonly DistributedRunEventRow[]> {
    const eventsByAgentId = new Map<string, DistributedRunEventRow[]>();
    for (const event of events) {
        const agentEvents = eventsByAgentId.get(event.agentId) ?? [];
        if (!eventsByAgentId.has(event.agentId)) {
            eventsByAgentId.set(event.agentId, agentEvents);
        }
        agentEvents.push(event);
    }
    return eventsByAgentId;
}
