import { toBrowserWsClientALRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    createBrowserALVolatileOutboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import type { ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALInboundRuntimeStores,
    ALVolatileInboundRuntimeStores
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundResyncRequired } from '@shared/alm/inbound/al-inbound-resync-required.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import type {
    ALCheckpointOutboundRuntimeStores,
    ALOutboundRuntimeDiagnosticsSink
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
import type { ClientInfo } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';
import { Command } from '@shared/cache/Command.ts';
import { findGroupStateSnapshotByRef } from '@shared/repository/group-state-snapshots-repository.ts';
import type { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import WsQueueBoxClientService, {
    createDefaultWsQueueBoxClientService,
    DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS
} from '@shared/services/ws-queue-box-client-service.ts';
import type { WebSocketSubmissionReadinessFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import type { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import {
    computeBrowserWsRoomSubmissionIneligibility,
    requiresBrowserWsRoomPresence
} from './compute-browser-ws-room-submission-ineligibility.ts';

export namespace CreateBrowserWebSocketQueueBox {
    export interface Input {
        readonly qosProvider: ALQosInputProvider | undefined;
        readonly submissionReadinessFaultPort: WebSocketSubmissionReadinessFaultPort;
        readonly outboundSettlements: ALDeliverySettlementSink;
        readonly qboxEngine: InboxOutboxEngine;
        readonly socket: JsonWebSocketClient;
        readonly clientData: ClientInfo;
        /** The WS server's peer id from `/api/config`; undefined when the server names none. */
        readonly serverPeerId: string | undefined;
        readonly inboundStores: ALInboundRuntimeStores;
        /** The session's inbound memory pair, the same one the RTC receiver holds. */
        readonly inboundVolatileStores: ALVolatileInboundRuntimeStores;
        readonly volatileBudget: ALVolatileSessionBudget;
        /** The connect's checkpoint pair of the WS client, which its `local-checkpoint` admissions go to. */
        readonly checkpointStores: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
        /** The connect's claim on its session's durable work, which only the durable lanes take. */
        readonly durableWorkOwnership: ALDurableWorkOwnership;
        readonly signal?: AbortSignal;
        readonly connectTimeoutMs: number;
        readonly newConnectionRequestId: (() => string) | undefined;
        readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
        readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
        /** Absent, no recovery owner is told of a track this client can no longer order: a transport built without the messaging composition. */
        readonly onResyncRequired?: (resync: ALInboundResyncRequired) => void;
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
        readSubmissionIneligibility: (message) => {
            if (!requiresBrowserWsRoomPresence(message)) {
                return undefined;
            }
            const ref = readALTargetGroupRef(message);
            return computeBrowserWsRoomSubmissionIneligibility({
                message,
                client: clientData,
                currentSession: readSession(),
                snapshot: ref ? findGroupStateSnapshotByRef(ref) : undefined,
                nowMs: Date.now()
            });
        },
        qosProvider: input.qosProvider,
        queueEngine: input.qboxEngine,
        submissionReadinessFaultPort: input.submissionReadinessFaultPort,
        outbox: outboundStores.workQueue,
        socket,
        sessionId: clientData.sessionId,
        serverPeerId: input.serverPeerId,
        inboundStores: input.inboundStores,
        inboundVolatileStores: input.inboundVolatileStores,
        outboundStores,
        outboundVolatileStores: createBrowserALVolatileOutboundRuntimeStores(
            toBrowserWsClientALRuntimeStoreId(clientData.sessionId),
            input.volatileBudget
        ),
        outboundCheckpointStores: input.checkpointStores,
        outboundDiagnostics: input.outboundDiagnostics,
        outboundSettlements: input.outboundSettlements,
        inboundDiagnostics: input.inboundDiagnostics,
        onResyncRequired: input.onResyncRequired,
        durableWorkOwnership: input.durableWorkOwnership,
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
    const connectTimeoutMs = input.connectTimeoutMs;
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
