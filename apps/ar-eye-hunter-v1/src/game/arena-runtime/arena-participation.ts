import { rallar } from '@shared-web/browser/rallar.ts';
import { readActiveGroupSessionRole } from '@shared/api/group-spectating.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

export function isArenaSpectator(snapshot: GroupSnapshot | undefined, principalId: string | undefined): boolean {
    return snapshot?.members.some((member) =>
        member.principalId === principalId && member.status === 'active' && member.role === 'spectator'
    ) ?? false;
}

export function isCurrentArenaSpectator(): boolean {
    const session = rallar.session();
    return Boolean(session && isArenaSpectator(rallar.rooms.state().currentRoom, session.clientId));
}

export function isArenaPlayerSession(
    snapshot: GroupSnapshot | undefined,
    sessionId: string,
    nowEpochMs: number
): boolean {
    const role = readActiveGroupSessionRole(snapshot, sessionId, nowEpochMs);
    return role !== undefined && role !== 'spectator';
}

export function isCurrentArenaPlayerSession(sessionId: string, nowEpochMs: number): boolean {
    return isArenaPlayerSession(rallar.rooms.state().currentRoom, sessionId, nowEpochMs);
}
