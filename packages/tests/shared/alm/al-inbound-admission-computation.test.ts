import { Temporal } from '@js-temporal/polyfill';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling, type ALMessageHandlingPlan } from '@shared/al-contracts/al-policy.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundAdmissionStore, ALInboundCommitBundle } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { computeALInboundAdmission, computeALInboundBufferedRelease } from '@shared/alm/inbound/compute-al-inbound-admission.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

describe('inbound admission computation boundary', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('computes the complete repeatable admission bundle from explicit facts', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const message = createMessage(1);
        const read = await stores.admissionStore.readIncomingMessage(message, 'sender', planIncomingMessage);
        vi.spyOn(Date, 'now').mockReturnValue(100);
        vi.spyOn(Temporal.Now, 'plainDateTimeISO').mockImplementation(() => {
            throw new Error('Admission computation must not read the clock');
        });

        const facts = createComputationFacts('candidate');
        const first = computeALInboundAdmission(read, false, facts);
        vi.spyOn(Date, 'now').mockReturnValue(200);
        const second = computeALInboundAdmission(read, false, facts);

        expect(second).toEqual(first);
        expect(first.durableEffects.map((effect) => effect.payload.kind)).toEqual([
            'dispatch-local',
            'send-control',
            'send-control'
        ]);
        expect(first.durableEffects[0]?.payload).toMatchObject({
            kind: 'dispatch-local',
            entry: { resource: JSON.stringify(message), typeId: 'inbox' }
        });
    });

    it('computes repeatable buffered release values without generating a local entry or ACK envelope', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const message = createMessage(2);
        const read = await stores.admissionStore.readIncomingMessage(message, 'sender', planIncomingMessage);
        const release = {
            kind: 'buffered-release' as const,
            nowMs: read.nowMs,
            snapshot: { trackKey: 'sender:chat', seq: 2, msg: message, plan: read.plan },
            supersedence: {},
            acks: []
        };
        vi.spyOn(Temporal.Now, 'plainDateTimeISO').mockImplementation(() => {
            throw new Error('Buffered computation must not read the clock');
        });

        const facts = createComputationFacts('buffered');
        const first = computeALInboundBufferedRelease(release, read.plan, facts);
        const second = computeALInboundBufferedRelease(release, read.plan, facts);

        expect(second).toEqual(first);
        expect(first.durableEffects[0]?.payload).toHaveProperty('entry');
    });

    it('uses only explicit facts for durable control-message identity and time', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const message = createMessage(1);
        const read = await stores.admissionStore.readIncomingMessage(message, 'sender', planIncomingMessage);
        const bundle = computeALInboundAdmission(read, false, createComputationFacts('candidate'));
        const controlMessages = bundle.durableEffects.flatMap((effect) => effect.payload.kind === 'send-control' ? [effect.payload.msg] : []);
        const controls = controlMessages.map(parseALControlMessage);

        expect(controlMessages.map((control) => control.id.msgId)).toEqual([
            expect.stringMatching(/^candidate:/),
            expect.stringMatching(/^candidate:/)
        ]);
        expect(controlMessages.map((control) => control.id.ts)).toEqual([
            1_800_000_000_000,
            1_800_000_000_000
        ]);
        expect(controls).toMatchObject([
            {
                type: 'ack',
                payload: { ackedMsgId: message.id.msgId, fromPeerId: 'receiver', toPeerId: 'sender', status: 'delivered', observedAtEpochMs: 1_800_000_000_000 }
            },
            {
                type: 'repair',
                payload: { msgId: message.id.msgId, reason: 'retransmit', observedAtEpochMs: 1_800_000_000_000 }
            }
        ]);
    });

    it('discards a conflicted computed candidate and sends only the committed envelope', async () => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const committedBundles: ALInboundCommitBundle[] = [];
        const commitStatuses: ('committed' | 'conflict')[] = [];
        const commitBundle = stores.admissionStore.commitBundle.bind(stores.admissionStore);
        let conflict = true;
        vi.spyOn(stores.admissionStore, 'commitBundle').mockImplementation(async (bundle) => {
            committedBundles.push(bundle);
            if (conflict) {
                conflict = false;
                await commitBundle({
                    senderId: bundle.senderId,
                    expectedVersion: bundle.expectedVersion,
                    mutations: [{ kind: 'set-msg-owner', msgId: 'concurrent-message', senderId: bundle.senderId }],
                    durableEffects: []
                });
            }
            const status = await commitBundle(bundle);
            commitStatuses.push(status);
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
            await runtime.handleIncomingMessage(createMessage(1), 'sender');

            expect(commitStatuses).toEqual(['conflict', 'committed']);
            expect(committedBundles).toHaveLength(2);
            const candidateControls = committedBundles.map((bundle) =>
                bundle.durableEffects.flatMap((effect) => effect.payload.kind === 'send-control' ? [effect.payload.msg] : [])
            );
            expect(controls).toEqual(candidateControls[1]);
            expect(controls.map((message) => message.id.msgId)).not.toEqual(candidateControls[0]?.map((message) => message.id.msgId));
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
            await runtime.handleIncomingMessage(createMessage(1), 'sender');
            const firstAck = controls.find((message) => message.payload.typeId === 'al.control.ack.v1');
            expect(firstAck).toBeDefined();
            expect(scheduler.pending?.delayMs).toBeGreaterThan(0);
            nowMs += 10_000;
            scheduler.pending?.callback();

            await vi.waitFor(() => {
                expect(controls.filter((message) => message.payload.typeId === 'al.control.ack.v1')).toEqual([firstAck, firstAck]);
            });
            await vi.waitFor(async () => {
                expect(await stores.admissionStore.peekNextEffectReadyAt(nowMs)).toBeUndefined();
            });
        }
        finally {
            runtime.dispose();
        }
    });
});

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

function createComputationFacts(messageIdentitySeed: string) {
    return {
        selfPeerId: 'receiver',
        inboxEntryTypeId: 'inbox',
        messageIdentitySeed,
        observedAtEpochMs: 1_800_000_000_000,
        inboxAudit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdTs: Temporal.PlainDateTime.from('2027-01-15T12:00:00')
        }
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
        selfPeerId: 'receiver',
        inboxEntryTypeId: 'inbox',
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

function planIncomingMessage(message: ALMessage, fromPeerId: string): ALMessageHandlingPlan {
    return planALMessageHandling(message, {
        selfPeerId: 'receiver',
        fromPeerId,
        connectedPeerIds: ['sender'],
        groupMemberPeerIds: ['sender', 'receiver'],
        overlayNeighborPeerIds: []
    });
}
