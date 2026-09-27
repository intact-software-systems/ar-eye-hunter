import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { GroupRef, GroupScope } from '@shared/api/group-types.ts';
import type { JsonWireObject, JsonWireValue } from '../protocol/json-wire-identity.ts';
import type { LiveWsAudience } from './live-ws-notice.ts';

export function decodeLiveWsAudience(value: JsonWireValue, scope: GroupScope | undefined): LiveWsAudience | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (
        value.mode === 'room' && hasKeys(value, ['mode', 'groupRef', 'recipientSessionIds']) &&
        scope !== undefined && isGroupRef(value.groupRef, scope) && isSessionIds(value.recipientSessionIds)
    ) {
        return { mode: 'room', groupRef: value.groupRef, recipientSessionIds: value.recipientSessionIds };
    }
    if (
        value.mode === 'peer' && hasKeys(value, ['mode', 'recipientSessionIds']) &&
        scope !== undefined && isSessionIds(value.recipientSessionIds) && value.recipientSessionIds.length === 1
    ) {
        return { mode: 'peer', recipientSessionIds: value.recipientSessionIds };
    }
    if (
        value.mode === 'principal' && hasKeys(value, ['mode', 'principalRef', 'recipientSessionIds']) &&
        scope !== undefined && isPrincipalRef(value.principalRef, scope) && isSessionIds(value.recipientSessionIds)
    ) {
        return { mode: 'principal', principalRef: value.principalRef, recipientSessionIds: value.recipientSessionIds };
    }
    if (
        value.mode === 'broad' && hasKeys(value, ['mode', 'targetMode']) &&
        scope === undefined && (value.targetMode === 'all' || value.targetMode === 'world')
    ) {
        return { mode: 'broad', targetMode: value.targetMode };
    }
    return undefined;
}

export function matchesLiveWsAudience(message: ALMessage, audience: LiveWsAudience): boolean {
    if (audience.mode === 'room') {
        const target = message.targets;
        return target !== undefined &&
            (target.mode === 'multicast' || (target.mode === 'broadcast' && target.scope === 'room')) &&
            target.groupRef?.applicationId === audience.groupRef.applicationId &&
            target.groupRef.workspaceId === audience.groupRef.workspaceId &&
            target.groupRef.groupId === audience.groupRef.groupId;
    }
    if (audience.mode === 'peer') {
        return message.targets?.mode === 'unicast' &&
            message.targets.toPeerId === audience.recipientSessionIds[0];
    }
    if (audience.mode === 'principal') {
        return message.targets?.mode === 'broadcast' && message.targets.scope === 'principal' &&
            message.targets.principalRef?.applicationId === audience.principalRef.applicationId &&
            message.targets.principalRef.workspaceId === audience.principalRef.workspaceId &&
            message.targets.principalRef.principalId === audience.principalRef.principalId;
    }
    return message.targets?.mode === 'broadcast' && message.targets.scope === audience.targetMode;
}

function isGroupRef(value: JsonWireValue, scope: GroupScope): value is JsonWireObject & GroupRef {
    return isRecord(value) && hasKeys(value, ['applicationId', 'workspaceId', 'groupId']) &&
        value.applicationId === scope.applicationId && value.workspaceId === scope.workspaceId &&
        isNonEmptyString(value.groupId);
}

function isPrincipalRef(value: JsonWireValue, scope: GroupScope): value is JsonWireObject & ClientPrincipalRef {
    return isRecord(value) && hasKeys(value, ['applicationId', 'workspaceId', 'principalId']) &&
        value.applicationId === scope.applicationId && value.workspaceId === scope.workspaceId &&
        isNonEmptyString(value.principalId);
}

function isSessionIds(value: JsonWireValue): value is readonly string[] {
    return Array.isArray(value) && value.every(isNonEmptyString) && new Set(value).size === value.length;
}

function isRecord(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasKeys(value: JsonWireObject, required: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function isNonEmptyString(value: JsonWireValue): value is string {
    return typeof value === 'string' && value.length > 0;
}
