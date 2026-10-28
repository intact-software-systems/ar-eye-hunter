import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    createRallarAlmReceiptDiagnosticsRecorder,
    type RallarAlmReceiptDiagnosticsRecorder
} from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import {
    computeClientStateSyncEntries,
    computeGroupStateSyncEntries,
    type ComputedGroupStateSync
} from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend
} from '@shared/alm/al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type {
    AuditStamp,
    Group,
    GroupEvent,
    GroupSnapshot,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { createTestGroup } from '../../create-test-group.ts';
import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

const SERVER_ID = 'server';
const DELTA_TRACE_ID = 'trace-delta-1';
const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };
const ROOM = { ...SCOPE, groupId: 'room-1' };
const CAUSAL_REVISION: GroupStateCausalRevision = { groupRevision: 2, presenceRevision: 1 };
/** Long enough that the receipt budget (four 2 s windows) ends first. */
const DELTA_TTL_MS = 60_000;
const CLOCK_STEP_MS = 1_000;
const AUDIT: AuditStamp = { atEpochMs: 1, actor: { kind: 'service', serviceId: 'test' }, reason: null, traceId: null, requestId: null };

interface ServerInstance {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly sockets: Readonly<Record<string, SimulatedWebSocket>>;
}

interface Clock {
    nowMs: number;
}

describe('receipts of the group-state deltas the server publishes', () => {
    it('records the delta\'s trace on the session that acknowledged it, then on the receipt the rest never gave', async () => {
        const clock = mockClock();
        const recorder = createReceiptRecorder(clock);
        const local = await createInstance(clock, recorder);
        const delta = toGroupDeltaMessage(clock.nowMs);

        const enqueued = await local.service.enqueueOutboxIfAbsent(delta, {
            admittedAudience: ['a', 'b'],
            recipientScope: undefined
        });

        expect(delta.delivery).toEqual({ ownership: 'shared', reliability: 'at-least-once', ack: 'receiver' });
        expect(enqueued.verdict.kind).toBe('admitted');
        await expect.poll(async () => {
            await local.engine.executeOnce();
            return [countCopies(local.sockets.a, delta.id.msgId), countCopies(local.sockets.b, delta.id.msgId)];
        }).toEqual([1, 1]);

        const acknowledgedAtEpochMs = clock.nowMs;
        await local.service.acceptIncomingMessage(sessionAck(delta, 'a'), 'a');
        expect(recorder.readDiagnostics().messages).toEqual([{
            msgId: delta.id.msgId,
            mode: 'receiver',
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            lastSettlementKind: 'acknowledgement',
            receiptExhausted: false,
            traceId: DELTA_TRACE_ID,
            updatedAtEpochMs: acknowledgedAtEpochMs
        }]);

        await expect.poll(async () => {
            clock.nowMs += CLOCK_STEP_MS;
            await local.engine.executeOnce();
            return recorder.readDiagnostics().messages[0]?.receiptExhausted;
        }, { timeout: 5_000 }).toBe(true);
        expect(recorder.readDiagnostics().messages).toEqual([{
            msgId: delta.id.msgId,
            mode: 'receiver',
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            lastSettlementKind: 'receipt-exhausted',
            receiptExhausted: true,
            traceId: DELTA_TRACE_ID,
            updatedAtEpochMs: expect.any(Number)
        }]);
        expect(recorder.readDiagnostics().messages[0]?.updatedAtEpochMs).toBeGreaterThan(acknowledgedAtEpochMs);
    });

    it('keeps a client-state event unreceipted, so it records nothing', async () => {
        const clock = mockClock();
        const recorder = createReceiptRecorder(clock);
        const local = await createInstance(clock, recorder);
        const [clientEvent] = computeClientStateSyncEntries({
            commandId: 'client-event-command',
            aggregateRef: { ...SCOPE, principalId: 'alice' },
            acceptedCausalRevision: 5,
            audience: { kind: 'principal', ...SCOPE, resourceId: 'alice' },
            createdAtEpochMs: clock.nowMs,
            expireAtEpochMs: clock.nowMs + DELTA_TTL_MS,
            effects: [{ effectKind: 'principal-state', payloadKind: 'event', payload: createClientEvent(clock.nowMs) }],
            traceId: 'trace-client-event-1'
        }, SERVER_ID);
        if (clientEvent === undefined) {
            throw new Error('Expected one client-state event entry');
        }

        await local.service.enqueueOutboxIfAbsent(clientEvent.message, {
            admittedAudience: ['a', 'b'],
            recipientScope: undefined
        });
        for (let step = 0; step < 10; step += 1) {
            clock.nowMs += CLOCK_STEP_MS;
            await local.engine.executeOnce();
        }

        expect(clientEvent.message.delivery?.ack).toBe('none');
        expect(recorder.readDiagnostics().messages).toEqual([]);
    });

    it('keeps every group snapshot page unreceipted', () => {
        const entries = computeGroupStateSyncEntries({
            ...toGroupStateSyncFacts(Date.now()),
            effects: [{ effectKind: 'member-state', payloadKind: 'snapshot', payload: createGroupSnapshot() }]
        }, SERVER_ID);

        expect(entries.map((entry) => decodePersistedALMessage(entry.resource).delivery?.ack)).toEqual(['none']);
    });
});

function toGroupDeltaMessage(nowMs: number): ALMessage {
    const [entry] = computeGroupStateSyncEntries({
        ...toGroupStateSyncFacts(nowMs),
        effects: [{ effectKind: 'member-state', payloadKind: 'delta-envelope', payload: createDeltaEnvelope() }]
    }, SERVER_ID);
    if (entry === undefined) {
        throw new Error('Expected one group-state delta entry');
    }
    return decodePersistedALMessage(entry.resource);
}

function toGroupStateSyncFacts(nowMs: number): Omit<ComputedGroupStateSync, 'effects'> {
    return {
        commandId: 'delta-command',
        aggregateRef: ROOM,
        acceptedCausalRevision: CAUSAL_REVISION,
        audience: { kind: 'group', ...SCOPE, resourceId: ROOM.groupId },
        createdAtEpochMs: nowMs,
        expireAtEpochMs: nowMs + DELTA_TTL_MS,
        traceId: DELTA_TRACE_ID
    };
}

function createDeltaEnvelope(): GroupStateDeltaEnvelope {
    return {
        event: createGroupEvent(),
        predecessorCausalRevision: CAUSAL_REVISION,
        resultingCausalRevision: CAUSAL_REVISION,
        members: [],
        removedMemberPrincipalIds: [],
        sessions: [],
        removedSessionIds: [],
        activeSessionIds: ['a', 'b'],
        group: createRoom(),
        memberCount: 1,
        onlineMemberCount: 1,
        audienceSessionIds: ['a', 'b']
    };
}

function createGroupSnapshot(): GroupSnapshot {
    return {
        causalRevision: CAUSAL_REVISION,
        group: createRoom(),
        members: [{
            ...ROOM,
            principalId: 'alice',
            role: 'owner',
            status: 'active',
            joined: AUDIT,
            updated: AUDIT,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null
        }],
        activeSessions: [],
        memberCount: 1,
        onlineMemberCount: 0
    };
}

function createRoom(): Group {
    return createTestGroup({
        ...ROOM,
        snapshotVersion: CAUSAL_REVISION.groupRevision,
        presenceVersion: CAUSAL_REVISION.presenceRevision
    });
}

function createGroupEvent(): GroupEvent {
    return {
        ...ROOM,
        eventId: 'event-1',
        eventType: 'group-updated',
        snapshotVersion: CAUSAL_REVISION.groupRevision,
        causalRevision: CAUSAL_REVISION,
        occurredAtEpochMs: 1,
        actor: AUDIT.actor,
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
}

function createClientEvent(nowMs: number): ClientEvent {
    return {
        ...SCOPE,
        principalId: 'alice',
        eventId: 'client-event-1',
        eventType: 'session-connected',
        snapshotVersion: 5,
        clientInstanceId: 'alice-instance',
        sessionId: 'a',
        occurredAtEpochMs: nowMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: 'client-event-command',
        payload: {}
    };
}

function createReceiptRecorder(clock: Clock): RallarAlmReceiptDiagnosticsRecorder {
    return createRallarAlmReceiptDiagnosticsRecorder({ nowEpochMs: () => clock.nowMs, capacity: 256 });
}

async function createInstance(clock: Clock, recorder: RallarAlmReceiptDiagnosticsRecorder): Promise<ServerInstance> {
    const outbox = new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    const nowMs = () => clock.nowMs;
    const socketServer = new JsonWebSocketServer();
    const sockets: Record<string, SimulatedWebSocket> = {};
    for (const peerId of ['a', 'b']) {
        const socket = new SimulatedWebSocket(`ws://${peerId}`);
        await socket.open();
        socketServer.addConnection(new ConnectionContext({ id: peerId, socket }));
        sockets[peerId] = socket;
    }
    const recipients = () => [...socketServer.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }));
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        inboundVolatileStores: undefined,
        outbox,
        socket: socketServer,
        name: SERVER_ID,
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        readAuthenticatedConnectionScope: (connection) =>
            socketServer.connections.get(connection.id) === connection
                ? { scope: SCOPE, expiresAtEpochMs: nowMs() + 60_000 }
                : undefined,
        outboundStores: createDefaultInMemoryALOutboundRuntimeStores({
            nowMs,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            outboundBackend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), nowMs)
        }),
        outboundSettlements: recorder.settlements,
        targetResolver: {
            resolvePeerRecipients: (peerId) => recipients().filter((recipient) => recipient.peerId === peerId),
            resolveBroadcastRecipients: recipients
        }
    });
    onTestFinished(() => service.dispose());
    return { service, engine, sockets };
}

function mockClock(): Clock {
    const clock = { nowMs: Date.now() };
    vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    onTestFinished(() => {
        vi.restoreAllMocks();
    });
    return clock;
}

/** The browser addresses its ACK to the delta's sender and stamps it with the delta's trace. */
function sessionAck(delta: ALMessage, recipient: string): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: `ack-${delta.id.msgId}-${recipient}`, senderId: recipient, ts: Date.now(), traceId: delta.id.traceId },
        {
            ackedMsgId: delta.id.msgId,
            fromPeerId: recipient,
            toPeerId: delta.id.senderId,
            originPeerId: delta.id.senderId,
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}

function countCopies(socket: SimulatedWebSocket, msgId: string): number {
    return socket.sent.filter((frame) => decodePersistedALMessage(frame).id.msgId === msgId).length;
}
