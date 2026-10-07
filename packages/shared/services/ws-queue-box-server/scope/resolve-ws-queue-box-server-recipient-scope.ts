import { readALTargetGroupRef, type ALMessage } from '../../../al-contracts/al-contract.ts';
import type { StateScope } from '../../../api/state-types.ts';

/** A message whose targets name a group is scoped by that group; any other takes the scope its producer proved. */
export function resolveWsQueueBoxServerRecipientScope(
    message: ALMessage,
    provenScope: StateScope | undefined
): StateScope | undefined {
    const groupRef = readALTargetGroupRef(message);
    return groupRef === undefined
        ? provenScope
        : { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId };
}

/**
 * The scope a unicast or a world broadcast reaches: its groupRef's for a unicast that names its room, else the scope
 * its producer proved. Undefined for any other message; `null` keeps meaning "a scope was required and none was proven".
 */
export function resolveWsQueueBoxServerProvenScope(
    message: ALMessage,
    provenScope: StateScope | null | undefined
): StateScope | null | undefined {
    const targets = message.targets;
    if (targets?.mode === 'broadcast' && targets.scope === 'world') {
        return provenScope;
    }
    if (targets?.mode !== 'unicast') {
        return undefined;
    }
    const groupRef = targets.groupRef;
    return groupRef === undefined
        ? provenScope
        : { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId };
}
