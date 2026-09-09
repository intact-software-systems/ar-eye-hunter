import { createTestALOutboundControlAdmission } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    newALRepairControlMessage
} from '@shared/al-contracts/al-control.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionDecoder } from '@shared/alm/al-admission-decoder.ts';
import { decodeALAdmissionControlValue } from '@shared/alm/al-admission-value-validation.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundAdmissionStore,
    type ALOutboundDurableEffect
} from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { decodeALOutboundTransportMessage, type ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    decodeALOutboundWorkEntry,
    toALOutboundWorkType
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { toStrictAppInboxQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { computeOutboundTestAdmission } from './outbound-runtime-test-fixture.ts';

interface OutboundObligationInput {
    readonly targets: NonNullable<ALMessage['targets']>;
    readonly expectedPeerIds: readonly string[];
    readonly ackedPeerIds: readonly string[];
    readonly ordering: ALMessage['ordering'];
}

describe('outbound control admission identity', () => {
    it.each(['ack', 'nack', 'repair'] as const)('does not create state or repair effects for an unknown %s', async (type) => {
        const { admissionStore, workQueue, control, state } = createFixture();
        const untracked = controlMessage(type);

        expect((await control.admit(untracked)).kind).toBe('rejected');
        expect(state.data.size).toBe(0);
        expect(await readRetainedWork(admissionStore, workQueue)).toEqual([]);
    });

    it.each(['ack', 'nack', 'repair'] as const)(
        'authorizes full long message and ordering identities for %s without trusting its bounded route',
        async (type) => {
            const { admissionStore, workQueue, control, state } = createFixture();
            const msgId = 'runtime-message/'.repeat(20);
            const message: ALMessage = {
                id: { v: 2, msgId, senderId: 'sender', ts: Date.now() },
                route: { topicId: 'command', resourceId: 'resource', contextId: 'context' },
                payload: { typeId: 'command.v1', resource: '{}' },
                targets: { mode: 'unicast', toPeerId: 'receiver' },
                constraints: { expiresAtMs: Date.now() + 30_000 },
                ordering: { orderingKey: 'ordered-stream/'.repeat(20), seq: 10, epoch: 7 }
            };
            const admission = await computeOutboundTestAdmission(admissionStore, message);
            await admissionStore.commitBundle({
                ...admission,
                mutations: [...admission.mutations, {
                    kind: 'set-pending-ack',
                    snapshot: {
                        msgId,
                        expectedPeerIds: ['receiver'],
                        ackedPeerIds: [],
                        timeoutMs: 2_000,
                        maxAttempts: 3,
                        attempts: 0,
                        deadlineAtMs: Date.now() + 2_000
                    }
                }]
            });
            const id: ALMessage['id'] = { v: 2, msgId: 'control', senderId: 'receiver', ts: Date.now() };
            const common = { fromPeerId: 'receiver', toPeerId: 'sender', observedAtEpochMs: Date.now() };
            const ordering = { orderingKey: toALOrderingTrackKey(message), missingSeqs: [2], expectedSeq: 2 };
            const accepted = type === 'ack'
                ? newALAckControlMessage(id, { ...common, ackedMsgId: msgId, status: 'delivered' })
                : type === 'nack'
                ? newALNackControlMessage(id, { ...common, ...ordering, msgId, reason: 'gap' })
                : newALRepairControlMessage(id, { ...common, ...ordering, msgId, reason: 'missing-seq' });
            const before = [...state.data];
            const wrongRoute = { ...accepted, route: { ...accepted.route, resourceId: 'another-locator' } };
            expect((await control.admit(wrongRoute)).kind).toBe('not-handled');
            const wrongIdentity = {
                ...accepted,
                payload: {
                    ...accepted.payload,
                    resource: JSON.stringify({
                        ...JSON.parse(accepted.payload.resource),
                        [type === 'ack' ? 'ackedMsgId' : 'msgId']: msgId + '-unowned'
                    })
                }
            };
            expect((await control.admit(wrongIdentity)).kind).toBe('not-handled');
            const unknownIdentity = {
                ...wrongIdentity,
                route: toStrictAppInboxQueueKey({
                    topicId: 'al-control',
                    resourceId: msgId + '-unowned',
                    contextId: 'sender'
                })
            };
            expect((await control.admit(unknownIdentity)).kind).toBe('rejected');
            if (type !== 'ack') {
                const wrongOrdering = {
                    ...accepted,
                    payload: {
                        ...accepted.payload,
                        resource: JSON.stringify({
                            ...JSON.parse(accepted.payload.resource),
                            orderingKey: ordering.orderingKey + '-unowned'
                        })
                    }
                };
                expect((await control.admit(wrongOrdering)).kind).toBe('rejected');
            }
            const oversized = {
                ...accepted,
                payload: {
                    ...accepted.payload,
                    resource: JSON.stringify({
                        ...JSON.parse(accepted.payload.resource),
                        [type === 'ack' ? 'ackedMsgId' : 'msgId']: 'x'.repeat(AL_MESSAGE_RESOURCE_LIMITS.payloadBytes + 1)
                    })
                }
            };
            expect((await control.admit(oversized)).kind).toBe('not-handled');
            expect([...state.data]).toEqual(before);

            expect(await control.admit(accepted)).toEqual({ kind: 'committed' });
            if (type === 'ack') {
                expect(await admissionStore.readPendingAck(msgId)).toBeUndefined();
            }
            else {
                const retained = await readRetainedWork(admissionStore, workQueue);
                expect(retained).toContainEqual(expect.objectContaining({
                    kind: 'repair-hint',
                    msgId,
                    request: expect.objectContaining({ orderingTrackKey: toALOrderingTrackKey(message), missingSeqs: [2] })
                }));
            }
        }
    );

    it('ignores an ACK from an unexpected peer and accepts the expected receiver without changing the input', async () => {
        const { admissionStore, control, state } = createFixture();
        await seedDirectObligation(admissionStore);
        const baseline = [...state.data];
        expect((await control.admit(controlMessage('ack', 'intruder'))).kind).toBe('rejected');
        expect([...state.data]).toEqual(baseline);
        const ack = controlMessage('ack');
        const candidate = JSON.stringify(ack);

        expect(await control.admit(ack)).toEqual({ kind: 'committed' });
        expect(await admissionStore.readPendingAck('message')).toBeUndefined();
        expect(JSON.stringify(ack)).toBe(candidate);
        const acceptedState = [...state.data];
        expect((await control.admit(ack)).kind).toBe('rejected');
        expect([...state.data]).toEqual(acceptedState);
    });

    it.each(['nack', 'repair'] as const)('does not let an unrelated peer create %s work for a tracked message', async (type) => {
        const { admissionStore, workQueue, control, state } = createFixture();
        await seedDirectObligation(admissionStore);
        const baseline = [...state.data];

        expect((await control.admit(controlMessage(type, 'intruder'))).kind).toBe('rejected');
        expect([...state.data]).toEqual(baseline);
        expect(await readRetainedWork(admissionStore, workQueue)).toEqual([]);
    });

    it('rejects a control addressed to another local message owner', async () => {
        const { admissionStore, control, state } = createFixture();
        await seedDirectObligation(admissionStore);
        const baseline = [...state.data];
        const ack = newALAckControlMessage(
            { v: 2, msgId: 'control', senderId: 'receiver', ts: 1 },
            { fromPeerId: 'receiver', toPeerId: 'other-sender', ackedMsgId: 'message', status: 'delivered', observedAtEpochMs: 1 }
        );

        expect((await control.admit(ack)).kind).toBe('rejected');
        expect([...state.data]).toEqual(baseline);
    });

    it('admits one stable repair hint and rejects a semantic duplicate', async () => {
        const { admissionStore, workQueue, control, state } = createFixture();
        await seedDirectObligation(admissionStore);
        const first = repairControl(1);

        expect(await control.admit(first)).toEqual({ kind: 'committed' });
        const acceptedState = [...state.data];
        expect((await control.admit(repairControl(2))).kind).toBe('rejected');
        expect([...state.data]).toEqual(acceptedState);
        expect(await readRetainedWork(admissionStore, workQueue)).toEqual([{
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
        const { admissionStore, control, state } = createFixture();
        await seedDirectObligation(admissionStore);

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
            expect(await control.admit(nack)).toEqual({ kind: 'committed' });
        }

        const stored = state.data.get('outbound-control:control:nacks:message');
        const history = decodeALAdmissionControlValue(stored?.value, 'message', 'nacks');
        expect(history.values).toHaveLength(256);
        expect(history.values[0].serverSnapshotVersion).toBe(1);
        expect(history.values.at(-1)?.serverSnapshotVersion).toBe(256);
    });

    it('uses a frozen multicast pending audience to admit repair controls', async () => {
        const { admissionStore, control, state } = createFixture();
        await seedMulticastObligation(admissionStore);

        expect(await control.admit(controlMessage('repair'))).toEqual({ kind: 'committed' });
        const acceptedState = [...state.data];
        expect((await control.admit(controlMessage('repair', 'intruder'))).kind).toBe('rejected');
        expect([...state.data]).toEqual(acceptedState);
    });

    it('rejects repair hints outside the retained message ordering track before writes', async () => {
        const { admissionStore, control, state } = createFixture();
        await seedOrderedObligation(admissionStore);
        const baseline = [...state.data];

        expect((await control.admit(orderedRepairControl('other-track', [2]))).kind).toBe('rejected');
        expect([...state.data]).toEqual(baseline);
        expect((await control.admit(orderedRepairControl('stream:sender:7', [11]))).kind).toBe('rejected');
        expect([...state.data]).toEqual(baseline);
        expect(await control.admit(orderedRepairControl('stream:sender:7', [2, 3]))).toEqual({ kind: 'committed' });
    });

    it('completes a frozen 256-peer audience after diagnostic ACK history is already full', async () => {
        const { admissionStore, control, state } = createFixture();
        const expectedPeerIds = Array.from({ length: 256 }, (_, index) => `peer-${index}`);
        await seedObligation(admissionStore, {
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

        expect(await control.admit(controlMessage('ack', 'peer-255'))).toEqual({ kind: 'committed' });
        expect(await admissionStore.readPendingAck('message')).toBeUndefined();
        expect(decodeALAdmissionControlValue(state.data.get(key)?.value, 'message', 'acks').values).toHaveLength(256);
    });

    it('retains admit-control work when message ownership changes after the control read', async () => {
        const { backend, admissionStore, workQueue, control, state } = createFixture();
        await seedDirectObligation(admissionStore);
        const write = backend.write.bind(backend);
        vi.spyOn(backend, 'write').mockImplementationOnce(async (operation) => {
            await write(async (transaction) => {
                await transaction.set('outbound-control:msg-owner:message', 'other-sender');
            });
            return await write(operation);
        });

        expect(await control.admit(controlMessage('ack'))).toEqual({ kind: 'pending-control' });
        expect(state.data.has('outbound-control:control:acks:message')).toBe(false);
        const retained = await readRetainedWork(admissionStore, workQueue);
        expect(retained.map((payload) => payload.kind)).toEqual(['admit-control']);

        // The replay finds the new owner and terminalizes the work instead of retrying forever.
        expect(await control.replay(toPendingControl(retained[0]!))).toEqual({ status: 'completed' });
        expect(state.data.has('outbound-control:control:acks:message')).toBe(false);
    });

    it('commits an accepted repair and the work it forwards in one transaction', async () => {
        const { backend, admissionStore, workQueue, control } = createFixture();
        await seedDirectObligation(admissionStore);
        const commits = recordALOutboundCommits(backend, admissionStore.namespace);

        expect(await control.admit(repairControl(1))).toEqual({ kind: 'committed' });

        // One commit carries the accepted repair history and the hint it forwards; a split write fails here.
        expect(commits).toHaveLength(1);
        expect(commits[0]!.workKinds).toEqual(['repair-hint']);
        expect(commits[0]!.storeKeys).toContainEqual(expect.stringContaining(':control:repairs:'));
        expect((await readRetainedWork(admissionStore, workQueue)).map((payload) => payload.kind))
            .toEqual(['repair-hint']);
    });

    it('answers pending-control for a backend conflict without an inner retry', async () => {
        const { backend, admissionStore, workQueue, control } = createFixture();
        await seedDirectObligation(admissionStore);
        const write = vi.spyOn(backend, 'write').mockImplementationOnce(() => {
            throw new ALAdmissionBackendConflictError('simulated outbound control conflict');
        });

        expect(await control.admit(controlMessage('ack'))).toEqual({ kind: 'pending-control' });

        expect(write).toHaveBeenCalledTimes(1);
        expect((await readRetainedWork(admissionStore, workQueue)).map((payload) => payload.kind))
            .toEqual(['admit-control']);
    });
});

function createFixture() {
    const state = createInMemoryALAdmissionState();
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    const admissionStore = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: 'outbound-control',
        decodePrepared: decodeALOutboundTransportMessage,
        namespace: 'outbound-control',
        backend,
        supersedenceTrackTtlMs: 300000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return {
        backend,
        admissionStore,
        state,
        workQueue: state.workQueue,
        control: createTestALOutboundControlAdmission({
            admissionStore,
            workQueue: state.workQueue,
            nowMs: Date.now
        })
    };
}

/** The work rows the owner retained for this scope, decoded the way its worker decodes them. */
async function readRetainedWork(
    admissionStore: ALOutboundAdmissionStore<ALOutboundTransportMessage>,
    workQueue: QueueBoxResourceEntryRepository
): Promise<readonly ALOutboundDurableEffect<ALOutboundTransportMessage>[]> {
    const page = await workQueue.readWorkPage({
        typeId: toALOutboundWorkType(admissionStore.namespace),
        status: EntityStatus.NEW,
        maxToRead: 10,
        cursor: null
    });
    return await Promise.all(
        page.entries.map(async (entry) => (await admissionStore.readWorkSnapshot(entry)).payload)
    );
}

function toPendingControl(payload: ALOutboundDurableEffect<ALOutboundTransportMessage>) {
    if (payload.kind !== 'admit-control') {
        throw new Error(`Expected retained admit-control work, received ${payload.kind}`);
    }
    return payload;
}

interface ALOutboundCommitObservation {
    readonly storeKeys: string[];
    readonly workKinds: string[];
}

/** Records what each backend write commits, so a commit boundary can be asserted rather than coexistence. */
function recordALOutboundCommits(
    backend: InMemoryAdmissionBackend,
    namespace: string
): readonly ALOutboundCommitObservation[] {
    const write = backend.write.bind(backend);
    const commits: ALOutboundCommitObservation[] = [];
    vi.spyOn(backend, 'write').mockImplementation((run, executionExpiresAtMs) => {
        const commit: ALOutboundCommitObservation = { storeKeys: [], workKinds: [] };
        commits.push(commit);
        return write(async (tx) =>
            await run({
                read: <V>(key: string, decode: ALAdmissionDecoder<V>) => tx.read(key, decode),
                list: <V>(prefix: string, decode: ALAdmissionDecoder<V>) => tx.list(prefix, decode),
                set: async <V>(key: string, value: V, expireAtTimestamp?: number) => {
                    commit.storeKeys.push(key);
                    await tx.set(key, value, expireAtTimestamp);
                },
                remove: async (key: string) => {
                    commit.storeKeys.push(key);
                    await tx.remove(key);
                },
                readWork: (key) => tx.readWork(key),
                writeWork: (entry) => {
                    commit.workKinds.push(
                        decodeALOutboundWorkEntry(entry, namespace, {
                            decodePrepared: decodeALOutboundTransportMessage,
                            message: undefined
                        }).payload.kind
                    );
                    tx.writeWork(entry);
                }
            }), executionExpiresAtMs);
    });
    return commits;
}

async function seedDirectObligation(
    admissionStore: ALOutboundAdmissionStore<ALOutboundTransportMessage>
): Promise<void> {
    await seedObligation(admissionStore, {
        targets: { mode: 'unicast', toPeerId: 'receiver' },
        expectedPeerIds: ['receiver'],
        ackedPeerIds: [],
        ordering: undefined
    });
}

async function seedMulticastObligation(
    admissionStore: ALOutboundAdmissionStore<ALOutboundTransportMessage>
): Promise<void> {
    await seedObligation(admissionStore, {
        targets: { mode: 'multicast', groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' } },
        expectedPeerIds: ['receiver', 'other-receiver'],
        ackedPeerIds: [],
        ordering: undefined
    });
}

async function seedOrderedObligation(
    admissionStore: ALOutboundAdmissionStore<ALOutboundTransportMessage>
): Promise<void> {
    await seedObligation(admissionStore, {
        targets: { mode: 'unicast', toPeerId: 'receiver' },
        expectedPeerIds: ['receiver'],
        ackedPeerIds: [],
        ordering: { orderingKey: 'stream', epoch: 7, seq: 10 }
    });
}

async function seedObligation(
    admissionStore: ALOutboundAdmissionStore<ALOutboundTransportMessage>,
    input: OutboundObligationInput
): Promise<void> {
    const msg: ALMessage = {
        id: { v: 2, msgId: 'message', senderId: 'sender', ts: 1 },
        route: { topicId: 'command', resourceId: 'resource', contextId: 'context' },
        payload: { typeId: 'command.v1', resource: '{}' },
        targets: input.targets,
        constraints: { expiresAtMs: Date.now() + 30_000 },
        ordering: input.ordering
    };
    const admission = await computeOutboundTestAdmission(admissionStore, msg);
    await admissionStore.commitBundle({
        ...admission,
        mutations: [
            ...admission.mutations,
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
    });
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
