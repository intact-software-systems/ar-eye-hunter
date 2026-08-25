import {
    resolveBrowserWsClientALInboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { createBrowserQueueBox } from '@shared-web/browser/queuebox/browser-queuebox-persistence.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { ClientInfo } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';
import { Command } from '@shared/cache/Command.ts';
import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import WsQueueBoxClientService, {
    DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS
} from '@shared/services/WsQueueBoxClientService.ts';
import type { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';

export namespace CreateBrowserWebSocketQueueBox {
    export interface Input {
        readonly qboxEngine: InboxOutboxEngine;
        readonly socket: JsonWebSocketClient;
        readonly clientData: ClientInfo;
        readonly resilience: ResilienceDto;
        readonly signal?: AbortSignal;
        readonly connectTimeoutMs?: number;
        readonly newConnectionRequestId?: () => string;
        readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
    }
}

export async function createBrowserWebSocketQueueBox(
    input: CreateBrowserWebSocketQueueBox.Input
): Promise<WsQueueBoxClientService> {
    const { clientData, qboxEngine, resilience, socket } = input;
    const wsQueueBox = new WsQueueBoxClientService(
        createBrowserQueueBox(`ws-inbox-${clientData.sessionId}`),
        createBrowserQueueBox(`ws-outbox-${clientData.sessionId}`),
        socket,
        {
            sessionId: clientData.sessionId
        },
        {
            inboundStores: resolveBrowserWsClientALInboundRuntimeStores(clientData.sessionId),
            outboundStores: resolveBrowserWsClientALOutboundRuntimeStores(clientData.sessionId),
            outboundDiagnostics: input.outboundDiagnostics,
            newConnectionRequestId: input.newConnectionRequestId,
            reconnect: {
                ...DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
                canReconnect: () => readSession()?.sessionId === clientData.sessionId
            }
        }
    );

    qboxEngine.includeTask(
        WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE,
        {
            name: WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE,
            maxConcurrency: () => 1,
            isWork: () =>
                wsQueueBox
                    .outbox
                    .isAnyEntryToLock(
                        WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES,
                        resilience.toWorkAdvertisementOptions()
                    ),
            runnable: () => wsQueueBox.dequeueOutbox(WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES, resilience),
            ongoingTasks: []
        }
    );

    qboxEngine.includeTask(
        WsQueueBoxClientService.INBOX_ENQUEUE_TYPE,
        {
            name: WsQueueBoxClientService.INBOX_ENQUEUE_TYPE,
            maxConcurrency: () => 1,
            isWork: () =>
                wsQueueBox
                    .inbox
                    .isAnyEntryToLock(
                        WsQueueBoxClientService.INBOX_DEQUEUE_TYPES,
                        resilience.toWorkAdvertisementOptions()
                    ),
            runnable: () => wsQueueBox.dequeueInbox(WsQueueBoxClientService.INBOX_DEQUEUE_TYPES, resilience),
            ongoingTasks: []
        }
    );

    await connectInitialSocket(wsQueueBox.socket, input);
    wsQueueBox
        .enableReconnect()
        .enableDefaultCallbacks();

    return wsQueueBox;
}

async function connectInitialSocket(
    socket: JsonWebSocketClient,
    input: CreateBrowserWebSocketQueueBox.Input
): Promise<void> {
    const requestId = input.newConnectionRequestId?.();
    const connectTimeoutMs = input.connectTimeoutMs ??
        DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS.connectTimeoutMsecs;
    if (connectTimeoutMs <= 0) {
        await socket.connect({
            requestId,
            signal: input.signal
        });
        return;
    }

    await new Command<void>(
        (signal) =>
            socket.connect({
                requestId,
                signal
            }),
        {
            signal: input.signal,
            timeoutMs: connectTimeoutMs,
            errorOnNull: false
        }
    ).run();
}
