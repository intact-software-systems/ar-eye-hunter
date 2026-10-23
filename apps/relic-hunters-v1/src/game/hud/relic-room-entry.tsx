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
        <section className="panel stack" aria-label="Private room entry">
            <h3>Enter a private expedition</h3>
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
                Use the reference and code from your host, or open their link. Invited accounts and current members can
                leave the code blank.
            </small>
            <button type="submit" disabled={!draft.reference.trim() || joining}>Enter private room</button>
        </form>
    );
}
