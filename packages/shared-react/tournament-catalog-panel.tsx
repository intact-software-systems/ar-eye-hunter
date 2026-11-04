import type { RallarTournamentCatalog } from '@shared-web/browser/tournaments/rallar-tournament-catalog.ts';
import type { TournamentCatalogEntry } from '@shared/api/tournaments/tournament-catalog.ts';
import { useEffect, useState } from 'react';

export interface TournamentCatalogPanelProps {
    readonly owner: RallarTournamentCatalog;
    readonly onSelect: (tournamentId: string) => void;
}

export function TournamentCatalogPanel({ owner, onSelect }: TournamentCatalogPanelProps) {
    const [state, setState] = useState(owner.getState());
    useEffect(() => owner.onChange(setState), [owner]);
    useEffect(() => {
        void owner.start();
        return () => owner.stop();
    }, [owner]);
    const busy = state.status === 'loading';
    return (
        <section className="stack" aria-label="Tournament catalogue">
            <nav aria-label="Tournament views">
                <button
                    type="button"
                    aria-pressed={state.view === 'public'}
                    onClick={() => void owner.changeView('public')}
                >
                    Discover
                </button>
                <button
                    type="button"
                    aria-pressed={state.view === 'mine'}
                    onClick={() => void owner.changeView('mine')}
                >
                    My tournaments
                </button>
            </nav>
            <p>
                {state.view === 'public'
                    ? 'Published tournaments in this game and workspace.'
                    : 'Your organized tournaments and current or past bracket participation.'}
            </p>
            <TournamentCatalogStatus state={state} />
            <button type="button" disabled={busy || state.paused} onClick={() => void owner.refresh()}>
                Refresh tournaments
            </button>
            <div className="stack">
                {state.entries.map((entry) => (
                    <TournamentCatalogCard key={entry.ref.tournamentId} entry={entry} onSelect={onSelect} />
                ))}
            </div>
            {state.nextCursor !== null && (
                <button
                    type="button"
                    disabled={busy || state.paused}
                    onClick={() => void owner.loadMore()}
                >
                    Load more tournaments
                </button>
            )}
            <p>Open a tournament to see match times and registration.</p>
        </section>
    );
}

interface TournamentCatalogStatusProps {
    readonly state: RallarTournamentCatalog.State;
}

function TournamentCatalogStatus({ state }: TournamentCatalogStatusProps) {
    return (
        <>
            {state.paused && <p role="status">Offline or hidden. Refresh resumes when you return online.</p>}
            {state.stale && <p role="status">Showing earlier results. They may be out of date.</p>}
            {state.status === 'loading' && <p role="status">Loading tournaments…</p>}
            {state.error && <p role="alert">{state.error}</p>}
            {state.status === 'ready' && state.entries.length === 0 && (
                <p>
                    {state.nextCursor === null
                        ? 'No tournaments found.'
                        : 'No matches in these pages. More tournaments may be available.'}
                </p>
            )}
        </>
    );
}

interface TournamentCatalogCardProps {
    readonly entry: TournamentCatalogEntry;
    readonly onSelect: (tournamentId: string) => void;
}

function TournamentCatalogCard({ entry, onSelect }: TournamentCatalogCardProps) {
    return (
        <article className="panel stack" aria-label={`Tournament ${entry.title}`}>
            <h4>{entry.title}</h4>
            <p>{entry.status} · {entry.activeEntrantCount}/4 players · Organizer: {entry.organizerPrincipalId}</p>
            <p>
                {entry.nextScheduledAtEpochMs === null
                    ? 'No match scheduled.'
                    : `Next scheduled match: ${new Date(entry.nextScheduledAtEpochMs).toLocaleString()}`}
            </p>
            <button type="button" onClick={() => onSelect(entry.ref.tournamentId)}>Open tournament</button>
        </article>
    );
}
