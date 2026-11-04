import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RallarTopicSubscription } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { BrowserTopicSubscriptions } from '@shared-web/browser/messages/topic-subscription/browser-topic-subscriptions.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage, type ALPeerControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundSettlementFact } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RtcTopicSubscriptionReader } from '@shared/multicast/publication/rtc-topic-subscription-reader.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

import { createDefaultOutboundTestRuntime, enqueueOutboundOrThrow } from '../alm/outbound-runtime-test-fixture.ts';
import { createAvailablePublicationCryptoFixture, type AvailablePublicationCrypto } from '../signature/publication-crypto-fixtures.ts';
import { createRtcGrantedTopicsFixture } from './rtc-granted-topic-reader-fixtures.ts';
import { ORIGIN_ROOM } from './rtc-origin-overlay-fixture.ts';
import {
    createFrozenGrantedMulticast,
    createPublicationRoomSnapshot,
    PUBLICATION_TOPIC_ID,
    PUBLISH_AND_SUBSCRIBE,
    signPublication,
    SUBSCRIBE_ONLY
} from './rtc-publication-proof-fixtures.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';
import { createRtcTopicSubscriptionsFixture, NO_RTC_TOPIC_SUBSCRIPTIONS } from './rtc-topic-subscription-reader-fixtures.ts';

/** The origin `a` and the sessions below it, each its own principal with a registered key. */
interface RelayChain {
    readonly keys: Readonly<Record<string, AvailablePublicationCrypto>>;
    readonly snapshot: GroupSnapshot;
}

interface ChainHopInput {
    readonly selfPeerId: string;
    /** The hop's parent first, then its children. */
    readonly neighbourPeerIds: readonly string[];
    /** Absent, the hop holds no token. */
    readonly topicSubscriptions?: RtcTopicSubscriptionReader;
}

interface ReceiptedPublicationInput {
    readonly resourceId: string;
    /** The audience the origin froze the frame to, which the proof signs. */
    readonly recipientPeerIds: readonly string[];
    readonly nextHopPeerId: string;
}

/** The origin's receipt for a frame, fed the controls its next hop sent it. */
interface OriginReceipt {
    accept(controls: readonly ALMessage[]): Promise<void>;
    readonly facts: readonly ALOutboundSettlementFact[];
}

const ACTIVE_TOKEN = createRtcTopicSubscriptionsFixture([PUBLICATION_TOPIC_ID]);

describe('a receipted granted publication at a frozen recipient that is not subscribed', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('carries a leaf\'s NACK through the relay naming the leaf, ends the leaf\'s hop there, and the origin records it outside', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], { a: PUBLISH_AND_SUBSCRIBE, r: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c'], topicSubscriptions: ACTIVE_TOKEN });
        const leaf = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['r'] });
        const signed = await signReceiptedPublication(chain, { resourceId: 'feed-1', recipientPeerIds: ['r', 'c'], nextHopPeerId: 'r' });
        const origin = await createOriginReceipt(signed, { expectedPeerIds: ['r', 'c'], nextHopPeerIds: ['r'] });

        await relay.receive(signed, 'a');
        await leaf.receive((await relay.readSent('c'))[0]!, 'r');
        await deliverEach(await leaf.readSent('r'), relay, 'c');
        await origin.accept(await relay.readSent('a'));

        expect(leaf.delivered).toEqual([]);
        expect(toControlTuples(await leaf.readSentControls('r')).toSorted()).toEqual([
            ['ack', 'c', 'subtree-complete-not-subscribed'],
            ['nack', 'c', 'not-subscribed']
        ]);
        // The relay's own terminal ACK and the NACK it relays leave as two works, in either order.
        expect(toControlTuples(await relay.readSentControls('a')).toSorted()).toEqual([
            ['ack', 'r', 'accepted'],
            ['ack', 'r', 'subtree-complete'],
            ['nack', 'c', 'not-subscribed']
        ]);
        expect(toReceiptStatement(origin.facts)).toEqual({ confirmed: ['r'], outside: ['c'], complete: true });
    });

    it('reaches a recipient below a nested not-subscribed relay by retry: that relay\'s hop stays open until its subtree answers', async () => {
        const chain = await createRelayChain(['a', 'p', 'q', 'l'], {
            a: PUBLISH_AND_SUBSCRIBE,
            p: SUBSCRIBE_ONLY,
            q: SUBSCRIBE_ONLY,
            l: SUBSCRIBE_ONLY
        });
        const p = createChainHop(chain, { selfPeerId: 'p', neighbourPeerIds: ['a', 'q'], topicSubscriptions: ACTIVE_TOKEN });
        const q = createChainHop(chain, { selfPeerId: 'q', neighbourPeerIds: ['p', 'l'] });
        const l = createChainHop(chain, { selfPeerId: 'l', neighbourPeerIds: ['q'], topicSubscriptions: ACTIVE_TOKEN });
        const signed = await signReceiptedPublication(chain, {
            resourceId: 'feed-1',
            recipientPeerIds: ['p', 'q', 'l'],
            nextHopPeerId: 'p'
        });
        const origin = await createOriginReceipt(signed, { expectedPeerIds: ['p', 'q', 'l'], nextHopPeerIds: ['p'] });

        await p.receive(signed, 'a');
        await q.receive((await p.readSent('q'))[0]!, 'p');
        // `l`'s first copy is lost.
        await deliverEach(await q.readSent('p'), p, 'q');
        const beforeRetry = toControlTuples(await p.readSentControls('a'));

        // The origin's missing-recipient retry still goes through `p`, whose hop is open.
        await p.receive(signed, 'a');
        await q.receive((await p.readSent('q')).at(-1)!, 'p');
        await l.receive((await q.readSent('l')).at(-1)!, 'q');
        const qSentBefore = (await q.readSent('p')).length;
        await deliverEach(await l.readSent('q'), q, 'l');
        await deliverEach((await q.readSent('p')).slice(qSentBefore), p, 'q');
        await origin.accept(await p.readSent('a'));

        expect(beforeRetry.toSorted()).toEqual([['ack', 'p', 'accepted'], ['nack', 'q', 'not-subscribed']]);
        expect(l.delivered.map((message) => message.id.msgId)).toEqual([signed.id.msgId]);
        expect(toControlTuples(await p.readSentControls('a'))).toContainEqual(['ack', 'p', 'subtree-complete']);
        // The retried copy is answered with every NACK `p` relayed, as with every ACK.
        expect(toControlTuples(await p.readSentControls('a')).filter(([type]) => type === 'nack')).toEqual([
            ['nack', 'q', 'not-subscribed'],
            ['nack', 'q', 'not-subscribed']
        ]);
        expect(toReceiptStatement(origin.facts)).toEqual({ confirmed: ['p', 'l'], outside: ['q'], complete: true });
    });

    it('answers not-subscribed for a subscribe holder whose own token is still pending, delivering nothing (PL12)', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], { a: PUBLISH_AND_SUBSCRIBE, r: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c'], topicSubscriptions: ACTIVE_TOKEN });
        const tokens = createPendingTopicSubscriptions();
        const leaf = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['r'], topicSubscriptions: tokens.reader });
        const signed = await signReceiptedPublication(chain, { resourceId: 'feed-1', recipientPeerIds: ['r', 'c'], nextHopPeerId: 'r' });

        await relay.receive(signed, 'a');
        await leaf.receive((await relay.readSent('c'))[0]!, 'r');

        expect([tokens.token.status(), leaf.delivered]).toEqual(['pending', []]);
        expect(toControlTuples(await leaf.readSentControls('r'))).toContainEqual(['nack', 'c', 'not-subscribed']);
    });

    it('answers for an unsubscribed relay with its own NACK, relays its child\'s ACK and NACK, and never confirms itself', async () => {
        const chain = await createRelayChain(['a', 'r', 'c', 'd'], {
            a: PUBLISH_AND_SUBSCRIBE,
            r: SUBSCRIBE_ONLY,
            c: SUBSCRIBE_ONLY,
            d: SUBSCRIBE_ONLY
        });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c', 'd'] });
        const subscribed = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['r'], topicSubscriptions: ACTIVE_TOKEN });
        const unsubscribed = createChainHop(chain, { selfPeerId: 'd', neighbourPeerIds: ['r'] });
        const signed = await signReceiptedPublication(chain, {
            resourceId: 'feed-1',
            recipientPeerIds: ['r', 'c', 'd'],
            nextHopPeerId: 'r'
        });

        await relay.receive(signed, 'a');
        await subscribed.receive((await relay.readSent('c'))[0]!, 'r');
        await unsubscribed.receive((await relay.readSent('d'))[0]!, 'r');
        await deliverEach(await subscribed.readSent('r'), relay, 'c');
        await deliverEach(await unsubscribed.readSent('r'), relay, 'd');

        expect(relay.delivered).toEqual([]);
        expect(toControlTuples(await relay.readSentControls('a')).toSorted()).toEqual([
            ['ack', 'c', 'forwarded'],
            ['ack', 'r', 'subtree-complete-not-subscribed'],
            ['nack', 'd', 'not-subscribed'],
            ['nack', 'r', 'not-subscribed']
        ]);
    });

    it('refuses at the relay a NACK naming a peer outside the frame\'s frozen audience, carrying nothing upward', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], { a: PUBLISH_AND_SUBSCRIBE, r: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c'], topicSubscriptions: ACTIVE_TOKEN });
        const signed = await signReceiptedPublication(chain, { resourceId: 'feed-1', recipientPeerIds: ['r', 'c'], nextHopPeerId: 'r' });
        await relay.receive(signed, 'a');
        const sentBefore = (await relay.readSentControls('a')).length;

        await relay.receive(createStrayNotSubscribed(signed, 'stranger'), 'c');

        expect((await relay.readSentControls('a')).slice(sentBefore)).toEqual([]);
    });

    it('says nothing at an unsubscribed relay outside the frozen audience: it only forwards', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], { a: PUBLISH_AND_SUBSCRIBE, c: SUBSCRIBE_ONLY });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c'] });
        const signed = await signReceiptedPublication(chain, { resourceId: 'feed-1', recipientPeerIds: ['c'], nextHopPeerId: 'r' });

        await relay.receive(signed, 'a');

        expect(await relay.readSent('c')).toHaveLength(1);
        expect(toControlTuples(await relay.readSentControls('a')).filter(([type]) => type === 'nack')).toEqual([]);
    });
});

async function createRelayChain(
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

function createChainHop(chain: RelayChain, input: ChainHopInput): RtcRelayOverlayFixture {
    return createRtcRelayOverlayFixture({
        selfPeerId: input.selfPeerId,
        snapshot: chain.snapshot,
        neighbourPeerIds: input.neighbourPeerIds,
        grantedTopics: createRtcGrantedTopicsFixture([PUBLICATION_TOPIC_ID]),
        publicationCrypto: chain.keys[input.selfPeerId],
        topicSubscriptions: input.topicSubscriptions ?? NO_RTC_TOPIC_SUBSCRIPTIONS
    });
}

/** A receipted granted frame as the origin `a` signs it: its receipted send is refused until S3-ii's lift. */
async function signReceiptedPublication(chain: RelayChain, input: ReceiptedPublicationInput): Promise<ALMessage> {
    const frozen = createFrozenGrantedMulticast({
        senderId: 'a',
        resourceId: input.resourceId,
        recipientPeerIds: input.recipientPeerIds,
        snapshotVersion: 3,
        ack: 'receiver'
    });
    return await signPublication(chain.keys.a!, {
        ...frozen,
        forwarding: { ...frozen.forwarding, nextHopPeerIds: [input.nextHopPeerId] }
    });
}

/** The origin's own `receiver` receipt for the frame, as its RTC dispatch tracks it. */
async function createOriginReceipt(
    signed: ALMessage,
    tracking: Readonly<{ expectedPeerIds: readonly string[]; nextHopPeerIds: readonly string[]; }>
): Promise<OriginReceipt> {
    const facts: ALOutboundSettlementFact[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        settlements: (fact) => facts.push(fact),
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true }),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'volatile',
            preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
            ackTracking: { enabled: true, timeoutMs: 10_000, maxAttempts: 0, mode: 'receiver', ...tracking }
        })
    });
    await enqueueOutboundOrThrow(runtime, signed);
    return {
        facts,
        accept: async (controls) => {
            for (const control of controls) {
                await runtime.acceptControlMessage(control, 'peer');
            }
        }
    };
}

async function deliverEach(messages: readonly ALMessage[], to: RtcRelayOverlayFixture, fromPeerId: string): Promise<void> {
    for (const message of messages) {
        await to.receive(message, fromPeerId);
    }
}

function toReceiptStatement(facts: readonly ALOutboundSettlementFact[]) {
    const last = facts.filter((fact) => fact.kind === 'acknowledgement').at(-1);
    return last?.kind === 'acknowledgement'
        ? { confirmed: last.confirmedRecipientPeerIds, outside: last.outsideAudienceRecipientPeerIds, complete: last.complete }
        : undefined;
}

/** Each control as its type, the recipient it speaks for, and its status or reason. */
function toControlTuples(controls: readonly ALPeerControlMessage[]): readonly (readonly string[])[] {
    return controls.map((control) =>
        control.type === 'ack'
            ? ['ack', control.payload.logicalRecipientPeerId, control.payload.status]
            : control.type === 'nack'
            ? ['nack', control.payload.logicalRecipientPeerId, control.payload.reason]
            : ['repair', control.payload.fromPeerId, control.payload.reason]
    );
}

/** A `not-subscribed` NACK from the leaf `c` naming a peer the frame never froze. */
function createStrayNotSubscribed(signed: ALMessage, logicalRecipientPeerId: string): ALMessage {
    return newALNackControlMessage(
        { v: 4, msgId: 'stray-nack', ts: Date.now(), senderId: 'c', traceId: signed.id.traceId },
        {
            msgId: signed.id.msgId,
            fromPeerId: 'c',
            toPeerId: 'r',
            logicalRecipientPeerId,
            reason: 'not-subscribed',
            observedAtEpochMs: Date.now()
        }
    );
}

/** The tab's real token store holding the topic: its subscribe call never answers, so the token stays pending. */
function createPendingTopicSubscriptions(): Readonly<{ reader: RtcTopicSubscriptionReader; token: RallarTopicSubscription; }> {
    const unanswered = () => new Promise<never>(() => {});
    const store = new BrowserTopicSubscriptions({
        http: { subscribeGroupTopic: unanswered, unsubscribeGroupTopic: unanswered },
        timers: createDefaultTimers(),
        newRequestId: () => 'request-pending'
    });
    return { reader: store, token: store.hold({ roomRef: ORIGIN_ROOM, topicId: PUBLICATION_TOPIC_ID }) };
}
