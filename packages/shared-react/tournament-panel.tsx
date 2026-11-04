import type { RallarTournament } from '@shared-web/browser/tournaments/rallar-tournament.ts';
import { readTournamentLink, toTournamentLink } from '@shared-web/browser/tournaments/tournament-link.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { TournamentSnapshot } from '@shared/api/tournaments/tournament-snapshot.ts';
import type { Tournament, TournamentMatch } from '@shared/api/tournaments/tournament-types.ts';
import { useEffect, useState } from 'react';

export interface TournamentPanelProps {
    readonly scope: StateScope;
    readonly createOwner: (tournamentId: string) => RallarTournament;
}

/** Owns selection and presentation; the resource owns authenticated commands and room entry. */
export function TournamentPanel({ scope, createOwner }: TournamentPanelProps) {
    const [owner, setOwner] = useState(() => {
        const ref = readTournamentLink(window.location.hash, scope);
        return ref === null ? null : createOwner(ref.tournamentId);
    });
    const selectOwner = (tournamentId: string) => {
        const next = createOwner(tournamentId);
        window.history.replaceState(null, '', toTournamentLink(window.location.href, next.ref));
        setOwner(next);
    };
    useEffect(() => {
        const select = () => {
            const ref = readTournamentLink(window.location.hash, scope);
            if (ref !== null) {
                setOwner(createOwner(ref.tournamentId));
            }
        };
        window.addEventListener('hashchange', select);
        return () => window.removeEventListener('hashchange', select);
    }, [scope, createOwner]);
    return (
        <section className="panel stack" aria-label="Tournaments">
            <h3>Tournaments</h3>
            <p>Four players, two semifinals and a final. Registration order sets the seeds. Ties are replayed.</p>
            <TournamentLinkPreview scope={scope} onSelect={selectOwner} />
            <button type="button" onClick={() => selectOwner(crypto.randomUUID())}>New tournament</button>
            {owner && <SelectedTournament owner={owner} />}
        </section>
    );
}

interface TournamentLinkPreviewProps {
    readonly scope: StateScope;
    readonly onSelect: (tournamentId: string) => void;
}

function TournamentLinkPreview({ scope, onSelect }: TournamentLinkPreviewProps) {
    const [reference, setReference] = useState('');
    const [linkError, setLinkError] = useState<string | null>(null);
    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                const ref = readTournamentLink(new URL(reference, window.location.href).hash, scope);
                if (ref === null) {
                    setLinkError('Use a tournament link for this game and workspace.');
                }
                else {
                    setLinkError(null);
                    onSelect(ref.tournamentId);
                }
            }}
        >
            <label>
                Tournament link<input
                    type="url"
                    required
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                />
            </label>
            <button type="submit">Preview tournament</button>
            {linkError && <p role="alert">{linkError}</p>}
        </form>
    );
}

interface TournamentOwnerProps {
    readonly owner: RallarTournament;
}

function SelectedTournament({ owner }: TournamentOwnerProps) {
    const [state, setState] = useState(owner.getState());
    useEffect(() => owner.onChange(setState), [owner]);
    useEffect(() => {
        void owner.start();
        return () => owner.stop();
    }, [owner]);
    const disabled = state.busy || state.retryPending;
    return (
        <div className="stack">
            {state.view?.tournament && (
                <TournamentBracket
                    owner={owner}
                    snapshot={state.view}
                    tournament={state.view.tournament}
                    disabled={disabled}
                />
            )}
            {state.view && state.view.tournament === null && <TournamentCreation owner={owner} disabled={disabled} />}
            {!state.view && !state.error && <p role="status">Loading tournament…</p>}
            {state.busy && <p role="status">Updating tournament…</p>}
            {state.error && <p role="alert">{state.error}</p>}
            {state.retryPending && (
                <button type="button" disabled={state.busy} onClick={() => void owner.retry()}>
                    Retry tournament request
                </button>
            )}
            <button type="button" disabled={state.busy} onClick={() => void owner.refresh()}>Refresh tournament</button>
        </div>
    );
}

interface TournamentCreationProps extends TournamentOwnerProps {
    readonly disabled: boolean;
}

function TournamentCreation({ owner, disabled }: TournamentCreationProps) {
    const [title, setTitle] = useState('');
    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                if (title.trim()) {
                    void owner.act({ type: 'create', title: title.trim() });
                }
            }}
        >
            <p>No tournament exists at this reference. Creating one keeps you in your current room.</p>
            <label>
                Tournament title<input
                    required
                    maxLength={100}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                />
            </label>
            <button type="submit" disabled={disabled || !title.trim()}>Create tournament</button>
        </form>
    );
}

interface TournamentBracketProps extends TournamentOwnerProps {
    readonly snapshot: TournamentSnapshot;
    readonly tournament: Tournament;
    readonly disabled: boolean;
}

function TournamentBracket(props: TournamentBracketProps) {
    const { tournament, snapshot, owner, disabled } = props;
    const organizer = tournament.organizerPrincipalId === snapshot.principalId;
    const entrant = tournament.entrants.find((entry) => entry.principalId === snapshot.principalId);
    const ended = tournament.status === 'complete' || tournament.status === 'cancelled';
    return (
        <article aria-label="Tournament bracket" className="stack">
            <h4>{tournament.title}</h4>
            <p role="status">Tournament {tournament.status}</p>
            <label>
                Tournament share link<input
                    readOnly
                    value={toTournamentLink(window.location.href, tournament.ref)}
                    onFocus={(event) => event.target.select()}
                />
            </label>
            <p>
                Organizer: {tournament.organizerPrincipalId}. No-show grace: {tournament.noShowGraceMs / 60_000}{' '}
                minutes.
            </p>
            <ol>
                {tournament.entrants.map((entry) => (
                    <li key={entry.principalId}>
                        {entry.principalId}
                        {entry.withdrawnAtEpochMs === null ? '' : ' · Withdrawn'}
                    </li>
                ))}
            </ol>
            {tournament.status === 'registration' && !entrant && (
                <button
                    type="button"
                    disabled={disabled || tournament.entrants.length === 4}
                    onClick={() => void owner.act({ type: 'register' })}
                >
                    Register for tournament
                </button>
            )}
            {organizer && tournament.status === 'registration' && (
                <button
                    type="button"
                    disabled={disabled || tournament.entrants.length !== 4}
                    onClick={() => void owner.act({ type: 'launch' })}
                >
                    Launch bracket
                </button>
            )}
            {!ended && entrant && entrant.withdrawnAtEpochMs === null && (
                <TournamentExit owner={owner} disabled={disabled} action="withdraw" />
            )}
            {!ended && organizer && <TournamentExit owner={owner} disabled={disabled} action="cancel" />}
            {tournament.championPrincipalId && <p role="status">Champion: {tournament.championPrincipalId}</p>}
            {tournament.matches.map((match) => (
                <TournamentMatchCard key={match.slot} {...props} match={match} organizer={organizer} />
            ))}
        </article>
    );
}

interface TournamentExitProps extends TournamentCreationProps {
    readonly action: 'withdraw' | 'cancel';
}

function TournamentExit({ owner, disabled, action }: TournamentExitProps) {
    const [confirming, setConfirming] = useState(false);
    const label = action === 'withdraw' ? 'Withdraw from tournament' : 'Cancel tournament';
    return confirming
        ? (
            <div>
                <p>
                    {action === 'withdraw'
                        ? 'Withdraw from this bracket? An eligible opponent may advance.'
                        : 'Cancel all unfinished matches? Completed results remain.'}
                </p>
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                        setConfirming(false);
                        void owner.act({ type: action });
                    }}
                >
                    Confirm {label.toLowerCase()}
                </button>
                <button type="button" onClick={() => setConfirming(false)}>Keep tournament unchanged</button>
            </div>
        )
        : <button type="button" disabled={disabled} onClick={() => setConfirming(true)}>{label}</button>;
}

interface TournamentMatchCardProps extends TournamentBracketProps {
    readonly match: TournamentMatch;
    readonly organizer: boolean;
}

function TournamentMatchCard(props: TournamentMatchCardProps) {
    const { match, tournament, snapshot, owner, disabled, organizer } = props;
    const participant = match.principalIds?.includes(snapshot.principalId) === true;
    const attempt = match.attempt;
    return (
        <article aria-label={match.slot} className="stack">
            <h5>{match.slot.replace('-', ' ')}</h5>
            <p>{match.principalIds?.join(' vs ') ?? 'Waiting for semifinal winners'} · {match.status}</p>
            {match.resolution && <p>Winner: {match.resolution.winnerPrincipalId} · {match.resolution.reason}</p>}
            {attempt && (
                <p>
                    Scheduled: {new Date(attempt.scheduledAtEpochMs).toLocaleString()}. Checked in:{' '}
                    {attempt.checkedInPrincipalIds.join(', ') || 'Nobody'}.
                </p>
            )}
            {match.status === 'tied' && <p>Tied score. The organizer must schedule a fresh replay.</p>}
            {match.status === 'unresolved' && (
                <p>No winner can advance. The organizer can reschedule or cancel the tournament.</p>
            )}
            <TournamentMatchAdmission {...props} />
            {attempt?.startedAtEpochMs !== null && attempt &&
                (match.status === 'playing' || match.status === 'complete') && (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void owner.enter(match.slot)}
                >
                    {participant ? 'Enter tournament match' : 'Watch tournament match'}
                </button>
            )}
            {organizer && tournament.status === 'active' && match.principalIds &&
                ['ready', 'scheduled', 'tied', 'unresolved'].includes(match.status) && (
                <TournamentMatchSchedule {...props} />
            )}
        </article>
    );
}

function TournamentMatchAdmission(
    { match, tournament, snapshot, owner, disabled, organizer }: TournamentMatchCardProps
) {
    const participant = match.principalIds?.includes(snapshot.principalId) === true;
    const withdrawn = tournament.entrants.some((entry) =>
        entry.principalId === snapshot.principalId && entry.withdrawnAtEpochMs !== null
    );
    const attempt = match.attempt;
    const canCheckIn = tournament.status === 'active' && participant && !withdrawn && attempt &&
        (match.status === 'scheduled' || match.status === 'unresolved');
    return (
        <>
            {canCheckIn && (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                        void owner.act({ type: 'check-in', slot: match.slot, attemptId: attempt.binding.attemptId })}
                >
                    {attempt.checkedInPrincipalIds.includes(snapshot.principalId)
                        ? 'Confirm check-in again'
                        : 'Check in for match'}
                </button>
            )}
            {organizer && attempt && match.status === 'scheduled' && (
                <button
                    type="button"
                    disabled={disabled || attempt.checkedInPrincipalIds.length !== 2 ||
                        snapshot.observedAtEpochMs < attempt.scheduledAtEpochMs}
                    onClick={() =>
                        void owner.act({ type: 'start', slot: match.slot, attemptId: attempt.binding.attemptId })}
                >
                    Start tournament match
                </button>
            )}
        </>
    );
}

function TournamentMatchSchedule({ match, owner, disabled }: TournamentMatchCardProps) {
    const [date, setDate] = useState('');
    const scheduledAtEpochMs = new Date(date).getTime();
    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                if (Number.isFinite(scheduledAtEpochMs)) {
                    void owner.act({ type: 'schedule', slot: match.slot, scheduledAtEpochMs });
                }
            }}
        >
            <label>
                Match start<input
                    type="datetime-local"
                    required
                    step={1}
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                />
            </label>
            <p>
                Time zone:{' '}
                {Intl.DateTimeFormat().resolvedOptions().timeZone}. Rescheduling clears check-ins and creates a fresh
                game.
            </p>
            <button type="submit" disabled={disabled || !Number.isFinite(scheduledAtEpochMs)}>Schedule match</button>
        </form>
    );
}
