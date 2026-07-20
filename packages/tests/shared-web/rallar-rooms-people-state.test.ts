import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

const mocks = vi.hoisted(() => ({
    session: {
        clientId: 'principal-1',
        sessionId: 'session-1',
        username: 'principal-1',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 60_000,
    },
    clientRepositoryMissing: vi.fn((_value?: unknown): unknown => {
        throw new Error(
            'Repository not found: shared.repository.client-state-snapshots',
        );
    }),
    groupRepositoryMissing: vi.fn((_value?: unknown): unknown => {
        throw new Error(
            'Repository not found: shared.repository.group-state-snapshots',
        );
    }),
}));

vi.mock('@shared/api/auth.ts', () => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: vi.fn(() => mocks.session),
    writeSession: vi.fn(),
}));

vi.mock('@shared/repository/client-state-snapshots-repository.ts', () => ({
    findClientStateSnapshotByPrincipalId: mocks.clientRepositoryMissing,
    getAllClientStateSnapshots: mocks.clientRepositoryMissing,
}));

vi.mock('@shared/repository/group-state-snapshots-repository.ts', () => ({
    findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.groupRepositoryMissing,
    findGroupStateSnapshotByRef: mocks.groupRepositoryMissing,
    getAllGroupStateSnapshots: mocks.groupRepositoryMissing,
}));

describe('Rallar rooms and people state compatibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.clientRepositoryMissing.mockImplementation(() => {
            throw new Error(
                'Repository not found: shared.repository.client-state-snapshots',
            );
        });
        mocks.groupRepositoryMissing.mockImplementation(() => {
            throw new Error(
                'Repository not found: shared.repository.group-state-snapshots',
            );
        });
    });

    it('returns empty state before cache repositories are configured', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        const roomListener = vi.fn();
        const peopleListener = vi.fn();

        expect(facade.rooms.state().rooms).toEqual([]);
        expect(facade.rooms.state().members).toEqual([]);
        expect(facade.people.state().people).toEqual([]);
        expect(facade.people.state().clients).toEqual([]);
        expect(facade.people.get('principal-1')).toBeUndefined();

        facade.rooms.onChange(roomListener);
        facade.people.onChange(peopleListener);

        expect(roomListener).toHaveBeenCalledWith(
            expect.objectContaining({ rooms: [], members: [] }),
        );
        expect(peopleListener).toHaveBeenCalledWith(
            expect.objectContaining({ people: [], clients: [] }),
        );
    });

    it('filters cached room state to the configured facade scope', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        const arRoom = createGroupSnapshot('arena-room', ['session-1'], {
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
        });
        const staleRallarRoom = createGroupSnapshot('stale-room', ['session-1'], {
            applicationId: 'rallar-server',
            workspaceId: 'default',
        });

        facade.setDefaults({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
        });
        mocks.groupRepositoryMissing.mockImplementation((roomRef?: unknown) => {
            if (roomRef === undefined) {
                return [staleRallarRoom, arRoom];
            }

            if (typeof roomRef === 'string') {
                return arRoom.group;
            }

            if (isGroupRefLike(roomRef)) {
                return roomRef.applicationId === 'ar-eye-hunter' &&
                        roomRef.groupId === 'arena-room'
                    ? arRoom
                    : undefined;
            }
        });

        expect(facade.rooms.state().rooms.map((room) => room.roomId)).toEqual([
            'arena-room',
        ]);
        expect(facade.rooms.state().currentRoomRef).toEqual(arRoom.group);
    });
});

function isGroupRefLike(value: unknown): value is GroupSnapshot['group'] {
    return typeof value === 'object' &&
        value !== null &&
        typeof (value as { groupId?: unknown }).groupId === 'string' &&
        typeof (value as { applicationId?: unknown }).applicationId === 'string';
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }> = {},
): GroupSnapshot {
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';
    return createGroupSnapshotFixture({
        applicationId,
        workspaceId,
        groupId,
        sessionIds,
    });
}
