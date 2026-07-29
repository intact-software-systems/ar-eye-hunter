import { beforeEach, expect, it } from 'vitest';

import {
  createRoomSnapshot,
  resetRoomWorkflowTestRuntime,
  seedRoomSnapshots,
} from './room-workflow-test-runtime.ts';

beforeEach(resetRoomWorkflowTestRuntime);

it('exposes the owning room session operation', async () => {
  const { createRoomSession } = await import('@shared-web/browser/rooms/room-session.ts');
  expect(typeof createRoomSession).toBe('function');
});

it('binds a session to the selected room snapshot', async () => {
  const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
  const snapshot = createRoomSnapshot('room-1', ['session-1']);
  seedRoomSnapshots([snapshot]);

  const session = createRallarFacade().rooms.session('room-1');

  expect(session.roomRef).toEqual(snapshot.group);
  expect(session.snapshot()).toBe(snapshot);
});
