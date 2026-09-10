import { createTestALInboundControlAdmission } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionDecoder } from '@shared/alm/al-admission-decoder.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    createALInboundAdmissionStore,
    type ALInboundAdmissionStore
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import {
    decodeALInboundWorkEntry,
    toALInboundWorkType
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { computeALInboundControlAdmission } from '@shared/alm/inbound/control/compute-al-inbound-control-admission.ts';
import { validateALInboundControlAdmission } from '@shared/alm/inbound/control/validate-al-inbound-control-admission.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
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
        nowMs: Date.now,
        namespace: 'inbound',
        backend,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const stores = { admissionStore, workQueue: state.workQueue };
    return {
        backend,
        // Captured before any spy so a recorder can call the real commit without re-entering itself.
        write: backend.write.bind(backend),
        admissionStore,
        workQueue: state.workQueue,
        control: createTestALInboundControlAdmission({
            ...stores,
            nowMs: Date.now,
            newControlId: () => 'generated-control'
        })
    };
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

interface ALInboundCommitObservation {
    readonly storeKeys: string[];
    readonly workKinds: string[];
}

/** Records what each backend write commits, so a commit boundary can be asserted rather than coexistence. */
function recordALInboundCommits(
    backend: InMemoryAdmissionBackend,
    write: InMemoryAdmissionBackend['write'],
    namespace: string
): readonly ALInboundCommitObservation[] {
    const commits: ALInboundCommitObservation[] = [];
    vi.spyOn(backend, 'write').mockImplementation((run, executionExpiresAtMs) => {
        const commit: ALInboundCommitObservation = { storeKeys: [], workKinds: [] };
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
                    commit.workKinds.push(decodeALInboundWorkEntry(entry, namespace).payload.kind);
                    tx.writeWork(entry);
                }
            }), executionExpiresAtMs);
    });
    return commits;
}

async function readRetainedWork(
    admissionStore: ALInboundAdmissionStore,
    workQueue: QueueBoxResourceEntryRepository
) {
    const page = await workQueue.readWorkPage({
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
        const { admissionStore, workQueue, control } = createFixture();
        await seedPendingAcknowledgement(admissionStore);

        const result = await control.admit(createAcknowledgement('intruder'));

        expect(result).toEqual({ kind: 'not-handled' });
        const state = await admissionStore.readAcknowledgementState(message.id.msgId, message.id.senderId);
        expect(state.acks).toEqual([]);
        expect(state.pendingAck?.expectedFromPeerIds).toEqual(['receiver']);
        expect(await readRetainedWork(admissionStore, workQueue)).toEqual([]);
    });

    it('retains admit-control work for a conflicting commit and replays it to completion', async () => {
        const { backend, write, admissionStore, workQueue, control } = createFixture();
        await seedPendingAcknowledgement(admissionStore);
        vi.spyOn(backend, 'write').mockImplementationOnce(() => {
            throw new ALAdmissionBackendConflictError('simulated inbound control conflict');
        });

        const conflicted = await control.admit(createAcknowledgement('receiver'));

        expect(conflicted).toEqual({ kind: 'pending-control' });
        expect((await admissionStore.readAcknowledgementState(message.id.msgId, message.id.senderId)).acks)
            .toEqual([]);
        const retained = await readRetainedWork(admissionStore, workQueue);
        expect(retained).toHaveLength(1);
        expect(retained[0]!.payload.kind).toBe('admit-control');

        const payload = retained[0]!.payload;
        if (payload.kind !== 'admit-control') {
            throw new Error('Expected retained admit-control work');
        }

        const commits = recordALInboundCommits(backend, write, admissionStore.namespace);

        const replayed = await control.replay(payload);

        expect(replayed.outcome).toEqual({ status: 'completed' });
        expect(replayed.acceptance?.handled).toBe(true);
        const state = await admissionStore.readAcknowledgementState(message.id.msgId, message.id.senderId);
        expect(state.acks.map((ack) => ack.fromPeerId)).toEqual(['receiver']);
        expect(state.pendingAck).toBeUndefined();
        // One commit carries the accepted acknowledgement and the control it forwards; a split write fails here.
        expect(commits).toHaveLength(1);
        expect(commits[0]!.workKinds).toEqual(['send-control']);
        expect(commits[0]!.storeKeys).toContainEqual(expect.stringContaining(':control:acks:'));
        expect((await readRetainedWork(admissionStore, workQueue)).map((work) => work.payload.kind).toSorted())
            .toEqual(['admit-control', 'send-control']);
    });

    // The global constraint requires validateXxx to report every issue, not only the first one.
    it('reports every reason one acknowledgement candidate is inadmissible', () => {
        const nowMs = 1_800_000_000_000;
        const candidate = computeALInboundControlAdmission({
            namespace: 'inbound',
            ack: {
                ackedMsgId: message.id.msgId,
                fromPeerId: 'stranger',
                toPeerId: message.id.senderId,
                status: 'delivered',
                observedAtEpochMs: nowMs
            },
            controlOwners: { ambiguous: false, values: [{ peerId: 'stranger', senderId: message.id.senderId }] },
            owner: {
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                source: { kind: 'ws-client', peerId: message.id.senderId },
                supersedenceKey: null
            },
            pending: {
                toPeerId: message.id.senderId,
                status: 'delivered',
                localReady: true,
                expectedFromPeerIds: ['receiver'],
                ackedFromPeerIds: ['stranger']
            },
            acks: [],
            nowMs,
            controlMsgId: 'control'
        }, normalizeALRuntimeStoreRetention());

        const issues = validateALInboundControlAdmission({
            ...candidate,
            pendingExpireAtTimestamp: Number.NaN
        });

        expect(issues.map((issue) => issue.message)).toEqual([
            'Inbound acknowledgement sender has no pending obligation',
            'Inbound acknowledgement was already admitted',
            'Inbound acknowledgement candidate exceeds persistence limits'
        ]);
    });
});
