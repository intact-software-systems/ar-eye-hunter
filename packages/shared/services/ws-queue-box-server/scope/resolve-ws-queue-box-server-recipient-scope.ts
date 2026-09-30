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

/** Undefined for a message that is not a unicast; `null` keeps meaning "a scope was required and none was proven". */
export function resolveWsQueueBoxServerUnicastScope(
    message: ALMessage,
    provenScope: StateScope | null | undefined
): StateScope | null | undefined {
    if (message.targets?.mode !== 'unicast') {
        return undefined;
    }
    const groupRef = message.targets.groupRef;
    return groupRef === undefined
        ? provenScope
        : { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId };
}
