import { useMemo, useState, type FormEvent } from 'react';

import { BabylonArena } from './game/BabylonArena.tsx';
import { colorForId } from './game/color.ts';
import { GAME_ROOM_NAME } from './game/types.ts';
import { useRallarArena } from './game/useRallarArena.ts';

type AuthMode = 'login' | 'register';

export default function App() {
    const arena = useRallarArena();
    const [authMode, setAuthMode] = useState<AuthMode>('login');
    const [username, setUsername] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [password, setPassword] = useState('');
    const [localScore, setLocalScore] = useState(0);

    const localColor = useMemo(
        () => colorForId(arena.session?.sessionId ?? 'local'),
        [arena.session?.sessionId],
    );
    const currentRoom = arena.rooms.find((room) => room.roomId === arena.roomId);
    const arenaRooms = arena.rooms.filter((room) =>
        room.name.toLowerCase().includes('eye hunter') ||
        room.name === GAME_ROOM_NAME
    );

    const submitAuth = async (event: FormEvent) => {
        event.preventDefault();
        if (authMode === 'login') {
            await arena.login(username.trim(), password);
            return;
        }

        await arena.register(username.trim(), password, displayName.trim());
    };

    return (
        <main className="app-root">
            <BabylonArena
                localUsername={arena.session?.username ?? 'hunter'}
                localColor={localColor}
                roomReady={arena.connectionState === 'connected' && Boolean(arena.roomId)}
                remotePlayers={arena.remotePlayers}
                remoteShots={arena.remoteShots}
                onLocalPose={arena.sendPose}
                onLocalShot={arena.sendShot}
                onScoreChange={setLocalScore}
            />

            <section className="hud hud--top">
                <div className="brand">
                    <span className="brand__mark" />
                    <div>
                        <h1>AR Eye Hunter</h1>
                        <p>{currentRoom?.name ?? 'No arena room selected'}</p>
                    </div>
                </div>

                <div className="status-strip">
                    <StatusPill label="Rallar" value={arena.connectionState} />
                    <StatusPill label="Score" value={String(localScore)} />
                    <StatusPill
                        label="Peers"
                        value={String(arena.remotePlayers.size)}
                    />
                </div>
            </section>

            <section className="hud hud--side">
                {arena.connectionState === 'signed-out' || !arena.session
                    ? (
                        <form className="panel stack" onSubmit={submitAuth}>
                            <div className="segmented">
                                <button
                                    type="button"
                                    className={authMode === 'login' ? 'active' : ''}
                                    onClick={() => setAuthMode('login')}
                                >
                                    Login
                                </button>
                                <button
                                    type="button"
                                    className={authMode === 'register' ? 'active' : ''}
                                    onClick={() => setAuthMode('register')}
                                >
                                    Register
                                </button>
                            </div>
                            <label>
                                Username
                                <input
                                    autoComplete="username"
                                    value={username}
                                    onChange={(event) => setUsername(event.target.value)}
                                />
                            </label>
                            {authMode === 'register' && (
                                <label>
                                    Display name
                                    <input
                                        value={displayName}
                                        onChange={(event) => setDisplayName(event.target.value)}
                                    />
                                </label>
                            )}
                            <label>
                                Password
                                <input
                                    autoComplete={authMode === 'login'
                                        ? 'current-password'
                                        : 'new-password'}
                                    type="password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                            </label>
                            <button
                                type="submit"
                                className="primary"
                                disabled={!username.trim() || !password}
                            >
                                {authMode === 'login' ? 'Enter Arena' : 'Create Hunter'}
                            </button>
                        </form>
                    )
                    : (
                        <div className="panel stack">
                            <div className="profile-row">
                                <span
                                    className="avatar-dot"
                                    style={{ background: localColor }}
                                />
                                <div>
                                    <strong>{arena.session.username}</strong>
                                    <span>{shortId(arena.session.sessionId)}</span>
                                </div>
                            </div>

                            <div className="room-actions">
                                <button type="button" onClick={arena.createArenaRoom}>
                                    New Arena
                                </button>
                                <button type="button" onClick={arena.refreshRooms}>
                                    Refresh
                                </button>
                                <button type="button" onClick={arena.logout}>
                                    Logout
                                </button>
                            </div>

                            <div className="room-list">
                                {arenaRooms.length === 0 && (
                                    <p className="muted">
                                        Create an arena or join from another browser session.
                                    </p>
                                )}
                                {arenaRooms.map((room) => (
                                    <button
                                        type="button"
                                        key={room.roomId}
                                        className={room.roomId === arena.roomId
                                            ? 'room-row active'
                                            : 'room-row'}
                                        onClick={() => arena.joinRoom(room.roomId)}
                                    >
                                        <span>{room.name}</span>
                                        <small>{room.onlineMemberCount} online</small>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                {arena.error && (
                    <div className="panel error-panel">
                        {arena.error}
                    </div>
                )}

                <div className="panel compact">
                    <div className="control-grid">
                        <span>WASD</span>
                        <span>Move</span>
                        <span>Mouse</span>
                        <span>Look</span>
                        <span>Click</span>
                        <span>Fire</span>
                    </div>
                </div>
            </section>

            <section className="hud hud--bottom">
                {[...arena.remotePlayers.values()].map((remote) => (
                    <div className="peer-chip" key={remote.pose.sessionId}>
                        <span
                            className="avatar-dot"
                            style={{ background: remote.pose.color }}
                        />
                        <strong>{remote.pose.username}</strong>
                        <span>{remote.pose.score}</span>
                    </div>
                ))}
            </section>
        </main>
    );
}

function StatusPill({ label, value }: Readonly<{ label: string; value: string }>) {
    return (
        <div className="status-pill">
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

function shortId(id: string): string {
    return id.length <= 8 ? id : id.slice(0, 8);
}
