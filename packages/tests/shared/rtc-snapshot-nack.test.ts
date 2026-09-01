import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage, parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundMessageRuntime } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { planRtcRoomSnapshotAdmission } from '@shared/multicast/rtc-room-snapshot-admission.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import { createTestGroup } from '../create-test-group.ts';

interface SnapshotAdmissionFixture {
    readonly runtime: ALInboundMessageRuntime;
    readonly observed: { snapshot: GroupSnapshot | undefined; };
    readonly delivered: string[];
    readonly controls: ALMessage[];
    readonly message: ALMessage;
}

describe('RTC snapshot rejection controls', () => {
    it('does not deliver a protocol NACK to the application or reply with another NACK', async () => {
        const fixture = createSnapshotAdmissionFixture();
        try {
            await fixture.runtime.handleIncomingMessage(
                newALNackControlMessage('sender', 'receiver', fixture.message.id.msgId, 'not-yet-in-sync'),
                'sender'
            );
            expect(fixture.controls).toEqual([]);
            expect(fixture.delivered).toEqual([]);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('does not consume admission state while rejected and delivers a retry only once after catch-up', async () => {
        const fixture = createSnapshotAdmissionFixture();
        try {
            await fixture.runtime.handleIncomingMessage(fixture.message, 'sender');
            expect(fixture.delivered).toEqual([]);
            expect(fixture.controls.map(parseALControlMessage)).toEqual([
                { type: 'nack', payload: expect.objectContaining({ reason: 'not-yet-in-sync' }) }
            ]);

            fixture.observed.snapshot = createCurrentSnapshot();
            await fixture.runtime.handleIncomingMessage(fixture.message, 'sender');
            await fixture.runtime.handleIncomingMessage(fixture.message, 'sender');
            expect(fixture.delivered).toEqual([fixture.message.id.msgId]);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('keeps an already admitted inbox entry retryable while its room cache is unavailable', async () => {
        const fixture = createSnapshotAdmissionFixture();
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(fixture.message, 'test-inbox');
        try {
            expect(await fixture.runtime.dispatchStoredEntry(entry)).toBe('retry');
            expect(fixture.delivered).toEqual([]);
            expect(fixture.controls).toEqual([]);

            fixture.observed.snapshot = createCurrentSnapshot();
            expect(await fixture.runtime.dispatchStoredEntry(entry)).toBe('completed');
            expect(fixture.delivered).toEqual([fixture.message.id.msgId]);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('emits only a correlated sync NACK even when the rejected message also has an ordering gap', async () => {
        const controls: ALMessage[] = [];
        const delivered: string[] = [];
        const forwarded: string[] = [];
        const message = newALMulticastMessage(
            'sender',
            {
                topicId: 'room.messages',
                contextId: 'room',
                resourceId: 'probe'
            },
            {
                applicationId: 'app',
                workspaceId: 'workspace',
                groupId: 'room'
            },
            'snapshot.probe.v1',
            { probe: true },
            {
                minSnapshotVersion: 5,
                seq: 2,
                reliability: 'at-least-once',
                ack: 'none'
            }
        );
        const runtime = createDefaultALInboundMessageRuntime({
            selfPeerId: 'receiver',
            inbox: new InMemoryQueueBox(new Map()),
            planIncomingMessage: (incoming, fromPeerId, stores) => {
                const plan = planALMessageHandling(incoming, {
                    selfPeerId: 'receiver',
                    fromPeerId,
                    ...stores
                });
                return {
                    ...plan,
                    dropReason: 'not-yet-in-sync',
                    localDelivery: { enabled: false, persist: false, deferred: false },
                    forwarding: { enabled: false, persist: false, nextHopPeerIds: [] },
                    ack: { enabled: false, algo: 'none', deferred: false },
                    nack: { enabled: true, toPeerId: fromPeerId, reason: 'not-yet-in-sync', missingSeqs: [] },
                    repair: { enabled: false, algo: 'none' }
                };
            },
            readStoredEntry: () => message,
            toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'test-inbox'),
            dispatchInboxEntry: async (entry) => {
                delivered.push(entry.resource);
            },
            sendControlMessage: async (control) => {
                controls.push(control);
            },
            forwardMessage: async (incoming) => {
                forwarded.push(incoming.id.msgId);
            }
        });
        try {
            await runtime.handleIncomingMessage(message, 'sender');
            expect(delivered).toEqual([]);
            expect(forwarded).toEqual([]);
            expect(controls.map(parseALControlMessage)).toEqual([
                {
                    type: 'nack',
                    payload: expect.objectContaining({
                        msgId: message.id.msgId,
                        fromPeerId: 'receiver',
                        toPeerId: 'sender',
                        reason: 'not-yet-in-sync'
                    })
                }
            ]);
        }
        finally {
            runtime.dispose();
        }
    });
});

function createSnapshotAdmissionFixture(): SnapshotAdmissionFixture {
    const observed: SnapshotAdmissionFixture['observed'] = { snapshot: undefined };
    const delivered: string[] = [];
    const controls: ALMessage[] = [];
    const message = newALMulticastMessage(
        'sender',
        {
            topicId: 'room.messages',
            contextId: 'room',
            resourceId: 'probe'
        },
        {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'room'
        },
        'snapshot.probe.v1',
        { probe: true },
        {
            minSnapshotVersion: 5,
            seq: 1,
            ack: 'none',
            qos: { supersedence: { algo: 'latest-wins' } }
        }
    );
    const runtime = createDefaultALInboundMessageRuntime({
        selfPeerId: 'receiver',
        inbox: new InMemoryQueueBox(new Map()),
        planIncomingMessage: (incoming, fromPeerId, stores) =>
            planRtcRoomSnapshotAdmission({
                message: incoming,
                plan: planALMessageHandling(incoming, { selfPeerId: 'receiver', fromPeerId, ...stores }),
                snapshot: observed.snapshot,
                fromPeerId,
                nowMs: 100
            }),
        readStoredEntry: () => message,
        toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'test-inbox'),
        dispatchInboxEntry: async () => {
            delivered.push(message.id.msgId);
        },
        sendControlMessage: async (control) => {
            controls.push(control);
        }
    });
    return { runtime, observed, delivered, controls, message };
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
