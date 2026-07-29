import { beforeEach, expect, it } from 'vitest';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

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

it('reports a structured validation issue when no room session can be resolved', async () => {
  const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
  let thrown: unknown;

  try {
    createRallarFacade().rooms.session();
  } catch (error) {
    thrown = error;
  }

  expect(isRallarValidationError(thrown)).toBe(true);
  expect(thrown).toMatchObject({
    issues: [
      {
        path: '$.roomRef',
        code: 'missing-room-ref',
        message: 'Cannot create room session: no scoped room reference.',
      },
    ],
  });
});
