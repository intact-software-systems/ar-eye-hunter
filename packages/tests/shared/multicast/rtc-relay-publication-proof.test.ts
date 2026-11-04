import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BROWSER_STATE_CACHE_TTL_MS } from '@shared-web/browser/state-cache/initialise-browser-cache-repositories.ts';
import { newALMulticastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import { toALPublicationProofSigningInput } from '@shared/al-contracts/publication-proof/al-publication-proof.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';

import {
    createAvailablePublicationCryptoFixture,
    UNAVAILABLE_PUBLICATION_CRYPTO,
    type AvailablePublicationCrypto
} from '../signature/publication-crypto-fixtures.ts';
import { createRtcGrantedTopicsFixture } from './rtc-granted-topic-reader-fixtures.ts';
import { createRtcOriginOverlayFixture, ORIGIN_ROOM, type RtcOriginOverlayFixture } from './rtc-origin-overlay-fixture.ts';
import {
    createPublicationRoomSnapshot,
    PUBLICATION_TOPIC_ID,
    PUBLISH_AND_SUBSCRIBE,
    PUBLISH_ONLY,
    SUBSCRIBE_ONLY
} from './rtc-publication-proof-fixtures.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';
import { createRtcTopicSubscriptionsFixture, NO_RTC_TOPIC_SUBSCRIPTIONS } from './rtc-topic-subscription-reader-fixtures.ts';

/** The origin `a` reaches the receiver `c` only through the relay `r`. */
interface RelayChain {
    readonly keys: Readonly<Record<'a' | 'r' | 'c', AvailablePublicationCrypto>>;
    readonly snapshot: GroupSnapshot;
    readonly origin: RtcOriginOverlayFixture;
}

interface RelayHopInput {
    readonly selfPeerId: 'r' | 'c';
    readonly snapshot?: GroupSnapshot;
    readonly crypto?: PublicationCrypto;
    readonly subscribed?: boolean;
    readonly groupCacheTtlMs?: number;
    /** The topic the relay's page declared granted; absent, the room feed topic. */
    readonly grantedTopicId?: string;
    /** The receiver session's QoS provider; absent, the carrier's capabilities alone. */
    readonly qosProvider?: ALQosInputProvider;
}

/** A granted topic outside the `room.` prefix: room admission alone never refuses a frame on it that names no room. */
const APP_TOPIC_ID = 'app.granted-feed';

const GRANTS_WITH_UNSUBSCRIBED_RELAY = { a: PUBLISH_AND_SUBSCRIBE, c: SUBSCRIBE_ONLY } as const;

const GRANTED_TYPE_ID = 'room.granted-feed.v1';

const MEMBERS_TYPE_ID = 'room.chat.v1';

describe('a granted RTC publication at its relays and receivers', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('forwards at a relay without subscribe, delivering nothing there, and the copy verifies at the next hop', async () => {
        const chain = await createRelayChain(GRANTS_WITH_UNSUBSCRIBED_RELAY);
        const relay = createRelayHop(chain, { selfPeerId: 'r', subscribed: true });
        const receiver = createRelayHop(chain, { selfPeerId: 'c', subscribed: true });
        const signed = await publishFromOrigin(chain, 'feed-1');

        await relay.receive(signed, 'a');
        const forwarded = await relay.readSent('c');
        await receiver.receive(forwarded[0]!, 'r');

        expect(relay.delivered).toEqual([]);
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]!.proof).toEqual(signed.proof);
        expect(toALPublicationProofSigningInput(forwarded[0]!)).toBe(toALPublicationProofSigningInput(signed));
        expect(receiver.delivered.map((message) => message.id.msgId)).toEqual([signed.id.msgId]);
    });

    it('only forwards at a publisher-only relay, and delivers at a subscribed one only while its token is active', async () => {
        const chain = await createRelayChain({ a: PUBLISH_AND_SUBSCRIBE, r: PUBLISH_ONLY, c: SUBSCRIBE_ONLY });
        const publisherOnly = createRelayHop(chain, { selfPeerId: 'r', subscribed: true });
        const pending = createRelayHop(chain, { selfPeerId: 'c', subscribed: false });
        const active = createRelayHop(chain, { selfPeerId: 'c', subscribed: true });
        const signed = await publishFromOrigin(chain, 'feed-1');

        await publisherOnly.receive(signed, 'a');
        const forwarded = (await publisherOnly.readSent('c'))[0]!;
        await pending.receive(forwarded, 'r');
        await active.receive(forwarded, 'r');

        expect([publisherOnly.delivered.length, pending.delivered.length, active.delivered.length]).toEqual([0, 0, 1]);
    });

    it('drops a frame whose senderId is forged to another member at the first relay, never forwarding it', async () => {
        const chain = await createRelayChain(GRANTS_WITH_UNSUBSCRIBED_RELAY);
        const relay = createRelayHop(chain, { selfPeerId: 'r', subscribed: true });
        const signed = await publishFromOrigin(chain, 'feed-1');

        await relay.receive({ ...signed, id: { ...signed.id, senderId: 'c' } }, 'a');

        expect(await relay.readSent('c')).toEqual([]);
        expect(relay.delivered).toEqual([]);
        expect(readAdmissionReasons(relay)).toEqual(['not-yet-in-sync: unknown-key']);
    });

    it.each<[string, (message: ALMessage) => ALMessage['targets']]>([
        ['a unicast', () => ({ mode: 'unicast', toPeerId: 'r' })],
        ['a world broadcast', () => ({ mode: 'broadcast', scope: 'world' })]
    ])('drops %s naming no room on a granted app topic as unbound, never delivering or forwarding it', async (_name, toTargets) => {
        const chain = await createRelayChain({ ...GRANTS_WITH_UNSUBSCRIBED_RELAY, r: SUBSCRIBE_ONLY });
        const relay = createRelayHop(chain, { selfPeerId: 'r', subscribed: true, grantedTopicId: APP_TOPIC_ID });
        const forged = newALUnicastMessage(
            'a',
            { topicId: APP_TOPIC_ID, resourceId: 'forged-1', contextId: ORIGIN_ROOM.groupId },
            'r',
            GRANTED_TYPE_ID,
            { text: 'forged' },
            { ttlMs: 30_000, traceId: 'trace-forged' }
        );

        await relay.receive({ ...forged, targets: toTargets(forged) }, 'a');

        expect([relay.delivered, await relay.readSent('c')]).toEqual([[], []]);
        expect(readAdmissionReasons(relay)).toEqual(['unauthorized: unbound-target']);
    });

    it('drops a frame without a proof at the first hop', async () => {
        const chain = await createRelayChain(GRANTS_WITH_UNSUBSCRIBED_RELAY);
        const relay = createRelayHop(chain, { selfPeerId: 'r', subscribed: true });
        const { proof: _proof, ...unsigned } = await publishFromOrigin(chain, 'feed-1');

        await relay.receive(unsigned, 'a');

        expect(await relay.readSent('c')).toEqual([]);
        expect(readAdmissionReasons(relay)).toEqual(['unauthorized: missing-proof']);
    });

    it('drops a frame its publisher signed before a revoke the relay has since observed', async () => {
        const chain = await createRelayChain(GRANTS_WITH_UNSUBSCRIBED_RELAY);
        const relay = createRelayHop(chain, { selfPeerId: 'r', subscribed: true });
        const signed = await publishFromOrigin(chain, 'feed-1');

        relay.acceptSnapshot(toRevokedSnapshot(chain));
        await relay.receive(signed, 'a');

        expect(await relay.readSent('c')).toEqual([]);
        expect(readAdmissionReasons(relay)).toEqual(['unauthorized: no-publish-grant']);
    });

    it('drops every granted frame at a keyless relay: it verifies none, so it neither delivers nor forwards', async () => {
        const chain = await createRelayChain({ ...GRANTS_WITH_UNSUBSCRIBED_RELAY, r: SUBSCRIBE_ONLY });
        const relay = createRelayHop(chain, { selfPeerId: 'r', crypto: UNAVAILABLE_PUBLICATION_CRYPTO, subscribed: true });

        await relay.receive(await publishFromOrigin(chain, 'feed-1'), 'a');
        await relay.receive(await publishFromOrigin(chain, 'feed-2'), 'a');

        expect([relay.delivered, await relay.readSent('c')]).toEqual([[], []]);
        expect(readAdmissionReasons(relay)).toEqual(['unauthorized: invalid-signature', 'unauthorized: invalid-signature']);
    });

    it('re-sends a retried copy whose signing input is byte-identical and which verifies at the next hop', async () => {
        const chain = await createRelayChain(GRANTS_WITH_UNSUBSCRIBED_RELAY);
        const relay = createRelayHop(chain, { selfPeerId: 'r', subscribed: true });
        const receiver = createRelayHop(chain, { selfPeerId: 'c', subscribed: true });
        const signed = await publishFromOrigin(chain, 'feed-1');
        await relay.receive(signed, 'a');

        // A retried copy is planned from the stored row: another object than the one the relay verified at ingress.
        await relay.forwardRetriedCopy({
            msg: structuredClone(signed),
            fromPeerId: 'a',
            toPeerIds: ['c'],
            attemptIdentity: 'retry-feed-1'
        });
        const [, retried] = await relay.readSent('c');
        await receiver.receive(retried!, 'r');

        expect(toALPublicationProofSigningInput(retried!)).toBe(toALPublicationProofSigningInput(signed));
        expect(retried!.proof).toEqual(signed.proof);
        expect(receiver.delivered.map((message) => message.id.msgId)).toEqual([signed.id.msgId]);
    });

    it('keeps the signed expiry of a frame whose receiver computes an earlier deadline, so it still verifies and delivers', async () => {
        const chain = await createRelayChain({ ...GRANTS_WITH_UNSUBSCRIBED_RELAY, r: SUBSCRIBE_ONLY });
        // The receiver cannot honour the origin's `expires-at`: it falls back to `fresh-until` over the unsigned audit time.
        const relay = createRelayHop(chain, {
            selfPeerId: 'r',
            subscribed: true,
            qosProvider: { capabilitiesForMessage: () => ({ supportedExpiry: ['fresh-until'] }) }
        });
        const signed = await publishFromOrigin(chain, 'feed-1');
        // An upstream hop stamps an earlier audit time, which the proof excludes: the receiver's deadline falls first.
        const restamped: ALMessage = { ...signed, audit: { ...signed.audit, createdTs: signed.id.ts - 40_000 } };

        await relay.receive(restamped, 'a');
        const forwarded = await relay.readSent('c');

        expect(readAdmissionReasons(relay)).toEqual(['admitted']);
        expect(relay.delivered.map((message) => message.id.msgId)).toEqual([signed.id.msgId]);
        expect(forwarded.map((message) => toALPublicationProofSigningInput(message))).toEqual([
            toALPublicationProofSigningInput(signed)
        ]);
    });

    it('delivers a members-topic frame without a proof as before: only granted topics are judged by proof', async () => {
        const chain = await createRelayChain(GRANTS_WITH_UNSUBSCRIBED_RELAY);
        const relay = createRelayHop(chain, { selfPeerId: 'r', subscribed: false });
        const members = createMembersTransportCopy();

        await relay.receive(members, 'a');

        expect(relay.delivered.map((message) => message.id.msgId)).toEqual([members.id.msgId]);
        expect(await relay.readSent('c')).toHaveLength(1);
    });

    it('drops a members-topic frame carrying a proof at the first hop, unauthorized: it never forwards or answers it', async () => {
        const chain = await createRelayChain(GRANTS_WITH_UNSUBSCRIBED_RELAY);
        const relay = createRelayHop(chain, { selfPeerId: 'r', subscribed: false });
        const signed = await publishFromOrigin(chain, 'feed-1');

        await relay.receive({ ...createMembersTransportCopy(), proof: signed.proof }, 'a');

        expect([relay.delivered, await relay.readSent('c'), await relay.readSent('a')]).toEqual([[], [], []]);
        expect(readAdmissionReasons(relay, MEMBERS_TYPE_ID)).toEqual(['unauthorized: proof-on-ungranted-topic']);
    });

    it('keeps a snapshot readable for its cache TTL: delivered a second before it lapses, dropped no-authority a second after', async () => {
        const chain = await createRelayChain({ ...GRANTS_WITH_UNSUBSCRIBED_RELAY, r: SUBSCRIBE_ONLY });
        const relay = createRelayHop(chain, {
            selfPeerId: 'r',
            subscribed: true,
            groupCacheTtlMs: BROWSER_STATE_CACHE_TTL_MS
        });

        await vi.advanceTimersByTimeAsync(BROWSER_STATE_CACHE_TTL_MS - 1_000);
        await relay.receive(await publishFromOrigin(chain, 'feed-before'), 'a');
        await vi.advanceTimersByTimeAsync(2_000);
        await relay.receive(await publishFromOrigin(chain, 'feed-after'), 'a');

        expect(relay.delivered.map((message) => message.route.resourceId)).toEqual(['feed-before']);
        expect(readAdmissionReasons(relay)).toEqual(['admitted', 'unauthorized: no-authority']);
    });

    it('emits no inbound diagnostic that carries the payload resource', async () => {
        const chain = await createRelayChain({ ...GRANTS_WITH_UNSUBSCRIBED_RELAY, r: SUBSCRIBE_ONLY });
        const relay = createRelayHop(chain, { selfPeerId: 'r', subscribed: true });
        const signed = await publishFromOrigin(chain, 'feed-1');

        await relay.receive(signed, 'a');
        await relay.receive({ ...signed, id: { ...signed.id, msgId: 'forged-1' } }, 'a');

        expect(relay.diagnostics.length).toBeGreaterThan(0);
        expect(JSON.stringify(relay.diagnostics)).not.toContain(signed.payload.resource);
    });
});

async function createRelayChain(grants: Readonly<Record<string, GroupPublicationTopicPermissions>>): Promise<RelayChain> {
    const keys = {
        a: await createAvailablePublicationCryptoFixture(),
        r: await createAvailablePublicationCryptoFixture(),
        c: await createAvailablePublicationCryptoFixture()
    };
    const snapshot = createPublicationRoomSnapshot({
        sessionIds: ['a', 'r', 'c'],
        snapshotVersion: 3,
        keys: {
            a: toGroupPresencePublicationKey(keys.a)!,
            r: toGroupPresencePublicationKey(keys.r)!,
            c: toGroupPresencePublicationKey(keys.c)!
        },
        grants
    });
    const origin = createRtcOriginOverlayFixture({
        snapshot,
        nextHopPeerIds: ['r'],
        grantedTopics: createRtcGrantedTopicsFixture([PUBLICATION_TOPIC_ID]),
        publicationCrypto: keys.a
    });
    return { keys, snapshot, origin };
}

function createRelayHop(chain: RelayChain, input: RelayHopInput): RtcRelayOverlayFixture {
    return createRtcRelayOverlayFixture({
        selfPeerId: input.selfPeerId,
        snapshot: input.snapshot ?? chain.snapshot,
        neighbourPeerIds: input.selfPeerId === 'r' ? ['a', 'c'] : ['r'],
        grantedTopics: createRtcGrantedTopicsFixture([input.grantedTopicId ?? PUBLICATION_TOPIC_ID]),
        publicationCrypto: input.crypto ?? chain.keys[input.selfPeerId],
        topicSubscriptions: input.subscribed
            ? createRtcTopicSubscriptionsFixture([PUBLICATION_TOPIC_ID])
            : NO_RTC_TOPIC_SUBSCRIPTIONS,
        groupCacheTtlMs: input.groupCacheTtlMs,
        qosProvider: input.qosProvider
    });
}

/** The transport copy the signing origin sends `r` for one granted room multicast. */
async function publishFromOrigin(chain: RelayChain, resourceId: string): Promise<ALMessage> {
    const sentBefore = chain.origin.channels.r!.sent.length;
    const admitted = await chain.origin.manager.enqueueLegIfAbsent(
        newALMulticastMessage(
            'a',
            { topicId: PUBLICATION_TOPIC_ID, resourceId, contextId: ORIGIN_ROOM.groupId },
            ORIGIN_ROOM,
            GRANTED_TYPE_ID,
            { text: `feed ${resourceId}` },
            { ack: 'none', reliability: 'best-effort', ttlMs: 30_000, traceId: `trace-${resourceId}` }
        ),
        'hold'
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
    return chain.origin.channels.r!.sent[sentBefore]!;
}

/** A members-topic room multicast as the origin's transport copy to `r`. */
function createMembersTransportCopy(): ALMessage {
    return toTransportCopy(newALMulticastMessage(
        'a',
        { topicId: 'room.chat', resourceId: 'chat-1', contextId: ORIGIN_ROOM.groupId },
        ORIGIN_ROOM,
        MEMBERS_TYPE_ID,
        { text: 'hello' },
        { ack: 'none', reliability: 'best-effort', ttlMs: 30_000, traceId: 'trace-members' }
    ));
}

function toTransportCopy(message: ALMessage): ALMessage {
    return {
        ...message,
        targets: { mode: 'multicast', groupRef: ORIGIN_ROOM, recipientPeerIds: ['a', 'r', 'c'], snapshotVersion: 3 },
        forwarding: { ...message.forwarding, nextHopPeerIds: ['r'] },
        constraints: { ...message.constraints, expiresAtMs: message.id.ts + 30_000 }
    };
}

/** The origin's publish grant is revoked in the next snapshot: it may still subscribe. */
function toRevokedSnapshot(chain: RelayChain): GroupSnapshot {
    return {
        ...chain.snapshot,
        group: { ...chain.snapshot.group, snapshotVersion: 4 },
        publicationGrants: chain.snapshot.publicationGrants.map((grant) =>
            grant.principalId === 'a' ? { ...grant, topics: { [PUBLICATION_TOPIC_ID]: SUBSCRIBE_ONLY } } : grant
        )
    };
}

function readAdmissionReasons(fixture: RtcRelayOverlayFixture, typeId = GRANTED_TYPE_ID): readonly string[] {
    return fixture.diagnostics.flatMap((event) => event.kind === 'admission-outcome' && event.typeId === typeId ? [event.reason] : []);
}
