import { beforeEach, describe, expect, it } from 'vitest';

import {
  createRoomSnapshot,
  rejectJoinWith,
  rejectLeaveWith,
  readRoomWorkflowMocks,
  requireRecord,
  resetRoomWorkflowTestRuntime,
  resolveJoinWith,
  resolveLeaveWith,
  seedRoomSnapshots,
} from './room-workflow-test-runtime.ts';

const roomWorkflowMocks = readRoomWorkflowMocks();

describe('room join operations', () => {
  beforeEach(resetRoomWorkflowTestRuntime);

  it('resolves roomId and roomRef object targets', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const roomRef = {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'room-ref',
    };
    const roomIdSnapshot = createRoomSnapshot('room-id', ['session-1']);
    const roomRefSnapshot = createRoomSnapshot('room-ref', ['session-1']);
    roomWorkflowMocks.joinStateGroup.mockImplementation(async (roomId) => {
      roomWorkflowMocks.operationLog.push(`join:${String(roomId)}`);
      return roomId === 'room-id' ? roomIdSnapshot : roomRefSnapshot;
    });
    const facade = createRallarFacade();

    await facade.rooms.join({ roomId: 'room-id', leaveCurrent: false });
    await facade.rooms.join({ roomRef, leaveCurrent: false });

    expect(roomWorkflowMocks.joinStateGroup.mock.calls[0]?.[0]).toBe('room-id');
    expect(roomWorkflowMocks.joinStateGroup.mock.calls[0]?.[4]).toBeUndefined();
    expect(roomWorkflowMocks.joinStateGroup.mock.calls[1]?.[0]).toBe('room-ref');
    expect(roomWorkflowMocks.joinStateGroup.mock.calls[1]?.[4]).toEqual({
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
    });
  });

  it('forwards invite credentials and safe command options', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const signal = new AbortController().signal;
    resolveJoinWith(createRoomSnapshot('room-1', ['session-1']));

    await createRallarFacade().rooms.join({
      roomId: 'room-1',
      inviteToken: 'invite-1',
      joinCode: 'code-1',
      leaveCurrent: false,
      signal,
      timeoutMs: 44,
    });

    expect(roomWorkflowMocks.joinStateGroup).toHaveBeenCalledWith(
      'room-1',
      'principal-1',
      'session-1',
      undefined,
      undefined,
      { command: { signal, timeoutMs: 44 } },
      { inviteToken: 'invite-1', joinCode: 'code-1' },
    );
  });

  it('applies the documented retry classification', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    resolveJoinWith(createRoomSnapshot('room-1', ['session-1']));

    await createRallarFacade().rooms.join('room-1', { maxAttempts: 3 });

    const policies = requireRecord(
      roomWorkflowMocks.joinStateGroup.mock.calls[0]?.[5],
      'join workflow policies',
    );
    const command = requireRecord(policies.command, 'join command policies');
    const shouldRetry = command.shouldRetry;
    if (typeof shouldRetry !== 'function') {
      throw new TypeError('Expected join workflow retry policy');
    }
    expect(command.maxAttempts).toBe(3);
    expect(shouldRetry(Object.assign(new Error(), { status: 503 }), 1)).toBe(true);
    expect(shouldRetry(Object.assign(new Error(), { status: 429 }), 1)).toBe(true);
    expect(shouldRetry(Object.assign(new Error(), { status: 400 }), 1)).toBe(false);
    expect(shouldRetry(Object.assign(new Error(), { status: 409 }), 1)).toBe(false);
  });

  it('accepts the new room before leaving the previous room', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const oldRoom = createRoomSnapshot('old-room', ['session-1']);
    const newRoom = createRoomSnapshot('new-room', ['session-1']);
    seedRoomSnapshots([oldRoom]);
    resolveJoinWith(newRoom);
    resolveLeaveWith(createRoomSnapshot('old-room', []));
    const facade = createRallarFacade();

    await expect(facade.rooms.join('new-room')).resolves.toBe(newRoom);

    expect(roomWorkflowMocks.operationLog).toEqual([
      'join:new-room',
      'hydrate:new-room',
      'leave:old-room',
      'hydrate:old-room',
    ]);
    expect(facade.rooms.current()).toBe(newRoom);
  });

  it('reports leave failure while retaining the joined room', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const oldRoom = createRoomSnapshot('old-room', ['session-1']);
    const newRoom = createRoomSnapshot('new-room', ['session-1']);
    const leaveError = new Error('leave failed');
    seedRoomSnapshots([oldRoom]);
    resolveJoinWith(newRoom);
    rejectLeaveWith(leaveError);
    const facade = createRallarFacade();

    await expect(facade.rooms.join('new-room')).rejects.toMatchObject({
      name: 'RallarRoomSwitchPartialFailureError',
      operation: 'join',
      joinedRoom: newRoom,
      previousRoomRef: oldRoom.group,
      leaveError,
    });
    expect(facade.rooms.current()).toBe(newRoom);
    expect(facade.rooms.state().currentRoomRef).toEqual(newRoom.group);
  });

  it('does not leave when joining the next room fails', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const oldRoom = createRoomSnapshot('old-room', ['session-1']);
    seedRoomSnapshots([oldRoom]);
    rejectJoinWith(new Error('join failed'));
    const facade = createRallarFacade();

    await expect(facade.rooms.join('new-room')).rejects.toThrow('join failed');

    expect(roomWorkflowMocks.operationLog).toEqual(['join:new-room']);
    expect(roomWorkflowMocks.leaveStateGroup).not.toHaveBeenCalled();
    expect(facade.rooms.current()).toBe(oldRoom);
  });

  it('rejects mismatched roomId and roomRef before the workflow', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');

    await expect(
      createRallarFacade().rooms.join({
        roomId: 'room-a',
        roomRef: {
          applicationId: 'app-1',
          workspaceId: 'workspace-1',
          groupId: 'room-b',
        },
      }),
    ).rejects.toThrow('roomId must match roomRef.groupId');

    expect(roomWorkflowMocks.joinStateGroup).not.toHaveBeenCalled();
  });
});
