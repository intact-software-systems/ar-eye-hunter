import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALPeerControlMessage } from '@shared/al-contracts/al-control.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { verifyTestALReceiptControl } from '../../../al-control-test-payloads.ts';
import { createRtcOriginOverlayFixture, enqueueAndDrain, ORIGIN_ROOM } from '../rtc-origin-overlay-fixture.ts';
import { createRelayChain, type RelayChain } from '../rtc-relay-chain-test-support.ts';
import { createRtcRelayOverlayFixture } from '../rtc-relay-overlay-fixture.ts';

interface RefusalCase {
    readonly reason: 'not-yet-in-sync' | 'membership-fenced';
    /** The room the counted recipient `b` judges the copy by, a snapshot behind the origin's. */
    readonly receiverRoom: (chain: RelayChain) => GroupSnapshot;
}

/** The origin's room is one version past the chain's, and its send is floored there. */
const ORIGIN_SNAPSHOT_VERSION = 4;

describe('a counted recipient\'s refusal of a receipted RTC send (S8-R1, S8-R6)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each<RefusalCase>([
        { reason: 'not-yet-in-sync', receiverRoom: (chain) => chain.snapshot },
        { reason: 'membership-fenced', receiverRoom: (chain) => toRoomWithoutMember(chain.snapshot, 'a') }
    ])('a counted recipient signs the $reason refusal of a floored receipted send, and the origin admits it', async ({ reason, receiverRoom }) => {
        const chain = await createRelayChain(['a', 'b'], {});
        const origin = createRtcOriginOverlayFixture({
            snapshot: { ...chain.snapshot, group: { ...chain.snapshot.group, snapshotVersion: ORIGIN_SNAPSHOT_VERSION } },
            nextHopPeerIds: ['b'],
            publicationCrypto: chain.keys.a
        });
        const receiver = createRtcRelayOverlayFixture({
            selfPeerId: 'b',
            snapshot: receiverRoom(chain),
            neighbourPeerIds: ['a'],
            publicationCrypto: chain.keys.b
        });
        expect((await enqueueAndDrain(origin.manager, createFlooredReceiptedSend(reason))).verdict.kind).toBe('admitted');

        await receiver.receive(origin.channels.b!.sent[0]!, 'a');
        const refusals = (await receiver.readSent('a')).filter((message) => decodeALPeerControlMessage(message).right?.type === 'nack');

        expect(refusals.map((message) => decodeALPeerControlMessage(message).right?.payload)).toEqual([
            expect.objectContaining({ logicalRecipientPeerId: 'b', reason })
        ]);
        expect(await verifyTestALReceiptControl(chain.keys.b!, refusals[0]!)).toBe(true);
        expect(await origin.manager.acceptControlMessage(refusals[0]!)).toEqual({ kind: 'committed' });
        expect(origin.diagnostics.filter((event) => event.kind === 'control-admission' && event.proofRefusal !== undefined)).toEqual([]);
    });
});

/** A `receiver` multicast that no recipient may admit below the origin's own room version. */
function createFlooredReceiptedSend(resourceId: string): ALMessage {
    return newALMulticastMessage('a', { topicId: 'chat', resourceId, contextId: 'room' }, ORIGIN_ROOM, 'chat.message.v1', { text: resourceId }, {
        ack: 'all-logical-recipients',
        reliability: 'at-least-once',
        ttlMs: 30_000,
        minSnapshotVersion: ORIGIN_SNAPSHOT_VERSION
    });
}

/** The room after `sessionId`'s principal left its roster, which fences that sender's copies. */
function toRoomWithoutMember(snapshot: GroupSnapshot, sessionId: string): GroupSnapshot {
    const principalId = snapshot.activeSessions.find((session) => session.sessionId === sessionId)?.principalId;
    return {
        ...snapshot,
        group: { ...snapshot.group, snapshotVersion: ORIGIN_SNAPSHOT_VERSION },
        members: snapshot.members.map((member) =>
            member.principalId === principalId && member.status === 'active' ? { ...member, status: 'left' as const, left: member.updated } : member
        )
    };
}
