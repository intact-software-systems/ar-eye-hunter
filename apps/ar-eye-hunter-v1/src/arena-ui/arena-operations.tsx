import { useState, type FormEvent } from 'react';

import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
import { GAME_ROOM_NAME } from '../game/types.ts';
import { toDirectorAttemptLabel, toDirectorLabel, toMatchLabel, toShortId } from './to-arena-labels.ts';

interface ArenaOperationsProps {
    readonly arena: ArenaConnection;
    readonly localColor: string;
    readonly matchRemainingMs: number;
}
interface ArenaAuthFields {
    readonly mode: 'login' | 'register';
    readonly username: string;
    readonly displayName: string;
    readonly password: string;
}
interface ArenaAuthFormProps {
    readonly fields: ArenaAuthFields;
    readonly setFields: (fields: ArenaAuthFields) => void;
    readonly submit: (event: FormEvent) => Promise<void>;
}

export function ArenaOperations(props: ArenaOperationsProps) {
    const { arena } = props;
    const [fields, setFields] = useState<ArenaAuthFields>({
        mode: 'login',
        username: '',
        displayName: '',
        password: ''
    });
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (fields.mode === 'login') {
            await arena.login(fields.username.trim(), fields.password);
        }
        else {
            await arena.register(fields.username.trim(), fields.password, fields.displayName.trim());
        }
    };
    return (
        <section className="hud hud--side" aria-label="Arena operations">
            {arena.connectionState === 'signed-out' || !arena.session
                ? <ArenaAuthForm fields={fields} setFields={setFields} submit={submit} />
                : <ArenaSessionPanel {...props} />}
            {arena.error && <div className="panel error-panel">{arena.error}</div>}
            <div className="panel compact">
                <div className="control-grid">
                    {[
                        'WASD',
                        'Move',
                        'Shift',
                        'Sprint',
                        'E',
                        'Dash',
                        'C/Ctrl',
                        'Slide',
                        'Space',
                        'Jump',
                        'Mouse',
                        'Look',
                        'Click',
                        'Fire',
                        'Right click',
                        'Scan'
                    ].map((label) => <span key={label}>{label}</span>)}
                </div>
            </div>
        </section>
    );
}

function ArenaAuthForm({ fields, setFields, submit }: ArenaAuthFormProps) {
    return (
        <form className="panel stack" onSubmit={submit}>
            <div className="segmented">
                <button
                    type="button"
                    className={fields.mode === 'login' ? 'active' : ''}
                    onClick={() => setFields({ ...fields, mode: 'login' })}
                >
                    Login
                </button>
                <button
                    type="button"
                    className={fields.mode === 'register' ? 'active' : ''}
                    onClick={() => setFields({ ...fields, mode: 'register' })}
                >
                    Register
                </button>
            </div>
            <label>
                Username<input
                    autoComplete="username"
                    value={fields.username}
                    onChange={(event) => setFields({ ...fields, username: event.target.value })}
                />
            </label>
            {fields.mode === 'register' && (
                <label>
                    Display name<input
                        value={fields.displayName}
                        onChange={(event) => setFields({ ...fields, displayName: event.target.value })}
                    />
                </label>
            )}
            <label>
                Password<input
                    autoComplete={fields.mode === 'login' ? 'current-password' : 'new-password'}
                    type="password"
                    value={fields.password}
                    onChange={(event) => setFields({ ...fields, password: event.target.value })}
                />
            </label>
            <button type="submit" className="primary" disabled={!fields.username.trim() || !fields.password}>
                {fields.mode === 'login' ? 'Enter Arena' : 'Create Hunter'}
            </button>
        </form>
    );
}

function ArenaSessionPanel({ arena, localColor, matchRemainingMs }: ArenaOperationsProps) {
    return (
        <div className="panel stack">
            <div className="profile-row">
                <span className="avatar-dot" style={{ background: localColor }} />
                <div>
                    <strong>{arena.session?.username}</strong>
                    <span>{toShortId(arena.session?.sessionId ?? '')}</span>
                </div>
            </div>
            <div className="room-actions">
                <button type="button" onClick={arena.createArenaRoom}>New Arena</button>
                <button type="button" onClick={arena.refreshRooms}>Refresh</button>
                <button type="button" onClick={arena.logout}>Logout</button>
            </div>
            <div className="director-panel">
                <div>
                    <span>Director</span>
                    <strong>{toDirectorLabel(arena.directorStatus)}</strong>
                </div>
                <button
                    type="button"
                    className="primary"
                    disabled={!arena.roomId || arena.directorStatus.isDirector ||
                        arena.directorAttempt.status === 'pending'}
                    onClick={arena.appointSelfAsDirector}
                >
                    {arena.directorAttempt.status === 'pending' ? 'Appointing...' : 'Appoint this SPA'}
                </button>
            </div>
            {arena.directorAttempt.status !== 'idle' && (
                <p className="attempt-note">{toDirectorAttemptLabel(arena.directorAttempt)}</p>
            )}
            <ArenaMatchControls arena={arena} matchRemainingMs={matchRemainingMs} />
            <div className="director-panel director-panel--event">
                <div>
                    <span>Chaos</span>
                    <strong>{arena.activeEvent?.headline ?? 'arming'}</strong>
                </div>
                <span className="event-kind">{arena.activeEvent?.kind ?? arena.aiStatus}</span>
            </div>
            <ArenaRoomList arena={arena} />
        </div>
    );
}

function ArenaMatchControls({ arena, matchRemainingMs }: Pick<ArenaOperationsProps, 'arena' | 'matchRemainingMs'>) {
    const match = arena.arenaSnapshot?.match;
    return (
        <div className="match-panel">
            <div>
                <span>Match</span>
                <strong>{toMatchLabel(match, matchRemainingMs)}</strong>
            </div>
            <div className="match-buttons">
                {([60_000, 180_000, 300_000] as const).map((duration) => (
                    <button
                        type="button"
                        key={duration}
                        disabled={!arena.directorStatus.isDirector || !arena.directorStatus.isFresh ||
                            match?.status === 'active'}
                        onClick={() => void arena.startArenaMatch(duration)}
                    >
                        {duration / 60_000}m
                    </button>
                ))}
            </div>
        </div>
    );
}

function ArenaRoomList({ arena }: Pick<ArenaOperationsProps, 'arena'>) {
    const rooms = arena.rooms.filter((room) =>
        room.name.toLowerCase().includes('eye hunter') || room.name === GAME_ROOM_NAME
    );
    return (
        <div className="room-list">
            {rooms.length === 0 && <p className="muted">Create an arena or join from another browser session.</p>}
            {rooms.map((room) => (
                <button
                    type="button"
                    key={room.roomId}
                    className={room.roomId === arena.roomId ? 'room-row active' : 'room-row'}
                    onClick={() => arena.joinRoom(room.roomId)}
                >
                    <span>{room.name}</span>
                    <small>{room.onlineMemberCount} online</small>
                </button>
            ))}
        </div>
    );
}
