import { beforeEach, describe, expect, it } from 'vitest';

import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';

import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createRoomSnapshot,
    getRoomWorkflowMocks,
    mockRoomCreateSuccess,
    mockRoomJoinSuccess,
    resetRoomWorkflowTestRuntime
} from './room-workflow-test-runtime.ts';

const roomWorkflowMocks = getRoomWorkflowMocks();

installFakeBroadcastChannelPerTest();

describe('room entry registers the page\'s publication key on the presence row', () => {
    beforeEach(resetRoomWorkflowTestRuntime);

    it('joins with the page key', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockRoomJoinSuccess(createRoomSnapshot('room-1', ['session-1']));

        await createRallarFacade().rooms.join({ roomId: 'room-1', leaveCurrent: false });

        expect(roomWorkflowMocks.joinStateGroup).toHaveBeenCalledWith(
            expect.objectContaining({ publicationKey: readPagePublicationKey() })
        );
    });

    it('creates and joins with the page key', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mockRoomCreateSuccess(createRoomSnapshot('new-room', ['session-1']));

        await createRallarFacade().rooms.create({ displayName: 'New Room' });

        expect(roomWorkflowMocks.createAndJoinStateGroup).toHaveBeenCalledWith(
            expect.objectContaining({ publicationKey: readPagePublicationKey() })
        );
    });

    it('accepts an invite with the page key', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        roomWorkflowMocks.acceptStateGroupInvite.mockResolvedValueOnce(createRoomSnapshot('room-1', ['session-1']));

        await createRallarFacade().rooms.acceptInvite('room-1');

        expect(roomWorkflowMocks.acceptStateGroupInvite).toHaveBeenCalledWith(
            expect.objectContaining({ publicationKey: readPagePublicationKey() })
        );
    });
});

function readPagePublicationKey(): ReturnType<typeof toGroupPresencePublicationKey> {
    const publicationKey = toGroupPresencePublicationKey(roomWorkflowMocks.publicationCrypto);
    expect(publicationKey).not.toBeNull();
    return publicationKey;
}
