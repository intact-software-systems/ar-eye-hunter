import { ClientInfo } from '@shared/api/api-config.ts';
import { Command } from '@shared/cache/Command.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import WsQueueBoxClientService, {
    DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
} from '@shared/services/WsQueueBoxClientService.ts';
import { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { createBrowserQueueBox } from '@shared-web/browser/browser-queuebox.ts';
import {
    resolveBrowserWsClientALInboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores,
} from '@shared-web/browser/browser-al-runtime-stores.ts';
import { readSession } from '@shared/api/auth.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/ALOutboundMessageRuntime.ts';

export type WsEngineInitOptions = Readonly<{
    signal?: AbortSignal;
    connectTimeoutMs?: number;
    outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
}>;

export async function initialiseWsEngine(
    qboxEngine: InboxOutboxEngine,
    socket: JsonWebSocketClient,
    clientData: ClientInfo,
    resilience: ResilienceDto,
    options: WsEngineInitOptions = {},
) {
    const wsQueueBox =
        new WsQueueBoxClientService(
            createBrowserQueueBox(`ws-inbox-${clientData.sessionId}`),
            createBrowserQueueBox(`ws-outbox-${clientData.sessionId}`),
            socket,
            {
                sessionId: clientData.sessionId,
            },
            {
                inboundStores: resolveBrowserWsClientALInboundRuntimeStores(clientData.sessionId),
                outboundStores: resolveBrowserWsClientALOutboundRuntimeStores(clientData.sessionId),
                outboundDiagnostics: options.outboundDiagnostics,
                reconnect: {
                    ...DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
                    canReconnect: () =>
                        readSession()?.sessionId === clientData.sessionId,
                },
            },
        );

    qboxEngine.includeTask(
        WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE,
        {
            name: WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE,
            maxConcurrency: () => 1,
            isWork:
                () =>
                    wsQueueBox
                        .outbox
                        .isAnyEntryToLock(
                            WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES,
                            resilience.toWorkAdvertisementOptions(),
                        ),
            runnable:
                () => wsQueueBox.dequeueOutbox(WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES, resilience),
            ongoingTasks: [],
        }
    );

    qboxEngine.includeTask(
        WsQueueBoxClientService.INBOX_ENQUEUE_TYPE,
        {
            name: WsQueueBoxClientService.INBOX_ENQUEUE_TYPE,
            maxConcurrency: () => 1,
            isWork:
                () =>
                    wsQueueBox
                        .inbox
                        .isAnyEntryToLock(
                            WsQueueBoxClientService.INBOX_DEQUEUE_TYPES,
                            resilience.toWorkAdvertisementOptions(),
                        ),
            runnable:
                () => wsQueueBox.dequeueInbox(WsQueueBoxClientService.INBOX_DEQUEUE_TYPES, resilience),
            ongoingTasks: [],
        }
    );

    await connectInitialSocket(wsQueueBox.socket, options);
    wsQueueBox
        .enableReconnect()
        .enableDefaultCallbacks();

    return wsQueueBox;
}

async function connectInitialSocket(
    socket: JsonWebSocketClient,
    options: WsEngineInitOptions,
): Promise<void> {
    const connectTimeoutMs = options.connectTimeoutMs ??
        DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS.connectTimeoutMsecs;
    if (connectTimeoutMs <= 0) {
        await socket.connect({
            signal: options.signal,
        });
        return;
    }

    await new Command<void>(
        (signal) =>
            socket.connect({
                signal,
            }),
        {
            signal: options.signal,
            timeoutMs: connectTimeoutMs,
            errorOnNull: false,
        },
    ).run();
}
