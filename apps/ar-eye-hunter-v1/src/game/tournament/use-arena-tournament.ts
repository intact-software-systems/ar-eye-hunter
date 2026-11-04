import type { AuthSession } from '@shared/api/api-config.ts';
import { useContext, useEffect, useMemo, useState } from 'react';
import { ArenaTournamentClient } from './arena-tournament-client.ts';
import { ArenaTournamentsEnabled } from './arena-tournaments-enabled.ts';

/** A room is classified before the browser director may start; failed reads never select casual authority. */
export function useArenaTournament(roomId: string | undefined, session: AuthSession | undefined) {
    const enabled = useContext(ArenaTournamentsEnabled);
    const owner = useMemo(() => enabled && roomId && session ? ArenaTournamentClient.createBrowser(roomId) : null, [
        enabled,
        roomId,
        session?.clientId,
        session?.sessionId
    ]);
    const [observed, setObserved] = useState(() => ({ owner, state: owner?.getState() }));
    useEffect(() => {
        if (!owner) {
            return;
        }
        const unsubscribe = owner.onChange((state) => setObserved({ owner, state }));
        void owner.start();
        return () => {
            unsubscribe();
            owner.stop();
        };
    }, [owner]);
    const state = observed.owner === owner ? observed.state : undefined;
    return {
        enabled,
        owner,
        mode: owner === null
            ? 'casual' as const
            : state?.view
            ? state.view.tournament === null ? 'casual' as const : 'tournament' as const
            : 'loading' as const,
        snapshot: state?.view?.tournament ?? null,
        error: state?.error ?? null
    };
}
