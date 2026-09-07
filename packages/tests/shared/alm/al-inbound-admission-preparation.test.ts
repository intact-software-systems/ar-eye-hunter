import { Temporal } from '@js-temporal/polyfill';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
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
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('inbound admission preparation boundary', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each(['msgId', 'senderId', 'dedup', 'ordering'] as const)('rejects a candidate with original observations from another %s scope', async (scope) => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const prepared = await readAdmission(stores.admissionStore, createMessage(1));
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
        const prepared = await readAdmission(stores.admissionStore, createMessage(1));
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
    });

    it('computes a repeatable final buffered-release bundle from captured values', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const message = createMessage(1);
        const prepared = await readAdmission(stores.admissionStore, message);
        const read = {
            kind: 'buffered-release' as const,
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
        const prepared = await readAdmission(stores.admissionStore, message, source, admittedAtMs);
        const bundle = computeALInboundAdmission({ ...prepared, canForward: false });
        expect(await stores.admissionStore.commitBundle(bundle)).toBe('committed');
        const ownerMutation = bundle.mutations.find((mutation) => mutation.kind === 'set-msg-owner');
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

    it('retries a durable control envelope unchanged using the injected worker clock and scheduler', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_800_000_000_000);
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const controls: ALMessage[] = [];
        const scheduler = new TestEffectScheduler();
        let nowMs = Date.now();
        const runtime = new ALInboundMessageRuntime({
            ...createRuntimeDependencies(stores.admissionStore),
            clock: { nowMs: () => nowMs },
            scheduler,
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
            expect(scheduler.pending?.delayMs).toBeGreaterThan(0);
            nowMs += 10_000;
            scheduler.pending?.callback();

            await vi.waitFor(() => {
                expect(controls.filter((message) => message.payload.typeId === 'al.control.ack.v1')).toEqual([firstAck, firstAck]);
            });
            await vi.waitFor(async () => {
                expect(await stores.admissionStore.peekNextEffectReadyAt()).toBeUndefined();
            });
        }
        finally {
            runtime.dispose();
        }
    });

    it('materializes controls through the strict canonical decoder', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const prepared = await readAdmission(stores.admissionStore, createMessage(1));
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

async function readAdmission(
    store: ALInboundAdmissionStore,
    message: ALMessage,
    source: ALInboundMessageRuntime.Source = { kind: 'ws-client', peerId: 'sender' },
    nowMs = Date.now()
): Promise<PreparedAdmission> {
    const prePlan = planIncomingMessage(message, source, { nowMs });
    const read = await store.readIncomingMessage({ msg: message, source, nowMs, prePlan });
    const plan = planIncomingMessage(message, source, computeALInboundPlanningObservations(read));
    return {
        read,
        plan,
        facts: readALInboundEffectFacts(message, nowMs, createPreparationDependencies())
    };
}

namespace TestEffectScheduler {
    export interface Pending {
        readonly callback: () => void;
        readonly delayMs: number;
    }
}

class TestEffectScheduler implements ALInboundMessageRuntime.Scheduler {
    pending: TestEffectScheduler.Pending | undefined;

    schedule(callback: () => void, delayMs: number): () => void {
        this.pending = { callback, delayMs };
        return () => {
            this.pending = undefined;
        };
    }
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
        inbox: new InMemoryQueueBox(new Map()),
        planIncomingMessage,
        readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
        dispatchInboxEntry: async () => {},
        sendControlMessage: async () => {},
        effectPreparation: createPreparationDependencies(),
        effectWorkerId: 'test-worker',
        clock: { nowMs: () => Date.now() },
        scheduler: new TestEffectScheduler()
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
