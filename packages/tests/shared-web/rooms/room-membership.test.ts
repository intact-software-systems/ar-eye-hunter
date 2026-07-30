import { beforeEach, expect, it } from 'vitest';

import {
  createRoomSnapshot,
  readRoomWorkflowMocks,
  resetRoomWorkflowTestRuntime,
} from './room-workflow-test-runtime.ts';

const roomWorkflowMocks = readRoomWorkflowMocks();

beforeEach(resetRoomWorkflowTestRuntime);

it('exposes the owning room membership operations', async () => {
  const {
    acceptRoomInvite,
    banRoomMember,
    createRoomInvite,
    removeRoomMember,
    setRoomMemberRole,
    transferRoomOwnership,
    unbanRoomMember,
  } = await import('@shared-web/browser/rooms/room-membership.ts');
  expect(typeof createRoomInvite).toBe('function');
  expect(typeof acceptRoomInvite).toBe('function');
  expect(typeof removeRoomMember).toBe('function');
  expect(typeof banRoomMember).toBe('function');
  expect(typeof unbanRoomMember).toBe('function');
  expect(typeof setRoomMemberRole).toBe('function');
  expect(typeof transferRoomOwnership).toBe('function');
});

it('routes an invite through the room membership owner', async () => {
  const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
  const snapshot = createRoomSnapshot('room-1', ['session-1']);
  roomWorkflowMocks.createStateGroupInvite.mockResolvedValue(snapshot);

  await expect(createRallarFacade().rooms.invite('room-1', 'principal-2')).resolves.toBe(snapshot);

  expect(roomWorkflowMocks.createStateGroupInvite).toHaveBeenCalledWith(
    'room-1',
    'principal-2',
    {},
    'principal-1',
    'session-1',
    expect.anything(),
    {},
  );
});
