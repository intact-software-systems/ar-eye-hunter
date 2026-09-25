import { createTestALInboundControlAdmission } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    parseALControlMessage,
    type ALAckPayload,
    type ALPendingAckSnapshot
} from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionReadContext
} from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionDecoder } from '@shared/alm/al-admission-decoder.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import type { ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    createALInboundAdmissionStore,
    type ALInboundAdmissionStore,
    type ALInboundControlOwnerIndex
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
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

import {
    readInboundTestAcknowledgements,
    type InboundTestAcknowledgements
} from '../read-inbound-test-acknowledgements.ts';

/** Every acknowledgement here reaches the WS runtime of a browser, which receives it from the server. */
const WS_ARRIVAL: ALInboundMessageRuntime.Source = { kind: 'trusted-server' };

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
            carrier: 'ws',
            ...stores,
            nowMs: Date.now,
            newControlId: () => 'generated-control'
        })
    };
}

const TRACKED_CONTROL_OWNERS: ALInboundControlOwnerIndex = {
    ambiguous: false,
    values: [{ peerId: 'receiver', senderId: message.id.senderId }]
};

async function seedPendingAcknowledgement(
    admissionStore: ALInboundAdmissionStore,
    controlOwners: ALInboundControlOwnerIndex = TRACKED_CONTROL_OWNERS,
    /** Absent seeds a message that arrived from its sender over WS. */
    source: ALInboundMessageRuntime.Source = { kind: 'ws-client', peerId: message.id.senderId }
): Promise<void> {
    const expireAtTimestamp = Date.now() + 60_000;
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
                        expireAtTimestamp,
                        carrier: 'ws'
                    }
                },
                expireAtTimestamp
            }, {
                kind: 'set-control-owners',
                msgId: message.id.msgId,
                value: controlOwners,
                expireAtTimestamp
            }],
            durableEffects: []
        })
    ).toBe('committed');
}

function createAcknowledgement(fromPeerId: string, originPeerId: string = message.id.senderId): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${fromPeerId}`, ts: 1, senderId: fromPeerId },
        {
            ackedMsgId: message.id.msgId,
            originPeerId,
            logicalRecipientPeerId: fromPeerId,
            fromPeerId,
            toPeerId: 'self',
            status: 'delivered',
            observedAtEpochMs: 1,
            carrier: 'ws'
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

async function readAcknowledgements(
    backend: ALAdmissionReadContext,
    admissionStore: ALInboundAdmissionStore
): Promise<InboundTestAcknowledgements> {
    return await readInboundTestAcknowledgements({
        backend,
        namespace: admissionStore.namespace,
        msgId: message.id.msgId,
        senderId: message.id.senderId
    });
}

async function readRetainedWork(
    admissionStore: ALInboundAdmissionStore,
    workQueue: QueueBoxResourceEntryRepository,
    carrier: ALDeliveryCarrier = 'ws'
) {
    const page = await workQueue.readWorkPage({
        typeId: toALInboundWorkType(admissionStore.namespace, carrier),
        status: EntityStatus.NEW,
        maxToRead: 10,
        cursor: null
    });
    return page.entries.map((entry) => decodeALInboundWorkEntry(entry, admissionStore.namespace));
}

describe('inbound control admission', () => {
    it('commits an acknowledgement from the peer that owes it and keeps the completed row', async () => {
        const { backend, admissionStore, control } = createFixture();
        await seedPendingAcknowledgement(admissionStore);

        const result = await control.admit(createAcknowledgement('receiver'), WS_ARRIVAL);

        expect(result.kind).toBe('committed');
        expect(result.kind === 'committed' && result.acceptance.handled).toBe(true);
        const state = await readAcknowledgements(backend, admissionStore);
        expect(state.acks.map((ack) => ack.fromPeerId)).toEqual(['receiver']);
        // A child ACK that arrives after completion is still relayed, so the row stays until it expires.
        expect(state.pendingAck?.ackedFromPeerIds).toEqual(['receiver']);
    });

    it('refuses a child acknowledgement that names another origin than the message it tracks', async () => {
        const { backend, admissionStore, control } = createFixture();
        await seedPendingAcknowledgement(admissionStore);

        const result = await control.admit(createAcknowledgement('receiver', 'B'), WS_ARRIVAL);

        expect(result).toEqual({
            kind: 'rejected',
            reason: 'Inbound acknowledgement names another origin than the message it acknowledges'
        });
        const state = await readAcknowledgements(backend, admissionStore);
        expect(state.acks).toEqual([]);
        expect(state.pendingAck?.ackedFromPeerIds).toEqual([]);
    });

    it('writes the ACK it relays upstream under the carrier the acknowledged message arrived on', async () => {
        const { admissionStore, workQueue, control } = createFixture();
        await seedPendingAcknowledgement(admissionStore, TRACKED_CONTROL_OWNERS, {
            kind: 'rtc-peer',
            peerId: message.id.senderId
        });

        // The acknowledgement itself reaches the WS runtime's control admission.
        expect((await control.admit(createAcknowledgement('receiver'), WS_ARRIVAL)).kind).toBe('committed');

        expect(await readRetainedWork(admissionStore, workQueue, 'ws')).toEqual([]);
        expect((await readRetainedWork(admissionStore, workQueue, 'rtc')).map((work) => work.payload.kind))
            .toEqual(['send-control', 'send-control']);
    });

    it('retains admit-control work for a conflicting commit and replays it to completion', async () => {
        const { backend, write, admissionStore, workQueue, control } = createFixture();
        await seedPendingAcknowledgement(admissionStore);
        vi.spyOn(backend, 'write').mockImplementationOnce(() => {
            throw new ALAdmissionBackendConflictError('simulated inbound control conflict');
        });

        const conflicted = await control.admit(createAcknowledgement('receiver'), WS_ARRIVAL);

        expect(conflicted).toEqual({ kind: 'pending-control' });
        expect((await readAcknowledgements(backend, admissionStore)).acks).toEqual([]);
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
        const state = await readAcknowledgements(backend, admissionStore);
        expect(state.acks.map((ack) => ack.fromPeerId)).toEqual(['receiver']);
        expect(state.pendingAck?.ackedFromPeerIds).toEqual(['receiver']);
        // One commit carries the accepted acknowledgement and the controls it sends upward; a split write fails here.
        expect(commits).toHaveLength(1);
        expect(commits[0]!.workKinds).toEqual(['send-control', 'send-control']);
        expect(commits[0]!.storeKeys).toContainEqual(expect.stringContaining(':control:acks:'));
        expect((await readRetainedWork(admissionStore, workQueue)).map((work) => work.payload.kind).toSorted())
            .toEqual(['admit-control', 'send-control', 'send-control']);
    });

    it('retains a conflicting acknowledgement under the carrier it arrived on and records it under that carrier', async () => {
        const { backend, admissionStore, workQueue } = createFixture();
        const control = createTestALInboundControlAdmission({
            carrier: 'rtc',
            admissionStore,
            workQueue,
            nowMs: Date.now,
            newControlId: () => 'generated-control'
        });
        await seedPendingAcknowledgement(admissionStore);
        vi.spyOn(backend, 'write').mockImplementationOnce(() => {
            throw new ALAdmissionBackendConflictError('simulated inbound control conflict');
        });

        const arrival: ALInboundMessageRuntime.Source = { kind: 'rtc-peer', peerId: 'receiver' };
        expect(await control.admit(createAcknowledgement('receiver'), arrival)).toEqual({ kind: 'pending-control' });
        expect(await readRetainedWork(admissionStore, workQueue, 'ws')).toEqual([]);
        const [retained] = await readRetainedWork(admissionStore, workQueue, 'rtc');
        if (retained?.payload.kind !== 'admit-control') {
            throw new Error('Expected retained admit-control work');
        }
        expect(retained.payload.carrier).toBe('rtc');

        expect((await control.replay(retained.payload)).outcome).toEqual({ status: 'completed' });
        expect((await readAcknowledgements(backend, admissionStore)).acks.map((ack) => ack.carrier)).toEqual(['rtc']);
    });

    it('relays the child ACK that completes its subtree, then sends its own terminal ACK last', () => {
        const nowMs = 1_800_000_000_000;
        const toAck = (fromPeerId: string, logicalRecipientPeerId: string): ALAckPayload => ({
            ackedMsgId: message.id.msgId,
            originPeerId: message.id.senderId,
            logicalRecipientPeerId,
            fromPeerId,
            toPeerId: 'self',
            status: 'subtree-complete',
            observedAtEpochMs: nowMs,
            carrier: 'rtc'
        });
        // The lower relay already completed its hop; the direct leaf completes the subtree.
        const candidate = computeALInboundControlAdmission({
            namespace: 'inbound',
            ack: toAck('leaf', 'leaf'),
            controlOwners: TRACKED_CONTROL_OWNERS,
            owner: {
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                source: { kind: 'rtc-peer', peerId: message.id.senderId },
                supersedenceKey: null
            },
            pending: {
                toPeerId: message.id.senderId,
                status: 'subtree-complete',
                localReady: true,
                expectedFromPeerIds: ['lower-relay', 'leaf'],
                ackedFromPeerIds: ['lower-relay'],
                carrier: 'rtc'
            },
            acks: [toAck('lower-relay', 'deep-recipient')],
            nowMs,
            controlMsgId: 'control'
        }, normalizeALRuntimeStoreRetention());

        const upstream = candidate.upwardEffects.map((effect) =>
            effect.payload.kind === 'send-control' ? parseALControlMessage(effect.payload.msg) : undefined
        );
        expect(upstream.map((control) => control?.type === 'ack' ? control.payload : undefined)).toEqual(
            [['leaf', 'forwarded'], ['self', 'subtree-complete']].map(([logicalRecipientPeerId, status]) => ({
                ackedMsgId: message.id.msgId,
                fromPeerId: 'self',
                toPeerId: message.id.senderId,
                originPeerId: message.id.senderId,
                logicalRecipientPeerId,
                carrier: 'rtc',
                status,
                observedAtEpochMs: nowMs
            }))
        );
        expect(new Set(candidate.upwardEffects.map((effect) => effect.effectId)).size).toBe(2);
    });

    it('completes a relay that is itself a recipient only after its child relay confirmed every recipient below it', () => {
        // origin -> relay `r` (a recipient) -> child relay `c` (a recipient) -> leaf `l`.
        const cUpward = admitRelayAcknowledgements(
            { selfPeerId: 'c', toPeerId: 'r', expectedFromPeerIds: ['l'] },
            [toRelayAck({ fromPeerId: 'l', toPeerId: 'c', logicalRecipientPeerId: 'l', status: 'delivered' })]
        );
        const rUpward = admitRelayAcknowledgements(
            { selfPeerId: 'r', toPeerId: message.id.senderId, expectedFromPeerIds: ['c'] },
            cUpward.upward
        );

        expect(rUpward.completedAfter).toEqual([false, true]);
        expect(rUpward.upward.map((ack) => [ack.logicalRecipientPeerId, ack.status])).toEqual([
            ['l', 'forwarded'],
            ['c', 'forwarded'],
            ['r', 'subtree-complete']
        ]);
        expect(rUpward.upward.every((ack) => ack.fromPeerId === 'r' && ack.toPeerId === message.id.senderId))
            .toBe(true);
    });

    it('keys a child\'s acknowledgements by the recipient each speaks for, refusing only a repeat (D40)', () => {
        const nowMs = 1_800_000_000_000;
        const toAck = (logicalRecipientPeerId: string): ALAckPayload => ({
            ackedMsgId: message.id.msgId,
            originPeerId: message.id.senderId,
            logicalRecipientPeerId,
            fromPeerId: 'child-relay',
            toPeerId: 'self',
            status: 'subtree-complete',
            observedAtEpochMs: nowMs,
            carrier: 'rtc'
        });
        const readWith = (ack: ALAckPayload) =>
            computeALInboundControlAdmission({
                namespace: 'inbound',
                ack,
                controlOwners: TRACKED_CONTROL_OWNERS,
                owner: {
                    msgId: message.id.msgId,
                    senderId: message.id.senderId,
                    source: { kind: 'rtc-peer', peerId: message.id.senderId },
                    supersedenceKey: null
                },
                pending: {
                    toPeerId: message.id.senderId,
                    status: 'subtree-complete',
                    localReady: true,
                    expectedFromPeerIds: ['child-relay', 'leaf'],
                    ackedFromPeerIds: ['child-relay'],
                    carrier: 'rtc'
                },
                acks: [toAck('grandchild-1')],
                nowMs,
                controlMsgId: 'control'
            }, normalizeALRuntimeStoreRetention());

        expect(validateALInboundControlAdmission(readWith(toAck('grandchild-2')))).toEqual([]);
        expect(validateALInboundControlAdmission(readWith(toAck('grandchild-1'))).map((issue) => issue.message))
            .toEqual(['Inbound acknowledgement was already admitted']);
    });

    it('names itself in its terminal ACK, after the recipients it relays', () => {
        const nowMs = 1_800_000_000_000;
        const candidate = computeALInboundControlAdmission({
            namespace: 'inbound',
            ack: {
                ackedMsgId: message.id.msgId,
                originPeerId: message.id.senderId,
                logicalRecipientPeerId: 'leaf',
                fromPeerId: 'leaf',
                toPeerId: 'self',
                status: 'delivered',
                observedAtEpochMs: nowMs,
                carrier: 'rtc'
            },
            controlOwners: TRACKED_CONTROL_OWNERS,
            owner: {
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                source: { kind: 'rtc-peer', peerId: message.id.senderId },
                supersedenceKey: null
            },
            pending: {
                toPeerId: message.id.senderId,
                status: 'subtree-complete',
                localReady: true,
                expectedFromPeerIds: ['leaf'],
                ackedFromPeerIds: [],
                carrier: 'rtc'
            },
            acks: [],
            nowMs,
            controlMsgId: 'control'
        }, normalizeALRuntimeStoreRetention());

        const upstream = candidate.upwardEffects.map((effect) =>
            effect.payload.kind === 'send-control' ? parseALControlMessage(effect.payload.msg) : undefined
        );
        // The terminal ACK is the end of this subtree for the parent, and names the relay for the origin.
        expect(
            upstream.map((control) => control?.type === 'ack' ? control.payload.logicalRecipientPeerId : undefined)
        ).toEqual(['leaf', 'self']);
    });

    it('re-originates the origin from its own message-owner row, never from what a child claimed', () => {
        const nowMs = 1_800_000_000_000;
        const candidate = computeALInboundControlAdmission({
            namespace: 'inbound',
            ack: {
                ackedMsgId: message.id.msgId,
                originPeerId: 'B',
                logicalRecipientPeerId: 'receiver',
                fromPeerId: 'receiver',
                toPeerId: 'self',
                status: 'delivered',
                observedAtEpochMs: nowMs,
                carrier: 'ws'
            },
            controlOwners: TRACKED_CONTROL_OWNERS,
            owner: {
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                source: { kind: 'ws-client', peerId: message.id.senderId },
                supersedenceKey: null
            },
            pending: {
                toPeerId: message.id.senderId,
                status: 'subtree-complete',
                localReady: true,
                expectedFromPeerIds: ['receiver'],
                ackedFromPeerIds: [],
                carrier: 'ws'
            },
            acks: [],
            nowMs,
            controlMsgId: 'control'
        }, normalizeALRuntimeStoreRetention());

        const upstream = candidate.upwardEffects.map((effect) =>
            effect.payload.kind === 'send-control' ? parseALControlMessage(effect.payload.msg) : undefined
        );
        expect(upstream.map((control) => control?.type === 'ack' ? control.payload.originPeerId : undefined))
            .toEqual([message.id.senderId, message.id.senderId]);
        expect(validateALInboundControlAdmission(candidate).map((issue) => issue.message))
            .toContain('Inbound acknowledgement names another origin than the message it acknowledges');
    });

    // The global constraint requires validateXxx to report every issue, not only the first one.
    it('reports every reason one acknowledgement candidate is inadmissible', () => {
        const nowMs = 1_800_000_000_000;
        const candidate = computeALInboundControlAdmission({
            namespace: 'inbound',
            ack: {
                ackedMsgId: message.id.msgId,
                originPeerId: message.id.senderId,
                logicalRecipientPeerId: 'stranger',
                fromPeerId: 'stranger',
                toPeerId: message.id.senderId,
                status: 'delivered',
                observedAtEpochMs: nowMs,
                carrier: 'ws'
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
                ackedFromPeerIds: ['stranger'],
                carrier: 'ws'
            },
            acks: [{
                ackedMsgId: message.id.msgId,
                originPeerId: message.id.senderId,
                logicalRecipientPeerId: 'stranger',
                fromPeerId: 'stranger',
                toPeerId: message.id.senderId,
                status: 'delivered',
                observedAtEpochMs: nowMs,
                carrier: 'ws'
            }],
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

interface RelayAcknowledgementRow {
    readonly selfPeerId: string;
    readonly toPeerId: string;
    readonly expectedFromPeerIds: readonly string[];
}

interface RelayAcknowledgementTrace {
    readonly upward: readonly ALAckPayload[];
    /** Whether the relay row had completed after each arrival it admitted, in arrival order. */
    readonly completedAfter: readonly boolean[];
}

/** Admits each arrival at one relay, in order, as its control admission would, and collects what it sends up. */
function admitRelayAcknowledgements(
    row: RelayAcknowledgementRow,
    arrivals: readonly ALAckPayload[]
): RelayAcknowledgementTrace {
    const nowMs = 1_800_000_000_000;
    let pending: ALPendingAckSnapshot | undefined = {
        toPeerId: row.toPeerId,
        status: 'subtree-complete',
        localReady: true,
        expectedFromPeerIds: row.expectedFromPeerIds,
        ackedFromPeerIds: [],
        carrier: 'rtc'
    };
    let acks: readonly ALAckPayload[] = [];
    const upward: ALAckPayload[] = [];
    const completedAfter: boolean[] = [];
    for (const [index, ack] of arrivals.entries()) {
        const candidate = computeALInboundControlAdmission({
            namespace: 'inbound',
            ack: { ...ack, toPeerId: row.selfPeerId },
            controlOwners: TRACKED_CONTROL_OWNERS,
            owner: {
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                source: { kind: 'rtc-peer', peerId: row.toPeerId },
                supersedenceKey: null
            },
            pending,
            acks,
            nowMs,
            controlMsgId: `${row.selfPeerId}-control-${index}`
        }, normalizeALRuntimeStoreRetention());
        if (validateALInboundControlAdmission(candidate).length > 0) {
            continue;
        }
        pending = candidate.pending?.value;
        acks = candidate.acks.values;
        completedAfter.push(candidate.acceptance.completedPendingAcks.length > 0);
        upward.push(...candidate.upwardEffects.flatMap((effect) => toSentAck(effect.payload)));
    }
    return { upward, completedAfter };
}

function toSentAck(payload: { readonly kind: string; readonly msg?: ALMessage; }): readonly ALAckPayload[] {
    const control = payload.kind === 'send-control' && payload.msg ? parseALControlMessage(payload.msg) : undefined;
    return control?.type === 'ack' ? [control.payload] : [];
}

function toRelayAck(
    input: Pick<ALAckPayload, 'fromPeerId' | 'toPeerId' | 'logicalRecipientPeerId' | 'status'>
): ALAckPayload {
    return {
        ...input,
        ackedMsgId: message.id.msgId,
        originPeerId: message.id.senderId,
        carrier: 'rtc',
        observedAtEpochMs: 1_800_000_000_000
    };
}
