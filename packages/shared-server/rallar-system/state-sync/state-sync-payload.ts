import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { readALPrincipalBroadcastTarget } from '@shared/al-contracts/read-al-principal-broadcast-target.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { validateAuthoritativeClientEvent } from '@shared/api/authoritative-state-validation.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import { validateGroupStateDeltaEnvelope, type GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    decodeStateSnapshotPage,
    isStateSnapshotTopic,
    type StateSnapshotPage
} from '@shared/api/state-snapshot-page.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export interface StateSyncSnapshotPage {
    readonly kind: 'snapshot-page';
    readonly page: StateSnapshotPage;
    readonly recipientPeerId: string | undefined;
}

export interface StateSyncClientEvent {
    readonly kind: 'client-event';
    readonly event: ClientEvent;
}

export interface StateSyncGroupEvent {
    readonly kind: 'group-event';
    readonly envelope: GroupStateDeltaEnvelope;
}

export type StateSyncPayload = StateSyncSnapshotPage | StateSyncClientEvent | StateSyncGroupEvent;
export type StateSyncDecodeResult =
    | { readonly kind: 'decoded'; readonly payload: StateSyncPayload; }
    | { readonly kind: 'invalid'; }
    | { readonly kind: 'unsupported'; };

export function decodeStateSyncMessage(message: ALMessage): StateSyncDecodeResult {
    const routeIsStateSync = isStateSyncTopic(message.route.topicId);
    const payloadIsStateSync = isStateSyncTopic(message.payload.typeId);
    if (!routeIsStateSync && !payloadIsStateSync) {
        return { kind: 'unsupported' };
    }
    if (!routeIsStateSync || !payloadIsStateSync || message.route.topicId !== message.payload.typeId) {
        return { kind: 'invalid' };
    }
    try {
        const value: unknown = JSON.parse(message.payload.resource);
        if (isStateSnapshotTopic(message.payload.typeId)) {
            return decodeSnapshotPage(message, value);
        }
        if (message.payload.typeId === AppTopics.clientStateEvent) {
            validateAuthoritativeClientEvent(value);
            const target = readALPrincipalBroadcastTarget(message);
            return target && sameScope(target, value) && target.principalId === value.principalId
                ? { kind: 'decoded', payload: { kind: 'client-event', event: value } }
                : { kind: 'invalid' };
        }
        validateGroupStateDeltaEnvelope(value);
        return hasMatchingGroupAudience(message, value.event)
            ? { kind: 'decoded', payload: { kind: 'group-event', envelope: value } }
            : { kind: 'invalid' };
    }
    catch {
        return { kind: 'invalid' };
    }
}

function decodeSnapshotPage(message: ALMessage, value: unknown): StateSyncDecodeResult {
    if (!value || typeof value !== 'object' || !('scope' in value)) {
        return { kind: 'invalid' };
    }
    const scope = value.scope;
    if (
        !scope || typeof scope !== 'object' || !('applicationId' in scope) || !('workspaceId' in scope) ||
        typeof scope.applicationId !== 'string' || typeof scope.workspaceId !== 'string'
    ) {
        return { kind: 'invalid' };
    }
    const decoded = decodeStateSnapshotPage(message, {
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId
    });
    return decoded.right
        ? {
            kind: 'decoded',
            payload: {
                kind: 'snapshot-page',
                page: decoded.right,
                recipientPeerId: message.targets?.mode === 'unicast' ? message.targets.toPeerId : undefined
            }
        }
        : { kind: 'invalid' };
}

export function sameScope(left: StateScope, right: StateScope): boolean {
    return left.applicationId === right.applicationId && left.workspaceId === right.workspaceId;
}

function hasMatchingGroupAudience(message: ALMessage, groupRef: GroupRef): boolean {
    const targetRef = readALTargetGroupRef(message);
    return targetRef !== undefined && sameScope(targetRef, groupRef) && targetRef.groupId === groupRef.groupId;
}

function isStateSyncTopic(typeId: string): boolean {
    return typeId === AppTopics.clientStateSnapshot || typeId === AppTopics.clientStateEvent ||
        typeId === AppTopics.groupStateSnapshot || typeId === AppTopics.groupDirectorySnapshot ||
        typeId === AppTopics.groupStateEvent;
}
