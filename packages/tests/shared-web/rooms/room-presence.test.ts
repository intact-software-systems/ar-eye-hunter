import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRoomSnapshot,
  publishRoomSnapshots,
  readRoomWorkflowMocks,
  resetRoomWorkflowTestRuntime,
  seedRoomSnapshots,
} from './room-workflow-test-runtime.ts';

const roomWorkflowMocks = readRoomWorkflowMocks();

describe('room presence waits', () => {
  beforeEach(resetRoomWorkflowTestRuntime);

  it('exposes the owning presence wait entry', async () => {
    const { waitForRoomPresence } = await import('@shared-web/browser/rooms/room-presence.ts');
    expect(typeof waitForRoomPresence).toBe('function');
  });

  it('is immediately ready from the current cache', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const snapshot = createRoomSnapshot('room-1', ['session-1']);
    seedRoomSnapshots([snapshot]);

    await expect(
      createRallarFacade().rooms.waitForPresence('room-1', {
        expect: { min: 1 },
        timeoutMs: 10,
      }),
    ).resolves.toEqual({
      status: 'ready',
      observedSessionIds: ['session-1'],
      missingSessionIds: [],
      extraSessionIds: [],
      observedCount: 1,
      expectedCount: 1,
      roomId: 'room-1',
      roomRef: snapshot.group,
      activeSessionIds: ['session-1'],
      timedOut: false,
    });
  });

  it('becomes ready after a later cache update', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    seedRoomSnapshots([createRoomSnapshot('room-1', ['session-1'])]);
    const wait = createRallarFacade().rooms.waitForPresence('room-1', {
      expect: { exact: 2 },
      timeoutMs: 1_000,
    });
    const ready = createRoomSnapshot('room-1', ['session-1', 'peer-a']);

    await publishRoomSnapshots([ready]);

    await expect(wait).resolves.toEqual({
      status: 'ready',
      observedSessionIds: ['peer-a', 'session-1'],
      missingSessionIds: [],
      extraSessionIds: [],
      observedCount: 2,
      expectedCount: 2,
      roomId: 'room-1',
      roomRef: ready.group,
      activeSessionIds: ['session-1', 'peer-a'],
      timedOut: false,
    });
  });

  it('rechecks after subscribing', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const ready = createRoomSnapshot('room-1', ['session-1', 'peer-a']);
    seedRoomSnapshots([createRoomSnapshot('room-1', ['session-1'])]);
    roomWorkflowMocks.onStateCacheChange.mockImplementation(() => {
      seedRoomSnapshots([ready]);
      return () => {};
    });

    await expect(
      createRallarFacade().rooms.waitForPresence('room-1', {
        expect: { exact: 2 },
        timeoutMs: 1,
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      observedSessionIds: ['peer-a', 'session-1'],
      observedCount: 2,
      expectedCount: 2,
      roomRef: ready.group,
      activeSessionIds: ['session-1', 'peer-a'],
      timedOut: false,
    });
  });

  it('returns the literal timeout result', async () => {
    vi.useFakeTimers();
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const snapshot = createRoomSnapshot('room-1', ['session-1']);
    seedRoomSnapshots([snapshot]);
    const wait = createRallarFacade().rooms.waitForPresence('room-1', {
      expect: { exact: 2 },
      timeoutMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);

    await expect(wait).resolves.toEqual({
      status: 'timeout',
      observedSessionIds: ['session-1'],
      missingSessionIds: [],
      extraSessionIds: [],
      observedCount: 1,
      expectedCount: 2,
      roomId: 'room-1',
      roomRef: snapshot.group,
      activeSessionIds: ['session-1'],
      timedOut: true,
    });
  });

  it('returns the literal aborted result', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const snapshot = createRoomSnapshot('room-1', ['session-1']);
    const controller = new AbortController();
    seedRoomSnapshots([snapshot]);
    const wait = createRallarFacade().rooms.waitForPresence('room-1', {
      expect: { exact: 2 },
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    controller.abort();

    await expect(wait).resolves.toEqual({
      status: 'aborted',
      observedSessionIds: ['session-1'],
      missingSessionIds: [],
      extraSessionIds: [],
      observedCount: 1,
      expectedCount: 2,
      roomId: 'room-1',
      roomRef: snapshot.group,
      activeSessionIds: ['session-1'],
      timedOut: false,
    });
  });
});
