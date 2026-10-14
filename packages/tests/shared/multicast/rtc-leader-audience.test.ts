import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALPrincipalBroadcastMessage,
    type ALMessage,
    type ALTargets
} from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { room, RtcEndpointFixture } from '../rtc-endpoint-fixture.ts';

import {
    createOriginPrincipalSnapshot,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_PRINCIPAL_REF,
    ORIGIN_ROOM,
    readSentTargets,
    toOriginDirectedSnapshot,
    toOriginFrozenTargets,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';

type LeaderAudience = 'room multicast' | 'room broadcast' | 'room except' | 'principal' | 'list';

const LEADER_FLOORS = { minSnapshotVersion: 4, rosterVersion: 4 } as const;
/** A `command` send's first ACK timeout: a receipt confirmed before it needed no retransmission. */
const LEADER_ACK_TIMEOUT_MS = 2_000;

describe('the RTC leg of a group-leader room send', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each<LeaderAudience>(['room multicast', 'room broadcast', 'principal', 'list'])(
        'freezes a group-leader %s send as the director session alone, the one recipient its leader receipt expects',
        async (audience) => {
            const fixture = createLeaderFixture(createDirectedSnapshot('d'));
            const message = createLeaderSend(audience, ['b', 'd']);

            const admitted = await enqueueLegAndDrain(fixture, message);

            expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
            expect(admitted.message.targets).toEqual(toLeaderFrozenTargets(['d']));
            expect(readSentTargets(fixture.channels.b!)).toEqual([toLeaderFrozenTargets(['d'])]);
            expect(readSentTargets(fixture.channels.c!)).toEqual([toLeaderFrozenTargets(['d'])]);
            expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
                .toMatchObject({ mode: 'leader', expectedPeerIds: ['d'] });
        }
    );

    it('completes concurrent direct and multihop leader receipts through the same origin-and-relay owner', async () => {
        vi.useRealTimers();
        // 02 owns its direct receipts while relaying 03's leader controls through 04; 08 is 03's leaf side branch.
        const messages = ['03', '02'].flatMap((senderId) =>
            Array.from({ length: 6 }, (_, index) =>
                newALMulticastMessage(
                    senderId,
                    { topicId: 'room.ar-eye-hunter.director', resourceId: `${senderId}-shot-${index + 1}`, contextId: room.groupId },
                    room,
                    'room.ar-eye-hunter.director.intent.v1',
                    { kind: 'player-shot-intent', senderId, seq: index + 1 },
                    { ack: 'group-leader', reliability: 'at-least-once', ttlMs: 30_000, qos: { durability: { algo: 'volatile' } } }
                ))
        );
        const deliveryWaiters = new Map(messages.map((message) => [message.id.msgId, Promise.withResolvers<ALMessage>()]));
        const receiptWaiters = new Map(messages.map((message) => [message.id.msgId, Promise.withResolvers<ALDeliverySettlement>()]));
        const receipts: ALDeliverySettlement[] = [];
        const topology = [
            ['03', ['04', '08']],
            ['04', ['03', '02']],
            ['02', ['04', 'director']],
            ['director', ['02']],
            ['08', ['03']]
        ] as const;
        const endpoints = topology.map(([sessionId, peerIds]) => {
            const endpoint = new RtcEndpointFixture(sessionId, peerIds, {
                outboundSettlements: (settlement) => {
                    if (
                        settlement.kind !== 'acknowledgement' ||
                        !messages.some((message) => message.id.msgId === settlement.msgId && message.id.senderId === sessionId)
                    ) {
                        return;
                    }
                    receipts.push(settlement);
                    if (settlement.complete) {
                        receiptWaiters.get(settlement.msgId)?.resolve(settlement);
                    }
                },
                inbox: {
                    onMessage: async (message) => {
                        if (sessionId === 'director') {
                            deliveryWaiters.get(message.id.msgId)?.resolve(message);
                        }
                    }
                }
            });
            onTestFinished(() => endpoint.close());
            return endpoint;
        });
        const bySession = new Map(endpoints.map((endpoint) => [endpoint.sessionId, endpoint]));
        for (const endpoint of endpoints) {
            endpoint.observe(1, room, ['03', '04', '02', 'director', '08']);
            endpoint.observeOverlay(1);
            const key = toScopedOverlayId(room);
            endpoint.groups.set(key, toOriginDirectedSnapshot(endpoint.groups.read(key)!, 'director', Date.now()));
            for (const peerId of endpoint.peers.keys()) {
                endpoint.connect(bySession.get(peerId)!);
            }
        }

        const admitted = await Promise.all(messages.map((message) => bySession.get(message.id.senderId)!.multicast.enqueueIfAbsent(message)));
        expect(admitted.every((result) => result.verdict.kind === 'admitted')).toBe(true);
        const completed = await Promise.all([
            ...[...deliveryWaiters.values()].map((waiter) => waiter.promise),
            ...[...receiptWaiters.values()].map((waiter) => waiter.promise)
        ]);

        expect(completed).toHaveLength(24);
        expect(bySession.get('director')!.delivered.map((message) => message.id.msgId).toSorted())
            .toEqual(messages.map((message) => message.id.msgId).toSorted());
        expect(endpoints.filter((endpoint) => endpoint.sessionId !== 'director').flatMap((endpoint) => endpoint.delivered)).toEqual([]);
        const completeReceipts = receipts.filter((settlement) => settlement.kind === 'acknowledgement' && settlement.complete);
        expect(completeReceipts).toHaveLength(12);
        for (const receipt of completeReceipts) {
            expect(receipt).toMatchObject({
                mode: 'leader',
                expectedRecipientPeerIds: ['director'],
                confirmedRecipientPeerIds: ['director'],
                unconfirmedRecipientPeerIds: [],
                complete: true
            });
        }
        for (const message of messages) {
            const copies = endpoints.flatMap((endpoint) => endpoint.sent).filter((copy) => copy.id.msgId === message.id.msgId);
            expect(copies.length).toBeGreaterThan(0);
            for (const copy of copies) {
                expect(copy.id).toEqual(message.id);
                expect(copy.delivery).toEqual(message.delivery);
                expect(copy.constraints).toEqual(message.constraints);
                expect(copy.payload).toEqual(message.payload);
                expect(copy.targets).toMatchObject({ mode: 'multicast', groupRef: room, recipientPeerIds: ['director'], snapshotVersion: 1 });
            }
            const leaderAck = {
                ackedMsgId: message.id.msgId,
                originPeerId: message.id.senderId,
                logicalRecipientPeerId: 'director',
                carrier: 'rtc'
            };
            expect(bySession.get('director')!.sent.map(parseALControlMessage)).toContainEqual({
                type: 'ack',
                payload: expect.objectContaining({ ...leaderAck, fromPeerId: 'director', toPeerId: '02', status: 'delivered' })
            });
            if (message.id.senderId === '03') {
                for (const [relay, parent] of [['02', '04'], ['04', '03']]) {
                    expect(bySession.get(relay)!.sent.map(parseALControlMessage)).toContainEqual({
                        type: 'ack',
                        payload: expect.objectContaining({ ...leaderAck, fromPeerId: relay, toPeerId: parent, status: 'forwarded' })
                    });
                }
            }
            expect(bySession.get(message.id.senderId)!.received.map(parseALControlMessage)).toContainEqual({
                type: 'ack',
                payload: expect.objectContaining({ ...leaderAck, toPeerId: message.id.senderId })
            });
        }
    });

    it('confirms a leader receipt from a director that relays to a silent leaf, with one ACK reaching the origin', async () => {
        const message = newALMulticastMessage(
            'origin',
            { topicId: 'room.ar-eye-hunter.director', resourceId: 'internal-director-shot', contextId: room.groupId },
            room,
            'room.ar-eye-hunter.director.intent.v1',
            { kind: 'player-shot-intent', senderId: 'origin', seq: 1 },
            { ack: 'group-leader', reliability: 'at-least-once', ttlMs: 30_000, qos: { durability: { algo: 'volatile' } } }
        );
        const receipts: ALDeliverySettlement[] = [];
        const topology = [
            ['origin', ['relay']],
            ['relay', ['origin', 'director']],
            ['director', ['relay', 'leaf-a', 'leaf-b', 'silent']],
            ['leaf-a', ['director']],
            ['leaf-b', ['director']]
        ] as const;
        const endpoints = topology.map(([sessionId, peerIds]) => {
            const endpoint = new RtcEndpointFixture(sessionId, peerIds, {
                outboundSettlements: (settlement) => {
                    if (settlement.kind === 'acknowledgement' && settlement.msgId === message.id.msgId) {
                        receipts.push(settlement);
                    }
                }
            });
            onTestFinished(() => endpoint.close());
            return endpoint;
        });
        const bySession = new Map(endpoints.map((endpoint) => [endpoint.sessionId, endpoint]));
        for (const endpoint of endpoints) {
            endpoint.observe(1, room, ['origin', 'relay', 'director', 'leaf-a', 'leaf-b', 'silent']);
            endpoint.observeOverlay(1);
            const key = toScopedOverlayId(room);
            endpoint.groups.set(key, toOriginDirectedSnapshot(endpoint.groups.read(key)!, 'director', Date.now()));
            for (const peerId of endpoint.peers.keys()) {
                const remote = bySession.get(peerId);
                if (remote !== undefined) {
                    endpoint.connect(remote);
                }
            }
        }
        vi.spyOn(bySession.get('director')!.peers.get('silent')!.channel, 'sendJson')
            .mockReturnValue({ status: 'sent', bufferedAmount: 0 });

        const admitted = await bySession.get('origin')!.multicast.enqueueIfAbsent(message);
        await vi.advanceTimersByTimeAsync(LEADER_ACK_TIMEOUT_MS - 1);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(receipts.filter((receipt) => receipt.kind === 'acknowledgement' && receipt.complete)).toEqual([
            expect.objectContaining({
                mode: 'leader',
                expectedRecipientPeerIds: ['director'],
                confirmedRecipientPeerIds: ['director'],
                complete: true
            })
        ]);
        expect(readAckSenders(bySession.get('director')!, message)).toEqual(['leaf-a', 'leaf-b']);
        expect(readAckSenders(bySession.get('origin')!, message)).toEqual(['relay']);
    });

    it.each([{ readyPeerIds: [] }, { readyPeerIds: ['r'] }])(
        'hands over a missing accepted RTC edge with ready peers $readyPeerIds, then admits that edge when ready',
        async ({ readyPeerIds }) => {
            const directed = toOriginDirectedSnapshot(createOriginSnapshot(['a', 'b', 'c', 'd'], 4), 'd', Date.now());
            const snapshot = { ...directed, causalRevision: { groupRevision: 4, presenceRevision: 4 } };
            validateAuthoritativeGroupSnapshot(snapshot, ORIGIN_ROOM);
            const fixture = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b'] });
            const message = createLeaderSend('room multicast', []);
            fixture.ready.peerIds = readyPeerIds;

            const result = await fixture.manager.enqueueLegIfAbsent(message, 'hand-over');
            await vi.advanceTimersByTimeAsync(0);

            expect(result.verdict).toMatchObject({ kind: 'unroutable', reason: 'no-route' });
            expect(result.entries).toEqual([]);
            expect(result.message.id).toEqual(message.id);
            expect(result.message.delivery).toEqual(message.delivery);
            expect(result.message.constraints).toEqual(message.constraints);
            expect(result.message.targets).toEqual(message.targets);
            expect(await fixture.resources.workQueue.getAllKeys()).toEqual([]);
            expect(Object.values(fixture.channels).flatMap((channel) => channel.sent)).toEqual([]);
            expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
                .toBeUndefined();

            fixture.ready.peerIds = ['b', 'r'];
            const admitted = await fixture.manager.enqueueLegIfAbsent(message, 'hand-over');
            await vi.advanceTimersByTimeAsync(0);

            expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
            expect(admitted.message.targets).toEqual(toLeaderFrozenTargets(['d']));
            expect(readSentTargets(fixture.channels.b!)).toEqual([toLeaderFrozenTargets(['d'])]);
            expect(fixture.channels.r!.sent).toEqual([]);
            expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
                .toMatchObject({ mode: 'leader', expectedPeerIds: ['d'] });
        }
    );

    it.each(['direct', 'hold'] as const)('keeps %s RTC route waiting when the accepted edge is absent', async (strategy) => {
        const directed = toOriginDirectedSnapshot(createOriginSnapshot(['a', 'b', 'c', 'd'], 4), 'd', Date.now());
        const snapshot = { ...directed, causalRevision: { groupRevision: 4, presenceRevision: 4 } };
        validateAuthoritativeGroupSnapshot(snapshot, ORIGIN_ROOM);
        const fixture = createLeaderFixture(snapshot);
        fixture.ready.peerIds = [];
        const message = createLeaderSend('room multicast', [], 'local-outbox');

        const admitted = strategy === 'direct'
            ? await fixture.manager.enqueueIfAbsent(message)
            : await fixture.manager.enqueueLegIfAbsent(message, 'hold');
        await vi.advanceTimersByTimeAsync(0);

        expect(admitted.verdict).toMatchObject({ kind: 'admitted', durable: true });
        expect(admitted.message.targets).toEqual(toLeaderFrozenTargets(['d']));
        expect(Object.values(fixture.channels).flatMap((channel) => channel.sent)).toEqual([]);
        fixture.ready.peerIds = ['b', 'c'];
        await vi.advanceTimersByTimeAsync(100);
        expect(readSentTargets(fixture.channels.b!)).toEqual([toLeaderFrozenTargets(['d'])]);
    });

    it.each([
        { denial: 'no leader', verdict: { kind: 'refused', reason: 'no-leader' } },
        { denial: 'unsupported receipt', verdict: { kind: 'refused', reason: 'unsupported' } },
        { denial: 'forbidden repair', verdict: { kind: 'skipped', reason: 'planner-drop' } }
    ])('preserves $denial on a hand-over leg with an absent accepted edge', async ({ denial, verdict }) => {
        const origin = createOriginSnapshot(['a', 'b', 'c', 'd'], 4);
        const directed = denial === 'no leader' ? origin : toOriginDirectedSnapshot(origin, 'd', Date.now());
        const snapshot = { ...directed, causalRevision: { groupRevision: 4, presenceRevision: 4 } };
        validateAuthoritativeGroupSnapshot(snapshot, ORIGIN_ROOM);
        const fixture = createRtcOriginOverlayFixture({
            snapshot,
            nextHopPeerIds: ['b'],
            qosProvider: denial === 'forbidden repair' ? { authorizationForMessage: () => ({ allowedRepairs: [] }) } : undefined
        });
        fixture.ready.peerIds = ['r'];
        const original = createLeaderSend('room multicast', []);
        const message: ALMessage = denial === 'unsupported receipt'
            ? {
                ...original,
                delivery: { ...original.delivery, reliability: 'at-least-once', ack: 'receiver' },
                qos: { ...original.qos, ack: { algo: 'leader' } }
            }
            : original;

        const result = await fixture.manager.enqueueLegIfAbsent(message, 'hand-over');
        await vi.advanceTimersByTimeAsync(0);

        expect(result.verdict).toMatchObject(verdict);
        expect(result.entries).toEqual([]);
        expect(Object.values(fixture.channels).flatMap((channel) => channel.sent)).toEqual([]);
    });

    it('keeps a leader send frozen to the director it was admitted to after the room appoints another', async () => {
        const fixture = createLeaderFixture(createDirectedSnapshot('d'));
        const message = createLeaderSend('room multicast', []);
        await enqueueLegAndDrain(fixture, message);

        fixture.groups.accept('room', createDirectedSnapshot('c'));
        await vi.advanceTimersByTimeAsync(3_000);

        expect(readSentTargets(fixture.channels.b!)).toEqual([toLeaderFrozenTargets(['d']), toLeaderFrozenTargets(['d'])]);
        expect(readSentTargets(fixture.channels.c!)).toEqual([toLeaderFrozenTargets(['d']), toLeaderFrozenTargets(['d'])]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'leader', expectedPeerIds: ['d'] });
    });

    it('retries a leader send its director has not confirmed toward the director, frozen to it and expected alone', async () => {
        const fixture = createRtcOriginOverlayFixture({ snapshot: createDirectedSnapshot('d'), nextHopPeerIds: ['b', 'c', 'd'] });
        const message = createLeaderSend('room multicast', []);
        await enqueueLegAndDrain(fixture, message);

        await vi.advanceTimersByTimeAsync(3_000);

        expect(readSentTargets(fixture.channels.d!)).toEqual([toLeaderFrozenTargets(['d']), toLeaderFrozenTargets(['d'])]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'leader', expectedPeerIds: ['d'], attempts: 1 });
    });

    it.each<{ label: string; snapshot: GroupSnapshot; audience: LeaderAudience; }>([
        { label: 'the room appoints no director', snapshot: createOriginPrincipalSnapshot(), audience: 'room multicast' },
        { label: 'the appointed director is not present', snapshot: createDirectedSnapshot('z'), audience: 'room multicast' },
        { label: 'the director\'s session lease has expired', snapshot: toLeaseExpired(createDirectedSnapshot('d'), 'd'), audience: 'room multicast' },
        { label: 'the sender is the director', snapshot: createDirectedSnapshot('a'), audience: 'room broadcast' },
        { label: 'the list leaves the director out', snapshot: createDirectedSnapshot('c'), audience: 'list' },
        { label: 'the principal is not the director\'s', snapshot: createDirectedSnapshot('c'), audience: 'principal' },
        { label: 'the exceptions name the director', snapshot: createDirectedSnapshot('d'), audience: 'room except' }
    ])('refuses a group-leader send as no-leader when $label, sending nothing', async ({ snapshot, audience }) => {
        const fixture = createLeaderFixture(snapshot);
        const message = createLeaderSend(audience, ['b', 'd']);

        const admitted = await enqueueLegAndDrain(fixture, message);

        expect(admitted.verdict).toMatchObject({ kind: 'refused', reason: 'no-leader' });
        expect(admitted.message.targets).toEqual(message.targets);
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toBeUndefined();
    });

    it('refuses a room send that asks for a leader receipt by quality of service alone as unsupported, sending nothing', async () => {
        const fixture = createLeaderFixture(createDirectedSnapshot('d'));
        const message = newALMulticastMessage(
            'a',
            { topicId: 'chat', resourceId: 'qos-leader', contextId: ORIGIN_ROOM.groupId },
            ORIGIN_ROOM,
            'chat.message.v1',
            {},
            {
                ack: 'receiver',
                reliability: 'at-least-once',
                ttlMs: 30_000,
                qos: { ack: { algo: 'leader' } }
            }
        );

        const admitted = await enqueueLegAndDrain(fixture, message);

        expect(admitted.verdict).toMatchObject({ kind: 'refused', reason: 'unsupported' });
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
    });

    it('holds a durable group-leader send admitted before its room snapshot and freezes it to the director when the snapshot arrives', async () => {
        const fixture = createLeaderFixture(createDirectedSnapshot('d'));
        fixture.groups.delete('room');
        const message = createLeaderSend('room broadcast', [], 'local-outbox');

        const admitted = await enqueueLegAndDrain(fixture, message);
        await vi.advanceTimersByTimeAsync(200);

        expect(admitted.verdict).toEqual({ kind: 'admitted', durable: true, queuedAttempts: 0 });
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);

        fixture.groups.accept('room', createDirectedSnapshot('d'));
        await vi.advanceTimersByTimeAsync(200);

        expect(readSentTargets(fixture.channels.b!)).toEqual([toLeaderFrozenTargets(['d'])]);
        expect(readSentTargets(fixture.channels.c!)).toEqual([toLeaderFrozenTargets(['d'])]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'leader', expectedPeerIds: ['d'] });
    });
});

function createLeaderFixture(snapshot: GroupSnapshot): RtcOriginOverlayFixture {
    return createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'] });
}

/** The room of `a`, `b`, `c` and `d` (`a`, `b` and `d` sessions of one principal) with its director appointed. */
function createDirectedSnapshot(directorSessionId: string): GroupSnapshot {
    return toOriginDirectedSnapshot(createOriginPrincipalSnapshot(), directorSessionId, Date.now());
}

function toLeaseExpired(snapshot: GroupSnapshot, sessionId: string): GroupSnapshot {
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => session.sessionId === sessionId ? { ...session, expiresAtEpochMs: 1 } : session)
    };
}

function toLeaderFrozenTargets(recipientPeerIds: readonly string[]): ALTargets {
    return { ...toOriginFrozenTargets(recipientPeerIds, 4), ...LEADER_FLOORS };
}

function createLeaderSend(
    audience: LeaderAudience,
    namedPeerIds: readonly string[],
    durability: 'volatile' | 'local-outbox' = 'volatile'
): ALMessage {
    const route = { topicId: 'chat', resourceId: `leader-${audience}`, contextId: ORIGIN_ROOM.groupId };
    const options = {
        ack: 'group-leader',
        reliability: 'at-least-once',
        ttlMs: 30_000,
        qos: { durability: { algo: durability } },
        ...LEADER_FLOORS
    } as const;
    switch (audience) {
        case 'room multicast':
            return newALMulticastMessage('a', route, ORIGIN_ROOM, 'chat.message.v1', {}, options);
        case 'room broadcast':
            return newALBroadcastMessage('a', route, 'room', 'chat.message.v1', {}, { ...options, groupRef: ORIGIN_ROOM });
        case 'room except':
            return newALBroadcastMessage('a', route, 'room', 'chat.message.v1', {}, {
                ...options,
                groupRef: ORIGIN_ROOM,
                exceptPeerIds: namedPeerIds
            });
        case 'principal':
            return newALPrincipalBroadcastMessage(
                'a',
                route,
                { groupRef: ORIGIN_ROOM, principalRef: ORIGIN_PRINCIPAL_REF },
                'chat.message.v1',
                {},
                options
            );
        case 'list':
            return newALBroadcastMessage('a', route, 'room', 'chat.message.v1', {}, {
                ...options,
                groupRef: ORIGIN_ROOM,
                recipientPeerIds: namedPeerIds
            });
    }
}

/** The hops whose ACKs about `message` this endpoint received, one entry per ACK. */
function readAckSenders(endpoint: RtcEndpointFixture, message: ALMessage): readonly string[] {
    return endpoint.received
        .map(parseALControlMessage)
        .flatMap((control) => control?.type === 'ack' && control.payload.ackedMsgId === message.id.msgId ? [control.payload.fromPeerId] : [])
        .toSorted();
}

async function enqueueLegAndDrain(fixture: RtcOriginOverlayFixture, message: ALMessage): Promise<ALOutboundEnqueueResult> {
    const result = await fixture.manager.enqueueLegIfAbsent(message, 'hold');
    await vi.advanceTimersByTimeAsync(0);
    return result;
}
