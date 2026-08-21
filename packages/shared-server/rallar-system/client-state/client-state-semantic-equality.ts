import type { ClientInstance, ClientPrincipal, ClientPrincipalRef, ClientSession } from '@shared/api/client-types.ts';

export function sameClientPrincipalState(left: ClientPrincipal, right: ClientPrincipal): boolean {
    return (
        left.username === right.username &&
        left.displayName === right.displayName &&
        left.avatarUrl === right.avatarUrl &&
        left.status === right.status &&
        left.authProvider === right.authProvider &&
        left.externalSubjectId === right.externalSubjectId &&
        arrayEquals(left.roles, right.roles) &&
        jsonEquals(left.metadata, right.metadata) &&
        left.lastSeenAtEpochMs === right.lastSeenAtEpochMs
    );
}

export function sameClientPrincipalRef(
    left: ClientPrincipalRef,
    right: ClientPrincipalRef
): boolean {
    return (
        left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.principalId === right.principalId
    );
}

export function sameClientInstanceState(left: ClientInstance, right: ClientInstance): boolean {
    return (
        left.status === right.status &&
        left.platform === right.platform &&
        left.deviceLabel === right.deviceLabel &&
        left.appVersion === right.appVersion &&
        left.userAgent === right.userAgent &&
        arrayEquals(left.capabilities, right.capabilities)
    );
}

export function sameClientSessionState(left: ClientSession, right: ClientSession): boolean {
    return (
        left.generationId === right.generationId &&
        left.generationVersion === right.generationVersion &&
        left.status === right.status &&
        left.presenceState === right.presenceState &&
        left.transport === right.transport &&
        left.connectionId === right.connectionId &&
        left.authenticatedAtEpochMs === right.authenticatedAtEpochMs &&
        left.connectedAtEpochMs === right.connectedAtEpochMs &&
        left.lastHeartbeatAtEpochMs === right.lastHeartbeatAtEpochMs &&
        left.expiresAtEpochMs === right.expiresAtEpochMs &&
        left.disconnectedAtEpochMs === right.disconnectedAtEpochMs &&
        left.disconnectReason === right.disconnectReason
    );
}

function arrayEquals<T>(left: readonly T[], right: readonly T[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function jsonEquals(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return (
            Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((value, index) => jsonEquals(value, right[index]))
        );
    }
    if (!isClientJsonObject(left) || !isClientJsonObject(right)) {
        return false;
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
        arrayEquals(leftKeys, rightKeys) && leftKeys.every((key) => jsonEquals(left[key], right[key]))
    );
}

export function isClientJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
