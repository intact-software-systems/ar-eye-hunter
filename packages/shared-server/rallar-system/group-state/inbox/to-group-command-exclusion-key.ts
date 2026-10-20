import type { GroupScope } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { validateAppInboxCommandIdentity } from '../../app-inbox/app-inbox-command-identity.ts';
import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';
import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    groupStateChildStorageKeySuffix,
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

const GROUP_PRESENCE_COMMAND_TYPES: ReadonlySet<AppInboxType> = new Set([
    AppInboxType.GROUP_PRESENCE_CONNECT,
    AppInboxType.GROUP_PRESENCE_HEARTBEAT,
    AppInboxType.GROUP_PRESENCE_DISCONNECT
]);

/**
 * The rows a queued group command guards, as a colon path, so one AppInbox round computes two commands one after
 * another only where they would conflict. A caller's aggregate command, a join among them, compares and sets the group
 * row, so every one of them shares the group's aggregate key. A presence command guards only its own session row and
 * its principal's admission row, so it keys by its session and computes beside its group's joins. A server-issued
 * command keys by the group itself, which orders it against both, and a session cleanup by its scope, the path prefix
 * of every group key there. A caller's command claims in that caller's context and a server-issued one in the group's,
 * so the key is read from the command itself. A command that names neither, or cannot be read, has no key.
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
    const groupKey = readCommandGroupStorageKey(command.data);
    if (groupKey === undefined) {
        return undefined;
    }
    return GROUP_PRESENCE_COMMAND_TYPES.has(command.type)
        ? readPresenceSessionExclusionKey(groupKey, command.data)
        : `${groupKey}:aggregate`;
}

function readPresenceSessionExclusionKey(groupKey: string, data: JsonWireValue): string | undefined {
    if (!isWireRecord(data) || typeof data.sessionId !== 'string' || data.sessionId.length === 0) {
        return undefined;
    }
    const { sessionId } = data;
    const sessionSuffix = toStorageKey(() => groupStateChildStorageKeySuffix('session', sessionId));
    return sessionSuffix === undefined ? undefined : `${groupKey}${sessionSuffix}`;
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
