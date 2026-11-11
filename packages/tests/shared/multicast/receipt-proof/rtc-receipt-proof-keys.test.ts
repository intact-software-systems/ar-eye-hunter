import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALAckAlgo, ALQosEffectivePolicy } from '@shared/al-contracts/al-policy.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/normalize-al-qos-policy.ts';
import { isALDeliveryAdmissionFallbackVerdict } from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';
import {
    captureALOutboundPolicy,
    decodeALOutboundCapturedPolicy,
    toALOutboundSentPolicy
} from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type { ALOutboundDispatchPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupPresencePublicationKey, GroupSnapshot } from '@shared/api/group-types.ts';
import { computeRtcReceiptKeyRefusal } from '@shared/multicast/receipt-proof/compute-rtc-receipt-key-refusal.ts';
import { toRtcReceiptProofDispatchPlan } from '@shared/multicast/receipt-proof/to-rtc-receipt-proof-dispatch-plan.ts';
import { toRtcAckTrackingPlan } from '@shared/multicast/to-rtc-ack-tracking-plan.ts';

import { createAvailablePublicationCryptoFixture } from '../../signature/publication-crypto-fixtures.ts';
import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM,
    toOriginFrozenTargets
} from '../rtc-origin-overlay-fixture.ts';

import { signTestALReceiptControl, toTestALAckPayload } from '../../../al-control-test-payloads.ts';

const KEYLESS_DETAIL = 'RTC receipt cannot be verified: 1 of 2 counted recipients registered no publication key';

describe('the keys an RTC origin freezes for the recipients its receipt counts', () => {
    it('states each counted recipient\'s registered key on a receiver plan and none on a hop plan', async () => {
        const keys = await createPageKeys(['b', 'c']);
        const room = createKeyedRoom(keys);

        const receiver = toRtcReceiptProofDispatchPlan(createFrozenPlan('receiver'), { room, selfPeerId: 'a', nowMs: Date.now() });
        const hop = toRtcReceiptProofDispatchPlan(createFrozenPlan('hop'), { room, selfPeerId: 'a', nowMs: Date.now() });

        expect(receiver.receiptProofKeys).toEqual({ b: keys.b, c: keys.c });
        expect(hop.receiptProofKeys).toBeUndefined();
    });

    it('refuses a receiver leg that counts a keyless session as unsupported, naming the message with its sender\'s targets', async () => {
        const keys = await createPageKeys(['b']);
        const original = newALBroadcastMessage('a', ROUTE, 'room', 'chat.message.v1', {}, {
            groupRef: ORIGIN_ROOM,
            recipientPeerIds: ['b', 'c']
        });
        const frozen: ALMessage = { ...original, targets: toOriginFrozenTargets(['b', 'c'], 4) };

        const refusal = computeRtcReceiptKeyRefusal({
            msg: frozen,
            original,
            effective: createEffectivePolicy(frozen, 'receiver'),
            room: createKeyedRoom(keys),
            canVerify: true,
            storedSend: false,
            nowMs: Date.now()
        });

        expect(refusal.left?.dropReasonCode).toBe('unsupported');
        expect(refusal.left?.dropReason).toBe(KEYLESS_DETAIL);
        expect(refusal.left?.lane).toBe('volatile');
        expect(refusal.left?.preparedMessages).toEqual([]);
        expect(refusal.left?.msg.targets).toEqual(original.targets);
    });

    it('refuses a leg whose origin page cannot verify', async () => {
        const message = createFrozenMulticast(['b', 'c']);

        const refusal = computeRtcReceiptKeyRefusal({
            msg: message,
            original: message,
            effective: createEffectivePolicy(message, 'leader'),
            room: createKeyedRoom(await createPageKeys(['b', 'c'])),
            canVerify: false,
            storedSend: false,
            nowMs: Date.now()
        });

        expect(refusal.left?.dropReasonCode).toBe('unsupported');
        expect(refusal.left?.dropReason).toBe('RTC receipt cannot be verified: this page holds no WebCrypto');
    });

    it('does not refuse a send that counts nobody on a page without WebCrypto', () => {
        const message = createFrozenMulticast([]);

        const refusal = computeRtcReceiptKeyRefusal({
            msg: message,
            original: message,
            effective: createEffectivePolicy(message, 'receiver'),
            room: createKeyedRoom({}),
            canVerify: false,
            storedSend: false,
            nowMs: Date.now()
        });

        expect(refusal.right).toBe(message);
    });

    it('refuses a receiver unicast whose addressee the room does not key, and one that names no room', async () => {
        const roomUnicast = newALUnicastMessage('a', ROUTE, 'b', 'chat.message.v1', {}, { groupRef: ORIGIN_ROOM });
        const roomlessUnicast = newALUnicastMessage('a', ROUTE, 'b', 'chat.message.v1', {});
        const detail = 'RTC receipt cannot be verified: 1 of 1 counted recipients registered no publication key';

        const keyless = computeRtcReceiptKeyRefusal({
            msg: roomUnicast,
            original: roomUnicast,
            effective: createEffectivePolicy(roomUnicast, 'receiver'),
            room: createKeyedRoom(await createPageKeys(['c'])),
            canVerify: true,
            storedSend: false,
            nowMs: Date.now()
        });
        const roomless = computeRtcReceiptKeyRefusal({
            msg: roomlessUnicast,
            original: roomlessUnicast,
            effective: createEffectivePolicy(roomlessUnicast, 'receiver'),
            room: undefined,
            canVerify: true,
            storedSend: false,
            nowMs: Date.now()
        });

        expect(keyless.left?.dropReasonCode).toBe('unsupported');
        expect(keyless.left?.dropReason).toBe(detail);
        expect(roomless.left?.dropReasonCode).toBe('unsupported');
        expect(roomless.left?.dropReason).toBe('RTC receipt cannot be verified: the message names no room to key its addressee');
    });

    it('leaves a send whose named room has no cached snapshot to its own admission', () => {
        const roomUnicast = newALUnicastMessage('a', ROUTE, 'b', 'chat.message.v1', {}, { groupRef: ORIGIN_ROOM });
        const frozen = createFrozenMulticast(['b', 'c']);

        const unicast = computeRtcReceiptKeyRefusal({
            msg: roomUnicast,
            original: roomUnicast,
            effective: createEffectivePolicy(roomUnicast, 'receiver'),
            room: undefined,
            canVerify: true,
            storedSend: false,
            nowMs: Date.now()
        });
        const multicast = computeRtcReceiptKeyRefusal({
            msg: frozen,
            original: frozen,
            effective: createEffectivePolicy(frozen, 'receiver'),
            room: undefined,
            canVerify: true,
            storedSend: false,
            nowMs: Date.now()
        });

        expect(unicast.right).toBe(roomUnicast);
        expect(multicast.right).toBe(frozen);
    });

    it('states no key record without a room, and none when no counted recipient is keyed', () => {
        const roomless = toRtcReceiptProofDispatchPlan(createFrozenPlan('receiver'), { room: undefined, selfPeerId: 'a', nowMs: Date.now() });
        const keyless = toRtcReceiptProofDispatchPlan(createFrozenPlan('receiver'), {
            room: createKeyedRoom({}),
            selfPeerId: 'a',
            nowMs: Date.now()
        });

        expect(roomless).not.toHaveProperty('receiptProofKeys');
        expect(keyless).not.toHaveProperty('receiptProofKeys');
    });

    it('leaves a counted session the room does not name to the planner and states no key for it', async () => {
        const keys = await createPageKeys(['b']);
        const message = createFrozenMulticast(['b', 'c', 'z']);
        const keyed = createKeyedRoom(keys);
        const room: GroupSnapshot = {
            ...keyed,
            activeSessions: keyed.activeSessions.map((session) => session.sessionId === 'c' ? { ...session, expiresAtEpochMs: Date.now() - 1 } : session)
        };
        const plan = { ...createFrozenPlan('receiver'), msg: message };

        const refusal = computeRtcReceiptKeyRefusal({
            msg: message,
            original: message,
            effective: createEffectivePolicy(message, 'receiver'),
            room,
            canVerify: true,
            storedSend: false,
            nowMs: Date.now()
        });
        const planned = toRtcReceiptProofDispatchPlan(plan, { room, selfPeerId: 'a', nowMs: Date.now() });

        expect(refusal.right).toBe(message);
        expect(planned.receiptProofKeys).toEqual({ b: keys.b });
    });

    it('passes a stored send whose recipient left', async () => {
        const message = createFrozenMulticast(['b', 'c']);
        const left = createOriginSnapshot(['a', 'b'], 5);

        const refusal = computeRtcReceiptKeyRefusal({
            msg: message,
            original: message,
            effective: createEffectivePolicy(message, 'receiver'),
            room: { ...left, activeSessions: left.activeSessions.map((session) => ({ ...session, publicationKey: null })) },
            canVerify: true,
            storedSend: true,
            nowMs: Date.now()
        });

        expect(refusal.right).toBe(message);
    });

    it('keeps the first dispatch\'s keys when a later plan states others', async () => {
        const first = { ...createFrozenPlan('receiver'), receiptProofKeys: await createPageKeys(['b', 'c']) };
        const later = { ...createFrozenPlan('receiver'), receiptProofKeys: await createPageKeys(['b']) };

        expect(toALOutboundSentPolicy(captureALOutboundPolicy(first), later).receiptProofKeys).toEqual(first.receiptProofKeys);
    });

    it('adopts the plan\'s keys when the stored policy has none', async () => {
        const later = { ...createFrozenPlan('receiver'), receiptProofKeys: await createPageKeys(['b', 'c']) };

        expect(toALOutboundSentPolicy(captureALOutboundPolicy(createFrozenPlan('receiver')), later).receiptProofKeys)
            .toEqual(later.receiptProofKeys);
    });

    it('leaves a replan of an already frozen stored send alone when a recipient has since lost its key', async () => {
        const keys = await createPageKeys(['b', 'c']);
        const message = createFrozenMulticast(['b', 'c']);
        const room = createKeyedRoom({ b: keys.b! });
        const stored = captureALOutboundPolicy({ ...createFrozenPlan('receiver'), receiptProofKeys: keys });

        const refusal = computeRtcReceiptKeyRefusal({
            msg: message,
            original: message,
            effective: createEffectivePolicy(message, 'receiver'),
            room,
            canVerify: true,
            storedSend: true,
            nowMs: Date.now()
        });
        const replanned = toRtcReceiptProofDispatchPlan(createFrozenPlan('receiver'), { room, selfPeerId: 'a', nowMs: Date.now() });

        expect(refusal.right).toBe(message);
        expect(toALOutboundSentPolicy(stored, replanned).receiptProofKeys).toEqual(keys);
    });

    it('refuses a captured key record with an empty session id', async () => {
        const keys = await createPageKeys(['b']);
        const captured = captureALOutboundPolicy({ ...createFrozenPlan('receiver'), receiptProofKeys: keys });

        expect(() => decodeALOutboundCapturedPolicy({ ...captured, receiptProofKeys: { '': keys.b! } })).toThrow(TypeError);
    });

    it('round-trips the captured keys through the sent row\'s closed decoder and refuses a malformed key', async () => {
        const keys = await createPageKeys(['b', 'c']);
        const captured = captureALOutboundPolicy({ ...createFrozenPlan('receiver'), receiptProofKeys: keys });
        const privateMember = { ...captured, receiptProofKeys: { b: { ...keys.b!, publicJwk: { ...keys.b!.publicJwk, d: 'x' } } } };
        const shortKeyId = { ...captured, receiptProofKeys: { b: { ...keys.b!, keyId: 'short' } } };

        expect(decodeALOutboundCapturedPolicy(JSON.parse(JSON.stringify(captured)))).toEqual(captured);
        expect(captured.receiptProofKeys).toEqual(keys);
        expect(() => decodeALOutboundCapturedPolicy(privateMember)).toThrow(TypeError);
        expect(() => decodeALOutboundCapturedPolicy(shortKeyId)).toThrow(TypeError);
    });
});

describe('an RTC origin\'s receipted leg over a keyless recipient', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('hands a receiver leg with a keyless recipient to the fallback at admission', async () => {
        const fixture = await createKeylessRecipientFixture();
        const message = createOriginReceiverMulticast('keyless-hand-over');

        const result = await fixture.manager.enqueueLegIfAbsent(message, 'hand-over');
        await vi.advanceTimersByTimeAsync(0);

        expect(result.verdict).toEqual({ kind: 'refused', reason: 'unsupported', detail: KEYLESS_DETAIL });
        expect(isALDeliveryAdmissionFallbackVerdict(result.verdict)).toBe(true);
        expect(result.message.targets).toEqual(message.targets);
        expect(await fixture.resources.admissionStore.readSentMessage(message.id.msgId)).toBeUndefined();
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toBeUndefined();
    });

    it('refuses it under rtc alone, never admitting it to time out', async () => {
        const fixture = await createKeylessRecipientFixture();
        const message = createOriginReceiverMulticast('keyless-hold');

        const result = await fixture.manager.enqueueLegIfAbsent(message, 'hold');
        await vi.advanceTimersByTimeAsync(60_000);

        expect(result.verdict).toEqual({ kind: 'refused', reason: 'unsupported', detail: KEYLESS_DETAIL });
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
        expect(fixture.settlements).toEqual([]);
        expect(await fixture.resources.admissionStore.readSentMessage(message.id.msgId)).toBeUndefined();
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toBeUndefined();
    });

    it('a send held without a room snapshot states its counted recipients\' keys when the snapshot arrives', async () => {
        const keys = await createPageKeys(['b', 'c']);
        const { fixture, message, held } = await holdWithoutRoomSnapshot('held-keyed');

        fixture.groups.accept('room', createKeyedRoom(keys));
        await vi.advanceTimersByTimeAsync(5_000);

        expect(held.verdict).toMatchObject({ kind: 'admitted', queuedAttempts: 0 });
        expect(fixture.channels.b!.sent.length).toBeGreaterThan(0);
        expect((await fixture.resources.admissionStore.readStoredMessage(message.id.msgId))?.policy.receiptProofKeys)
            .toEqual(keys);
    });

    it('Limit: a send held without a room snapshot is dropped unsettled at its freezing dequeue if a counted recipient is keyless', async () => {
        // Limit (S8-i): a stored-stage unsupported refusal is not settled and not handed to the fallback; the room-limit refusal shares it.
        const { fixture, message, held } = await holdWithoutRoomSnapshot('held-keyless');

        fixture.groups.accept('room', createKeyedRoom(await createPageKeys(['b'])));
        await vi.advanceTimersByTimeAsync(5_000);

        const keys = (await fixture.resources.admissionStore.readStoredMessage(message.id.msgId))?.policy.receiptProofKeys;
        await vi.advanceTimersByTimeAsync(60_000);

        expect(held.verdict).toMatchObject({ kind: 'admitted', queuedAttempts: 0 });
        expect(keys).toBeUndefined();
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent, ...fixture.channels.d!.sent]).toEqual([]);
        expect(fixture.settlements.map((settlement) => settlement.kind)).toEqual(['attempt-settled']);
        expect(fixture.settlements[0]).toMatchObject({ outcome: 'not-ready', willRetry: true });
    });

    it('a held already-frozen send states its keys at the dequeue that first sees its room', async () => {
        const keys = await createPageKeys(['b', 'c']);
        const { fixture, message, held } = await holdWithoutRoomSnapshot('held-frozen-keyed', ['b', 'c']);

        fixture.groups.accept('room', createKeyedRoom(keys));
        await vi.advanceTimersByTimeAsync(5_000);

        expect(held.verdict).toMatchObject({ kind: 'admitted', queuedAttempts: 0 });
        expect(fixture.channels.b!.sent.length).toBeGreaterThan(0);
        expect((await fixture.resources.admissionStore.readStoredMessage(message.id.msgId))?.policy.receiptProofKeys)
            .toEqual(keys);
    });

    it('Limit: a held already-frozen send to a keyless recipient is sent and left to its receipt timeout', async () => {
        // Limit (S8-i): the stored plan of a send frozen before its admission is never judged, so a fix would refuse it unsupported and send nothing.
        const keys = await createPageKeys(['b']);
        const { fixture, message, held } = await holdWithoutRoomSnapshot('held-frozen-keyless', ['b', 'c']);

        fixture.groups.accept('room', createKeyedRoom(keys));
        await vi.advanceTimersByTimeAsync(5_000);

        expect(held.verdict).toMatchObject({ kind: 'admitted', queuedAttempts: 0 });
        expect(fixture.channels.c!.sent.length).toBeGreaterThan(0);
        expect((await fixture.resources.admissionStore.readStoredMessage(message.id.msgId))?.policy.receiptProofKeys)
            .toEqual(keys);
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'admission')).toEqual([]);
        // The Limit is per recipient: `b`'s key was frozen, `c` has none, so even `c`'s own signed ACK keys nobody.
        const ownAck = await signTestALReceiptControl(await createAvailablePublicationCryptoFixture(), {
            type: 'ack',
            payload: toTestALAckPayload({ ackedMsgId: message.id.msgId, fromPeerId: 'c', toPeerId: 'a', observedAtEpochMs: Date.now() })
        });
        expect(
            await fixture.manager.acceptControlMessage(
                newALAckControlMessage({ v: 4, msgId: 'ack-c-own', senderId: 'c', ts: Date.now(), traceId: 'trace-limit' }, ownAck.payload)
            )
        ).toMatchObject({ kind: 'rejected', proofRefusal: { kind: 'unknown-key', claimedRecipientPeerId: 'c', channelPeerId: 'c' } });
    });

    it('counts the recipients its dequeue froze, so a counted recipient\'s own unsigned ACK there is missing-proof', async () => {
        // The row's policy was captured before the freeze and expects nobody; the canonical's frozen targets name who counts.
        const { fixture, message } = await holdWithoutRoomSnapshot('held-freeze-counted');
        fixture.groups.accept('room', createKeyedRoom(await createPageKeys(['b', 'c'])));
        await vi.advanceTimersByTimeAsync(5_000);

        const admitted = await fixture.manager.acceptControlMessage(newALAckControlMessage(
            { v: 4, msgId: 'ack-b-unsigned', senderId: 'b', ts: Date.now(), traceId: 'trace-held-freeze' },
            toTestALAckPayload({ ackedMsgId: message.id.msgId, fromPeerId: 'b', toPeerId: 'a', observedAtEpochMs: Date.now() })
        ));

        expect((await fixture.resources.admissionStore.readStoredMessage(message.id.msgId))?.policy.ackTracking?.expectedPeerIds)
            .toEqual([]);
        expect(admitted).toMatchObject({
            kind: 'rejected',
            proofRefusal: { kind: 'missing-proof', claimedRecipientPeerId: 'b', channelPeerId: 'b' }
        });
    });

    it('Limit: a send whose row froze no key reads unknown-key and runs to its retry', async () => {
        // Limit (S8-i): a held already-frozen send whose room keys none of its counted recipients is sent unjudged and
        // stores no key record, so even a recipient's own signed ACK keys nobody; its receipt retries, then times out.
        const { fixture, message } = await holdWithoutRoomSnapshot('held-frozen-unkeyed', ['b', 'c']);
        fixture.groups.accept('room', createKeyedRoom({}));
        for (let step = 0; step < 50 && fixture.channels.c!.sent.length === 0; step++) {
            await vi.advanceTimersByTimeAsync(100);
        }
        const sentBefore = fixture.channels.c!.sent.length;
        const c = await createAvailablePublicationCryptoFixture();
        const ack = await signTestALReceiptControl(c, {
            type: 'ack',
            payload: toTestALAckPayload({
                ackedMsgId: message.id.msgId,
                fromPeerId: 'c',
                toPeerId: 'a',
                observedAtEpochMs: Date.now()
            })
        });

        const admitted = await fixture.manager.acceptControlMessage(
            newALAckControlMessage({ v: 4, msgId: 'ack-c', senderId: 'c', ts: Date.now(), traceId: 'trace-limit' }, ack.payload)
        );
        await vi.advanceTimersByTimeAsync(5_000);

        expect(sentBefore).toBeGreaterThan(0);
        expect((await fixture.resources.admissionStore.readStoredMessage(message.id.msgId))?.policy.receiptProofKeys)
            .toBeUndefined();
        expect(admitted).toMatchObject({
            kind: 'rejected',
            proofRefusal: { kind: 'unknown-key', claimedRecipientPeerId: 'c', channelPeerId: 'c' }
        });
        expect(fixture.channels.c!.sent.length).toBeGreaterThan(sentBefore);
    });

    it('defers a durable room unicast held without its room snapshot, storing nothing, and judges it when it is admitted again', async () => {
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b', 'c'], 4),
            nextHopPeerIds: ['b', 'c'],
            publicationCrypto: await createAvailablePublicationCryptoFixture()
        });
        fixture.groups.delete('room');
        const message = newALUnicastMessage('a', ROUTE, 'b', 'chat.message.v1', {}, {
            groupRef: ORIGIN_ROOM,
            ack: 'all-logical-recipients',
            reliability: 'at-least-once',
            ttlMs: 30_000,
            qos: { durability: { algo: 'local-outbox' } }
        });

        const held = await fixture.manager.enqueueLegIfAbsent(message, 'hold');
        await vi.advanceTimersByTimeAsync(0);
        fixture.groups.accept('room', createKeyedRoom(await createPageKeys(['c'])));
        await vi.advanceTimersByTimeAsync(5_000);
        const storedWhileHeld = await fixture.resources.admissionStore.readStoredMessage(message.id.msgId);
        const readmitted = await fixture.manager.enqueueLegIfAbsent(message, 'hold');

        expect(held.verdict).toMatchObject({ kind: 'deferred', reason: 'not-yet-in-sync' });
        expect(storedWhileHeld).toBeUndefined();
        expect(readmitted.verdict).toEqual({
            kind: 'refused',
            reason: 'unsupported',
            detail: 'RTC receipt cannot be verified: 1 of 1 counted recipients registered no publication key'
        });
        expect(fixture.channels.b!.sent).toEqual([]);
    });

    it('captures every counted recipient\'s key on the sent row of an admitted receiver send', async () => {
        const keys = await createPageKeys(['b', 'c']);
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createKeyedRoom(keys),
            nextHopPeerIds: ['b', 'c'],
            publicationCrypto: await createAvailablePublicationCryptoFixture()
        });
        const message = createOriginReceiverMulticast('keyed');

        const result = await fixture.manager.enqueueLegIfAbsent(message, 'hold');
        await vi.advanceTimersByTimeAsync(0);

        expect(result.verdict).toMatchObject({ kind: 'admitted' });
        expect((await fixture.resources.admissionStore.readStoredMessage(message.id.msgId))?.policy.receiptProofKeys)
            .toEqual(keys);
    });

    it('a send whose first admission conflicted still verifies its counted recipients\' ACKs', async () => {
        const recipients = { b: await createAvailablePublicationCryptoFixture(), c: await createAvailablePublicationCryptoFixture() };
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createKeyedRoom({ b: toGroupPresencePublicationKey(recipients.b)!, c: toGroupPresencePublicationKey(recipients.c)! }),
            nextHopPeerIds: ['b', 'c'],
            publicationCrypto: await createAvailablePublicationCryptoFixture()
        });
        const store = fixture.resources.admissionStore;
        const commitBundle = store.commitBundle.bind(store);
        let conflicts = 0;
        vi.spyOn(store, 'commitBundle').mockImplementation(async (bundle, observation) => {
            if (conflicts > 0) {
                return await commitBundle(bundle, observation);
            }
            conflicts++;
            return 'conflict';
        });
        const message = createOriginReceiverMulticast('conflicted-keyed');

        await fixture.manager.enqueueLegIfAbsent(message, 'hold');
        await vi.advanceTimersByTimeAsync(10);
        const sentBefore = [fixture.channels.b!.sent.length, fixture.channels.c!.sent.length];
        const admitted = [];
        for (const peerId of ['b', 'c'] as const) {
            const signed = await signTestALReceiptControl(recipients[peerId], {
                type: 'ack',
                payload: toTestALAckPayload({
                    ackedMsgId: message.id.msgId,
                    fromPeerId: peerId,
                    toPeerId: 'a',
                    originPeerId: 'a',
                    logicalRecipientPeerId: peerId,
                    carrier: 'rtc',
                    observedAtEpochMs: Date.now()
                })
            });
            admitted.push(
                await fixture.manager.acceptControlMessage(newALAckControlMessage(
                    { v: 4, msgId: `ack-${peerId}-conflicted`, senderId: peerId, ts: Date.now(), traceId: 'trace-conflicted' },
                    signed.payload
                ))
            );
        }
        await vi.advanceTimersByTimeAsync(30_000);

        expect(conflicts).toBe(1);
        expect(sentBefore).toEqual([1, 1]);
        expect(admitted).toEqual([{ kind: 'committed' }, { kind: 'committed' }]);
        expect([fixture.channels.b!.sent.length, fixture.channels.c!.sent.length]).toEqual(sentBefore);
    });
});

const ROUTE = { topicId: 'chat', resourceId: 'counted', contextId: ORIGIN_ROOM.groupId };

async function createPageKeys(sessionIds: readonly string[]): Promise<Record<string, GroupPresencePublicationKey>> {
    const entries = await Promise.all(sessionIds.map(async (sessionId) =>
        [
            sessionId,
            toGroupPresencePublicationKey(await createAvailablePublicationCryptoFixture())!
        ] as const
    ));
    return Object.fromEntries(entries);
}

/** The origin room of `a`, `b` and `c`, where a session absent from `keys` registered none. */
function createKeyedRoom(keys: Readonly<Record<string, GroupPresencePublicationKey>>): GroupSnapshot {
    const snapshot = createOriginSnapshot(['a', 'b', 'c'], 4);
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => ({ ...session, publicationKey: keys[session.sessionId] ?? null }))
    };
}

async function createKeylessRecipientFixture() {
    return createRtcOriginOverlayFixture({
        snapshot: createKeyedRoom(await createPageKeys(['a', 'b'])),
        nextHopPeerIds: ['b', 'c'],
        publicationCrypto: await createAvailablePublicationCryptoFixture()
    });
}

/** A durable receiver send, frozen to `frozenPeerIds` when given, the origin admits while its room snapshot is not cached. */
async function holdWithoutRoomSnapshot(resourceId: string, frozenPeerIds?: readonly string[]) {
    const fixture = createRtcOriginOverlayFixture({
        snapshot: createOriginSnapshot(['a', 'b', 'c'], 4),
        nextHopPeerIds: ['b', 'c'],
        publicationCrypto: await createAvailablePublicationCryptoFixture()
    });
    fixture.groups.delete('room');
    const unfrozen: ALMessage = { ...createOriginReceiverMulticast(resourceId), qos: { durability: { algo: 'local-outbox' } } };
    const message = frozenPeerIds === undefined ? unfrozen : { ...unfrozen, targets: toOriginFrozenTargets(frozenPeerIds, 4) };
    const held = await fixture.manager.enqueueLegIfAbsent(message, 'hold');
    await vi.advanceTimersByTimeAsync(0);
    return { fixture, message, held };
}

function createFrozenMulticast(recipientPeerIds: readonly string[]): ALMessage {
    const message = newALMulticastMessage('a', ROUTE, ORIGIN_ROOM, 'chat.message.v1', {});
    return { ...message, targets: toOriginFrozenTargets(recipientPeerIds, 4) };
}

function createEffectivePolicy(message: ALMessage, algo: ALAckAlgo): ALQosEffectivePolicy {
    const effective = normalizeALQosPolicy(message).effective;
    return { ...effective, ack: { ...effective.ack, algo } };
}

function createFrozenPlan(algo: ALAckAlgo): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    const msg = createFrozenMulticast(['b', 'c']);
    return {
        msg,
        dropReasonCode: undefined,
        lane: 'volatile',
        preparedMessages: [],
        ackTracking: toRtcAckTrackingPlan(createEffectivePolicy(msg, algo), ['b', 'c'])
    };
}
