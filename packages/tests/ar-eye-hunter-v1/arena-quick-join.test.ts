// @vitest-environment happy-dom
import { arenaRoomRef, ArenaRuntimeTestHarness, arenaSnapshot, emitAuthState, mockRallar, session, waitForState } from './arena-runtime-test-harness.ts';

import { createRallarGameEnvelope } from '@shared-web/game/mod.ts';
import type { QuickJoinGroupResult } from '@shared/api/mutation/group-quick-join.ts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArenaOperations } from '../../../apps/ar-eye-hunter-v1/src/arena-ui/arena-operations.tsx';
import { createArenaRallarGameMatch } from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

describe('AR Eye Quick Join action and controls', () => {
    const arena = new ArenaRuntimeTestHarness();
    let root: Root;
    let container: HTMLDivElement;

    beforeEach(async () => {
        arena.reset();
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        await arena.dispose();
    });

    it('supplies the arena selector and adopts the selected room without creating one', async () => {
        const snapshot = createGroupSnapshotFixture({ applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'selected', sessionIds: ['session-1'] });
        mockRallar.rooms.quickJoin.mockResolvedValue({ status: 'joined', snapshot });
        mockRallar.rooms.refresh.mockResolvedValue({ rooms: [], currentRoomId: 'selected' });

        await act(async () => {
            await arena.current?.quickJoinArenaRoom();
        });

        expect(mockRallar.rooms.quickJoin).toHaveBeenCalledWith({ kind: 'room', q: 'eye hunter' });
        expect(arena.current?.roomId).toBe('selected');
        expect(mockRallar.rooms.createAndSwitch).not.toHaveBeenCalled();
    });

    it('shows progress and unavailable while retaining the current room and New Arena action', async () => {
        const result = Promise.withResolvers<QuickJoinGroupResult>();
        mockRallar.rooms.quickJoin.mockReturnValue(result.promise);
        await renderOperations();

        await act(async () => button('Quick Join').click());
        expect(button('Joining…').disabled).toBe(true);
        expect(button('New Arena')).toBeDefined();
        await act(async () => result.resolve({ status: 'unavailable' }));

        expect(container.textContent).toContain('No available arena. Try again or create one.');
        expect(button('Quick Join').disabled).toBe(false);
        expect(arena.current?.roomId).toBe('arena-1');
    });

    it('shows a failure without treating it as unavailable', async () => {
        mockRallar.rooms.quickJoin.mockRejectedValue(new Error('Admission service unavailable'));
        await renderOperations();

        await act(async () => button('Quick Join').click());

        expect(container.textContent).toContain('Admission service unavailable');
        expect(container.textContent).not.toContain('No available arena.');
        expect(button('Quick Join').disabled).toBe(false);
        expect(arena.current?.roomId).toBe('arena-1');
    });

    it('clears old arena state after a successful switch with failed previous-room cleanup', async () => {
        await act(async () => {
            await vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0].onSnapshot?.(createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'snapshot',
                roomId: 'arena-1',
                senderId: 'director-1',
                seq: 1,
                directorEpoch: 1,
                sentAtEpochMs: 123,
                payload: arenaSnapshot(7)
            }));
        });
        expect(arena.current?.arenaSnapshot?.revision).toBe(7);
        const snapshot = createGroupSnapshotFixture({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'players',
            groupId: 'selected',
            sessionIds: ['session-1']
        });
        const failure = Object.assign(new Error('Joined selected, but leaving arena-1 failed.'), {
            name: 'RallarRoomSwitchPartialFailureError',
            operation: 'quick-join',
            joinedRoom: snapshot,
            previousRoomRef: arenaRoomRef,
            leaveError: new Error('leave failed')
        });
        mockRallar.rooms.quickJoin.mockRejectedValue(failure);
        mockRallar.rooms.state.mockReturnValue({ rooms: [], currentRoomId: 'selected', currentRoomRef: snapshot.group });
        mockRallar.rooms.refresh.mockResolvedValue({ rooms: [], currentRoomId: 'selected' });
        await renderOperations();

        await act(async () => button('Quick Join').click());

        expect(arena.current?.roomId).toBe('selected');
        expect(arena.current?.arenaSnapshot).toBeUndefined();
        expect(vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0].readSnapshot?.()).toBeUndefined();
        expect(container.textContent).toContain(failure.message);
    });

    it('clears the old snapshot as soon as the selected room is published, while cleanup is pending', async () => {
        await act(async () => {
            await vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0].onSnapshot?.(createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'snapshot',
                roomId: 'arena-1',
                senderId: 'director-1',
                seq: 1,
                directorEpoch: 1,
                sentAtEpochMs: 123,
                payload: arenaSnapshot(7)
            }));
        });
        const result = Promise.withResolvers<QuickJoinGroupResult>();
        mockRallar.rooms.quickJoin.mockReturnValue(result.promise);
        await renderOperations();
        await act(async () => button('Quick Join').click());
        const snapshot = createGroupSnapshotFixture({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'players',
            groupId: 'selected',
            sessionIds: ['session-1']
        });
        const selectedState = { rooms: [], currentRoomId: 'selected', currentRoomRef: snapshot.group };
        mockRallar.rooms.state.mockReturnValue(selectedState);
        mockRallar.rooms.refresh.mockResolvedValue(selectedState);

        await act(async () => {
            mockRallar.rooms.onChange.mock.calls.at(-1)?.[0](selectedState);
        });

        expect(button('Joining…').disabled).toBe(true);
        expect(arena.current?.roomId).toBe('selected');
        expect(arena.current?.arenaSnapshot).toBeUndefined();
        expect(vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0].readSnapshot?.()).toBeUndefined();
        await act(async () => {
            await vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0].onSnapshot?.(createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'snapshot',
                roomId: 'selected',
                senderId: 'director-2',
                seq: 2,
                directorEpoch: 2,
                sentAtEpochMs: 234,
                payload: arenaSnapshot(8)
            }));
        });
        await act(async () => result.resolve({ status: 'joined', snapshot }));
        expect(arena.current?.arenaSnapshot?.revision).toBe(8);
    });

    it('discards a completion from the old session after authentication changes', async () => {
        const result = Promise.withResolvers<QuickJoinGroupResult>();
        mockRallar.rooms.quickJoin.mockReturnValue(result.promise);
        let pending: Promise<'joined' | 'unavailable' | undefined> | undefined;
        await act(async () => {
            pending = arena.current?.quickJoinArenaRoom();
        });
        await emitAuthState({ authenticated: true, reason: 'login', session: { ...session, sessionId: 'replacement' } });
        const roomBeforeCompletion = arena.current?.roomId;
        await act(async () => {
            result.resolve({
                status: 'joined',
                snapshot: createGroupSnapshotFixture({
                    applicationId: 'ar-eye-hunter',
                    workspaceId: 'default',
                    groupId: 'old-session-room',
                    sessionIds: ['session-1']
                })
            });
            await pending;
        });

        expect(arena.current?.roomId).toBe(roomBeforeCompletion);
    });

    async function renderOperations(): Promise<void> {
        const current = arena.current;
        if (!current) {
            throw new Error('Arena hook is not mounted');
        }
        await act(async () =>
            root.render(createElement(ArenaOperations, {
                arena: current,
                localColor: '#00ffff',
                matchRemainingMs: 0
            }))
        );
    }

    function button(label: string): HTMLButtonElement {
        const found = [...container.querySelectorAll('button')].find((element) => element.textContent === label);
        if (!found) {
            throw new Error(`Missing button: ${label}`);
        }
        return found;
    }
});
