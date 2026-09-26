// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { createTestALOutboundControlAdmission } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import {
    createDefaultIndexedDbALOutboundRuntimeStores,
    createDefaultInMemoryALOutboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundRuntimeStores,
    ALOutboundSettlementFact
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { computeOutboundTestAdmission } from '../outbound-runtime-test-fixture.ts';

type ReceiptTestStores = ALOutboundRuntimeStores<ALOutboundTransportMessage>;

const ORIGIN = 'origin';
const RELAY = 'relay';
const MSG_ID = 'message';
const ALREADY_COUNTED = 'confirms a peer the receipt already counted';

let indexedDbCount = 0;

const BACKENDS: readonly (readonly [string, () => ReceiptTestStores])[] = [
    ['memory', () =>
        createDefaultInMemoryALOutboundRuntimeStores({
            namespace: 'receipt-keys',
            decodePrepared: decodeALOutboundTransportMessage
        })],
    ['IndexedDB', () => {
        indexedDbCount += 1;
        return createDefaultIndexedDbALOutboundRuntimeStores({
            dbName: `rallar-alm-receipt-keys-${indexedDbCount}`,
            namespace: 'receipt-keys',
            decodePrepared: decodeALOutboundTransportMessage
        });
    }]
];

describe.each(BACKENDS)('outbound receipt keys over %s', (_name, createStores) => {
    it('admits two recipients\' ACKs through one relay, completes the receipt and refuses a repeat', async () => {
        const stores = createStores();
        const settlements: ALOutboundSettlementFact[] = [];
        await seedObligation(stores.admissionStore, { mode: 'receiver', expectedPeerIds: ['r1', 'r2'] });
        const control = createTestALOutboundControlAdmission({
            ...stores,
            nowMs: Date.now,
            carrier: 'ws',
            settlements: (fact) => settlements.push(fact)
        });

        expect(await control.admit(relayAck('r1', 'ack-r1'), 'peer')).toEqual({ kind: 'committed' });
        expect(await control.admit(relayAck('r2', 'ack-r2'), 'peer')).toEqual({ kind: 'committed' });

        expect(await stores.admissionStore.readReceiptState({ originPeerId: ORIGIN, msgId: MSG_ID }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['r1', 'r2'], ackedPeerIds: ['r1', 'r2'] });
        expect(settlements.at(-1)).toMatchObject({
            kind: 'acknowledgement',
            msgId: MSG_ID,
            mode: 'receiver',
            // The relay forwards ACKs it speaks for others: they confirm recipients, never the relay as a hop.
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: [],
            confirmedRecipientPeerIds: ['r1', 'r2'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });

        const repeat = await control.admit(relayAck('r1', 'ack-r1-repeat'), 'peer');
        expect(repeat.kind).toBe('rejected');
        expect(repeat.kind === 'rejected' && repeat.reason).toContain('already admitted');
    });

    it('refuses a receiver-mode ACK whose logical recipient is outside the audience, as a typed rejection', async () => {
        const stores = createStores();
        await seedObligation(stores.admissionStore, { mode: 'receiver', expectedPeerIds: ['r1', 'r2'] });
        const control = createTestALOutboundControlAdmission({ ...stores, nowMs: Date.now, carrier: 'ws' });

        // A hop ACK names the hop itself; under `receiver` it is never a logical confirmation.
        const hop = await control.admit(relayAck(RELAY, 'ack-hop'), 'peer');

        expect(hop).toEqual({
            kind: 'rejected',
            reason: expect.stringContaining('confirms no peer of the pending outbound receipt')
        });
        expect(await stores.admissionStore.readReceiptState({ originPeerId: ORIGIN, msgId: MSG_ID }))
            .toMatchObject({ ackedPeerIds: [] });
    });

    it('counts a hop once under `hop`, however many recipients its ACKs name', async () => {
        const stores = createStores();
        const settlements: ALOutboundSettlementFact[] = [];
        await seedObligation(stores.admissionStore, { mode: 'hop', expectedPeerIds: [RELAY] });
        const control = createTestALOutboundControlAdmission({
            ...stores,
            nowMs: Date.now,
            carrier: 'ws',
            settlements: (fact) => settlements.push(fact)
        });

        expect(await control.admit(relayAck('r1', 'ack-r1'), 'peer')).toEqual({ kind: 'committed' });
        // Not a duplicate (another recipient), but the hop is already counted: refused without a write.
        expect(await control.admit(relayAck('r2', 'ack-r2'), 'peer')).toEqual({
            kind: 'rejected',
            reason: expect.stringContaining(ALREADY_COUNTED)
        });

        expect(settlements).toEqual([
            expect.objectContaining({ mode: 'hop', confirmedHopPeerIds: [RELAY], complete: true })
        ]);
        expect(await stores.admissionStore.readReceiptState({ originPeerId: ORIGIN, msgId: MSG_ID }))
            .toMatchObject({ mode: 'hop', ackedPeerIds: [RELAY] });
    });

    it('refuses an ACK for an already-confirmed logical recipient under `receiver`, however it travelled', async () => {
        const stores = createStores();
        await seedObligation(stores.admissionStore, { mode: 'receiver', expectedPeerIds: ['r1', 'r2'] });
        const control = createTestALOutboundControlAdmission({ ...stores, nowMs: Date.now, carrier: 'ws' });

        expect(await control.admit(relayAck('r1', 'ack-r1'), 'peer')).toEqual({ kind: 'committed' });
        // Another relay's ACK for `r1` is not a duplicate by key, but `r1` is already counted.
        expect(await control.admit(relayAck('r1', 'ack-r1-other-relay', 'other-relay'), 'peer')).toEqual({
            kind: 'rejected',
            reason: expect.stringContaining(ALREADY_COUNTED)
        });
        expect(await control.admit(relayAck('r2', 'ack-r2'), 'peer')).toEqual({ kind: 'committed' });
    });

    it('keeps two origins\' pending rows for one msgId apart in one namespace', async () => {
        const stores = createStores();
        for (const [originPeerId, expectedPeerIds] of [['origin-a', ['a1']], ['origin-b', ['b1', 'b2']]] as const) {
            expect(
                await stores.admissionStore.commitBundle({
                    senderId: originPeerId,
                    mutations: [{
                        kind: 'set-pending-ack',
                        originPeerId,
                        snapshot: toPendingSnapshot({ mode: 'receiver', expectedPeerIds }),
                        expireAtTimestamp: Date.now() + 30_000
                    }],
                    durableEffects: []
                })
            ).toBe('committed');
        }

        expect(await stores.admissionStore.readReceiptState({ originPeerId: 'origin-a', msgId: MSG_ID }))
            .toMatchObject({ expectedPeerIds: ['a1'] });
        expect(await stores.admissionStore.readReceiptState({ originPeerId: 'origin-b', msgId: MSG_ID }))
            .toMatchObject({ expectedPeerIds: ['b1', 'b2'] });
    });
});

interface ReceiptTestObligation {
    readonly mode: ALOutboundPendingAckSnapshot['mode'];
    readonly expectedPeerIds: readonly string[];
}

async function seedObligation(
    admissionStore: ALOutboundAdmissionStore<ALOutboundTransportMessage>,
    obligation: ReceiptTestObligation
): Promise<void> {
    await admissionStore.ready();
    const msg: ALMessage = {
        id: { v: 2, msgId: MSG_ID, senderId: ORIGIN, ts: 1 },
        route: { topicId: 'command', resourceId: 'resource', contextId: 'context' },
        payload: { typeId: 'command.v1', resource: '{}' },
        targets: { mode: 'multicast', groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' } },
        constraints: { expiresAtMs: Date.now() + 30_000 }
    };
    const admission = await computeOutboundTestAdmission(admissionStore, msg);
    expect(
        await admissionStore.commitBundle({
            ...admission,
            mutations: [
                ...admission.mutations,
                {
                    kind: 'set-pending-ack',
                    originPeerId: ORIGIN,
                    snapshot: toPendingSnapshot(obligation),
                    expireAtTimestamp: Date.now() + 30_000
                }
            ],
            durableEffects: []
        })
    ).toBe('committed');
}

function toPendingSnapshot(obligation: ReceiptTestObligation): ALOutboundPendingAckSnapshot {
    return {
        msgId: MSG_ID,
        mode: obligation.mode,
        expectedPeerIds: obligation.expectedPeerIds,
        ackedPeerIds: [],
        timeoutMs: 2_000,
        maxAttempts: 3,
        attempts: 0,
        deadlineAtMs: Date.now() + 2_000
    };
}

/** The relay re-originates one ACK per logical recipient it confirmed, each from itself. */
function relayAck(logicalRecipientPeerId: string, controlMsgId: string, relayPeerId: string = RELAY): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: controlMsgId, senderId: relayPeerId, ts: Date.now() },
        {
            ackedMsgId: MSG_ID,
            fromPeerId: relayPeerId,
            toPeerId: ORIGIN,
            originPeerId: ORIGIN,
            logicalRecipientPeerId,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}
