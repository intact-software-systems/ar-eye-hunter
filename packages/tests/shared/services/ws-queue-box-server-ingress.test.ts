import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALNackPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore, type ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { readALInboundStoredMessage } from '@shared/alm/inbound/al-inbound-canonical-message.ts';
import { decodeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { createDefaultWsQueueBoxServerService, WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';
import { waitForSettledALInboundWork } from '../wait-for-al-inbound-work.ts';

interface ServerIngressFixture {
    readonly service: WsQueueBoxServerService;
    readonly server: JsonWebSocketServer;
    readonly socket: SimulatedWebSocket;
    readonly admission: ALAdmissionMemoryState;
    readonly backend: InMemoryAdmissionBackend;
    readonly admissionStore: ALInboundAdmissionStore;
    readonly delivered: ALMessage[];
}

describe('WS server bounded and authorized admission', () => {
    it('rejects invalid envelopes and forged identities without poisoning a valid message identity', async () => {
        const fixture = await createServerIngressFixture();
        const message = createIncomingMessage();
        expect((await fixture.service.acceptIncomingMessage({}, 'session-1')).left?.code).toBe('malformed');
        const forged = { ...message, id: { ...message.id, senderId: 'victim' } };
        expect((await fixture.service.acceptIncomingMessage(forged, 'session-1')).left?.code).toBe('unauthorized');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
        expect(fixture.socket.sent).toEqual([]);

        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right?.kind).toBe('admitted');
        await expect.poll(() => fixture.delivered).toEqual([message]);
    });

    it('keeps admitted work unclaimed until an application consumer registers', async () => {
        const fixture = await createServerIngressFixture();
        fixture.service.removeAnyInboxMessageCallback('observer');
        await fixture.service.acceptIncomingMessage(createIncomingMessage(), 'session-1');
        const keys = await fixture.admission.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        expect(await fixture.admission.workQueue.getItem(keys[0])).toMatchObject({ status: 'NEW', dequeueAudit: { attempts: 0 } });
        fixture.service.onAnyInboxMessageDo('observer', {
            onMessage: async (message) => {
                fixture.delivered.push(message);
            }
        });

        await expect.poll(async () => {
            return fixture.admission.workQueue.getItem(keys[0]);
        }).toMatchObject({ status: 'COMPLETED', dequeueAudit: { attempts: 1 } });
        expect(fixture.delivered).toEqual([createIncomingMessage()]);
    });

    it('requires room authority even when a message supplies no snapshot floor', async () => {
        const fixture = await createServerIngressFixture();
        const message = createRoomMessage();
        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).left?.code).toBe('unsupported');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.delivered).toEqual([]);
    });

    it('restarts owned delivery without requiring new ingress', async () => {
        const fixture = await createServerIngressFixture();
        fixture.service.removeAnyInboxMessageCallback('observer');
        const message = createIncomingMessage();
        await fixture.service.acceptIncomingMessage(message, 'session-1');
        fixture.service.dispose();
        const resumed = createDefaultWsQueueBoxServerService({
            name: 'server',
            socket: fixture.server,
            outbox: new InMemoryQueueBox(),
            inboundStores: { admissionStore: fixture.admissionStore, workQueue: fixture.admission.workQueue }
        });
        onTestFinished(() => resumed.dispose());
        const delivered: ALMessage[] = [];
        resumed.onInboxMessageDo('message.v1', {
            onMessage: async (incoming) => {
                delivered.push(incoming);
            }
        });

        await expect.poll(() => delivered).toEqual([message]);
        const keys = await fixture.admission.workQueue.getAllKeys();
        expect(await fixture.admission.workQueue.getItem(keys[0])).toMatchObject({ status: 'COMPLETED', dequeueAudit: { attempts: 1 } });
    });

    it.each([-1, 0, 1])('checks remaining consumer expiry after a handler returns at deadline %+i ms', async (offsetMs) => {
        let nowMs = 10_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const fixture = await createServerIngressFixture();
        const expiresAtMs = nowMs + 1_000;
        const delivered: string[] = [];
        fixture.service.onInboxMessageDo('message.v1', {
            onMessage: async () => {
                delivered.push('specific');
                await Promise.resolve();
                nowMs = expiresAtMs + offsetMs;
            }
        });
        fixture.service.onAllInboxMessagesDo({
            onMessage: async () => {
                delivered.push('wildcard');
            }
        });
        const message = { ...createIncomingMessage(), constraints: { expiresAtMs } };

        await fixture.service.acceptIncomingMessage(message, 'session-1');

        await waitForSettledALInboundWork(fixture.admission.workQueue);
        expect(delivered).toEqual(offsetMs < 0 ? ['specific', 'wildcard'] : ['specific']);
        expect(fixture.delivered).toEqual(offsetMs < 0 ? [message] : []);
    });

    it.each([
        { effect: 'local', offsetMs: -1 },
        { effect: 'local', offsetMs: 0 },
        { effect: 'local', offsetMs: 1 },
        { effect: 'forward', offsetMs: -1 },
        { effect: 'forward', offsetMs: 0 },
        { effect: 'forward', offsetMs: 1 }
    ])('checks $effect expiry after authorization at deadline $offsetMs ms', async ({ effect, offsetMs }) => {
        let nowMs = 10_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const fixture = await createServerIngressFixture();
        const expiresAtMs = nowMs + 1_000;
        const recipient = new SimulatedWebSocket('ws://recipient');
        await recipient.open();
        if (effect === 'forward') {
            fixture.service.removeAnyInboxMessageCallback('observer');
            fixture.server.addConnection(new ConnectionContext({ id: 'recipient', socket: recipient }));
        }
        let authorityReads = 0;
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () => {
                authorityReads += 1;
                if (authorityReads > 1) {
                    await Promise.resolve();
                    nowMs = expiresAtMs + offsetMs;
                }
                return { authorized: true, groupRecipientPeerIds: effect === 'forward' ? ['recipient'] : [] };
            }
        });
        const message = { ...createRoomMessage(), constraints: { expiresAtMs } };

        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right?.kind).toBe('admitted');

        // A forward that beat the deadline leaves its local dispatch retained; everything else drains.
        await expect.poll(async () => {
            fixture.admission.workQueue.cleanup();
            return (await fixture.admission.workQueue.getAllKeys()).length;
        }).toBe(offsetMs < 0 && effect === 'forward' ? 1 : 0);
        const observed = effect === 'local' ? fixture.delivered : recipient.sent;
        expect(observed).toHaveLength(offsetMs < 0 ? 1 : 0);
        const keys = await fixture.admission.workQueue.getAllKeys();
        if (offsetMs < 0 && effect === 'forward') {
            expect(keys).toHaveLength(1);
            const pending = await fixture.admission.workQueue.getItem(keys[0]);
            expect(pending).toMatchObject({ status: 'NEW', dequeueAudit: { attempts: 0 } });
            expect(pending?.audit.expiryTs.epochMilliseconds).toBe(expiresAtMs);
            const retained = decodeALInboundWorkEntry(pending!, 'ws-server-ingress');
            expect(retained.payload.kind).toBe('dispatch-local');
            if (retained.payload.kind !== 'dispatch-local') {
                throw new Error('Expected pending local delivery');
            }
            const original = (await readALInboundStoredMessage({
                database: fixture.backend,
                namespace: fixture.admissionStore.namespace,
                reference: retained.payload.message
            }))?.msg;
            expect(original?.id).toEqual(message.id);
            expect(original?.constraints?.expiresAtMs).toBe(expiresAtMs);
        }
        else {
            expect(keys).toEqual([]);
        }
    });

    it.each(['unauthorized', 'not-yet-in-sync'] as const)('rechecks %s room authority before pending admission can commit or acknowledge', async (reason) => {
        let nowMs = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const fixture = await createServerIngressFixture();
        let pending = false;
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () =>
                pending
                    ? { authorized: false, reason, logMessage: 'Current room authority changed', sendNack: false }
                    : { authorized: true, groupRecipientPeerIds: [] }
        });
        const commit = fixture.admissionStore.commitBundle.bind(fixture.admissionStore);
        vi.spyOn(fixture.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
            expect(await commit({ ...bundle, mutations: bundle.mutations.filter((mutation) => mutation.kind === 'set-msg-owner'), durableEffects: [] })).toBe(
                'committed'
            );
            const status = await commit(bundle);
            expect(status).toBe('conflict');
            return status;
        });
        const enqueue = fixture.admission.workQueue.enqueueIfAbsent.bind(fixture.admission.workQueue);
        let observedMetadata: ALAdmissionMemoryState['data'] | undefined;
        vi.spyOn(fixture.admission.workQueue, 'enqueueIfAbsent').mockImplementationOnce(async (entry) => {
            const retained = await enqueue(entry);
            observedMetadata = new Map(fixture.admission.data);
            pending = true;
            return retained;
        });
        const message = { ...createRoomMessage(), constraints: { expiresAtMs: Date.now() + 60_000 }, qos: { ack: { algo: 'hop' as const } } };
        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right?.kind).toBe('pending-admission');
        await expect.poll(async () => {
            const keys = await fixture.admission.workQueue.getAllKeys();
            return (await fixture.admission.workQueue.getItem(keys[0]))?.status;
        }).toBe(reason === 'unauthorized' ? 'COMPLETED' : 'RETRY');
        expect(fixture.admission.data).toEqual(observedMetadata);
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.delivered).toEqual([]);
        const keys = await fixture.admission.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        expect((await fixture.admission.workQueue.getItem(keys[0]))?.status).toBe(reason === 'unauthorized' ? 'COMPLETED' : 'RETRY');
        if (reason === 'not-yet-in-sync') {
            const waiting = await fixture.admission.workQueue.getItem(keys[0]);
            expect(waiting?.dequeueAudit.attempts).toBe(0);
            expect(waiting?.dequeueAudit.nextTs?.epochMilliseconds).toBe(Date.now() + 50);
            nowMs = waiting!.dequeueAudit.nextTs!.epochMilliseconds;
            await expect.poll(async () => (await fixture.admission.workQueue.getItem(keys[0]))?.dequeueAudit.nextTs?.epochMilliseconds).toBe(nowMs + 50);
            const stillWaiting = await fixture.admission.workQueue.getItem(keys[0]);
            expect(stillWaiting?.dequeueAudit.attempts).toBe(0);
            expect(stillWaiting?.dequeueAudit.nextTs?.epochMilliseconds).toBe(nowMs + 50);
            pending = false;
            nowMs = stillWaiting!.dequeueAudit.nextTs!.epochMilliseconds;
            await expect.poll(async () => {
                return fixture.delivered.length;
            }).toBe(1);
            expect(fixture.delivered[0].constraints?.expiresAtMs).toBe(message.constraints.expiresAtMs);
        }
    });

    it.each([true, false])('returns configured denial NACKs without accepting room traffic (sendNack=%s)', async (sendNack) => {
        const fixture = await createServerIngressFixture();
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () => ({
                authorized: false,
                reason: 'unauthorized',
                logMessage: 'Sender is no longer a room member',
                sendNack
            })
        });

        const message: ALMessage = { ...createRoomMessage(), qos: { ack: { algo: 'hop' }, durability: { algo: 'local-inbox' } } };
        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).left?.code).toBe('unauthorized');
        expect(fixture.admission.data.size).toBe(0);
        expect(await fixture.admission.workQueue.getAllKeys()).toEqual([]);
        if (sendNack) {
            const controls = fixture.socket.sent.map((frame) => decodePersistedALMessage(String(frame)));
            expect(controls).toMatchObject([{
                id: { senderId: 'server' },
                targets: { mode: 'unicast', toPeerId: 'session-1' },
                qos: { delivery: { algo: 'best-effort' }, durability: { algo: 'volatile' }, ack: { algo: 'none' } },
                payload: { typeId: 'al.control.nack.v1' }
            }]);
            expect(decodeALNackPayload(JSON.parse(controls[0].payload.resource))).toMatchObject({
                fromPeerId: 'server',
                toPeerId: 'session-1',
                msgId: 'message-1',
                reason: 'unauthorized'
            });
        }
        else {
            expect(fixture.socket.sent).toEqual([]);
        }
        expect(fixture.delivered).toEqual([]);
    });

    it.each(['unauthorized', 'not-yet-in-sync'] as const)('preserves %s denial when its advisory NACK exceeds the payload ceiling', async (reason) => {
        const fixture = await createServerIngressFixture();
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () => ({ authorized: false, reason, logMessage: 'Room policy denied', sendNack: true })
        });
        for (const msgId of ['x'.repeat(65536), 'é'.repeat(32768), '"'.repeat(32768), '"'.repeat(32700)]) {
            const message: ALMessage = { ...createRoomMessage(), id: { ...createRoomMessage().id, msgId } };
            const result = await fixture.service.acceptIncomingMessage(message, 'session-1');
            if (reason === 'unauthorized') {
                expect(result.left).toEqual({ code: 'unauthorized', message: 'Room policy denied' });
            }
            else {
                expect(result.right).toEqual({ kind: 'not-admitted', reason });
            }
        }
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.admission.data.size).toBe(0);
        expect(await fixture.admission.workQueue.getAllKeys()).toEqual([]);
        expect(fixture.delivered).toEqual([]);
    });

    it.each(['unauthorized', 'not-yet-in-sync'] as const)(
        'preserves %s denial for an authenticated peer outside the control receiver limit',
        async (reason) => {
            const peerId = 'p'.repeat(129);
            const fixture = await createServerIngressFixture(undefined, peerId);
            fixture.service.authorizeInboundMessagesWith({
                authorize: async () => ({ authorized: false, reason, logMessage: 'Room policy denied', sendNack: true })
            });
            const message: ALMessage = { ...createRoomMessage(), id: { ...createRoomMessage().id, senderId: peerId } };
            const result = await fixture.service.acceptIncomingMessage(message, peerId);
            if (reason === 'unauthorized') {
                expect(result.left).toEqual({ code: 'unauthorized', message: 'Room policy denied' });
            }
            else {
                expect(result.right).toEqual({ kind: 'not-admitted', reason });
            }
            expect(fixture.socket.sent).toEqual([]);
            expect(fixture.admission.data.size).toBe(0);
            expect(await fixture.admission.workQueue.getAllKeys()).toEqual([]);
            expect(fixture.delivered).toEqual([]);
        }
    );

    it('preserves advisory NACK transport error diagnostics', async () => {
        const fixture = await createServerIngressFixture();
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () => ({ authorized: false, reason: 'unauthorized', logMessage: 'Denied', sendNack: true })
        });
        const failure = new Error('Native send failed');
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(fixture.socket, 'send').mockImplementation(() => {
            throw failure;
        });
        expect((await fixture.service.acceptIncomingMessage(createRoomMessage(), 'session-1')).left?.code).toBe('unauthorized');
        expect(errors).toHaveBeenCalledWith('Error sending WS server message to session-1', failure);
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
    });

    it('does not relay to recipients removed by delivery-time authorization', async () => {
        const fixture = await createServerIngressFixture();
        fixture.service.removeAnyInboxMessageCallback('observer');
        const recipient = new SimulatedWebSocket('ws://recipient');
        await recipient.open();
        fixture.server.addConnection(new ConnectionContext({ id: 'recipient', socket: recipient }));
        let authorityReads = 0;
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () => {
                authorityReads += 1;
                await Promise.resolve();
                return { authorized: true, groupRecipientPeerIds: authorityReads === 1 ? ['recipient'] : [] };
            }
        });

        await fixture.service.acceptIncomingMessage(createRoomMessage(), 'session-1');

        await expect.poll(() => {
            fixture.admission.workQueue.cleanup();
            return fixture.admission.workQueue.getAllKeys();
        }).toHaveLength(1);
        const [pendingKey] = await fixture.admission.workQueue.getAllKeys();
        const pending = await fixture.admission.workQueue.getItem(pendingKey);
        expect(decodeALInboundWorkEntry(pending!, fixture.admissionStore.namespace).payload.kind).toBe('dispatch-local');
        expect(recipient.sent).toEqual([]);
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

        expect((await fixture.service.acceptIncomingMessage(createRoomMessage(), 'session-1')).right).toEqual({
            kind: 'not-admitted',
            reason: 'not-yet-in-sync'
        });
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
        expect(fixture.socket.sent).toHaveLength(1);
    });

    it('does not parse an oversized native wire message or admit its decoded equivalent', async () => {
        const fixture = await createServerIngressFixture();
        const message = createIncomingMessage();
        const serialized = ' '.repeat(AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes) + JSON.stringify(message);
        const parse = vi.spyOn(JSON, 'parse');
        onTestFinished(() => parse.mockRestore());

        await fixture.socket.receive(serialized);

        expect(parse.mock.calls.some(([value]) => value === serialized)).toBe(false);
        expect(fixture.admission.data.size).toBe(0);
        await fixture.socket.receive(JSON.stringify(message));
        await expect.poll(() => fixture.delivered).toEqual([message]);
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
        const receiving = fixture.service.acceptIncomingMessage(createIncomingMessage(), 'session-1');
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

        expect((await fixture.service.acceptIncomingMessage(createIncomingMessage(), 'session-1')).left?.code).toBe('malformed');
        expect(authorize).not.toHaveBeenCalled();
        expect(fixture.admission.data.size).toBe(0);
    });

    it('rechecks room authority before delivering already queued messages', async () => {
        const fixture = await createServerIngressFixture();
        const claim = vi.spyOn(fixture.admission.workQueue, 'reserveEntries').mockResolvedValue(new Map());
        let authorized = true;
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () =>
                authorized
                    ? { authorized: true }
                    : { authorized: false, reason: 'unauthorized', logMessage: 'Membership removed', sendNack: false }
        });
        const message: ALMessage = { ...createRoomMessage(), qos: { durability: { algo: 'local-inbox' } } };
        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right?.kind).toBe('admitted');
        expect(await fixture.admission.workQueue.getAllKeys()).toHaveLength(1);
        expect(fixture.delivered).toEqual([]);
        authorized = false;

        claim.mockRestore();
        await expect.poll(async () => {
            const keys = await fixture.admission.workQueue.getAllKeys();
            return (await fixture.admission.workQueue.getItem(keys[0]))?.status;
        }).toBe('COMPLETED');
        expect(fixture.delivered).toEqual([]);
    });

    it('leaves queued delivery retryable while current room evidence catches up', async () => {
        const fixture = await createServerIngressFixture();
        const claim = vi.spyOn(fixture.admission.workQueue, 'reserveEntries').mockResolvedValue(new Map());
        let catchingUp = false;
        fixture.service.authorizeInboundMessagesWith({
            authorize: async () =>
                catchingUp
                    ? { authorized: false, reason: 'not-yet-in-sync', logMessage: 'Waiting for room snapshot', sendNack: false }
                    : { authorized: true }
        });
        const message: ALMessage = { ...createRoomMessage(), qos: { durability: { algo: 'local-inbox' } } };
        await fixture.service.acceptIncomingMessage(message, 'session-1');
        catchingUp = true;

        claim.mockRestore();

        expect(fixture.delivered).toEqual([]);
        const keys = await fixture.admission.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        await expect.poll(async () => {
            return (await fixture.admission.workQueue.getItem(keys[0]))?.status;
        }).toBe('RETRY');
        expect(fixture.delivered).toEqual([]);
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
        const receiving = fixture.service.acceptIncomingMessage(createIncomingMessage(), 'session-1');
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
        const receiving = fixture.service.acceptIncomingMessage(createIncomingMessage(), 'session-1');
        await started.promise;
        fixture.service.dispose();
        release.resolve();

        expect((await receiving).right?.kind).toBe('disposed');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
    });

    it('leaves a durable message in QueueBox when an application subscriber fails', async () => {
        const fixture = await createServerIngressFixture();
        const message: ALMessage = { ...createIncomingMessage(), qos: { durability: { algo: 'local-inbox' } } };
        fixture.service.onAnyInboxMessageDo('observer', {
            onMessage: async () => {
                throw new Error('Temporary application failure');
            }
        });
        await fixture.service.acceptIncomingMessage(message, 'session-1');

        const keys = await fixture.admission.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        await expect.poll(async () => {
            return (await fixture.admission.workQueue.getItem(keys[0]))?.status;
        }).toBe('RETRY');
    });
});

async function createServerIngressFixture(
    validateInboundMessage?: WsQueueBoxServerService.Input['validateInboundMessage'],
    peerId = 'session-1'
): Promise<ServerIngressFixture> {
    const server = new JsonWebSocketServer();
    const socket = new SimulatedWebSocket('ws://server');
    await socket.open();
    server.addConnection(new ConnectionContext({ id: peerId, socket }));
    const nowMs = Date.now;
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => Temporal.Instant.fromEpochMilliseconds(nowMs()));
    const admission = createInMemoryALAdmissionState(new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs())));
    const engine = new InboxOutboxEngine();
    engine.start();
    const backend = new InMemoryAdmissionBackend(admission, nowMs);
    const admissionStore = createALInboundAdmissionStore({
        namespace: 'ws-server-ingress',
        nowMs,
        backend,
        orderingTrackTtlMs: 300000,
        supersedenceTrackTtlMs: 300000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const service = createDefaultWsQueueBoxServerService({
        outbox: new InMemoryQueueBox(new Map()),
        socket: server,
        name: 'server',
        targetResolver: {
            resolveBroadcastRecipients: () => [...server.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }))
        },
        validateInboundMessage,
        inboundStores: { admissionStore, workQueue: admission.workQueue },
        queueEngine: engine
    });
    const delivered: ALMessage[] = [];
    service.onAnyInboxMessageDo('observer', {
        onMessage: async (message) => {
            delivered.push(message);
        }
    });
    onTestFinished(() => {
        service.dispose();
        engine.stop();
        vi.restoreAllMocks();
    });
    return { service, server, socket, admission, backend, admissionStore, delivered };
}

function createIncomingMessage(): ALMessage {
    return {
        id: { v: 2, msgId: 'message-1', ts: 1, senderId: 'session-1' },
        route: { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

function createRoomMessage(): ALMessage {
    return {
        ...createIncomingMessage(),
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: 'room-1' },
        targets: { mode: 'broadcast', scope: 'room', groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' } }
    };
}
