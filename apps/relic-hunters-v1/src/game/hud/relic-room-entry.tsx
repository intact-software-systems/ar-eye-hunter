import { useEffect, useState, type FormEvent } from 'react';

import { RELIC_ROOM_SCOPE } from '../relic-hunters-browser.ts';
import type { RelicHuntersRuntime } from '../relic-hunters-runtime.ts';

interface RelicRoomEntryProps {
    readonly game: RelicHuntersRuntime.Connection;
}

interface RelicRoomEntryDraft {
    readonly reference: string;
    readonly code: string;
}

export function RelicRoomEntry({ game }: RelicRoomEntryProps) {
    const owner = game.roomEntry;
    const [entry, setEntry] = useState(owner.getState());
    const [draft, setDraft] = useState<RelicRoomEntryDraft>({ reference: '', code: '' });
    useEffect(() => owner.onChange(setEntry), [owner]);
    useEffect(() => {
        setDraft({ reference: entry.destination?.roomRef.groupId ?? '', code: entry.destination?.joinCode ?? '' });
    }, [entry.destination]);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        owner.enter({
            roomRef: { ...RELIC_ROOM_SCOPE, groupId: draft.reference.trim() },
            joinCode: draft.code.trim() || null
        });
    };
    const pending = entry.status !== 'idle' && entry.status !== 'entered';
    return (
        <section className="panel stack" aria-label="Shared room entry">
            <h3>Enter a shared expedition</h3>
            <RelicRoomEntryForm
                draft={draft}
                setDraft={setDraft}
                submit={submit}
                joining={entry.status === 'joining'}
            />
            {pending && entry.destination && <p>Room destination: {entry.destination.roomRef.groupId}</p>}
            {pending && entry.destination && !game.session && <p>Sign in to enter this room.</p>}
            {entry.status === 'joining' && <p role="status">Entering the expedition room…</p>}
            {entry.status === 'entered' && <p aria-live="polite">Entered {entry.destination?.roomRef.groupId}.</p>}
            {entry.failure && <p role="alert">{entry.failure.message}</p>}
            {pending && (
                <div className="button-grid">
                    {entry.status === 'failed' && game.session && (
                        <button
                            type="button"
                            onClick={() => void owner.resume()}
                        >
                            Retry room entry
                        </button>
                    )}
                    <button type="button" onClick={() => owner.cancel()}>Cancel room entry</button>
                </div>
            )}
            <RelicRecentRooms game={game} joining={entry.status === 'joining'} />
        </section>
    );
}

interface RelicRecentRoomsProps extends RelicRoomEntryProps {
    readonly joining: boolean;
}

function RelicRecentRooms({ game, joining }: RelicRecentRoomsProps) {
    const owner = game.recentRooms;
    const [history, setHistory] = useState(owner.getState());
    const [selectionFailure, setSelectionFailure] = useState<string | null>(null);
    useEffect(() => owner.onChange(setHistory), [owner]);
    useEffect(() => setSelectionFailure(null), [history.principalId]);
    const principalId = history.principalId;
    return (
        <section className="stack" aria-label="Recent rooms">
            <h4>Recent rooms</h4>
            <p>
                Saved on this device for your account. Return checks access; Join Expedition remains a separate action.
            </p>
            {history.status === 'signed-out' && <p>Sign in to see your recent rooms.</p>}
            {history.status === 'loading' && <p role="status">Loading recent rooms…</p>}
            {history.status === 'ready' && history.rooms.length === 0 && <p>No recent rooms yet.</p>}
            {history.failure && (
                <div>
                    <p role="alert">{history.failure}</p>
                    <button type="button" onClick={() => void owner.retry()}>Retry recent rooms</button>
                </div>
            )}
            {selectionFailure && <p role="alert">{selectionFailure}</p>}
            {principalId && history.rooms.map(({ roomRef }) => (
                <div className="button-grid" key={roomRef.groupId}>
                    <span>{roomRef.groupId}</span>
                    <button
                        type="button"
                        aria-label={`Return to ${roomRef.groupId}`}
                        disabled={joining}
                        onClick={() => {
                            const result = game.roomEntry.returnTo(roomRef, principalId);
                            setSelectionFailure(result.left?.message ?? null);
                        }}
                    >
                        Return
                    </button>
                    <button
                        type="button"
                        aria-label={`Forget ${roomRef.groupId}`}
                        onClick={() => void owner.forget(roomRef, principalId)}
                    >
                        Forget
                    </button>
                </div>
            ))}
            {history.rooms.length > 0 && <p>Forget removes this shortcut only; it does not leave the room.</p>}
        </section>
    );
}

interface RelicRoomEntryFormProps {
    readonly draft: RelicRoomEntryDraft;
    readonly setDraft: (draft: RelicRoomEntryDraft) => void;
    readonly submit: (event: FormEvent) => void;
    readonly joining: boolean;
}

function RelicRoomEntryForm({ draft, setDraft, submit, joining }: RelicRoomEntryFormProps) {
    return (
        <form className="stack" onSubmit={submit}>
            <label>
                Room reference<input
                    autoComplete="off"
                    value={draft.reference}
                    onChange={(event) => setDraft({ ...draft, reference: event.target.value })}
                />
            </label>
            <label>
                Room code<input
                    autoComplete="off"
                    value={draft.code}
                    onChange={(event) => setDraft({ ...draft, code: event.target.value })}
                />
            </label>
            <small>
                Open the host’s link or enter its room reference. Unlisted rooms need no code; code rooms require one
                unless you are already a member.
            </small>
            <button type="submit" disabled={!draft.reference.trim() || joining}>Enter room</button>
        </form>
    );
}
