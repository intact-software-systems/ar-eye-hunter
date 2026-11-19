import { requireExactKeys, requireRecord, requireString } from '../api/exact-object-decoding.ts';
import type { GroupRef } from '../api/group-types.ts';

/** Throws a TypeError naming `label` unless the value is an exact group reference with non-empty ids. */
export function decodeExactGroupRef(value: unknown, label: string): GroupRef {
    const groupRef = requireRecord(value, `${label} groupRef`);
    requireExactKeys(groupRef, ['applicationId', 'workspaceId', 'groupId'], `${label} groupRef`);
    requireString(groupRef.applicationId, `${label} applicationId`);
    requireString(groupRef.workspaceId, `${label} workspaceId`);
    requireString(groupRef.groupId, `${label} groupId`);
    return {
        applicationId: groupRef.applicationId,
        workspaceId: groupRef.workspaceId,
        groupId: groupRef.groupId
    };
}
