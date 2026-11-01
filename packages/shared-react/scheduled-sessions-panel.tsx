import { toRoomEntryUrl } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import type { RallarScheduledSessions } from '@shared-web/browser/rooms/sessions/rallar-scheduled-sessions.ts';
import type { GroupSessionPreview } from '@shared/api/group-sessions/group-session-schedule.ts';
import { useEffect, useState, type FormEvent } from 'react';

export interface ScheduledSessionsPanelProps {
    readonly owner: Pick<
        RallarScheduledSessions,
        | 'getState'
        | 'onChange'
        | 'start'
        | 'stop'
        | 'refresh'
        | 'loadMore'
        | 'select'
        | 'create'
        | 'act'
        | 'retry'
        | 'enterLobby'
    >;
    readonly connected: boolean;
    readonly defaultName: string;
    readonly maxPlayers: number;
}

/** Shared view only; authoritative timing, admission and recoverable requests belong to their owners. */
export function ScheduledSessionsPanel({ owner, connected, defaultName, maxPlayers }: ScheduledSessionsPanelProps) {
    const [state, setState] = useState(owner.getState());
    useEffect(() => owner.onChange(setState), [owner]);
    useEffect(() => {
        if (connected) {
            void owner.start();
        }
        return () => owner.stop();
    }, [owner, connected]);
    const disabled = !connected || state.busy || state.retryPending;
    return (
        <section className="panel stack" aria-label="Scheduled sessions">
            <h3>Scheduled sessions</h3>
            <p>
                Reserve a player seat. The lobby opens ten minutes early; the host starts play at or after the scheduled
                time.
            </p>
            <ScheduleForm owner={owner} disabled={disabled} defaultName={defaultName} maxPlayers={maxPlayers} />
            <SessionList state={state} owner={owner} disabled={disabled} />
            {state.selected && (
                <SessionCard
                    key={`${state.selected.roomRef.groupId}:${state.selected.schedule.revision}`}
                    session={state.selected}
                    owner={owner}
                    disabled={disabled}
                />
            )}
            {state.busy && <p role="status">Saving session…</p>}
            {state.error && <p role="alert">{state.error}</p>}
            {state.retryPending && (
                <button
                    type="button"
                    disabled={state.busy || !connected}
                    onClick={() => void owner.retry()}
                >
                    Retry session request
                </button>
            )}
            <button type="button" disabled={state.busy || !connected} onClick={() => void owner.refresh()}>
                Refresh sessions
            </button>
        </section>
    );
}

interface SessionListProps extends Pick<ScheduledSessionsPanelProps, 'owner'> {
    readonly state: RallarScheduledSessions.State;
    readonly disabled: boolean;
}

function SessionList({ state, owner, disabled }: SessionListProps) {
    return (
        <div className="stack" aria-label="Your scheduled sessions">
            {state.sessions.length === 0 && <p>No scheduled sessions saved for this account.</p>}
            {state.sessions.map((session) => (
                <button
                    type="button"
                    key={session.roomRef.groupId}
                    disabled={disabled}
                    onClick={() => void owner.select(session.roomRef)}
                >
                    {session.displayName} · {formatInstant(session.schedule.startsAtEpochMs)}
                    {session.timing.phase === 'cancelled' ? ' · Cancelled' : ''}
                </button>
            ))}
            {state.hasMore && (
                <button type="button" disabled={disabled} onClick={() => void owner.loadMore()}>
                    More sessions
                </button>
            )}
        </div>
    );
}

interface ScheduleFormProps extends Pick<ScheduledSessionsPanelProps, 'owner' | 'defaultName' | 'maxPlayers'> {
    readonly disabled: boolean;
}

function ScheduleForm({ owner, disabled, defaultName, maxPlayers }: ScheduleFormProps) {
    const [name, setName] = useState('');
    const [date, setDate] = useState(() => toLocalDateInput(Date.now() + 3_600_000));
    const [capacity, setCapacity] = useState(maxPlayers);
    const startsAtEpochMs = new Date(date).getTime();
    const valid = Number.isFinite(startsAtEpochMs) && startsAtEpochMs > Date.now();
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (valid && !disabled) {
            void owner.create({ displayName: `${defaultName}: ${name.trim()}`, startsAtEpochMs, maxPlayers: capacity });
        }
    };
    return (
        <details>
            <summary>Schedule a session</summary>
            <form className="stack" onSubmit={submit}>
                <label>
                    Session name<input
                        required
                        maxLength={100}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                </label>
                <label>
                    Session start<input
                        required
                        type="datetime-local"
                        step={1}
                        value={date}
                        onChange={(event) => setDate(event.target.value)}
                    />
                </label>
                <p>
                    Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}.{' '}
                    {valid ? formatInstant(startsAtEpochMs) : 'Choose a future start time.'}
                </p>
                <label>
                    Player seats<input
                        required
                        type="number"
                        min={1}
                        max={maxPlayers}
                        value={capacity}
                        onChange={(event) => setCapacity(event.target.valueAsNumber)}
                    />
                </label>
                <p>Your seat is included. Creating this unlisted room keeps you in your current game.</p>
                <button
                    type="submit"
                    disabled={disabled || !valid || !name.trim() || !Number.isInteger(capacity) || capacity < 1 ||
                        capacity > maxPlayers}
                >
                    Create scheduled session
                </button>
            </form>
        </details>
    );
}

interface SessionCardProps extends Pick<ScheduleFormProps, 'owner' | 'disabled'> {
    readonly session: GroupSessionPreview;
}

function SessionCard({ session, owner, disabled }: SessionCardProps) {
    return (
        <article className="stack" aria-label="Session details">
            <h4>{session.displayName}</h4>
            <p>Starts {formatInstant(session.schedule.startsAtEpochMs)}</p>
            <p>Lobby opens {formatInstant(session.timing.lobbyOpensAtEpochMs)}</p>
            <p>{session.availableSeats} of {session.maxPlayers} player seats available.</p>
            <p role="status">{sessionStatus(session)}</p>
            <SessionShareLink roomRef={session.roomRef} />
            {(session.participation === 'none' || session.participation === 'needs-confirmation') && (
                <button
                    type="button"
                    disabled={disabled || !session.canReserve}
                    onClick={() => void owner.act('reserve')}
                >
                    {session.participation === 'needs-confirmation' ? 'Confirm new time' : 'Reserve a seat'}
                </button>
            )}
            {(session.participation === 'reserved' || session.participation === 'needs-confirmation') && (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void owner.act('withdraw')}
                >
                    Cancel reservation
                </button>
            )}
            <button type="button" disabled={disabled || !session.canEnter} onClick={() => void owner.enterLobby()}>
                Enter lobby
            </button>
            {session.isOrganizer && session.timing.phase === 'upcoming' && (
                <ScheduleChanges session={session} owner={owner} disabled={disabled} />
            )}
        </article>
    );
}

function SessionShareLink({ roomRef }: Pick<GroupSessionPreview, 'roomRef'>) {
    const [copyStatus, setCopyStatus] = useState<string | null>(null);
    const link = toRoomEntryUrl(window.location.href, {
        intent: 'preview-session',
        roomRef,
        joinCode: null,
        participation: 'player'
    });
    const shareUrl = link.right ?? '';
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(shareUrl);
            setCopyStatus('Session link copied.');
        }
        catch {
            setCopyStatus('Copy failed. Select and copy the session link below.');
        }
    };
    return (
        <>
            <label>
                Session share link<input
                    aria-label="Session share link"
                    readOnly
                    value={shareUrl}
                    onFocus={(event) => event.target.select()}
                />
            </label>
            <button type="button" disabled={!shareUrl} onClick={() => void copy()}>Copy session link</button>
            {copyStatus && <p role="status">{copyStatus}</p>}
        </>
    );
}

function ScheduleChanges({ session, owner, disabled }: SessionCardProps) {
    const [date, setDate] = useState(() => toLocalDateInput(session.schedule.startsAtEpochMs));
    const startsAtEpochMs = new Date(date).getTime();
    return (
        <details>
            <summary>Change schedule</summary>
            <p>
                Rescheduling clears seat confirmations. Players must confirm the new time. Changes close when the lobby
                opens.
            </p>
            <label>
                New session start<input
                    type="datetime-local"
                    step={1}
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                />
            </label>
            <p>Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
            <button
                type="button"
                disabled={disabled || !Number.isFinite(startsAtEpochMs) ||
                    startsAtEpochMs <= session.serverNowEpochMs + 600_000}
                onClick={() => void owner.act('reschedule', startsAtEpochMs)}
            >
                Reschedule session
            </button>
            <button type="button" disabled={disabled} onClick={() => void owner.act('cancel')}>Cancel session</button>
        </details>
    );
}

function sessionStatus(session: GroupSessionPreview): string {
    if (session.timing.phase === 'cancelled') {
        return 'This session was cancelled.';
    }
    if (session.admissionDenial !== null) {
        switch (session.admissionDenial) {
            case 'group-full':
                return 'This session is full.';
            case 'member-banned':
                return 'Your account is banned from this room.';
            case 'member-removed':
                return 'Your account was removed from this room.';
            default:
                return 'Room admission is not available to this account.';
        }
    }
    if (session.participation === 'admitted') {
        return 'You are a room member. Enter the lobby when it opens; the host starts play explicitly.';
    }
    if (session.participation === 'needs-confirmation') {
        return 'The organizer changed the schedule. Confirm the new time to reserve a seat.';
    }
    if (session.timing.phase === 'reservations-expired') {
        return 'Unclaimed reservations have expired. You may enter if a player seat is available.';
    }
    return session.participation === 'reserved'
        ? 'Your seat is reserved until ten minutes after start. Entering the lobby claims it.'
        : 'Reserve a seat before entering. A reservation does not join the room.';
}

function formatInstant(epochMs: number): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(epochMs);
}

function toLocalDateInput(epochMs: number): string {
    const date = new Date(epochMs);
    return new Date(epochMs - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}
