import type { RallarBlackBoxTestRuntimeEventInput } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { completedActionFeedback, type CommandCenterActionFeedback } from '../shared/action-feedback.ts';

export interface WebSocketRecordedEvent {
    readonly topic: string;
    readonly payload: RallarBlackBoxTestRuntimeEventInput['payload'];
    readonly lastAction: string;
    readonly severity?: RallarBlackBoxTestRuntimeEventInput['severity'];
    readonly kind?: RallarBlackBoxTestRuntimeEventInput['kind'];
}

export interface ObserveRawWebSocketInput {
    readonly socket: WebSocket;
    readonly connection: string;
    readonly url: string;
    readonly label: string;
    readonly startedAtEpochMs: number;
    recordEvent(event: WebSocketRecordedEvent): void;
    setWaitStatus(status: string): void;
    setActionFeedback(feedback: CommandCenterActionFeedback): void;
    readonly signal?: AbortSignal;
}

export function observeRawWebSocket(
    input: ObserveRawWebSocketInput
): void {
    input.socket.addEventListener('open', () => publishRawWebSocketOpen(input), { signal: input.signal });
    input.socket.addEventListener('message', (event) => publishRawWebSocketMessage(input, event), {
        signal: input.signal
    });
    input.socket.addEventListener('error', () => publishRawWebSocketError(input), { signal: input.signal });
    input.socket.addEventListener('close', (event) => publishRawWebSocketClose(input, event), { signal: input.signal });
}

type RawWebSocketMessage = null | boolean | number | string | object;

function parseRawWebSocketMessage(data: string | object): RawWebSocketMessage {
    if (typeof data !== 'string') {
        return data;
    }

    try {
        return JSON.parse(data);
    }
    catch {
        return data;
    }
}

function publishRawWebSocketOpen(input: ObserveRawWebSocketInput): void {
    input.recordEvent(
        {
            topic: 'rallar.direct.raw_ws.open.completed',
            payload: {
                connection: input.connection,
                url: input.url,
                readyState: input.socket.readyState
            },
            lastAction: 'Open WebSocket'
        }
    );
    input.setWaitStatus('raw ws open');
    input.setActionFeedback(
        completedActionFeedback({
            label: input.label,
            startedAtEpochMs: input.startedAtEpochMs,
            target: input.url,
            ok: true,
            status: 'open',
            message: 'Raw WebSocket is open.'
        })
    );
}

function publishRawWebSocketMessage(input: ObserveRawWebSocketInput, event: MessageEvent<string | object>): void {
    input.recordEvent(
        {
            topic: 'rallar.direct.raw_ws.message',
            payload: {
                connection: input.connection,
                data: parseRawWebSocketMessage(event.data)
            },
            lastAction: 'Raw WebSocket message received',
            severity: 'info',
            kind: 'message'
        }
    );
}

function publishRawWebSocketError(input: ObserveRawWebSocketInput): void {
    input.recordEvent(
        {
            topic: 'rallar.direct.raw_ws.error',
            payload: {
                connection: input.connection,
                url: input.url,
                readyState: input.socket.readyState
            },
            lastAction: 'Raw WebSocket error',
            severity: 'error'
        }
    );
    input.setWaitStatus('raw ws error');
    input.setActionFeedback(
        completedActionFeedback({
            label: input.label,
            startedAtEpochMs: input.startedAtEpochMs,
            target: input.url,
            ok: false,
            statusText: 'error',
            message: 'Raw WebSocket emitted an error.'
        })
    );
}

function publishRawWebSocketClose(input: ObserveRawWebSocketInput, event: CloseEvent): void {
    input.recordEvent(
        {
            topic: 'rallar.direct.raw_ws.close',
            payload: {
                connection: input.connection,
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean
            },
            lastAction: 'Raw WebSocket closed',
            severity: event.wasClean ? 'info' : 'warning'
        }
    );
    input.setWaitStatus('raw ws closed');
}
