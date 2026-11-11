import { onTestFinished, vi } from 'vitest';

import { resolveBrowserALCheckpointStores } from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
import { toBrowserSessionALInboundRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    configureBrowserALRuntimeStores,
    createBrowserALVolatileInboundRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { createPassThroughALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import type WsQueueBoxClientService from '@shared/services/ws-queue-box-client-service.ts';
import type { ScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { captureOutboundWorkRunnable } from '../../shared/alm/outbound-runtime-test-fixture.ts';
import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createDefaultVolatileSessionBudget } from '../default-volatile-session-budget.ts';

export interface OpenRecoveryOwnerInput {
    readonly sessionId: string;
    readonly principalId: string;
    readonly faults: ScriptedTransportFaultPort;
    readonly beforeOpenDelayMs: number;
}

export interface RecoveryOwner {
    readonly engine: InboxOutboxEngine;
    readonly native: TestWebSocket;
    readonly service: WsQueueBoxClientService;
    readonly settlements: readonly ALDeliverySettlement[];
    drain(): Promise<void>;
}

/** A real browser WS owner over the session's IndexedDB stores; the caller stubs `WebSocket` with `TestWebSocket`. */
export async function openRecoveryOwner({
    sessionId,
    principalId,
    faults,
    beforeOpenDelayMs
}: OpenRecoveryOwnerInput): Promise<RecoveryOwner> {
    configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
    const engine = new InboxOutboxEngine();
    const drain = captureOutboundWorkRunnable(engine);
    const settlements: ALDeliverySettlement[] = [];
    const connecting = createBrowserWebSocketQueueBox({
        durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
        qosProvider: {},
        submissionReadinessFaultPort: faults,
        outboundSettlements: (event) => settlements.push(event),
        newConnectionRequestId: undefined,
        qboxEngine: engine,
        socket: new JsonWebSocketClient('ws://test', faults),
        clientData: { clientId: principalId, sessionId, isOnline: true },
        serverPeerId: 'server',
        inboundStores: resolveBrowserSessionALInboundRuntimeStores(sessionId),
        inboundVolatileStores: createBrowserALVolatileInboundRuntimeStores(
            toBrowserSessionALInboundRuntimeStoreId(sessionId),
            createDefaultVolatileSessionBudget(),
            createPassThroughALStorageEventSink()
        ),
        volatileBudget: createDefaultVolatileSessionBudget(),
        checkpointStores: resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
        connectTimeoutMs: 0
    });
    await vi.advanceTimersByTimeAsync(beforeOpenDelayMs);
    const native = TestWebSocket.instances.at(-1);
    if (!native) {
        throw new Error('Connection must create a native socket');
    }
    native.open();
    const service = await connecting;
    onTestFinished(async () => {
        const outcomes = await Promise.allSettled([service.close(), engine.stop()]);
        const failure = outcomes.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw failure.reason;
        }
    });
    return { engine, drain, native, service, settlements };
}
