import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALPrincipalBroadcastMessage,
    type ALMessage,
    type ALTargets
} from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import {
    acknowledgeAtOrigin,
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
            const fixture = createLeaderFixture(toDirectedSnapshot('d'));
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

    it('completes the leader receipt on the director\'s ACK alone', async () => {
        const fixture = createLeaderFixture(toDirectedSnapshot('d'));
        const message = createLeaderSend('room multicast', []);

        await enqueueLegAndDrain(fixture, message);
        await acknowledgeAtOrigin(fixture.manager, {
            msgId: message.id.msgId,
            fromPeerId: 'b',
            logicalRecipientPeerId: 'd',
            status: 'delivered'
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            mode: 'leader',
            expectedRecipientPeerIds: ['d'],
            confirmedRecipientPeerIds: ['d'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
    });

    it.each([{ readyPeerIds: [] }, { readyPeerIds: ['r'] }])(
        'hands over a missing accepted RTC edge with ready peers $readyPeerIds, then admits that edge when ready',
        async ({ readyPeerIds }) => {
            const directed = toOriginDirectedSnapshot(createOriginSnapshot(['a', 'b', 'c', 'd'], 4), 'd');
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
        const directed = toOriginDirectedSnapshot(createOriginSnapshot(['a', 'b', 'c', 'd'], 4), 'd');
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
        const directed = denial === 'no leader' ? origin : toOriginDirectedSnapshot(origin, 'd');
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
        const fixture = createLeaderFixture(toDirectedSnapshot('d'));
        const message = createLeaderSend('room multicast', []);
        await enqueueLegAndDrain(fixture, message);

        fixture.groups.accept('room', toDirectedSnapshot('c'));
        await vi.advanceTimersByTimeAsync(3_000);

        expect(readSentTargets(fixture.channels.b!)).toEqual([toLeaderFrozenTargets(['d']), toLeaderFrozenTargets(['d'])]);
        expect(readSentTargets(fixture.channels.c!)).toEqual([toLeaderFrozenTargets(['d']), toLeaderFrozenTargets(['d'])]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'leader', expectedPeerIds: ['d'] });
    });

    it('retries a leader send its director has not confirmed toward the director, frozen to it and expected alone', async () => {
        const fixture = createRtcOriginOverlayFixture({ snapshot: toDirectedSnapshot('d'), nextHopPeerIds: ['b', 'c', 'd'] });
        const message = createLeaderSend('room multicast', []);
        await enqueueLegAndDrain(fixture, message);

        await vi.advanceTimersByTimeAsync(3_000);

        expect(readSentTargets(fixture.channels.d!)).toEqual([toLeaderFrozenTargets(['d']), toLeaderFrozenTargets(['d'])]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'leader', expectedPeerIds: ['d'], attempts: 1 });
    });

    it.each<{ label: string; snapshot: GroupSnapshot; audience: LeaderAudience; }>([
        { label: 'the room appoints no director', snapshot: createOriginPrincipalSnapshot(), audience: 'room multicast' },
        { label: 'the appointed director is not present', snapshot: toDirectedSnapshot('z'), audience: 'room multicast' },
        { label: 'the director\'s session lease has expired', snapshot: toLeaseExpired(toDirectedSnapshot('d'), 'd'), audience: 'room multicast' },
        { label: 'the sender is the director', snapshot: toDirectedSnapshot('a'), audience: 'room broadcast' },
        { label: 'the list leaves the director out', snapshot: toDirectedSnapshot('c'), audience: 'list' },
        { label: 'the principal is not the director\'s', snapshot: toDirectedSnapshot('c'), audience: 'principal' },
        { label: 'the exceptions name the director', snapshot: toDirectedSnapshot('d'), audience: 'room except' }
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
        const fixture = createLeaderFixture(toDirectedSnapshot('d'));
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
        const fixture = createLeaderFixture(toDirectedSnapshot('d'));
        fixture.groups.delete('room');
        const message = createLeaderSend('room broadcast', [], 'local-outbox');

        const admitted = await enqueueLegAndDrain(fixture, message);
        await vi.advanceTimersByTimeAsync(200);

        expect(admitted.verdict).toEqual({ kind: 'admitted', durable: true, queuedAttempts: 0 });
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);

        fixture.groups.accept('room', toDirectedSnapshot('d'));
        await vi.advanceTimersByTimeAsync(200);

        expect(readSentTargets(fixture.channels.b!)).toEqual([toLeaderFrozenTargets(['d'])]);
        expect(readSentTargets(fixture.channels.c!)).toEqual([toLeaderFrozenTargets(['d'])]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'leader', expectedPeerIds: ['d'] });
    });
});

const LEADER_FLOORS = { minSnapshotVersion: 4, rosterVersion: 4 } as const;

function createLeaderFixture(snapshot: GroupSnapshot): RtcOriginOverlayFixture {
    return createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'] });
}

/** The room of `a`, `b`, `c` and `d` (`a`, `b` and `d` sessions of one principal) with its director appointed. */
function toDirectedSnapshot(directorSessionId: string): GroupSnapshot {
    return toOriginDirectedSnapshot(createOriginPrincipalSnapshot(), directorSessionId);
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

async function enqueueLegAndDrain(fixture: RtcOriginOverlayFixture, message: ALMessage): Promise<ALOutboundEnqueueResult> {
    const result = await fixture.manager.enqueueLegIfAbsent(message, 'hold');
    await vi.advanceTimersByTimeAsync(0);
    return result;
}
