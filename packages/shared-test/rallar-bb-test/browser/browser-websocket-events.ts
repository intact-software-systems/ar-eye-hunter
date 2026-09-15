import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

import { decodeAbortReason } from './browser-command-cancellation.ts';
import type {
    RallarBlackBoxBrowserWebSocket,
    RallarBlackBoxBrowserWebSocketEvent,
    RallarBlackBoxBrowserWebSocketListener
} from './browser-command-contracts.ts';

export type BrowserWebSocketEventType = 'open' | 'message' | 'close' | 'error';

export interface WaitForWebSocketOpenInput {
    readonly socket: RallarBlackBoxBrowserWebSocket;
    readonly timeoutMs: number;
    readonly signal: AbortSignal | undefined;
}

const WEBSOCKET_OPEN_STATE = 1;

/** A socket without `addEventListener` chains onto its `on*` slot and restores the previous handler on removal. */
export function addWebSocketListener(
    socket: RallarBlackBoxBrowserWebSocket,
    type: BrowserWebSocketEventType,
    listener: RallarBlackBoxBrowserWebSocketListener
): () => void {
    if (socket.addEventListener && socket.removeEventListener) {
        socket.addEventListener(type, listener);
        return () => socket.removeEventListener?.(type, listener);
    }

    const property = `on${type}` as const;
    const previous = socket[property];
    const next: RallarBlackBoxBrowserWebSocketListener = (event) => {
        previous?.(event);
        listener(event);
    };
    socket[property] = next;
    return () => {
        if (socket[property] === next) {
            socket[property] = previous;
        }
    };
}

/** Settles once: open, an error or close before open, the timeout, or the recipe's cancel. */
export function waitForWebSocketOpen(input: WaitForWebSocketOpenInput): Promise<void> {
    const { socket, timeoutMs, signal } = input;
    if (socket.readyState === WEBSOCKET_OPEN_STATE) {
        return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
        const settled = new AbortController();
        const settle = (error: Error | undefined): void => {
            if (settled.signal.aborted) {
                return;
            }
            settled.abort();
            if (error === undefined) {
                resolve();
            }
            else {
                reject(error);
            }
        };
        const timeout = setTimeout(() => settle(new Error(`WebSocket did not open within ${timeoutMs}ms.`)), timeoutMs);
        settled.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
        if (signal?.aborted) {
            settle(decodeAbortReason(signal.reason));
            return;
        }
        signal?.addEventListener('abort', () => settle(decodeAbortReason(signal.reason)), {
            once: true,
            signal: settled.signal
        });
        const disposers = [
            addWebSocketListener(socket, 'open', () => settle(undefined)),
            addWebSocketListener(socket, 'error', () => settle(new Error('WebSocket failed before open.'))),
            addWebSocketListener(socket, 'close', (event) => settle(toWebSocketClosedBeforeOpenError(event)))
        ];
        settled.signal.addEventListener('abort', () => {
            for (const dispose of disposers) {
                dispose();
            }
        }, { once: true });
    });
}

export function toWebSocketClosePayload(event: RallarBlackBoxBrowserWebSocketEvent): RallarBlackBoxTestRecord {
    return { code: event.code, reason: event.reason, wasClean: event.wasClean };
}

function toWebSocketClosedBeforeOpenError(event: RallarBlackBoxBrowserWebSocketEvent): Error {
    return new Error(`WebSocket closed before open. code=${String(event.code)}, reason=${String(event.reason)}`);
}
