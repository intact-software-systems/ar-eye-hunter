import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { readGroupVisibility } from '../group-state/policy/group-snapshot-visibility-policy.ts';
import { isClientSnapshotSessionLive } from '../presence/snapshot-presence.ts';
import { sameScope } from './state-sync-payload.ts';

export interface PrincipalStateSyncAudienceInput {
    readonly principalRef: ClientPrincipalRef;
    readonly ownSnapshot: ClientSnapshot;
    readonly clientSnapshots: readonly ClientSnapshot[];
    readonly groupSnapshots: readonly GroupSnapshot[];
    readonly nowEpochMs: number;
}

/** Computes the full principal audience before publication; callers own the durable read. */
export function computePrincipalStateSyncAudience(
    input: PrincipalStateSyncAudienceInput
): readonly string[] {
    const { principalRef, ownSnapshot, clientSnapshots, groupSnapshots, nowEpochMs } = input;
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
    for (const snapshot of [ownSnapshot, ...clientSnapshots]) {
        if (
            !sameScope(snapshot.principal, principalRef) ||
            !principalIds.has(snapshot.principal.principalId) ||
            (snapshot !== ownSnapshot && snapshot.principal.principalId === principalRef.principalId)
        ) {
            continue;
        }
        for (const session of snapshot.activeSessions) {
            if (isClientSnapshotSessionLive(session, nowEpochMs)) {
                audience.add(session.sessionId);
            }
        }
    }
    return [...audience].sort();
}
