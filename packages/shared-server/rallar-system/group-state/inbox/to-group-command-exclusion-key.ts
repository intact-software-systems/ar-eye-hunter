import type { GroupScope } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { validateAppInboxCommandIdentity } from '../../app-inbox/app-inbox-command-identity.ts';
import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';
import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    groupStateGroupStorageKey,
    groupStateScopeStorageKey
} from '../persistence/aggregate/group-aggregate-storage-keys.ts';

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
 * that caller's context and a server-issued one in the group's, so the key is read from the command itself. A
 * session cleanup writes the presence of every group of its session, which only its compute reads, so its key is
 * its scope: the path prefix of every group key there. A command that names neither, or cannot be read, has no key.
 */
export function toGroupCommandExclusionKey(entry: ResourceEntry): string | undefined {
    const identity = validateAppInboxCommandIdentity(entry);
    if (!identity.valid || !identity.command.type.startsWith('GROUP_')) {
        return undefined;
    }
    const { command } = identity;
    if (GROUP_SYSTEM_COMMAND_TYPES.has(command.type)) {
        return command.contextId;
    }
    if (command.type === AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP) {
        const connection = isWireRecord(command.data) ? command.data.connection : undefined;
        return readScopeStorageKey(isWireRecord(connection) ? connection.scope : undefined);
    }
    return readCommandGroupStorageKey(command.data);
}

function readCommandGroupStorageKey(data: JsonWireValue): string | undefined {
    if (!isWireRecord(data) || typeof data.groupId !== 'string' || data.groupId.length === 0) {
        return undefined;
    }
    const scope = readScope(data.scope);
    const { groupId } = data;
    return scope === undefined ? undefined : toStorageKey(() => groupStateGroupStorageKey({ ...scope, groupId }));
}

function readScopeStorageKey(value: JsonWireValue | undefined): string | undefined {
    const scope = readScope(value);
    return scope === undefined ? undefined : toStorageKey(() => groupStateScopeStorageKey(scope));
}

function readScope(value: JsonWireValue | undefined): GroupScope | undefined {
    if (
        !isWireRecord(value) ||
        typeof value.applicationId !== 'string' || value.applicationId.length === 0 ||
        typeof value.workspaceId !== 'string' || value.workspaceId.length === 0
    ) {
        return undefined;
    }
    return { applicationId: value.applicationId, workspaceId: value.workspaceId };
}

/** A part that cannot be URI-encoded, such as a lone surrogate, forms no key rather than failing the round. */
function toStorageKey(compute: () => string): string | undefined {
    try {
        return compute();
    }
    catch {
        return undefined;
    }
}

function isWireRecord(value: JsonWireValue | undefined): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
