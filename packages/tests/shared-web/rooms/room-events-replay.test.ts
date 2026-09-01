import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RallarMessage } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import type { StateEventCursor } from '@shared/api/state-event-types.ts';
import {
    createRoomEvent,
    createRoomEventPage,
    dispatchRoomWsMessage,
    readRoomEventMocks,
    resetRoomEventTestRuntime,
    toRoomEventEnvelopeMessage
} from './room-event-test-runtime.ts';

interface ReplayPageRequest {
    readonly roomId: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly limit: number | undefined;
    readonly after: StateEventCursor | undefined;
}

describe('room event replay', () => {
    beforeEach(resetRoomEventTestRuntime);

    it('replays explicitly and deduplicates overlap with live room events', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readRoomEventMocks();
        const facade = createRallarFacade();
        const liveEvents: GroupEvent[] = [];
        const replayEvents: GroupEvent[] = [];
        const replayMessages: RallarMessage<GroupEvent>[] = [];
        const live = createRoomEvent({ groupId: 'room-1', eventId: 'event-1', eventType: 'member-joined' });
        const replayed = createRoomEvent({
            groupId: 'room-1',
            eventId: 'event-2',
            eventType: 'member-left',
            snapshotVersion: 2,
            occurredAtEpochMs: 2
        });
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.rooms.onEvent((event) => {
            liveEvents.push(event);
        }, { roomId: 'room-1' });
        mocks.listStateGroupEventPage.mockResolvedValue(createRoomEventPage([live, replayed], false));
        await facade.connect();
        await dispatchRoomWsMessage(toRoomEventEnvelopeMessage(live));

        const result = await facade.rooms.replayEvents(
            {
                roomId: 'room-1',
                after: { snapshotVersion: 1, occurredAtEpochMs: 1, eventId: 'event-1' },
                limit: 2
            },
            (event, message) => {
                replayEvents.push(event);
                replayMessages.push(message);
            }
        );
        await dispatchRoomWsMessage(toRoomEventEnvelopeMessage(replayed));

        expect(liveEvents.map((event) => event.eventId)).toEqual(['event-1']);
        expect(replayEvents).toEqual([replayed]);
        expect(replayMessages[0]).toMatchObject({
            transport: 'replay',
            typeId: AppTopics.groupStateEvent,
            topicId: AppTopics.groupStateEvent
        });
        expect({ event: replayEvents[0], message: replayMessages[0] }).toEqual({
            event: replayed,
            message: expect.objectContaining({
                transport: 'replay',
                typeId: AppTopics.groupStateEvent,
                topicId: AppTopics.groupStateEvent
            })
        });
        expect(result).toMatchObject({
            events: [replayed],
            duplicateCount: 1,
            replayedCount: 1,
            pageCount: 1,
            hasMore: false
        });
        expect(result).toEqual({
            events: [replayed],
            nextCursor: { snapshotVersion: 2, occurredAtEpochMs: 2, eventId: 'event-2' },
            hasMore: false,
            pageCount: 1,
            replayedCount: 1,
            duplicateCount: 1
        });
        expect(mocks.listStateGroupEventPage).toHaveBeenCalledWith(
            'room-1',
            { applicationId: 'app-1', workspaceId: 'workspace-1' },
            {
                after: { snapshotVersion: 1, occurredAtEpochMs: 1, eventId: 'event-1' },
                limit: 2,
                signal: expect.any(AbortSignal)
            }
        );
    });

    it('continues room replay across pages until completion', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readRoomEventMocks();
        const facade = createRallarFacade();
        const observedEvents: GroupEvent[] = [];
        const pageRequests: ReplayPageRequest[] = [];
        const first = createRoomEvent({ groupId: 'room-1', eventId: 'event-1', eventType: 'member-joined' });
        const second = createRoomEvent({
            groupId: 'room-1',
            eventId: 'event-2',
            eventType: 'member-left',
            snapshotVersion: 2,
            occurredAtEpochMs: 2
        });
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.rooms.onEvent((event) => {
            observedEvents.push(event);
        }, { roomId: 'room-1' });
        mocks.listStateGroupEventPage.mockImplementation(
            async (roomId, scope, options) => {
                if (!scope || !options) {
                    throw new Error('Room replay must provide scope and page options');
                }
                pageRequests.push({
                    roomId,
                    applicationId: scope.applicationId,
                    workspaceId: scope.workspaceId,
                    limit: options.limit,
                    after: options.after
                });
                return options.after
                    ? createRoomEventPage([second], false)
                    : createRoomEventPage([first], true);
            }
        );

        const result = await facade.rooms.replayEvents({
            roomId: 'room-1',
            limit: 1,
            maxPages: 2
        });

        expect(observedEvents).toEqual([first, second]);
        expect(result).toMatchObject({
            events: [first, second],
            nextCursor: { snapshotVersion: 2, occurredAtEpochMs: 2, eventId: 'event-2' },
            hasMore: false,
            pageCount: 2,
            replayedCount: 2,
            duplicateCount: 0
        });
        expect(result).toEqual({
            events: [first, second],
            nextCursor: { snapshotVersion: 2, occurredAtEpochMs: 2, eventId: 'event-2' },
            hasMore: false,
            pageCount: 2,
            replayedCount: 2,
            duplicateCount: 0
        });
        expect(pageRequests).toEqual([
            {
                roomId: 'room-1',
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                limit: 1,
                after: undefined
            },
            {
                roomId: 'room-1',
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                limit: 1,
                after: {
                    snapshotVersion: 1,
                    occurredAtEpochMs: 1,
                    eventId: 'event-1'
                }
            }
        ]);
    });

    it('stops room replay at maxPages while preserving the continuation cursor', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readRoomEventMocks();
        const facade = createRallarFacade();
        const event = createRoomEvent({ groupId: 'room-1', eventId: 'event-1', eventType: 'member-joined' });
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.rooms.onEvent(vi.fn(), { roomId: 'room-1' });
        mocks.listStateGroupEventPage.mockResolvedValue(createRoomEventPage([event], true));

        const result = await facade.rooms.replayEvents({
            roomId: 'room-1',
            limit: 1,
            maxPages: 1
        });

        expect(result).toEqual({
            events: [event],
            nextCursor: { snapshotVersion: 1, occurredAtEpochMs: 1, eventId: 'event-1' },
            hasMore: true,
            pageCount: 1,
            replayedCount: 1,
            duplicateCount: 0
        });
    });
});
