import type { ALMessage } from '../al-contracts/al-contract.ts';
import type { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
import type { NonRetryableException } from '../queuebox/DequeueResourceEntryController.ts';
import type { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import type { ResourceInboxAttemptTelemetry } from '../queuebox/ResourceInboxAttemptTelemetry.ts';
import type { JsonWebSocketClient } from '../websocket/json-web-socket-client.ts';
import type { JsonWebSocketServer } from '../websocket/json-web-socket-server.ts';

export interface OnOutboxWebSocketMessageCallback {
    onMessage: (entry: ResourceEntry, client: JsonWebSocketClient) => Promise<void>;
}

export interface OnWebSocketServerMessageCallback<T> {
    onMessage: (value: T, entry: ResourceEntry, context: WebSocketServerMessageContext) => Promise<void>;
}

export interface WebSocketServerMessageContext {
    readonly server: JsonWebSocketServer;
    readonly source: ALInboundMessageRuntime.Source;
}

export interface OnMessageCallback {
    onMessage: (message: ALMessage, entry: ResourceEntry) => Promise<void>;
}

export interface OnQueuedMessageCallback {
    onMessage: (
        message: ALMessage,
        entry: ResourceEntry,
        attemptTelemetry: ResourceInboxAttemptTelemetry
    ) => Promise<void>;
}

export interface OnRejectedQueuedMessageCallback {
    onRejectedMessage: (
        entry: ResourceEntry,
        attemptTelemetry: ResourceInboxAttemptTelemetry,
        error: NonRetryableException
    ) => Promise<ResourceEntry>;
}
