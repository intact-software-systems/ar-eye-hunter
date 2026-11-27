import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { installFakeBroadcastChannelPerTest } from '../../data/rallar-data-test-runtime.ts';
import {
    createRallarTestFacade,
    getRallarFacadeMocks,
    resetRallarFacadeTestRuntime
} from '../rallar-facade-test-runtime.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const mocks = getRallarFacadeMocks();

installFakeBroadcastChannelPerTest();

/** A message of stream `s` as a sender page's edge-ordered channel builds it, with nothing earlier ended. */
function toStampedMove(position: number): ALMessage {
    return newALMulticastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'alice-session',
        route: newALRoute('room.moves', ROOM.groupId, `move-${position}`),
        groupRef: ROOM,
        typeId: 'game.move',
        resource: {
            edgeOrder: { stream: 's', position, lowestOpenPosition: 1, earlierCanArriveUntilMs: Date.now() + 30_000 },
            payload: { n: position }
        },
        options: { ttlMs: 30_000, reliability: 'at-least-once', ack: 'receiver' }
    });
}

/** Hands a WS arrival to the facade through the inbox callback its current connect registered. */
async function deliverWs(message: ALMessage): Promise<void> {
    const registered = vi.mocked(mocks.apiMiddleware.middleware.webSocketQueueBox.onAnyInboxMessageDo).mock.calls.at(-1);
    await registered?.[1].onMessage(message, toResourceEntry(message.payload.typeId, {}));
}

describe('edge order across a disconnect', () => {
    beforeEach(() => {
        resetRallarFacadeTestRuntime();
    });

    it('drops the messages it holds when the page disconnects, and goes on from the same position after it reconnects', async () => {
        const facade = createRallarTestFacade();
        await facade.connect();
        const seen: number[] = [];
        facade.messages.room<{ n: number; }>({
            roomRef: ROOM,
            topicId: 'room.moves',
            typeId: 'game.move',
            purpose: 'command',
            access: 'members',
            order: 'edge'
        }).onWs((payload) => {
            seen.push(payload.n);
        });
        await deliverWs(toStampedMove(1));
        await deliverWs(toStampedMove(3));
        expect(seen).toEqual([1]);

        await facade.disconnect();
        await facade.connect();
        await deliverWs(toStampedMove(2));

        // Message 3 was held when the connect went away, so it is gone: handing over 2 does not bring it.
        expect(seen).toEqual([1, 2]);
    });
});
