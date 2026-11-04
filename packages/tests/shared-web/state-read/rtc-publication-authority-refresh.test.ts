import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { RtcGroupSnapshotRefresh } from '@shared-web/browser/state-read/rtc-group-snapshot-refresh.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupPresencePublicationKey, GroupSnapshot } from '@shared/api/group-types.ts';

import { createRtcGrantedTopicsFixture } from '../../shared/multicast/rtc-granted-topic-reader-fixtures.ts';
import { createRtcOriginOverlayFixture, ORIGIN_ROOM } from '../../shared/multicast/rtc-origin-overlay-fixture.ts';
import {
    createPublicationRoomSnapshot,
    PUBLICATION_TOPIC_ID,
    PUBLISH_AND_SUBSCRIBE,
    SUBSCRIBE_ONLY
} from '../../shared/multicast/rtc-publication-proof-fixtures.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from '../../shared/multicast/rtc-relay-overlay-fixture.ts';
import { createRtcTopicSubscriptionsFixture } from '../../shared/multicast/rtc-topic-subscription-reader-fixtures.ts';
import {
    createAvailablePublicationCryptoFixture,
    type AvailablePublicationCrypto
} from '../../shared/signature/publication-crypto-fixtures.ts';

interface RefreshedReceiver {
    readonly receiver: RtcRelayOverlayFixture;
    /** The rooms the receiver read again, one entry per refresh. */
    readonly refreshedRooms: readonly string[];
}

const GRANTS = { a: PUBLISH_AND_SUBSCRIBE, c: SUBSCRIBE_ONLY } as const;

describe('a granted RTC publication whose key the receiver has not yet observed', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each([
        { refreshed: 'names the publisher\'s key', namesKey: true, outcomes: ['not-yet-in-sync: unknown-key', 'admitted'] },
        {
            refreshed: 'still names no key for it',
            namesKey: false,
            outcomes: ['not-yet-in-sync: unknown-key', 'not-yet-in-sync: unknown-key']
        }
    ])('re-enters admission once after one refresh, which $refreshed', async ({ namesKey, outcomes }) => {
        const keys = { a: await createAvailablePublicationCryptoFixture(), c: await createAvailablePublicationCryptoFixture() };
        const { receiver, refreshedRooms } = createRefreshedReceiver(keys, namesKey);
        const signed = await publishFromOrigin(keys);

        await receiver.receive(signed, 'a');

        expect(refreshedRooms).toEqual([ORIGIN_ROOM.groupId]);
        expect(readAdmissionReasons(receiver)).toEqual(outcomes);
        expect(receiver.delivered.map((message) => message.id.msgId)).toEqual(namesKey ? [signed.id.msgId] : []);
    });
});

/** The receiver `c` observed the room before `a` registered its key; its one refresh reads the room again. */
function createRefreshedReceiver(
    keys: Readonly<Record<'a' | 'c', AvailablePublicationCrypto>>,
    refreshNamesKey: boolean
): RefreshedReceiver {
    const refreshedRooms: string[] = [];
    const registered = { c: toGroupPresencePublicationKey(keys.c)! };
    const receiver = createRtcRelayOverlayFixture({
        selfPeerId: 'c',
        snapshot: toRoomSnapshot(3, registered),
        neighbourPeerIds: ['a'],
        grantedTopics: createRtcGrantedTopicsFixture([PUBLICATION_TOPIC_ID]),
        publicationCrypto: keys.c,
        topicSubscriptions: createRtcTopicSubscriptionsFixture([PUBLICATION_TOPIC_ID]),
        roomAuthorityRefresh: new RtcGroupSnapshotRefresh({
            refreshGroupSnapshot: async (roomRef) => {
                refreshedRooms.push(roomRef.groupId);
                receiver.acceptSnapshot(toRoomSnapshot(
                    4,
                    refreshNamesKey
                        ? { ...registered, a: toGroupPresencePublicationKey(keys.a)! }
                        : registered
                ));
            }
        })
    });
    return { receiver, refreshedRooms };
}

function toRoomSnapshot(
    snapshotVersion: number,
    keys: Readonly<Record<string, GroupPresencePublicationKey>>
): GroupSnapshot {
    return createPublicationRoomSnapshot({ sessionIds: ['a', 'c'], snapshotVersion, keys, grants: GRANTS });
}

/** The transport copy the signing origin `a` sends `c` for one granted room multicast. */
async function publishFromOrigin(keys: Readonly<Record<'a' | 'c', AvailablePublicationCrypto>>): Promise<ALMessage> {
    const origin = createRtcOriginOverlayFixture({
        snapshot: toRoomSnapshot(3, {
            a: toGroupPresencePublicationKey(keys.a)!,
            c: toGroupPresencePublicationKey(keys.c)!
        }),
        nextHopPeerIds: ['c'],
        grantedTopics: createRtcGrantedTopicsFixture([PUBLICATION_TOPIC_ID]),
        publicationCrypto: keys.a
    });
    const admitted = await origin.manager.enqueueLegIfAbsent(
        newALMulticastMessage(
            'a',
            { topicId: PUBLICATION_TOPIC_ID, resourceId: 'feed-1', contextId: ORIGIN_ROOM.groupId },
            ORIGIN_ROOM,
            'room.granted-feed.v1',
            { text: 'feed' },
            { ack: 'none', reliability: 'best-effort', ttlMs: 30_000, traceId: 'trace-feed-1' }
        ),
        'hold'
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
    return origin.channels.c!.sent[0]!;
}

function readAdmissionReasons(fixture: RtcRelayOverlayFixture): readonly string[] {
    return fixture.diagnostics.flatMap((event) => event.kind === 'admission-outcome' && event.typeId === 'room.granted-feed.v1' ? [event.reason] : []);
}
