import { createTestALInboundControlAdmission } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '@shared/al-contracts/al-control-value-codec.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
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
import {
    createALInboundAdmissionStore,
    type ALInboundAdmissionStore,
    type ALInboundControlOwnerIndex
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import {
    decodeALInboundWorkEntry,
    toALInboundWorkType
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { ALInboundAcknowledgementEvidence } from '@shared/alm/inbound/control/al-inbound-acknowledgement-evidence.ts';
import type { ALInboundControlAdmission } from '@shared/alm/inbound/control/al-inbound-control-admission.ts';
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
    id: { v: 4, msgId: 'message', senderId: 'sender', ts: 1_800_000_000_000, traceId: 'trace-al-inbound-control-admission' },
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
        retention: normalizeALRuntimeStoreRetention(),
        maxOrderingTracks: undefined,
        maxDeliveredMarkers: undefined
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
    source: ALInboundMessageRuntime.Source = {
        kind: 'ws-client',
        peerId: message.id.senderId,
        authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' }
    }
): Promise<void> {
    await seedRelayRow(admissionStore, { controlOwners, source, row: {} });
}

interface SeededRelayRow {
    readonly controlOwners: ALInboundControlOwnerIndex;
    readonly source: ALInboundMessageRuntime.Source;
    /** What differs from a ready row toward `upstream` waiting on `receiver` alone. */
    readonly row: Partial<ALPendingAckSnapshot>;
}

async function seedRelayRow(admissionStore: ALInboundAdmissionStore, seeded: SeededRelayRow): Promise<void> {
    const { controlOwners, source } = seeded;
    const expireAtTimestamp = Date.now() + 60_000;
    const nowMs = Date.now();
    const read = await admissionStore.readIncomingMessage({
        selfPeerId: 'self',
        orderingObserver: 'addressed',
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
                    supersedenceKey: null,
                    deliveredLocally: true
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
                        outsideAudiencePeerIds: [],
                        expireAtTimestamp,
                        carrier: 'ws',
                        ...seeded.row
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
        { v: 4, msgId: `ack-${fromPeerId}`, ts: 1, senderId: fromPeerId, traceId: 'trace-al-inbound-control-admission' },
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
                setFence: async <V>(key: string, value: V, expireAtTimestamp?: number) => {
                    commit.storeKeys.push(key);
                    await tx.setFence(key, value, expireAtTimestamp);
                },
                remove: async (key: string) => {
                    commit.storeKeys.push(key);
                    await tx.remove(key);
                },
                readWork: (key) => tx.readWork(key),
                readClaimedWork: (claimed) => tx.readClaimedWork(claimed),
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

    it('relays upstream under the trace of the acknowledgement it admits, never a fresh one', async () => {
        const { admissionStore, workQueue, control } = createFixture();
        await seedPendingAcknowledgement(admissionStore);
        const acknowledgement = createAcknowledgement('receiver');

        expect((await control.admit(acknowledgement, WS_ARRIVAL)).kind).toBe('committed');

        const relayed = (await readRetainedWork(admissionStore, workQueue)).map((work) =>
            work.payload.kind === 'send-control' ? work.payload.msg.id.traceId : undefined
        );
        expect(relayed).toEqual([acknowledgement.id.traceId, acknowledgement.id.traceId]);
    });

    it('retains admit-control work for a conflicting commit and replays it to completion', async () => {
        const { backend, write, admissionStore, workQueue, control } = createFixture();
        await seedPendingAcknowledgement(admissionStore);
        vi.spyOn(backend, 'write').mockImplementationOnce(() => {
            throw new ALAdmissionBackendConflictError('simulated inbound control conflict');
        });

        const acknowledgement = createAcknowledgement('receiver');
        const traced = { ...acknowledgement, id: { ...acknowledgement.id, traceId: 'trace-replayed-acknowledgement' } };
        const conflicted = await control.admit(traced, WS_ARRIVAL);

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
        const work = await readRetainedWork(admissionStore, workQueue);
        expect(work.map((entry) => entry.payload.kind).toSorted()).toEqual(['admit-control', 'send-control', 'send-control']);
        expect(work.flatMap((entry) => entry.payload.kind === 'send-control' ? [entry.payload.msg.id.traceId] : []))
            .toEqual([traced.id.traceId, traced.id.traceId]);
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
            traceId: 'trace-al-inbound-control-admission',
            namespace: 'inbound',
            ack: toAck('leaf', 'leaf'),
            controlOwners: TRACKED_CONTROL_OWNERS,
            owner: {
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                source: { kind: 'rtc-peer', peerId: message.id.senderId },
                supersedenceKey: null,
                deliveredLocally: true
            },
            pending: {
                toPeerId: message.id.senderId,
                status: 'subtree-complete',
                localReady: true,
                expectedFromPeerIds: ['lower-relay', 'leaf'],
                ackedFromPeerIds: ['lower-relay'],
                outsideAudiencePeerIds: [],
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
                traceId: 'trace-al-inbound-control-admission',
                namespace: 'inbound',
                ack,
                controlOwners: TRACKED_CONTROL_OWNERS,
                owner: {
                    msgId: message.id.msgId,
                    senderId: message.id.senderId,
                    source: { kind: 'rtc-peer', peerId: message.id.senderId },
                    supersedenceKey: null,
                    deliveredLocally: true
                },
                pending: {
                    toPeerId: message.id.senderId,
                    status: 'subtree-complete',
                    localReady: true,
                    expectedFromPeerIds: ['child-relay', 'leaf'],
                    ackedFromPeerIds: ['child-relay'],
                    outsideAudiencePeerIds: [],
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
            traceId: 'trace-al-inbound-control-admission',
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
                supersedenceKey: null,
                deliveredLocally: true
            },
            pending: {
                toPeerId: message.id.senderId,
                status: 'subtree-complete',
                localReady: true,
                expectedFromPeerIds: ['leaf'],
                ackedFromPeerIds: [],
                outsideAudiencePeerIds: [],
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
            traceId: 'trace-al-inbound-control-admission',
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
                source: { kind: 'ws-client', peerId: message.id.senderId, authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' } },
                supersedenceKey: null,
                deliveredLocally: true
            },
            pending: {
                toPeerId: message.id.senderId,
                status: 'subtree-complete',
                localReady: true,
                expectedFromPeerIds: ['receiver'],
                ackedFromPeerIds: [],
                outsideAudiencePeerIds: [],
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
            traceId: 'trace-al-inbound-control-admission',
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
                source: { kind: 'ws-client', peerId: message.id.senderId, authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' } },
                supersedenceKey: null,
                deliveredLocally: true
            },
            pending: {
                toPeerId: message.id.senderId,
                status: 'delivered',
                localReady: true,
                expectedFromPeerIds: ['receiver'],
                ackedFromPeerIds: ['stranger'],
                outsideAudiencePeerIds: [],
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
        outsideAudiencePeerIds: [],
        carrier: 'rtc'
    };
    let acks: readonly ALAckPayload[] = [];
    const upward: ALAckPayload[] = [];
    const completedAfter: boolean[] = [];
    for (const [index, ack] of arrivals.entries()) {
        const candidate = computeALInboundControlAdmission({
            traceId: 'trace-al-inbound-control-admission',
            namespace: 'inbound',
            ack: { ...ack, toPeerId: row.selfPeerId },
            controlOwners: TRACKED_CONTROL_OWNERS,
            owner: {
                msgId: message.id.msgId,
                senderId: message.id.senderId,
                source: { kind: 'rtc-peer', peerId: row.toPeerId },
                supersedenceKey: null,
                deliveredLocally: true
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

describe('a not-subscribed NACK at a relay (PL9)', () => {
    /** A receipted room message whose frozen audience names the child `receiver` and `below` it. */
    const FROZEN_ROW: Partial<ALPendingAckSnapshot> = { upwardAudiencePeerIds: ['receiver', 'below'] };
    const SEEDED = {
        controlOwners: TRACKED_CONTROL_OWNERS,
        source: { kind: 'rtc-peer', peerId: message.id.senderId } as const,
        row: FROZEN_ROW
    };

    function createNotSubscribedNack(logicalRecipientPeerId: string, reason: 'not-subscribed' | 'duplicate' = 'not-subscribed'): ALMessage {
        return newALNackControlMessage(
            { v: 4, msgId: `nack-${logicalRecipientPeerId}`, ts: 1, senderId: 'receiver', traceId: 'trace-not-subscribed' },
            {
                msgId: message.id.msgId,
                fromPeerId: 'receiver',
                toPeerId: 'self',
                logicalRecipientPeerId,
                reason,
                observedAtEpochMs: 1
            }
        );
    }

    async function readUpwardControls(admissionStore: ALInboundAdmissionStore, workQueue: QueueBoxResourceEntryRepository) {
        return (await readRetainedWork(admissionStore, workQueue, 'rtc')).flatMap((work) => {
            const control = work.payload.kind === 'send-control' ? parseALControlMessage(work.payload.msg) : undefined;
            return control === undefined || control.type === 'receipt' || control.type === 'repair' ? [] : [control];
        });
    }

    it('re-originates a child\'s NACK for a recipient below it to its parent from itself, naming the same recipient', async () => {
        const { backend, admissionStore, workQueue, control } = createFixture();
        await seedRelayRow(admissionStore, SEEDED);

        const result = await control.admit(createNotSubscribedNack('below'), WS_ARRIVAL);

        expect(result).toEqual({ kind: 'committed', acceptance: { handled: true, completedPendingAcks: [] } });
        expect(await readUpwardControls(admissionStore, workQueue)).toEqual([{
            type: 'nack',
            payload: expect.objectContaining({
                msgId: message.id.msgId,
                fromPeerId: 'self',
                toPeerId: 'upstream',
                logicalRecipientPeerId: 'below',
                reason: 'not-subscribed'
            })
        }]);
        expect((await readAcknowledgements(backend, admissionStore)).pendingAck).toMatchObject({
            ackedFromPeerIds: [],
            outsideAudiencePeerIds: ['below']
        });
    });

    function createChildAck(logicalRecipientPeerId: string, status: ALAckPayload['status']): ALMessage {
        return newALAckControlMessage(
            { v: 4, msgId: `ack-${logicalRecipientPeerId}-${status}`, ts: 1, senderId: 'receiver', traceId: 'trace-not-subscribed' },
            {
                ackedMsgId: message.id.msgId,
                originPeerId: message.id.senderId,
                logicalRecipientPeerId,
                fromPeerId: 'receiver',
                toPeerId: 'self',
                status,
                observedAtEpochMs: 1,
                carrier: 'rtc'
            }
        );
    }

    it('keeps the hop of a child that answers for itself open: only its hop-completion ACK ends it', async () => {
        const { backend, admissionStore, workQueue, control } = createFixture();
        await seedRelayRow(admissionStore, SEEDED);

        const nacked = await control.admit(createNotSubscribedNack('receiver'), WS_ARRIVAL);
        const rowAfterNack = (await readAcknowledgements(backend, admissionStore)).pendingAck;
        const completed = await control.admit(createChildAck('receiver', 'subtree-complete-not-subscribed'), WS_ARRIVAL);

        expect(nacked.kind === 'committed' && nacked.acceptance.completedPendingAcks).toEqual([]);
        expect(rowAfterNack).toMatchObject({ ackedFromPeerIds: [], outsideAudiencePeerIds: ['receiver'] });
        expect(completed.kind === 'committed' && completed.acceptance.completedPendingAcks).toHaveLength(1);
        expect((await readUpwardControls(admissionStore, workQueue)).map((upward) => [upward.type, upward.payload.fromPeerId]).toSorted())
            .toEqual([['ack', 'self'], ['nack', 'self']]);
    });

    it('reads a hop-completion ACK that arrives without its NACK as implying it, relaying that NACK and no confirmation', async () => {
        const { backend, admissionStore, workQueue, control } = createFixture();
        await seedRelayRow(admissionStore, SEEDED);

        expect((await control.admit(createChildAck('receiver', 'subtree-complete-not-subscribed'), WS_ARRIVAL)).kind).toBe('committed');

        expect((await readAcknowledgements(backend, admissionStore)).pendingAck).toMatchObject({
            ackedFromPeerIds: ['receiver'],
            outsideAudiencePeerIds: ['receiver']
        });
        const upward = await readUpwardControls(admissionStore, workQueue);
        expect(upward.map((control) => [control.type, control.payload.logicalRecipientPeerId]).toSorted())
            .toEqual([['ack', 'self'], ['nack', 'receiver']]);
    });

    it.each(
        [
            ['the NACK first', ['nack', 'ack']],
            ['the hop-completion ACK first', ['ack', 'nack']]
        ] as const
    )('relays one NACK for the recipient whichever arrives first: %s', async (_order, arrivals) => {
        const { admissionStore, workQueue, control } = createFixture();
        await seedRelayRow(admissionStore, SEEDED);

        for (const arrival of arrivals) {
            await control.admit(
                arrival === 'nack'
                    ? createNotSubscribedNack('receiver')
                    : createChildAck('receiver', 'subtree-complete-not-subscribed'),
                WS_ARRIVAL
            );
        }

        const upward = await readUpwardControls(admissionStore, workQueue);
        expect(upward.map((control) => [control.type, control.payload.logicalRecipientPeerId]).toSorted())
            .toEqual([['ack', 'self'], ['nack', 'receiver']]);
    });

    it('refuses a NACK for a recipient whose confirmation it already relayed', async () => {
        const { admissionStore, control } = createFixture();
        await seedRelayRow(admissionStore, SEEDED);
        await control.admit(createChildAck('below', 'forwarded'), WS_ARRIVAL);

        expect(await control.admit(createNotSubscribedNack('below'), WS_ARRIVAL)).toEqual({
            kind: 'rejected',
            reason: 'Inbound NACK names a recipient whose confirmation was already relayed'
        });
    });

    it.each<[string, Partial<ALPendingAckSnapshot>, string]>([
        ['a peer outside the frozen audience', FROZEN_ROW, 'stranger'],
        ['a recipient of a message no receipt counts recipients of', {}, 'below']
    ])('refuses a NACK naming %s, relaying nothing', async (_name, row, logicalRecipientPeerId) => {
        const { admissionStore, workQueue, control } = createFixture();
        await seedRelayRow(admissionStore, { ...SEEDED, row });

        expect(await control.admit(createNotSubscribedNack(logicalRecipientPeerId), WS_ARRIVAL)).toEqual({
            kind: 'rejected',
            reason: 'Inbound NACK names no recipient of the frozen audience'
        });
        expect(await readUpwardControls(admissionStore, workQueue)).toEqual([]);
    });

    it('relays each recipient once, and admits no ACK for a recipient it relayed a NACK for', async () => {
        const { admissionStore, workQueue, control } = createFixture();
        await seedRelayRow(admissionStore, SEEDED);
        await control.admit(createNotSubscribedNack('below'), WS_ARRIVAL);
        const forwarded = newALAckControlMessage(
            { v: 4, msgId: 'ack-below', ts: 1, senderId: 'receiver', traceId: 'trace-not-subscribed' },
            {
                ackedMsgId: message.id.msgId,
                originPeerId: message.id.senderId,
                logicalRecipientPeerId: 'below',
                fromPeerId: 'receiver',
                toPeerId: 'self',
                status: 'forwarded',
                observedAtEpochMs: 1,
                carrier: 'rtc'
            }
        );

        expect(await control.admit(createNotSubscribedNack('below'), WS_ARRIVAL)).toEqual({
            kind: 'rejected',
            reason: 'Inbound NACK names a recipient already relayed outside the audience'
        });
        expect(await control.admit(forwarded, WS_ARRIVAL)).toEqual({
            kind: 'rejected',
            reason: 'Inbound acknowledgement names a recipient that answered it is not subscribed'
        });
        expect(await readUpwardControls(admissionStore, workQueue)).toHaveLength(1);
    });

    it('leaves every NACK it does not relay to its outbound owner, as before', async () => {
        const { admissionStore, control } = createFixture();
        await seedRelayRow(admissionStore, SEEDED);

        expect(await control.admit(createNotSubscribedNack('receiver', 'duplicate'), WS_ARRIVAL)).toEqual({ kind: 'not-handled' });
    });

    it('re-originates a child\'s gap NACK to its parent with its ordering hints, leaving its row as it was (S4ii-R3)', async () => {
        const { backend, admissionStore, workQueue, control } = createFixture();
        await seedRelayRow(admissionStore, SEEDED);
        const rowBefore = (await readAcknowledgements(backend, admissionStore)).pendingAck;
        const ordering = { orderingKey: 'chat:sender:1', expectedSeq: 1, missingRanges: [{ from: 1, to: 1 }] };
        const gap = newALNackControlMessage(
            { v: 4, msgId: 'gap-below', ts: 1, senderId: 'receiver', traceId: 'trace-not-subscribed' },
            {
                msgId: message.id.msgId,
                fromPeerId: 'receiver',
                toPeerId: 'self',
                logicalRecipientPeerId: 'below',
                reason: 'gap',
                observedAtEpochMs: 1,
                ...ordering
            }
        );

        expect(await control.admit(gap, WS_ARRIVAL)).toEqual({ kind: 'committed', acceptance: { handled: true, completedPendingAcks: [] } });

        expect(await readUpwardControls(admissionStore, workQueue)).toEqual([{
            type: 'nack',
            payload: expect.objectContaining({ fromPeerId: 'self', toPeerId: 'upstream', logicalRecipientPeerId: 'below', reason: 'gap', ...ordering })
        }]);
        expect((await readAcknowledgements(backend, admissionStore)).pendingAck).toEqual(rowBefore);
    });

    /** Admits a NACK with the evidence a capturing sink installs, and returns the association it publishes. */
    async function admitWithEvidence(control: ALInboundControlAdmission, nack: ALMessage) {
        const events: ALInboundRuntimeDiagnosticsEvent[] = [];
        const evidence = ALInboundAcknowledgementEvidence.tryCreate({
            msg: nack,
            carrier: 'ws',
            sink: (event) => events.push(event),
            workerId: 'relay-worker'
        });
        evidence?.beginAttempt('durable');
        const result = await control.admit(nack, WS_ARRIVAL, evidence);
        evidence?.admissionResult(result.kind);
        evidence?.publishAssociation('ingress', 'control');
        return { result, association: events.find((event) => event.kind === 'acknowledgement-association') };
    }

    it.each(
        [
            {
                name: 'commits',
                row: FROZEN_ROW,
                conflicts: false,
                attempt: { validated: true, commit: 'committed', retention: 'not-called', result: 'committed' }
            },
            {
                name: 'refuses',
                row: {},
                conflicts: false,
                attempt: { validated: false, commit: 'not-called', retention: 'not-called', result: 'rejected' }
            },
            {
                name: 'conflicts on',
                row: FROZEN_ROW,
                conflicts: true,
                attempt: { validated: true, commit: 'conflict', retention: 'returned', result: 'pending-control' }
            }
        ] as const
    )('records a NACK\'s candidate and commit as an ACK\'s when it $name it', async ({ row, conflicts, attempt }) => {
        const { backend, admissionStore, control } = createFixture();
        await seedRelayRow(admissionStore, { ...SEEDED, row });
        if (conflicts) {
            vi.spyOn(backend, 'write').mockImplementationOnce(() => {
                throw new ALAdmissionBackendConflictError('simulated inbound NACK conflict');
            });
        }

        const { result, association } = await admitWithEvidence(control, createNotSubscribedNack('below'));

        expect(result.kind).toBe(attempt.result);
        expect(association).toMatchObject({
            incoming: {
                control: 'nack',
                controlMsgId: 'nack-below',
                subjectMsgId: message.id.msgId,
                logicalRecipientPeerId: 'below',
                fromPeerId: 'receiver',
                toPeerId: 'self',
                carrier: 'ws',
                traceId: 'trace-not-subscribed'
            },
            attempts: [{
                lane: 'durable',
                candidate: { ownerPeerId: message.id.senderId, parentPeerId: 'upstream', validated: attempt.validated },
                commit: attempt.commit,
                retention: attempt.retention,
                result: attempt.result
            }]
        });
    });

    it('names the NACK it relays upward among the candidate\'s generated controls', async () => {
        const { admissionStore, control } = createFixture();
        await seedRelayRow(admissionStore, SEEDED);

        const { association } = await admitWithEvidence(control, createNotSubscribedNack('below'));

        expect(association).toMatchObject({
            attempts: [{
                candidate: {
                    generated: [{
                        control: 'nack',
                        controlMsgId: 'generated-control:0',
                        subjectMsgId: message.id.msgId,
                        logicalRecipientPeerId: 'below',
                        fromPeerId: 'self',
                        toPeerId: 'upstream',
                        carrier: 'rtc'
                    }]
                }
            }]
        });
    });
});
