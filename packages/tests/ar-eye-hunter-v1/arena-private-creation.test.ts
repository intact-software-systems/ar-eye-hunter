// @vitest-environment happy-dom
import { ArenaRuntimeTestHarness, mockRallar, waitForState } from './arena-runtime-test-harness.ts';

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
