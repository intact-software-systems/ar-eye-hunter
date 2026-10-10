import { Temporal } from '@js-temporal/polyfill';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createBlackBoxRallarCongestionCounters } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-congestion-counters.ts';
import {
    BlackBoxRallarRuntimeDiagnostics,
    createBlackBoxRallarDiagnosticsPorts
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts';
import type { BlackBoxRallarEvent } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { createBlackBoxRallarOrderingTracks } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-ordering-tracks.ts';
import { toRallarBlackBoxRuntimeDiagnostic } from '@shared-test/rallar-bb-test/diagnostics.ts';
import { decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent, ALInboundRuntimeDiagnosticsSink } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { decodeALInboundWorkEntry, toALInboundWorkType } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { ALInboundAcknowledgementEvidence } from '@shared/alm/inbound/control/al-inbound-acknowledgement-evidence.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { ALWorkBatchObservations } from '@shared/alm/work/al-work-batch-observations.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { createScriptedStorageFaultPort } from '@shared/persistence/storage-fault-port.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { createScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';

import { readInboundTestAcknowledgements } from '../read-inbound-test-acknowledgements.ts';

afterEach(() => vi.restoreAllMocks());

namespace AcknowledgementFixture {
    export interface Input {
        readonly diagnostics?: ALInboundRuntimeDiagnosticsSink;
        readonly onControlMessage?: ALInboundMessageRuntime.Dependencies['onControlMessage'];
        readonly nowMs?: () => number;
    }
}

/** Real admission, work repository and runtime; only transport and captured publication are external ports. */
class AcknowledgementFixture {
    readonly events: BlackBoxRallarEvent[] = [];
    readonly sent: ALMessage[] = [];
    private nowMs = Date.now;
    readonly state = createInMemoryALAdmissionState(new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(this.nowMs())));
    readonly backend = new InMemoryAdmissionBackend(this.state, () => this.nowMs());
    readonly store = createALInboundAdmissionStore({
        namespace: 'ack-association',
        backend: this.backend,
        nowMs: () => this.nowMs(),
        retention: normalizeALRuntimeStoreRetention(),
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        maxOrderingTracks: undefined
    });
    readonly engine = new InboxOutboxEngine();
    readonly message: ALMessage = {
        id: { v: 3, msgId: 'subject', senderId: 'origin', ts: 1 },
        route: { topicId: 'chat', resourceId: 'resource', contextId: 'room' },
        payload: { typeId: 'chat', resource: '{"private":"payload"}' }
    };
    readonly source: ALInboundMessageRuntime.Source = { kind: 'rtc-peer', peerId: 'parent' };
    readonly diagnostics = createBlackBoxRallarDiagnosticsPorts(
        new BlackBoxRallarRuntimeDiagnostics({
            now: () => 100,
            publish: (event) => {
                this.events.push(event);
            },
            onPublishError: (error) => {
                throw error;
            },
            transportOf: () => 'realtime',
            laneIdOf: () => 'lane',
            scopeDiagnostics: () => ({})
        }),
        {
            faults: createScriptedTransportFaultPort(),
            storage: createCountingIndexedDbOperationObserver(),
            storageFaults: createScriptedStorageFaultPort(),
            congestion: createBlackBoxRallarCongestionCounters(),
            orderingTracks: createBlackBoxRallarOrderingTracks()
        }
    ).inboundDiagnostics;
    readonly sendGate = Promise.withResolvers<void>();
    readonly runtime: ALInboundMessageRuntime;
    private controlSequence = 0;
    sendFailure: Error | undefined;

    constructor(input: AcknowledgementFixture.Input = {}) {
        this.nowMs = input.nowMs ?? Date.now;
        this.runtime = new ALInboundMessageRuntime({
            ...createDefaultALInboundRuntimeResources({
                selfPeerId: 'relay',
                stores: { admissionStore: this.store, workQueue: this.state.workQueue },
                queueEngine: this.engine,
                nowMs: input.nowMs,
                newControlId: () => `generated-${++this.controlSequence}`,
                toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox')
            }),
            carrier: 'rtc',
            effectWorkerId: 'relay-worker',
            diagnostics: input.diagnostics ?? this.diagnostics,
            onControlMessage: input.onControlMessage,
            planIncomingMessage: (msg, _source, observations) => planALMessageHandling(msg, { ...observations, selfPeerId: 'relay' }),
            dispatchInboxEntry: async () => {},
            sendControlMessages: async (messages) => {
                this.sent.push(...messages);
                await this.sendGate.promise;
                if (this.sendFailure) {
                    throw this.sendFailure;
                }
            }
        });
        onTestFinished(() => {
            this.sendGate.resolve();
            this.runtime.dispose();
        });
    }

    acknowledgement(originPeerId = 'origin', logicalRecipientPeerId = 'leaf'): ALMessage {
        return newALAckControlMessage({ v: 3, msgId: 'incoming-control', senderId: 'child', ts: 1 }, {
            ackedMsgId: 'subject',
            originPeerId,
            logicalRecipientPeerId,
            fromPeerId: 'child',
            toPeerId: 'relay',
            status: 'subtree-complete',
            carrier: 'ws',
            observedAtEpochMs: 2
        });
    }

    async seed(): Promise<void> {
        const nowMs = this.nowMs();
        const expireAtTimestamp = nowMs + 60_000;
        const read = await this.store.readIncomingMessage({
            msg: this.message,
            source: this.source,
            nowMs,
            prePlan: planALMessageHandling(this.message, { selfPeerId: 'relay', nowMs })
        });
        expect(
            await this.store.commitBundle({
                senderId: 'origin',
                admissionExpiresAtMs: null,
                observations: read.observations,
                mutations: [
                    { kind: 'set-msg-owner', value: { msgId: 'subject', senderId: 'origin', source: this.source, supersedenceKey: null }, expireAtTimestamp },
                    {
                        kind: 'set-control-owners',
                        msgId: 'subject',
                        value: { ambiguous: false, values: [{ peerId: 'child', senderId: 'origin' }] },
                        expireAtTimestamp
                    },
                    {
                        kind: 'set-control-pending',
                        msgId: 'subject',
                        senderId: 'origin',
                        expireAtTimestamp,
                        value: {
                            kind: 'pending',
                            value: {
                                toPeerId: 'parent',
                                status: 'subtree-complete',
                                localReady: true,
                                expectedFromPeerIds: ['child'],
                                ackedFromPeerIds: [],
                                expireAtTimestamp,
                                carrier: 'rtc'
                            }
                        }
                    }
                ],
                durableEffects: []
            })
        ).toBe('committed');
        await this.runtime.ready();
    }

    resolveAssociation(phase: 'ingress' | 'replay' = 'ingress'): BlackBoxRallarEvent | undefined {
        return this.events.find((event) => {
            const data = decodeRecord(event.data);
            return data.kind === 'acknowledgement-association' && data.phase === phase;
        });
    }

    get handoffs(): readonly BlackBoxRallarEvent[] {
        return this.events.filter((event) => decodeRecord(event.data).kind === 'acknowledgement-handoff');
    }

    async readStoredControls(): Promise<readonly ALMessage[]> {
        const controls: ALMessage[] = [];
        for (const status of [EntityStatus.NEW, EntityStatus.RESERVED, EntityStatus.RETRY]) {
            const page = await this.state.workQueue.readWorkPage({
                typeId: toALInboundWorkType(this.store.namespace, 'rtc'),
                status,
                maxToRead: 10,
                cursor: null
            });
            for (const entry of page.entries) {
                const effect = decodeALInboundWorkEntry(entry, this.store.namespace).payload;
                if (effect.kind === 'send-control') {
                    controls.push(effect.msg);
                }
            }
        }
        return controls;
    }
}

namespace AcknowledgementCaptureScenario {
    export type Mode = 'disabled' | 'constructor-fails' | 'snapshot-fails' | 'claim-snapshot-fails' | 'batch-fails' | 'sink-throws';
    export interface Result {
        readonly acceptance: ALInboundMessageRuntime.Acceptance | undefined;
        readonly sent: readonly string[];
        readonly clocks: readonly number[];
        readonly released: readonly string[];
    }
}

/** Runs real work with one optional observation failure and records independent mandatory boundaries. */
class AcknowledgementCaptureScenario {
    private readonly clockReads: number[] = [];
    private readonly released: string[] = [];
    private readonly acknowledgementKinds: string[] = [];
    private readonly drained = Promise.withResolvers<void>();
    private readonly fixture: AcknowledgementFixture;
    private readonly mode: AcknowledgementCaptureScenario.Mode;

    constructor(mode: AcknowledgementCaptureScenario.Mode, clockEpoch: number) {
        this.mode = mode;
        const sink: ALInboundRuntimeDiagnosticsSink = this.observe;
        if (mode !== 'disabled') {
            Object.assign(sink, {
                acknowledgementCapture: {
                    evidence: mode === 'constructor-fails' ? FailingAcknowledgementEvidence : ALInboundAcknowledgementEvidence,
                    batchObservations: mode === 'batch-fails' ? FailingBatchObservations : ALWorkBatchObservations
                }
            });
        }
        this.fixture = new AcknowledgementFixture({
            diagnostics: sink,
            nowMs: () => {
                const now = clockEpoch + this.clockReads.length;
                this.clockReads.push(now);
                return now;
            }
        });
    }

    async run(): Promise<AcknowledgementCaptureScenario.Result> {
        await this.fixture.seed();
        const release = this.fixture.state.workQueue.releaseEntries.bind(this.fixture.state.workQueue);
        vi.spyOn(this.fixture.state.workQueue, 'releaseEntries').mockImplementation(async (entries) => {
            for (const entry of entries) {
                this.released.push(entry.disposition.status);
            }
            return await release(entries);
        });
        if (this.mode === 'snapshot-fails' || this.mode === 'claim-snapshot-fails') {
            const freeze = Object.freeze;
            vi.spyOn(Object, 'freeze').mockImplementation((value) => {
                if (
                    value && typeof value === 'object' &&
                    (this.mode === 'snapshot-fails' ? 'ownerPeerId' in value : 'claimAttempt' in value)
                ) {
                    throw new Error('optional snapshot');
                }
                return freeze(value);
            });
        }
        const construction = vi.spyOn(ALInboundAcknowledgementEvidence, 'tryCreate');
        const claimConstruction = vi.spyOn(ALInboundAcknowledgementEvidence, 'tryCreateClaim');
        const acceptance = await this.fixture.runtime.admitIncomingMessage(this.fixture.acknowledgement(), { kind: 'trusted-server' });
        this.fixture.sendGate.resolve();
        await this.drained.promise;
        if (this.mode === 'disabled') {
            expect(construction).not.toHaveBeenCalled();
            expect(claimConstruction).not.toHaveBeenCalled();
        }
        if (this.mode === 'disabled' || this.mode === 'constructor-fails') {
            expect(this.acknowledgementKinds).toEqual([]);
        }
        if (this.mode === 'batch-fails' || this.mode === 'claim-snapshot-fails') {
            expect(this.acknowledgementKinds).toEqual(['acknowledgement-association']);
        }
        const stored = await readInboundTestAcknowledgements({
            backend: this.fixture.backend,
            namespace: this.fixture.store.namespace,
            msgId: 'subject',
            senderId: 'origin'
        });
        expect(stored.acks).toHaveLength(1);
        this.fixture.runtime.dispose();
        vi.restoreAllMocks();
        return { acceptance: acceptance.right, sent: this.fixture.sent.map((msg) => msg.id.msgId), clocks: this.clockReads, released: this.released };
    }

    private readonly observe: ALInboundRuntimeDiagnosticsSink = (event) => {
        if (event.kind === 'acknowledgement-association' || event.kind === 'acknowledgement-handoff') {
            this.acknowledgementKinds.push(event.kind);
        }
        if (event.kind === 'effect-drain') {
            this.drained.resolve();
        }
        if (this.mode === 'sink-throws') {
            throw new Error('optional sink');
        }
    };
}

/** Exercises a mandatory post-handoff clock failure through the real handler and retry repository. */
class AcknowledgementClaimClockScenario {
    readonly events: ALInboundRuntimeDiagnosticsEvent[] = [];
    readonly trace: string[] = [];
    readonly released: string[] = [];
    readonly original = new Error('mandatory claim duration clock');
    readonly fixture: AcknowledgementFixture;
    private failNextClock = false;
    private reads = 0;

    constructor(capturing: boolean, clockEpoch: number) {
        const diagnostics: ALInboundRuntimeDiagnosticsSink = (event) => this.events.push(event);
        if (capturing) {
            Object.assign(diagnostics, {
                acknowledgementCapture: { evidence: ALInboundAcknowledgementEvidence, batchObservations: ALWorkBatchObservations }
            });
        }
        this.fixture = new AcknowledgementFixture({
            diagnostics,
            nowMs: () => {
                const next = ++this.reads;
                if (this.failNextClock) {
                    this.failNextClock = false;
                    this.trace.push(`throw-${next}`);
                    throw this.original;
                }
                this.trace.push(`read-${next}`);
                return clockEpoch + next;
            }
        });
    }

    async run(): Promise<void> {
        await this.fixture.seed();
        const release = this.fixture.state.workQueue.releaseEntries.bind(this.fixture.state.workQueue);
        vi.spyOn(this.fixture.state.workQueue, 'releaseEntries').mockImplementation(async (entries) => {
            const released = await release(entries);
            this.released.push(...entries.map((entry) => entry.disposition.status));
            return released;
        });
        await this.fixture.runtime.admitIncomingMessage(this.fixture.acknowledgement(), { kind: 'trusted-server' });
        await expect.poll(() => this.fixture.sent.length).toBe(1);
        this.trace.push('send-unblocked');
        this.failNextClock = true;
        this.fixture.sendGate.resolve();
        await expect.poll(() => this.events.some((event) => event.kind === 'effect-drain')).toBe(true);
        const retained = await readInboundTestAcknowledgements({
            backend: this.fixture.backend,
            namespace: this.fixture.store.namespace,
            msgId: 'subject',
            senderId: 'origin'
        });
        expect(retained.acks).toHaveLength(1);
        const page = await this.fixture.state.workQueue.readWorkPage({
            typeId: toALInboundWorkType(this.fixture.store.namespace, 'rtc'),
            status: EntityStatus.RETRY,
            maxToRead: 10,
            cursor: null
        });
        expect(page.entries).toHaveLength(1);
        expect(decodeALInboundWorkEntry(page.entries[0]!, this.fixture.store.namespace).payload)
            .toMatchObject({ kind: 'send-control', msg: { id: { msgId: 'generated-1:0' } } });
        expect(this.fixture.sent.map((msg) => msg.id.msgId)).toEqual(['generated-1:0']);
    }
}

class FailingAcknowledgementEvidence extends ALInboundAcknowledgementEvidence {
    constructor(identity: ALInboundAcknowledgementEvidence.Identity, sink: ALInboundRuntimeDiagnosticsSink, workerId: string) {
        super(identity, sink, workerId);
        throw new Error('optional evidence constructor');
    }
}

class FailingBatchObservations extends ALWorkBatchObservations {
    constructor() {
        super();
        throw new Error('optional batch constructor');
    }
}

it('associates the exact received ACK with independently stored regenerated controls and their real handoff', async () => {
    const fixture = new AcknowledgementFixture();
    await fixture.seed();
    const result = await fixture.runtime.admitIncomingMessage(fixture.acknowledgement(), { kind: 'trusted-server' });
    expect(result.right).toEqual({ kind: 'control', handled: true });
    const retained = await readInboundTestAcknowledgements({
        backend: fixture.backend,
        namespace: fixture.store.namespace,
        msgId: 'subject',
        senderId: 'origin'
    });
    expect(retained.acks).toMatchObject([{ fromPeerId: 'child', logicalRecipientPeerId: 'leaf', carrier: 'ws' }]);
    const controls = await fixture.readStoredControls();
    expect(controls.map((msg) => msg.id.msgId).sort()).toEqual(['generated-1:0']);
    expect(controls.map(parseALControlMessage)).toEqual(expect.arrayContaining([
        expect.objectContaining({ payload: expect.objectContaining({ logicalRecipientPeerId: 'leaf', toPeerId: 'parent', carrier: 'rtc' }) })
    ]));
    const association = fixture.resolveAssociation();
    const captured = toRallarBlackBoxRuntimeDiagnostic({
        topic: 'rallar.browser.alm.inbound_diagnostics',
        severity: 'info',
        source: 'browser-rallar',
        payload: association
    });
    expect(JSON.parse(JSON.stringify(captured)).data).toEqual(association?.data);
    expect(association?.data).toMatchObject({
        incoming: { controlMsgId: 'incoming-control', subjectMsgId: 'subject', originPeerId: 'origin', logicalRecipientPeerId: 'leaf', carrier: 'ws' },
        attempts: [{
            candidate: {
                ownerPeerId: 'origin',
                parentPeerId: 'parent',
                generated: [
                    { controlMsgId: 'generated-1:0', logicalRecipientPeerId: 'leaf', carrier: 'rtc' }
                ]
            },
            commit: 'committed'
        }],
        result: 'control'
    });
    expect(fixture.handoffs).toEqual([]);
    fixture.sendGate.resolve();
    await expect.poll(() => fixture.handoffs.length).toBe(1);
    expect(fixture.sent.map((msg) => msg.id.msgId).sort()).toEqual(['generated-1:0']);
});

it('separates a conflicted candidate from replay IDs and retained work', async () => {
    const fixture = new AcknowledgementFixture();
    await fixture.seed();
    const write = fixture.backend.write.bind(fixture.backend);
    vi.spyOn(fixture.backend, 'write').mockImplementationOnce(async () => {
        throw new ALAdmissionBackendConflictError('test conflict');
    });
    // Hold the real retained admission row before the commit wake can claim it.
    const claim = fixture.state.workQueue.reserveEntries.bind(fixture.state.workQueue);
    const held = Promise.withResolvers<void>();
    onTestFinished(() => held.resolve());
    vi.spyOn(fixture.state.workQueue, 'reserveEntries').mockImplementation(async (...args) => {
        await held.promise;
        return await claim(...args);
    });
    expect((await fixture.runtime.admitIncomingMessage(fixture.acknowledgement(), { kind: 'rtc-peer', peerId: 'child' })).right)
        .toEqual({ kind: 'pending-admission' });
    expect(await fixture.readStoredControls()).toEqual([]);
    const stored = await readInboundTestAcknowledgements({
        backend: fixture.backend,
        namespace: fixture.store.namespace,
        msgId: 'subject',
        senderId: 'origin'
    });
    expect(stored.acks).toEqual([]);
    expect(fixture.resolveAssociation()?.data).toMatchObject({
        phase: 'ingress',
        result: 'pending-admission',
        attempts: [{ commit: 'conflict', retention: 'returned', candidate: { generated: [{ controlMsgId: 'generated-1:0' }] } }]
    });
    vi.spyOn(fixture.backend, 'write').mockImplementation(write);
    held.resolve();
    fixture.sendGate.resolve();
    fixture.engine.start();
    onTestFinished(() => fixture.engine.stop());
    await expect.poll(() => fixture.sent.length).toBe(1);
    expect(fixture.sent[0]?.id.msgId).toBe('generated-2:0');
    await expect.poll(() => fixture.resolveAssociation('replay')?.data)
        .toMatchObject({
            result: 'completed',
            attempts: [{ commit: 'committed', result: 'committed', candidate: { generated: [{ controlMsgId: 'generated-2:0' }] } }]
        });
});

it('reports terminal origin bypass without a candidate, read, commit or generated work', async () => {
    const received: string[] = [];
    const fixture = new AcknowledgementFixture({
        onControlMessage: async (msg) => {
            received.push(msg.id.msgId);
        }
    });
    await fixture.runtime.ready();
    const read = vi.spyOn(fixture.store, 'readControlDecisionSurface');
    const commit = vi.spyOn(fixture.store, 'commitBundle');
    expect((await fixture.runtime.admitIncomingMessage(fixture.acknowledgement('relay'), { kind: 'trusted-server' })).right)
        .toEqual({ kind: 'control', handled: false });
    expect(received).toEqual(['incoming-control']);
    expect(read).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(await fixture.state.workQueue.getAllKeys()).toEqual([]);
    expect(fixture.resolveAssociation()?.data).toMatchObject({
        terminalOrigin: true,
        attempts: [],
        result: 'control'
    });
});

it('keeps committed facts immutable and preserves the original callback exception', async () => {
    const original = new Error('private original failure');
    const fixture = new AcknowledgementFixture({
        onControlMessage: async () => {
            throw original;
        }
    });
    await fixture.seed();
    await expect(fixture.runtime.admitIncomingMessage(fixture.acknowledgement(), { kind: 'trusted-server' })).rejects.toBe(original);
    const event = fixture.resolveAssociation();
    expect(event?.data).toMatchObject({ result: 'threw', attempts: [{ commit: 'committed' }] });
    expect(JSON.stringify(event)).not.toContain(original.message);
    const association = event?.data;
    expect(Object.isFrozen(decodeRecord(association).incoming)).toBe(true);
    expect(Object.isFrozen(decodeRecord(association).attempts)).toBe(true);
    expect(await fixture.readStoredControls()).toHaveLength(1);
    const stored = await readInboundTestAcknowledgements({
        backend: fixture.backend,
        namespace: fixture.store.namespace,
        msgId: 'subject',
        senderId: 'origin'
    });
    expect(stored.acks).toHaveLength(1);
});

it('publishes a failed handoff only after the real retry release and retains the original generated ID', async () => {
    const fixture = new AcknowledgementFixture();
    await fixture.seed();
    fixture.sendFailure = new Error('transport rejected');
    await fixture.runtime.admitIncomingMessage(fixture.acknowledgement(), { kind: 'trusted-server' });
    fixture.sendGate.resolve();
    await expect.poll(() => fixture.handoffs[0]?.data)
        .toMatchObject({ control: { controlMsgId: 'generated-1:0' }, handoff: 'fallback-pending', result: 'threw' });
    const page = await fixture.state.workQueue.readWorkPage({
        typeId: toALInboundWorkType(fixture.store.namespace, 'rtc'),
        status: EntityStatus.RETRY,
        maxToRead: 10,
        cursor: null
    });
    expect(page.entries).toHaveLength(1);
    const effect = decodeALInboundWorkEntry(page.entries[0]!, fixture.store.namespace);
    expect(effect.payload).toMatchObject({ kind: 'send-control', msg: { id: { msgId: 'generated-1:0' } } });
    expect(fixture.sent.map((msg) => msg.id.msgId)).toEqual(['generated-1:0', 'generated-1:0']);
});

it.each(['disabled', 'constructor-fails', 'snapshot-fails', 'claim-snapshot-fails', 'batch-fails', 'sink-throws'] as const)(
    'preserves real commit, work, release and mandatory clocks when capture is %s',
    async (mode) => {
        const clockEpoch = Date.now();
        const baseline = await new AcknowledgementCaptureScenario('disabled', clockEpoch).run();
        const actual = await new AcknowledgementCaptureScenario(mode, clockEpoch).run();
        expect(actual).toEqual(baseline);
        expect(actual).toMatchObject({ acceptance: { kind: 'control', handled: true }, sent: ['generated-1:0'] });
    }
);

it('withholds handoff publication while the real claim release is still pending', async () => {
    const fixture = new AcknowledgementFixture();
    await fixture.seed();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    onTestFinished(() => finish.resolve());
    const release = fixture.state.workQueue.releaseEntries.bind(fixture.state.workQueue);
    vi.spyOn(fixture.state.workQueue, 'releaseEntries').mockImplementation(async (entries) => {
        entered.resolve();
        await finish.promise;
        return await release(entries);
    });
    await fixture.runtime.admitIncomingMessage(fixture.acknowledgement(), { kind: 'trusted-server' });
    fixture.sendGate.resolve();
    await entered.promise;
    expect(fixture.handoffs).toEqual([]);
    expect(await fixture.readStoredControls()).toHaveLength(1);
    finish.resolve();
    await expect.poll(() => fixture.handoffs[0]?.data)
        .toMatchObject({ result: 'completed', handoff: 'batch-returned' });
    expect(await fixture.readStoredControls()).toEqual([]);
});

it.each(['commit', 'retention'] as const)('retains the original %s exception and reports no invented write result', async (boundary) => {
    const fixture = new AcknowledgementFixture();
    await fixture.seed();
    const original = new Error('original write failure');
    if (boundary === 'commit') {
        vi.spyOn(fixture.backend, 'write').mockRejectedValueOnce(original);
    }
    else {
        vi.spyOn(fixture.backend, 'write').mockRejectedValueOnce(new ALAdmissionBackendConflictError('conditional conflict'));
        vi.spyOn(fixture.state.workQueue, 'enqueueIfAbsent').mockRejectedValueOnce(original);
    }
    await expect(fixture.runtime.admitIncomingMessage(fixture.acknowledgement(), { kind: 'trusted-server' })).rejects.toBe(original);
    expect(fixture.resolveAssociation()?.data).toMatchObject({
        result: 'threw',
        attempts: [{ result: 'threw', commit: boundary === 'commit' ? 'pending' : 'conflict', retention: boundary === 'retention' ? 'pending' : 'not-called' }]
    });
    expect(await fixture.readStoredControls()).toEqual([]);
    const stored = await readInboundTestAcknowledgements({
        backend: fixture.backend,
        namespace: fixture.store.namespace,
        msgId: 'subject',
        senderId: 'origin'
    });
    expect(stored.acks).toEqual([]);
    expect(fixture.sent).toEqual([]);
});

it('preserves the original business exception even when every diagnostic sink invocation throws', async () => {
    const original = new Error('business callback failure');
    const diagnostics: ALInboundRuntimeDiagnosticsSink = Object.assign(() => {
        throw new Error('optional diagnostic failure');
    }, {
        acknowledgementCapture: { evidence: ALInboundAcknowledgementEvidence, batchObservations: ALWorkBatchObservations }
    });
    const fixture = new AcknowledgementFixture({
        diagnostics,
        onControlMessage: async () => {
            throw original;
        }
    });
    await fixture.seed();
    await expect(fixture.runtime.admitIncomingMessage(fixture.acknowledgement(), { kind: 'trusted-server' })).rejects.toBe(original);
    expect(await fixture.readStoredControls()).toHaveLength(1);
    const stored = await readInboundTestAcknowledgements({
        backend: fixture.backend,
        namespace: fixture.store.namespace,
        msgId: 'subject',
        senderId: 'origin'
    });
    expect(stored.acks).toHaveLength(1);
});

it('preserves the returned handoff and actual retry when the mandatory claim duration clock throws', async () => {
    const clockEpoch = Date.now();
    const baseline = new AcknowledgementClaimClockScenario(false, clockEpoch);
    await baseline.run();
    const capturing = new AcknowledgementClaimClockScenario(true, clockEpoch);
    await capturing.run();
    expect(capturing.trace).toEqual(baseline.trace);
    const afterSend = capturing.trace.slice(capturing.trace.indexOf('send-unblocked') + 1);
    expect(afterSend[0]).toMatch(/^throw-/);
    expect(afterSend.slice(1).every((entry) => entry.startsWith('read-'))).toBe(true);
    expect(capturing.released).toEqual(baseline.released);
    expect(capturing.released).toEqual([EntityStatus.RETRY]);
    expect(capturing.events.find((event) => event.kind === 'acknowledgement-handoff'))
        .toMatchObject({ handoff: 'batch-returned', result: 'threw', control: { controlMsgId: 'generated-1:0' } });
});
