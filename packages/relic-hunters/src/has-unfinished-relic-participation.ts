import type { RelicPublicSnapshot } from './model.ts';

/** Banked history remains visible after withdrawal, but no longer represents a participating hunter. */
export function hasUnfinishedRelicParticipation(
    snapshot: RelicPublicSnapshot | undefined,
    playerId: string | undefined
): boolean {
    return snapshot !== undefined && snapshot.phase !== 'finished' &&
        snapshot.players.some((player) => player.playerId === playerId && player.withdrawnAtEpochMs === undefined);
}
