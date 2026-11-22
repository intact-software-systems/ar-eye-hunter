import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage, newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';

import { createRtcGrantedTopicsFixture } from '../rtc-granted-topic-reader-fixtures.ts';
import {
    createOriginReceiverMulticast,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    toOriginDirectedSnapshot,
    toOriginFrozenTargets,
    type RtcOriginOverlayFixture
} from '../rtc-origin-overlay-fixture.ts';
import {
    createFrozenGrantedMulticast,
    PUBLICATION_TOPIC_ID,
    PUBLISH_AND_SUBSCRIBE,
    signPublication,
    SUBSCRIBE_ONLY
} from '../rtc-publication-proof-fixtures.ts';
import { createChainHop, createRelayChain, toControlTuples, type RelayChain } from '../rtc-relay-chain-test-support.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from '../rtc-relay-overlay-fixture.ts';
import { createRtcTopicSubscriptionsFixture } from '../rtc-topic-subscription-reader-fixtures.ts';

/** The content the forger `b` puts under the origin's id. */
const FORGED_RESOURCE = JSON.stringify({ text: 'forged by b' });

/**
 * The room `a`, `b`, `c`, each its own principal with its own registered key: `a` is the origin, `c` the recipient,
 * and `b` a room member that holds an RTC channel to `c` and forges.
 */
interface ForgeryRoom {
    readonly chain: RelayChain;
    readonly origin: RtcOriginOverlayFixture;
    readonly recipient: RtcRelayOverlayFixture;
}

/** The origin's receipted send and the transport copy it sent the recipient, which the test holds back. */
interface HeldOriginCopy {
    readonly message: ALMessage;
    readonly originCopy: ALMessage;
}

/**
 * S8-i (D590, option C ruled 2026-11-22): an ordinary RTC room send that tracks a `receiver` or `leader` receipt is
 * unsigned today, so any room member with a channel to a recipient can deliver other content under the origin's id.
 * Each test asserts the behaviour the ruling asks for, so it is red until the origin signs and every hop verifies.
 */
describe('a forged copy of an ordinary receipted RTC room send (S8-i, D590)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('never reaches the recipient\'s application and draws no delivered ACK', async () => {
        const room = await createForgeryRoom();
        const { originCopy } = await sendReceiverToRecipient(room, 'forged-before-origin');

        await room.recipient.receive(toForgedCopy(originCopy), 'b');

        // Today: the application receives FORGED_RESOURCE and `c` signs `['ack', 'c', 'delivered']` to `b`.
        expect(readDeliveredResources(room.recipient)).toEqual([]);
        expect(toControlTuples(await room.recipient.readSentControls('b'))).toEqual([]);
    });

    it('leaves the origin\'s receipt unconfirmed when the forger re-addresses the recipient\'s ACK to the origin', async () => {
        const room = await createForgeryRoom();
        const { message, originCopy } = await sendReceiverToRecipient(room, 'forged-ack-relayed');

        await room.recipient.receive(toForgedCopy(originCopy), 'b');
        for (const control of await room.recipient.readSent('b')) {
            await room.origin.manager.acceptControlMessage(toForgerRelayedAck(control));
        }

        // Today: the ACK's `fromPeerId` and `toPeerId` are outside its signed input, so the re-addressed ACK commits
        // and the receipt reads `c` confirmed.
        expect((await readOriginReceipt(room.origin, message))?.ackedPeerIds).toEqual([]);
    });

    it('delivers the origin\'s own copy that arrives after a forged one, so a confirmed recipient holds the origin\'s content', async () => {
        const room = await createForgeryRoom();
        const { message, originCopy } = await sendReceiverToRecipient(room, 'origin-after-forged');

        await room.recipient.receive(toForgedCopy(originCopy), 'b');
        await room.recipient.receive(originCopy, 'a');
        await acceptEach(room.origin, await room.recipient.readSent('a'));

        // Today: the origin's copy is a duplicate (`not-handled`) that is never delivered, yet `c` answers it
        // `delivered` and the origin's receipt confirms `c`, although `c`'s application holds only FORGED_RESOURCE.
        expect(readConfirmedDelivery(room, message)).toEqual({ confirmed: true, delivered: [originCopy.payload.resource] });
    });

    it('does not let a forged unreceipted copy turn the origin\'s receipted copy into an acknowledged duplicate', async () => {
        const room = await createForgeryRoom();
        const { message, originCopy } = await sendReceiverToRecipient(room, 'downgraded-forgery');
        // The forger cannot carry the origin's proof onto other content, and a copy that asks no receipt needs none.
        const downgraded: ALMessage = {
            ...toForgedCopy(originCopy),
            proof: undefined,
            delivery: { reliability: 'best-effort', ack: 'none' }
        };

        await room.recipient.receive(downgraded, 'b');
        await room.recipient.receive(originCopy, 'a');
        await acceptEach(room.origin, await room.recipient.readSent('a'));

        // Today: the forged copy asks for no receipt, so `c` answers nothing to `b`; the origin's copy is then a
        // duplicate that `c` still answers `delivered`, and the origin's receipt confirms `c` on content it never had.
        expect(toControlTuples(await room.recipient.readSentControls('b'))).toEqual([]);
        expect(readConfirmedDelivery(room, message)).toEqual({ confirmed: true, delivered: [originCopy.payload.resource] });
    });

    it('under a leader receipt, never reaches the director\'s application and draws no delivered ACK', async () => {
        const chain = await createRelayChain(['a', 'b', 'd'], {});
        const directed = toOriginDirectedSnapshot(chain.snapshot, 'd', Date.now());
        const origin = createRtcOriginOverlayFixture({
            snapshot: directed,
            nextHopPeerIds: ['b', 'd'],
            nextHopsBySessionId: { a: ['b', 'd'], b: ['a'], d: ['a'] },
            publicationCrypto: chain.keys.a
        });
        const director = createRtcRelayOverlayFixture({
            selfPeerId: 'd',
            snapshot: directed,
            neighbourPeerIds: ['a', 'b'],
            publicationCrypto: chain.keys.d
        });
        const message = createOriginLeaderMulticast('forged-to-director');
        expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');
        const originCopy = origin.channels.d!.sent[0]!;
        expect(originCopy.delivery).toEqual({ reliability: 'at-least-once', ack: 'group-leader' });

        await director.receive(toForgedCopy(originCopy), 'b');
        for (const control of await director.readSent('b')) {
            await origin.manager.acceptControlMessage(toForgerRelayedAck(control));
        }

        // Today: the director's application receives FORGED_RESOURCE, `d` signs `delivered` to `b`, and the
        // re-addressed ACK ends the origin's leader receipt.
        expect(readDeliveredResources(director)).toEqual([]);
        expect(toControlTuples(await director.readSentControls('b'))).toEqual([]);
        expect(await readOriginReceipt(origin, message)).toMatchObject({ ackedPeerIds: [] });
    });
});

describe('the RTC sends that are not exposed to a forger today (S8-i guards)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('refuses an RTC unicast under the origin\'s id whose channel peer is not its origin', async () => {
        const room = await createForgeryRoom();
        const unicast = createOriginReceiverUnicast('unicast-forged');

        await room.recipient.receive({ ...unicast, payload: { ...unicast.payload, resource: FORGED_RESOURCE } }, 'b');
        await room.recipient.receive(unicast, 'a');

        expect(readDeliveredResources(room.recipient)).toEqual([unicast.payload.resource]);
        expect(toControlTuples(await room.recipient.readSentControls('b'))).toEqual([]);
    });

    it('refuses a granted publication another member alters or re-signs, and delivers the origin\'s own copy', async () => {
        const chain = await createRelayChain(['a', 'b', 'c'], GRANTED_ROOM);
        const recipient = createChainHop(chain, {
            selfPeerId: 'c',
            neighbourPeerIds: ['a', 'b'],
            topicSubscriptions: createRtcTopicSubscriptionsFixture([PUBLICATION_TOPIC_ID])
        });
        const originCopy = await signPublication(
            chain.keys.a!,
            createFrozenGrantedMulticast({
                senderId: 'a',
                resourceId: 'granted-forged',
                recipientPeerIds: ['b', 'c'],
                snapshotVersion: 3,
                ack: 'receiver'
            })
        );
        const altered = toForgedCopy(originCopy);
        const reSigned = await signPublication(chain.keys.b!, { ...altered, proof: undefined });

        await recipient.receive(altered, 'b');
        await recipient.receive(reSigned, 'b');
        await recipient.receive(originCopy, 'a');

        expect(readDeliveredResources(recipient)).toEqual([originCopy.payload.resource]);
        // A proof under a key the room does not name for the sender may be a stale snapshot, so the re-signed copy is
        // held not-yet-in-sync and answered with a NACK to its channel peer: never delivered, never acknowledged.
        expect(readAdmissionReasons(recipient)).toEqual([
            'unauthorized: invalid-signature',
            'not-yet-in-sync: unknown-key',
            'admitted'
        ]);
        expect(toControlTuples(await recipient.readSentControls('b'))).toEqual([['nack', 'c', 'not-yet-in-sync']]);
    });
});

const GRANTED_ROOM: Readonly<Record<string, GroupPublicationTopicPermissions>> = {
    a: PUBLISH_AND_SUBSCRIBE,
    b: PUBLISH_AND_SUBSCRIBE,
    c: SUBSCRIBE_ONLY
};

async function createForgeryRoom(): Promise<ForgeryRoom> {
    const chain = await createRelayChain(['a', 'b', 'c'], {});
    const origin = createRtcOriginOverlayFixture({
        snapshot: chain.snapshot,
        nextHopPeerIds: ['b', 'c'],
        publicationCrypto: chain.keys.a
    });
    const recipient = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a', 'b'] });
    return { chain, origin, recipient };
}

/** The origin's `receiver` multicast frozen to `b` and `c`: `b` holds a true copy, so it knows the message id. */
async function sendReceiverToRecipient(room: ForgeryRoom, resourceId: string): Promise<HeldOriginCopy> {
    const message = { ...createOriginReceiverMulticast(resourceId), targets: toOriginFrozenTargets(['b', 'c'], 3) };
    expect((await enqueueAndDrain(room.origin.manager, message)).verdict.kind).toBe('admitted');
    const originCopy = room.origin.channels.c!.sent[0]!;
    expect(originCopy.proof).toBeDefined();
    expect(originCopy.delivery?.ack).toBe('all-logical-recipients');
    return { message, originCopy };
}

function createOriginLeaderMulticast(resourceId: string): ALMessage {
    return newALMulticastMessage(
        {
            createdAtEpochMs: Date.now(),
            senderId: 'a',
            route: { topicId: 'chat', resourceId, contextId: 'room' },
            groupRef: ORIGIN_ROOM,
            typeId: 'chat.message.v1',
            resource: { text: resourceId },
            options: { ack: 'group-leader', reliability: 'at-least-once', ttlMs: 30_000, traceId: `trace-${resourceId}` }
        }
    );
}

function createOriginReceiverUnicast(resourceId: string): ALMessage {
    return newALUnicastMessage(
        {
            createdAtEpochMs: Date.now(),
            senderId: 'a',
            route: { topicId: 'chat', resourceId, contextId: 'room' },
            toPeerId: 'c',
            typeId: 'chat.message.v1',
            resource: { text: resourceId },
            options: {
                groupRef: ORIGIN_ROOM,
                ack: 'receiver',
                reliability: 'at-least-once',
                ttlMs: 30_000,
                traceId: `trace-${resourceId}`
            }
        }
    );
}

/** The origin's copy with the forger's content: the id, sender, audience and receipt mode are the origin's. */
function toForgedCopy(originCopy: ALMessage): ALMessage {
    return { ...originCopy, payload: { ...originCopy.payload, resource: FORGED_RESOURCE } };
}

/**
 * The recipient's signed ACK as the forger `b` hands it on to the origin: it keeps the recipient's proof and rewrites
 * only `fromPeerId` and `toPeerId`, which the receipt proof does not sign (D584).
 */
function toForgerRelayedAck(control: ALMessage): ALMessage {
    const parsed = decodeALControlMessage(control).right;
    if (parsed?.type !== 'ack') {
        throw new Error('The recipient answered the forged copy with another control than an ACK.');
    }
    return newALAckControlMessage(
        { v: 4, msgId: `relayed-by-b-${control.id.msgId}`, senderId: 'b', ts: Date.now(), traceId: 'trace-forger' },
        { ...parsed.payload, fromPeerId: 'b', toPeerId: 'a' }
    );
}

async function acceptEach(origin: RtcOriginOverlayFixture, controls: readonly ALMessage[]): Promise<void> {
    for (const control of controls) {
        await origin.manager.acceptControlMessage(control);
    }
}

async function readOriginReceipt(origin: RtcOriginOverlayFixture, message: ALMessage) {
    return await origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId });
}

/** Whether the origin's last acknowledgement confirms the recipient `c`, beside what `c`'s application received. */
function readConfirmedDelivery(room: ForgeryRoom, message: ALMessage): { confirmed: boolean; delivered: readonly unknown[]; } {
    const last = room.origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement' && settlement.msgId === message.id.msgId)
        .at(-1);
    return {
        confirmed: last?.kind === 'acknowledgement' && last.confirmedRecipientPeerIds.includes('c'),
        delivered: readDeliveredResources(room.recipient)
    };
}

function readDeliveredResources(fixture: RtcRelayOverlayFixture): readonly unknown[] {
    return fixture.delivered.map((message) => message.payload.resource);
}

function readAdmissionReasons(fixture: RtcRelayOverlayFixture): readonly string[] {
    return fixture.diagnostics.flatMap((event) => event.kind === 'admission-outcome' ? [event.reason] : []);
}
