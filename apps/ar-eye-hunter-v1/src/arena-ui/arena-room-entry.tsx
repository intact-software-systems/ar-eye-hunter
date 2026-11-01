import {
    useEffect,
    useState,
    type FormEvent
} from 'react';

import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
import {
    ARENA_ROOM_SCOPE,
    arenaRecentRooms,
    arenaRoomEntry
} from '../game/arena-runtime/arena-room-entry.ts';

interface ArenaRoomEntryProps {
    readonly arena: ArenaConnection;
}

export function ArenaRoomEntry({ arena }: ArenaRoomEntryProps) {
    const [entry, setEntry] = useState(arenaRoomEntry.getState());
    const [reference, setReference] = useState('');
    const [code, setCode] = useState('');
    const [participation, setParticipation] = useState<'preserve' | 'spectator'>('preserve');
    useEffect(() => arenaRoomEntry.onChange(setEntry), []);
    useEffect(() => {
        if (entry.status === 'entered' || entry.status === 'idle') {
            setCode('');
        }
    }, [entry.status]);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        arenaRoomEntry.enter({
            intent: 'join',
            roomRef: { ...ARENA_ROOM_SCOPE, groupId: reference.trim() },
            joinCode: code.trim() || null,
            participation
        });
        if (arena.connectionState === 'connected') {
            void arenaRoomEntry.resume();
        }
    };
    const destination = entry.destination?.roomRef.groupId;
    return (
        <section className="panel stack" aria-label="Shared room entry">
            <h3>Enter a shared arena</h3>
            <ArenaRoomEntryForm
                participation={participation}
                setParticipation={setParticipation}
                reference={reference}
                setReference={setReference}
                code={code}
                setCode={setCode}
                submit={submit}
                joining={entry.status === 'joining'}
            />
            {destination && entry.status !== 'entered' && (
                <p>{!arena.session ? `Sign in to enter ${destination}.` : `Room destination: ${destination}`}</p>
            )}
            {entry.status === 'joining' && <p role="status">Entering the arena…</p>}
            {entry.status === 'entered' && <p aria-live="polite">Entered {destination}.</p>}
            {entry.failure && <p role="alert">{entry.failure.message}</p>}
            {entry.status !== 'idle' && entry.status !== 'entered' && (
                <div className="room-actions">
                    {entry.status === 'failed' && arena.session && (
                        <button
                            type="button"
                            onClick={() => void arenaRoomEntry.resume()}
                        >
                            Retry room entry
                        </button>
                    )}
                    <button type="button" onClick={() => arenaRoomEntry.cancel()}>Cancel room entry</button>
                </div>
            )}
            <ArenaRecentRooms arena={arena} joining={entry.status === 'joining'} />
        </section>
    );
}

interface ArenaRecentRoomsProps extends ArenaRoomEntryProps {
    readonly joining: boolean;
}

function ArenaRecentRooms({ arena, joining }: ArenaRecentRoomsProps) {
    const [history, setHistory] = useState(arenaRecentRooms.getState());
    const [selectionFailure, setSelectionFailure] = useState<string | null>(null);
    useEffect(() => arenaRecentRooms.onChange(setHistory), []);
    useEffect(() => setSelectionFailure(null), [history.principalId]);
    const principalId = history.principalId;
    return (
        <section className="stack" aria-label="Recent rooms">
            <h4>Recent rooms</h4>
            <p className="muted">Saved on this device for your account. Return checks whether you can still enter.</p>
            {history.status === 'signed-out' && <p>Sign in to see your recent rooms.</p>}
            {history.status === 'loading' && <p role="status">Loading recent rooms…</p>}
            {history.status === 'ready' && history.rooms.length === 0 && <p>No recent rooms yet.</p>}
            {history.failure && (
                <div>
                    <p role="alert">{history.failure}</p>
                    <button type="button" onClick={() => void arenaRecentRooms.retry()}>Retry recent rooms</button>
                </div>
            )}
            {selectionFailure && <p role="alert">{selectionFailure}</p>}
            {principalId && history.rooms.map(({ roomRef }) => (
                <div className="room-actions" key={roomRef.groupId}>
                    <span>{roomRef.groupId}</span>
                    <button
                        type="button"
                        aria-label={`Return to ${roomRef.groupId}`}
                        disabled={joining}
                        onClick={() => {
                            const result = arenaRoomEntry.returnTo(roomRef, principalId);
                            setSelectionFailure(result.left?.message ?? null);
                            if (result.right && arena.connectionState === 'connected') {
                                void arenaRoomEntry.resume();
                            }
                        }}
                    >
                        Return
                    </button>
                    <button
                        type="button"
                        aria-label={`Forget ${roomRef.groupId}`}
                        onClick={() => void arenaRecentRooms.forget(roomRef, principalId)}
                    >
                        Forget
                    </button>
                </div>
            ))}
            {history.rooms.length > 0 && (
                <p className="muted">Forget removes this shortcut only; it does not leave the room.</p>
            )}
        </section>
    );
}

interface ArenaRoomEntryFormProps {
    readonly participation: 'preserve' | 'spectator';
    readonly setParticipation: (participation: 'preserve' | 'spectator') => void;
    readonly reference: string;
    readonly setReference: (reference: string) => void;
    readonly code: string;
    readonly setCode: (code: string) => void;
    readonly submit: (event: FormEvent) => void;
    readonly joining: boolean;
}

function ArenaRoomEntryForm(
    { participation, setParticipation, reference, setReference, code, setCode, submit, joining }:
        ArenaRoomEntryFormProps
) {
    return (
        <form className="stack" onSubmit={submit}>
            <label>
                Participation<select
                    value={participation}
                    onChange={(event) =>
                        setParticipation(event.target.value === 'spectator' ? 'spectator' : 'preserve')}
                >
                    <option value="preserve">Enter room</option>
                    <option value="spectator">Watch</option>
                </select>
            </label>
            <label>
                Room reference<input
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    autoComplete="off"
                />
            </label>
            <label>
                Room code<input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" />
            </label>
            <p className="muted">
                Open the host’s link or enter its room reference. Unlisted rooms need no code; code rooms require one
                unless you are already a member.
            </p>
            <button type="submit" disabled={!reference.trim() || joining}>Enter room</button>
        </form>
    );
}
