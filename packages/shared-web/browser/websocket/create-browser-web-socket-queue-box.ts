import {
    resolveBrowserWsClientALInboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ClientInfo } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';
import { Command } from '@shared/cache/Command.ts';
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
        readonly signal?: AbortSignal;
        readonly connectTimeoutMs?: number;
        readonly newConnectionRequestId?: () => string;
        readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
        readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
    }
}

export async function createBrowserWebSocketQueueBox(
    input: CreateBrowserWebSocketQueueBox.Input
): Promise<WsQueueBoxClientService> {
    const wsQueueBox = createBrowserWebSocketQueueBoxService(input);
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
    const outboundStores = resolveBrowserWsClientALOutboundRuntimeStores(clientData.sessionId);
    return createDefaultWsQueueBoxClientService({
        queueEngine: input.qboxEngine,
        outbox: outboundStores.workQueue,
        socket,
        sessionId: clientData.sessionId,
        inboundStores: resolveBrowserWsClientALInboundRuntimeStores(clientData.sessionId),
        outboundStores,
        outboundDiagnostics: input.outboundDiagnostics,
        outboundSettlements: undefined,
        inboundDiagnostics: input.inboundDiagnostics,
        newConnectionRequestId: input.newConnectionRequestId,
        reconnect: {
            ...DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
            canReconnect: () => readSession()?.sessionId === clientData.sessionId
        }
    });
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
