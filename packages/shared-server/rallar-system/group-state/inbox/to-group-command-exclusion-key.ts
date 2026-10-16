import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { validateAppInboxCommandIdentity } from '../../app-inbox/app-inbox-command-identity.ts';
import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';
import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';

const GROUP_SYSTEM_COMMAND_TYPES: ReadonlySet<AppInboxType> = new Set([
    AppInboxType.GROUP_FORMATION_CRITERION,
    AppInboxType.GROUP_FORMATION_AUTOMATION,
    AppInboxType.GROUP_TOPOLOGY_PUBLICATION,
    AppInboxType.GROUP_ACTIVATION_STATUS,
    AppInboxType.GROUP_PRESENCE_EXPIRE
]);

/**
 * The group a queued command mutates, as its storage key: commands of one group that compute together only
 * conflict on its revision, so one AppInbox round computes them one after another. A caller's command claims in
 * that caller's context and a server-issued one in the group's, so the key is read from the command itself.
 * A command that names no existing group, or cannot be read, has no key.
 */
export function toGroupCommandExclusionKey(entry: ResourceEntry): string | undefined {
    const identity = validateAppInboxCommandIdentity(entry);
    if (!identity.valid || !identity.command.type.startsWith('GROUP_')) {
        return undefined;
    }
    const { command } = identity;
    return GROUP_SYSTEM_COMMAND_TYPES.has(command.type) ? command.contextId : readCommandGroupStorageKey(command.data);
}

function readCommandGroupStorageKey(data: JsonWireValue): string | undefined {
    if (!isWireRecord(data) || typeof data.groupId !== 'string' || data.groupId.length === 0) {
        return undefined;
    }
    const scope = data.scope;
    if (
        !isWireRecord(scope) ||
        typeof scope.applicationId !== 'string' || scope.applicationId.length === 0 ||
        typeof scope.workspaceId !== 'string' || scope.workspaceId.length === 0
    ) {
        return undefined;
    }
    return groupStateGroupStorageKey({
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId,
        groupId: data.groupId
    });
}

function isWireRecord(value: JsonWireValue | undefined): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
