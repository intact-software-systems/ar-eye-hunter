import { getOwnField } from '../../encoding/get-own-field.ts';
import { Either } from '../../resilience/Either.ts';
import { decodePlainRecord, hasExactKeys } from '../exact-object-decoding.ts';
import type { GroupRef } from '../group-types.ts';
import { validateRallarRouteId } from '../rallar-validation.ts';

const ROOM_REF_KEYS = ['applicationId', 'workspaceId', 'groupId'] as const;

/** An admin response's room: exactly an application, a workspace and a group route ID, in canonical form. */
export function decodeAdminRoomRef(value: unknown): Either<string, GroupRef> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, ROOM_REF_KEYS)) {
        return Either.ofLeft('Room identity must be an exact object of an application, a workspace and a group');
    }
    const applicationId = getOwnField(fields, 'applicationId');
    const workspaceId = getOwnField(fields, 'workspaceId');
    const groupId = getOwnField(fields, 'groupId');
    if (!isRouteId(applicationId) || !isRouteId(workspaceId) || !isRouteId(groupId)) {
        return Either.ofLeft('Room identity must name its application, workspace and group by route ID');
    }
    return Either.ofRight({ applicationId, workspaceId, groupId });
}

function isRouteId(value: unknown): value is string {
    return validateRallarRouteId(value).ok;
}
