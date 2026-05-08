import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type {
    RelicActionInput,
    RelicActionKind,
    RelicCharacterId,
    RelicEvent,
    RelicPlayer,
    RelicPublicSnapshot,
} from '@relic-hunters/mod.ts';
import { RELIC_CHARACTERS, findRelicCharacter } from '@relic-hunters/mod.ts';
import { RelicScene } from './game/RelicScene.tsx';
import { useRelicHunters } from './game/useRelicHunters.ts';
import { colorForId } from './game/color.ts';
import {
    isAmbientSoundPlaying,
    playActionSound,
    playRelicEventSound,
    playUiSound,
    startAmbientSound,
    stopAmbientSound,
} from './game/sound.ts';

type AuthMode = 'login' | 'register';
type ActionDraft = Readonly<{
    kind: RelicActionInput['kind'];
    targetRoomId?: string;
    targetPlayerId?: string;
}>;

export default function App() {
    const game = useRelicHunters();
    const playedEventIdsRef = useRef<Set<string>>(new Set());
    const [authMode, setAuthMode] = useState<AuthMode>('login');
    const [username, setUsername] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [password, setPassword] = useState('');
    const [selectedRoomId, setSelectedRoomId] = useState<string | undefined>();
    const [selectedCharacterId, setSelectedCharacterId] = useState<RelicCharacterId>(
        RELIC_CHARACTERS[0].id,
    );
    const [draft, setDraft] = useState<ActionDraft>({ kind: 'search' });
    const [scenePrimedAction, setScenePrimedAction] = useState<RelicActionInput | undefined>();
    const [dismissedPartyChangeKey, setDismissedPartyChangeKey] = useState<string | undefined>();
    const [ambientEnabled, setAmbientEnabled] = useState(false);

    const currentPlayer = useMemo(
        () =>
            game.snapshot?.players.find((player) =>
                player.playerId === game.session?.sessionId
            ),
        [game.session?.sessionId, game.snapshot?.players],
    );
    const currentRoom = game.snapshot?.map.find((room) =>
        room.id === currentPlayer?.roomId
    );
    const currentRoomSummary = useMemo(
        () => game.rooms.find((room) => room.roomId === game.roomId),
        [game.roomId, game.rooms],
    );
    const selectedCharacter = findRelicCharacter(
        currentPlayer && game.snapshot?.phase !== 'lobby'
            ? currentPlayer.characterId
            : selectedCharacterId,
    );
    const moveTargets = currentPlayer && game.snapshot
        ? game.snapshot.map
            .filter((room) => currentRoom?.neighbors.includes(room.id) && !room.collapsed)
            .map((room) => room.id)
        : [];
    const stealTargets = game.snapshot?.players.filter((player) =>
        currentPlayer &&
        player.playerId !== currentPlayer.playerId &&
        player.roomId === currentPlayer.roomId &&
        !player.escaped &&
        !player.defeated
    ) ?? [];
    const rooms = game.rooms.filter((room) =>
        room.name.toLowerCase().includes('relic hunters')
    );
    const lastEvent = game.snapshot?.events.at(-1);
    const progress = game.snapshot
        ? toProgress(game.snapshot, currentPlayer?.playerId)
        : undefined;
    const objective = game.snapshot
        ? toObjective(game.snapshot, currentPlayer)
        : 'Create or join a room to begin the expedition.';
    const actionInfo = ACTION_INFO[draft.kind];
    const submitBlocker = game.snapshot && currentPlayer
        ? actionBlocker(game.snapshot, currentPlayer, draft, moveTargets, stealTargets)
        : undefined;
    const canSubmit = !!game.snapshot &&
        game.snapshot.phase === 'planning' &&
        !!currentPlayer &&
        !game.snapshot.submittedPlayerIds.includes(currentPlayer.playerId) &&
        !submitBlocker;
    const partyChangeKey = game.snapshot &&
            currentRoomSummary &&
            game.snapshot.phase !== 'finished' &&
            game.snapshot.players.length > 0 &&
            currentRoomSummary.onlineMemberCount !== game.snapshot.players.length
        ? [
            game.roomId,
            game.snapshot.players.length,
            currentRoomSummary.onlineMemberCount,
        ].join(':')
        : undefined;
    const showPartyChangePrompt = !!partyChangeKey &&
        partyChangeKey !== dismissedPartyChangeKey &&
        !!game.session &&
        !!game.roomId;

    useEffect(() => {
        const events = game.snapshot?.events ?? [];
        const seen = playedEventIdsRef.current;
        if (seen.size === 0) {
            for (const event of events) {
                seen.add(event.id);
            }
            return;
        }

        for (const event of events) {
            if (seen.has(event.id)) {
                continue;
            }

            seen.add(event.id);
            playRelicEventSound(event);
        }
    }, [game.snapshot?.events]);

    useEffect(() => {
        if (currentPlayer) {
            setSelectedCharacterId(currentPlayer.characterId);
        }
    }, [currentPlayer?.characterId]);

    useEffect(() => {
        if (!game.session) {
            stopAmbientSound();
            setAmbientEnabled(false);
        }
    }, [game.session]);

    useEffect(() => {
        setScenePrimedAction(undefined);
    }, [currentPlayer?.roomId, game.snapshot?.phase, game.snapshot?.round]);

    const submitAuth = async (event: FormEvent) => {
        event.preventDefault();
        if (authMode === 'login') {
            await game.login(username.trim(), password);
            return;
        }

        await game.register(username.trim(), password, displayName.trim());
    };

    const submitAction = async () => {
        const selectedMoveTarget = selectedRoomId && moveTargets.includes(selectedRoomId)
            ? selectedRoomId
            : undefined;
        const action: RelicActionInput = draft.kind === 'move'
            ? {
                kind: 'move',
                targetRoomId: draft.targetRoomId ?? selectedMoveTarget ?? moveTargets[0],
            }
            : draft.kind === 'steal'
            ? {
                kind: 'steal',
                targetPlayerId: draft.targetPlayerId ?? stealTargets[0]?.playerId,
            }
            : { kind: draft.kind };

        playActionSound(action.kind);
        if (!isAmbientSoundPlaying()) {
            setAmbientEnabled(startAmbientSound());
        }
        await game.submitAction(action);
    };

    const joinExpedition = async () => {
        playUiSound('join');
        setAmbientEnabled(startAmbientSound());
        await game.joinExpedition(selectedCharacterId);
    };

    const startExpedition = async () => {
        playUiSound('start');
        setAmbientEnabled(startAmbientSound());
        await game.startExpedition();
    };

    const resetExpedition = async () => {
        playUiSound('reset');
        setDismissedPartyChangeKey(undefined);
        await game.resetExpedition();
    };

    const primeSceneAction = (action: RelicActionInput) => {
        playUiSound('select');
        if (action.kind === 'move' && action.targetRoomId) {
            setSelectedRoomId(action.targetRoomId);
            setDraft({
                kind: 'move',
                targetRoomId: action.targetRoomId,
            });
            setScenePrimedAction(action);
            return;
        }

        if (action.kind === 'search') {
            setDraft({ kind: 'search' });
            setScenePrimedAction(action);
            return;
        }

        if (action.kind === 'escape') {
            setDraft({ kind: 'escape' });
            setScenePrimedAction(action);
            return;
        }

        if (action.kind === 'steal') {
            setDraft({
                kind: 'steal',
                targetPlayerId: action.targetPlayerId,
            });
            setScenePrimedAction(action);
        }
    };

    const toggleAmbient = () => {
        if (isAmbientSoundPlaying()) {
            stopAmbientSound();
            setAmbientEnabled(false);
            return;
        }

        setAmbientEnabled(startAmbientSound());
    };

    return (
        <main className="app-root">
            <RelicScene
                snapshot={game.snapshot}
                localPlayerId={game.session?.sessionId}
                selectedRoomId={selectedRoomId}
                primedAction={scenePrimedAction}
                onSelectRoom={setSelectedRoomId}
                onPrimeAction={primeSceneAction}
            />

            <section className="topbar">
                <div className="brand">
                    <span className="brand-mark"/>
                    <div>
                        <h1>Relic Hunters</h1>
                        <p>{phaseLabel(game.snapshot?.phase ?? game.connectionState)}</p>
                    </div>
                </div>
                <div className="status-row">
                    <Status label="Round" value={game.snapshot
                        ? `${game.snapshot.round}/${game.snapshot.maxRounds}`
                        : '-'}
                    />
                    <Status label="Hunters" value={String(game.snapshot?.players.length ?? 0)}/>
                    <Status label="Submitted" value={String(game.snapshot?.submittedPlayerIds.length ?? 0)}/>
                    <Status label="Relics" value={progress?.relics ?? '-'}/>
                    <Status label="Escape" value={progress?.escape ?? '-'}/>
                </div>
            </section>

            <section className="side-panel">
                {!game.session || game.connectionState === 'signed-out'
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
                                {authMode === 'login' ? 'Enter' : 'Create Hunter'}
                            </button>
                        </form>
                    )
                    : (
                        <div className="panel stack">
                            <div className="profile-row">
                                <span
                                    className="hunter-dot"
                                    style={{
                                        background: colorForId(game.session.sessionId),
                                    }}
                                />
                                <div>
                                    <strong>{game.session.username}</strong>
                                    <span>{shortId(game.session.sessionId)}</span>
                                </div>
                            </div>

                            <div className="button-grid">
                                <button type="button" onClick={game.createRoom}>New Room</button>
                                <button type="button" onClick={game.refreshRooms}>Refresh</button>
                                <button type="button" onClick={game.logout}>Logout</button>
                                <button
                                    type="button"
                                    className={ambientEnabled ? 'active' : ''}
                                    onClick={toggleAmbient}
                                >
                                    Atmosphere
                                </button>
                            </div>

                            <div className="room-list">
                                {rooms.map((room) => (
                                    <button
                                        type="button"
                                        key={room.roomId}
                                        className={room.roomId === game.roomId
                                            ? 'room-row active'
                                            : 'room-row'}
                                        onClick={() => game.joinRoom(room.roomId)}
                                    >
                                        <span>{room.name}</span>
                                        <small>{room.onlineMemberCount} online</small>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                {game.session && game.roomId && (
                    <div className="panel stack">
                        <CharacterSelect
                            currentPlayer={currentPlayer}
                            selectedCharacterId={selectedCharacterId}
                            onSelect={(characterId) => {
                                playUiSound('select');
                                setSelectedCharacterId(characterId);
                            }}
                            phase={game.snapshot?.phase}
                        />

                        <div className="objective-card">
                            <span>Final Goal</span>
                            <strong>Collect relic points, reach the Exit, then submit Escape before the ruin closes.</strong>
                            <small>Highest safe score claims the Heart Relic.</small>
                        </div>

                        <div className="objective-card objective-card-next">
                            <span>Current Goal</span>
                            <strong>{objective}</strong>
                            {currentPlayer && (
                                <small>
                                    {selectedCharacter.role} / {currentPlayer.health} health / {currentPlayer.score} score / {currentPlayer.relicIds.length} relics
                                </small>
                            )}
                        </div>

                        <div className="button-grid">
                            <button type="button" onClick={joinExpedition}>
                                {currentPlayer ? 'Update Hunter' : `Join as ${selectedCharacter.name}`}
                            </button>
                            <button type="button" onClick={startExpedition}>
                                Start
                            </button>
                            <button type="button" onClick={resetExpedition}>
                                Reset
                            </button>
                            <button
                                type="button"
                                className={ambientEnabled ? 'active' : ''}
                                onClick={toggleAmbient}
                            >
                                Atmosphere
                            </button>
                        </div>

                        <div className="action-picker">
                            {(['move', 'search', 'steal', 'escape'] as const).map((kind) => (
                                <button
                                    type="button"
                                    key={kind}
                                    className={draft.kind === kind ? 'active' : ''}
                                    onClick={() => {
                                        playUiSound('select');
                                        const nextDraft: ActionDraft = kind === 'move'
                                            ? {
                                                kind,
                                                targetRoomId: selectedRoomId &&
                                                        moveTargets.includes(selectedRoomId)
                                                    ? selectedRoomId
                                                    : moveTargets[0],
                                            }
                                            : kind === 'steal'
                                            ? {
                                                kind,
                                                targetPlayerId: stealTargets[0]?.playerId,
                                            }
                                            : { kind };
                                        setDraft(nextDraft);
                                        setScenePrimedAction(nextDraft);
                                    }}
                                >
                                    <span>{ACTION_INFO[kind].label}</span>
                                    <small>{ACTION_INFO[kind].noise}</small>
                                </button>
                            ))}
                        </div>

                        <div className="action-brief">
                            <strong>{actionInfo.label}</strong>
                            <span>{actionInfo.description}</span>
                            {submitBlocker && <small>{submitBlocker}</small>}
                        </div>

                        {draft.kind === 'move' && (
                            <select
                                value={draft.targetRoomId ?? selectedRoomId ?? moveTargets[0] ?? ''}
                                onChange={(event) =>
                                    {
                                        const nextDraft = {
                                            kind: 'move' as const,
                                            targetRoomId: event.target.value,
                                        };
                                        setDraft(nextDraft);
                                        setScenePrimedAction(nextDraft);
                                    }}
                            >
                                {moveTargets.map((roomId) => (
                                    <option key={roomId} value={roomId}>
                                        {roomName(game.snapshot, roomId)}
                                    </option>
                                ))}
                            </select>
                        )}

                        {draft.kind === 'steal' && (
                            <select
                                value={draft.targetPlayerId ?? stealTargets[0]?.playerId ?? ''}
                                onChange={(event) =>
                                    {
                                        const nextDraft = {
                                            kind: 'steal' as const,
                                            targetPlayerId: event.target.value,
                                        };
                                        setDraft(nextDraft);
                                        setScenePrimedAction(nextDraft);
                                    }}
                            >
                                {stealTargets.map((player) => (
                                    <option key={player.playerId} value={player.playerId}>
                                        {player.username}
                                    </option>
                                ))}
                            </select>
                        )}

                        <button
                            type="button"
                            className="primary"
                            disabled={!canSubmit}
                            onClick={submitAction}
                        >
                            {game.snapshot?.submittedPlayerIds.includes(game.session.sessionId)
                                ? 'Plan Locked'
                                : 'Submit Plan'}
                        </button>
                    </div>
                )}

                {game.session && game.roomId && game.snapshot && (
                    <CastleMap
                        snapshot={game.snapshot}
                        localPlayerId={game.session.sessionId}
                        selectedRoomId={selectedRoomId}
                        onSelectRoom={setSelectedRoomId}
                    />
                )}

                {showPartyChangePrompt && game.snapshot && currentRoomSummary && (
                    <PartyChangePrompt
                        expeditionPlayers={game.snapshot.players.length}
                        onlinePlayers={currentRoomSummary.onlineMemberCount}
                        onReset={resetExpedition}
                        onContinue={() => setDismissedPartyChangeKey(partyChangeKey)}
                    />
                )}

                {game.session && game.roomId && (
                    <RoomIntel
                        currentRoom={currentRoom}
                        moveTargets={moveTargets}
                        snapshot={game.snapshot}
                    />
                )}

                {game.error && <div className="panel error-panel">{game.error}</div>}
            </section>

            <section className="bottom-panel">
                <HunterList
                    players={game.snapshot?.players ?? []}
                    localPlayerId={game.session?.sessionId}
                />
                <RoundChronicle
                    events={game.snapshot?.events ?? []}
                    phase={game.snapshot?.phase}
                    lastEvent={lastEvent}
                />
            </section>

            {game.snapshot?.phase === 'finished' && (
                <VictoryPanel snapshot={game.snapshot}/>
            )}
        </main>
    );
}

const ACTION_INFO: Record<
    RelicActionKind,
    Readonly<{ label: string; noise: string; description: string }>
> = {
    move: {
        label: 'Move',
        noise: 'quiet',
        description: 'Step into an adjacent room to reach relics or race toward the exit.',
    },
    search: {
        label: 'Search',
        noise: 'noisy',
        description: 'Look for relics in this room. Searching creates danger but wins games.',
    },
    steal: {
        label: 'Steal',
        noise: 'loud',
        description: 'Take a relic from another hunter in your room. Failed attempts still make noise.',
    },
    escape: {
        label: 'Escape',
        noise: 'silent',
        description: 'Leave from the Exit with your relics. Escaped hunters keep their score safe.',
    },
};

function CharacterSelect({
    currentPlayer,
    selectedCharacterId,
    onSelect,
    phase,
}: Readonly<{
    currentPlayer?: RelicPlayer;
    selectedCharacterId: RelicCharacterId;
    onSelect(characterId: RelicCharacterId): void;
    phase?: RelicPublicSnapshot['phase'];
}>) {
    const locked = !!currentPlayer && phase !== 'lobby';
    const activeCharacter = findRelicCharacter(
        locked ? currentPlayer.characterId : selectedCharacterId,
    );

    return (
        <div className="character-panel">
            <div className="character-current">
                <span
                    className="character-sigil"
                    style={{
                        background: activeCharacter.colors.accent,
                        boxShadow: `0 0 24px ${activeCharacter.colors.accent}55`,
                    }}
                />
                <div>
                    <span className="panel-label">
                        {locked ? 'Your Hunter' : 'Choose Hunter'}
                    </span>
                    <strong>{activeCharacter.name}</strong>
                    <small>{activeCharacter.epithet}</small>
                </div>
            </div>

            <div className="character-grid">
                {RELIC_CHARACTERS.map((character) => (
                    <button
                        type="button"
                        className={character.id === activeCharacter.id ? 'character-card active' : 'character-card'}
                        key={character.id}
                        disabled={locked}
                        onClick={() => onSelect(character.id)}
                        style={{
                            borderColor: character.id === activeCharacter.id
                                ? `${character.colors.accent}cc`
                                : undefined,
                        }}
                    >
                        <span
                            className="character-swatch"
                            style={{
                                background: `linear-gradient(135deg, ${character.colors.primary}, ${character.colors.secondary})`,
                            }}
                        />
                        <strong>{character.name}</strong>
                        <small>{character.role}</small>
                    </button>
                ))}
            </div>

            <div className="character-skill">
                <span>{activeCharacter.passive}</span>
                <small>{activeCharacter.skillset.join(' / ')}</small>
            </div>
        </div>
    );
}

function PartyChangePrompt({
    expeditionPlayers,
    onlinePlayers,
    onReset,
    onContinue,
}: Readonly<{
    expeditionPlayers: number;
    onlinePlayers: number;
    onReset(): void;
    onContinue(): void;
}>) {
    return (
        <div className="panel stack party-change-panel">
            <div>
                <span className="panel-label">Party Changed</span>
                <strong>{onlinePlayers}/{expeditionPlayers} hunters are online</strong>
            </div>
            <p>The expedition roster no longer matches the connected party.</p>
            <div className="button-grid">
                <button type="button" className="primary" onClick={onReset}>
                    Start Over
                </button>
                <button type="button" onClick={onContinue}>
                    Keep Going
                </button>
            </div>
        </div>
    );
}

function RoomIntel({
    currentRoom,
    moveTargets,
    snapshot,
}: Readonly<{
    currentRoom?: RelicPublicSnapshot['map'][number];
    moveTargets: readonly string[];
    snapshot?: RelicPublicSnapshot;
}>) {
    const roomRelics = currentRoom && snapshot
        ? snapshot.relics.filter((relic) =>
            relic.roomId === currentRoom.id && !relic.carriedBy && !relic.escapedBy
        )
        : [];
    const investigation = currentRoom && snapshot
        ? snapshot.roomInvestigations?.find((candidate) =>
            candidate.roomId === currentRoom.id
        )
        : undefined;
    const revealedRoom = investigation?.revealedRoomId && snapshot
        ? snapshot.map.find((room) => room.id === investigation.revealedRoomId)
        : undefined;

    return (
        <div className="panel stack room-intel">
            <div>
                <span className="panel-label">Current Room</span>
                <strong>{currentRoom?.name ?? 'No hunter in the ruin'}</strong>
            </div>
            {currentRoom && (
                <>
                    <div className="tag-row">
                        <span className={`tag ${currentRoom.unstable ? 'danger' : ''}`}>
                            {currentRoom.unstable ? 'unstable' : 'stable'}
                        </span>
                        <span className={`tag ${currentRoom.collapsed ? 'danger' : ''}`}>
                            {currentRoom.collapsed ? 'collapsed' : currentRoom.kind}
                        </span>
                    </div>
                    <div className="intel-grid">
                        <div>
                            <span>Paths</span>
                            <strong>{moveTargets.length > 0
                                ? moveTargets.map((roomId) => roomName(snapshot, roomId)).join(', ')
                                : 'none'}</strong>
                        </div>
                        <div>
                            <span>Relic Signal</span>
                            <strong>{roomRelics.length > 0
                                ? roomRelics.map((relic) => relic.name).join(', ')
                                : investigation
                                ? investigation.result === 'relic-found'
                                    ? 'relic trail marked'
                                    : 'searched clear'
                                : 'quiet stone'}</strong>
                        </div>
                        <div>
                            <span>Investigation</span>
                            <strong>{investigation
                                ? investigation.summary
                                : 'unmarked'}</strong>
                        </div>
                        {investigation && (
                            <div>
                                <span>Clue Note</span>
                                <strong>{investigation.danger ?? investigation.hint}</strong>
                            </div>
                        )}
                        {revealedRoom && (
                            <div>
                                <span>Clue Target</span>
                                <strong>{revealedRoom.name}</strong>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

type CastleMapBounds = Readonly<{
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}>;

function CastleMap({
    snapshot,
    localPlayerId,
    selectedRoomId,
    onSelectRoom,
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    localPlayerId?: string;
    selectedRoomId?: string;
    onSelectRoom(roomId: string): void;
}>) {
    const bounds = castleMapBounds(snapshot.map);
    const clueTargetRoomIds = new Set(
        (snapshot.roomInvestigations ?? [])
            .map((investigation) => investigation.revealedRoomId)
            .filter((roomId): roomId is string => !!roomId),
    );
    const edges = snapshot.map.flatMap((room) =>
        room.neighbors
            .filter((neighborId) => room.id < neighborId)
            .map((neighborId) => ({
                from: room,
                to: snapshot.map.find((candidate) => candidate.id === neighborId),
            }))
            .filter((edge): edge is Readonly<{
                from: RelicPublicSnapshot['map'][number];
                to: RelicPublicSnapshot['map'][number];
            }> => !!edge.to)
    );

    return (
        <div className="panel castle-map-panel">
            <div className="castle-map-title">
                <span className="panel-label">Castle Map</span>
                <strong>{snapshot.phase === 'lobby' ? 'Choose a hunter to enter' : 'Track the expedition'}</strong>
            </div>
            <div className="castle-map" aria-label="Castle room map">
                <svg viewBox="0 0 100 100" aria-hidden="true">
                    {edges.map((edge) => {
                        const from = castleMapPoint(edge.from, bounds);
                        const to = castleMapPoint(edge.to, bounds);
                        return (
                            <line
                                key={`${edge.from.id}-${edge.to.id}`}
                                x1={from.x}
                                y1={from.y}
                                x2={to.x}
                                y2={to.y}
                            />
                        );
                    })}
                </svg>

                {snapshot.map.map((room) => {
                    const point = castleMapPoint(room, bounds);
                    const local = snapshot.players.some((player) =>
                        player.playerId === localPlayerId && player.roomId === room.id
                    );
                    return (
                        <button
                            type="button"
                            key={room.id}
                            className={[
                                'castle-map-room',
                                room.id === selectedRoomId ? 'selected' : '',
                                local ? 'local' : '',
                                clueTargetRoomIds.has(room.id) ? 'clue-target' : '',
                                room.unstable ? 'unstable' : '',
                                room.collapsed ? 'collapsed' : '',
                            ].filter(Boolean).join(' ')}
                            style={{
                                left: `${point.x}%`,
                                top: `${point.y}%`,
                            }}
                            onClick={() => onSelectRoom(room.id)}
                        >
                            <span>{room.name}</span>
                        </button>
                    );
                })}

                {snapshot.players.map((player, index) => {
                    const room = snapshot.map.find((candidate) => candidate.id === player.roomId);
                    if (!room || player.escaped || player.defeated) {
                        return null;
                    }

                    const point = castleMapPoint(room, bounds);
                    const offset = castleMapPlayerOffset(index);
                    const character = findRelicCharacter(player.characterId);
                    return (
                        <span
                            key={player.playerId}
                            className={player.playerId === localPlayerId
                                ? 'castle-map-hunter local'
                                : 'castle-map-hunter'}
                            style={{
                                left: `${point.x + offset.x}%`,
                                top: `${point.y + offset.y}%`,
                                background: character.colors.accent,
                            }}
                            title={`${player.username}: ${character.name}`}
                        />
                    );
                })}
            </div>
        </div>
    );
}

function RoundChronicle({
    events,
    phase,
    lastEvent,
}: Readonly<{
    events: readonly RelicEvent[];
    phase?: RelicPublicSnapshot['phase'];
    lastEvent?: RelicEvent;
}>) {
    const recent = events.slice(-6).reverse();
    return (
        <div className={`chronicle ${toneClass(lastEvent)}`}>
            <div className="chronicle-title">
                <span>{phase === 'finished' ? 'Expedition End' : 'Round Chronicle'}</span>
                <strong>{chronicleHeadline(lastEvent, phase)}</strong>
            </div>
            <div className="chronicle-list">
                {recent.map((event) => (
                    <p className={toneClass(event)} key={event.id}>{event.message}</p>
                ))}
            </div>
        </div>
    );
}

function VictoryPanel({ snapshot }: Readonly<{ snapshot: RelicPublicSnapshot }>) {
    const winners = snapshot.players.filter((player) =>
        snapshot.winnerIds.includes(player.playerId)
    );
    const sortedPlayers = [...snapshot.players].sort((left, right) => right.score - left.score);

    return (
        <section className="victory-panel">
            <div>
                <span>The Heart Relic has chosen</span>
                <h2>{winners.map((winner) => winner.username).join(', ') || 'No hunter'}</h2>
                <p>Final score: {winners[0]?.score ?? 0}</p>
            </div>
            <div className="scoreboard">
                {sortedPlayers.map((player) => (
                    <div key={player.playerId}>
                        <span>{player.username}</span>
                        <strong>{player.score}</strong>
                    </div>
                ))}
            </div>
        </section>
    );
}

function HunterList({
    players,
    localPlayerId,
}: Readonly<{
    players: readonly RelicPlayer[];
    localPlayerId?: string;
}>) {
    return (
        <div className="hunter-list">
            {players.map((player) => (
                <HunterChip
                    key={player.playerId}
                    player={player}
                    localPlayerId={localPlayerId}
                />
            ))}
        </div>
    );
}

function HunterChip({
    player,
    localPlayerId,
}: Readonly<{
    player: RelicPlayer;
    localPlayerId?: string;
}>) {
    const character = findRelicCharacter(player.characterId);
    return (
        <div
            className={player.playerId === localPlayerId
                ? 'hunter-chip active'
                : 'hunter-chip'}
        >
            <span
                className="hunter-dot"
                style={{ background: character.colors.accent }}
            />
            <strong>{player.username}</strong>
            <span>{player.score}</span>
            <small>
                {character.role} / {player.escaped
                    ? 'escaped'
                    : player.defeated
                    ? 'down'
                    : player.roomId}
            </small>
        </div>
    );
}

function toProgress(
    snapshot: RelicPublicSnapshot,
    localPlayerId: string | undefined,
): Readonly<{ relics: string; escape: string }> {
    const foundCount = snapshot.relics.filter((relic) => relic.foundBy).length;
    const escapedCount = snapshot.players.filter((player) => player.escaped).length;
    const localPlayer = snapshot.players.find((player) => player.playerId === localPlayerId);

    return {
        relics: `${foundCount}/${snapshot.relics.length}`,
        escape: localPlayer?.escaped
            ? 'safe'
            : `${escapedCount}/${Math.max(snapshot.players.length, 1)}`,
    };
}

function toObjective(
    snapshot: RelicPublicSnapshot,
    currentPlayer: RelicPlayer | undefined,
): string {
    if (snapshot.phase === 'finished') {
        return snapshot.winnerIds.length > 0
            ? 'The highest score has claimed the Heart Relic.'
            : 'The ruin has gone silent.';
    }

    if (!currentPlayer) {
        return 'Join the expedition to enter the ruin.';
    }

    if (snapshot.phase === 'lobby') {
        return 'Gather hunters, then start the expedition.';
    }

    if (currentPlayer.escaped) {
        return 'You escaped. Watch whether the others can beat your score.';
    }

    if (currentPlayer.defeated) {
        return 'You are down. The ruin keeps your relics.';
    }

    if (snapshot.submittedPlayerIds.includes(currentPlayer.playerId)) {
        const waiting = activePlayerCount(snapshot) - snapshot.submittedPlayerIds.length;
        return waiting > 0
            ? `Plan locked. Waiting for ${waiting} hunter${waiting === 1 ? '' : 's'}.`
            : 'All plans are locked. The ruin is about to answer.';
    }

    const roundsLeft = snapshot.maxRounds - snapshot.round + 1;
    return `Find relics, then escape within ${roundsLeft} round${roundsLeft === 1 ? '' : 's'}.`;
}

function activePlayerCount(snapshot: RelicPublicSnapshot): number {
    return snapshot.players.filter((player) => !player.escaped && !player.defeated).length;
}

function actionBlocker(
    snapshot: RelicPublicSnapshot,
    player: RelicPlayer,
    draft: ActionDraft,
    moveTargets: readonly string[],
    stealTargets: readonly RelicPlayer[],
): string | undefined {
    if (snapshot.phase !== 'planning') {
        return 'Start the expedition before locking plans.';
    }

    if (player.escaped) {
        return 'You are already safe outside the ruin.';
    }

    if (player.defeated) {
        return 'You are down and cannot act this expedition.';
    }

    if (draft.kind === 'move' && moveTargets.length === 0) {
        return 'No open adjacent paths from this room.';
    }

    if (draft.kind === 'steal' && stealTargets.length === 0) {
        return 'Steal needs another active hunter in this room.';
    }

    if (draft.kind === 'escape' && player.roomId !== 'exit') {
        return 'Escape only works from the Exit room.';
    }

    return undefined;
}

function chronicleHeadline(
    event: RelicEvent | undefined,
    phase: RelicPublicSnapshot['phase'] | undefined,
): string {
    if (!event) {
        return phase === 'lobby' ? 'The ruin waits.' : 'Listen for the next echo.';
    }

    switch (event.type) {
        case 'relic_found':
            return 'Treasure breaks the silence.';
        case 'room_collapsed':
            return 'Stone gives way.';
        case 'player_escaped':
            return 'Daylight is close.';
        case 'noise_pulse':
            return 'The ruin hears everything.';
        case 'game_finished':
            return 'The expedition is over.';
        default:
            return event.message;
    }
}

function toneClass(event: RelicEvent | undefined): string {
    return event?.tone ? `tone-${event.tone}` : 'tone-neutral';
}

function phaseLabel(value: string): string {
    switch (value) {
        case 'lobby':
            return 'Gather hunters';
        case 'planning':
            return 'Choose secretly';
        case 'finished':
            return 'Expedition complete';
        case 'connected':
            return 'Choose a room';
        case 'connecting':
            return 'Opening the gate';
        case 'signed-out':
            return 'Sign in';
        default:
            return value;
    }
}

function Status({ label, value }: Readonly<{ label: string; value: string }>) {
    return (
        <div className="status-pill">
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

function castleMapBounds(map: RelicPublicSnapshot['map']): CastleMapBounds {
    const xs = map.map((room) => room.x);
    const zs = map.map((room) => room.z);
    return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minZ: Math.min(...zs),
        maxZ: Math.max(...zs),
    };
}

function castleMapPoint(
    room: RelicPublicSnapshot['map'][number],
    bounds: CastleMapBounds,
): Readonly<{ x: number; y: number }> {
    const padding = 12;
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const depth = Math.max(1, bounds.maxZ - bounds.minZ);
    return {
        x: padding + ((room.x - bounds.minX) / width) * (100 - padding * 2),
        y: padding + ((room.z - bounds.minZ) / depth) * (100 - padding * 2),
    };
}

function castleMapPlayerOffset(index: number): Readonly<{ x: number; y: number }> {
    const angle = (Math.PI * 2 * index) / 4;
    return {
        x: Math.cos(angle) * 2.6,
        y: Math.sin(angle) * 2.6,
    };
}

function roomName(
    snapshot: { map: readonly { id: string; name: string }[] } | undefined,
    roomId: string,
): string {
    return snapshot?.map.find((room) => room.id === roomId)?.name ?? roomId;
}

function shortId(id: string): string {
    return id.length <= 8 ? id : id.slice(0, 8);
}
