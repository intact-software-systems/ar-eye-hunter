import { FriendsPanel } from '@shared-react/friends-panel.tsx';
import { MatchmakingPanel } from '@shared-react/matchmaking-panel.tsx';
import { ScheduledSessionsPanel } from '@shared-react/scheduled-sessions-panel.tsx';
import { RallarFriends } from '@shared-web/browser/friends/rallar-friends.ts';
import { RallarMatchmaking } from '@shared-web/browser/matchmaking/rallar-matchmaking.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { RallarScheduledSessions } from '@shared-web/browser/rooms/sessions/rallar-scheduled-sessions.ts';
import { useState, type FormEvent } from 'react';
import { GAME_ROOM_NAME } from '../game/arena-contracts.ts';
import { ARENA_ROOM_SCOPE, arenaRoomEntry } from '../game/arena-runtime/arena-room-entry.ts';
import { ArenaRoomMove } from './arena-room-move.tsx';

import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
import { ArenaRoomEntry } from './arena-room-entry.tsx';
import { ArenaRoomHosting } from './arena-room-hosting.tsx';
import { ArenaRoomList } from './arena-room-list.tsx';
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
    const [scheduledSessions] = useState(() =>
        RallarScheduledSessions.createBrowser(rallar, arenaRoomEntry, {
            scope: ARENA_ROOM_SCOPE,
            refreshIntervalMs: 5_000
        })
    );
    const [matchmaking] = useState(() =>
        RallarMatchmaking.createBrowser(rallar, arenaRoomEntry, { scope: ARENA_ROOM_SCOPE, refreshIntervalMs: 1000 })
    );
    const [friends] = useState(() =>
        RallarFriends.createBrowser(rallar, arenaRoomEntry, { scope: ARENA_ROOM_SCOPE, refreshIntervalMs: 30_000 })
    );
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
            {arena.session && <MatchmakingPanel owner={matchmaking} findLabel="Find a game" />}
            {arena.session && (
                <ScheduledSessionsPanel
                    owner={scheduledSessions}
                    connected={arena.connectionState === 'connected'}
                    defaultName={GAME_ROOM_NAME}
                    maxPlayers={16}
                />
            )}
            {arena.session && (
                <FriendsPanel
                    owner={friends}
                    sessions={scheduledSessions}
                    enabled={true}
                    scope={ARENA_ROOM_SCOPE}
                    roomRef={arena.roomId ? { ...ARENA_ROOM_SCOPE, groupId: arena.roomId } : null}
                />
            )}
            {arena.session && <ArenaRoomMove arena={arena} />}
            {arena.connectionState === 'signed-out' || !arena.session
                ? <ArenaAuthForm fields={fields} setFields={setFields} submit={submit} />
                : <ArenaSessionPanel key={arena.session.sessionId} {...props} />}
            {arena.error && <div className="panel error-panel">{arena.error}</div>}
            <ArenaControlHints spectating={arena.spectating} />
        </section>
    );
}

function ArenaControlHints({ spectating }: Readonly<{ spectating: boolean; }>) {
    return (
        <div className="panel compact">
            {spectating
                ? <p>Watching the live arena. Join as player to move and fight.</p>
                : (
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
                )}
        </div>
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
                    disabled={arena.spectating || !arena.roomId || arena.directorStatus.isDirector ||
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
                        disabled={arena.spectating || !arena.directorStatus.isDirector ||
                            !arena.directorStatus.isFresh ||
                            match !== undefined}
                        onClick={() => void arena.startArenaMatch(duration)}
                    >
                        {duration / 60_000}m
                    </button>
                ))}
            </div>
        </div>
    );
}
