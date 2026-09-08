import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore, type ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { createDefaultWsQueueBoxClientService, type WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { JsonWebSocketClient, type OnWebSocketMessageCallback } from '@shared/websocket/json-web-socket-client.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

interface ClientIngressFixture {
    readonly service: WsQueueBoxClientService;
    readonly socket: TestWebSocket;
    readonly admissionStore: ALInboundAdmissionStore;
    readonly outboundStore: ALOutboundAdmissionStore;
    readonly outbox: InMemoryQueueBox;
    readonly admission: ALAdmissionMemoryState;
    readonly delivered: ALMessage[];
}

describe('WS client typed ingress and transport effects', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('rejects malformed and oversized input before admission and still delivers valid traffic', async () => {
        const fixture = await createClientIngressFixture();
        const message = incomingMessage();
        const malformed = { ...message, payload: { ...message.payload, resource: '{' } };
        const oversized = { ...message, diagnostics: { visitedPeerIds: Array.from({ length: 65 }, () => 'peer') } };

        expect((await fixture.service.acceptIncomingMessage(malformed)).left?.code).toBe('malformed');
        expect((await fixture.service.acceptIncomingMessage(oversized)).left?.code).toBe('oversized');
        expect(fixture.admission.data.size).toBe(0);
        expect(await fixture.admissionStore.workQueue.getAllKeys()).toEqual([]);
        expect(await fixture.outbox.getAllKeys()).toEqual([]);
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.delivered).toEqual([]);

        const accepted = await fixture.service.acceptIncomingMessage(message);
        expect(accepted.right?.kind).toBe('admitted');
        expect(fixture.delivered).toEqual([message]);
    });

    it.each(['owned', 'shared'] as const)('replays without new ingress when a matching consumer registers with an %s engine', async (ownership) => {
        const fixture = await createClientIngressFixture();
        fixture.service.removeAnyInboxMessageCallback('test-observer');
        const message = incomingMessage();
        await fixture.service.acceptIncomingMessage(message);
        const keys = await fixture.admissionStore.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        expect(await fixture.admissionStore.workQueue.getItem(keys[0])).toMatchObject({ status: 'NEW', dequeueAudit: { attempts: 0 } });
        fixture.service.close();

        const engine = new InboxOutboxEngine();
        engine.start();
        const replay = createDefaultWsQueueBoxClientService({
            outbox: new InMemoryQueueBox(),
            socket: new JsonWebSocketClient('ws://configured-server'),
            sessionId: 'self',
            inboundStores: { admissionStore: fixture.admissionStore },
            queueEngine: ownership === 'shared' ? engine : undefined
        });
        onTestFinished(() => {
            replay.close();
            engine.stop();
        });
        const delivered: string[] = [];
        replay.onInboxMessageDo('unrelated.v1', {
            onMessage: async () => {
                delivered.push('wrong consumer');
            }
        });
        await engine.executeOnce();
        expect(await fixture.admissionStore.workQueue.getItem(keys[0])).toMatchObject({ status: 'NEW', dequeueAudit: { attempts: 0 } });
        replay.onInboxMessageDo('message.v1', {
            onMessage: async (incoming) => {
                delivered.push(incoming.id.msgId);
            }
        });

        await expect.poll(() => fixture.admissionStore.workQueue.getItem(keys[0])).toMatchObject({ status: 'COMPLETED', dequeueAudit: { attempts: 1 } });
        expect(delivered).toEqual([message.id.msgId]);
    });

    it('accepts the logical origin relayed by its configured server without rewriting the candidate', async () => {
        const fixture = await createClientIngressFixture();
        const message = incomingMessage();
        Object.freeze(message.id);
        Object.freeze(message.route);
        Object.freeze(message.targets);
        Object.freeze(message.payload);
        Object.freeze(message);

        const accepted = await fixture.service.acceptIncomingMessage(message);

        expect(accepted.right?.kind).toBe('admitted');
        expect(fixture.delivered).toEqual([message]);
        expect(fixture.delivered[0].id.senderId).toBe('logical-origin');
    });

    it.each([-1, 0, 1])('checks remaining consumer expiry after a handler returns at deadline %+i ms', async (offsetMs) => {
        let nowMs = 10_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const fixture = await createClientIngressFixture();
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
        const message = { ...incomingMessage(), constraints: { expiresAtMs } };

        await fixture.service.acceptIncomingMessage(message);

        expect(delivered).toEqual(offsetMs < 0 ? ['specific', 'wildcard'] : ['specific']);
        expect(fixture.delivered).toEqual(offsetMs < 0 ? [message] : []);
    });

    it('consumes malformed live socket input without throwing or poisoning the next message', async () => {
        const fixture = await createClientIngressFixture();
        const message = incomingMessage();

        fixture.socket.receive(JSON.stringify({ ...message, id: { ...message.id, v: 99 } }));
        fixture.socket.receive(JSON.stringify(message));

        await vi.waitFor(() => expect(fixture.delivered).toEqual([message]));
        expect(fixture.socket.sent).toEqual([]);
    });

    it('rejects an oversized live serialization before parsing even when its decoded envelope would be small', async () => {
        const fixture = await createClientIngressFixture();
        const message = incomingMessage();
        const serialized = ' '.repeat(AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes) + JSON.stringify(message);
        const parse = vi.spyOn(JSON, 'parse');

        fixture.socket.receive(serialized);

        expect(parse.mock.calls.some(([value]) => value === serialized)).toBe(false);
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
        fixture.socket.receive(JSON.stringify(message));
        await vi.waitFor(() => expect(fixture.delivered).toEqual([message]));
    });

    it('does not admit input after the client is closed', async () => {
        const fixture = await createClientIngressFixture();
        fixture.service.close();

        const accepted = await fixture.service.acceptIncomingMessage(incomingMessage());

        expect(accepted.right?.kind).toBe('disposed');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
    });

    it('stops later consumers when closed during a handler', async () => {
        const fixture = await createClientIngressFixture();
        const started = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        onTestFinished(() => resume.resolve());
        fixture.service.onInboxMessageDo('message.v1', {
            onMessage: async () => {
                started.resolve();
                await resume.promise;
            }
        });
        fixture.service.onAllInboxMessagesDo({
            onMessage: async (message) => {
                fixture.delivered.push(message);
            }
        });
        const receiving = fixture.service.acceptIncomingMessage(incomingMessage());
        await started.promise;

        fixture.service.close();
        resume.resolve();
        await receiving;

        expect(fixture.delivered).toEqual([]);
    });

    it('retries a failed socket submission instead of retiring its durable effect', async () => {
        vi.useFakeTimers();
        const fixture = await createClientIngressFixture();
        vi.spyOn(fixture.socket, 'send').mockImplementationOnce(() => {
            throw new Error('connection interrupted during send');
        });
        const incoming = incomingMessage();
        const message: ALMessage = {
            ...incoming,
            id: { ...incoming.id, ts: Date.now(), senderId: 'self' },
            targets: { mode: 'unicast', toPeerId: 'logical-origin' }
        };

        const result = await fixture.service.enqueueOutboxIfAbsent(message);
        expect(result.status).toBe('accepted');
        expect(fixture.socket.sent).toEqual([]);
        const retryAtMs = await fixture.outboundStore.peekNextEffectReadyAt();
        if (retryAtMs === undefined) {
            throw new Error('Expected retained retry work after the failed socket submission');
        }
        expect(retryAtMs).toBeGreaterThan(Date.now());
        await vi.advanceTimersByTimeAsync(retryAtMs - Date.now() - 1);
        expect(fixture.socket.sent).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);

        expect(fixture.socket.sent.map((serialized) => JSON.parse(serialized))).toMatchObject([message]);
        expect(fixture.delivered).toEqual([]);
    });

    it('retains accepted local delivery when an application handler fails and retries it', async () => {
        vi.useFakeTimers();
        const fixture = await createClientIngressFixture();
        let available = false;
        fixture.service.onInboxMessageDo('message.v1', {
            onMessage: async () => {
                if (!available) {
                    throw new Error('Application handler is temporarily unavailable');
                }
            }
        });
        const message = incomingMessage();

        expect((await fixture.service.acceptIncomingMessage(message)).right?.kind).toBe('admitted');
        expect(fixture.delivered).toEqual([]);
        const keys = await fixture.admissionStore.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        const retry = (await fixture.admissionStore.workQueue.getItem(keys[0]))!;
        expect(retry).toMatchObject({ status: 'RETRY', dequeueAudit: { attempts: 1 } });
        available = true;
        await vi.advanceTimersByTimeAsync(retry.dequeueAudit.nextTs!.epochMilliseconds - Date.now());
        await vi.waitFor(() => expect(fixture.delivered).toEqual([message]));
    });

    it('ignores a native event whose connection was replaced while an earlier listener was waiting', async () => {
        vi.useFakeTimers();
        const fixture = await createClientIngressFixture({
            onMessage: async () => await new Promise<void>((resolve) => setTimeout(resolve, 1))
        });
        const message = incomingMessage();
        fixture.socket.receive(JSON.stringify(message));
        fixture.socket.disconnect(1006, 'connection-lost');
        const reconnected = fixture.service.socket.connect();
        await Promise.resolve();
        const current = TestWebSocket.instances.at(-1)!;
        current.open();
        await reconnected;

        await vi.advanceTimersByTimeAsync(1);
        expect(fixture.delivered).toEqual([]);
        expect(fixture.admission.data.size).toBe(0);

        current.receive(JSON.stringify(message));
        await vi.advanceTimersByTimeAsync(1);
        expect(fixture.delivered).toEqual([message]);
    });
});

async function createClientIngressFixture(
    beforeMessage: OnWebSocketMessageCallback | undefined = undefined
): Promise<ClientIngressFixture> {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const client = new JsonWebSocketClient('ws://configured-server');
    if (beforeMessage) {
        client.onWebSocketMessageDo('earlier-listener', beforeMessage);
    }
    const connected = client.connect();
    await Promise.resolve();
    const socket = TestWebSocket.instances.at(-1)!;
    socket.open();
    await connected;
    const admission = createInMemoryALAdmissionState();
    const outbox = new InMemoryQueueBox(new Map());
    const delivered: ALMessage[] = [];
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        outboundBackend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), Date.now)
    });
    const admissionStore = createALInboundAdmissionStore({
        namespace: 'ws-client-ingress',
        backend: new InMemoryAdmissionBackend(admission, Date.now),
        orderingTrackTtlMs: 300000,
        supersedenceTrackTtlMs: 300000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const service = createDefaultWsQueueBoxClientService({
        outbox,
        socket: client,
        sessionId: 'self',
        inboundStores: { admissionStore },
        outboundStores
    }).enableDefaultCallbacks();
    service.onAnyInboxMessageDo('test-observer', {
        onMessage: async (message) => {
            delivered.push(message);
        }
    });
    onTestFinished(() => service.close());
    return { service, socket, admissionStore, outboundStore: outboundStores.admissionStore, outbox, admission, delivered };
}

function incomingMessage(): ALMessage {
    return {
        id: { v: 2, msgId: 'message-1', ts: 1, senderId: 'logical-origin' },
        route: { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
        targets: { mode: 'unicast', toPeerId: 'self' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}
