import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore, type ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { Either } from '@shared/resilience/Either.ts';
import { createDefaultWsQueueBoxServerService, WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

interface ServerIngressFixture {
    readonly service: WsQueueBoxServerService;
    readonly server: JsonWebSocketServer;
    readonly socket: SimulatedWebSocket;
    readonly admission: ALAdmissionMemoryState;
    readonly admissionStore: ALInboundAdmissionStore;
    readonly inbox: InMemoryQueueBox;
    readonly delivered: ALMessage[];
}

describe('WS server bounded and authorized admission', () => {
    it('rejects invalid envelopes and forged identities without poisoning a valid message identity', async () => {
        const fixture = await createServerIngressFixture();
        const message = incomingMessage();
        expect((await fixture.service.acceptIncomingMessage({}, 'session-1')).left?.code).toBe('malformed');
        const forged = { ...message, id: { ...message.id, senderId: 'victim' } };
        expect((await fixture.service.acceptIncomingMessage(forged, 'session-1')).left?.code).toBe('unauthorized');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);

        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right?.kind).toBe('admitted');
        expect(fixture.delivered).toEqual([message]);
    });

    it('requires room authority even when a message supplies no snapshot floor', async () => {
        const fixture = await createServerIngressFixture();
        const message = roomMessage();
        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).left?.code).toBe('unsupported');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.delivered).toEqual([]);
    });

    it('does not acknowledge or retain denied room traffic', async () => {
        const fixture = await createServerIngressFixture();
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () => ({
                authorized: false,
                reason: 'unauthorized',
                logMessage: 'Sender is no longer a room member',
                sendNack: true
            })
        });

        expect((await fixture.service.acceptIncomingMessage(roomMessage(), 'session-1')).left?.code).toBe('unauthorized');
        expect(fixture.admission.data.size).toBe(0);
        expect(await fixture.inbox.getAllKeys()).toEqual([]);
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.delivered).toEqual([]);
    });

    it('returns an explicit pending result for room evidence that is still catching up', async () => {
        const fixture = await createServerIngressFixture();
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () => ({
                authorized: false,
                reason: 'not-yet-in-sync',
                logMessage: 'Room snapshot is catching up',
                sendNack: true,
                serverSnapshotVersion: 1
            })
        });

        expect((await fixture.service.acceptIncomingMessage(roomMessage(), 'session-1')).right).toEqual({
            kind: 'not-admitted',
            reason: 'not-yet-in-sync'
        });
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
        expect(fixture.socket.sent).toHaveLength(1);
    });

    it('does not parse an oversized native wire message or admit its decoded equivalent', async () => {
        const fixture = await createServerIngressFixture();
        const message = incomingMessage();
        const serialized = ' '.repeat(AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes) + JSON.stringify(message);
        const parse = vi.spyOn(JSON, 'parse');
        onTestFinished(() => parse.mockRestore());

        await fixture.socket.receive(serialized);

        expect(parse.mock.calls.some(([value]) => value === serialized)).toBe(false);
        expect(fixture.admission.data.size).toBe(0);
        await fixture.socket.receive(JSON.stringify(message));
        expect(fixture.delivered).toEqual([message]);
    });

    it('rechecks the connection generation after asynchronous authorization', async () => {
        const fixture = await createServerIngressFixture();
        const gate = Promise.withResolvers<void>();
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () => {
                await gate.promise;
                return { authorized: true };
            }
        });
        const receiving = fixture.service.acceptIncomingMessage(incomingMessage(), 'session-1');
        const replacement = new SimulatedWebSocket('ws://replacement');
        await replacement.open();
        fixture.server.addConnection(new ConnectionContext({ id: 'session-1', socket: replacement }));
        gate.resolve();

        expect((await receiving).left?.code).toBe('unauthorized');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
    });

    it('runs a typed application validator before authorization or admission', async () => {
        const fixture = await createServerIngressFixture(() => Either.ofLeft({ code: 'malformed', message: 'Invalid command' }));
        const authorize = vi.fn(async () => ({ authorized: true as const }));
        fixture.service.authorizeInboundMessagesWith({ authorize });

        expect((await fixture.service.acceptIncomingMessage(incomingMessage(), 'session-1')).left?.code).toBe('malformed');
        expect(authorize).not.toHaveBeenCalled();
        expect(fixture.admission.data.size).toBe(0);
    });

    it('rechecks room authority before delivering already queued messages', async () => {
        const fixture = await createServerIngressFixture();
        let authorized = true;
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () =>
                authorized
                    ? { authorized: true }
                    : { authorized: false, reason: 'unauthorized', logMessage: 'Membership removed', sendNack: false }
        });
        const message: ALMessage = { ...roomMessage(), qos: { durability: { algo: 'local-inbox' } } };
        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right?.kind).toBe('admitted');
        expect(await fixture.inbox.getAllKeys()).toHaveLength(1);
        expect(fixture.delivered).toEqual([]);
        authorized = false;

        await fixture.service.dequeueInbox(WsQueueBoxServerService.INBOX_DEQUEUE_TYPES, dequeueResilience());

        expect(fixture.delivered).toEqual([]);
    });

    it('leaves queued delivery retryable while current room evidence catches up', async () => {
        const fixture = await createServerIngressFixture();
        let catchingUp = false;
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () =>
                catchingUp
                    ? { authorized: false, reason: 'not-yet-in-sync', logMessage: 'Waiting for room snapshot', sendNack: false }
                    : { authorized: true }
        });
        const message: ALMessage = { ...roomMessage(), qos: { durability: { algo: 'local-inbox' } } };
        await fixture.service.acceptIncomingMessage(message, 'session-1');
        catchingUp = true;

        await fixture.service.dequeueInbox(WsQueueBoxServerService.INBOX_DEQUEUE_TYPES, dequeueResilience());

        expect(fixture.delivered).toEqual([]);
        const queued = await fixture.inbox.getItem(message.route);
        expect(queued?.status).toBe('RETRY');
    });

    it('fences an authorization result that arrives after disposal', async () => {
        const fixture = await createServerIngressFixture();
        const gate = Promise.withResolvers<void>();
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () => {
                await gate.promise;
                return { authorized: true };
            }
        });
        const receiving = fixture.service.acceptIncomingMessage(incomingMessage(), 'session-1');
        fixture.service.dispose();
        gate.resolve();

        expect((await receiving).right?.kind).toBe('disposed');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
    });

    it('does not commit an admission read that completes after disposal', async () => {
        const fixture = await createServerIngressFixture();
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const read = fixture.admissionStore.readIncomingMessage.bind(fixture.admissionStore);
        vi.spyOn(fixture.admissionStore, 'readIncomingMessage').mockImplementation(async (...input) => {
            started.resolve();
            await release.promise;
            return await read(...input);
        });
        const receiving = fixture.service.acceptIncomingMessage(incomingMessage(), 'session-1');
        await started.promise;
        fixture.service.dispose();
        release.resolve();

        expect((await receiving).right?.kind).toBe('disposed');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
    });

    it('leaves a durable message in QueueBox when an application subscriber fails', async () => {
        const fixture = await createServerIngressFixture();
        const message: ALMessage = { ...incomingMessage(), qos: { durability: { algo: 'local-inbox' } } };
        fixture.service.onAnyInboxMessageDo('observer', {
            onMessage: async () => {
                throw new Error('Temporary application failure');
            }
        });
        await fixture.service.acceptIncomingMessage(message, 'session-1');

        await fixture.service.dequeueInbox(WsQueueBoxServerService.INBOX_DEQUEUE_TYPES, dequeueResilience());

        const queued = await fixture.inbox.getItem(message.route);
        expect(queued?.status).toBe('RETRY');
    });
});

function dequeueResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        {
            maxConsecutiveFailures: 10,
            resetTimeout: duration,
            halfOpenTimeout: duration,
            slidingWindow: duration
        },
        1,
        10,
        1,
        1
    );
}

async function createServerIngressFixture(
    validateInboundMessage?: WsQueueBoxServerService.Input['validateInboundMessage']
): Promise<ServerIngressFixture> {
    const server = new JsonWebSocketServer();
    const socket = new SimulatedWebSocket('ws://server');
    await socket.open();
    server.addConnection(new ConnectionContext({ id: 'session-1', socket }));
    const admission = createInMemoryALAdmissionState();
    const inbox = new InMemoryQueueBox(new Map());
    const admissionStore = createALInboundAdmissionStore({
        namespace: 'ws-server-ingress',
        backend: new InMemoryAdmissionBackend(admission, Date.now),
        orderingTrackTtlMs: 300000,
        supersedenceTrackTtlMs: 300000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const service = createDefaultWsQueueBoxServerService({
        inbox,
        outbox: new InMemoryQueueBox(new Map()),
        socket: server,
        name: 'server',
        validateInboundMessage,
        inboundStores: { admissionStore }
    });
    const delivered: ALMessage[] = [];
    service.onAnyInboxMessageDo('observer', {
        onMessage: async (message) => {
            delivered.push(message);
        }
    });
    onTestFinished(() => service.dispose());
    return { service, server, socket, admission, admissionStore, inbox, delivered };
}

function incomingMessage(): ALMessage {
    return {
        id: { v: 2, msgId: 'message-1', ts: 1, senderId: 'session-1' },
        route: { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

function roomMessage(): ALMessage {
    return {
        ...incomingMessage(),
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: 'room-1' },
        targets: { mode: 'broadcast', scope: 'room', groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' } }
    };
}
