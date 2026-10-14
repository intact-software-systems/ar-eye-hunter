import {
    beforeEach,
    expect,
    it
} from 'vitest';

import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createRoomSnapshot,
    getRoomWorkflowMocks,
    resetRoomWorkflowTestRuntime
} from './room-workflow-test-runtime.ts';

const roomWorkflowMocks = getRoomWorkflowMocks();

installFakeBroadcastChannelPerTest();

beforeEach(resetRoomWorkflowTestRuntime);

it('routes an invite through the room membership owner', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const snapshot = createRoomSnapshot('room-1', ['session-1']);
    roomWorkflowMocks.createStateGroupInvite.mockResolvedValue(snapshot);

    await expect(createRallarFacade().rooms.invite('room-1', 'principal-2')).resolves.toBe(snapshot);

    expect(roomWorkflowMocks.createStateGroupInvite).toHaveBeenCalledWith(
        {
            groupId: 'room-1',
            targetPrincipalId: 'principal-2',
            request: {},
            actorPrincipalId: 'principal-1',
            sessionId: 'session-1',
            scope: { applicationId: 'rallar-server', workspaceId: 'default' },
            policies: {}
        }
    );
});
