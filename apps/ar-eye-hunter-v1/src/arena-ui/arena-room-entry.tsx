import { useEffect, useState, type FormEvent } from 'react';

import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
import { ARENA_ROOM_SCOPE, arenaRoomEntry } from '../game/arena-runtime/arena-room-entry.ts';

interface ArenaRoomEntryProps {
    readonly arena: ArenaConnection;
}

export function ArenaRoomEntry({ arena }: ArenaRoomEntryProps) {
    const [entry, setEntry] = useState(arenaRoomEntry.getState());
    const [reference, setReference] = useState('');
    const [code, setCode] = useState('');
    useEffect(() => arenaRoomEntry.onChange(setEntry), []);
    useEffect(() => {
        if (entry.status === 'entered' || entry.status === 'idle') {
            setCode('');
        }
    }, [entry.status]);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        arenaRoomEntry.enter({
            roomRef: { ...ARENA_ROOM_SCOPE, groupId: reference.trim() },
            joinCode: code.trim() || null
        });
        if (arena.connectionState === 'connected') {
            void arenaRoomEntry.resume();
        }
    };
    const destination = entry.destination?.roomRef.groupId;
    return (
        <section className="panel stack" aria-label="Private room entry">
            <h3>Enter a private arena</h3>
            <ArenaRoomEntryForm
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
        </section>
    );
}

interface ArenaRoomEntryFormProps {
    readonly reference: string;
    readonly setReference: (reference: string) => void;
    readonly code: string;
    readonly setCode: (code: string) => void;
    readonly submit: (event: FormEvent) => void;
    readonly joining: boolean;
}

function ArenaRoomEntryForm({ reference, setReference, code, setCode, submit, joining }: ArenaRoomEntryFormProps) {
    return (
        <form className="stack" onSubmit={submit}>
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
                Use the room reference and code from your host, or open their link. Members and invited accounts can
                leave the code blank.
            </p>
            <button type="submit" disabled={!reference.trim() || joining}>Enter private room</button>
        </form>
    );
}
