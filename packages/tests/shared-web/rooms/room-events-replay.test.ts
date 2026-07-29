import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppTopics } from '@shared/api/api-config.ts';

import {
  createRoomEvent,
  createRoomEventPage,
  findRoomWsCallback,
  readRoomEventMocks,
  resetRoomEventTestRuntime,
  toRoomEventMessage,
} from './room-event-test-runtime.ts';

describe('room event replay compatibility', () => {
  beforeEach(resetRoomEventTestRuntime);

  it('replays explicitly and deduplicates overlap with live room events', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const mocks = readRoomEventMocks();
    const facade = createRallarFacade();
    const liveListener = vi.fn();
    const replayListener = vi.fn();
    const live = createRoomEvent('room-1', 'event-1', 'member-joined');
    const replayed = createRoomEvent('room-1', 'event-2', 'member-left', {
      snapshotVersion: 2,
      occurredAtEpochMs: 2,
    });
    facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
    facade.rooms.onEvent(liveListener, { roomId: 'room-1' });
    mocks.listStateGroupEventPage.mockResolvedValue(createRoomEventPage([live, replayed], false));
    await facade.connect();
    await findRoomWsCallback(true)?.onMessage?.(toRoomEventMessage(live));

    const result = await facade.rooms.replayEvents(
      {
        roomId: 'room-1',
        after: { snapshotVersion: 1, occurredAtEpochMs: 1, eventId: 'event-1' },
        limit: 2,
      },
      replayListener,
    );
    await findRoomWsCallback(true)?.onMessage?.(toRoomEventMessage(replayed));

    expect(liveListener.mock.calls.map((call) => call[0].eventId)).toEqual(['event-1']);
    expect(replayListener).toHaveBeenCalledOnce();
    expect(replayListener).toHaveBeenCalledWith(
      replayed,
      expect.objectContaining({
        transport: 'replay',
        typeId: AppTopics.groupStateEvent,
        topicId: AppTopics.groupStateEvent,
      }),
    );
    expect(result).toEqual({
      events: [replayed],
      nextCursor: { snapshotVersion: 2, occurredAtEpochMs: 2, eventId: 'event-2' },
      hasMore: false,
      pageCount: 1,
      replayedCount: 1,
      duplicateCount: 1,
    });
    expect(mocks.listStateGroupEventPage).toHaveBeenCalledWith(
      'room-1',
      { applicationId: 'app-1', workspaceId: 'workspace-1' },
      {
        after: { snapshotVersion: 1, occurredAtEpochMs: 1, eventId: 'event-1' },
        limit: 2,
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('continues room replay across pages until completion', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const mocks = readRoomEventMocks();
    const facade = createRallarFacade();
    const listener = vi.fn();
    const first = createRoomEvent('room-1', 'event-1', 'member-joined');
    const second = createRoomEvent('room-1', 'event-2', 'member-left', {
      snapshotVersion: 2,
      occurredAtEpochMs: 2,
    });
    facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
    facade.rooms.onEvent(listener, { roomId: 'room-1' });
    mocks.listStateGroupEventPage
      .mockResolvedValueOnce(createRoomEventPage([first], true))
      .mockResolvedValueOnce(createRoomEventPage([second], false));

    const result = await facade.rooms.replayEvents({
      roomId: 'room-1',
      limit: 1,
      maxPages: 2,
    });

    expect(listener.mock.calls.map((call) => call[0].eventId)).toEqual(['event-1', 'event-2']);
    expect(result).toEqual({
      events: [first, second],
      nextCursor: { snapshotVersion: 2, occurredAtEpochMs: 2, eventId: 'event-2' },
      hasMore: false,
      pageCount: 2,
      replayedCount: 2,
      duplicateCount: 0,
    });
    expect(mocks.listStateGroupEventPage).toHaveBeenNthCalledWith(
      2,
      'room-1',
      { applicationId: 'app-1', workspaceId: 'workspace-1' },
      {
        limit: 1,
        after: { snapshotVersion: 1, occurredAtEpochMs: 1, eventId: 'event-1' },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('stops room replay at maxPages while preserving the continuation cursor', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const mocks = readRoomEventMocks();
    const facade = createRallarFacade();
    const event = createRoomEvent('room-1', 'event-1', 'member-joined');
    facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
    facade.rooms.onEvent(vi.fn(), { roomId: 'room-1' });
    mocks.listStateGroupEventPage.mockResolvedValue(createRoomEventPage([event], true));

    const result = await facade.rooms.replayEvents({
      roomId: 'room-1',
      limit: 1,
      maxPages: 1,
    });

    expect(mocks.listStateGroupEventPage).toHaveBeenCalledOnce();
    expect(result).toEqual({
      events: [event],
      nextCursor: { snapshotVersion: 1, occurredAtEpochMs: 1, eventId: 'event-1' },
      hasMore: true,
      pageCount: 1,
      replayedCount: 1,
      duplicateCount: 0,
    });
  });
});
