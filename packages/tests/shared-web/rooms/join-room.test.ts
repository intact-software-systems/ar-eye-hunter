import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    createRoomSnapshot,
    readRoomWorkflowMocks,
    rejectJoinWith,
    rejectLeaveWith,
    requireRecord,
    resetRoomWorkflowTestRuntime,
    resolveJoinWith,
    resolveLeaveWith,
    seedRoomSnapshots
} from './room-workflow-test-runtime.ts';

const roomWorkflowMocks = readRoomWorkflowMocks();

describe('room join operations', () => {
    beforeEach(resetRoomWorkflowTestRuntime);

    it('exposes the owning join operation entries', async () => {
        const { enterRoom, joinRoom } = await import('@shared-web/browser/rooms/join-room.ts');
        expect(typeof joinRoom).toBe('function');
        expect(typeof enterRoom).toBe('function');
    });

    it('resolves roomId and roomRef object targets', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const roomRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-ref'
        };
        const roomIdSnapshot = createRoomSnapshot('room-id', ['session-1']);
        const roomRefSnapshot = createRoomSnapshot('room-ref', ['session-1']);
        roomWorkflowMocks.joinStateGroup.mockImplementation(async (input) => {
            roomWorkflowMocks.operationLog.push(`join:${input.groupId}`);
            return input.groupId === 'room-id' ? roomIdSnapshot : roomRefSnapshot;
        });
        const facade = createRallarFacade();

        await facade.rooms.join({ roomId: 'room-id', leaveCurrent: false });
        await facade.rooms.join({ roomRef, leaveCurrent: false });

        expect(roomWorkflowMocks.joinStateGroup.mock.calls[0]?.[0]).toMatchObject({
            groupId: 'room-id',
            scope: undefined
        });
        expect(roomWorkflowMocks.joinStateGroup.mock.calls[1]?.[0]).toMatchObject({
            groupId: 'room-ref',
            scope: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1'
            }
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
            timeoutMs: 44
        });

        expect(roomWorkflowMocks.joinStateGroup).toHaveBeenCalledWith(
            {
                groupId: 'room-1',
                principalId: 'principal-1',
                sessionId: 'session-1',
                generationId: undefined,
                scope: undefined,
                policies: { command: { signal, timeoutMs: 44 } },
                intent: { inviteToken: 'invite-1', joinCode: 'code-1' }
            }
        );
    });

    it('applies the documented retry classification', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        resolveJoinWith(createRoomSnapshot('room-1', ['session-1']));

        await createRallarFacade().rooms.join('room-1', { maxAttempts: 3 });

        const policies = requireRecord(
            roomWorkflowMocks.joinStateGroup.mock.calls[0]?.[0].policies,
            'join workflow policies'
        );
        const command = requireRecord(policies.command, 'join command policies');
        const shouldRetry = command.shouldRetry;
        if (typeof shouldRetry !== 'function') {
            throw new TypeError('Expected join workflow retry policy');
        }
        expect(command.maxAttempts).toBe(3);
        expect(shouldRetry(apiHttpError(503), 1)).toBe(true);
        expect(shouldRetry(apiHttpError(429), 1)).toBe(true);
        expect(shouldRetry(apiHttpError(400), 1)).toBe(false);
        expect(shouldRetry(apiHttpError(409), 1)).toBe(false);
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
            'hydrate:old-room'
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
            leaveError
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
                    groupId: 'room-b'
                }
            })
        ).rejects.toThrow('roomId must match roomRef.groupId');

        expect(roomWorkflowMocks.joinStateGroup).not.toHaveBeenCalled();
    });
});

function apiHttpError(status: number): ApiHttpError {
    return new ApiHttpError(
        'POST',
        '/api/test/requests/test-request-id',
        status,
        JSON.stringify({
            type: 'api-mutation-failure',
            version: 'canonical.v2',
            code: `test-${status}`,
            status,
            message: `Test ${status}`,
            issues: null,
            denial: null,
            retry: status === 429
                ? {
                    kind: 'rate-limited',
                    retryAfterMs: 1000,
                    attempts: null,
                    lane: null,
                    queueAgeMs: null,
                    dueAgeMs: null
                }
                : status === 503
                ? {
                    kind: 'unavailable',
                    retryAfterMs: null,
                    attempts: 1,
                    lane: null,
                    queueAgeMs: null,
                    dueAgeMs: null
                }
                : null
        })
    );
}
