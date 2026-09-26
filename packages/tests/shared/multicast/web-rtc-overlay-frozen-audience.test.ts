import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type { GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import { computeRtcRoomSnapshotAdmission } from '@shared/multicast/rtc-room-snapshot-admission.ts';
import { computeFrozenAudience } from '@shared/multicast/web-rtc-overlay-frozen-audience.ts';

import {
    createOriginOverlay,
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
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
        await vi.advanceTimersByTimeAsync(10_000);

        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b', 'c'] });
        // The joiner is a hop of the current tree, so the retry may pass through it, but only as the frozen copy.
        expect(fixture.channels.d!.sent.length).toBeGreaterThan(0);
        expect(new Set(readSentTargets(fixture.channels.d!).map((targets) => JSON.stringify(targets))))
            .toEqual(new Set([JSON.stringify(toOriginFrozenTargets(['b', 'c'], 4))]));
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
            { v: 2, msgId: 'nack-from-b', senderId: 'b', ts: Date.now() },
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

        expect(computeFrozenAudience({ admission, selfPeerId: 'a' }))
            .toEqual({ recipientPeerIds: ['b', 'c'], snapshotVersion: admission.snapshotVersion });
        expect(admission.snapshotVersion).toBe(4);
    });
});

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
