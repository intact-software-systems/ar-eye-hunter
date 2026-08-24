import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { readALPrincipalBroadcastTarget } from '@shared/al-contracts/read-al-principal-broadcast-target.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import {
    validateAuthoritativeClientEvent,
    validateAuthoritativeClientSnapshot,
    validateAuthoritativeGroupSnapshot
} from '@shared/api/authoritative-state-validation.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import { validateGroupStateDeltaEnvelope, type GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

export interface StateSyncScope {
    readonly applicationId: string;
    readonly workspaceId: string;
}

export type StateSyncPayload =
    | Readonly<{
        kind: 'client-snapshot';
        scope: StateSyncScope;
        snapshot: ClientSnapshot;
    }>
    | Readonly<{
        kind: 'client-event';
        scope: StateSyncScope;
        event: ClientEvent;
    }>
    | Readonly<{
        kind: 'group-snapshot';
        snapshot: GroupSnapshot;
    }>
    | Readonly<{
        kind: 'group-directory-snapshot';
        snapshot: GroupSnapshot;
    }>
    | Readonly<{
        kind: 'group-event';
        envelope: GroupStateDeltaEnvelope;
    }>;

export type StateSyncDecodeResult =
    | Readonly<{ kind: 'decoded'; payload: StateSyncPayload; }>
    | Readonly<{ kind: 'invalid'; }>
    | Readonly<{ kind: 'unsupported'; }>;

export function decodeStateSyncMessage(message: ALMessage): StateSyncDecodeResult {
    const routeIsStateSync = isStateSyncTopic(message.route.topicId);
    const payloadIsStateSync = isStateSyncTopic(message.payload.typeId);
    if (!routeIsStateSync && !payloadIsStateSync) {
        return { kind: 'unsupported' };
    }
    if (
        !routeIsStateSync ||
        !payloadIsStateSync ||
        message.route.topicId !== message.payload.typeId
    ) {
        return { kind: 'invalid' };
    }

    try {
        const value: unknown = JSON.parse(message.payload.resource);
        return decodeStateSyncPayload(message, value);
    }
    catch {
        return { kind: 'invalid' };
    }
}

export function sameScope(left: StateSyncScope, right: StateSyncScope): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId;
}

function decodeStateSyncPayload(message: ALMessage, value: unknown): StateSyncDecodeResult {
    switch (message.payload.typeId) {
        case AppTopics.clientStateSnapshot:
            validateAuthoritativeClientSnapshot(value);
            return hasMatchingPrincipalAudience(message, value.principal)
                ? {
                    kind: 'decoded',
                    payload: {
                        kind: 'client-snapshot',
                        scope: value.principal,
                        snapshot: value
                    }
                }
                : { kind: 'invalid' };
        case AppTopics.clientStateEvent:
            validateAuthoritativeClientEvent(value);
            return hasMatchingPrincipalAudience(message, value)
                ? {
                    kind: 'decoded',
                    payload: {
                        kind: 'client-event',
                        scope: value,
                        event: value
                    }
                }
                : { kind: 'invalid' };
        case AppTopics.groupStateSnapshot:
            validateAuthoritativeGroupSnapshot(value);
            return hasMatchingGroupAudience(message, value.group)
                ? {
                    kind: 'decoded',
                    payload: { kind: 'group-snapshot', snapshot: value }
                }
                : { kind: 'invalid' };
        case AppTopics.groupDirectorySnapshot:
            validateAuthoritativeGroupSnapshot(value);
            return hasMatchingGroupAudience(message, value.group)
                ? {
                    kind: 'decoded',
                    payload: { kind: 'group-directory-snapshot', snapshot: value }
                }
                : { kind: 'invalid' };
        case AppTopics.groupStateEvent:
            validateGroupStateDeltaEnvelope(value);
            return hasMatchingGroupAudience(message, value.event)
                ? {
                    kind: 'decoded',
                    payload: { kind: 'group-event', envelope: value }
                }
                : { kind: 'invalid' };
        default:
            return { kind: 'unsupported' };
    }
}

function hasMatchingPrincipalAudience(
    message: ALMessage,
    scope: StateSyncScope & { readonly principalId: string; }
): boolean {
    const principalRef = readALPrincipalBroadcastTarget(message);
    return principalRef !== undefined &&
        sameScope(principalRef, scope) &&
        principalRef.principalId === scope.principalId;
}

function hasMatchingGroupAudience(message: ALMessage, groupRef: GroupRef): boolean {
    const targets = message.targets;
    const targetRef = targets?.mode === 'multicast'
        ? targets.groupRef
        : targets?.mode === 'broadcast' && targets.groupRef !== undefined
        ? targets.groupRef
        : undefined;
    return targetRef !== undefined &&
        sameScope(targetRef, groupRef) &&
        targetRef.groupId === groupRef.groupId;
}

function isStateSyncTopic(typeId: string): boolean {
    return typeId === AppTopics.clientStateSnapshot ||
        typeId === AppTopics.clientStateEvent ||
        typeId === AppTopics.groupStateSnapshot ||
        typeId === AppTopics.groupDirectorySnapshot ||
        typeId === AppTopics.groupStateEvent;
}
