import type { StateScope } from '@shared/api/state-types.ts';
import { decodeTournamentRef } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import type { TournamentRef } from '@shared/api/tournaments/tournament-types.ts';
import { groupStateScopeStorageKey } from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';

export function toTournamentStorageKey(ref: TournamentRef): string {
    return `${groupStateScopeStorageKey(ref)}:tournament=${encodeURIComponent(ref.tournamentId)}`;
}

export function decodeTournamentStorageKey(key: string, scope: StateScope): TournamentRef {
    const prefix = `${groupStateScopeStorageKey(scope)}:tournament=`;
    if (!key.startsWith(prefix)) {
        throw new TypeError('Tournament key differs from requested scope');
    }
    const ref = decodeTournamentRef({ ...scope, tournamentId: decodeURIComponent(key.slice(prefix.length)) });
    if (toTournamentStorageKey(ref) !== key) {
        throw new TypeError('Tournament storage key is not canonical');
    }
    return ref;
}
