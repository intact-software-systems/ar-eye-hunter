import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage, parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundMessageRuntime, ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type {
    ALInboundRuntimeDiagnosticsEvent,
    ALInboundRuntimeDiagnosticsSink
} from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
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
import { waitForOwnedQueueWork } from './wait-for-owned-queue-work.ts';

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
                    { v: 3, msgId: 'nack-control', senderId: 'sender', ts: Date.now() },
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

    it.each([1, 2])('NACKs a fenced sender membership-fenced with no ordering hints or repair for sequence %s', async (seq) => {
        const events: ALInboundRuntimeDiagnosticsEvent[] = [];
        const fixture = createSnapshotAdmissionFixture(seq, false, (event) => events.push(event));
        try {
            fixture.observed.snapshot = createRemovedSenderSnapshot();
            await fixture.runtime.admitIncomingMessage(fixture.message, source);
            await expect.poll(() => fixture.controls.map(parseALControlMessage)).toEqual([
                {
                    type: 'nack',
                    payload: {
                        fromPeerId: 'receiver',
                        toPeerId: 'sender',
                        msgId: fixture.message.id.msgId,
                        reason: 'membership-fenced',
                        observedAtEpochMs: expect.any(Number)
                    }
                }
            ]);
            expect(fixture.delivered).toEqual([]);
            expect(events).toContainEqual(expect.objectContaining({
                kind: 'admission-outcome',
                msgId: fixture.message.id.msgId,
                carrier: 'rtc',
                outcome: 'rejected',
                reason: 'membership-fenced: Room sender has no live session in a roster beyond its stamp'
            }));
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('sends no NACK for a copy with no immediate RTC hop to answer', async () => {
        const fixture = createSnapshotAdmissionFixture(1, false);
        try {
            fixture.observed.snapshot = createRemovedSenderSnapshot();
            await fixture.runtime.admitIncomingMessage(fixture.message, { kind: 'trusted-server' });
            await waitForOwnedQueueWork(fixture.stores.workQueue);
            expect(fixture.controls).toEqual([]);
            expect(fixture.delivered).toEqual([]);
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

function createSnapshotAdmissionFixture(
    seq: number,
    persist: boolean,
    diagnostics?: ALInboundRuntimeDiagnosticsSink
): SnapshotAdmissionFixture {
    const observed: SnapshotObservation = { snapshot: undefined };
    const delivered: string[] = [];
    const controls: ALMessage[] = [];
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    const message = toALFrozenMulticastMessage(
        newALMulticastMessage('sender', { topicId: 'room.messages', contextId: 'room', resourceId: 'probe' }, roomRef, 'snapshot.probe.v1', {
            probe: true
        }, {
            minSnapshotVersion: 5,
            rosterVersion: 1,
            seq,
            ack: 'none',
            reliability: 'at-least-once',
            qos: { supersedence: { algo: 'latest-wins' }, durability: { algo: persist ? 'local-inbox' : 'volatile' } }
        }),
        { recipientPeerIds: ['receiver'], snapshotVersion: 5 }
    );
    const runtime = createDefaultALInboundMessageRuntime({
        carrier: 'rtc',
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
        sendControlMessages: async (messages) => {
            controls.push(...messages);
        },
        diagnostics
    });
    return { runtime, observed, delivered, controls, message, stores };
}

/** The authoritative shape of a removal: the roster moved past the stamp and lists no session of the removed member. */
function createRemovedSenderSnapshot(): GroupSnapshot {
    const current = createCurrentSnapshot();
    return {
        ...current,
        group: { ...current.group, rosterVersion: 2, snapshotVersion: 6 },
        members: current.members.map((member) =>
            member.principalId === 'sender' && member.status === 'active' ? { ...member, status: 'removed', removed: member.updated } : member
        ),
        activeSessions: current.activeSessions.filter((session) => session.sessionId !== 'sender')
    };
}

function createCurrentSnapshot(): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...roomRef, sessionIds: ['sender', 'receiver'] });
    return {
        ...snapshot,
        group: { ...snapshot.group, snapshotVersion: 5 },
        activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: Date.now() + 60_000 }))
    };
}
