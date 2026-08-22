import type { RallarBlackBoxTestEvent, RallarBlackBoxTestEventKind } from '@shared-test/rallar-bb-test/types.ts';
import { recordValue as optionalRecord } from '../../shared/record-value.ts';
import { stringValue } from '../../shared/string-value.ts';
import { eventPayloadDetails } from './event-presentation.ts';

export type EventFilter = RallarBlackBoxTestEventKind | 'all';

export type EventFilters = Readonly<{
    kind: EventFilter;
    commandId: string;
    connection: string;
    actor: string;
    transport: string;
    group: string;
    peer: string;
    selector: string;
    topic: string;
    severity: string;
}>;

export const DEFAULT_EVENT_FILTERS: EventFilters = {
    kind: 'all',
    commandId: '',
    connection: '',
    actor: '',
    transport: '',
    group: '',
    peer: '',
    selector: '',
    topic: '',
    severity: ''
};

export const EVENT_KIND_FILTERS: readonly EventFilter[] = [
    'all',
    'diagnostic',
    'event',
    'message',
    'report',
    'result',
    'state',
    'stats'
];

export function eventFilterFromValue(value: string): EventFilter {
    return EVENT_KIND_FILTERS.includes(value as EventFilter)
        ? (value as EventFilter)
        : 'all';
}

export function eventMatchesFilters(
    event: RallarBlackBoxTestEvent,
    filters: EventFilters
): boolean {
    if (filters.kind !== 'all' && event.kind !== filters.kind) {
        return false;
    }
    if (filters.commandId && event.commandId !== filters.commandId) {
        return false;
    }
    if (filters.connection && event.connection !== filters.connection) {
        return false;
    }
    if (filters.actor && event.actor !== filters.actor) {
        return false;
    }
    if (filters.transport && event.transport !== filters.transport) {
        return false;
    }
    if (filters.severity && event.severity !== filters.severity) {
        return false;
    }
    if (filters.group && eventGroupValue(event) !== filters.group) {
        return false;
    }
    if (filters.peer && eventPeerValue(event) !== filters.peer) {
        return false;
    }
    if (filters.selector && eventSelectorValue(event) !== filters.selector) {
        return false;
    }
    if (
        filters.topic &&
        !event.topic.toLowerCase().includes(filters.topic.toLowerCase())
    ) {
        return false;
    }

    return true;
}

function firstStringValue(values: readonly unknown[]): string | undefined {
    return values.find(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
    );
}

export function eventGroupValue(
    event: RallarBlackBoxTestEvent
): string | undefined {
    const payload = eventPayloadDetails(event);
    return firstStringValue([
        payload.roomId,
        payload.groupId,
        optionalRecord(payload.roomRef).groupId
    ]);
}

export function eventPeerValue(
    event: RallarBlackBoxTestEvent
): string | undefined {
    const payload = eventPayloadDetails(event);
    return firstStringValue([
        payload.peerId,
        payload.remotePeerId,
        payload.senderId,
        payload.targetClient
    ]);
}

export function eventSelectorValue(
    event: RallarBlackBoxTestEvent
): string | undefined {
    const payload = eventPayloadDetails(event);
    const typeId = stringValue(payload.typeId);
    const topicId = stringValue(payload.topicId) ?? stringValue(payload.topic);
    if (!typeId && !topicId) {
        return undefined;
    }

    return `${topicId ?? '*'} / ${typeId ?? '-'}`;
}
