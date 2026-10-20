import type { ClientPrincipalRef, ClientSession } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { readGroupVisibility } from '../group-state/policy/group-snapshot-visibility-policy.ts';
import { isClientSnapshotSessionLive } from '../presence/snapshot-presence.ts';
import { sameScope } from './state-sync-payload.ts';

/** A principal and its live sessions: all of a principal the audience reads, never its instances. */
export interface PrincipalAudienceSessions {
    readonly principalRef: ClientPrincipalRef;
    readonly activeSessions: readonly ClientSession[];
}

export interface PrincipalStateSyncAudienceInput {
    readonly principalRef: ClientPrincipalRef;
    readonly ownSessions: PrincipalAudienceSessions;
    readonly coMemberSessions: readonly PrincipalAudienceSessions[];
    readonly groupSnapshots: readonly GroupSnapshot[];
    readonly nowEpochMs: number;
}

/** Computes the full principal audience before publication; callers own the durable read. */
export function computePrincipalStateSyncAudience(
    input: PrincipalStateSyncAudienceInput
): readonly string[] {
    const { principalRef, ownSessions, coMemberSessions, groupSnapshots, nowEpochMs } = input;
    const principalIds = new Set<string>([principalRef.principalId]);
    for (const groupSnapshot of groupSnapshots) {
        if (
            !sameScope(groupSnapshot.group, principalRef) ||
            readGroupVisibility({
                    snapshot: groupSnapshot,
                    actor: { principalId: principalRef.principalId },
                    nowEpochMs
                }) !== 'full'
        ) {
            continue;
        }
        for (const member of groupSnapshot.members) {
            if (
                readGroupVisibility({
                    snapshot: groupSnapshot,
                    actor: { principalId: member.principalId },
                    nowEpochMs
                }) === 'full'
            ) {
                principalIds.add(member.principalId);
            }
        }
    }
    const audience = new Set<string>();
    for (const sessions of [ownSessions, ...coMemberSessions]) {
        if (
            !sameScope(sessions.principalRef, principalRef) ||
            !principalIds.has(sessions.principalRef.principalId) ||
            (sessions !== ownSessions && sessions.principalRef.principalId === principalRef.principalId)
        ) {
            continue;
        }
        for (const session of sessions.activeSessions) {
            if (isClientSnapshotSessionLive(session, nowEpochMs)) {
                audience.add(session.sessionId);
            }
        }
    }
    return [...audience].sort();
}
