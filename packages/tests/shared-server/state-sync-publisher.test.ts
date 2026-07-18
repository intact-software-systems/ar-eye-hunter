import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ALOutboundEnqueueStatus } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { createWsStateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';

describe('createWsStateSyncPublisher', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('allows no-route for a group snapshot with active sessions and logs a warning', async () => {
        const { publisher } = createPublisherReturning('no-route');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            await expect(
                publisher.publishGroupSnapshot(createGroupSnapshot('room-1', ['session-a'])),
            ).resolves.toBeUndefined();
            expect(warn).toHaveBeenCalledWith(
                'State sync publish missed live route',
                expect.objectContaining({
                    topicId: 'group-state.snapshot',
                    resourceId: 'room-1',
                    status: 'no-route',
                    reason: 'test resolver returned no recipients',
                }),
            );
        } finally {
            warn.mockRestore();
        }
    });

    it('allows no-route for a group snapshot with no live sessions to notify', async () => {
        const { publisher } = createPublisherReturning('no-route');

        await expect(
            publisher.publishGroupSnapshot(createGroupSnapshot('room-1', [])),
        ).resolves.toBeUndefined();
    });

    it('publishes group snapshots to member state and scope directory topics', async () => {
        const { publisher, enqueueOutboxIfAbsent } = createPublisherReturning('enqueued');

        await publisher.publishGroupSnapshot(createGroupSnapshot('room-1', ['session-a']));

        expect(
            enqueueOutboxIfAbsent.mock.calls.map(([message]) => message.payload.typeId),
        ).toEqual([
            AppTopics.groupStateSnapshot,
            AppTopics.groupDirectorySnapshot,
        ]);
        expect(enqueueOutboxIfAbsent.mock.calls[1]?.[0]).toMatchObject({
            payload: expect.objectContaining({
                typeId: AppTopics.groupDirectorySnapshot,
            }),
        });
    });

    it('returns an exact first winner and distrusts reconstructed duplicate entries', async () => {
        const storedMessages = new Map<string, ALMessage>();
        const enqueueOutboxIfAbsent = vi.fn(async (message: ALMessage) => {
            const winner = storedMessages.get(message.id.msgId) ?? message;
            const status = storedMessages.has(message.id.msgId)
                ? 'duplicate' as const
                : 'enqueued' as const;
            storedMessages.set(message.id.msgId, winner);
            const entry = QueueBoxUtilities.toResourceEntryFromMsg(
                status === 'enqueued' ? winner : message,
                WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
            );
            return { status, message, entry, entries: [entry] };
        });
        const publisher = createWsStateSyncPublisher(
            { enqueueOutboxIfAbsent } as unknown as WsQueueBoxServerService,
            { serverId: 'state-service' },
        );
        const revision1 = createClientSnapshot('alice', []);
        const revision2: ClientSnapshot = {
            ...revision1,
            stateRevision: 2,
            principal: {
                ...revision1.principal,
                snapshotVersion: 2,
                profileVersion: 2,
            },
        };

        const first = await publisher.publishClientSnapshot(
            revision1,
            'outbox-worker',
            'state-mutation-1:client-state-sync:snapshot',
        );
        const duplicate = await publisher.publishClientSnapshot(
            revision2,
            'outbox-worker',
            'state-mutation-1:client-state-sync:snapshot',
        );

        const messageIds = enqueueOutboxIfAbsent.mock.calls.map(
            ([message]) => message.id.msgId,
        );
        expect(messageIds[0]).toBe(messageIds[1]);
        expect(storedMessages.size).toBe(1);
        expect(first).toEqual({ effectiveSnapshotRevision: 1 });
        expect(duplicate).toBeUndefined();
    });

    it('does not treat superseded candidate entries as persisted winners', async () => {
        const enqueueOutboxIfAbsent = vi.fn(async (message: ALMessage) => {
            const entry = QueueBoxUtilities.toResourceEntryFromMsg(
                message,
                WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
            );
            return {
                status: 'superseded' as const,
                message,
                entry,
                entries: [entry],
            };
        });
        const publisher = createWsStateSyncPublisher(
            { enqueueOutboxIfAbsent } as unknown as WsQueueBoxServerService,
            { serverId: 'state-service' },
        );

        await expect(publisher.publishClientSnapshot(
            createClientSnapshot('alice', []),
            'outbox-worker',
            'state-mutation-1:client-state-sync:snapshot',
        )).resolves.toBeUndefined();
    });

    it('allows no-route for a client snapshot with active sessions and logs a warning', async () => {
        const { publisher } = createPublisherReturning('no-route');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            await expect(
                publisher.publishClientSnapshot(createClientSnapshot('alice', ['session-a'])),
            ).resolves.toBeUndefined();
            expect(warn).toHaveBeenCalledWith(
                'State sync publish missed live route',
                expect.objectContaining({
                    topicId: 'client-state.snapshot',
                    resourceId: 'alice',
                    status: 'no-route',
                    reason: 'test resolver returned no recipients',
                }),
            );
        } finally {
            warn.mockRestore();
        }
    });

    it('records timing details when a live state-sync publish has no route', async () => {
        const timingEvents: RallarTimingEvent[] = [];
        const { publisher } = createPublisherReturning('no-route', {
            timing: (event) => timingEvents.push(event),
        });

        await publisher.publishClientSnapshot(
            createClientSnapshot('alice', ['session-a']),
        );

        expect(timingEvents).toEqual([
            expect.objectContaining({
                component: 'state-sync',
                operation: 'no-route',
                status: 'ok',
                details: expect.objectContaining({
                    topicId: 'client-state.snapshot',
                    resourceId: 'alice',
                    reason: 'test resolver returned no recipients',
                }),
            }),
        ]);
    });

    it('allows no-route for a group event when the cached group snapshot has active sessions', async () => {
        const snapshot = createGroupSnapshot('room-2', ['session-b']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(snapshot);
        const { publisher } = createPublisherReturning('no-route');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            await expect(
                publisher.publishGroupEvent(createGroupEvent('room-2', 'event-1')),
            ).resolves.toBeUndefined();
            expect(warn).toHaveBeenCalledWith(
                'State sync publish missed live route',
                expect.objectContaining({
                    topicId: 'group-state.event',
                    resourceId: 'event-1',
                    status: 'no-route',
                    reason: 'test resolver returned no recipients',
                }),
            );
        } finally {
            warn.mockRestore();
        }
    });

    it('rejects hard enqueue failures even when no live route is expected', async () => {
        const { publisher } = createPublisherReturning('failed');

        await expect(
            publisher.publishGroupSnapshot(createGroupSnapshot('room-3', [])),
        ).rejects.toThrow(
            'State sync publish failed for group-state.snapshot/room-3: failed',
        );
    });
});

function createPublisherReturning(
    status: ALOutboundEnqueueStatus,
    options: Partial<Parameters<typeof createWsStateSyncPublisher>[1]> = {},
): Readonly<{
    publisher: ReturnType<typeof createWsStateSyncPublisher>;
    enqueueOutboxIfAbsent: ReturnType<typeof vi.fn>;
}> {
    const enqueueOutboxIfAbsent = vi.fn(async (message: ALMessage) => ({
        status,
        message,
        entries: [],
        reason: status === 'no-route' ? 'test resolver returned no recipients' : 'test failure',
    }));
    const publisher = createWsStateSyncPublisher(
        { enqueueOutboxIfAbsent } as unknown as WsQueueBoxServerService,
        {
            serverId: 'state-service',
            ...options,
        },
    );

    return {
        publisher,
        enqueueOutboxIfAbsent,
    };
}

function createClientSnapshot(
    principalId: string,
    sessionIds: readonly string[],
): ClientSnapshot {
    return {
        stateRevision: 1,
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId,
            username: principalId,
            displayName: principalId,
            status: 'active',
            roles: [],
            metadata: {},
            profileVersion: 1,
            presenceVersion: sessionIds.length,
            snapshotVersion: 1,
            created: { atEpochMs: 1, byServiceId: 'test' },
            updated: { atEpochMs: 1, byServiceId: 'test' },
        },
        instances: [],
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId,
            clientInstanceId: 'browser',
            sessionId,
            status: 'active',
            presenceState: 'online',
            transport: 'ws',
            authenticatedAtEpochMs: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        })),
        isOnline: sessionIds.length > 0,
        activeSessionCount: sessionIds.length,
    };
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
): GroupSnapshot {
    return {
        stateRevision: 1,
        group: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: sessionIds.length,
            created: { atEpochMs: 1, byServiceId: 'test' },
            updated: { atEpochMs: 1, byServiceId: 'test' },
        },
        members: sessionIds.map((sessionId) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: { atEpochMs: 1, byServiceId: 'test' },
            updated: { atEpochMs: 1, byServiceId: 'test' },
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}

function createGroupEvent(groupId: string, eventId: string): GroupEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        eventId,
        eventType: 'group-updated',
        snapshotVersion: 2,
        occurredAtEpochMs: 2,
        actor: {
            serviceId: 'test',
        },
    };
}
