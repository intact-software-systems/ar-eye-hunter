import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, newALNackControlMessage, newALRepairControlMessage } from '@shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { decodeALAdmissionControlValue } from '@shared/alm/al-admission-value-validation.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore, type ALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { decodeALOutboundPreparedMessage } from '@shared/alm/outbound/al-outbound-effect-validation.ts';
import { describe, expect, it, vi } from 'vitest';

interface OutboundObligationInput {
    readonly targets: NonNullable<ALMessage['targets']>;
    readonly expectedPeerIds: readonly string[];
    readonly ackedPeerIds: readonly string[];
    readonly ordering: ALMessage['ordering'];
}

describe('outbound control admission identity', () => {
    it.each(['ack', 'nack', 'repair'] as const)('does not create state or repair effects for an unknown %s', async (type) => {
        const { store, state } = createFixture();
        const control = controlMessage(type);

        expect(await store.acceptControlMessage(control, decodeALOutboundPreparedMessage)).toEqual({ handled: false });
        expect(state.data.size).toBe(0);
        expect(await store.claimReadyEffects({ maxCount: 10 }, decodeALOutboundPreparedMessage)).toEqual([]);
    });

    it('ignores an ACK from an unexpected peer and accepts the expected receiver without changing the input', async () => {
        const { store, state } = createFixture();
        await seedDirectObligation(store);
        const baseline = [...state.data];
        expect(await store.acceptControlMessage(controlMessage('ack', 'intruder'), decodeALOutboundPreparedMessage)).toEqual({ handled: false });
        expect([...state.data]).toEqual(baseline);
        const ack = controlMessage('ack');
        const candidate = JSON.stringify(ack);

        expect(await store.acceptControlMessage(ack, decodeALOutboundPreparedMessage)).toEqual({ handled: true });
        expect(await store.getPendingAck('message')).toBeUndefined();
        expect(JSON.stringify(ack)).toBe(candidate);
        const acceptedState = [...state.data];
        expect(await store.acceptControlMessage(ack, decodeALOutboundPreparedMessage)).toEqual({ handled: false });
        expect([...state.data]).toEqual(acceptedState);
    });

    it.each(['nack', 'repair'] as const)('does not let an unrelated peer create %s work for a tracked message', async (type) => {
        const { store, state } = createFixture();
        await seedDirectObligation(store);
        const baseline = [...state.data];

        expect(await store.acceptControlMessage(controlMessage(type, 'intruder'), decodeALOutboundPreparedMessage)).toEqual({ handled: false });
        expect([...state.data]).toEqual(baseline);
        expect(await store.claimReadyEffects({ maxCount: 10 }, decodeALOutboundPreparedMessage)).toEqual([]);
    });

    it('rejects a control addressed to another local message owner', async () => {
        const { store, state } = createFixture();
        await seedDirectObligation(store);
        const baseline = [...state.data];
        const ack = newALAckControlMessage(
            { v: 2, msgId: 'control', senderId: 'receiver', ts: 1 },
            { fromPeerId: 'receiver', toPeerId: 'other-sender', ackedMsgId: 'message', status: 'delivered', observedAtEpochMs: 1 }
        );

        expect(await store.acceptControlMessage(ack, decodeALOutboundPreparedMessage)).toEqual({ handled: false });
        expect([...state.data]).toEqual(baseline);
    });

    it('admits one stable repair hint and rejects a semantic duplicate', async () => {
        const { store, state } = createFixture();
        await seedDirectObligation(store);
        const first = repairControl(1);

        expect(await store.acceptControlMessage(first, decodeALOutboundPreparedMessage)).toEqual({ handled: true });
        const acceptedState = [...state.data];
        expect(await store.acceptControlMessage(repairControl(2), decodeALOutboundPreparedMessage)).toEqual({
            handled: false
        });
        expect([...state.data]).toEqual(acceptedState);
        const effects = await store.claimReadyEffects({ maxCount: 10 }, decodeALOutboundPreparedMessage);
        expect(effects.map((effect) => effect.payload)).toEqual([{
            kind: 'repair-hint',
            msgId: 'message',
            request: {
                trigger: 'repair',
                requestedByPeerId: 'receiver',
                missingSeqs: [],
                failedPeerIds: []
            }
        }]);
    });

    it('keeps control history within the persisted collection limit', async () => {
        const { store, state } = createFixture();
        await seedDirectObligation(store);

        for (let serverSnapshotVersion = 0; serverSnapshotVersion <= 256; serverSnapshotVersion++) {
            const nack = newALNackControlMessage(
                { v: 2, msgId: `control-${serverSnapshotVersion}`, senderId: 'receiver', ts: serverSnapshotVersion },
                {
                    fromPeerId: 'receiver',
                    toPeerId: 'sender',
                    msgId: 'message',
                    reason: 'stale',
                    observedAtEpochMs: serverSnapshotVersion,
                    serverSnapshotVersion
                }
            );
            expect(await store.acceptControlMessage(nack, decodeALOutboundPreparedMessage)).toEqual({ handled: true });
        }

        const stored = state.data.get('outbound-control:control:nacks:message');
        const history = decodeALAdmissionControlValue(stored?.value, 'message', 'nacks');
        expect(history.values).toHaveLength(256);
        expect(history.values[0].serverSnapshotVersion).toBe(1);
        expect(history.values.at(-1)?.serverSnapshotVersion).toBe(256);
    });

    it('uses a frozen multicast pending audience to admit repair controls', async () => {
        const { store, state } = createFixture();
        await seedMulticastObligation(store);

        expect(await store.acceptControlMessage(controlMessage('repair'), decodeALOutboundPreparedMessage)).toEqual({
            handled: true
        });
        const acceptedState = [...state.data];
        expect(await store.acceptControlMessage(controlMessage('repair', 'intruder'), decodeALOutboundPreparedMessage)).toEqual({
            handled: false
        });
        expect([...state.data]).toEqual(acceptedState);
    });

    it('rejects repair hints outside the retained message ordering track before writes', async () => {
        const { store, state } = createFixture();
        await seedOrderedObligation(store);
        const baseline = [...state.data];

        expect(
            await store.acceptControlMessage(
                orderedRepairControl('other-track', [2]),
                decodeALOutboundPreparedMessage
            )
        ).toEqual({ handled: false });
        expect([...state.data]).toEqual(baseline);
        expect(
            await store.acceptControlMessage(
                orderedRepairControl('stream:sender:7', [11]),
                decodeALOutboundPreparedMessage
            )
        ).toEqual({ handled: false });
        expect([...state.data]).toEqual(baseline);
        expect(
            await store.acceptControlMessage(
                orderedRepairControl('stream:sender:7', [2, 3]),
                decodeALOutboundPreparedMessage
            )
        ).toEqual({ handled: true });
    });

    it('completes a frozen 256-peer audience after diagnostic ACK history is already full', async () => {
        const { store, state } = createFixture();
        const expectedPeerIds = Array.from({ length: 256 }, (_, index) => `peer-${index}`);
        await seedObligation(store, {
            targets: { mode: 'multicast', groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' } },
            expectedPeerIds,
            ackedPeerIds: expectedPeerIds.slice(0, -1),
            ordering: undefined
        });
        const values = [
            ...expectedPeerIds.slice(0, -1).map((fromPeerId, observedAtEpochMs) => ({
                ackedMsgId: 'message',
                fromPeerId,
                toPeerId: 'sender',
                status: 'delivered' as const,
                observedAtEpochMs
            })),
            {
                ackedMsgId: 'message',
                fromPeerId: 'peer-0',
                toPeerId: 'sender',
                status: 'accepted' as const,
                observedAtEpochMs: 256
            }
        ];
        const key = 'outbound-control:control:acks:message';
        state.data.set(key, {
            key,
            value: { kind: 'acks', values },
            expireAtTimestamp: Date.now() + 60_000
        });

        expect(await store.acceptControlMessage(controlMessage('ack', 'peer-255'), decodeALOutboundPreparedMessage))
            .toEqual({ handled: true });
        expect(await store.getPendingAck('message')).toBeUndefined();
        expect(decodeALAdmissionControlValue(state.data.get(key)?.value, 'message', 'acks').values).toHaveLength(256);
    });

    it('reports a typed conflict when message ownership changes after the control read', async () => {
        const { backend, store, state } = createFixture();
        await seedDirectObligation(store);
        const write = backend.write.bind(backend);
        vi.spyOn(backend, 'write').mockImplementationOnce(async (operation) => {
            await write(async (transaction) => {
                await transaction.set('outbound-control:msg-owner:message', 'other-sender');
            });
            return await write(operation);
        });

        await expect(store.acceptControlMessage(controlMessage('ack'), decodeALOutboundPreparedMessage))
            .rejects.toBeInstanceOf(ALAdmissionBackendConflictError);
        expect(state.data.has('outbound-control:control:acks:message')).toBe(false);
        expect(await store.claimReadyEffects({ maxCount: 10 }, decodeALOutboundPreparedMessage)).toEqual([]);
    });
});

function createFixture() {
    const state = createInMemoryALAdmissionState();
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    const store = createALOutboundAdmissionStore({
        namespace: 'outbound-control',
        backend,
        supersedenceTrackTtlMs: 300000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { backend, store, state };
}

async function seedDirectObligation(store: ALOutboundAdmissionStore): Promise<void> {
    await seedObligation(store, {
        targets: { mode: 'unicast', toPeerId: 'receiver' },
        expectedPeerIds: ['receiver'],
        ackedPeerIds: [],
        ordering: undefined
    });
}

async function seedMulticastObligation(store: ALOutboundAdmissionStore): Promise<void> {
    await seedObligation(store, {
        targets: { mode: 'multicast', groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' } },
        expectedPeerIds: ['receiver', 'other-receiver'],
        ackedPeerIds: [],
        ordering: undefined
    });
}

async function seedOrderedObligation(store: ALOutboundAdmissionStore): Promise<void> {
    await seedObligation(store, {
        targets: { mode: 'unicast', toPeerId: 'receiver' },
        expectedPeerIds: ['receiver'],
        ackedPeerIds: [],
        ordering: { orderingKey: 'stream', epoch: 7, seq: 10 }
    });
}

async function seedObligation(
    store: ALOutboundAdmissionStore,
    input: OutboundObligationInput
): Promise<void> {
    const msg: ALMessage = {
        id: { v: 2, msgId: 'message', senderId: 'sender', ts: 1 },
        route: { topicId: 'command', resourceId: 'resource', contextId: 'context' },
        payload: { typeId: 'command.v1', resource: '{}' },
        targets: input.targets,
        ordering: input.ordering
    };
    await store.commitBundle({
        senderId: 'sender',
        mutations: [
            { kind: 'set-msg-owner', msgId: 'message', senderId: 'sender' },
            { kind: 'set-sent-message', snapshot: { msgId: 'message', msg } },
            {
                kind: 'set-pending-ack',
                snapshot: {
                    msgId: 'message',
                    expectedPeerIds: input.expectedPeerIds,
                    ackedPeerIds: input.ackedPeerIds,
                    timeoutMs: 2000,
                    maxAttempts: 3,
                    attempts: 0,
                    deadlineAtMs: Date.now() + 2000
                }
            }
        ],
        durableEffects: []
    }, decodeALOutboundPreparedMessage);
}

function repairControl(observedAtEpochMs: number): ALMessage {
    return newALRepairControlMessage(
        { v: 2, msgId: `control-${observedAtEpochMs}`, senderId: 'receiver', ts: observedAtEpochMs },
        {
            fromPeerId: 'receiver',
            toPeerId: 'sender',
            msgId: 'message',
            reason: 'retransmit',
            observedAtEpochMs
        }
    );
}

function orderedRepairControl(orderingKey: string, missingSeqs: readonly number[]): ALMessage {
    return newALRepairControlMessage(
        { v: 2, msgId: `control-${orderingKey}-${missingSeqs.join('-')}`, senderId: 'receiver', ts: 1 },
        {
            fromPeerId: 'receiver',
            toPeerId: 'sender',
            msgId: 'message',
            reason: 'missing-seq',
            observedAtEpochMs: 1,
            orderingKey,
            expectedSeq: 2,
            missingSeqs
        }
    );
}

function controlMessage(type: 'ack' | 'nack' | 'repair', peerId: string = 'receiver'): ALMessage {
    const id: ALMessage['id'] = { v: 2, msgId: 'control', senderId: peerId, ts: 1 };
    const common = { fromPeerId: peerId, toPeerId: 'sender', observedAtEpochMs: 1 };
    switch (type) {
        case 'ack':
            return newALAckControlMessage(id, { ...common, ackedMsgId: 'message', status: 'delivered' });
        case 'nack':
            return newALNackControlMessage(id, { ...common, msgId: 'message', reason: 'gap' });
        case 'repair':
            return newALRepairControlMessage(id, { ...common, msgId: 'message', reason: 'retransmit' });
    }
}
