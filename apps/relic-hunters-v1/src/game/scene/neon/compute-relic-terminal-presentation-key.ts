import { type RelicPublicSnapshot } from '@relic-hunters/mod.ts';

/** Native authority alone can suspend graphics; transport timestamps are not scene content. */
export function computeRelicTerminalPresentationKey(snapshot: RelicPublicSnapshot | undefined): string | undefined {
    if (!isRelicTournamentTerminal(snapshot)) {
        return undefined;
    }
    return JSON.stringify([
        snapshot.gameId,
        snapshot.roomId,
        snapshot.phase,
        snapshot.round,
        snapshot.map,
        snapshot.relics,
        snapshot.players,
        snapshot.tournament
    ]);
}

export function isRelicTournamentTerminal(snapshot: RelicPublicSnapshot | undefined): snapshot is RelicPublicSnapshot {
    return snapshot?.tournament?.status === 'finished' || snapshot?.tournament?.status === 'cancelled';
}
