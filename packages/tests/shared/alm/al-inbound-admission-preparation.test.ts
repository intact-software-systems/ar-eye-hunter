import { Temporal } from '@js-temporal/polyfill';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodeALMessageValue, decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import {
    planALMessageHandling,
    type ALMessageHandlingPlan,
    type ALMessagePlanningObservations
} from '@shared/al-contracts/al-policy.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type {
    ALInboundAdmissionRead,
    ALInboundAdmissionStore,
    ALInboundCommitBundle
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { computeALInboundAdmission, computeALInboundBufferedRelease } from '@shared/alm/inbound/compute-al-inbound-admission.ts';
import {
    readALInboundEffectFacts,
    type ALInboundEffectFacts,
    type ALInboundEffectPreparationDependencies
} from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import { validateALInboundCommitBundle } from '@shared/alm/inbound/validate-al-inbound-commit-bundle.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('inbound admission preparation boundary', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each(['msgId', 'senderId', 'dedup', 'ordering'] as const)('rejects a candidate with original observations from another %s scope', async (scope) => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const prepared = await readAdmission({ store: stores.admissionStore, message: createMessage(1) });
        const bundle = computeALInboundAdmission({ ...prepared, canForward: false });
        const observations = {
            ...bundle.observations,
            ...(scope === 'msgId' ? { msgId: 'other-message' } : {}),
            ...(scope === 'senderId' ? { senderId: 'other-sender' } : {}),
            ...(scope === 'dedup' ? { dedup: undefined } : {}),
            ...(scope === 'ordering' ? { ordering: undefined } : {})
        };

        await expect(stores.admissionStore.commitBundle({ ...bundle, observations })).rejects.toThrow(TypeError);

        expect(await stores.admissionStore.commitBundle(bundle)).toBe('committed');
    });

    it('computes one repeatable final bundle from captured read, policy, and effect facts', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const prepared = await readAdmission({ store: stores.admissionStore, message: createMessage(1) });
        vi.spyOn(Date, 'now').mockReturnValue(100);
        vi.spyOn(Temporal.Now, 'plainDateTimeISO').mockImplementation(() => {
            throw new Error('Admission computation must not read the clock');
        });

        const first = computeALInboundAdmission({ ...prepared, canForward: false });
        vi.spyOn(Date, 'now').mockReturnValue(200);
        const second = computeALInboundAdmission({ ...prepared, canForward: false });

        expect(second).toEqual(first);
        expect(first.durableEffects.map((effect) => effect.payload.kind)).toEqual([
            'dispatch-local',
            'send-control',
            'send-control'
        ]);
        expect(first.durableEffects.every((effect) => Number.isSafeInteger(effect.expireAtTimestamp))).toBe(true);
        expect(first.observations).toEqual(prepared.read.observations);
        expect(first.mutations.find((mutation) => mutation.kind === 'set-msg-owner')?.value).toEqual({
            msgId: prepared.read.msg.id.msgId,
            senderId: 'sender',
            source: { kind: 'ws-client', peerId: 'sender' },
            supersedenceKey: null
        });
    });

    it('computes a repeatable final buffered-release bundle from captured values', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const message = createMessage(1);
        const prepared = await readAdmission({ store: stores.admissionStore, message });
        const read = {
            kind: 'buffered-release' as const,
            orderingTrackTtlMs: prepared.read.orderingTrackTtlMs,
            namespace: prepared.read.namespace,
            nowMs: prepared.read.nowMs,
            source: prepared.read.source,
            observations: prepared.read.observations,
            snapshot: { trackKey: 'sender:chat', seq: 1, msg: message, plan: prepared.plan },
            supersedence: {},
            supersedenceTrackTtlMs: prepared.read.supersedenceTrackTtlMs,
            pendingAck: prepared.read.pendingAck,
            acks: prepared.read.acks,
            controlOwners: prepared.read.controlOwners,
            retention: prepared.read.retention
        };
        vi.spyOn(Date, 'now').mockReturnValue(100);
        vi.spyOn(Temporal.Now, 'plainDateTimeISO').mockImplementation(() => {
            throw new Error('Buffered computation must not read the clock');
        });

        const first = computeALInboundBufferedRelease({ read, plan: prepared.plan, facts: prepared.facts });
        vi.spyOn(Date, 'now').mockReturnValue(200);
        const second = computeALInboundBufferedRelease({ read, plan: prepared.plan, facts: prepared.facts });

        expect(second).toEqual(first);
        expect(first.durableEffects.every((effect) => Number.isSafeInteger(effect.expireAtTimestamp))).toBe(true);
    });

    it.each(
        [
            { algo: 'fresh-until', callerTtlMs: undefined },
            { algo: 'fresh-until', callerTtlMs: 500 },
            { algo: 'fresh-until', callerTtlMs: 2_000 },
            { algo: 'expires-at', callerTtlMs: undefined },
            { algo: 'expires-at', callerTtlMs: 500 },
            { algo: 'expires-at', callerTtlMs: 2_000 }
        ] as const
    )('carries the admitted $algo deadline into every message when caller TTL is $callerTtlMs', async ({ algo, callerTtlMs }) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const admittedAtMs = 1_800_000_000_000;
        vi.setSystemTime(admittedAtMs);
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const message: ALMessage = Object.freeze({
            ...createMessage(1),
            constraints: Object.freeze({
                ttlHops: 5,
                ...(callerTtlMs === undefined ? {} : { expiresAtMs: admittedAtMs + callerTtlMs })
            })
        });
        const original = JSON.stringify(message);
        const prepared = await readAdmission({ store: stores.admissionStore, message });
        const plan: ALMessageHandlingPlan = {
            ...prepared.plan,
            effective: {
                ...prepared.plan.effective,
                expiry: {
                    algo,
                    opts: algo === 'fresh-until' ? { maxStalenessMs: 1_000 } : { expiresAtMs: admittedAtMs + 1_000 }
                }
            },
            forwarding: { ...prepared.plan.forwarding, enabled: true, nextHopPeerIds: ['peer-b'] }
        };
        const deadline = admittedAtMs + Math.min(callerTtlMs ?? 1_000, 1_000);
        const bundle = computeALInboundAdmission({ ...prepared, plan, canForward: true });
        const dispatch = bundle.durableEffects.find((effect) => effect.payload.kind === 'dispatch-local');
        const forward = bundle.durableEffects.find((effect) => effect.payload.kind === 'forward-message');
        const buffered = bundle.mutations.find((mutation) => mutation.kind === 'set-buffered');
        if (dispatch?.payload.kind !== 'dispatch-local' || forward?.payload.kind !== 'forward-message' || !buffered) {
            throw new Error('This admitted message must own dispatch, forwarding and ordered replay');
        }
        for (const admitted of [decodePersistedALMessage(dispatch.payload.entry.resource), forward.payload.msg, buffered.snapshot.msg]) {
            expect(admitted).toEqual({ ...message, constraints: { ttlHops: 5, expiresAtMs: deadline } });
        }
        expect(dispatch.expireAtTimestamp).toBe(deadline);
        expect(forward.expireAtTimestamp).toBe(deadline);
        expect(await stores.admissionStore.commitBundle(bundle)).toBe('committed');
        expect(JSON.stringify(message)).toBe(original);

        vi.setSystemTime(admittedAtMs + 100);
        const read = await stores.admissionStore.readBufferedRelease({
            trackKey: buffered.snapshot.trackKey,
            seq: buffered.snapshot.seq,
            nowMs: Date.now()
        });
        if (!read) {
            throw new Error('The admitted message must survive for ordered replay');
        }
        // Removing the old topic expiry policy must not renew the admitted message.
        const replayPlan = planIncomingMessage(read.snapshot.msg, read.source, { nowMs: Date.now() });
        const replay = computeALInboundBufferedRelease({
            read,
            plan: replayPlan,
            facts: readALInboundEffectFacts(read.snapshot.msg, Date.now(), createPreparationDependencies())
        });
        expect(replay.localDelivery?.entry.audit.expiryTs.epochMilliseconds).toBe(deadline);
        expect(decodePersistedALMessage(replay.localDelivery!.entry.resource).constraints?.expiresAtMs).toBe(deadline);
    });

    it('uses the buffered message deadline for release work created by a later predecessor', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const admittedAtMs = 1_800_000_000_000;
        vi.setSystemTime(admittedAtMs);
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const message = { ...createMessage(2), constraints: { expiresAtMs: admittedAtMs + 1_000 } };
        const waiting = await readAdmission({ store: stores.admissionStore, message });
        expect(await stores.admissionStore.commitBundle(computeALInboundAdmission({ ...waiting, canForward: false })))
            .toBe('committed');

        vi.setSystemTime(admittedAtMs + 500);
        const predecessor = await readAdmission({ store: stores.admissionStore, message: createMessage(1) });
        const bundle = computeALInboundAdmission({ ...predecessor, canForward: false });
        const release = bundle.durableEffects.find((effect) => effect.payload.kind === 'release-buffered');

        expect(release).toBeDefined();
        expect(release?.expireAtTimestamp).toBe(admittedAtMs + 1_000);
    });

    it('rejects a deadline-expanded envelope before it can poison buffered admission', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_800_000_000_000);
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const message = toMessageWithEnvelopeSize(createMessage(2), AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes);
        expect(decodeALMessageValue(message).right).toBeDefined();
        const prepared = await readAdmission({ store: stores.admissionStore, message });
        const plan = withFreshnessPolicy(prepared.plan);
        const candidate = computeALInboundAdmission({ ...prepared, plan, canForward: false });
        expect(validateALInboundCommitBundle(candidate, prepared.read.namespace).left?.code).toBe('oversized');

        const runtime = new ALInboundMessageRuntime({
            ...createRuntimeDependencies(stores.admissionStore),
            planIncomingMessage: (message, source, observations) => withFreshnessPolicy(planIncomingMessage(message, source, observations))
        });
        try {
            const result = await runtime.handleIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });
            expect(result.left?.code).toBe('oversized');
            const untouched = await readAdmission({ store: stores.admissionStore, message });
            expect(untouched.read.observations.messageOwner).toBeUndefined();
            expect(untouched.read.bufferedSnapshots).toEqual([]);
            expect(await stores.admissionStore.workQueue.getAllKeys()).toEqual([]);
        }
        finally {
            runtime.dispose();
        }
    });

    it('counts the deadline-bearing message before deciding whether an ordered buffer has room', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_800_000_000_000);
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        let freshnessEnabled = false;
        const runtime = new ALInboundMessageRuntime({
            ...createRuntimeDependencies(stores.admissionStore),
            planIncomingMessage: (message, source, observations) => {
                const plan = planIncomingMessage(message, source, observations);
                return freshnessEnabled ? withFreshnessPolicy(plan) : plan;
            }
        });
        try {
            for (let seq = 2; seq <= 9; seq++) {
                const message = toMessageWithEnvelopeSize(createMessage(seq), 130_000);
                expect((await runtime.handleIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' })).right?.kind)
                    .toBe('admitted');
            }
            const message = toMessageWithEnvelopeSize(createMessage(10), AL_MESSAGE_RESOURCE_LIMITS.bufferedBytes - 8 * 130_000);
            const prepared = await readAdmission({ store: stores.admissionStore, message });
            const candidate = computeALInboundAdmission({ ...prepared, plan: withFreshnessPolicy(prepared.plan), canForward: false });
            expect(validateALInboundCommitBundle(candidate, prepared.read.namespace).left?.code).toBe('oversized');

            freshnessEnabled = true;
            const result = await runtime.handleIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });
            expect(result.right?.kind).toBe('resync-required');
            const remaining = await readAdmission({ store: stores.admissionStore, message });
            expect(remaining.read.observations.messageOwner).toBeUndefined();
            expect(remaining.read.bufferedSnapshots).toHaveLength(8);
            expect(remaining.read.bufferedSnapshots.reduce((bytes, snapshot) => bytes + new TextEncoder().encode(JSON.stringify(snapshot.msg)).length, 0))
                .toBe(8 * 130_000);
        }
        finally {
            runtime.dispose();
        }
    });

    it('retains authenticated source and frozen audience for the full owned-work lifetime', async () => {
        vi.useFakeTimers();
        const admittedAtMs = 1_800_000_000_000;
        vi.setSystemTime(admittedAtMs);
        const stores = createDefaultInMemoryALInboundRuntimeStores({
            retention: {
                msgOwnerTtlMs: 10,
                durableEffectTtlMs: 10_000,
                bufferedMessageTtlMs: 20_000
            }
        });
        const message = createMessage(2);
        const source = {
            kind: 'ws-client' as const,
            peerId: 'sender',
            roomRecipientPeerIds: ['receiver', 'peer-b']
        };
        const prepared = await readAdmission({ store: stores.admissionStore, message, source, nowMs: admittedAtMs });
        const bundle = computeALInboundAdmission({ ...prepared, canForward: false });
        const ownerMutation = bundle.mutations.find((mutation) => mutation.kind === 'set-msg-owner');
        if (!ownerMutation) {
            throw new Error('Admission must compute the message provenance before writing');
        }
        Object.freeze(source.roomRecipientPeerIds);
        Object.freeze(ownerMutation.value.source);
        Object.freeze(ownerMutation.value);
        Object.freeze(ownerMutation);
        expect(await stores.admissionStore.commitBundle(bundle)).toBe('committed');
        const ownedWorkExpiry = Math.max(...bundle.durableEffects.map((effect) => effect.expireAtTimestamp));
        expect(ownerMutation?.expireAtTimestamp).toBeGreaterThanOrEqual(ownedWorkExpiry);

        vi.setSystemTime(admittedAtMs + 1_000);
        const replay = await stores.admissionStore.readStoredPlanningState({
            msg: message,
            nowMs: admittedAtMs + 1_000
        });
        expect(replay.source).toEqual(source);
        expect(replay.supersedenceKey).toBeNull();
    });

    it('discards a conflicted candidate and requires a fresh ingress before committing', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const candidates: ALInboundCommitBundle[] = [];
        const statuses: ('committed' | 'conflict')[] = [];
        const commitBundle = stores.admissionStore.commitBundle.bind(stores.admissionStore);
        let injectConflict = true;
        vi.spyOn(stores.admissionStore, 'commitBundle').mockImplementation(async (bundle) => {
            const admissionCandidate = bundle.durableEffects.some((effect) => effect.payload.kind === 'send-control');
            if (admissionCandidate) {
                candidates.push(bundle);
            }
            if (admissionCandidate && injectConflict) {
                injectConflict = false;
                await commitBundle({
                    ...bundle,
                    mutations: bundle.mutations.filter((mutation) => mutation.kind === 'set-msg-owner'),
                    durableEffects: []
                });
            }
            const status = await commitBundle(bundle);
            if (admissionCandidate) {
                statuses.push(status);
            }
            return status;
        });
        const controls: ALMessage[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...createRuntimeDependencies(stores.admissionStore),
            sendControlMessage: async (message) => {
                controls.push(message);
            }
        });
        try {
            const first = await runtime.handleIncomingMessage(createMessage(1), { kind: 'ws-client', peerId: 'sender' });
            expect(first.right).toEqual({ kind: 'not-admitted', reason: 'conflict' });
            expect(controls).toEqual([]);

            const second = await runtime.handleIncomingMessage(createMessage(1), { kind: 'ws-client', peerId: 'sender' });
            expect(second.right).toEqual({ kind: 'admitted' });
            expect(statuses).toEqual(['conflict', 'committed']);
            expect(candidates).toHaveLength(2);
            const committedControls = candidates[1]!.durableEffects.flatMap((effect) => effect.payload.kind === 'send-control' ? [effect.payload.msg] : []);
            expect(controls).toEqual(committedControls);
            expect(controls).not.toEqual(candidates[0]!.durableEffects);
        }
        finally {
            runtime.dispose();
        }
    });

    it('retries the same durable control envelope through QueueBox after a transport failure', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_800_000_000_000);
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const controls: ALMessage[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...createRuntimeDependencies(stores.admissionStore),
            sendControlMessage: async (message) => {
                controls.push(message);
                if (controls.length === 1) {
                    throw new Error('Temporary control transport failure');
                }
            }
        });
        try {
            await runtime.handleIncomingMessage(createMessage(1), { kind: 'ws-client', peerId: 'sender' });
            const firstAck = controls.find((message) => message.payload.typeId === 'al.control.ack.v1');
            expect(firstAck).toBeDefined();
            vi.setSystemTime(Date.now() + 10_000);
            await expect.poll(() => controls.filter((message) => message.payload.typeId === 'al.control.ack.v1'))
                .toEqual([firstAck, firstAck]);
        }
        finally {
            runtime.dispose();
        }
    });

    it('materializes controls through the strict canonical decoder', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const prepared = await readAdmission({ store: stores.admissionStore, message: createMessage(1) });
        const bundle = computeALInboundAdmission({ ...prepared, canForward: false });
        const controls = bundle.durableEffects.flatMap((effect) => effect.payload.kind === 'send-control' ? [decodeALControlMessage(effect.payload.msg)] : []);

        expect(controls.length).toBeGreaterThan(0);
        expect(controls.every((control) => control.right !== undefined)).toBe(true);
    });
});

interface PreparedAdmission {
    readonly read: ALInboundAdmissionRead;
    readonly plan: ALMessageHandlingPlan;
    readonly facts: ALInboundEffectFacts;
}

function withFreshnessPolicy(plan: ALMessageHandlingPlan): ALMessageHandlingPlan {
    return {
        ...plan,
        effective: { ...plan.effective, expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 1_000 } } }
    };
}

function toMessageWithEnvelopeSize(message: ALMessage, bytes: number): ALMessage {
    const empty = { ...message, id: { ...message.id, traceId: '' } };
    return {
        ...empty,
        id: { ...empty.id, traceId: 'x'.repeat(bytes - new TextEncoder().encode(JSON.stringify(empty)).length) }
    };
}

interface AdmissionReadInput {
    readonly store: ALInboundAdmissionStore;
    readonly message: ALMessage;
    readonly source?: ALInboundMessageRuntime.Source;
    readonly nowMs?: number;
}

async function readAdmission(input: AdmissionReadInput): Promise<PreparedAdmission> {
    const { store, message, source = { kind: 'ws-client', peerId: 'sender' }, nowMs = Date.now() } = input;
    const prePlan = planIncomingMessage(message, source, { nowMs });
    const read = await store.readIncomingMessage({ msg: message, source, nowMs, prePlan });
    const plan = planIncomingMessage(message, source, computeALInboundPlanningObservations(read));
    return {
        read,
        plan,
        facts: readALInboundEffectFacts(message, nowMs, createPreparationDependencies())
    };
}

function createPreparationDependencies(): ALInboundEffectPreparationDependencies {
    return {
        selfPeerId: 'receiver',
        createInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
    };
}

function createRuntimeDependencies(admissionStore: ALInboundAdmissionStore): ALInboundMessageRuntime.Dependencies {
    return {
        admissionStore,
        planIncomingMessage,
        readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
        dispatchInboxEntry: async () => {},
        sendControlMessage: async () => {},
        effectPreparation: createPreparationDependencies(),
        effectWorkerId: 'test-worker',
        clock: { nowMs: () => Date.now() },
        queueEngine: new InboxOutboxEngine(),
        ownsQueueEngine: true
    };
}

function createMessage(seq: number): ALMessage {
    return newALMulticastMessage(
        'sender',
        { topicId: 'chat', resourceId: `message-${seq}`, contextId: 'room' },
        { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        'chat.message.v1',
        { text: `message ${seq}` },
        { seq, ack: 'receiver', reliability: 'at-least-once', qos: { durability: { algo: 'volatile' } } }
    );
}

function planIncomingMessage(
    message: ALMessage,
    source: ALInboundMessageRuntime.Source,
    observations: ALMessagePlanningObservations
): ALMessageHandlingPlan {
    return planALMessageHandling(message, {
        selfPeerId: 'receiver',
        fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
        connectedPeerIds: ['sender'],
        groupMemberPeerIds: ['sender', 'receiver'],
        overlayNeighborPeerIds: [],
        ...observations
    });
}
