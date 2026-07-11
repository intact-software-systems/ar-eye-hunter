import {
    selectRallarBlackBoxCommandHistory,
    selectRallarBlackBoxEvents,
} from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { recordValue as optionalRecord } from '../../shared/record-value.ts';
import type { WebSocketDiagnostic } from './websocket-contracts.ts';

export function deriveWebSocketDiagnostics(
    state: RallarBlackBoxTestState,
    connection: string,
): WebSocketDiagnostic {
    const history = selectRallarBlackBoxCommandHistory(state);
    const events = selectRallarBlackBoxEvents(state)
        .filter((event) => event.transport === 'ws')
        .filter(
            (event) =>
                !connection ||
                !event.connection ||
                event.connection === connection,
        );
    const recentEvents = events.slice(-16).map((event) => ({
        eventId: event.eventId,
        kind: event.kind,
        topic: event.topic,
        atEpochMs: event.atEpochMs,
        severity: event.severity ?? 'info',
        payload: event.payload,
    }));
    const receivedMessages = events
        .filter((event) => event.kind === 'message')
        .slice(-16)
        .map((event) => {
            const payload = optionalRecord(event.payload);
            const data = payload.data;
            const dataRecord = optionalRecord(data);
            const messagePayload =
                'payload' in dataRecord
                    ? dataRecord.payload
                    : (data ?? event.payload);
            return {
                eventId: event.eventId,
                atEpochMs: event.atEpochMs,
                senderId: String(
                    payload.senderId ?? dataRecord.senderId ?? '-',
                ),
                roomId: String(
                    payload.roomId ??
                        dataRecord.roomId ??
                        dataRecord.groupId ??
                        '-',
                ),
                typeId: String(payload.typeId ?? dataRecord.typeId ?? '-'),
                topicId: String(payload.topicId ?? dataRecord.topicId ?? '-'),
                contextId: String(
                    payload.contextId ?? dataRecord.contextId ?? '-',
                ),
                resourceId: String(
                    payload.resourceId ?? dataRecord.resourceId ?? '-',
                ),
                payload: messagePayload,
            };
        });
    const openEvents = events.filter(
        (event) =>
            event.topic.includes('ws.opened') ||
            event.topic.includes('ws.open_skipped'),
    );
    const closeEvents = events.filter((event) =>
        event.topic.includes('ws.closed'),
    );
    const errorEvents = events.filter(
        (event) =>
            event.severity === 'error' || event.topic.includes('ws.error'),
    );
    const lastOpen = openEvents.at(-1);
    const lastClose = closeEvents.at(-1);
    const lastError = errorEvents.at(-1);
    const openedAfterClose = Boolean(
        lastOpen && (!lastClose || lastOpen.atEpochMs >= lastClose.atEpochMs),
    );
    const closedAfterOpen = Boolean(
        lastClose && (!lastOpen || lastClose.atEpochMs >= lastOpen.atEpochMs),
    );
    const simulated = Boolean(lastOpen?.topic.includes('open_skipped'));
    const status =
        lastError && (!lastClose || lastError.atEpochMs >= lastClose.atEpochMs)
            ? 'error'
            : simulated
              ? 'simulated'
              : openedAfterClose
                ? 'open'
                : closedAfterOpen
                  ? 'closed'
                  : 'idle';
    const statusLabel = status === 'simulated' ? 'simulated' : status;
    const openPayload = optionalRecord(lastOpen?.payload);
    const closePayload = optionalRecord(lastClose?.payload);
    const failedWsResults = history.filter(
        (result) =>
            (result.kind === 'ws.open' ||
                result.kind === 'ws.send' ||
                result.kind === 'ws.close') &&
            !result.ok,
    );
    const outboundCount = history.filter(
        (result) =>
            result.kind === 'ws.send' &&
            (optionalRecord(result.value).connection === connection ||
                connection.length === 0),
    ).length;

    return {
        readyState: String(
            openPayload.readyState ?? (status === 'open' ? 'open' : status),
        ),
        status,
        statusLabel,
        lastOpenAtEpochMs: lastOpen?.atEpochMs,
        lastCloseAtEpochMs: lastClose?.atEpochMs,
        closeCode: closePayload.code,
        closeReason: closePayload.reason,
        inboundCount: events.filter((event) => event.kind === 'message').length,
        outboundCount,
        errorCount: errorEvents.length + failedWsResults.length,
        recentEvents,
        receivedMessages,
    };
}
