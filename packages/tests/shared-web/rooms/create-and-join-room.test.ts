import { beforeEach, describe, expect, it } from 'vitest';

import {
    createRoomSnapshot,
    readRoomWorkflowMocks,
    rejectCreateWith,
    rejectLeaveWith,
    resetRoomWorkflowTestRuntime,
    resolveCreateWith,
    resolveLeaveWith,
    seedRoomSnapshots
} from './room-workflow-test-runtime.ts';

const roomWorkflowMocks = readRoomWorkflowMocks();

describe('room create operations', () => {
    beforeEach(resetRoomWorkflowTestRuntime);

    it('exposes the owning create operation entries', async () => {
        const { createAndJoinRoom, createAndSwitchRoom } = await import('@shared-web/browser/rooms/create-and-join-room.ts');
        expect(typeof createAndJoinRoom).toBe('function');
        expect(typeof createAndSwitchRoom).toBe('function');
    });

    it('returns the authoritative snapshot and hydrates current room state', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createRoomSnapshot('created-room', ['session-1']);
        resolveCreateWith(snapshot);
        const facade = createRallarFacade();

        await expect(facade.rooms.create('Created Room')).resolves.toBe(snapshot);

        expect(roomWorkflowMocks.operationLog).toEqual(['create:Created Room', 'hydrate:created-room']);
        expect(facade.rooms.current()).toBe(snapshot);
        expect(facade.rooms.state().currentRoomRef).toEqual(snapshot.group);
    });

    it('forwards only the supported room fields and command options', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
        resolveCreateWith(createRoomSnapshot('custom-room', ['session-1']));

        await createRallarFacade().rooms.create({
            groupId: 'custom-room',
            displayName: 'Custom Room',
            description: 'Mission lobby',
            joinMode: 'open',
            maxMembers: 8,
            maxSessionsPerMember: 2,
            metadata: { map: 'fjord' },
            lifecyclePolicy: { preset: 'managed' },
            scope,
            timeoutMs: 55
        });

        expect(roomWorkflowMocks.createAndJoinStateGroup).toHaveBeenCalledWith(
            {
                displayName: 'Custom Room',
                principalId: 'principal-1',
                sessionId: 'session-1',
                generationId: 'generation-session-1',
                scope,
                policies: { command: { timeoutMs: 55 } },
                requestedGroupId: 'custom-room',
                options: {
                    description: 'Mission lobby',
                    joinMode: 'open',
                    maxMembers: 8,
                    maxSessionsPerMember: 2,
                    metadata: { map: 'fjord' },
                    lifecyclePolicy: { preset: 'managed' }
                }
            }
        );
    });

    it('leaves the previous room only after the new room is accepted', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const oldRoom = createRoomSnapshot('old-room', ['session-1']);
        const newRoom = createRoomSnapshot('new-room', ['session-1']);
        const leftOldRoom = createRoomSnapshot('old-room', []);
        seedRoomSnapshots([oldRoom]);
        resolveCreateWith(newRoom);
        resolveLeaveWith(leftOldRoom);
        const facade = createRallarFacade();

        await expect(facade.rooms.createAndSwitch({ displayName: 'New Room' })).resolves.toBe(newRoom);

        expect(roomWorkflowMocks.operationLog).toEqual([
            'create:New Room',
            'hydrate:new-room',
            'leave:old-room',
            'hydrate:old-room'
        ]);
        expect(facade.rooms.current()).toBe(newRoom);
    });

    it('reports leave failure while retaining the new current room', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const oldRoom = createRoomSnapshot('old-room', ['session-1']);
        const newRoom = createRoomSnapshot('new-room', ['session-1']);
        const leaveError = new Error('leave failed');
        seedRoomSnapshots([oldRoom]);
        resolveCreateWith(newRoom);
        rejectLeaveWith(leaveError);
        const facade = createRallarFacade();

        await expect(facade.rooms.createAndSwitch({ displayName: 'New Room' })).rejects.toMatchObject({
            name: 'RallarRoomSwitchPartialFailureError',
            operation: 'create-and-switch',
            joinedRoom: newRoom,
            previousRoomRef: oldRoom.group,
            leaveError
        });
        expect(facade.rooms.current()).toBe(newRoom);
        expect(facade.rooms.state().currentRoomRef).toEqual(newRoom.group);
        expect(roomWorkflowMocks.operationLog).toEqual([
            'create:New Room',
            'hydrate:new-room',
            'leave:old-room'
        ]);
    });

    it('does not leave when create fails', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const oldRoom = createRoomSnapshot('old-room', ['session-1']);
        seedRoomSnapshots([oldRoom]);
        rejectCreateWith(new Error('create failed'));
        const facade = createRallarFacade();

        await expect(facade.rooms.createAndSwitch({ displayName: 'New Room' })).rejects.toThrow(
            'create failed'
        );

        expect(roomWorkflowMocks.operationLog).toEqual(['create:New Room']);
        expect(roomWorkflowMocks.leaveStateGroup).not.toHaveBeenCalled();
        expect(facade.rooms.current()).toBe(oldRoom);
    });
});
