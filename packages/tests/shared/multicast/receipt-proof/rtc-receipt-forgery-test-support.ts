import { expect } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    type ALAckPayload,
    type ALNackPayload
} from '@shared/al-contracts/al-control.ts';
import type { ALReceiptControl } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';

import { toTestALAckPayload, toTestALNackPayload } from '../../../al-control-test-payloads.ts';
import {
    createOriginReceiverMulticast,
    enqueueAndDrain,
    toOriginFrozenTargets,
    type RtcOriginOverlayFixture
} from '../rtc-origin-overlay-fixture.ts';
import { toControlTuples } from '../rtc-relay-chain-test-support.ts';
import type { RtcRelayOverlayFixture } from '../rtc-relay-overlay-fixture.ts';

/** A receipted send frozen to `recipientPeerIds`, which the receipt counts. */
export async function sendFrozenReceipted(
    origin: RtcOriginOverlayFixture,
    resourceId: string,
    recipientPeerIds: readonly string[]
): Promise<ALMessage> {
    const message = { ...createOriginReceiverMulticast(resourceId), targets: toOriginFrozenTargets(recipientPeerIds, 3) };
    expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');
    expect(await readReceipt(origin, message)).toMatchObject({ expectedPeerIds: recipientPeerIds });
    return message;
}

export async function readReceipt(origin: RtcOriginOverlayFixture, message: ALMessage) {
    return await origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId });
}

export interface ForgedAckInput {
    readonly msgId: string;
    readonly fromPeerId: string;
    readonly logicalRecipientPeerId: string;
    readonly status?: ALAckPayload['status'];
    readonly originPeerId?: string;
}

export interface ForgedNackInput {
    readonly msgId: string;
    readonly fromPeerId: string;
    readonly logicalRecipientPeerId: string;
    readonly reason: ALNackPayload['reason'];
}

/** A child's ACK to the relay `r`; absent, its status is `delivered`. */
export function toChildAckControl(input: Omit<ForgedAckInput, 'originPeerId'>): ALReceiptControl {
    return {
        type: 'ack',
        payload: toTestALAckPayload({
            ackedMsgId: input.msgId,
            fromPeerId: input.fromPeerId,
            toPeerId: 'r',
            originPeerId: 'a',
            logicalRecipientPeerId: input.logicalRecipientPeerId,
            status: input.status ?? 'delivered',
            observedAtEpochMs: Date.now()
        })
    };
}

/** Hands every control a relay sent its parent to the origin, in order. */
export async function acceptEach(origin: RtcOriginOverlayFixture, controls: readonly ALMessage[]): Promise<void> {
    for (const control of controls) {
        await origin.manager.acceptControlMessage(control);
    }
}

/** Each control the relay sent `toPeerId` that speaks for `recipientPeerId`, as its type, recipient and status or reason. */
export async function readUpwardTuplesFor(
    relay: RtcRelayOverlayFixture,
    toPeerId: string,
    recipientPeerId: string
): Promise<readonly (readonly string[])[]> {
    return toControlTuples(await relay.readSentControls(toPeerId)).filter(([, recipient]) => recipient === recipientPeerId);
}

/** A child's `not-subscribed` NACK to the relay `r`. */
export function toChildNackControl(input: Omit<ForgedNackInput, 'reason'>): ALReceiptControl {
    return {
        type: 'nack',
        payload: toTestALNackPayload({
            msgId: input.msgId,
            fromPeerId: input.fromPeerId,
            toPeerId: 'r',
            originPeerId: 'a',
            logicalRecipientPeerId: input.logicalRecipientPeerId,
            reason: 'not-subscribed',
            observedAtEpochMs: Date.now()
        })
    };
}

export function toControlMessage(control: ALReceiptControl, variant: string): ALMessage {
    const id = {
        v: 4,
        msgId: `forged-${control.type}-${variant}-${control.payload.fromPeerId}`,
        senderId: control.payload.fromPeerId,
        ts: Date.now(),
        traceId: 'trace-forgery'
    } as const;
    return control.type === 'ack' ? newALAckControlMessage(id, control.payload) : newALNackControlMessage(id, control.payload);
}

/** Each rejected control admission's proof refusal, in order, as the diagnostic states it. */
export function readProofRefusals(origin: RtcOriginOverlayFixture): readonly Readonly<Record<string, string | undefined>>[] {
    return origin.diagnostics.flatMap((event) =>
        event.kind === 'control-admission' && event.outcome === 'rejected'
            ? [{
                proofRefusal: event.proofRefusal,
                claimedRecipientPeerId: event.claimedRecipientPeerId,
                channelPeerId: event.channelPeerId
            }]
            : []
    );
}
