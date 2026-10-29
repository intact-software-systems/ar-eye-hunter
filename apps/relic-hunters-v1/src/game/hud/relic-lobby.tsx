import { useState, type FormEvent } from 'react';

import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { readActiveGroupSessionRole, readGroupSpectatorCapacity } from '@shared/api/group-spectating.ts';

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
    const currentRoom = game.rooms.find((room) => room.roomId === game.roomId)?.snapshot;
    const hunter = game.snapshot?.players.find((player) =>
        player.playerId === game.session?.sessionId && player.withdrawnAtEpochMs === undefined
    );
    const unfinished = game.participation === 'player' && !!hunter && game.snapshot?.phase !== 'finished';
    const keeperRole = game.snapshot?.adminPlayerId
        ? readActiveGroupSessionRole(currentRoom, game.snapshot.adminPlayerId, Date.now())
        : undefined;
    const keeperPresent = keeperRole !== undefined && keeperRole !== 'spectator';
    const playerCount =
        currentRoom?.members.filter((member) => member.status === 'active' && member.role !== 'spectator').length ?? 0;
    const full = currentRoom?.group.maxMembers !== null && currentRoom?.group.maxMembers !== undefined &&
        playerCount >= currentRoom.group.maxMembers;
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
                    disabled={!game.diagnostics.middlewareConnected || unfinished}
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
            {game.roomId && (
                <div className="button-grid">
                    {game.participation === 'spectator' && (
                        <>
                            <strong>Watching</strong>
                            <button
                                type="button"
                                disabled={full || !!game.snapshot &&
                                        (game.snapshot.phase !== 'lobby' || game.snapshot.players.length >= 4)}
                                onClick={() => void game.joinAsPlayer()}
                            >
                                Join as player
                            </button>
                        </>
                    )}
                    {unfinished && (
                        <>
                            <button type="button" onClick={() => void game.leaveExpedition()}>Leave expedition</button>
                            {game.snapshot?.adminPlayerId !== hunter?.playerId && (
                                <button
                                    type="button"
                                    disabled={keeperPresent}
                                    onClick={() => void game.takeKeeper()}
                                >
                                    Take over as Keeper
                                </button>
                            )}
                            <small>
                                Leave expedition withdraws this hunter and drops carried relics. Banked results stay
                                saved.
                            </small>
                        </>
                    )}
                    <button type="button" onClick={() => void game.leaveRoom()}>Leave room</button>
                    <small>
                        Leave room removes this account from the room in every tab. Leave expedition keeps room
                        membership.
                    </small>
                </div>
            )}
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
    const watchBlocked = game.participation === 'player' && game.snapshot?.phase !== 'finished' &&
        game.snapshot?.players.some((player) =>
            player.playerId === game.session?.sessionId && player.withdrawnAtEpochMs === undefined
        );
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
            onlinePlayerCount:
                room.snapshot.members.filter((member) =>
                    member.status === 'active' && member.role !== 'spectator' &&
                    room.snapshot.activeSessions.some((presence) => presence.principalId === member.principalId)
                ).length,
            full: false,
            maxSpectators: readGroupSpectatorCapacity(room.snapshot.group.metadata),
            spectatorCount:
                room.snapshot.members.filter((member) => member.status === 'active' && member.role === 'spectator')
                    .length,
            canWatch: !room.snapshot.members.some((member) =>
                member.principalId === game.session?.clientId && (member.role === 'owner' || member.role === 'admin')
            )
        })),
        ...publicRooms.map((entry) => ({
            roomId: entry.groupRef.groupId,
            name: entry.displayName,
            onlinePlayerCount: entry.onlinePlayerCount,
            full: entry.isFull,
            maxSpectators: entry.maxSpectators,
            spectatorCount: entry.spectatorCount,
            canWatch: true
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
                <div key={room.roomId}>
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
                        <small>
                            {room.onlinePlayerCount} {room.onlinePlayerCount === 1 ? 'player' : 'players'} ·{' '}
                            {room.spectatorCount} watching{room.full && ' · Full'}
                        </small>
                    </button>
                    {!watchBlocked && room.canWatch && room.maxSpectators > 0 && (
                        <button
                            type="button"
                            aria-label={`Watch ${room.name}`}
                            disabled={room.spectatorCount >= room.maxSpectators ||
                                !game.diagnostics.middlewareConnected}
                            onClick={() => void game.watchRoom(room.roomId)}
                        >
                            Watch
                        </button>
                    )}
                </div>
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
