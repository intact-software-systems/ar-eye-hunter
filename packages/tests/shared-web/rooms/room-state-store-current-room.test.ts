import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createRallarBrowserFacadeRuntimeContext } from '@shared-web/browser/rallar-runtime-context.ts';
import { createRallarStateCacheReadPort } from '@shared-web/browser/rallar-runtime/state-store.ts';
import { createRoomStateStore } from '@shared-web/browser/rooms/room-state-store.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupMember, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import {
    createActiveGroupMemberFixture,
    createActiveGroupPresenceSessionFixture,
    createClientSnapshotFixture,
    createGroupSnapshotFixture
} from '../authoritative-group-fixtures.ts';

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
    }
}));

describe('room state store current-room projection', () => {
    void createRoomStateStore;

    beforeEach(() => {
        stateMocks.groups.length = 0;
        stateMocks.clients.length = 0;
        stateMocks.repositoriesConfigured = false;
    });

    it('projects active members and orders display names before username fallbacks', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const current = createMemberRoomSnapshot();
        const aliceClient = createClient('alice', 'Zulu Display');
        const bobClient = createClient('bob', null);
        stateMocks.repositoriesConfigured = true;
        stateMocks.groups.push(current);
        stateMocks.clients.push(bobClient, aliceClient);

        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });

        expect(facade.rooms.state().members).toEqual([
            {
                principalId: 'bob',
                username: 'Alpha Username',
                displayName: undefined,
                role: 'member',
                status: 'active',
                isOwner: false,
                isOnline: false,
                sessionIds: [],
                client: bobClient
            },
            {
                principalId: 'charlie',
                username: 'charlie',
                displayName: undefined,
                role: 'member',
                status: 'left',
                isOwner: false,
                isOnline: false,
                sessionIds: [],
                client: undefined
            },
            {
                principalId: 'alice',
                username: 'alice',
                displayName: 'Zulu Display',
                role: 'owner',
                status: 'active',
                isOwner: true,
                isOnline: true,
                sessionIds: ['session-1'],
                client: aliceClient
            }
        ]);
    });

    it('uses the highest-revision principal snapshot before accepting the default scope', () => {
        const runtime = createRallarBrowserFacadeRuntimeContext();
        const current = createMemberRoomSnapshot();
        const lowerRevisionDefaultAlice = createClient('alice', 'Default Alice');
        const higherRevisionOtherScopeAlice = createClient('alice', 'Other Alice', {
            applicationId: 'app-2',
            workspaceId: 'workspace-2',
            stateRevision: 3
        });
        const higherRevisionDefaultBob = createClient('bob', 'Default Bob', { stateRevision: 4 });
        const lowerRevisionOtherScopeBob = createClient('bob', 'Other Bob', {
            applicationId: 'app-2',
            workspaceId: 'workspace-2',
            stateRevision: 2
        });
        stateMocks.groups.push(current);
        stateMocks.clients.push(
            higherRevisionOtherScopeAlice,
            higherRevisionDefaultBob,
            lowerRevisionDefaultAlice,
            lowerRevisionOtherScopeBob
        );
        stateMocks.repositoriesConfigured = true;
        const store = createRoomStateStore({
            runtime,
            readSession: () => stateMocks.session,
            stateCache: createRallarStateCacheReadPort()
        });

        runtime.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });

        expect(store.state().members).toEqual([
            expect.objectContaining({
                principalId: 'alice',
                username: 'alice',
                displayName: undefined,
                client: undefined
            }),
            expect.objectContaining({
                principalId: 'charlie',
                username: 'charlie',
                displayName: undefined,
                client: undefined
            }),
            expect.objectContaining({
                principalId: 'bob',
                username: 'Alpha Username',
                displayName: 'Default Bob',
                client: higherRevisionDefaultBob
            })
        ]);
    });

    it('preserves the selected current room when defaults move to another scope', () => {
        const runtime = createRallarBrowserFacadeRuntimeContext();
        const current = createRoomSnapshot('scope-a-room', 'Scope A Room');
        const visible = createRoomSnapshot(
            'scope-b-room',
            'Scope B Room',
            { applicationId: 'app-2', workspaceId: 'workspace-2' },
            []
        );
        stateMocks.groups.push(current, visible);
        stateMocks.repositoriesConfigured = true;
        const store = createRoomStateStore({
            runtime,
            readSession: () => stateMocks.session,
            stateCache: createRallarStateCacheReadPort()
        });
        runtime.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        runtime.setCurrentRoom(current);
        const before = store.state();

        runtime.setDefaults({ applicationId: 'app-2', workspaceId: 'workspace-2' });
        const after = store.state();

        expect(before.rooms.map((room) => room.roomId)).toEqual(['scope-a-room']);
        expect(before.currentRoom).toBe(current);
        expect(after.rooms.map((room) => room.roomId)).toEqual(['scope-b-room']);
        expect(after.currentRoomRef).toBe(before.currentRoomRef);
        expect(after.currentRoomId).toBe(before.currentRoomId);
        expect(after.currentRoom).toBe(before.currentRoom);
        expect(after.members).toEqual(before.members);
    });

    it('selects the session room when the canonical current room ref is absent', () => {
        const runtime = createRallarBrowserFacadeRuntimeContext();
        const sessionRoom = createRoomSnapshot('session-room', 'Session Room');
        const bareIdRoom = createRoomSnapshot('bare-id-room', 'Bare ID Room');
        stateMocks.groups.push(sessionRoom, bareIdRoom);
        stateMocks.repositoriesConfigured = true;
        const store = createRoomStateStore({
            runtime: {
                currentRoomId: () => bareIdRoom.group.groupId,
                currentRoomRef: () => undefined,
                setCurrentRoom: runtime.setCurrentRoom,
                clearCurrentRoomIfMatches: runtime.clearCurrentRoomIfMatches,
                readDefaultScope: runtime.readDefaultScope,
                resolveOperationScope: runtime.resolveOperationScope
            },
            readSession: () => stateMocks.session,
            stateCache: createRallarStateCacheReadPort()
        });

        runtime.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });

        expect(store.resolveCurrentRoomRef()).toEqual(sessionRoom.group);
    });
});

function requireConfiguredRepositories(): void {
    if (!stateMocks.repositoriesConfigured) {
        throw new Error('Repository not found: shared.repository.test-snapshots');
    }
}

function createRoomSnapshot(
    groupId: string,
    displayName: string,
    scope: Readonly<{ applicationId?: string; workspaceId?: string; }> = {},
    sessionIds: readonly string[] = ['session-1']
): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: scope.applicationId ?? 'app-1',
        workspaceId: scope.workspaceId ?? 'workspace-1',
        groupId,
        sessionIds
    });
    return { ...snapshot, group: { ...snapshot.group, displayName } };
}

function createMemberRoomSnapshot(): GroupSnapshot {
    const snapshot = createRoomSnapshot('room-1', 'Room One', {}, []);
    const scope = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
    const alice = createActiveGroupMemberFixture({
        ...scope,
        principalId: 'alice',
        role: 'owner',
        actorPrincipalId: 'alice'
    });
    const bob = createActiveGroupMemberFixture({
        ...scope,
        principalId: 'bob',
        role: 'member',
        actorPrincipalId: 'alice'
    });
    const charlie = createActiveGroupMemberFixture({
        ...scope,
        principalId: 'charlie',
        role: 'member',
        actorPrincipalId: 'alice'
    });
    const inactive: GroupMember = {
        applicationId: charlie.applicationId,
        workspaceId: charlie.workspaceId,
        groupId: charlie.groupId,
        principalId: charlie.principalId,
        role: charlie.role,
        updated: charlie.updated,
        invitedByPrincipalId: charlie.invitedByPrincipalId,
        invitationExpiresAtEpochMs: charlie.invitationExpiresAtEpochMs,
        status: 'left',
        left: snapshot.group.updated,
        joined: snapshot.group.created,
        removed: null,
        banned: null
    };
    return {
        ...snapshot,
        group: { ...snapshot.group, ownerPrincipalId: 'alice', activeMemberCount: 2 },
        members: [alice, inactive, bob],
        activeSessions: [
            createActiveGroupPresenceSessionFixture({
                ...scope,
                principalId: 'alice',
                sessionId: 'session-1'
            })
        ],
        memberCount: 2,
        onlineMemberCount: 1
    };
}

function createClient(
    principalId: string,
    displayName: string | null,
    options: Readonly<{
        applicationId?: string;
        workspaceId?: string;
        stateRevision?: number;
    }> = {}
): ClientSnapshot {
    const snapshot = createClientSnapshotFixture({
        applicationId: options.applicationId ?? 'app-1',
        workspaceId: options.workspaceId ?? 'workspace-1',
        principalId
    });
    return {
        ...snapshot,
        stateRevision: options.stateRevision ?? snapshot.stateRevision,
        principal: {
            ...snapshot.principal,
            username: principalId === 'bob' ? 'Alpha Username' : principalId,
            displayName
        }
    };
}
