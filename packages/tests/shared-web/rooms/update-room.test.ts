import { beforeEach, expect, it } from 'vitest';

import { createRoomSnapshot, readRoomWorkflowMocks, resetRoomWorkflowTestRuntime } from './room-workflow-test-runtime.ts';

const roomWorkflowMocks = readRoomWorkflowMocks();

beforeEach(resetRoomWorkflowTestRuntime);

it('exposes the owning room update operations', async () => {
    const { archiveRoom, deleteRoom, updateRoom, updateRoomMetadata } = await import('@shared-web/browser/rooms/update-room.ts');
    expect(typeof updateRoom).toBe('function');
    expect(typeof archiveRoom).toBe('function');
    expect(typeof deleteRoom).toBe('function');
    expect(typeof updateRoomMetadata).toBe('function');
});

it('routes a detail update through the room update owner', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const snapshot = createRoomSnapshot('room-1', ['session-1']);
    roomWorkflowMocks.updateStateGroupDetails.mockResolvedValue(snapshot);

    await expect(
        createRallarFacade().rooms.update({ roomId: 'room-1', displayName: 'Room 1' })
    ).resolves.toBe(snapshot);

    expect(roomWorkflowMocks.updateStateGroupDetails).toHaveBeenCalledWith(
        {
            groupId: 'room-1',
            request: { displayName: 'Room 1' },
            principalId: 'principal-1',
            sessionId: 'session-1',
            scope: { applicationId: 'rallar-server', workspaceId: 'default' },
            policies: {}
        }
    );
});
