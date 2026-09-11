import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundPlanner } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime, ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundMessageRuntime } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { planRtcRoomSnapshotAdmission } from '@shared/multicast/rtc-room-snapshot-admission.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { createGroupSnapshotFixture } from '../../shared-web/authoritative-group-fixtures.ts';

interface ReplayObservedState {
    snapshot: GroupSnapshot | undefined;
    overloaded: boolean;
}

interface ReplayFixture {
    readonly runtime: ALInboundMessageRuntime;
    readonly stores: ALInboundRuntimeStores;
    readonly engine: InboxOutboxEngine;
    readonly observed: ReplayObservedState;
    readonly planner: ALInboundPlanner;
    readonly delivered: string[];
    readonly forwarded: string[];
    readonly controls: ALMessage[];
}

interface ReplayMessageInput {
    readonly seq: number;
    readonly versioned: boolean;
    readonly acknowledge: boolean;
    readonly persist?: boolean;
}

describe('RTC admitted-message consumption', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
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
                await fixture.runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: 'sender' });
                expect(fixture.delivered).toEqual([]);
                expect(fixture.forwarded).toEqual([]);

                fixture.observed.snapshot = createCurrentSnapshot();
                fixture.observed.overloaded = false;
                await fixture.engine.executeOnce();
                await expect.poll(async () => {
                    await fixture.engine.executeOnce();
                    return fixture.delivered;
                }).toEqual([message.id.msgId]);
                await expect.poll(async () => {
                    await fixture.engine.executeOnce();
                    return fixture.forwarded;
                }).toEqual([message.id.msgId]);
                expect(fixture.forwarded).toEqual([message.id.msgId]);
                await fixture.runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: 'sender' });
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
        const trackKey = toALOrderingTrackKey(second);
        if (!trackKey) {
            throw new Error('Ordered message must have an ordering track.');
        }
        try {
            await fixture.runtime.admitIncomingMessage(second, { kind: 'rtc-peer', peerId: 'sender' });
            fixture.observed.snapshot = { ...createCurrentSnapshot(), group: { ...createCurrentSnapshot().group, snapshotVersion: 4 } };
            await fixture.runtime.admitIncomingMessage(first, { kind: 'rtc-peer', peerId: 'sender' });
            await expect.poll(() => fixture.delivered).toEqual([first.id.msgId]);
            expect(await fixture.stores.admissionStore.readBufferedRelease({ trackKey, seq: 2, nowMs: Date.now() })).toBeDefined();
            expect(acknowledgedIds(fixture.controls)).not.toContain(second.id.msgId);

            fixture.observed.snapshot = createCurrentSnapshot();
            await fixture.engine.executeOnce();
            await expect.poll(async () => {
                await fixture.engine.executeOnce();
                return fixture.delivered;
            }).toEqual([first.id.msgId, second.id.msgId]);
            await expect.poll(async () => {
                await fixture.engine.executeOnce();
                return acknowledgedIds(fixture.controls);
            }).toContain(second.id.msgId);
            expect(await fixture.stores.admissionStore.readBufferedRelease({ trackKey, seq: 2, nowMs: Date.now() })).toBeUndefined();
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
            await fixture.runtime.admitIncomingMessage(first, { kind: 'rtc-peer', peerId: 'sender' });
            expect(fixture.delivered).toEqual([]);
            clearSnapshotAfterCommit.mockRestore();
            fixture.observed.snapshot = createCurrentSnapshot();
            await fixture.runtime.admitIncomingMessage(second, { kind: 'rtc-peer', peerId: 'sender' });
            expect(fixture.delivered).not.toContain(second.id.msgId);
            await fixture.engine.executeOnce();
            await expect.poll(async () => {
                await fixture.engine.executeOnce();
                return fixture.delivered;
            }).toEqual([first.id.msgId, second.id.msgId]);
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
        await initial.runtime.admitIncomingMessage(first, { kind: 'rtc-peer', peerId: 'sender' });
        expect(initial.delivered).toEqual([]);
        initial.runtime.dispose();

        const resumed = createReplayFixture(false, initial.stores);
        try {
            await resumed.runtime.admitIncomingMessage(second, { kind: 'rtc-peer', peerId: 'sender' });
            await expect.poll(async () => {
                await resumed.engine.executeOnce();
                return resumed.delivered;
            }).toEqual([first.id.msgId, second.id.msgId]);
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
            await fixture.runtime.admitIncomingMessage(second, { kind: 'rtc-peer', peerId: 'upstream-relay' });
            await fixture.runtime.admitIncomingMessage(first, { kind: 'rtc-peer', peerId: 'upstream-relay' });
            await expect.poll(async () => {
                await fixture.engine.executeOnce();
                return fixture.controls.map(parseALControlMessage).filter((control) =>
                    control?.type === 'ack' && control.payload.ackedMsgId === second.id.msgId && control.payload.status === 'delivered'
                );
            }).toEqual([
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

        await fixture.runtime.admitIncomingMessage(createMessage({ seq: 1, versioned: true, acknowledge: false }), { kind: 'rtc-peer', peerId: 'sender' });

        expect(vi.getTimerCount()).toBe(0);
        fixture.observed.snapshot = createCurrentSnapshot();
        await fixture.engine.executeOnce();
        expect(fixture.delivered).toEqual([]);
    });

    it('requests resynchronization when its predecessor retry work has expired', async () => {
        const fixture = createReplayFixture(
            false,
            createDefaultInMemoryALInboundRuntimeStores({
                retention: { durableEffectTtlMs: 500, bufferedMessageTtlMs: 5_000 }
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
            await fixture.runtime.admitIncomingMessage(first, { kind: 'rtc-peer', peerId: 'sender' });
            vi.setSystemTime(Date.now() + 1_000);
            fixture.observed.snapshot = createCurrentSnapshot();

            await fixture.runtime.admitIncomingMessage(second, { kind: 'rtc-peer', peerId: 'sender' });

            expect(fixture.delivered).toEqual([]);
            await expect.poll(async () => {
                await fixture.engine.executeOnce();
                return fixture.controls.map(parseALControlMessage);
            }).toContainEqual({
                type: 'nack',
                payload: expect.objectContaining({ msgId: second.id.msgId, reason: 'resync-required', missingSeqs: [] })
            });
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
            await fixture.runtime.admitIncomingMessage(first, { kind: 'rtc-peer', peerId: 'sender' });
            vi.setSystemTime(Date.now() + 100);
            fixture.observed.snapshot = { ...createCurrentSnapshot(), group: { ...createCurrentSnapshot().group, snapshotVersion: 4 } };
            await fixture.runtime.admitIncomingMessage(second, { kind: 'rtc-peer', peerId: 'sender' });
            expect(fixture.delivered).toEqual([]);
            fixture.observed.snapshot = createCurrentSnapshot();
            await expect.poll(async () => {
                await fixture.engine.executeOnce();
                return fixture.delivered;
            }).toEqual([first.id.msgId, second.id.msgId]);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('leaves claimed work unconsumed when disposed while its storage read is in flight', async () => {
        const fixture = createReplayFixture(false);
        const reserve = fixture.stores.workQueue.reserveEntries.bind(fixture.stores.workQueue);
        vi.spyOn(fixture.stores.workQueue, 'reserveEntries').mockImplementation(async (request) => {
            const reserved = await reserve(request);
            if (reserved.size > 0) {
                fixture.runtime.dispose();
            }
            return reserved;
        });

        await fixture.runtime.admitIncomingMessage(createMessage({ seq: 1, versioned: true, acknowledge: false }), { kind: 'rtc-peer', peerId: 'sender' });

        expect(fixture.delivered).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
});

function createReplayFixture(relay: boolean, stores = createDefaultInMemoryALInboundRuntimeStores()): ReplayFixture {
    const observed: ReplayObservedState = { snapshot: createCurrentSnapshot(), overloaded: false };
    const delivered: string[] = [];
    const forwarded: string[] = [];
    const controls: ALMessage[] = [];
    const planner: ALInboundPlanner = (message, source, observations) =>
        planRtcRoomSnapshotAdmission({
            message,
            plan: planALMessageHandling(message, {
                selfPeerId: 'receiver',
                fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
                ...observations,
                overloaded: observed.overloaded,
                connectedPeerIds: relay ? ['sender', 'downstream'] : ['sender'],
                groupMemberPeerIds: ['sender', 'receiver', 'downstream'],
                overlayNeighborPeerIds: relay ? ['sender', 'downstream'] : ['sender']
            }),
            snapshot: observed.snapshot,
            fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
            selfPeerId: 'receiver',
            recipientPeerId: undefined,
            overlay: {
                overlayId: 'room',
                groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
                provenance: 'server',
                state: 'active',
                topology: 'tree',
                name: 'Room',
                sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 1 },
                nextHopSessionIds: ['sender', 'upstream-relay', 'downstream'],
                degreeLimit: 3,
                overlayVersion: 1,
                createdByClientId: 'sender',
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1
            },
            nowMs: observations.nowMs
        });
    const engine = new InboxOutboxEngine();
    const runtime = createDefaultALInboundMessageRuntime({
        selfPeerId: 'receiver',
        stores,
        queueEngine: engine,
        planIncomingMessage: planner,
        toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox'),
        dispatchInboxEntry: async (entry) => {
            delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
        },
        forwardMessage: async (message) => {
            forwarded.push(message.id.msgId);
        },
        sendControlMessage: async (message) => {
            controls.push(message);
        },
        diagnostics: undefined
    });
    return { runtime, stores, engine, observed, planner, delivered, forwarded, controls };
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
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'app',
        workspaceId: 'workspace',
        groupId: 'room',
        sessionIds: ['sender', 'receiver', 'upstream-relay', 'downstream']
    });
    return {
        ...snapshot,
        group: { ...snapshot.group, snapshotVersion: 5 },
        activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: Date.now() + 60_000 }))
    };
}
