import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { BrowserGrantedTopics } from '@shared-web/browser/messages/publication/browser-granted-topics.ts';
import { RtcGroupSnapshotRefresh } from '@shared-web/browser/state-read/rtc-group-snapshot-refresh.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';
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

type PublicationKeys = Readonly<Record<'a' | 'c', AvailablePublicationCrypto>>;

type RoomGrants = Readonly<Record<string, GroupPublicationTopicPermissions>>;

const GRANTS: RoomGrants = { a: PUBLISH_AND_SUBSCRIBE, c: SUBSCRIBE_ONLY };

/** A room whose snapshot grants no topic: a page that declared no granted channel classifies none as granted. */
const NO_GRANTS: RoomGrants = {};

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
        const keys = await createPublicationKeys();
        const { receiver, refreshedRooms } = createRefreshedReceiver(keys, namesKey);
        const signed = await publishFromOrigin(keys, 3);

        await receiver.receive(signed, 'a');

        expect(refreshedRooms).toEqual([ORIGIN_ROOM.groupId]);
        expect(readAdmissionReasons(receiver)).toEqual(outcomes);
        expect(receiver.delivered.map((message) => message.id.msgId)).toEqual(namesKey ? [signed.id.msgId] : []);
    });
});

describe('a signed RTC frame on a topic the receiver\'s snapshot does not grant', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('holds it not-yet-in-sync while its snapshot is older than the frame, and admits it once the refresh grants the topic', async () => {
        const keys = await createPublicationKeys();
        const { receiver, refreshedRooms } = createUngrantedReceiver(keys, 3);
        const signed = await publishFromOrigin(keys, 4);

        await receiver.receive(signed, 'a');

        expect(refreshedRooms).toEqual([ORIGIN_ROOM.groupId]);
        expect(readAdmissionReasons(receiver)).toEqual(['not-yet-in-sync: authority-ahead', 'admitted']);
        expect(receiver.delivered.map((message) => message.id.msgId)).toEqual([signed.id.msgId]);
    });

    it('drops it unauthorized once its snapshot is as new as the frame: no refresh, no NACK, no delivery', async () => {
        const keys = await createPublicationKeys();
        const { receiver, refreshedRooms } = createUngrantedReceiver(keys, 4);
        const signed = await publishFromOrigin(keys, 4);

        await receiver.receive(signed, 'a');

        expect(refreshedRooms).toEqual([]);
        expect(readAdmissionReasons(receiver)).toEqual(['unauthorized: proof-on-ungranted-topic']);
        expect([receiver.delivered, await receiver.readSent('a')]).toEqual([[], []]);
    });
});

async function createPublicationKeys(): Promise<PublicationKeys> {
    return { a: await createAvailablePublicationCryptoFixture(), c: await createAvailablePublicationCryptoFixture() };
}

/** The receiver `c` observed the room before `a` registered its key; its one refresh reads the room again. */
function createRefreshedReceiver(keys: PublicationKeys, refreshNamesKey: boolean): RefreshedReceiver {
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

/**
 * The receiver `c` declared no granted channel and observed the room at `snapshotVersion` with no grant row, so it
 * classifies the topic by its snapshot alone; its one refresh reads the room at version 4, which grants the topic.
 */
function createUngrantedReceiver(keys: PublicationKeys, snapshotVersion: number): RefreshedReceiver {
    const refreshedRooms: string[] = [];
    let current = toRoomSnapshot(snapshotVersion, toRegisteredKeys(keys), NO_GRANTS);
    const receiver = createRtcRelayOverlayFixture({
        selfPeerId: 'c',
        snapshot: current,
        neighbourPeerIds: ['a'],
        grantedTopics: new BrowserGrantedTopics({ findGroupSnapshot: () => current }),
        publicationCrypto: keys.c,
        topicSubscriptions: createRtcTopicSubscriptionsFixture([PUBLICATION_TOPIC_ID]),
        roomAuthorityRefresh: new RtcGroupSnapshotRefresh({
            refreshGroupSnapshot: async (roomRef) => {
                refreshedRooms.push(roomRef.groupId);
                current = toRoomSnapshot(4, toRegisteredKeys(keys), GRANTS);
                receiver.acceptSnapshot(current);
            }
        })
    });
    return { receiver, refreshedRooms };
}

function toRegisteredKeys(keys: PublicationKeys): Readonly<Record<string, GroupPresencePublicationKey>> {
    return { a: toGroupPresencePublicationKey(keys.a)!, c: toGroupPresencePublicationKey(keys.c)! };
}

function toRoomSnapshot(
    snapshotVersion: number,
    keys: Readonly<Record<string, GroupPresencePublicationKey>>,
    grants: RoomGrants = GRANTS
): GroupSnapshot {
    return createPublicationRoomSnapshot({ sessionIds: ['a', 'c'], snapshotVersion, keys, grants });
}

/** The transport copy the signing origin `a` sends `c` for one granted room multicast, frozen at `snapshotVersion`. */
async function publishFromOrigin(keys: PublicationKeys, snapshotVersion: number): Promise<ALMessage> {
    const origin = createRtcOriginOverlayFixture({
        snapshot: toRoomSnapshot(snapshotVersion, toRegisteredKeys(keys)),
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
