import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

/** The WS server refuses a room send routed in another room (D82); the browser refuses it first, on every carrier. */
export function validateRoomContext(
    contextId: string | undefined,
    roomRef: GroupRef | undefined
): readonly RallarValidationIssue[] {
    return roomRef === undefined || contextId === undefined || contextId === roomRef.groupId
        ? []
        : [{
            path: '$.contextId',
            code: 'context-room-mismatch',
            message: 'A room send routes in the room it names: contextId must equal the room id.'
        }];
}
