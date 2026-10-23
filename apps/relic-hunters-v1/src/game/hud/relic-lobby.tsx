import { useState, type FormEvent } from 'react';

import { isSameGroupRef } from '@shared/api/api-type-utils.ts';

import { colorForId } from '../color.ts';
import { shortId } from '../lang.ts';
import type { RelicHuntersRuntime } from '../relic-hunters-runtime.ts';
import type { RelicPreferences } from '../use-relic-preferences.ts';
import { RelicRoomHosting } from './relic-room-hosting.tsx';

interface RelicLobbyProps {
    readonly game: RelicHuntersRuntime.Connection;
    readonly preferences: RelicPreferences;
}

export function RelicLobby({ game, preferences }: RelicLobbyProps) {
    if (!game.session || game.connectionState === 'signed-out') {
        return <RelicAuthForm game={game} />;
    }
    return (
        <div id="hud-rooms" className="panel stack">
            <div className="profile-row">
                <span className="hunter-dot" style={{ background: colorForId(game.session.sessionId) }} />
                <div>
                    <strong>{game.session.username}</strong>
                    <span>{shortId(game.session.sessionId)}</span>
                </div>
            </div>
            <div className="button-grid">
                <button
                    type="button"
                    disabled={!game.diagnostics.middlewareConnected}
                    onClick={() => void game.createRoom()}
                >
                    New Room
                </button>
                <button type="button" onClick={() => void game.refreshRooms()}>Refresh</button>
                <button type="button" onClick={() => void game.logout()}>Logout</button>
                <RelicPreferencesControls preferences={preferences} />
            </div>
            <label>
                Your account reference<input value={game.session.clientId} readOnly />
            </label>
            <RelicRoomHosting game={game} />
            <RelicRoomsList game={game} />
        </div>
    );
}

interface RelicSessionProps {
    readonly game: RelicHuntersRuntime.Connection;
}

interface RelicCredentials {
    readonly mode: 'login' | 'register';
    readonly username: string;
    readonly displayName: string;
    readonly password: string;
}

function RelicAuthForm({ game }: RelicSessionProps) {
    const [credentials, setCredentials] = useState<RelicCredentials>({
        mode: 'login',
        username: '',
        displayName: '',
        password: ''
    });
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (credentials.mode === 'login') {
            await game.login(credentials.username.trim(), credentials.password);
        }
        else {
            await game.register(credentials.username.trim(), credentials.password, credentials.displayName.trim());
        }
    };
    return (
        <form className="panel stack" onSubmit={(event) => void submit(event)}>
            <div className="segmented">
                <button
                    type="button"
                    className={credentials.mode === 'login' ? 'active' : ''}
                    onClick={() => setCredentials({ ...credentials, mode: 'login' })}
                >
                    Login
                </button>
                <button
                    type="button"
                    className={credentials.mode === 'register' ? 'active' : ''}
                    onClick={() => setCredentials({ ...credentials, mode: 'register' })}
                >
                    Register
                </button>
            </div>
            <RelicCredentialFields credentials={credentials} setCredentials={setCredentials} />
            <button type="submit" className="primary" disabled={!credentials.username.trim() || !credentials.password}>
                {credentials.mode === 'login' ? 'Enter' : 'Create Hunter'}
            </button>
        </form>
    );
}

interface RelicCredentialFieldsProps {
    readonly credentials: RelicCredentials;
    readonly setCredentials: (credentials: RelicCredentials) => void;
}

function RelicCredentialFields({ credentials, setCredentials }: RelicCredentialFieldsProps) {
    return (
        <>
            <label>
                Username<input
                    autoComplete="username"
                    value={credentials.username}
                    onChange={(event) => setCredentials({ ...credentials, username: event.target.value })}
                />
            </label>
            {credentials.mode === 'register' && (
                <label>
                    Display name<input
                        value={credentials.displayName}
                        onChange={(event) => setCredentials({ ...credentials, displayName: event.target.value })}
                    />
                </label>
            )}
            <label>
                Password<input
                    autoComplete={credentials.mode === 'login' ? 'current-password' : 'new-password'}
                    type="password"
                    value={credentials.password}
                    onChange={(event) => setCredentials({ ...credentials, password: event.target.value })}
                />
            </label>
        </>
    );
}

function RelicRoomsList({ game }: RelicSessionProps) {
    const rooms = game.rooms.filter((room) =>
        room.name.toLowerCase().includes('relic hunters') &&
        room.snapshot.members.some((member) =>
            member.principalId === game.session?.clientId && member.status === 'active'
        )
    );
    const publicRooms = game.directory.entries.filter((entry) =>
        !rooms.some((room) => isSameGroupRef(room.roomRef, entry.groupRef))
    );
    const rows = [
        ...rooms.map((room) => ({
            roomId: room.roomId,
            name: room.name,
            onlineMemberCount: room.onlineMemberCount,
            full: false
        })),
        ...publicRooms.map((entry) => ({
            roomId: entry.groupRef.groupId,
            name: entry.displayName,
            onlineMemberCount: entry.onlineMemberCount,
            full: entry.isFull
        }))
    ];
    return (
        <div className="room-list" aria-busy={game.directory.status === 'loading'}>
            {game.directory.status === 'loading' && <p role="status">Loading public expeditions…</p>}
            {game.directory.status === 'error' && (
                <p role="alert">
                    Could not refresh public expeditions. Try Refresh.
                    {publicRooms.length > 0 && ' Previous results are shown.'}
                </p>
            )}
            {game.directory.status === 'ready' && game.directory.entries.length === 0 && (
                <p>No public expeditions found.</p>
            )}
            {rows.map((room) => (
                <button
                    type="button"
                    key={room.roomId}
                    data-room-id={room.roomId}
                    disabled={room.full || !game.diagnostics.middlewareConnected}
                    className={room.roomId === game.roomId ? 'room-row active' : 'room-row'}
                    onClick={() => {
                        if (room.roomId !== game.roomId) {
                            void game.joinRoom(room.roomId);
                        }
                    }}
                >
                    <span>{room.name}</span>
                    <small>{room.onlineMemberCount} online{room.full && ' · Full'}</small>
                </button>
            ))}
        </div>
    );
}

interface RelicPreferencesControlsProps {
    readonly preferences: RelicPreferences;
}

export function RelicPreferencesControls({ preferences }: RelicPreferencesControlsProps) {
    return (
        <>
            <button
                type="button"
                className={preferences.ambientEnabled ? 'active' : ''}
                onClick={preferences.toggleAmbient}
            >
                {preferences.lang === 'no' ? 'Atmosfære' : 'Atmosphere'}
            </button>
            <button type="button" onClick={preferences.toggleLanguage} title="Switch language / Bytt språk">
                {preferences.lang === 'en' ? 'Norsk' : 'English'}
            </button>
        </>
    );
}

interface SidePanelMenuItem {
    readonly id: string;
    readonly label: string;
}

interface SidePanelMenuProps {
    readonly items: readonly SidePanelMenuItem[];
    onJump(id: string): void;
}

export function SidePanelMenu({
    items,
    onJump
}: SidePanelMenuProps) {
    return (
        <nav className="side-panel-menu" aria-label="Side panel sections">
            {items.map((item) => (
                <button
                    key={item.id}
                    type="button"
                    onClick={() => onJump(item.id)}
                >
                    {item.label}
                </button>
            ))}
        </nav>
    );
}
