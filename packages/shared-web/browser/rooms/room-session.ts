import type { RallarMessagesController } from '@shared-web/browser/messages/browser-rallar-messages-controller.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarRoomMessageChannelDefinition } from '@shared-web/browser/rallar-message-contracts.ts';
import type { RallarRealtimeFacade } from '@shared-web/browser/rallar-realtime-facade.ts';
import { throwIfRallarValidationIssues } from '@shared-web/browser/rallar-runtime/validation.ts';
import { isSameGroupRef, toStateScope } from '@shared/api/api-type-utils.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

import type {
    RallarLeaveRoomOptions,
    RallarRoomSession,
    RallarRoomSessionMessageDefinition,
    RallarRoomSessionRealtimeInput,
    RallarRoomSummary
} from './rallar-room-contracts.ts';
import type { GroupRef, GroupSnapshot } from './room-group-state-translation.ts';
import type { RallarRoomStateStorePort } from './room-state-store.ts';

export interface CreateRoomSessionInput {
    readonly roomRef: GroupRef;
    readonly stateStore: RallarRoomStateStorePort;
    readonly messages: RallarMessagesController['operations'];
    readonly realtime: RallarRealtimeFacade;
    readonly leaveRoom: (
        input?: string | RallarLeaveRoomOptions
    ) => Promise<GroupSnapshot | undefined>;
    readonly refreshRoom: (
        roomRef: GroupRef,
        input?: RallarScopedOperationOptions
    ) => Promise<unknown>;
}

export function createRoomSession(input: CreateRoomSessionInput): RallarRoomSession {
    const roomId = input.roomRef.groupId;
    return {
        roomId,
        roomRef: input.roomRef,
        snapshot: () => input.stateStore.findGroupSnapshot(input.roomRef),
        summary: () => findRoomSummary(input.stateStore.state().rooms, input.roomRef),
        leave: async (options = {}) =>
            await input.leaveRoom({
                ...options,
                roomId,
                roomRef: input.roomRef,
                scope: options.scope ?? toStateScope(input.roomRef)
            }),
        refresh: async (options = {}) => {
            await input.refreshRoom(input.roomRef, {
                ...options,
                scope: options.scope ?? toStateScope(input.roomRef)
            });
            return createRoomSession(input);
        },
        realtime: <T>(options?: RallarRoomSessionRealtimeInput) =>
            input.realtime.room<T>(toRoomSessionRealtimeDefaults(options, input.roomRef)),
        message: <T>(definition: RallarRoomSessionMessageDefinition) =>
            input.messages.room<T>(toRoomSessionMessageDefinition(definition, input.roomRef))
    };
}

export function toRoomSessionRealtimeDefaults(
    input: RallarRoomSessionRealtimeInput | undefined,
    roomRef: GroupRef
) {
    if (input === undefined) {
        return { roomRef };
    }
    if (typeof input === 'string') {
        return { laneId: input, roomRef };
    }
    const { roomId: _roomId, roomRef: _roomRef, ...defaults } = input;
    return { ...defaults, roomRef };
}

function findRoomSummary(
    rooms: readonly RallarRoomSummary[],
    roomRef: GroupRef
): RallarRoomSummary | undefined {
    return rooms.find((room) => isSameGroupRef(room.roomRef, roomRef));
}

function toRoomSessionMessageDefinition(
    input: RallarRoomSessionMessageDefinition,
    roomRef: GroupRef
): RallarRoomMessageChannelDefinition {
    if (typeof input === 'string') {
        return { topicId: `room.${input}`, typeId: `room.${input}.v1`, roomRef };
    }
    const issues: RallarValidationIssue[] = [];
    if (input.roomId && input.roomId !== roomRef.groupId) {
        issues.push({
            path: '$.roomId',
            code: 'room-id-mismatch',
            message: 'roomId must match the bound room session.'
        });
    }
    if (input.roomRef && !isSameGroupRef(input.roomRef, roomRef)) {
        issues.push({
            path: '$.roomRef',
            code: 'room-ref-mismatch',
            message: 'roomRef must match the bound room session.'
        });
    }
    throwIfRallarValidationIssues(issues);
    return { topicId: input.topicId, typeId: input.typeId, roomRef };
}
