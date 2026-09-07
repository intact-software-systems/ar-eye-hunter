import {
    resolveBrowserWsClientALInboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { createBrowserQueueBox } from '@shared-web/browser/queuebox/browser-queuebox-persistence.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ClientInfo } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';
import { Command } from '@shared/cache/Command.ts';
import type { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import WsQueueBoxClientService, {
    createDefaultWsQueueBoxClientService,
    DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS
} from '@shared/services/ws-queue-box-client-service.ts';
import type { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

export namespace CreateBrowserWebSocketQueueBox {
    export interface Input {
        readonly qboxEngine: InboxOutboxEngine;
        readonly socket: JsonWebSocketClient;
        readonly clientData: ClientInfo;
        readonly resilience: ResourceInboxResilience;
        readonly signal?: AbortSignal;
        readonly connectTimeoutMs?: number;
        readonly newConnectionRequestId?: () => string;
        readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
    }
}

export async function createBrowserWebSocketQueueBox(
    input: CreateBrowserWebSocketQueueBox.Input
): Promise<WsQueueBoxClientService> {
    const wsQueueBox = createBrowserWebSocketQueueBoxService(input);
    const taskInput: RegisterBrowserWebSocketQueueTaskInput = {
        qboxEngine: input.qboxEngine,
        wsQueueBox,
        resilience: input.resilience
    };
    registerBrowserWebSocketOutboxTask(taskInput);
    await connectInitialSocket(wsQueueBox.socket, input);
    wsQueueBox
        .enableReconnect()
        .enableDefaultCallbacks();

    return wsQueueBox;
}

function createBrowserWebSocketQueueBoxService(
    input: CreateBrowserWebSocketQueueBox.Input
): WsQueueBoxClientService {
    const { clientData, socket } = input;
    return createDefaultWsQueueBoxClientService({
        queueEngine: input.qboxEngine,
        outbox: createBrowserQueueBox(`ws-outbox-${clientData.sessionId}`),
        socket,
        sessionId: clientData.sessionId,
        inboundStores: resolveBrowserWsClientALInboundRuntimeStores(clientData.sessionId),
        outboundStores: resolveBrowserWsClientALOutboundRuntimeStores(clientData.sessionId),
        outboundDiagnostics: input.outboundDiagnostics,
        newConnectionRequestId: input.newConnectionRequestId,
        reconnect: {
            ...DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
            canReconnect: () => readSession()?.sessionId === clientData.sessionId
        }
    });
}

interface RegisterBrowserWebSocketQueueTaskInput {
    readonly qboxEngine: InboxOutboxEngine;
    readonly wsQueueBox: WsQueueBoxClientService;
    readonly resilience: ResourceInboxResilience;
}

function registerBrowserWebSocketOutboxTask(
    input: RegisterBrowserWebSocketQueueTaskInput
): void {
    input.qboxEngine.includeTask(
        WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE,
        {
            name: WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE,
            maxConcurrency: () => 1,
            isWork: () =>
                input.wsQueueBox
                    .outbox
                    .isAnyEntryToLock(
                        WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES,
                        input.resilience.toWorkAdvertisementOptions()
                    ),
            runnable: () =>
                input.wsQueueBox.dequeueOutbox(
                    WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES,
                    input.resilience
                ),
            ongoingTasks: []
        }
    );
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
