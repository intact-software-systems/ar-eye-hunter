import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Either } from '@shared/resilience/Either.ts';

import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createRoomSnapshot,
    getRoomWorkflowMocks,
    mockRoomCreateSuccess,
    mockRoomJoinSuccess,
    resetRoomWorkflowTestRuntime
} from './room-workflow-test-runtime.ts';

const roomWorkflowMocks = getRoomWorkflowMocks();
const NOT_OPEN = 'Cannot connect room presence: the WebSocket is not open.';

installFakeBroadcastChannelPerTest();

describe('a room presence connect names the open socket', () => {
    beforeEach(resetRoomWorkflowTestRuntime);

    it('joins under the generation the open socket read, with the heartbeat lease', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const signal = new AbortController().signal;
        mockRoomJoinSuccess(createRoomSnapshot('room-1', ['session-1']));

        await createRallarFacade().rooms.join({ roomId: 'room-1', leaveCurrent: false, signal });

        expect(roomWorkflowMocks.joinStateGroup.mock.calls[0]?.[0].connectionGenerationId).toBe('ws-generation-session-1');
        expect(roomWorkflowMocks.context.middleware.ownWsConnectionGeneration.read).toHaveBeenCalledWith(signal);
    });

    it('refuses a join while no socket generation is known', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        refuseOwnWsConnectionGeneration();

        await expect(createRallarFacade().rooms.join({ roomId: 'room-1', leaveCurrent: false })).rejects.toThrow(NOT_OPEN);
    });

    it('refuses a create-and-join while no socket generation is known', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockRoomCreateSuccess(createRoomSnapshot('new-room', ['session-1']));
        refuseOwnWsConnectionGeneration();

        await expect(createRallarFacade().rooms.create({ displayName: 'New Room' })).rejects.toThrow(NOT_OPEN);
    });

    it('refuses an invite acceptance while no socket generation is known', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        refuseOwnWsConnectionGeneration();

        await expect(createRallarFacade().rooms.acceptInvite('room-1')).rejects.toThrow(NOT_OPEN);
    });

    it('accepts an invite under the open socket\'s generation', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const snapshot = createRoomSnapshot('room-1', ['session-1']);
        roomWorkflowMocks.acceptStateGroupInvite.mockResolvedValueOnce(snapshot);

        await createRallarFacade().rooms.acceptInvite('room-1');

        expect(roomWorkflowMocks.acceptStateGroupInvite.mock.calls[0]?.[0].connectionGenerationId).toBe(
            'ws-generation-session-1'
        );
    });
});

function refuseOwnWsConnectionGeneration(): void {
    vi.mocked(roomWorkflowMocks.context.middleware.ownWsConnectionGeneration.read).mockResolvedValueOnce(
        Either.ofLeft(new Error(NOT_OPEN))
    );
}
