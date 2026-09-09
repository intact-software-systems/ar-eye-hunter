import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    createALInboundAdmissionStore,
    type ALInboundAdmissionStore
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import {
    AL_INBOUND_WORK_LEASE_MS,
    decodeALInboundWorkEntry,
    toALInboundWorkType
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { ALInboundControlAdmission } from '@shared/alm/inbound/control/al-inbound-control-admission.ts';
import { createALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

const message: ALMessage = {
    id: { v: 2, msgId: 'message', senderId: 'sender', ts: 1_800_000_000_000 },
    route: { topicId: 'chat', resourceId: 'resource', contextId: 'room' },
    ordering: { orderingKey: 'chat', seq: 2 },
    payload: { typeId: 'chat', resource: '{"text":"hello"}' }
};

function createFixture() {
    const state = createInMemoryALAdmissionState();
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    const admissionStore = createALInboundAdmissionStore({
        namespace: 'inbound',
        backend,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const control = new ALInboundControlAdmission({
        admissionStore,
        port: createALWorkQueuePort({
            queue: admissionStore.workQueue,
            workTypes: new Set([toALInboundWorkType(admissionStore.namespace)]),
            leaseMs: AL_INBOUND_WORK_LEASE_MS,
            nowMs: Date.now,
            random: () => 0.5
        }),
        clock: { nowMs: Date.now },
        newControlId: () => 'generated-control',
        retention: admissionStore.retention
    });
    return { backend, admissionStore, control };
}

async function seedPendingAcknowledgement(admissionStore: ALInboundAdmissionStore): Promise<void> {
    const expireAtTimestamp = Date.now() + 60_000;
    const source = { kind: 'ws-client' as const, peerId: message.id.senderId };
    const nowMs = Date.now();
    const read = await admissionStore.readIncomingMessage({
        msg: message,
        source,
        nowMs,
        prePlan: planALMessageHandling(message, { selfPeerId: 'self', nowMs })
    });
    expect(
        await admissionStore.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: read.observations,
            mutations: [{
                kind: 'set-msg-owner',
                value: {
                    msgId: message.id.msgId,
                    senderId: message.id.senderId,
                    source,
                    supersedenceKey: null
                },
                expireAtTimestamp
            }, {
                kind: 'set-control-pending',
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                value: {
                    kind: 'pending',
                    value: {
                        toPeerId: 'upstream',
                        status: 'subtree-complete',
                        localReady: true,
                        expectedFromPeerIds: ['receiver'],
                        ackedFromPeerIds: [],
                        expireAtTimestamp
                    }
                },
                expireAtTimestamp
            }, {
                kind: 'set-control-owners',
                msgId: message.id.msgId,
                value: { ambiguous: false, values: [{ peerId: 'receiver', senderId: message.id.senderId }] },
                expireAtTimestamp
            }],
            durableEffects: []
        })
    ).toBe('committed');
}

function createAcknowledgement(fromPeerId: string): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${fromPeerId}`, ts: 1, senderId: fromPeerId },
        {
            ackedMsgId: message.id.msgId,
            fromPeerId,
            toPeerId: 'self',
            status: 'accepted',
            observedAtEpochMs: 1
        }
    );
}

async function readRetainedWork(admissionStore: ALInboundAdmissionStore) {
    const page = await admissionStore.workQueue.readWorkPage({
        typeId: toALInboundWorkType(admissionStore.namespace),
        status: EntityStatus.NEW,
        maxToRead: 10,
        cursor: null
    });
    return page.entries.map((entry) => decodeALInboundWorkEntry(entry, admissionStore.namespace));
}

describe('inbound control admission', () => {
    it('commits an acknowledgement from the peer that owes it', async () => {
        const { admissionStore, control } = createFixture();
        await seedPendingAcknowledgement(admissionStore);

        const result = await control.admit(createAcknowledgement('receiver'));

        expect(result.kind).toBe('committed');
        expect(result.kind === 'committed' && result.acceptance.handled).toBe(true);
        const state = await admissionStore.readAcknowledgementState(message.id.msgId, message.id.senderId);
        expect(state.acks.map((ack) => ack.fromPeerId)).toEqual(['receiver']);
        expect(state.pendingAck).toBeUndefined();
    });

    it('writes nothing for an acknowledgement from a peer that does not own the message', async () => {
        const { admissionStore, control } = createFixture();
        await seedPendingAcknowledgement(admissionStore);

        const result = await control.admit(createAcknowledgement('intruder'));

        expect(result).toEqual({ kind: 'not-handled' });
        const state = await admissionStore.readAcknowledgementState(message.id.msgId, message.id.senderId);
        expect(state.acks).toEqual([]);
        expect(state.pendingAck?.expectedFromPeerIds).toEqual(['receiver']);
        expect(await readRetainedWork(admissionStore)).toEqual([]);
    });

    it('retains admit-control work for a conflicting commit and replays it to completion', async () => {
        const { backend, admissionStore, control } = createFixture();
        await seedPendingAcknowledgement(admissionStore);
        vi.spyOn(backend, 'write').mockImplementationOnce(() => {
            throw new ALAdmissionBackendConflictError('simulated inbound control conflict');
        });

        const conflicted = await control.admit(createAcknowledgement('receiver'));

        expect(conflicted).toEqual({ kind: 'pending-control' });
        expect((await admissionStore.readAcknowledgementState(message.id.msgId, message.id.senderId)).acks)
            .toEqual([]);
        const retained = await readRetainedWork(admissionStore);
        expect(retained).toHaveLength(1);
        expect(retained[0]!.payload.kind).toBe('admit-control');

        const payload = retained[0]!.payload;
        expect(payload.kind === 'admit-control' && await control.replay(payload)).toEqual({ status: 'completed' });
        const state = await admissionStore.readAcknowledgementState(message.id.msgId, message.id.senderId);
        expect(state.acks.map((ack) => ack.fromPeerId)).toEqual(['receiver']);
        expect(state.pendingAck).toBeUndefined();
    });
});
