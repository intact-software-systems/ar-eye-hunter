import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { readALInboundStoredMessage } from '@shared/alm/inbound/al-inbound-canonical-message.ts';
import { decodeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';
import { waitForSettledALInboundWork } from '../wait-for-al-inbound-work.ts';
import { createIncomingMessage, createRoomMessage, createServerIngressFixture } from './ws-queue-box-server-ingress-fixture.ts';

describe('WS server inbound delivery and relay', () => {
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

    it('restarts owned delivery without requiring new ingress', async () => {
        const fixture = await createServerIngressFixture();
        fixture.service.removeAnyInboxMessageCallback('observer');
        const message = createIncomingMessage();
        await fixture.service.acceptIncomingMessage(message, 'session-1');
        fixture.service.dispose();
        const resumed = createDefaultWsQueueBoxServerService({
            readAuthenticatedConnectionScope: () => undefined,
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
            sendNacks: false,
            authorize: async () => {
                authorityReads += 1;
                if (authorityReads > 1) {
                    await Promise.resolve();
                    nowMs = expiresAtMs + offsetMs;
                }
                return { authorized: true, roomAudience: { recipientPeerIds: effect === 'forward' ? ['recipient'] : [], snapshotVersion: 1 } };
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

    it('does not relay to recipients removed by delivery-time authorization', async () => {
        const fixture = await createServerIngressFixture();
        fixture.service.removeAnyInboxMessageCallback('observer');
        const recipient = new SimulatedWebSocket('ws://recipient');
        await recipient.open();
        fixture.server.addConnection(new ConnectionContext({ id: 'recipient', socket: recipient }));
        let authorityReads = 0;
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: false,
            authorize: async () => {
                authorityReads += 1;
                await Promise.resolve();
                return { authorized: true, roomAudience: { recipientPeerIds: authorityReads === 1 ? ['recipient'] : [], snapshotVersion: 1 } };
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

    it.each(['unauthorized', 'membership-fenced'] as const)(
        'completes already queued messages without delivery or a NACK when current room authority is %s',
        async (reason) => {
            const fixture = await createServerIngressFixture();
            const claim = vi.spyOn(fixture.admission.workQueue, 'reserveEntries').mockResolvedValue(new Map());
            let authorized = true;
            fixture.service.authorizeInboundMessagesWith({
                sendNacks: true,
                authorize: async () =>
                    authorized
                        ? { authorized: true }
                        : { authorized: false, reason, logMessage: 'Membership removed', sendNack: true }
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
            expect(fixture.socket.sent).toEqual([]);
        }
    );

    it('leaves queued delivery retryable while current room evidence catches up', async () => {
        const fixture = await createServerIngressFixture();
        const claim = vi.spyOn(fixture.admission.workQueue, 'reserveEntries').mockResolvedValue(new Map());
        let catchingUp = false;
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: false,
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
});
