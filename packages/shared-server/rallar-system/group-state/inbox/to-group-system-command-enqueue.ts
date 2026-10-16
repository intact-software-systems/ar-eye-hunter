import { AppInboxType, type AppInboxEnqueueInput } from '../../app-inbox/app-inbox-contracts.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { GroupMutationIngress } from '../group-state-service-contracts.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';

export type GroupSystemCommandType =
    | typeof AppInboxType.GROUP_FORMATION_CRITERION
    | typeof AppInboxType.GROUP_FORMATION_AUTOMATION
    | typeof AppInboxType.GROUP_TOPOLOGY_PUBLICATION
    | typeof AppInboxType.GROUP_ACTIVATION_STATUS
    | typeof AppInboxType.GROUP_PRESENCE_EXPIRE;

/** A command the server issues for one group runs in that group's context: in order, never behind another group. */
export function toGroupSystemCommandEnqueue(
    type: GroupSystemCommandType,
    ingress: GroupMutationIngress
): AppInboxEnqueueInput {
    return {
        type,
        resourceId: ingress.queueResourceId,
        contextId: groupStateGroupStorageKey(ingress.command.aggregateRef),
        authority: decodeJsonWireValue(ingress, `${type} AppInbox authority`),
        data: { commandId: ingress.command.commandId }
    };
}
