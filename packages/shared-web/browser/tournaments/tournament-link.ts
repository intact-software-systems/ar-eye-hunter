import type { StateScope } from '@shared/api/state-types.ts';
import { decodeTournamentRef } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import type { TournamentRef } from '@shared/api/tournaments/tournament-types.ts';

/** A share link selects a preview; it never registers or admits its recipient. */
export function readTournamentLink(hash: string, scope: StateScope): TournamentRef | null {
    const prefix = '#rallar-tournament?';
    if (!hash.startsWith(prefix)) {
        return null;
    }
    const parameters = new URLSearchParams(hash.slice(prefix.length));
    if (parameters.size !== 3) {
        return null;
    }
    try {
        const ref = decodeTournamentRef(Object.fromEntries(parameters));
        return ref.applicationId === scope.applicationId && ref.workspaceId === scope.workspaceId ? ref : null;
    }
    catch {
        return null;
    }
}

export function toTournamentLink(url: string, ref: TournamentRef): string {
    const decoded = decodeTournamentRef(ref);
    const link = new URL(url);
    link.hash = `rallar-tournament?${new URLSearchParams({ ...decoded })}`;
    return link.href;
}
