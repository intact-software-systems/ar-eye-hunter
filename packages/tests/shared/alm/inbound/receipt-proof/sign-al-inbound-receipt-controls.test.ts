import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    newALMulticastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import type { ALInboundNackPlanReason } from '@shared/al-contracts/al-control-value-codec.ts';
import {
    decodeALPeerControlMessage,
    newALAckControlMessage,
    type ALPeerControlMessage
} from '@shared/al-contracts/al-control.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import type { ALAckAlgo, ALMessageHandlingPlan } from '@shared/al-contracts/al-policy.ts';
import type { ALReceiptProofSignerPort } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';
import { toALMessageTrace } from '@shared/al-contracts/trace/to-al-message-trace.ts';
import { validateALInboundCommitBundle } from '@shared/alm/inbound/admission/validate-al-inbound-commit-bundle.ts';
import type { ALInboundCommitBundle } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { decodeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import {
    signALInboundReceiptControls,
    type ALInboundReceiptProofs
} from '@shared/alm/inbound/receipt-proof/sign-al-inbound-receipt-controls.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { RtcReceiptProofSigner } from '@shared/multicast/receipt-proof/rtc-receipt-proof-signer.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { Either } from '@shared/resilience/Either.ts';

import { toTestALAckPayload, verifyTestALReceiptControl } from '../../../../al-control-test-payloads.ts';
import { createAvailablePublicationCryptoFixture } from '../../../signature/publication-crypto-fixtures.ts';
import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE,
    readInboundTestAdmission,
    type InboundTestRuntime
} from '../../inbound-runtime-test-fixture.ts';

const NAMESPACE = 'sign-al-inbound-receipt-controls';
const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room' };
const CHILD_PEER_ID = 'child';
const RTC_SOURCE: ALInboundMessageRuntime.Source = { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID };
const CRYPTO = await createAvailablePublicationCryptoFixture();
const SIGNED: ALInboundReceiptProofs = { kind: 'signed', signer: new RtcReceiptProofSigner({ crypto: CRYPTO }) };

const REFUSING_SIGNER: ALReceiptProofSignerPort = {
    signReceiptProof: async () => Either.ofLeft({ kind: 'sign-failed', message: 'refused' })
};

afterEach(() => {
    vi.restoreAllMocks();
});

/** A real admission's bundle whose `send-control` effect is marked as its counted recipient's own. */
async function readMarkedAdmission(msgId: string): Promise<ALInboundCommitBundle> {
    const stores = createInboundTestStores({
        namespace: NAMESPACE,
        storage: 'memory',
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const bundle = await readInboundTestAdmission(
        stores.admissionStore,
        createInboundTestMessage({ msgId, acknowledged: true })
    );
    return {
        ...bundle,
        durableEffects: bundle.durableEffects.map((effect) => effect.payload.kind === 'send-control' ? { ...effect, signsForRecipient: true } : effect)
    };
}

function readControlEffectIndex(bundle: ALInboundCommitBundle): number {
    return bundle.durableEffects.findIndex((effect) => effect.payload.kind === 'send-control');
}

describe('signALInboundReceiptControls', () => {
    it('returns the bundle untouched under carrier authentication', async () => {
        const bundle = await readMarkedAdmission('carrier-authenticated');

        const signed = await signALInboundReceiptControls({
            bundle,
            namespace: NAMESPACE,
            receiptProofs: { kind: 'carrier-authenticated' },
            diagnostics: undefined
        });

        expect(signed).toBe(bundle);
    });

    it('signs a marked control and leaves every other effect and mutation as it was', async () => {
        const bundle = await readMarkedAdmission('signed');
        const index = readControlEffectIndex(bundle);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(bundle.durableEffects.length).toBeGreaterThan(1);

        const signed = await signALInboundReceiptControls({
            bundle,
            namespace: NAMESPACE,
            receiptProofs: SIGNED,
            diagnostics: undefined
        });

        const marked = bundle.durableEffects[index]!;
        const control = signed.durableEffects[index]!;
        const stored = decodeALInboundWorkEntry(control.entry, NAMESPACE).payload;
        expect(stored.kind).toBe('send-control');
        expect(stored.kind === 'send-control' && await verifyTestALReceiptControl(CRYPTO, stored.msg)).toBe(true);
        // Only the stored resource changes: the rebuilt write is the marked one, now signed and no longer marked.
        expect({ ...control, payload: undefined, entry: { ...control.entry, resource: undefined } }).toEqual({
            ...marked,
            payload: undefined,
            signsForRecipient: false,
            entry: { ...marked.entry, resource: undefined }
        });
        expect(signed.durableEffects.filter((_, at) => at !== index))
            .toEqual(bundle.durableEffects.filter((_, at) => at !== index));
        expect(signed.mutations).toEqual(bundle.mutations);
        expect(validateALInboundCommitBundle(signed, NAMESPACE).right).toBeDefined();
    });

    it('leaves a control whose sign failed out, writes one receipt-sign diagnostic and keeps a bundle the store validates', async () => {
        const bundle = await readMarkedAdmission('refused');
        const index = readControlEffectIndex(bundle);
        const marked = bundle.durableEffects[index]!.payload;
        if (marked.kind !== 'send-control') {
            throw new Error('The admission wrote no control');
        }
        const events: ALInboundRuntimeDiagnosticsEvent[] = [];

        const signed = await signALInboundReceiptControls({
            bundle,
            namespace: NAMESPACE,
            receiptProofs: { kind: 'signed', signer: REFUSING_SIGNER },
            diagnostics: (event) => events.push(event)
        });

        expect(signed.durableEffects).toEqual(bundle.durableEffects.filter((_, at) => at !== index));
        expect(events).toEqual([{
            kind: 'receipt-sign',
            msgId: marked.msg.id.msgId,
            typeId: marked.msg.payload.typeId,
            targetMsgId: 'refused',
            reason: 'sign-failed: refused',
            ...toALMessageTrace(marked.msg)
        }]);
        expect(validateALInboundCommitBundle(signed, NAMESPACE).right).toBeDefined();
        expect(signed.mutations).toEqual(bundle.mutations);
    });
});

interface SigningRuntimeInput {
    readonly name: string;
    readonly carrier?: 'rtc' | 'ws';
    readonly plan?: (plan: ALMessageHandlingPlan) => ALMessageHandlingPlan;
    /** Absent, the runtime forwards nothing. */
    readonly relays?: boolean;
    /** Absent, every local delivery may be dispatched. */
    readonly canDispatchMessage?: () => boolean;
}

function createSigningRuntime(input: SigningRuntimeInput): InboundTestRuntime {
    const stores = createInboundTestStores({
        namespace: `${NAMESPACE}-${input.name}`,
        storage: 'memory',
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const relay = (plan: ALMessageHandlingPlan): ALMessageHandlingPlan => ({
        ...plan,
        ack: { ...plan.ack, deferred: true },
        forwarding: { enabled: true, nextHopPeerIds: [CHILD_PEER_ID], persist: false }
    });
    return createInboundTestRuntime({
        stores,
        carrier: input.carrier ?? 'rtc',
        effectWorkerId: `al-inbound:${input.name}`,
        receiptProofs: SIGNED,
        plan: (plan) => {
            const planned = input.plan?.(plan) ?? plan;
            return input.relays === true ? relay(planned) : planned;
        },
        forwardMessage: input.relays === true ? async () => {} : undefined,
        canDispatchMessage: input.canDispatchMessage
    });
}

/** The receiver unicast at `seq` of the sender's ordered track. */
function createOrderedReceiverUnicast(msgId: string, seq: number): ALMessage {
    return { ...createReceiverUnicast(msgId), ordering: { orderingKey: 'chat', seq } };
}

function createReceiverUnicast(msgId: string, algo: ALAckAlgo = 'receiver'): ALMessage {
    const message = newALUnicastMessage(
        INBOUND_TEST_SENDER_PEER_ID,
        { topicId: 'chat', resourceId: msgId, contextId: 'room' },
        INBOUND_TEST_SELF_PEER_ID,
        'chat.private-text.v1',
        { text: msgId },
        { ttlMs: 60_000, qos: { ack: { algo } } }
    );
    return { ...message, id: { ...message.id, msgId } };
}

/** A receiver multicast frozen to `recipientPeerIds`, which this session relays to its child. */
function createFrozenRoomMulticast(msgId: string, recipientPeerIds: readonly string[]): ALMessage {
    const message = newALMulticastMessage(
        INBOUND_TEST_SENDER_PEER_ID,
        { topicId: 'chat', resourceId: msgId, contextId: 'room' },
        ROOM,
        'chat.message.v1',
        { text: msgId },
        { ack: 'all-logical-recipients', reliability: 'at-least-once', ttlMs: 30_000 }
    );
    return toALFrozenMulticastMessage({ ...message, id: { ...message.id, msgId } }, { recipientPeerIds, snapshotVersion: 4 });
}

function createChildAck(message: ALMessage): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: `ack-${CHILD_PEER_ID}-${message.id.msgId}`, senderId: CHILD_PEER_ID, ts: Date.now(), traceId: message.id.traceId },
        toTestALAckPayload({
            ackedMsgId: message.id.msgId,
            fromPeerId: CHILD_PEER_ID,
            toPeerId: INBOUND_TEST_SELF_PEER_ID,
            originPeerId: INBOUND_TEST_SENDER_PEER_ID,
            logicalRecipientPeerId: CHILD_PEER_ID,
            status: 'delivered',
            observedAtEpochMs: Date.now()
        })
    );
}

/** A recipient that delivers nothing and says why: not subscribed, or a refusal that drops the message. */
function withNackPlan(reason: ALInboundNackPlanReason): (plan: ALMessageHandlingPlan) => ALMessageHandlingPlan {
    return (plan) => ({
        ...plan,
        dropReason: reason === 'not-subscribed' ? plan.dropReason : `refused: ${reason}`,
        localDelivery: { ...plan.localDelivery, enabled: false, deferred: false },
        nack: { ...plan.nack, enabled: true, reason },
        repair: { ...plan.repair, enabled: reason === 'gap' }
    });
}

function readSentControls(fixture: InboundTestRuntime): readonly { msg: ALMessage; control: ALPeerControlMessage; }[] {
    return fixture.controlSends.flat().flatMap((msg) => {
        const control = decodeALPeerControlMessage(msg).right;
        return control === undefined ? [] : [{ msg, control }];
    });
}

/** Runs the runtime's work rounds until it sent a control `matches` accepts. */
async function readOwnControl(
    fixture: InboundTestRuntime,
    matches: (control: ALPeerControlMessage) => boolean
): Promise<ALMessage> {
    await expect.poll(async () => {
        await fixture.queueEngine.executeOnce();
        return readSentControls(fixture).some(({ control }) => matches(control));
    }).toBe(true);
    return readSentControls(fixture).find(({ control }) => matches(control))!.msg;
}

function isOwnAck(status: string): (control: ALPeerControlMessage) => boolean {
    return (control) =>
        control.type === 'ack' && control.payload.status === status &&
        control.payload.logicalRecipientPeerId === INBOUND_TEST_SELF_PEER_ID;
}

/** Admits the message and, for a relayed one, its child's delivered ACK, so the relay ends its own hop. */
async function admitAsRecipient(fixture: InboundTestRuntime, message: ALMessage, relayed: boolean): Promise<void> {
    await fixture.runtime.ready();
    expect((await fixture.runtime.admitIncomingMessage(message, RTC_SOURCE)).left).toBeUndefined();
    if (relayed) {
        await fixture.runtime.admitIncomingMessage(createChildAck(message), { kind: 'rtc-peer', peerId: CHILD_PEER_ID });
    }
}

describe('the receipt controls an RTC counted recipient sends', () => {
    it.each(['delivered', 'accepted', 'subtree-complete', 'subtree-complete-not-subscribed'] as const)(
        'a counted recipient\'s %s ACK carries a proof that verifies',
        async (status) => {
            const relayed = status === 'accepted' || status === 'subtree-complete';
            const fixture = createSigningRuntime({
                name: `ack-${status}`,
                relays: relayed,
                plan: status === 'subtree-complete-not-subscribed' ? withNackPlan('not-subscribed') : undefined
            });
            const message = relayed
                ? createFrozenRoomMulticast(`ack-${status}`, [INBOUND_TEST_SELF_PEER_ID, CHILD_PEER_ID])
                : createReceiverUnicast(`ack-${status}`);

            await admitAsRecipient(fixture, message, relayed);

            expect(await verifyTestALReceiptControl(CRYPTO, await readOwnControl(fixture, isOwnAck(status)))).toBe(true);
        }
    );

    it.each(['not-subscribed', 'before-entry', 'gap', 'resync-required', 'expired'] as const)(
        'a counted recipient\'s %s NACK carries a proof that verifies',
        async (reason) => {
            const fixture = createSigningRuntime({ name: `nack-${reason}`, plan: withNackPlan(reason) });

            await admitAsRecipient(fixture, createReceiverUnicast(`nack-${reason}`), false);

            const nack = await readOwnControl(fixture, (control) => control.type === 'nack' && control.payload.reason === reason);
            expect(await verifyTestALReceiptControl(CRYPTO, nack)).toBe(true);
        }
    );

    it('a hop ACK, a subtree ACK, a non-recipient relay\'s hop-end and a repair request carry null', async () => {
        const hop = createSigningRuntime({ name: 'null-hop' });
        await admitAsRecipient(hop, createReceiverUnicast('null-hop', 'hop'), false);
        const subtree = createSigningRuntime({ name: 'null-subtree' });
        await admitAsRecipient(subtree, createReceiverUnicast('null-subtree', 'subtree'), false);
        const outside = createSigningRuntime({ name: 'null-outside', relays: true });
        await admitAsRecipient(outside, createFrozenRoomMulticast('null-outside', [CHILD_PEER_ID]), true);
        const gap = createSigningRuntime({ name: 'null-repair', plan: withNackPlan('gap') });
        await admitAsRecipient(gap, createReceiverUnicast('null-repair'), false);

        const proofs = [
            decodeALPeerControlMessage(await readOwnControl(hop, isOwnAck('delivered'))).right?.payload,
            decodeALPeerControlMessage(await readOwnControl(subtree, isOwnAck('delivered'))).right?.payload,
            decodeALPeerControlMessage(await readOwnControl(outside, isOwnAck('subtree-complete'))).right?.payload
        ];
        const repair = decodeALPeerControlMessage(await readOwnControl(gap, (control) => control.type === 'repair')).right;
        expect(proofs).toEqual([
            expect.objectContaining({ proof: null }),
            expect.objectContaining({ proof: null }),
            expect.objectContaining({ proof: null })
        ]);
        expect(repair?.payload).not.toHaveProperty('proof');
    });

    it('a counted relay\'s control for its child carries null', async () => {
        const fixture = createSigningRuntime({ name: 'child-control', relays: true });

        await admitAsRecipient(fixture, createFrozenRoomMulticast('child-control', [INBOUND_TEST_SELF_PEER_ID, CHILD_PEER_ID]), true);

        const forwarded = await readOwnControl(fixture, (control) => control.type === 'ack' && control.payload.logicalRecipientPeerId === CHILD_PEER_ID);
        expect(decodeALPeerControlMessage(forwarded).right?.payload).toMatchObject({ status: 'forwarded', proof: null });
        expect(await verifyTestALReceiptControl(CRYPTO, await readOwnControl(fixture, isOwnAck('subtree-complete')))).toBe(true);
    });

    it('a buffered message\'s release signs the ACK it commits', async () => {
        const fixture = createSigningRuntime({ name: 'ordered-release' });
        await fixture.runtime.ready();

        await fixture.runtime.admitIncomingMessage(createOrderedReceiverUnicast('ordered-2', 2), RTC_SOURCE);
        await fixture.runtime.admitIncomingMessage(createOrderedReceiverUnicast('ordered-1', 1), RTC_SOURCE);

        const released = await readOwnControl(
            fixture,
            (control) => control.type === 'ack' && control.payload.ackedMsgId === 'ordered-2' && control.payload.status === 'delivered'
        );
        expect(await verifyTestALReceiptControl(CRYPTO, released)).toBe(true);
    });

    it('an ordered release the track can no longer order signs the resync-required NACK it commits', async () => {
        let dispatchable = false;
        const fixture = createSigningRuntime({ name: 'ordered-reject', canDispatchMessage: () => dispatchable });
        await admitAsRecipient(fixture, createOrderedReceiverUnicast('reject-1', 1), false);
        for (const key of await fixture.stores.workQueue.getAllKeys()) {
            await fixture.stores.workQueue.removeItem(key);
        }
        dispatchable = true;

        await fixture.runtime.admitIncomingMessage(createOrderedReceiverUnicast('reject-2', 2), RTC_SOURCE);

        const nack = await readOwnControl(
            fixture,
            (control) => control.type === 'nack' && control.payload.msgId === 'reject-2' && control.payload.reason === 'resync-required'
        );
        expect(await verifyTestALReceiptControl(CRYPTO, nack)).toBe(true);
    });

    it('every ws control carries null', async () => {
        const fixture = createSigningRuntime({ name: 'ws', carrier: 'ws', plan: withNackPlan('not-subscribed') });
        await fixture.runtime.ready();

        expect((await fixture.runtime.admitIncomingMessage(createReceiverUnicast('ws'), INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'admitted' });

        await readOwnControl(fixture, isOwnAck('subtree-complete-not-subscribed'));
        const controls = readSentControls(fixture).map(({ control }) => control);
        expect(controls.map((control) => control.type).toSorted()).toEqual(['ack', 'nack']);
        expect(controls.map((control) => control.payload)).toEqual([
            expect.objectContaining({ proof: null }),
            expect.objectContaining({ proof: null })
        ]);
    });

    it('a conflict replay signs the control it rebuilds, in one commit', async () => {
        const fixture = createSigningRuntime({ name: 'conflict-replay', relays: true });
        const message = createFrozenRoomMulticast('conflict-replay', [INBOUND_TEST_SELF_PEER_ID, CHILD_PEER_ID]);
        await admitAsRecipient(fixture, message, false);
        const commitBundle = fixture.stores.admissionStore.commitBundle.bind(fixture.stores.admissionStore);
        const commits: { readonly bundle: ALInboundCommitBundle; readonly status: string; }[] = [];
        let conflicted = false;
        vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockImplementation(async (bundle) => {
            const status = conflicted ? await commitBundle(bundle) : 'conflict';
            conflicted = true;
            commits.push({ bundle, status });
            return status;
        });

        await fixture.runtime.admitIncomingMessage(createChildAck(message), { kind: 'rtc-peer', peerId: CHILD_PEER_ID });
        const terminal = await readOwnControl(fixture, isOwnAck('subtree-complete'));

        const terminalCommits = commits.filter(({ bundle }) =>
            bundle.durableEffects.some((effect) =>
                effect.payload.kind === 'send-control' &&
                decodeALPeerControlMessage(effect.payload.msg).right?.type === 'ack' &&
                isOwnAck('subtree-complete')(decodeALPeerControlMessage(effect.payload.msg).right!)
            )
        );
        expect(terminalCommits.map(({ status }) => status)).toEqual(['conflict', 'committed']);
        const committed = terminalCommits[1]!.bundle.durableEffects.flatMap((effect) =>
            effect.payload.kind === 'send-control' && effect.payload.msg.id.msgId === terminal.id.msgId ? [effect.payload.msg] : []
        );
        expect(committed).toEqual([terminal]);
        expect(await verifyTestALReceiptControl(CRYPTO, terminal)).toBe(true);
    });
});
