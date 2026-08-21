import { beforeEach, describe, expect, it } from 'vitest';

import {
    createRoomSnapshot,
    readRoomWorkflowMocks,
    resetRoomWorkflowTestRuntime,
    resolveCreateWith,
    resolveLeaveWith,
    seedRoomSnapshots
} from './room-workflow-test-runtime.ts';

const roomWorkflowMocks = readRoomWorkflowMocks();

describe('room leave operations', () => {
    beforeEach(resetRoomWorkflowTestRuntime);

    it('exposes the owning leave operation entry', async () => {
        const { leaveRoom } = await import('@shared-web/browser/rooms/leave-room.ts');
        expect(typeof leaveRoom).toBe('function');
    });

    it('returns and hydrates the workflow snapshot while clearing current', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const currentRoom = createRoomSnapshot('room-1', ['session-1']);
        const leftRoom = createRoomSnapshot('room-1', []);
        const signal = new AbortController().signal;
        seedRoomSnapshots([currentRoom]);
        resolveLeaveWith(leftRoom);
        const facade = createRallarFacade();

        await expect(
            facade.rooms.leave({
                roomRef: currentRoom.group,
                signal,
                timeoutMs: 33
            })
        ).resolves.toBe(leftRoom);

        expect(roomWorkflowMocks.leaveStateGroup).toHaveBeenCalledWith(
            'room-1',
            'principal-1',
            'session-1',
            undefined,
            { applicationId: 'app-1', workspaceId: 'workspace-1' },
            { command: { signal, timeoutMs: 33 } }
        );
        expect(roomWorkflowMocks.operationLog).toEqual(['leave:room-1', 'hydrate:room-1']);
        expect(facade.rooms.current()).toBeUndefined();
        expect(facade.rooms.list()[0]?.snapshot).toBe(leftRoom);
    });

    it('can preserve current selection for room switching', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const oldRoom = createRoomSnapshot('old-room', ['session-1']);
        const newRoom = createRoomSnapshot('new-room', ['session-1']);
        seedRoomSnapshots([oldRoom]);
        resolveCreateWith(newRoom);
        resolveLeaveWith(createRoomSnapshot('old-room', []));
        const facade = createRallarFacade();
        await facade.rooms.create('New Room');
        roomWorkflowMocks.operationLog.length = 0;

        await facade.rooms.leave({
            roomRef: oldRoom.group,
            clearCurrent: false
        });

        expect(roomWorkflowMocks.operationLog).toEqual(['leave:old-room', 'hydrate:old-room']);
        expect(facade.rooms.current()).toBe(newRoom);
        expect(facade.rooms.state().currentRoomRef).toEqual(newRoom.group);
    });

    it('returns undefined without a workflow when no room can be resolved', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');

        await expect(createRallarFacade().rooms.leave()).resolves.toBeUndefined();

        expect(roomWorkflowMocks.leaveStateGroup).not.toHaveBeenCalled();
        expect(roomWorkflowMocks.hydrateStateCaches).not.toHaveBeenCalled();
        expect(roomWorkflowMocks.operationLog).toEqual([]);
    });
});
