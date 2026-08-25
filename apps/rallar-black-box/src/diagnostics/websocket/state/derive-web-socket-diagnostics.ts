import {
    selectRallarBlackBoxCommandHistory,
    selectRallarBlackBoxEvents
} from '@shared-test/rallar-bb-test/selectors.ts';
import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/types.ts';

import { recordValue as optionalRecord } from '../../../legacy/shared/record-value.ts';
import { normalizeWebSocketJsonValue } from '../normalize-websocket-json-value.ts';
import type { WebSocketCloseInfo, WebSocketDiagnostic, WebSocketReceivedMessageRow } from '../websocket-contracts.ts';

interface WebSocketLifecycleDiagnostic extends WebSocketCloseInfo {
    readonly readyState: string;
    readonly status: WebSocketDiagnostic['status'];
    readonly statusLabel: string;
    readonly lastOpenAtEpochMs?: number;
    readonly lastCloseAtEpochMs?: number;
    readonly errorCount: number;
}

export function deriveWebSocketDiagnostics(
    state: RallarBlackBoxTestState,
    connection: string
): WebSocketDiagnostic {
    const history = selectRallarBlackBoxCommandHistory(state);
    const events = readWebSocketEvents(state, connection);
    const lifecycle = computeWebSocketLifecycleDiagnostic(events);

    return {
        ...lifecycle,
        inboundCount: events.filter((event) => event.kind === 'message').length,
        outboundCount: countWebSocketSends(history, connection),
        errorCount: lifecycle.errorCount + countFailedWebSocketCommands(history),
        recentEvents: events.slice(-16).map((event) => ({
            eventId: event.eventId,
            kind: event.kind,
            topic: event.topic,
            atEpochMs: event.atEpochMs,
            severity: event.severity ?? 'info',
            payload: normalizeWebSocketJsonValue(event.payload)
        })),
        receivedMessages: events
            .filter((event) => event.kind === 'message')
            .slice(-16)
            .map(toWebSocketReceivedMessageRow)
    };
}

function readWebSocketEvents(
    state: RallarBlackBoxTestState,
    connection: string
): readonly RallarBlackBoxTestEvent[] {
    return selectRallarBlackBoxEvents(state)
        .filter((event) => event.transport === 'ws')
        .filter((event) => !connection || !event.connection || event.connection === connection);
}

function toWebSocketReceivedMessageRow(event: RallarBlackBoxTestEvent): WebSocketReceivedMessageRow {
    const eventPayload = optionalRecord(event.payload);
    const messageData = eventPayload.data;
    const messageRecord = optionalRecord(messageData);
    const messagePayload = 'payload' in messageRecord
        ? messageRecord.payload
        : (messageData ?? event.payload);

    return {
        eventId: event.eventId,
        atEpochMs: event.atEpochMs,
        senderId: String(eventPayload.senderId ?? messageRecord.senderId ?? '-'),
        roomId: String(eventPayload.roomId ?? messageRecord.roomId ?? messageRecord.groupId ?? '-'),
        typeId: String(eventPayload.typeId ?? messageRecord.typeId ?? '-'),
        topicId: String(eventPayload.topicId ?? messageRecord.topicId ?? '-'),
        contextId: String(eventPayload.contextId ?? messageRecord.contextId ?? '-'),
        resourceId: String(eventPayload.resourceId ?? messageRecord.resourceId ?? '-'),
        payload: normalizeWebSocketJsonValue(messagePayload)
    };
}

function computeWebSocketLifecycleDiagnostic(
    events: readonly RallarBlackBoxTestEvent[]
): WebSocketLifecycleDiagnostic {
    const openEvent = events.filter(isWebSocketOpenEvent).at(-1);
    const closeEvent = events.filter((event) => event.topic.includes('ws.closed')).at(-1);
    const errorEvents = events.filter(isWebSocketErrorEvent);
    const errorEvent = errorEvents.at(-1);
    const status = computeWebSocketStatus({ openEvent, closeEvent, errorEvent });
    const openPayload = optionalRecord(openEvent?.payload);
    const closeInfo = toWebSocketCloseInfo(closeEvent);

    return {
        readyState: String(openPayload.readyState ?? (status === 'open' ? 'open' : status)),
        status,
        statusLabel: status,
        lastOpenAtEpochMs: openEvent?.atEpochMs,
        lastCloseAtEpochMs: closeEvent?.atEpochMs,
        ...closeInfo,
        errorCount: errorEvents.length
    };
}

function toWebSocketCloseInfo(closeEvent: RallarBlackBoxTestEvent | undefined): WebSocketCloseInfo {
    const closePayload = optionalRecord(closeEvent?.payload);
    const closeCode = typeof closePayload.code === 'number' && Number.isFinite(closePayload.code)
        ? closePayload.code
        : undefined;
    const closeReason = typeof closePayload.reason === 'string'
        ? closePayload.reason
        : undefined;
    return { closeCode, closeReason };
}

interface ComputeWebSocketStatusInput {
    readonly openEvent: RallarBlackBoxTestEvent | undefined;
    readonly closeEvent: RallarBlackBoxTestEvent | undefined;
    readonly errorEvent: RallarBlackBoxTestEvent | undefined;
}

function computeWebSocketStatus(input: ComputeWebSocketStatusInput): WebSocketDiagnostic['status'] {
    if (input.errorEvent && (!input.closeEvent || input.errorEvent.atEpochMs >= input.closeEvent.atEpochMs)) {
        return 'error';
    }
    if (input.openEvent?.topic.includes('open_skipped')) {
        return 'simulated';
    }
    if (input.openEvent && (!input.closeEvent || input.openEvent.atEpochMs >= input.closeEvent.atEpochMs)) {
        return 'open';
    }
    return input.closeEvent ? 'closed' : 'idle';
}

function isWebSocketOpenEvent(event: RallarBlackBoxTestEvent): boolean {
    return event.topic.includes('ws.opened') || event.topic.includes('ws.open_skipped');
}

function isWebSocketErrorEvent(event: RallarBlackBoxTestEvent): boolean {
    return event.severity === 'error' || event.topic.includes('ws.error');
}

function countFailedWebSocketCommands(history: readonly RallarBlackBoxTestResult[]): number {
    return history.filter((result) =>
        (result.kind === 'ws.open' || result.kind === 'ws.send' || result.kind === 'ws.close') && !result.ok
    ).length;
}

function countWebSocketSends(
    history: readonly RallarBlackBoxTestResult[],
    connection: string
): number {
    return history.filter((result) =>
        result.kind === 'ws.send' &&
        (optionalRecord(result.value).connection === connection || connection.length === 0)
    ).length;
}
