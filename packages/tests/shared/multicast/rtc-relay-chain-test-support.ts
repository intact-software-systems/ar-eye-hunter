import { expect, vi } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALPeerControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALVolatileInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RtcTopicSubscriptionReader } from '@shared/multicast/publication/rtc-topic-subscription-reader.ts';

import { createAvailablePublicationCryptoFixture, type AvailablePublicationCrypto } from '../signature/publication-crypto-fixtures.ts';
import { createRtcGrantedTopicsFixture } from './rtc-granted-topic-reader-fixtures.ts';
import { createRtcOriginOverlayFixture, ORIGIN_ROOM, type RtcOriginOverlayFixture } from './rtc-origin-overlay-fixture.ts';
import {
    createFrozenGrantedMulticast,
    createPublicationRoomSnapshot,
    PUBLICATION_TOPIC_ID,
    signPublication,
    SUBSCRIBE_ONLY
} from './rtc-publication-proof-fixtures.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';
import { NO_RTC_TOPIC_SUBSCRIPTIONS } from './rtc-topic-subscription-reader-fixtures.ts';

/** The origin `a` and the sessions below it, each its own principal with a registered key. */
export interface RelayChain {
    readonly keys: Readonly<Record<string, AvailablePublicationCrypto>>;
    readonly snapshot: GroupSnapshot;
}

/** The chain `a`, `r`, `c` whose origin `a` is a real signing RTC origin reaching `c` only through the relay `r`. */
export interface OriginRelayChain extends RelayChain {
    readonly origin: RtcOriginOverlayFixture;
}

export interface ChainHopInput {
    readonly selfPeerId: string;
    /** The hop's parent first, then its children. */
    readonly neighbourPeerIds: readonly string[];
    /** Absent, the hop holds no token. */
    readonly topicSubscriptions?: RtcTopicSubscriptionReader;
    /** The hop's inbound memory pair; absent, the receive pipeline's own. */
    readonly inboundVolatileStores?: ALVolatileInboundRuntimeStores;
}

export interface OrderedReceiptedPublicationInput {
    readonly resourceId: string;
    /** The audience the origin froze the frame to, which the proof signs. */
    readonly recipientPeerIds: readonly string[];
    readonly nextHopPeerId: string;
    readonly seq: number;
    /** The record the origin signs into the frame; absent, no authority recorded the copy. */
    readonly priorSeqByRecipient?: Readonly<Record<string, number>>;
}

export interface TrackFrameInput {
    readonly seq: number;
    readonly recipientPeerIds: readonly string[];
    readonly priorSeqByRecipient: Readonly<Record<string, number>>;
    /** Absent, the origin's only next hop is the first recipient. */
    readonly nextHopPeerId?: string;
}

export interface OrderedOriginPublicationInput {
    readonly origin: RtcOriginOverlayFixture;
    readonly seq: number;
    /** The receipt the send asks for, `at-least-once` under `receiver`; absent, none, so the send is best-effort. */
    readonly ack?: 'none' | 'receiver';
}

export const GRANTED_TYPE_ID = 'room.granted-feed.v1';

const ORDERED_TRACK_KEY = 'feed-track';

/** The real `setTimeout`, read before a suite installs its fake timers. */
const REAL_SET_TIMEOUT = globalThis.setTimeout;

/** One drain cycle per event-loop turn: enough for every hop's lock grants under a loaded runner. */
const DRAIN_MAX_CYCLES = 200;

export async function createRelayChain(
    sessionIds: readonly string[],
    grants: Readonly<Record<string, GroupPublicationTopicPermissions>>
): Promise<RelayChain> {
    const keys: Record<string, AvailablePublicationCrypto> = {};
    for (const sessionId of sessionIds) {
        keys[sessionId] = await createAvailablePublicationCryptoFixture();
    }
    const snapshot = createPublicationRoomSnapshot({
        sessionIds,
        snapshotVersion: 3,
        keys: Object.fromEntries(sessionIds.map((sessionId) => [sessionId, toGroupPresencePublicationKey(keys[sessionId]!)!])),
        grants
    });
    return { keys, snapshot };
}

export async function createOriginRelayChain(
    grants: Readonly<Record<string, GroupPublicationTopicPermissions>>
): Promise<OriginRelayChain> {
    const chain = await createRelayChain(['a', 'r', 'c'], grants);
    const origin = createRtcOriginOverlayFixture({
        snapshot: chain.snapshot,
        nextHopPeerIds: ['r'],
        grantedTopics: createRtcGrantedTopicsFixture([PUBLICATION_TOPIC_ID]),
        publicationCrypto: chain.keys.a
    });
    return { ...chain, origin };
}

export function createChainHop(chain: RelayChain, input: ChainHopInput): RtcRelayOverlayFixture {
    return createRtcRelayOverlayFixture({
        selfPeerId: input.selfPeerId,
        snapshot: chain.snapshot,
        neighbourPeerIds: input.neighbourPeerIds,
        grantedTopics: createRtcGrantedTopicsFixture([PUBLICATION_TOPIC_ID]),
        publicationCrypto: chain.keys[input.selfPeerId],
        topicSubscriptions: input.topicSubscriptions ?? NO_RTC_TOPIC_SUBSCRIPTIONS,
        inboundVolatileStores: input.inboundVolatileStores
    });
}

/** A receipted granted frame on the origin's ordered at-least-once track, at `seq`, as `a` signs it. */
export async function signOrderedReceiptedPublication(
    chain: RelayChain,
    input: OrderedReceiptedPublicationInput
): Promise<ALMessage> {
    const frozen = createFrozenGrantedMulticast({
        senderId: 'a',
        resourceId: input.resourceId,
        recipientPeerIds: input.recipientPeerIds,
        snapshotVersion: 3,
        ack: 'receiver'
    });
    return await signPublication(chain.keys.a!, {
        ...frozen,
        delivery: { ack: 'receiver', reliability: 'at-least-once' },
        ordering: {
            orderingKey: ORDERED_TRACK_KEY,
            seq: input.seq,
            ...(input.priorSeqByRecipient === undefined ? {} : { priorSeqByRecipient: input.priorSeqByRecipient })
        },
        forwarding: { ...frozen.forwarding, nextHopPeerIds: [input.nextHopPeerId] }
    });
}

/** The origin's signed frames of one recorded track, one message per sequence. */
export async function signTrack(chain: RelayChain, frames: readonly TrackFrameInput[]): Promise<readonly ALMessage[]> {
    const signed: ALMessage[] = [];
    for (const frame of frames) {
        signed.push(
            await signOrderedReceiptedPublication(chain, {
                resourceId: `feed-${frame.seq}`,
                recipientPeerIds: frame.recipientPeerIds,
                nextHopPeerId: frame.nextHopPeerId ?? frame.recipientPeerIds.at(-1)!,
                seq: frame.seq,
                priorSeqByRecipient: frame.priorSeqByRecipient
            })
        );
    }
    return signed;
}

/** The transport copy the signing origin sends `r` for one granted room multicast on its recorded track, at `seq`. */
export async function publishOrderedFromOrigin(input: OrderedOriginPublicationInput): Promise<ALMessage> {
    const { origin, seq } = input;
    const ack = input.ack ?? 'none';
    const sentBefore = origin.channels.r!.sent.length;
    const admitted = await origin.manager.enqueueLegIfAbsent(
        newALMulticastMessage(
            'a',
            { topicId: PUBLICATION_TOPIC_ID, resourceId: `feed-${seq}`, contextId: ORIGIN_ROOM.groupId },
            ORIGIN_ROOM,
            GRANTED_TYPE_ID,
            { text: `feed ${seq}` },
            {
                ack,
                reliability: ack === 'none' ? 'best-effort' : 'at-least-once',
                ttlMs: 30_000,
                traceId: `trace-feed-${seq}`,
                orderingKey: ORDERED_TRACK_KEY,
                seq
            }
        ),
        'hold'
    );
    await drainUntil(() => origin.channels.r!.sent.length > sentBefore);
    expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
    return origin.channels.r!.sent[sentBefore]!;
}

/** The origin's publish grant is revoked in the next snapshot: it may still subscribe. */
export function toPublishRevokedSnapshot(snapshot: GroupSnapshot): GroupSnapshot {
    return {
        ...snapshot,
        group: { ...snapshot.group, snapshotVersion: 4 },
        publicationGrants: snapshot.publicationGrants.map((grant) =>
            grant.principalId === 'a' ? { ...grant, topics: { [PUBLICATION_TOPIC_ID]: SUBSCRIBE_ONLY } } : grant
        )
    };
}

/**
 * Runs the chain's due work until `condition` holds or the cycle budget runs out. Each cycle runs the due fake timers
 * without moving the clock and yields one real event-loop turn, which a Web Locks grant needs. It never throws: the
 * caller's assertion states what did not happen.
 */
export async function drainUntil(condition: () => boolean | Promise<boolean>, maxCycles = DRAIN_MAX_CYCLES): Promise<void> {
    for (let cycle = 0; cycle < maxCycles && !(await condition()); cycle++) {
        await vi.advanceTimersByTimeAsync(0);
        await new Promise<void>((resolve) => REAL_SET_TIMEOUT(resolve, 0));
    }
}

export async function deliverEach(messages: readonly ALMessage[], to: RtcRelayOverlayFixture, fromPeerId: string): Promise<void> {
    for (const message of messages) {
        await to.receive(message, fromPeerId);
    }
}

/** Each control as its type, the recipient it speaks for, and its status or reason. */
export function toControlTuples(controls: readonly ALPeerControlMessage[]): readonly (readonly string[])[] {
    return controls.map((control) =>
        control.type === 'ack'
            ? ['ack', control.payload.logicalRecipientPeerId, control.payload.status]
            : control.type === 'nack'
            ? ['nack', control.payload.logicalRecipientPeerId, control.payload.reason]
            : ['repair', control.payload.fromPeerId, control.payload.reason]
    );
}

/** Each `ordering-position` the session stated, as its status, sequence and the record's prior for it. */
export function readOrderingPositions(fixture: RtcRelayOverlayFixture): readonly (readonly [string, number, number | null])[] {
    return fixture.diagnostics.flatMap((event) => event.kind === 'ordering-position' ? [[event.status, event.seq, event.priorSeq] as const] : []);
}
