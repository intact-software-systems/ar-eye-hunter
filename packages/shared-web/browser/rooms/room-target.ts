import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    pushOptionalGroupRefIssue,
    pushOptionalRouteIdIssue,
    throwIfRallarValidationIssues,
    throwRallarValidationIssue
} from '@shared-web/browser/rallar-runtime/validation.ts';
import type {
    RallarJoinRoomInput,
    RallarJoinRoomOptions,
    RallarRoomTargetInput
} from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

export interface RallarJoinRoomTarget {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly options: RallarJoinRoomOptions;
}

export interface RallarRoomTarget {
    readonly roomId: string;
    readonly roomRef?: GroupRef;
    readonly options: RallarScopedOperationOptions;
}

export function toJoinRoomTarget(
    room: string | GroupRef | RallarJoinRoomInput,
    options: RallarJoinRoomOptions
): RallarJoinRoomTarget {
    if (typeof room === 'string') {
        return { roomId: room, roomRef: options.roomRef, options };
    }
    if (isGroupRefInput(room)) {
        return { roomId: room.groupId, roomRef: room, options };
    }
    return {
        roomId: room.roomId ?? room.roomRef?.groupId,
        roomRef: room.roomRef,
        options: room
    };
}

export function toRoomTarget(
    room: string | GroupRef | RallarRoomTargetInput,
    options: RallarScopedOperationOptions
): RallarRoomTarget {
    const target = typeof room === 'string'
        ? { roomId: room, roomRef: undefined, options }
        : isGroupRefInput(room)
        ? { roomId: room.groupId, roomRef: room, options }
        : {
            roomId: room.roomId ?? room.roomRef?.groupId,
            roomRef: room.roomRef,
            options: { ...room, ...options }
        };
    assertValidRoomTarget(target);
    if (!target.roomId) {
        throwRallarValidationIssue(
            '$.roomId',
            'missing-room',
            'Cannot operate on room: room is required.'
        );
    }
    return {
        roomId: target.roomId,
        roomRef: target.roomRef,
        options: target.options
    };
}

export function assertValidRoomTarget(
    input: Readonly<{ roomId?: string; roomRef?: GroupRef; }>
): void {
    const issues: RallarValidationIssue[] = [];
    pushOptionalRouteIdIssue(input.roomId, '$.roomId', 'Room ID', issues);
    pushOptionalGroupRefIssue(input.roomRef, '$.roomRef', issues);
    if (!input.roomId && !input.roomRef) {
        issues.push({
            path: '$.roomId',
            code: 'missing-room',
            message: 'Cannot join room: room is required.'
        });
    }
    if (input.roomId && input.roomRef && input.roomId !== input.roomRef.groupId) {
        issues.push({
            path: '$.roomRef.groupId',
            code: 'room-id-mismatch',
            message: 'roomId must match roomRef.groupId.'
        });
    }
    throwIfRallarValidationIssues(issues);
}

function isGroupRefInput(value: unknown): value is GroupRef {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return (
        typeof (value as { applicationId?: unknown; }).applicationId === 'string' &&
        typeof (value as { groupId?: unknown; }).groupId === 'string' &&
        !Object.prototype.hasOwnProperty.call(value, 'roomId') &&
        !Object.prototype.hasOwnProperty.call(value, 'roomRef')
    );
}
