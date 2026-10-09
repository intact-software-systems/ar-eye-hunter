import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { resolveBrowserALCheckpointStores } from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
import { toBrowserSessionALInboundRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    configureBrowserALRuntimeStores,
    createBrowserALVolatileInboundRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { AL_INBOUND_WORK_PAGE_SIZE } from '@shared/alm/inbound/read-al-inbound-work-selection.ts';
import { createPassThroughALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
import type { ClientInfo } from '@shared/api/api-config.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import type WsQueueBoxClientService from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createDefaultVolatileSessionBudget } from '../default-volatile-session-budget.ts';

const diagnosticsPorts = toRallarDiagnosticsPorts(undefined);
const clientData: ClientInfo = { clientId: 'client-1', sessionId: 'session-1', isOnline: true };
const TYPE_ID = 'chat.message.v1';
/** Seq 2 to 65 buffered behind a missing seq 1: what the lane's buffered-track cell sends. */
const BUFFERED = 64;
type EffectDrain = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'effect-drain'; }>;

interface BufferedTrackReceiver {
    readonly service: WsQueueBoxClientService;
    readonly socket: TestWebSocket;
    readonly drains: readonly EffectDrain[];
    /** The msgId of every arrival the inbound runtime decided on. */
    readonly admitted: readonly string[];
}

describe('a buffered track on the browser WS client', () => {
    beforeEach(() => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        onTestFinished(() => {
            vi.unstubAllGlobals();
            TestWebSocket.instances.length = 0;
        });
        configureBrowserALRuntimeStores(clientData.sessionId, { scope: defaultStateScope(), diagnosticsPorts });
    });

    it('delivers all 65 messages of a 64-message buffered track in order within the default message lifetime', async () => {
        const receiver = await openBufferedTrackReceiver();
        const deliveredSeqs: (number | undefined)[] = [];
        receiver.service.onInboxMessageDo(TYPE_ID, {
            onMessage: async (message) => {
                deliveredSeqs.push(message.ordering?.seq);
            }
        });
        for (let seq = 2; seq <= BUFFERED + 1; seq += 1) {
            await receiveAdmitted(receiver, createTrackMessage(seq));
        }

        const releasedAtMs = Date.now();
        await receiveAdmitted(receiver, createTrackMessage(1));
        await vi.waitFor(() => expect(deliveredSeqs).toHaveLength(BUFFERED + 1), {
            timeout: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS,
            interval: 10
        });

        expect(Date.now() - releasedAtMs).toBeLessThan(BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS);
        expect(deliveredSeqs).toEqual(Array.from({ length: BUFFERED + 1 }, (_, index) => index + 1));
        expect(readSentNackReasons(receiver.socket)).not.toContain('resync-required');
        await vi.waitFor(() => expect(sumCompleted(receiver.drains)).toBeGreaterThanOrEqual(BUFFERED + 1));
        expect(receiver.drains.length).toBeLessThanOrEqual(1 + Math.ceil(BUFFERED / AL_INBOUND_WORK_PAGE_SIZE));
        expect(receiver.drains.reduce((sum, drain) => sum + drain.promoted, 0)).toBeGreaterThan(0);
    }, BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS + 5_000);
});

/** The browser's own WS client over an open test socket, with its inbound drains collected. */
async function openBufferedTrackReceiver(): Promise<BufferedTrackReceiver> {
    const socket = new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort());
    onTestFinished(() => socket.close(1000, 'test-finished'));
    // The connect starts the session's engine; the rotation's rounds after a commit's own batch run on it.
    const qboxEngine = new InboxOutboxEngine();
    qboxEngine.start();
    onTestFinished(() => qboxEngine.stop());
    const drains: EffectDrain[] = [];
    const admitted: string[] = [];
    const budget = createDefaultVolatileSessionBudget();
    const initialized = createBrowserWebSocketQueueBox({
        durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
        qosProvider: undefined,
        submissionReadinessFaultPort: diagnosticsPorts.submissionReadinessFaultPort,
        outboundSettlements: () => {},
        newConnectionRequestId: undefined,
        qboxEngine,
        socket,
        clientData,
        serverPeerId: 'server',
        inboundStores: resolveBrowserSessionALInboundRuntimeStores(clientData.sessionId),
        inboundVolatileStores: createBrowserALVolatileInboundRuntimeStores(
            toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId),
            budget,
            createPassThroughALStorageEventSink()
        ),
        volatileBudget: budget,
        checkpointStores: resolveBrowserALCheckpointStores(clientData.sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
        connectTimeoutMs: 0,
        inboundDiagnostics: (event) => {
            if (event.kind === 'effect-drain' && event.claimedCount > 0) {
                drains.push(event);
            }
            if (event.kind === 'admission-outcome') {
                admitted.push(event.msgId);
            }
        }
    });
    await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
    const native = TestWebSocket.instances[0]!;
    native.open();
    const service = await initialized;
    onTestFinished(() => service.close(1000, 'test-finished'));
    return { service, socket: native, drains, admitted };
}

/**
 * One frame, admitted before the next arrives: the server's socket delivers a track in order, and
 * this proof is about the drain after the gap fills, not about arrivals racing their own admission.
 */
async function receiveAdmitted(receiver: BufferedTrackReceiver, message: ALMessage): Promise<void> {
    receiver.socket.receive(JSON.stringify(message));
    await vi.waitFor(() => expect(receiver.admitted).toContain(message.id.msgId));
}

/** One message of the server's track to this session, at the browser's default lifetime. */
function createTrackMessage(seq: number): ALMessage {
    const message = newALUnicastMessage(
        'server',
        { topicId: 'chat', resourceId: `track-${seq}`, contextId: 'conversation' },
        clientData.sessionId,
        TYPE_ID,
        { seq },
        { ttlMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS }
    );
    return { ...message, id: { ...message.id, msgId: `track-${seq}` }, ordering: { orderingKey: 'chat', seq } };
}

function readSentNackReasons(socket: TestWebSocket): readonly string[] {
    return socket.sent.flatMap((frame) => {
        const control = decodeALControlMessage(decodePersistedALMessage(frame)).right;
        return control?.type === 'nack' ? [control.payload.reason] : [];
    });
}

function sumCompleted(drains: readonly EffectDrain[]): number {
    return drains.reduce((sum, drain) => sum + drain.completedCount, 0);
}
