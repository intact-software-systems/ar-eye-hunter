import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import { validateGroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

export type StateSyncScope = Readonly<{
    applicationId: string;
    workspaceId: string;
}>;

export type StateSyncPayload =
    | Readonly<{
        kind: 'client';
        scope: StateSyncScope;
        snapshot?: ClientSnapshot;
    }>
    | Readonly<{
        kind: 'group';
        snapshot: GroupSnapshot;
    }>
    | Readonly<{
        kind: 'group-directory';
        snapshot: GroupSnapshot;
    }>
    | Readonly<{
        kind: 'group-event';
        scope: StateSyncScope;
        groupId: string;
        audienceSessionIds: readonly string[];
    }>
    | Readonly<{
        kind: 'invalid';
    }>;

/**
 * The authoritative group snapshot carried by a state-sync row, when the row
 * is a group or group-directory snapshot for that exact group. Delivery-time
 * audience resolution may use it when a process-local cache lags the row.
 */
export function readGroupSnapshotStateSyncPayload(
    message: ALMessage
): GroupSnapshot | undefined {
    const payload = parseStateSyncPayload(message);
    return payload && (payload.kind === 'group' || payload.kind === 'group-directory')
        ? payload.snapshot
        : undefined;
}

/**
 * The authoritative client snapshot carried by a state-sync row, when the row
 * is a client snapshot. Delivery-time audience resolution may use it when a
 * process-local cache lags the row: the mutation that produced the row may
 * have committed on another server, so the local cache does not yet list the
 * very session the snapshot announces.
 */
export function readClientSnapshotStateSyncPayload(
    message: ALMessage
): ClientSnapshot | undefined {
    const payload = parseStateSyncPayload(message);
    return payload && payload.kind === 'client' ? payload.snapshot : undefined;
}

export function parseStateSyncPayload(message: ALMessage): StateSyncPayload | undefined {
    try {
        switch (message.payload.typeId) {
            case AppTopics.clientStateSnapshot: {
                const snapshot = JSON.parse(message.payload.resource);
                if (!isClientSnapshot(snapshot)) {
                    return { kind: 'invalid' };
                }
                return {
                    kind: 'client',
                    scope: snapshot.principal,
                    snapshot
                };
            }
            case AppTopics.clientStateEvent: {
                const event = JSON.parse(message.payload.resource);
                if (!isClientEvent(event)) {
                    return { kind: 'invalid' };
                }
                return {
                    kind: 'client',
                    scope: event
                };
            }
            case AppTopics.groupStateSnapshot: {
                const snapshot = JSON.parse(message.payload.resource);
                if (
                    !isGroupSnapshot(snapshot) ||
                    !hasMatchingExplicitGroupAudience(message, snapshot.group)
                ) {
                    return { kind: 'invalid' };
                }
                return {
                    kind: 'group',
                    snapshot
                };
            }
            case AppTopics.groupDirectorySnapshot: {
                const snapshot = JSON.parse(message.payload.resource);
                if (
                    !isGroupSnapshot(snapshot) ||
                    !hasMatchingExplicitGroupAudience(message, snapshot.group)
                ) {
                    return { kind: 'invalid' };
                }
                return {
                    kind: 'group-directory',
                    snapshot
                };
            }
            case AppTopics.groupStateEvent: {
                const payload = JSON.parse(message.payload.resource);
                validateGroupStateDeltaEnvelope(payload);
                if (!hasMatchingExplicitGroupAudience(message, payload.event)) {
                    return { kind: 'invalid' };
                }
                return {
                    kind: 'group-event',
                    scope: payload.event,
                    groupId: payload.event.groupId,
                    audienceSessionIds: payload.audienceSessionIds
                };
            }
            default:
                return undefined;
        }
    }
    catch {
        return isStateSyncTopic(message.payload.typeId)
            ? { kind: 'invalid' }
            : undefined;
    }
}

export function sameScope(
    left: StateSyncScope,
    right: StateSyncScope
): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId;
}

function hasMatchingExplicitGroupAudience(
    message: ALMessage,
    groupRef: GroupRef
): boolean {
    const targets = message.targets;
    const targetRef = targets?.mode === 'multicast'
        ? targets.groupRef
        : targets?.mode === 'broadcast' && targets.groupRef !== undefined
        ? targets.groupRef
        : undefined;
    return targetRef !== undefined &&
        (
            targetRef.applicationId === groupRef.applicationId &&
            targetRef.workspaceId === groupRef.workspaceId &&
            targetRef.groupId === groupRef.groupId
        );
}

function isStateSyncTopic(typeId: string): boolean {
    return typeId === AppTopics.clientStateSnapshot ||
        typeId === AppTopics.clientStateEvent ||
        typeId === AppTopics.groupStateSnapshot ||
        typeId === AppTopics.groupDirectorySnapshot ||
        typeId === AppTopics.groupStateEvent;
}

function isClientSnapshot(value: unknown): value is ClientSnapshot {
    return isRecord(value) &&
        isRecord(value.principal) &&
        typeof value.principal.principalId === 'string' &&
        hasStateSyncScope(value.principal) &&
        Array.isArray(value.activeSessions);
}

function isClientEvent(value: unknown): value is ClientEvent {
    return isRecord(value) &&
        typeof value.principalId === 'string' &&
        typeof value.snapshotVersion === 'number' &&
        hasStateSyncScope(value);
}

function isGroupSnapshot(value: unknown): value is GroupSnapshot {
    return isRecord(value) &&
        isRecord(value.group) &&
        typeof value.group.groupId === 'string' &&
        hasStateSyncScope(value.group) &&
        Array.isArray(value.members) &&
        Array.isArray(value.activeSessions);
}

function hasStateSyncScope(value: Record<string, unknown>): value is StateSyncScope {
    return typeof value.applicationId === 'string' &&
        typeof value.workspaceId === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
