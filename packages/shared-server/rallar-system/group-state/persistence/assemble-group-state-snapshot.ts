import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type {
    Group,
    GroupMember,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import { isLogicallyActiveSession } from '../../presence/session-expiry.ts';
import { groupStateGroupStorageKey } from './group-state-storage-keys.ts';

export type GroupStateSnapshotAssemblyInput = Readonly<{
    group: Group;
    members: readonly GroupMember[];
    summary: GroupPresenceSummary | undefined;
    authoritativeSessions: readonly GroupPresenceSession[];
    groupRevision: number;
    observedAtEpochMs: number;
    /**
     * 'authoritative' carries the liveness plane without revision movement:
     * emitted sessions take lastHeartbeatAtEpochMs/expiresAtEpochMs from the
     * authoritative rows, so a summary frozen at the last transition stays
     * truthful between transitions. 'summary-frozen' reproduces the stored
     * summary copies bit-for-bit.
     */
    sessionLeaseFields: 'summary-frozen' | 'authoritative';
}>;

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

interface SnapshotInvariantContext {
    readonly storageKey: string;
    readonly invariantError: (storageKey: string, message: string) => Error;
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
    const activeMemberIds = new Set(
        input.members
            .filter((member) => member.status === 'active')
            .map((member) => member.principalId)
    );
    const activeSessions = readActiveSessions(input, activeMemberIds);
    const presenceRevision = input.summary?.causalRevision.presenceRevision ?? 0;
    const causalRevision = {
        groupRevision: input.groupRevision,
        presenceRevision
    };
    const activePrincipals = new Set(activeSessions.map((session) => session.principalId));
    const activeMembers = input.members.filter((member) => member.status === 'active');
    const invariantContext = {
        storageKey: groupStateGroupStorageKey(input.group),
        invariantError
    };
    assertStoredRoster(input, activeMembers, invariantContext);
    const snapshot: GroupSnapshot = {
        causalRevision,
        group: { ...input.group, presenceVersion: presenceRevision },
        members: input.members,
        activeSessions,
        memberCount: activeMembers.length,
        onlineMemberCount: activeMembers.filter((member) => activePrincipals.has(member.principalId))
            .length
    };
    assertValidSnapshot(snapshot, input.group, invariantContext);
    return snapshot;
}

function readActiveSessions(
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

function assertStoredRoster(
    input: GroupStateSnapshotAssemblyInput,
    activeMembers: readonly GroupMember[],
    invariantContext: SnapshotInvariantContext
): void {
    const activeOwners = activeMembers.filter((member) => member.role === 'owner');
    if (
        input.group.activeMemberCount !== activeMembers.length ||
        (input.group.maxMembers !== null && activeMembers.length > input.group.maxMembers) ||
        activeOwners.length !== 1 ||
        activeOwners[0]?.principalId !== input.group.ownerPrincipalId
    ) {
        throw invariantContext.invariantError(
            invariantContext.storageKey,
            'Stored group roster facts are inconsistent'
        );
    }
}

function assertValidSnapshot(
    snapshot: GroupSnapshot,
    group: Group,
    invariantContext: SnapshotInvariantContext
): void {
    try {
        validateAuthoritativeGroupSnapshot(snapshot, group);
    }
    catch (error) {
        throw invariantContext.invariantError(
            invariantContext.storageKey,
            error instanceof Error ? error.message : 'Stored group snapshot is invalid'
        );
    }
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
