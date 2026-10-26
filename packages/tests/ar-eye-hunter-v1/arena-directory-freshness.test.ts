// @vitest-environment happy-dom
import {
    ArenaRuntimeTestHarness,
    mockRallar,
    waitForState
} from './arena-runtime-test-harness.ts';

import type { GroupDirectoryEntry } from '@shared/api/group-directory/group-directory-types.ts';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const publicArena: GroupDirectoryEntry = {
    groupRef: { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'public-arena' },
    displayName: 'AR Eye Hunter Arena: Public',
    kind: 'room',
    joinMode: 'open',
    memberCount: 1,
    onlineMemberCount: 1,
    maxMembers: 4,
    isFull: false,
    lifecycleState: 'active',
    peerRttMs: null
};

describe('arena automatic directory', () => {
    const arena = new ArenaRuntimeTestHarness();
    beforeEach(() => arena.reset());
    afterEach(() => arena.dispose());

    it('discovers public arenas after connecting without refreshing or replacing the current room', async () => {
        mockRallar.rooms.directory.mockResolvedValue({ entries: [publicArena], nextCursor: null });
        await arena.render();
        await waitForState(() => arena.current?.openRoomsStatus === 'ready');

        expect(arena.current?.openRooms).toEqual([publicArena]);
        expect(arena.current?.roomId).toBe('arena-1');
        expect(arena.current?.rooms).toHaveLength(1);
        expect(mockRallar.rooms.refresh).not.toHaveBeenCalled();
    });
    it('pauses browser discovery while hidden or offline and refreshes when foreground connectivity returns', async () => {
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
        mockRallar.rooms.directory.mockResolvedValue({ entries: [publicArena], nextCursor: null });
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        expect(arena.current?.openRoomsStatus).toBe('idle');
        await act(async () => {
            visibility.mockReturnValue('visible');
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await waitForState(() => arena.current?.openRoomsStatus === 'ready');
        expect(arena.current?.openRooms).toEqual([publicArena]);
        await act(async () => {
            online.mockReturnValue(false);
            window.dispatchEvent(new Event('offline'));
        });
        mockRallar.rooms.directory.mockResolvedValue({ entries: [], nextCursor: null });
        await act(async () => {
            visibility.mockReturnValue('hidden');
            document.dispatchEvent(new Event('visibilitychange'));
            visibility.mockReturnValue('visible');
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(arena.current?.openRooms).toEqual([publicArena]);
        await act(async () => {
            online.mockReturnValue(true);
            window.dispatchEvent(new Event('online'));
        });
        await waitForState(() => arena.current?.openRooms.length === 0);
        expect(arena.current?.roomId).toBe('arena-1');
        expect(mockRallar.rooms.refresh).not.toHaveBeenCalled();
    });
});
