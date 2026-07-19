import type { GroupRef } from '@shared/api/group-types.ts';

type GroupMemberStorageRef = GroupRef & Readonly<{ principalId: string }>;
type GroupSessionStorageRef = GroupRef & Readonly<{ sessionId: string }>;

function keyPart(name: string, value: string): string {
    return `${name}=${encodeURIComponent(value)}`;
}

function workspaceKeyPart(workspaceId: string | undefined): string {
    if (workspaceId === undefined) return 'ws=_';
    // Keep the historical absent-workspace namespace while ensuring that the
    // valid explicit identifier "_" cannot alias it. Percent is itself escaped
    // by encodeURIComponent, so "%5F" and the explicit sentinel remain distinct.
    const encoded = workspaceId === '_' ? '%5F' : encodeURIComponent(workspaceId);
    return `ws=${encoded}`;
}

export function groupStateScopeStorageKey(
    scope: Pick<GroupRef, 'applicationId' | 'workspaceId'>,
): string {
    return [
        keyPart('app', scope.applicationId),
        workspaceKeyPart(scope.workspaceId),
    ].join(':');
}

export function groupStateGroupStorageKey(ref: GroupRef): string {
    return [
        groupStateScopeStorageKey(ref),
        keyPart('group', ref.groupId),
    ].join(':');
}

export function groupStateMemberStorageKey(ref: GroupMemberStorageRef): string {
    return [
        groupStateGroupStorageKey(ref),
        keyPart('member', ref.principalId),
    ].join(':');
}

export function groupStatePresenceSessionStorageKey(
    ref: GroupSessionStorageRef,
): string {
    return [
        groupStateGroupStorageKey(ref),
        keyPart('session', ref.sessionId),
    ].join(':');
}

export function groupStatePresenceAdmissionStorageKey(
    ref: GroupMemberStorageRef,
): string {
    return [
        groupStateGroupStorageKey(ref),
        keyPart('principal', ref.principalId),
    ].join(':');
}

export function groupStatePresenceSummaryStorageKey(ref: GroupRef): string {
    return groupStateGroupStorageKey(ref);
}

export function groupStateIdempotencyStorageKey(
    ref: GroupRef,
    requestId: string,
): string {
    return [
        groupStateGroupStorageKey(ref),
        keyPart('request', requestId),
    ].join(':');
}
