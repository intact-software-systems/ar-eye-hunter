import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundPlanner } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime, ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundMessageRuntime } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { planRtcRoomSnapshotAdmission } from '@shared/multicast/rtc-room-snapshot-admission.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { createTestGroup } from '../../create-test-group.ts';

interface ReplayObservedState {
    snapshot: GroupSnapshot | undefined;
    overloaded: boolean;
}

interface ReplayFixture {
    readonly runtime: ALInboundMessageRuntime;
    readonly stores: ALInboundRuntimeStores;
    readonly observed: ReplayObservedState;
    readonly planner: ALInboundPlanner;
    readonly delivered: string[];
    readonly forwarded: string[];
    readonly controls: ALMessage[];
    readonly inbox: InMemoryQueueBox;
}

interface ReplayMessageInput {
    readonly seq: number;
    readonly versioned: boolean;
    readonly acknowledge: boolean;
    readonly persist?: boolean;
}

describe('RTC admitted-message consumption', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_800_000_000_000);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each(['snapshot', 'congestion'] as const)(
        'retries durable delivery and forwarding after %s changes between admission and consumption',
        async (fault) => {
            const fixture = createReplayFixture(true);
            const commit = fixture.stores.admissionStore.commitBundle.bind(fixture.stores.admissionStore);
            vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
                const result = await commit(bundle);
                if (fault === 'snapshot') {
                    fixture.observed.snapshot = undefined;
                }
                else {
                    fixture.observed.overloaded = true;
                }
                return result;
            });
            const message = createMessage({ seq: 1, versioned: true, acknowledge: false });
            try {
                await fixture.runtime.handleIncomingMessage(message, 'sender');
                expect(fixture.delivered).toEqual([]);
                expect(fixture.forwarded).toEqual([]);

                fixture.observed.snapshot = createCurrentSnapshot();
                fixture.observed.overloaded = false;
                await vi.advanceTimersByTimeAsync(1_000);
                expect(fixture.delivered).toEqual([message.id.msgId]);
                expect(fixture.forwarded).toEqual([message.id.msgId]);
                await fixture.runtime.handleIncomingMessage(message, 'sender');
                expect(fixture.delivered).toEqual([message.id.msgId]);
            }
            finally {
                fixture.runtime.dispose();
            }
        }
    );

    it('retains a buffered message and withholds its ACK until its snapshot catches up', async () => {
        const fixture = createReplayFixture(false);
        const second = createMessage({ seq: 2, versioned: true, acknowledge: true });
        const first = createMessage({ seq: 1, versioned: false, acknowledge: true });
        const read = await fixture.stores.admissionStore.readIncomingMessage(second, 'sender', fixture.planner);
        const trackKey = read.plan.orderingRuntime.trackKey;
        if (!trackKey) {
            throw new Error('Ordered message must have an ordering track.');
        }
        try {
            await fixture.runtime.handleIncomingMessage(second, 'sender');
            fixture.observed.snapshot = undefined;
            await fixture.runtime.handleIncomingMessage(first, 'sender');
            expect(fixture.delivered).toEqual([first.id.msgId]);
            expect(await fixture.stores.admissionStore.readBufferedRelease(trackKey, 2)).toBeDefined();
            expect(acknowledgedIds(fixture.controls)).not.toContain(second.id.msgId);

            fixture.observed.snapshot = createCurrentSnapshot();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(fixture.delivered).toEqual([first.id.msgId, second.id.msgId]);
            expect(acknowledgedIds(fixture.controls)).toContain(second.id.msgId);
            expect(await fixture.stores.admissionStore.readBufferedRelease(trackKey, 2)).toBeUndefined();
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('keeps a newly received successor behind an admitted predecessor awaiting snapshot recovery', async () => {
        const fixture = createReplayFixture(false);
        const first = createMessage({ seq: 1, versioned: true, acknowledge: false });
        const second = createMessage({ seq: 2, versioned: true, acknowledge: false });
        const commit = fixture.stores.admissionStore.commitBundle.bind(fixture.stores.admissionStore);
        const clearSnapshotAfterCommit = vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockImplementation(async (bundle) => {
            const result = await commit(bundle);
            fixture.observed.snapshot = undefined;
            return result;
        });
        try {
            await fixture.runtime.handleIncomingMessage(first, 'sender');
            expect(fixture.delivered).toEqual([]);
            clearSnapshotAfterCommit.mockRestore();
            fixture.observed.snapshot = createCurrentSnapshot();
            await fixture.runtime.handleIncomingMessage(second, 'sender');
            expect(fixture.delivered).not.toContain(second.id.msgId);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(fixture.delivered).toEqual([first.id.msgId, second.id.msgId]);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('preserves the predecessor delivery fence when the runtime restarts before its retry', async () => {
        const initial = createReplayFixture(false);
        const first = createMessage({ seq: 1, versioned: true, acknowledge: false });
        const second = createMessage({ seq: 2, versioned: true, acknowledge: false });
        const commit = initial.stores.admissionStore.commitBundle.bind(initial.stores.admissionStore);
        vi.spyOn(initial.stores.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
            const result = await commit(bundle);
            initial.observed.snapshot = undefined;
            return result;
        });
        await initial.runtime.handleIncomingMessage(first, 'sender');
        expect(initial.delivered).toEqual([]);
        initial.runtime.dispose();

        const resumed = createReplayFixture(false, initial.stores);
        try {
            await resumed.runtime.handleIncomingMessage(second, 'sender');
            expect(resumed.delivered).not.toContain(second.id.msgId);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(resumed.delivered).toEqual([first.id.msgId, second.id.msgId]);
        }
        finally {
            resumed.runtime.dispose();
        }
    });

    it('acknowledges a released buffered message to its admitted upstream relay, not its origin', async () => {
        const fixture = createReplayFixture(false);
        const second = createMessage({ seq: 2, versioned: true, acknowledge: true });
        const first = createMessage({ seq: 1, versioned: true, acknowledge: true });
        try {
            await fixture.runtime.handleIncomingMessage(second, 'upstream-relay');
            await fixture.runtime.handleIncomingMessage(first, 'upstream-relay');
            const acknowledgements = fixture.controls.map(parseALControlMessage).filter((control) =>
                control?.type === 'ack' && control.payload.ackedMsgId === second.id.msgId && control.payload.status === 'delivered'
            );
            expect(acknowledgements).toEqual([
                { type: 'ack', payload: expect.objectContaining({ toPeerId: 'upstream-relay' }) }
            ]);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('does not start delivery or schedule a retry when disposed during an admission commit', async () => {
        const fixture = createReplayFixture(false);
        const commit = fixture.stores.admissionStore.commitBundle.bind(fixture.stores.admissionStore);
        vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
            const result = await commit(bundle);
            fixture.observed.snapshot = undefined;
            fixture.runtime.dispose();
            return result;
        });

        await fixture.runtime.handleIncomingMessage(createMessage({ seq: 1, versioned: true, acknowledge: false }), 'sender');

        expect(vi.getTimerCount()).toBe(0);
        fixture.observed.snapshot = createCurrentSnapshot();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fixture.delivered).toEqual([]);
    });

    it('releases a successor when its predecessor retry work has expired', async () => {
        const fixture = createReplayFixture(
            false,
            createDefaultInMemoryALInboundRuntimeStores({
                retention: { durableEffectTtlMs: 50, bufferedMessageTtlMs: 500 }
            })
        );
        const first = createMessage({ seq: 1, versioned: true, acknowledge: false });
        const second = createMessage({ seq: 2, versioned: true, acknowledge: false });
        const commit = fixture.stores.admissionStore.commitBundle.bind(fixture.stores.admissionStore);
        vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
            const result = await commit(bundle);
            fixture.observed.snapshot = undefined;
            return result;
        });
        try {
            await fixture.runtime.handleIncomingMessage(first, 'sender');
            vi.setSystemTime(Date.now() + 100);
            fixture.observed.snapshot = createCurrentSnapshot();

            await fixture.runtime.handleIncomingMessage(second, 'sender');

            expect(fixture.delivered).toEqual([second.id.msgId]);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it.each(['active', 'failed', 'missing', 'replaced'] as const)('respects the actual %s queued predecessor rather than an orphaned marker', async (owner) => {
        const fixture = createReplayFixture(false);
        const first = createMessage({ seq: 1, versioned: true, acknowledge: false, persist: true });
        const second = createMessage({ seq: 2, versioned: true, acknowledge: false, persist: true });
        try {
            await fixture.runtime.handleIncomingMessage(first, 'sender');
            const firstEntry = await fixture.inbox.getItem(first.route);
            if (!firstEntry) {
                throw new Error('Expected the first admitted inbox entry');
            }
            if (owner === 'failed') {
                await fixture.inbox.setItem(firstEntry.key, { ...firstEntry, status: EntityStatus.FAILED }, {
                    expireAtTimestamp: firstEntry.audit.expiryTs.epochMilliseconds
                });
            }
            else if (owner === 'missing') {
                await fixture.inbox.removeItem(firstEntry.key);
            }
            else if (owner === 'replaced') {
                const replacement = { ...first, id: { ...first.id, msgId: 'replacement-message' } };
                await fixture.inbox.setItem(firstEntry.key, { ...firstEntry, resource: JSON.stringify(replacement) }, {
                    expireAtTimestamp: firstEntry.audit.expiryTs.epochMilliseconds
                });
            }
            await fixture.runtime.handleIncomingMessage(second, 'sender');
            const secondEntry = await fixture.inbox.getItem(second.route);
            if (!secondEntry) {
                throw new Error('Expected the second admitted inbox entry');
            }

            expect(await fixture.runtime.dispatchStoredEntry(secondEntry)).toBe(owner === 'active' ? 'retry' : 'completed');
            if (owner === 'active') {
                expect(fixture.delivered).toEqual([]);
                expect(await fixture.runtime.dispatchStoredEntry(firstEntry)).toBe('completed');
                expect(await fixture.runtime.dispatchStoredEntry(secondEntry)).toBe('completed');
                expect(fixture.delivered).toEqual([first.id.msgId, second.id.msgId]);
            }
            else {
                expect(fixture.delivered).toEqual([second.id.msgId]);
            }
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it.each([false, true])('keeps live predecessor work ordered when buffer retention is shorter (queued=%s)', async (persist) => {
        const fixture = createReplayFixture(
            false,
            createDefaultInMemoryALInboundRuntimeStores({
                retention: { durableEffectTtlMs: 500, bufferedMessageTtlMs: 50 }
            })
        );
        const first = createMessage({ seq: 1, versioned: true, acknowledge: false, persist });
        const second = createMessage({ seq: 2, versioned: false, acknowledge: false, persist });
        const commit = fixture.stores.admissionStore.commitBundle.bind(fixture.stores.admissionStore);
        vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
            const result = await commit(bundle);
            fixture.observed.snapshot = undefined;
            return result;
        });
        try {
            await fixture.runtime.handleIncomingMessage(first, 'sender');
            vi.setSystemTime(Date.now() + 100);
            await fixture.runtime.handleIncomingMessage(second, 'sender');
            if (persist) {
                const secondEntry = await fixture.inbox.getItem(second.route);
                if (!secondEntry) {
                    throw new Error('Expected the admitted successor inbox entry');
                }
                expect(await fixture.runtime.dispatchStoredEntry(secondEntry)).toBe('retry');
                fixture.observed.snapshot = createCurrentSnapshot();
                const firstEntry = await fixture.inbox.getItem(first.route);
                if (!firstEntry) {
                    throw new Error('Expected the admitted predecessor inbox entry');
                }
                expect(await fixture.runtime.dispatchStoredEntry(firstEntry)).toBe('completed');
                expect(await fixture.runtime.dispatchStoredEntry(secondEntry)).toBe('completed');
            }
            else {
                expect(fixture.delivered).toEqual([]);
                fixture.observed.snapshot = createCurrentSnapshot();
                await vi.advanceTimersByTimeAsync(1_000);
            }
            expect(fixture.delivered).toEqual([first.id.msgId, second.id.msgId]);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('leaves claimed work unconsumed when disposed while its storage read is in flight', async () => {
        const fixture = createReplayFixture(false);
        const claim = fixture.stores.admissionStore.claimReadyEffects.bind(fixture.stores.admissionStore);
        vi.spyOn(fixture.stores.admissionStore, 'claimReadyEffects').mockImplementation(async (...args) => {
            const effects = await claim(...args);
            if (effects.length > 0) {
                fixture.runtime.dispose();
            }
            return effects;
        });

        await fixture.runtime.handleIncomingMessage(createMessage({ seq: 1, versioned: true, acknowledge: false }), 'sender');

        expect(fixture.delivered).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
});

function createReplayFixture(relay: boolean, stores = createDefaultInMemoryALInboundRuntimeStores()): ReplayFixture {
    const observed: ReplayObservedState = { snapshot: createCurrentSnapshot(), overloaded: false };
    const delivered: string[] = [];
    const forwarded: string[] = [];
    const controls: ALMessage[] = [];
    const planner: ALInboundPlanner = (message, fromPeerId, runtimeStores) =>
        planRtcRoomSnapshotAdmission({
            message,
            plan: planALMessageHandling(message, {
                selfPeerId: 'receiver',
                fromPeerId,
                ...runtimeStores,
                overloaded: observed.overloaded,
                connectedPeerIds: relay ? ['sender', 'downstream'] : ['sender'],
                groupMemberPeerIds: ['sender', 'receiver', 'downstream'],
                overlayNeighborPeerIds: relay ? ['sender', 'downstream'] : ['sender']
            }),
            snapshot: observed.snapshot,
            fromPeerId,
            nowMs: Date.now()
        });
    const inbox = new InMemoryQueueBox(new Map());
    const runtime = createDefaultALInboundMessageRuntime({
        selfPeerId: 'receiver',
        stores,
        inbox,
        planIncomingMessage: planner,
        readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
        toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox'),
        dispatchInboxEntry: async (entry) => {
            delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
        },
        forwardMessage: async (message) => {
            forwarded.push(message.id.msgId);
        },
        sendControlMessage: async (message) => {
            controls.push(message);
        }
    });
    return { runtime, stores, observed, planner, delivered, forwarded, controls, inbox };
}

function createMessage(input: ReplayMessageInput): ALMessage {
    return newALMulticastMessage(
        'sender',
        { topicId: 'chat', resourceId: `message-${input.seq}`, contextId: 'room' },
        { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        'chat.message.v1',
        { text: `message ${input.seq}` },
        {
            seq: input.seq,
            minSnapshotVersion: input.versioned ? 5 : undefined,
            ack: input.acknowledge ? 'receiver' : 'none',
            reliability: 'at-least-once',
            qos: { durability: { algo: input.persist ? 'local-inbox' : 'volatile' }, congestion: { algo: 'reject' } }
        }
    );
}

function acknowledgedIds(controls: readonly ALMessage[]): string[] {
    return controls.flatMap((message) => {
        const control = parseALControlMessage(message);
        return control?.type === 'ack' ? [control.payload.ackedMsgId] : [];
    });
}

function createCurrentSnapshot(): GroupSnapshot {
    return {
        group: createTestGroup({ applicationId: 'app', workspaceId: 'workspace', groupId: 'room', snapshotVersion: 5 }),
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0
    };
}
