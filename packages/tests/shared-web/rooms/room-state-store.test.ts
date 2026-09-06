import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createRoomStateStore } from '@shared-web/browser/rooms/room-state-store.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { createTestGroup } from '../../create-test-group.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface RoomSnapshotFixtureInput {
    readonly groupId: string;
    readonly displayName: string;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly sessionIds?: readonly string[];
}

const stateMocks = vi.hoisted(() => ({
    session: {
        clientId: 'principal-1',
        sessionId: 'session-1',
        username: 'principal-1',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 60_000
    },
    groups: [] as GroupSnapshot[],
    clients: [] as ClientSnapshot[],
    repositoriesConfigured: false
}));

vi.mock('@shared/api/auth.ts', () => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: vi.fn(() => stateMocks.session),
    writeSession: vi.fn()
}));

vi.mock('@shared/repository/client-state-snapshots-repository.ts', () => ({
    findClientStateSnapshotByPrincipalId: (principalId: string) => {
        requireConfiguredRepositories();
        return stateMocks.clients.find((snapshot) => snapshot.principal.principalId === principalId);
    },
    getAllClientStateSnapshots: () => {
        requireConfiguredRepositories();
        return [...stateMocks.clients];
    }
}));

vi.mock('@shared/repository/group-state-snapshots-repository.ts', () => ({
    findFirstGroupStateSnapshotRefSessionIdIsIn: (sessionId: string) => {
        requireConfiguredRepositories();
        return stateMocks.groups.find((snapshot) => snapshot.activeSessions.some((session) => session.sessionId === sessionId))?.group;
    },
    findGroupStateSnapshotByRef: (roomRef: GroupRef) => {
        requireConfiguredRepositories();
        return stateMocks.groups.find(
            (snapshot) =>
                snapshot.group.applicationId === roomRef.applicationId &&
                snapshot.group.workspaceId === roomRef.workspaceId &&
                snapshot.group.groupId === roomRef.groupId
        );
    },
    getAllGroupStateSnapshots: () => {
        requireConfiguredRepositories();
        return [...stateMocks.groups];
    },
    wasGroupStateSnapshotObservedByRef: (roomRef: GroupRef) => {
        requireConfiguredRepositories();
        return stateMocks.groups.some(
            (snapshot) =>
                snapshot.group.applicationId === roomRef.applicationId &&
                snapshot.group.workspaceId === roomRef.workspaceId &&
                snapshot.group.groupId === roomRef.groupId
        );
    }
}));

describe('room state store summaries', () => {
    void createRoomStateStore;

    beforeEach(() => {
        stateMocks.groups.length = 0;
        stateMocks.clients.length = 0;
        stateMocks.repositoriesConfigured = false;
    });

    it('requires configured cache repositories for room state reads', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();

        expect(() => facade.rooms.state()).toThrow(
            'Repository not found: shared.repository.test-snapshots'
        );
    });

    it('reads an absent room snapshot before the cache repositories exist', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const roomRef = createTestGroup({ applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' });

        expect(facade.rooms.formation(roomRef).status()).toBeUndefined();
    });

    it('filters room state by application and workspace scope', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const selected = createRoomSnapshot({ groupId: 'selected-room', displayName: 'Selected Room' });
        const otherApplication = createRoomSnapshot({ groupId: 'other-app-room', displayName: 'Other App', applicationId: 'other-app' });
        const otherWorkspace = createRoomSnapshot({ groupId: 'other-workspace-room', displayName: 'Other Workspace', workspaceId: 'other-workspace' });
        stateMocks.repositoriesConfigured = true;
        stateMocks.groups.push(otherApplication, otherWorkspace, selected);

        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });

        expect(facade.rooms.state().rooms.map((room) => room.roomId)).toEqual(['selected-room']);
        expect(facade.rooms.state().currentRoomRef).toEqual(createTestGroup({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'selected-room',
            displayName: 'Selected Room',
            activeMemberCount: 1,
            ownerPrincipalId: 'session-1',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: selected.group.created,
            updated: selected.group.updated
        }));
    });

    it('shares the browser session and cache repositories across facade instances', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const firstFacade = createRallarFacade();
        const secondFacade = createRallarFacade();
        const room = createRoomSnapshot({
            groupId: 'shared-room',
            displayName: 'Shared Room'
        });
        stateMocks.repositoriesConfigured = true;
        stateMocks.groups.push(room);
        firstFacade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        secondFacade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });

        expect(firstFacade.auth.restore()).toEqual(stateMocks.session);
        expect(secondFacade.auth.restore()).toEqual(stateMocks.session);
        expect(firstFacade.rooms.state().rooms.map((summary) => summary.roomId)).toEqual([
            'shared-room'
        ]);
        expect(secondFacade.rooms.state().rooms.map((summary) => summary.roomId)).toEqual([
            'shared-room'
        ]);
    });

    it('orders active room summaries by display name and omits archived rooms', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const current = createRoomSnapshot({ groupId: 'z-room', displayName: 'Beta Room' });
        const first = createRoomSnapshot({ groupId: 'a-room', displayName: 'Alpha Room', sessionIds: [] });
        const archivedBase = createRoomSnapshot({ groupId: 'archived-room', displayName: 'Archived Room', sessionIds: [] });
        const archived: GroupSnapshot = {
            ...archivedBase,
            group: {
                ...archivedBase.group,
                status: 'archived',
                archived: archivedBase.group.updated,
                deleted: null
            }
        };
        stateMocks.repositoriesConfigured = true;
        stateMocks.groups.push(current, archived, first);

        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });

        const state = facade.rooms.state();

        expect(
            state.rooms.map(({ roomId, name, isJoined, isCurrent }) => ({
                roomId,
                name,
                isJoined,
                isCurrent
            }))
        ).toEqual([
            { roomId: 'a-room', name: 'Alpha Room', isJoined: false, isCurrent: false },
            { roomId: 'z-room', name: 'Beta Room', isJoined: true, isCurrent: true }
        ]);
        expect(state.currentRoomId).toBe('z-room');
        expect(state.currentRoomRef).toEqual(current.group);
        expect(state.currentRoom).toEqual(current);
    });

    it('preserves complete summary and current-room state fields', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const current = createRoomSnapshot({ groupId: 'z-room', displayName: 'Beta Room' });
        stateMocks.repositoriesConfigured = true;
        stateMocks.groups.push(current);
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });

        expect(facade.rooms.state()).toEqual({
            rooms: [
                {
                    roomId: 'z-room',
                    roomRef: current.group,
                    name: 'Beta Room',
                    status: 'active',
                    kind: 'room',
                    joinMode: 'open',
                    memberCount: 1,
                    onlineMemberCount: 1,
                    isJoined: true,
                    isCurrent: true,
                    snapshot: current
                }
            ],
            currentRoomId: 'z-room',
            currentRoomRef: current.group,
            currentRoom: current,
            members: [
                {
                    principalId: 'session-1',
                    username: 'session-1',
                    displayName: undefined,
                    role: 'owner',
                    status: 'active',
                    isOwner: true,
                    isOnline: true,
                    sessionIds: ['session-1'],
                    client: undefined
                }
            ]
        });
    });
});

function requireConfiguredRepositories(): void {
    if (!stateMocks.repositoriesConfigured) {
        throw new Error('Repository not found: shared.repository.test-snapshots');
    }
}

function createRoomSnapshot(
    input: RoomSnapshotFixtureInput
): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: input.applicationId ?? 'app-1',
        workspaceId: input.workspaceId ?? 'workspace-1',
        groupId: input.groupId,
        sessionIds: input.sessionIds ?? ['session-1']
    });
    return { ...snapshot, group: { ...snapshot.group, displayName: input.displayName } };
}
