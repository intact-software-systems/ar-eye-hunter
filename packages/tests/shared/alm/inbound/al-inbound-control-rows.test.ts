import '../../../setup-browser-indexeddb.ts';

import { describe, expect, it } from 'vitest';

import { createTestALInboundControlAdmission } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, parseALControlMessage, type ALAckPayload } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { computeALInboundAdmission } from '@shared/alm/inbound/admission/compute-al-inbound-admission.ts';
import type { ALInboundControlOwnerIndex, ALInboundPlanner } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime, ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import {
    applyALInboundControlMutation,
    readControlDecisionSurface
} from '@shared/alm/inbound/control/al-inbound-control-rows.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestBackendStores,
    INBOUND_TEST_EFFECT_PREPARATION,
    type InboundTestStorage
} from '../inbound-runtime-test-fixture.ts';
import { readInboundTestAcknowledgements } from '../read-inbound-test-acknowledgements.ts';

const ORIGINAL_SENDER_ID = 's1';
const RTC_ARRIVAL: ALInboundMessageRuntime.Source = { kind: 'rtc-peer', peerId: ORIGINAL_SENDER_ID };
/** Two downstream peers, so one acknowledgement leaves the pending receipt standing. */
const DOWNSTREAM_PEER_IDS = ['s2', 's3'];

function createRelayedMessage(): ALMessage {
    return newALMulticastMessage(
        ORIGINAL_SENDER_ID,
        { topicId: 'chat', resourceId: 'relayed', contextId: 'room' },
        { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        'chat.message.v1',
        { text: 'relayed' },
        { reliability: 'at-least-once', ack: 'all-logical-recipients', ttlMs: 60_000 }
    );
}

/** The relay's own admission over RTC: it forwards to both downstream peers and owes its sender one subtree ACK. */
async function admitOverRtc(stores: ALInboundRuntimeStores, msg: ALMessage): Promise<void> {
    const { admissionStore } = stores;
    const nowMs = Date.now();
    const planner: ALInboundPlanner = (planned, source, observations) =>
        planALMessageHandling(planned, {
            ...observations,
            selfPeerId: INBOUND_TEST_EFFECT_PREPARATION.selfPeerId,
            fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
            connectedPeerIds: [ORIGINAL_SENDER_ID, ...DOWNSTREAM_PEER_IDS],
            groupMemberPeerIds: [INBOUND_TEST_EFFECT_PREPARATION.selfPeerId, ORIGINAL_SENDER_ID, ...DOWNSTREAM_PEER_IDS],
            overlayNeighborPeerIds: DOWNSTREAM_PEER_IDS
        });
    const read = await admissionStore.readIncomingMessage({
        msg,
        source: RTC_ARRIVAL,
        nowMs,
        prePlan: planner(msg, RTC_ARRIVAL, { nowMs })
    });
    const bundle = computeALInboundAdmission({
        read,
        plan: planner(msg, RTC_ARRIVAL, computeALInboundPlanningObservations(read)),
        facts: readALInboundEffectFacts(nowMs, INBOUND_TEST_EFFECT_PREPARATION),
        canForward: true,
        recordedParentPresent: true
    });
    expect(await admissionStore.commitBundle(bundle)).toBe('committed');
}

function createDownstreamAcknowledgement(msg: ALMessage, fromPeerId: string): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${fromPeerId}`, senderId: fromPeerId, ts: Date.now() },
        {
            ackedMsgId: msg.id.msgId,
            originPeerId: msg.id.senderId,
            logicalRecipientPeerId: fromPeerId,
            fromPeerId,
            toPeerId: INBOUND_TEST_EFFECT_PREPARATION.selfPeerId,
            status: 'delivered',
            observedAtEpochMs: Date.now(),
            carrier: 'ws'
        }
    );
}

interface UnresolvedControlOwnerCase {
    readonly named: string;
    readonly controlOwners: ALInboundControlOwnerIndex;
}

/** Two stored owner indexes that resolve the acknowledging peer to no single original sender. */
const UNRESOLVED_CONTROL_OWNERS: readonly UnresolvedControlOwnerCase[] = [
    // An overflowed index retains no entries at all, so its ambiguity is all there is left to read.
    { named: 'an overflowed correlation set', controlOwners: { ambiguous: true, values: [] } },
    {
        named: 'a peer tracked against several senders',
        controlOwners: { ambiguous: false, values: [{ peerId: 's2', senderId: null }] }
    }
];

function toAckPayload(ack: ALMessage): ALAckPayload {
    const parsed = parseALControlMessage(ack);
    if (parsed?.type !== 'ack') {
        throw new Error('Expected an acknowledgement');
    }
    return parsed.payload;
}

async function writeControlOwners(
    backend: ALAdmissionWorkBackend,
    namespace: string,
    input: Readonly<{ msgId: string; value: ALInboundControlOwnerIndex; }>
): Promise<void> {
    await backend.write(async (transaction) => {
        await applyALInboundControlMutation(transaction, namespace, {
            kind: 'set-control-owners',
            msgId: input.msgId,
            value: input.value,
            expireAtTimestamp: Date.now() + 60_000
        });
    }, null);
}

describe.each<InboundTestStorage>(['memory', 'indexeddb'])('inbound control rows over %s storage', (storage) => {
    function createFixture() {
        const { backend, stores } = createInboundTestBackendStores({
            namespace: 'inbound-control-rows',
            storage,
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const msg = createRelayedMessage();
        const namespace = stores.admissionStore.namespace;
        return {
            backend,
            stores,
            msg,
            namespace,
            control: createTestALInboundControlAdmission({
                ...stores,
                carrier: 'ws',
                nowMs: Date.now,
                newControlId: () => 'relay-control'
            }),
            readRows: () => readInboundTestAcknowledgements({ backend, namespace, msgId: msg.id.msgId, senderId: ORIGINAL_SENDER_ID })
        };
    }

    it('records each acknowledgement under the carrier it arrived on and the receipt under its message\'s', async () => {
        const { stores, msg, control, readRows } = createFixture();

        await admitOverRtc(stores, msg);
        expect((await readRows()).pendingAck?.carrier).toBe('rtc');

        const admitted = await control.admit(createDownstreamAcknowledgement(msg, 's2'), { kind: 'trusted-server' });

        expect(admitted.kind).toBe('committed');
        const rows = await readRows();
        expect(rows.acks.map((ack) => [ack.fromPeerId, ack.carrier])).toEqual([['s2', 'ws']]);
        expect(rows.pendingAck).toMatchObject({ carrier: 'rtc', ackedFromPeerIds: ['s2'] });
    });

    it('reads no decision surface and writes nothing for a peer that does not owe the acknowledgement', async () => {
        const { backend, stores, msg, namespace, control, readRows } = createFixture();
        await admitOverRtc(stores, msg);
        const ack = createDownstreamAcknowledgement(msg, 'intruder');

        expect(await readControlDecisionSurface(backend, namespace, toAckPayload(ack))).toBeUndefined();
        expect(await control.admit(ack, { kind: 'trusted-server' })).toEqual({ kind: 'not-handled' });
        const rows = await readRows();
        expect(rows.acks).toEqual([]);
        expect(rows.pendingAck?.expectedFromPeerIds).toEqual(DOWNSTREAM_PEER_IDS);
    });

    it.each(UNRESOLVED_CONTROL_OWNERS)(
        'reads no decision surface and writes nothing when the owner index names $named',
        async ({ controlOwners }) => {
            const { backend, stores, msg, namespace, control, readRows } = createFixture();
            await admitOverRtc(stores, msg);
            await writeControlOwners(backend, namespace, { msgId: msg.id.msgId, value: controlOwners });
            const ack = createDownstreamAcknowledgement(msg, 's2');

            expect(await readControlDecisionSurface(backend, namespace, toAckPayload(ack))).toBeUndefined();
            expect(await control.admit(ack, { kind: 'trusted-server' })).toEqual({ kind: 'not-handled' });
            const rows = await readRows();
            expect(rows.acks).toEqual([]);
            expect(rows.pendingAck?.expectedFromPeerIds).toEqual(DOWNSTREAM_PEER_IDS);
        }
    );
});
