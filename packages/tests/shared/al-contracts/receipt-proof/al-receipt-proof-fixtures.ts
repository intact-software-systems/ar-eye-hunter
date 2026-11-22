import type { ALAckPayload, ALNackPayload } from '@shared/al-contracts/al-control.ts';
import { AL_GAP_NACK_RELAY_HOP_LIMIT } from '@shared/al-contracts/al-message-resource-limits.ts';
import type { ALReceiptControl } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';

import { toTestALAckPayload, toTestALNackPayload } from '../../../al-control-test-payloads.ts';

export const ACK: Extract<ALReceiptControl, { type: 'ack'; }> = {
    type: 'ack',
    payload: toTestALAckPayload({
        ackedMsgId: 'm1',
        fromPeerId: 'r',
        toPeerId: 'a',
        originPeerId: 'a',
        logicalRecipientPeerId: 'c',
        status: 'delivered',
        observedAtEpochMs: 1_700_000_000_000
    })
};

export const NACK: Extract<ALReceiptControl, { type: 'nack'; }> = {
    type: 'nack',
    payload: toTestALNackPayload({
        msgId: 'm1',
        fromPeerId: 'r',
        toPeerId: 'a',
        originPeerId: 'a',
        logicalRecipientPeerId: 'c',
        reason: 'not-subscribed',
        observedAtEpochMs: 1_700_000_000_000
    })
};

export const GAP_NACK: Extract<ALReceiptControl, { type: 'nack'; }> = {
    type: 'nack',
    payload: {
        ...NACK.payload,
        reason: 'gap',
        orderingKey: 'room-1',
        expectedSeq: 3,
        missingRanges: [{ from: 3, to: 4 }],
        gapRequestNumber: 1,
        relayHopsLeft: AL_GAP_NACK_RELAY_HOP_LIMIT
    } as ALNackPayload
};

export const ACK_ALTERATIONS: readonly (readonly [string, Partial<ALAckPayload>])[] = [
    ['ackedMsgId', { ackedMsgId: 'm2' }],
    ['originPeerId', { originPeerId: 'b' }],
    ['logicalRecipientPeerId', { logicalRecipientPeerId: 'd' }],
    ['status', { status: 'failed' as ALAckPayload['status'] }],
    ['observedAtEpochMs', { observedAtEpochMs: 1_700_000_000_001 }]
];

export const NACK_ALTERATIONS: readonly (readonly [string, Partial<ALNackPayload>])[] = [
    ['msgId', { msgId: 'm2' }],
    ['originPeerId', { originPeerId: 'b' }],
    ['logicalRecipientPeerId', { logicalRecipientPeerId: 'd' }],
    ['reason', { reason: 'gap' }],
    ['observedAtEpochMs', { observedAtEpochMs: 1_700_000_000_001 }],
    ['orderingKey', { orderingKey: 'room-2' }],
    ['expectedSeq', { expectedSeq: 9 }],
    ['missingRanges', { missingRanges: [{ from: 1, to: 2 }] }],
    ['serverSnapshotVersion', { serverSnapshotVersion: 7 }]
];

export const RELAY_REWRITES: readonly (readonly [string, Partial<ALAckPayload>])[] = [
    ['fromPeerId', { fromPeerId: 'relay' }],
    ['toPeerId', { toPeerId: 'upstream' }],
    ['carrier', { carrier: 'ws' }]
];

export function withPayload(control: ALReceiptControl, change: Partial<ALAckPayload> | Partial<ALNackPayload>): ALReceiptControl {
    return control.type === 'ack'
        ? { type: 'ack', payload: { ...control.payload, ...change } as ALAckPayload }
        : { type: 'nack', payload: { ...control.payload, ...change } as ALNackPayload };
}
