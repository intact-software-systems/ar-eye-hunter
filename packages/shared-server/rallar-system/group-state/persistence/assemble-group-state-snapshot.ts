import {
    validateAuthoritativeGroupSnapshotIssues,
    type AuthoritativeStateValidationIssue
} from '@shared/api/authoritative-state-validation.ts';
import type {
    Group,
    GroupMember,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { isLogicallyActiveSession } from '../../presence/session-expiry.ts';
import { groupStateGroupStorageKey } from './aggregate/group-aggregate-storage-keys.ts';

export interface GroupStateSnapshotAssemblyInput {
    readonly group: Group;
    readonly members: readonly GroupMember[];
    readonly summary: GroupPresenceSummary | undefined;
    readonly authoritativeSessions: readonly GroupPresenceSession[];
    readonly groupRevision: number;
    readonly observedAtEpochMs: number;
    /**
     * 'authoritative' carries the liveness plane without revision movement:
     * emitted sessions take lastHeartbeatAtEpochMs/expiresAtEpochMs from the
     * authoritative rows, so a summary frozen at the last transition stays
     * truthful between transitions. 'summary-frozen' reproduces the stored
     * summary copies bit-for-bit.
     */
    readonly sessionLeaseFields: 'summary-frozen' | 'authoritative';
}

export interface GroupStateScopeSnapshotRead {
    readonly groupsBefore: readonly RuntimeStateEntryValue<Group>[];
    readonly groupsAfter: readonly RuntimeStateEntryValue<Group>[];
    readonly membersByGroupId: ReadonlyMap<string, readonly GroupMember[]>;
    readonly summariesByGroupId: ReadonlyMap<string, GroupPresenceSummary>;
    readonly sessionsByGroupId: ReadonlyMap<string, readonly GroupPresenceSession[]>;
}

export interface GroupStateSnapshotPageGroup {
    readonly entry: Readonly<{ key: string; revision: number; }>;
    readonly group: Group;
}

export interface GroupStateSnapshotPageScan {
    readonly groups: readonly GroupStateSnapshotPageGroup[];
    readonly hasMore: boolean;
}

export function collectGroupStateValuesByGroupId<T extends GroupRef>(
    values: readonly T[]
): Map<string, T[]> {
    const valuesByGroupId = new Map<string, T[]>();
    for (const value of values) {
        const current = valuesByGroupId.get(value.groupId) ?? [];
        current.push(value);
        valuesByGroupId.set(value.groupId, current);
    }
    return valuesByGroupId;
}

export function assembleGroupStateSnapshot(
    input: GroupStateSnapshotAssemblyInput,
    invariantError: (storageKey: string, message: string) => Error
): GroupSnapshot {
    const snapshot = computeGroupStateSnapshot(input);
    const issues = validateGroupStateSnapshotAssembly(input, snapshot);
    if (issues.length > 0) {
        throw invariantError(groupStateGroupStorageKey(input.group), issues[0].message);
    }
    return snapshot;
}

export function computeGroupStateSnapshot(input: GroupStateSnapshotAssemblyInput): GroupSnapshot {
    const activeMemberIds = new Set(
        input.members
            .filter((member) => member.status === 'active')
            .map((member) => member.principalId)
    );
    const activeSessions = computeActiveSessions(input, activeMemberIds);
    const presenceRevision = input.summary?.causalRevision.presenceRevision ?? 0;
    const causalRevision = {
        groupRevision: input.groupRevision,
        presenceRevision
    };
    const activePrincipals = new Set(activeSessions.map((session) => session.principalId));
    const activeMembers = input.members.filter((member) => member.status === 'active');
    return {
        causalRevision,
        group: { ...input.group, presenceVersion: presenceRevision },
        members: input.members,
        activeSessions,
        memberCount: activeMembers.length,
        onlineMemberCount: activeMembers.filter((member) => activePrincipals.has(member.principalId))
            .length
    };
}

function computeActiveSessions(
    input: GroupStateSnapshotAssemblyInput,
    activeMemberIds: ReadonlySet<string>
): readonly GroupPresenceSession[] {
    const groupAllowsLivePresence = input.group.status === 'active' &&
        (input.group.expiresAtEpochMs === null ||
            input.group.expiresAtEpochMs > input.observedAtEpochMs);
    if (!groupAllowsLivePresence) {
        return [];
    }
    const authoritativeSessionsById = new Map(
        input.authoritativeSessions.map((session) => [session.sessionId, session])
    );
    const summarySessions = input.sessionLeaseFields === 'authoritative'
        ? (input.summary?.activeSessions ?? [])
        : toActiveSessions(input.summary?.activeSessions ?? [], input.observedAtEpochMs);
    return summarySessions
        .filter((session) => activeMemberIds.has(session.principalId))
        .flatMap((session) => {
            const authoritative = authoritativeSessionsById.get(session.sessionId);
            if (
                authoritative === undefined ||
                authoritative.principalId !== session.principalId ||
                authoritative.generationId !== session.generationId ||
                authoritative.generationVersion !== session.generationVersion ||
                authoritative.disconnectedAtEpochMs !== null ||
                session.disconnectedAtEpochMs !== null ||
                !isLogicallyActiveSession(authoritative.expiresAtEpochMs, input.observedAtEpochMs)
            ) {
                return [];
            }
            if (input.sessionLeaseFields === 'summary-frozen') {
                return [session];
            }
            return [
                {
                    ...session,
                    lastHeartbeatAtEpochMs: authoritative.lastHeartbeatAtEpochMs,
                    expiresAtEpochMs: authoritative.expiresAtEpochMs
                }
            ];
        });
}

export function validateGroupStateSnapshotAssembly(
    input: GroupStateSnapshotAssemblyInput,
    snapshot: GroupSnapshot
): readonly AuthoritativeStateValidationIssue[] {
    const activeMembers = input.members.filter((member) => member.status === 'active');
    const activeOwners = activeMembers.filter((member) => member.role === 'owner');
    const rosterIsInvalid = input.group.activeMemberCount !== activeMembers.length ||
        (input.group.maxMembers !== null && activeMembers.length > input.group.maxMembers) ||
        activeOwners.length !== 1 || activeOwners[0]?.principalId !== input.group.ownerPrincipalId;
    return [
        ...(rosterIsInvalid ? [{ path: 'members', message: 'Stored group roster facts are inconsistent' }] : []),
        ...validateAuthoritativeGroupSnapshotIssues(snapshot, input.group)
    ];
}

function toActiveSessions(
    sessions: readonly GroupPresenceSession[],
    observedAtEpochMs: number
): readonly GroupPresenceSession[] {
    return sessions.filter(
        (session) =>
            session.disconnectedAtEpochMs === null &&
            isLogicallyActiveSession(session.expiresAtEpochMs, observedAtEpochMs)
    );
}
