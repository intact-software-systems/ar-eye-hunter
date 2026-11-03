// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

// Load consumers after the harness has registered its browser ports.
const { ArenaRoomEntry } = await import('../../../apps/ar-eye-hunter-v1/src/arena-ui/arena-room-entry.tsx');
const { arenaRecentRooms, arenaRoomEntry } = await import('../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/arena-room-entry.ts');
import { ArenaRuntimeTestHarness, emitAuthState, mockRallar, session, waitForState } from './arena-runtime-test-harness.ts';

describe('arena recent-room navigation', () => {
    it('starts history with the connection and supports visible Return/Forget without leaking it after sign-out', async () => {
        const arena = new ArenaRuntimeTestHarness();
        arena.reset();
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        try {
            await arena.render();
            await waitForState(() => arena.current?.connectionState === 'connected');
            await arenaRecentRooms.whenIdle();
            expect(arenaRecentRooms.getState().status).toBe('ready');
            mockRallar.rooms.join.mockImplementation(async (roomRef) => createGroupSnapshotFixture({ ...roomRef, sessionIds: [session.sessionId] }));
            for (const groupId of ['room-a', 'room-b']) {
                await act(async () => {
                    arenaRoomEntry.enter({
                        intent: 'join',
                        roomRef: { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId },
                        joinCode: null,
                        participation: 'preserve'
                    });
                    await arenaRoomEntry.resume();
                    await arenaRecentRooms.whenIdle();
                });
            }
            const connected = arena.current;
            if (!connected) {
                throw new Error('The arena must be connected before rendering its entry controls.');
            }
            await act(async () => root.render(createElement(ArenaRoomEntry, { arena: connected })));
            const click = async (label: string) => {
                const button = [...container.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === label);
                if (!button) {
                    throw new Error(`Expected the visible control: ${label}`);
                }
                await act(async () => {
                    button.click();
                    await arenaRoomEntry.resume();
                    await arenaRecentRooms.whenIdle();
                });
            };
            await click('Return to room-a');
            expect(arenaRoomEntry.getState()).toMatchObject({ status: 'entered', destination: { roomRef: { groupId: 'room-a' } } });
            await click('Forget room-b');
            expect(container.querySelector('[aria-label="Return to room-b"]')).toBeNull();
            await emitAuthState({ authenticated: false, reason: 'logout', session: undefined });
            expect(container.querySelector('[aria-label="Return to room-a"]')).toBeNull();
            expect(arenaRecentRooms.getState()).toMatchObject({ status: 'signed-out', rooms: [] });
        }
        finally {
            await act(async () => root.unmount());
            container.remove();
            await arena.dispose();
            await arenaRecentRooms.whenIdle();
        }
    });
});
