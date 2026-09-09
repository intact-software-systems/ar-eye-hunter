import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage, parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundMessageRuntime, ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundMessageRuntime } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { planRtcRoomSnapshotAdmission } from '@shared/multicast/rtc-room-snapshot-admission.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

interface SnapshotObservation {
    snapshot: GroupSnapshot | undefined;
}

interface SnapshotAdmissionFixture {
    readonly runtime: ALInboundMessageRuntime;
    readonly observed: SnapshotObservation;
    readonly delivered: string[];
    readonly controls: ALMessage[];
    readonly message: ALMessage;
    readonly stores: ALInboundRuntimeStores;
}

const source: ALInboundMessageRuntime.Source = { kind: 'rtc-peer', peerId: 'sender' };
const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

describe('RTC snapshot rejection controls', () => {
    it('rejects an uncorrelated protocol NACK without application delivery or a NACK response', async () => {
        const fixture = createSnapshotAdmissionFixture(1, false);
        try {
            const result = await fixture.runtime.admitIncomingMessage(
                newALNackControlMessage(
                    { v: 2, msgId: 'nack-control', senderId: 'sender', ts: Date.now() },
                    { fromPeerId: 'sender', toPeerId: 'receiver', msgId: fixture.message.id.msgId, reason: 'not-yet-in-sync', observedAtEpochMs: Date.now() }
                ),
                source
            );
            expect(result.right).toEqual({ kind: 'control', handled: false });
            expect(fixture.controls).toEqual([]);
            expect(fixture.delivered).toEqual([]);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it.each([1, 2])('emits only a sync NACK without consuming admission state for sequence %s', async (seq) => {
        const fixture = createSnapshotAdmissionFixture(seq, false);
        try {
            await fixture.runtime.admitIncomingMessage(fixture.message, source);
            await expect.poll(() => fixture.controls.map(parseALControlMessage)).toEqual([
                { type: 'nack', payload: expect.objectContaining({ msgId: fixture.message.id.msgId, toPeerId: 'sender', reason: 'not-yet-in-sync' }) }
            ]);
            expect(fixture.delivered).toEqual([]);
            if (seq === 1) {
                fixture.observed.snapshot = createCurrentSnapshot();
                await fixture.runtime.admitIncomingMessage(fixture.message, source);
                await fixture.runtime.admitIncomingMessage(fixture.message, source);
                await expect.poll(() => fixture.delivered).toEqual([fixture.message.id.msgId]);
            }
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('rechecks current authority and retained ingress before retrying admitted work', async () => {
        vi.useFakeTimers();
        onTestFinished(() => {
            vi.restoreAllMocks();
            vi.useRealTimers();
        });
        const fixture = createSnapshotAdmissionFixture(1, true);
        const claim = vi.spyOn(fixture.stores.workQueue, 'reserveEntries').mockResolvedValue(new Map());
        try {
            fixture.observed.snapshot = createCurrentSnapshot();
            await fixture.runtime.admitIncomingMessage(fixture.message, source);
            expect(await fixture.stores.workQueue.getAllKeys()).not.toHaveLength(0);
            fixture.observed.snapshot = undefined;
            claim.mockRestore();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(fixture.delivered).toEqual([]);
            fixture.observed.snapshot = createCurrentSnapshot();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(fixture.delivered).toEqual([fixture.message.id.msgId]);
        }
        finally {
            fixture.runtime.dispose();
        }
    });
});

function createSnapshotAdmissionFixture(seq: number, persist: boolean): SnapshotAdmissionFixture {
    const observed: SnapshotObservation = { snapshot: undefined };
    const delivered: string[] = [];
    const controls: ALMessage[] = [];
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    const message = newALMulticastMessage('sender', { topicId: 'room.messages', contextId: 'room', resourceId: 'probe' }, roomRef, 'snapshot.probe.v1', {
        probe: true
    }, {
        minSnapshotVersion: 5,
        seq,
        ack: 'none',
        reliability: 'at-least-once',
        qos: { supersedence: { algo: 'latest-wins' }, durability: { algo: persist ? 'local-inbox' : 'volatile' } }
    });
    const runtime = createDefaultALInboundMessageRuntime({
        selfPeerId: 'receiver',
        stores,
        planIncomingMessage: (incoming, ingress, observations) => {
            const fromPeerId = ingress.kind === 'trusted-server' ? undefined : ingress.peerId;
            return planRtcRoomSnapshotAdmission({
                message: incoming,
                plan: planALMessageHandling(incoming, { selfPeerId: 'receiver', fromPeerId, ...observations }),
                snapshot: observed.snapshot,
                fromPeerId,
                selfPeerId: 'receiver',
                overlay: undefined,
                recipientPeerId: undefined,
                nowMs: observations.nowMs
            });
        },
        toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'test-inbox'),
        dispatchInboxEntry: async (entry) => {
            delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
        },
        sendControlMessage: async (control) => {
            controls.push(control);
        }
    });
    return { runtime, observed, delivered, controls, message, stores };
}

function createCurrentSnapshot(): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...roomRef, sessionIds: ['sender', 'receiver'] });
    return {
        ...snapshot,
        group: { ...snapshot.group, snapshotVersion: 5 },
        activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: Date.now() + 60_000 }))
    };
}
