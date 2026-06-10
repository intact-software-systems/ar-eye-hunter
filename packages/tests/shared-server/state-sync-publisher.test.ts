import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ALOutboundEnqueueStatus } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { createWsStateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';

describe('createWsStateSyncPublisher', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('rejects no-route for a group snapshot with active sessions', async () => {
        const { publisher } = createPublisherReturning('no-route');

        await expect(
            publisher.publishGroupSnapshot(createGroupSnapshot('room-1', ['session-a'])),
        ).rejects.toThrow(
            'State sync publish failed for group-state.snapshot/room-1: no-route',
        );
    });

    it('allows no-route for a group snapshot with no live sessions to notify', async () => {
        const { publisher } = createPublisherReturning('no-route');

        await expect(
            publisher.publishGroupSnapshot(createGroupSnapshot('room-1', [])),
        ).resolves.toBeUndefined();
    });

    it('rejects no-route for a client snapshot with active sessions', async () => {
        const { publisher } = createPublisherReturning('no-route');

        await expect(
            publisher.publishClientSnapshot(createClientSnapshot('alice', ['session-a'])),
        ).rejects.toThrow(
            'State sync publish failed for client-state.snapshot/alice: no-route',
        );
    });

    it('rejects no-route for a group event when the cached group snapshot has active sessions', async () => {
        const snapshot = createGroupSnapshot('room-2', ['session-b']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(snapshot);
        const { publisher } = createPublisherReturning('no-route');

        await expect(
            publisher.publishGroupEvent(createGroupEvent('room-2', 'event-1')),
        ).rejects.toThrow(
            'State sync publish failed for group-state.event/event-1: no-route',
        );
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

function createPublisherReturning(status: ALOutboundEnqueueStatus): Readonly<{
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
        { serverId: 'state-service' },
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
