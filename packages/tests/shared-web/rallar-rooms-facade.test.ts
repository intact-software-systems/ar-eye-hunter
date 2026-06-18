import { describe, expect, it, vi } from 'vitest';
import type { GroupEvent, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import { createRallarRoomsFacade } from '@shared-web/browser/rallar-rooms-facade.ts';
import type {
    RallarReplayEventsResult,
    RallarRoomEventListener,
    RallarRoomState,
    RallarStateListener,
} from '@shared-web/browser/rallar.ts';

describe('Rallar rooms facade factory', () => {
    it('delegates room methods through injected operations', async () => {
        const roomRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
        } satisfies GroupRef;
        const snapshot = {
            group: roomRef,
        } as GroupSnapshot;
        const state = {
            rooms: [],
            currentRoomId: 'room-1',
            currentRoomRef: roomRef,
            currentRoom: snapshot,
            members: [],
        } satisfies RallarRoomState;
        const event = {} as GroupEvent;
        const page = {
            events: [event],
            hasMore: false,
        } as unknown as StateEventPage<GroupEvent>;
        const replay = {
            events: [event],
            hasMore: false,
            pageCount: 1,
            replayedCount: 1,
            duplicateCount: 0,
        } satisfies RallarReplayEventsResult<GroupEvent>;
        const unsubscribe = vi.fn();
        const stateListener = vi.fn() as RallarStateListener<RallarRoomState>;
        const eventListener = vi.fn() as RallarRoomEventListener;
        const operations = {
            state: vi.fn(() => state),
            list: vi.fn(() => state.rooms),
            refresh: vi.fn(async () => state),
            listEvents: vi.fn(async () => [event]),
            listEventPage: vi.fn(async () => page),
            replayEvents: vi.fn(async () => replay),
            create: vi.fn(async () => snapshot),
            createAndSwitch: vi.fn(async () => snapshot),
            join: vi.fn(async () => snapshot),
            leave: vi.fn(async () => snapshot),
            updateMetadata: vi.fn(async () => snapshot),
            current: vi.fn(() => snapshot),
            onChange: vi.fn(() => unsubscribe),
            onEvent: vi.fn(() => unsubscribe),
        };

        const facade = createRallarRoomsFacade(operations);

        expect(facade.state()).toBe(state);
        expect(facade.list()).toBe(state.rooms);
        await expect(
            facade.refresh({
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
            }),
        ).resolves.toBe(state);
        await expect(facade.listEvents('room-1')).resolves.toEqual([event]);
        await expect(
            facade.listEventPage({ roomRef, limit: 1 }),
        ).resolves.toBe(page);
        await expect(
            facade.replayEvents({ roomRef, maxPages: 1 }, eventListener),
        ).resolves.toBe(replay);
        await expect(facade.create('Room 1')).resolves.toBe(snapshot);
        await expect(facade.createAndSwitch('Room 2')).resolves.toBe(snapshot);
        await expect(
            facade.join(roomRef, { leaveCurrent: false }),
        ).resolves.toBe(snapshot);
        await expect(facade.leave({ roomRef })).resolves.toBe(snapshot);
        await expect(
            facade.updateMetadata(roomRef, { topic: 'maps' }, { timeoutMs: 25 }),
        ).resolves.toBe(snapshot);
        expect(facade.current()).toBe(snapshot);
        expect(facade.onChange(stateListener, { emitCurrent: false })).toBe(
            unsubscribe,
        );
        expect(facade.onEvent(eventListener, { roomRef })).toBe(unsubscribe);

        expect(operations.refresh).toHaveBeenCalledWith({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
        expect(operations.listEvents).toHaveBeenCalledWith('room-1');
        expect(operations.listEventPage).toHaveBeenCalledWith({
            roomRef,
            limit: 1,
        });
        expect(operations.replayEvents).toHaveBeenCalledWith(
            { roomRef, maxPages: 1 },
            eventListener,
        );
        expect(operations.create).toHaveBeenCalledWith('Room 1');
        expect(operations.createAndSwitch).toHaveBeenCalledWith('Room 2');
        expect(operations.join).toHaveBeenCalledWith(roomRef, {
            leaveCurrent: false,
        });
        expect(operations.leave).toHaveBeenCalledWith({ roomRef });
        expect(operations.updateMetadata).toHaveBeenCalledWith(
            roomRef,
            { topic: 'maps' },
            { timeoutMs: 25 },
        );
        expect(operations.onChange).toHaveBeenCalledWith(stateListener, {
            emitCurrent: false,
        });
        expect(operations.onEvent).toHaveBeenCalledWith(eventListener, {
            roomRef,
        });
    });
});
