import { useState, type FormEvent } from 'react';

import { toGroupDirectoryListing } from '@shared/api/group-directory/group-directory-listing.ts';

import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
import { ArenaRoomEntry } from './arena-room-entry.tsx';
import { ArenaRoomHosting } from './arena-room-hosting.tsx';
import {
    toDirectorAttemptLabel,
    toDirectorLabel,
    toMatchLabel,
    toShortId
} from './to-arena-labels.ts';

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
            <ArenaRoomEntry arena={arena} />
            {arena.connectionState === 'signed-out' || !arena.session
                ? <ArenaAuthForm fields={fields} setFields={setFields} submit={submit} />
                : <ArenaSessionPanel key={arena.session.sessionId} {...props} />}
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
            <label>
                Account reference<input value={arena.session?.clientId ?? ''} readOnly />
            </label>
            <ArenaQuickJoin arena={arena} />
            <div className="room-actions">
                <button type="button" onClick={() => void arena.createArenaRoom()}>New Arena</button>
                <button type="button" onClick={arena.refreshRooms}>Refresh</button>
                <button type="button" onClick={arena.logout}>Logout</button>
            </div>
            <ArenaRoomHosting arena={arena} />
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

function ArenaQuickJoin({ arena }: Pick<ArenaOperationsProps, 'arena'>) {
    const [status, setStatus] = useState<'idle' | 'joining' | 'joined' | 'unavailable' | 'error'>('idle');
    const [error, setError] = useState<string | undefined>();
    const join = async () => {
        setStatus('joining');
        setError(undefined);
        try {
            const result = await arena.quickJoinArenaRoom();
            setStatus(result ?? 'idle');
        }
        catch (error) {
            setError(error instanceof Error ? error.message : String(error));
            setStatus('error');
        }
    };
    return (
        <div className="stack">
            <button type="button" className="primary" onClick={join} disabled={status === 'joining'}>
                {status === 'joining' ? 'Joining…' : 'Quick Join'}
            </button>
            <p className="muted" role="status">
                {status === 'unavailable' && 'No available arena. Try again or create one.'}
                {status === 'joined' && 'Joined arena.'}
                {status === 'error' && error}
            </p>
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

function ArenaLatencyPreference({ arena }: Pick<ArenaOperationsProps, 'arena'>) {
    return (
        <>
            <label className="directory-latency-preference">
                <input
                    type="checkbox"
                    checked={arena.directoryOrder === 'peer-rtt'}
                    onChange={(event) =>
                        void arena.changeDirectoryOrder(event.target.checked ? 'peer-rtt' : 'online-members')}
                />
                Prefer lower peer latency
            </label>
            {arena.directoryOrder === 'peer-rtt' && (
                <p className="muted">
                    Occupancy comes first. Recent peer RTT breaks ties; unmeasured rooms stay available.
                </p>
            )}
        </>
    );
}

function ArenaRoomList({ arena }: Pick<ArenaOperationsProps, 'arena'>) {
    const rooms = arena.rooms.filter((room) =>
        room.name.toLowerCase().includes('eye hunter') &&
        ((room.joinMode === 'open' && toGroupDirectoryListing(room.snapshot.group.metadata) === 'listed') ||
            room.snapshot.members.some((member) =>
                member.principalId === arena.session?.clientId && member.status === 'active'
            ))
    );
    return (
        <>
            <ArenaLatencyPreference arena={arena} />
            <div className="room-list">
                {arena.openRoomsStatus === 'loading' && <p className="muted">Loading open arenas…</p>}
                {arena.openRoomsStatus === 'ready' && rooms.length === 0 && arena.openRooms.length === 0 && (
                    <p className="muted">Create an arena or join from another browser session.</p>
                )}
                {arena.openRoomsStatus === 'error' && (
                    <p className="muted">Could not load open arenas: {arena.openRoomsError}</p>
                )}
                {arena.openRoomsStatus !== 'ready' && arena.openRooms.length > 0 && (
                    <p className="muted">Last loaded arenas — refresh to check availability.</p>
                )}
                {rooms.map((room) => (
                    <button
                        type="button"
                        key={room.roomId}
                        data-room-id={room.roomId}
                        className={room.roomId === arena.roomId ? 'room-row active' : 'room-row'}
                        onClick={() => arena.joinRoom(room.roomId)}
                    >
                        <span>{room.name}</span>
                        <small>{room.onlineMemberCount} online</small>
                    </button>
                ))}
                {arena.openRooms.length > 0 && <p className="muted">Open arenas</p>}
                {arena.openRooms.map((room) => (
                    <button
                        type="button"
                        key={room.groupRef.groupId}
                        data-room-id={room.groupRef.groupId}
                        className="room-row"
                        disabled={room.isFull}
                        onClick={() => arena.joinRoom(room.groupRef.groupId)}
                    >
                        <span>{room.displayName}</span>
                        <small>
                            {room.isFull ? 'Full' : `${room.onlineMemberCount} online · Request to join`}
                            {arena.directoryOrder === 'peer-rtt' && (
                                <>
                                    <br />
                                    {room.peerRttMs === null
                                        ? 'Peer latency unknown'
                                        : `${Math.round(room.peerRttMs)} ms peer RTT`}
                                </>
                            )}
                        </small>
                    </button>
                ))}
            </div>
        </>
    );
}
