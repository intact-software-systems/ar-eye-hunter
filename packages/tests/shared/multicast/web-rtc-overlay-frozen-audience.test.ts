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
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { resolveALChannelSendDefaults } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import type { GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import { computeRtcRoomSnapshotAdmission } from '@shared/multicast/rtc-room-snapshot-admission.ts';
import { computeFrozenAudience, type RtcAudienceNarrowing } from '@shared/multicast/web-rtc-overlay-frozen-audience.ts';

import {
    createOriginOverlay,
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    readSentTargets,
    toOriginFrozenTargets,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';

function createFixture(
    input = { snapshot: createOriginSnapshot(['a', 'b', 'c'], 4), nextHopPeerIds: ['b', 'c'] }
): RtcOriginOverlayFixture {
    return createRtcOriginOverlayFixture(input);
}

describe('RTC frozen room audience', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('freezes the audience at admission and keeps expecting it after a later join and leave, the joiner only a hop', async () => {
        const fixture = createFixture();
        const message = createOriginReceiverMulticast('frozen');

        const admitted = await enqueueAndDrain(fixture.manager, message);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(readSentTargets(fixture.channels.b!)).toEqual([toOriginFrozenTargets(['b', 'c'], 4)]);
        expect(readSentTargets(fixture.channels.c!)).toEqual([toOriginFrozenTargets(['b', 'c'], 4)]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b', 'c'] });

        fixture.groups.accept('room', createOriginSnapshot(['a', 'b', 'c', 'd'], 5));
        fixture.groups.accept('room', createOriginSnapshot(['a', 'b', 'd'], 6));
        fixture.overlays.accept('room', createOriginOverlay(['b', 'd']));
        fixture.ready.peerIds = ['b', 'd'];
        // Inside the receipt budget (2 000 ms x 4 windows): the live row still expects the frozen audience.
        await vi.advanceTimersByTimeAsync(6_000);

        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b', 'c'] });
        // The joiner is a hop of the current tree, so the retry may pass through it, but only as the frozen copy.
        expect(fixture.channels.d!.sent.length).toBeGreaterThan(0);
        expect(new Set(readSentTargets(fixture.channels.d!).map((targets) => JSON.stringify(targets))))
            .toEqual(new Set([JSON.stringify(toOriginFrozenTargets(['b', 'c'], 4))]));

        // Past the budget the exhaustion commit deletes the row (D63).
        await vi.advanceTimersByTimeAsync(4_000);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toBeUndefined();
    });

    it('re-admits the unfrozen original as the duplicate of its frozen canonical', async () => {
        const fixture = createFixture();
        const message = createOriginReceiverMulticast('resent');

        await enqueueAndDrain(fixture.manager, message);
        fixture.groups.accept('room', createOriginSnapshot(['a', 'b', 'c', 'd'], 5));
        const resent = await enqueueAndDrain(fixture.manager, message);

        expect(resent.verdict.kind).toBe('duplicate');
        expect(resent.message.targets).toEqual(toOriginFrozenTargets(['b', 'c'], 4));
    });

    it('keeps a hop receipt on the next hops the plan reaches', async () => {
        const fixture = createFixture();
        const message = { ...createOriginReceiverMulticast('hop'), qos: { ack: { algo: 'hop' } } } as const;

        await enqueueAndDrain(fixture.manager, message);

        expect(readSentTargets(fixture.channels.b!)).toEqual([toOriginFrozenTargets(['b', 'c'], 4)]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'hop', expectedPeerIds: ['b', 'c'] });
    });

    it('settles a default notification send as rejected by the hop whose resync-required NACK it admits', async () => {
        const fixture = createFixture();
        const defaults = resolveALChannelSendDefaults({
            purpose: 'notification',
            durability: undefined,
            hasLogicalAudience: true
        });
        const message = newALMulticastMessage(
            'a',
            { topicId: 'chat', resourceId: 'default-relay-rejected', contextId: 'room' },
            ORIGIN_ROOM,
            'chat.message.v1',
            { text: 'default' },
            {
                reliability: defaults.reliability,
                ack: defaults.ack,
                ttlMs: defaults.ttlMs,
                qos: { durability: { algo: defaults.durability } }
            }
        );
        await enqueueAndDrain(fixture.manager, message);

        await fixture.manager.acceptControlMessage(newALNackControlMessage(
            { v: 3, msgId: 'nack-resync-from-b', senderId: 'b', ts: Date.now() },
            {
                msgId: message.id.msgId,
                fromPeerId: 'b',
                toPeerId: 'a',
                reason: 'resync-required',
                observedAtEpochMs: Date.now()
            }
        ));
        await vi.advanceTimersByTimeAsync(0);

        // The manager discards the admission verdict; only a committed resync-required NACK states relay-rejected.
        expect(fixture.settlements).toContainEqual(expect.objectContaining({
            kind: 'relay-rejected',
            msgId: message.id.msgId,
            relayRejection: { relay: 'peer', peerId: 'b', reason: 'resync-required' }
        }));
    });

    it('still leaves an explicit receipt-less send without a committed hop NACK (the carry stays for explicit ack none)', async () => {
        const fixture = createFixture();
        const message = newALMulticastMessage(
            'a',
            { topicId: 'chat', resourceId: 'receipt-less', contextId: 'room' },
            ORIGIN_ROOM,
            'chat.message.v1',
            { text: 'none' },
            { reliability: 'at-least-once', ack: 'none', ttlMs: 30_000 }
        );
        await enqueueAndDrain(fixture.manager, message);

        await fixture.manager.acceptControlMessage(newALNackControlMessage(
            { v: 3, msgId: 'nack-resync-receipt-less', senderId: 'b', ts: Date.now() },
            {
                msgId: message.id.msgId,
                fromPeerId: 'b',
                toPeerId: 'a',
                reason: 'resync-required',
                observedAtEpochMs: Date.now()
            }
        ));
        await vi.advanceTimersByTimeAsync(0);

        expect(fixture.settlements).not.toContainEqual(expect.objectContaining({
            kind: 'relay-rejected',
            msgId: message.id.msgId
        }));
    });
});

describe('the origin receipt of a frozen room multicast', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('freezes only the sessions the room authority admits, never an expired lease or a removed member', async () => {
        const fixture = createFixture({ snapshot: createSnapshotWithRefusedSessions(), nextHopPeerIds: ['b', 'c'] });
        const message = createOriginReceiverMulticast('authorized');

        await enqueueAndDrain(fixture.manager, message);

        expect(readSentTargets(fixture.channels.b!)).toEqual([toOriginFrozenTargets(['b', 'c'], 4)]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b', 'c'] });
    });

    it.each(
        [
            { ack: 'receiver', expectedPeerIds: ['b', 'c'] },
            { ack: 'hop', expectedPeerIds: ['b'] }
        ] as const
    )('expects $expectedPeerIds under $ack when the tree reaches c only through b', async ({ ack, expectedPeerIds }) => {
        const fixture = createFixture({ snapshot: createOriginSnapshot(['a', 'b', 'c'], 4), nextHopPeerIds: ['b'] });
        const message = { ...createOriginReceiverMulticast(`tree-${ack}`), qos: { ack: { algo: ack } } } as const;

        await enqueueAndDrain(fixture.manager, message);

        expect(readSentTargets(fixture.channels.b!)).toEqual([toOriginFrozenTargets(['b', 'c'], 4)]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: ack, expectedPeerIds });
    });

    it('keeps expecting the whole frozen audience after a recipient asks for a targeted repair', async () => {
        const fixture = createFixture();
        const message = { ...createOriginReceiverMulticast('nack-repair'), qos: { repair: { algo: 'retransmit' } } } as const;
        await enqueueAndDrain(fixture.manager, message);

        await fixture.manager.acceptControlMessage(newALNackControlMessage(
            { v: 3, msgId: 'nack-from-b', senderId: 'b', ts: Date.now() },
            { msgId: message.id.msgId, fromPeerId: 'b', toPeerId: 'a', reason: 'gap', observedAtEpochMs: Date.now() }
        ));
        await vi.advanceTimersByTimeAsync(100);

        expect(fixture.channels.b!.sent).toHaveLength(2);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b', 'c'] });
        // The repair copy is the copy of the repaired dispatch, so `b` still sees its sibling as visited.
        expect(fixture.channels.b!.sent[1]!.diagnostics).toEqual(fixture.channels.b!.sent[0]!.diagnostics);
    });

    it.each([
        { label: 'a changed payload', change: { payload: { typeId: 'chat.message.v1', resource: '{"text":"changed"}' } } },
        { label: 'another frozen audience', change: { targets: toOriginFrozenTargets(['b'], 4) } }
    ])('refuses a re-admission that brings $label against the frozen canonical', async ({ change }) => {
        const fixture = createFixture();
        const message = createOriginReceiverMulticast('canonical');
        await enqueueAndDrain(fixture.manager, message);

        const changed = await enqueueAndDrain(fixture.manager, { ...message, ...change });

        expect(changed.verdict).toMatchObject({ kind: 'failed' });
        expect(changed.reason).toContain('Stored AL admission');
    });
});

describe('the RTC room bound on a frozen audience (R-S2c-ii-13)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each(['none', 'hop', 'receiver'] as const)(
        'refuses a %s send to a room of 300 sessions as unsupported, naming the bound and sending nothing',
        async (ack) => {
            const fixture = createFixture({ snapshot: createOriginSnapshot(toRoomSessionIds(300), 4), nextHopPeerIds: ['b', 'c'] });
            const message = { ...createOriginReceiverMulticast(`oversize-${ack}`), qos: { ack: { algo: ack } } } as const;

            const admitted = await enqueueAndDrain(fixture.manager, message);

            expect(admitted.verdict).toEqual({
                kind: 'refused',
                reason: 'unsupported',
                detail: 'RTC room multicast audience of 299 recipients exceeds the RTC room limit of 256'
            });
            expect(fixture.channels.b!.sent).toEqual([]);
            expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
                .toBeUndefined();
        }
    );

    it.each(['none', 'hop', 'receiver'] as const)('still admits a %s send to a room of 257 sessions', async (ack) => {
        const fixture = createFixture({ snapshot: createOriginSnapshot(toRoomSessionIds(257), 4), nextHopPeerIds: ['b', 'c'] });
        const message = { ...createOriginReceiverMulticast(`at-bound-${ack}`), qos: { ack: { algo: ack } } } as const;

        const admitted = await enqueueAndDrain(fixture.manager, message);

        expect(admitted.verdict).toMatchObject({ kind: 'admitted' });
        expect(fixture.channels.b!.sent).toHaveLength(1);
        expect(fixture.channels.b!.sent[0]!.targets).toMatchObject({ recipientPeerIds: expect.any(Array) });
        expect((fixture.channels.b!.sent[0]!.targets as { recipientPeerIds: readonly string[]; }).recipientPeerIds)
            .toHaveLength(256);
    });
});

/** The origin `a`, its two next hops, and filler sessions up to `count`. */
function toRoomSessionIds(count: number): readonly string[] {
    return ['a', 'b', 'c', ...Array.from({ length: count - 3 }, (_, index) => `s${index}`)];
}

describe('computeFrozenAudience', () => {
    it('names the authorized sessions except the origin, at the snapshot version the authority was read at', () => {
        const room = createSnapshotWithRefusedSessions();
        const admission = computeRtcRoomSnapshotAdmission({
            message: createOriginReceiverMulticast('pure'),
            snapshot: room,
            overlay: createOriginOverlay(['b', 'c']),
            selfPeerId: 'a',
            fromPeerId: undefined,
            recipientPeerId: undefined,
            nowMs: Date.now()
        });
        if (admission.kind !== 'authorized') {
            throw new Error('The origin must be authorized in its own room');
        }

        expect(computeFrozenAudience({ admission, selfPeerId: 'a', narrowing: undefined }))
            .toEqual({ recipientPeerIds: ['b', 'c'], snapshotVersion: admission.snapshotVersion });
        expect(admission.snapshotVersion).toBe(4);
    });

    it.each<{ label: string; narrowing: RtcAudienceNarrowing; recipientPeerIds: readonly string[]; }>([
        { label: 'a principal', narrowing: { kind: 'principal', principalId: 'principal-1' }, recipientPeerIds: ['b', 'd'] },
        { label: 'a list', narrowing: { kind: 'list', recipientPeerIds: ['a', 'c', 'z'] }, recipientPeerIds: ['c'] }
    ])('narrows the authorized sessions except the origin to $label', ({ narrowing, recipientPeerIds }) => {
        const admission = computeRtcRoomSnapshotAdmission({
            message: createOriginReceiverMulticast('narrowed'),
            snapshot: createPrincipalSnapshot(),
            overlay: createOriginOverlay(['b', 'c']),
            selfPeerId: 'a',
            fromPeerId: undefined,
            recipientPeerId: undefined,
            nowMs: Date.now()
        });
        if (admission.kind !== 'authorized') {
            throw new Error('The origin must be authorized in its own room');
        }

        expect(computeFrozenAudience({ admission, selfPeerId: 'a', narrowing }))
            .toEqual({ recipientPeerIds, snapshotVersion: 4 });
    });
});

describe('the RTC leg of a principal or listed room send', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('freezes a principal broadcast in its room as the principal\'s other sessions, the multicast every copy and the receipt carry', async () => {
        const fixture = createFixture({ snapshot: createPrincipalSnapshot(), nextHopPeerIds: ['b', 'c'] });
        const message = createAudienceBroadcast('principal');

        const admitted = await enqueueLegAndDrain(fixture, message);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.targets).toEqual(toOriginFrozenTargets(['b', 'd'], 4));
        expect(readSentTargets(fixture.channels.b!)).toEqual([toOriginFrozenTargets(['b', 'd'], 4)]);
        expect(readSentTargets(fixture.channels.c!)).toEqual([toOriginFrozenTargets(['b', 'd'], 4)]);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b', 'd'] });
    });

    it('freezes a listed room broadcast as the listed sessions the room holds, less the excepted ones', async () => {
        const fixture = createFixture({ snapshot: createOriginSnapshot(['a', 'b', 'c', 'd'], 4), nextHopPeerIds: ['b', 'c'] });
        const message = createAudienceBroadcast('list');

        const admitted = await enqueueLegAndDrain(fixture, message);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.targets).toEqual(toOriginFrozenTargets(['c'], 4));
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['c'] });
    });

    it.each(
        [
            { audience: 'room', recipientPeerIds: ['b', 'c', 'd'] },
            { audience: 'principal', recipientPeerIds: ['b', 'd'] },
            { audience: 'list', recipientPeerIds: ['c'] }
        ] as const
    )(
        'holds a durable $audience send admitted before its room snapshot and freezes it to $recipientPeerIds when the snapshot arrives',
        async ({ audience, recipientPeerIds }) => {
            const fixture = createFixture({ snapshot: createPrincipalSnapshot(), nextHopPeerIds: ['b', 'c'] });
            fixture.groups.delete('room');
            const message = createAudienceBroadcast(audience, ORIGIN_ROOM, 'local-outbox');

            const admitted = await enqueueLegAndDrain(fixture, message);
            await vi.advanceTimersByTimeAsync(200);

            expect(admitted.verdict).toEqual({ kind: 'admitted', durable: true, queuedAttempts: 0 });
            expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);

            fixture.groups.accept('room', createPrincipalSnapshot());
            await vi.advanceTimersByTimeAsync(200);

            expect(readSentTargets(fixture.channels.b!)).toEqual([toOriginFrozenTargets(recipientPeerIds, 4)]);
            expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
                .toMatchObject({ mode: 'receiver', expectedPeerIds: recipientPeerIds });
        }
    );

    it.each(['world', 'all', 'principal'] as const)(
        'refuses a %s broadcast that names no room as unsupported, sending nothing',
        async (scope) => {
            const fixture = createFixture();
            const message = createRoomlessBroadcast(scope);

            const admitted = await enqueueLegAndDrain(fixture, message);

            expect(admitted.verdict).toEqual({
                kind: 'refused',
                reason: 'unsupported',
                detail: `RTC carries room audiences only: a ${scope} broadcast is unsupported`
            });
            expect(fixture.channels.b!.sent).toEqual([]);
        }
    );
});

const PRINCIPAL_REF = { applicationId: 'app', workspaceId: 'workspace', principalId: 'principal-1' };

function createAudienceBroadcast(
    audience: 'room' | 'principal' | 'list',
    groupRef = ORIGIN_ROOM,
    durability: 'volatile' | 'local-outbox' = 'volatile'
): ALMessage {
    const route = { topicId: 'chat', resourceId: `narrowed-${audience}`, contextId: groupRef.groupId };
    const options = {
        ack: 'all-logical-recipients',
        reliability: 'at-least-once',
        ttlMs: 30_000,
        qos: { durability: { algo: durability } }
    } as const;
    if (audience === 'room') {
        return newALMulticastMessage('a', route, groupRef, 'chat.message.v1', {}, options);
    }
    return audience === 'principal'
        ? newALPrincipalBroadcastMessage('a', route, { groupRef, principalRef: PRINCIPAL_REF }, 'chat.message.v1', {}, options)
        : newALBroadcastMessage('a', route, 'room', 'chat.message.v1', {}, {
            ...options,
            groupRef,
            recipientPeerIds: ['c', 'd', 'z'],
            exceptPeerIds: ['d']
        });
}

function createRoomlessBroadcast(scope: 'world' | 'all' | 'principal'): ALMessage {
    const route = { topicId: 'chat', resourceId: `roomless-${scope}`, contextId: 'app' };
    const message = newALBroadcastMessage('a', route, 'world', 'chat.message.v1', {}, { ttlMs: 30_000 });
    return scope === 'principal'
        ? { ...message, targets: { mode: 'broadcast', scope, principalRef: PRINCIPAL_REF } }
        : { ...message, targets: { mode: 'broadcast', scope } };
}

async function enqueueLegAndDrain(fixture: RtcOriginOverlayFixture, message: ALMessage) {
    const result = await fixture.manager.enqueueLegIfAbsent(message, 'hold');
    await vi.advanceTimersByTimeAsync(0);
    return result;
}

/** The room of `a`, `b`, `c` and `d`, where `a`, `b` and `d` are sessions of one principal. */
function createPrincipalSnapshot(): GroupSnapshot {
    const snapshot = createOriginSnapshot(['a', 'b', 'c', 'd'], 4);
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) =>
            ['a', 'b', 'd'].includes(session.sessionId) ? { ...session, principalId: PRINCIPAL_REF.principalId } : session
        ),
        members: [...snapshot.members, { ...snapshot.members[0]!, principalId: PRINCIPAL_REF.principalId }]
    };
}

/** Sessions a snapshot still lists but the room authority refuses: `x` has an expired lease, `y` was removed. */
function createSnapshotWithRefusedSessions(): GroupSnapshot {
    const snapshot = createOriginSnapshot(['a', 'b', 'c', 'x', 'y'], 4);
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => session.sessionId === 'x' ? { ...session, expiresAtEpochMs: Date.now() } : session),
        members: snapshot.members.map((member) => member.principalId === 'y' ? toRemovedMember(member) : member)
    };
}

function toRemovedMember(member: GroupMember): GroupMember {
    return { ...member, status: 'removed', left: null, removed: member.updated, banned: null };
}
