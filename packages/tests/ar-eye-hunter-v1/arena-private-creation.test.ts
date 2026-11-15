// @vitest-environment happy-dom
import { ArenaRuntimeTestHarness, mockRallar, waitForState } from './arena-runtime-test-harness.ts';

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GroupRef } from '@shared/api/group-types.ts';
import { ArenaRoomHosting } from '../../../apps/ar-eye-hunter-v1/src/arena-ui/arena-room-hosting.tsx';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

describe('AR Eye private arena creation', () => {
    const arena = new ArenaRuntimeTestHarness();

    beforeEach(async () => {
        arena.reset();
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
    });

    afterEach(() => arena.dispose());

    it('keeps the created private room available for sharing when previous membership cannot be left', async () => {
        const room = createGroupSnapshotFixture({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            groupId: 'new-private-arena',
            sessionIds: ['session-1']
        });
        const snapshot = { ...room, group: { ...room.group, joinMode: 'code' as const } };
        const state = { rooms: [], currentRoom: snapshot, currentRoomRef: snapshot.group, currentRoomId: snapshot.group.groupId };
        mockRallar.rooms.state.mockReturnValue(state);
        mockRallar.rooms.refresh.mockResolvedValue(state);
        mockRallar.rooms.createAndSwitch.mockRejectedValue(Object.assign(new Error('Cannot remove last owner'), {
            name: 'RallarRoomSwitchPartialFailureError',
            operation: 'create-and-switch',
            joinedRoom: snapshot,
            previousRoomRef: { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'old-arena' },
            leaveError: new Error('Cannot remove last owner')
        }));

        await act(async () => {
            await expect(arena.current?.createArenaRoom('code')).resolves.toEqual(snapshot);
        });

        expect(arena.current?.roomId).toBe('new-private-arena');
        expect(arena.current?.error).toBe('The new arena is ready, but leaving the previous arena failed. Your membership there remains.');
        expect(mockRallar.rooms.createAndSwitch).toHaveBeenCalledWith({
            displayName: expect.stringContaining('AR Eye Hunter Arena:'),
            joinMode: 'code',
            maxSpectators: 16,
            retention: { mode: 'temporary', reconnectGraceMs: 600_000 }
        });
    });

    it('issues the join code for the created room when leaving the previous room fails before the cache observes the host in it', async () => {
        const previous = createGroupSnapshotFixture({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            groupId: 'previous-arena',
            sessionIds: ['hunter-1']
        });
        const joined = createGroupSnapshotFixture({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            groupId: 'new-private-arena',
            sessionIds: ['hunter-1']
        });
        // The joined room's snapshot does not list the host's session yet, so the cache still resolves the previous room.
        const created = { ...joined, group: { ...joined.group, joinMode: 'code' as const }, activeSessions: [], onlineMemberCount: 0 };
        const state = { rooms: [], currentRoom: previous, currentRoomRef: previous.group, currentRoomId: previous.group.groupId };
        mockRallar.rooms.state.mockReturnValue(state);
        mockRallar.rooms.refresh.mockResolvedValue({
            rooms: [{
                roomId: created.group.groupId,
                roomRef: created.group,
                name: 'New private arena',
                status: 'active',
                kind: 'room',
                joinMode: 'code',
                memberCount: 1,
                onlineMemberCount: 0,
                isJoined: true,
                isCurrent: true,
                snapshot: created
            }],
            currentRoomId: created.group.groupId
        });
        mockRallar.rooms.createAndSwitch.mockRejectedValue(Object.assign(new Error('Cannot remove last owner'), {
            name: 'RallarRoomSwitchPartialFailureError',
            operation: 'create-and-switch',
            joinedRoom: created,
            previousRoomRef: previous.group,
            leaveError: new Error('Cannot remove last owner')
        }));
        // Server-side join codes: a rotate issues a code for the room it names.
        const issuedJoinCodes = new Map<string, string>();
        mockRallar.rooms.rotateJoinCode.mockImplementation(async (room: GroupRef) => {
            issuedJoinCodes.set(room.groupId, `code-for-${room.groupId}`);
            return {
                joinCode: `code-for-${room.groupId}`,
                expiresAtEpochMs: 4_000_000_000_000,
                snapshot: room.groupId === created.group.groupId ? created : previous
            };
        });
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const renderHosting = () => root.render(createElement(ArenaRoomHosting, { arena: requireArena() }));
        try {
            await act(async () => renderHosting());
            const create = [...container.querySelectorAll('button')].find((button) => button.textContent === 'New code arena');
            await act(async () => create?.click());
            await act(async () => renderHosting());

            expect(issuedJoinCodes.has(created.group.groupId)).toBe(true);
            expect(issuedJoinCodes.has(previous.group.groupId)).toBe(false);
            const link = [...container.querySelectorAll('label')].find((label) => label.textContent?.startsWith('Room link'))?.querySelector('input');
            expect(link?.value).toContain('joinCode=code-for-new-private-arena');
            expect(arena.current?.error).toBe('The new arena is ready, but leaving the previous arena failed. Your membership there remains.');
        }
        finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    function requireArena() {
        if (!arena.current) {
            throw new Error('The arena runtime must be mounted');
        }
        return arena.current;
    }
});
