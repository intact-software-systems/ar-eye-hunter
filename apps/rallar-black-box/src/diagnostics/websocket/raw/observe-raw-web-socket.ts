import type { RallarBlackBoxTestRuntimeEventInput } from '@shared-test/rallar-bb-test/types.ts';

import {
    completedActionFeedback,
    type CommandCenterActionFeedback
} from '../../../legacy/diagnostics/shared/action-feedback.ts';
import { normalizeWebSocketJsonValue, parseWebSocketJsonValue } from '../normalize-websocket-json-value.ts';
import type { WebSocketJsonValue } from '../websocket-contracts.ts';

export interface RawWebSocketEventRecord {
    readonly topic: string;
    readonly payload: WebSocketJsonValue;
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
    readonly recordEvent: (event: RawWebSocketEventRecord) => void;
    readonly setWaitStatus: (status: string) => void;
    readonly setActionFeedback: (feedback: CommandCenterActionFeedback) => void;
}

export function observeRawWebSocket(input: ObserveRawWebSocketInput): void {
    observeRawWebSocketOpen(input);
    observeRawWebSocketMessages(input);
    observeRawWebSocketErrors(input);
    observeRawWebSocketClose(input);
}

function observeRawWebSocketOpen(input: ObserveRawWebSocketInput): void {
    input.socket.addEventListener('open', () => {
        input.recordEvent({
            topic: 'rallar.direct.raw_ws.open.completed',
            payload: {
                connection: input.connection,
                url: input.url,
                readyState: input.socket.readyState
            },
            lastAction: 'Open WebSocket'
        });
        input.setWaitStatus('raw ws open');
        input.setActionFeedback(completedActionFeedback({
            label: input.label,
            startedAtEpochMs: input.startedAtEpochMs,
            target: input.url,
            ok: true,
            status: 'open',
            message: 'Raw WebSocket is open.'
        }));
    });
}

function observeRawWebSocketMessages(input: ObserveRawWebSocketInput): void {
    input.socket.addEventListener('message', (event) => {
        input.recordEvent({
            topic: 'rallar.direct.raw_ws.message',
            payload: {
                connection: input.connection,
                data: parseRawWebSocketMessage(event.data)
            },
            lastAction: 'Raw WebSocket message received',
            severity: 'info',
            kind: 'message'
        });
    });
}

function observeRawWebSocketErrors(input: ObserveRawWebSocketInput): void {
    input.socket.addEventListener('error', () => {
        input.recordEvent({
            topic: 'rallar.direct.raw_ws.error',
            payload: {
                connection: input.connection,
                url: input.url,
                readyState: input.socket.readyState
            },
            lastAction: 'Raw WebSocket error',
            severity: 'error'
        });
        input.setWaitStatus('raw ws error');
        input.setActionFeedback(completedActionFeedback({
            label: input.label,
            startedAtEpochMs: input.startedAtEpochMs,
            target: input.url,
            ok: false,
            statusText: 'error',
            message: 'Raw WebSocket emitted an error.'
        }));
    });
}

function observeRawWebSocketClose(input: ObserveRawWebSocketInput): void {
    input.socket.addEventListener('close', (event) => {
        input.recordEvent({
            topic: 'rallar.direct.raw_ws.close',
            payload: {
                connection: input.connection,
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean
            },
            lastAction: 'Raw WebSocket closed',
            severity: event.wasClean ? 'info' : 'warning'
        });
        input.setWaitStatus('raw ws closed');
    });
}

function parseRawWebSocketMessage(data: string | object): WebSocketJsonValue {
    if (typeof data !== 'string') {
        return normalizeWebSocketJsonValue(data);
    }
    const parsed = parseWebSocketJsonValue(data);
    return parsed.ok ? parsed.value : data;
}
