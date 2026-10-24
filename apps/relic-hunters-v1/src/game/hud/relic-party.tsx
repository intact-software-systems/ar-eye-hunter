import { useEffect, useState } from 'react';

import type {
    RelicActionKind,
    RelicCharacter,
    RelicCharacterId,
    RelicPlayer,
    RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import { findRelicCharacter, RELIC_CHARACTERS } from '@relic-hunters/mod.ts';

import {
    plural,
    UI,
    type Lang
} from '../lang.ts';
import type { RelicHuntersRuntime } from '../relic-hunters-runtime.ts';
import { playUiSound } from '../sound.ts';
import type { RelicPreferences } from '../use-relic-preferences.ts';
import type { RelicTurn } from '../use-relic-turn.ts';

interface RelicPartyControlsProps {
    readonly game: RelicHuntersRuntime.Connection;
    readonly turn: RelicTurn;
    readonly preferences: RelicPreferences;
}

export function RelicPartyControls({ game, turn, preferences }: RelicPartyControlsProps) {
    const [characterId, setCharacterId] = useState<RelicCharacterId>(RELIC_CHARACTERS[0].id);
    const player = turn.viewModel.currentPlayer;
    useEffect(() => {
        if (player) {
            setCharacterId(player.characterId);
        }
    }, [player?.characterId]);
    const character = findRelicCharacter(player && game.snapshot?.phase !== 'lobby' ? player.characterId : characterId);
    const select = (characterId: RelicCharacterId) => {
        playUiSound('select');
        setCharacterId(characterId);
    };
    const join = async () => {
        playUiSound('join');
        preferences.enableAmbient();
        await game.joinExpedition(characterId);
    };
    return (
        <>
            <CharacterSelect
                currentPlayer={player}
                selectedCharacterId={characterId}
                onSelect={select}
                phase={game.snapshot?.phase}
            />
            <div className="objective-card">
                <span>Final Goal</span>
                <strong>Collect relic points, reach the Exit, then submit Escape before the ruin closes.</strong>
                <small>Highest safe score claims the Heart Relic.</small>
            </div>
            <div className="objective-card objective-card-next">
                <span>Current Goal</span>
                <strong>{turn.viewModel.objective}</strong>
                {player && (
                    <small>
                        {character.role} / {player.health} health / {player.score} score / {player.relicIds.length}{' '}
                        relics
                    </small>
                )}
            </div>
            <RelicExpeditionAdmission
                game={game}
                turn={turn}
                preferences={preferences}
                characterId={characterId}
                join={join}
            />
        </>
    );
}

interface RelicExpeditionAdmissionProps extends RelicPartyControlsProps {
    readonly characterId: RelicCharacterId;
    readonly join: () => Promise<void>;
}

function RelicExpeditionAdmission(props: RelicExpeditionAdmissionProps) {
    const { game, turn, preferences, characterId, join } = props;
    const { lang } = preferences;
    const currentPlayer = turn.viewModel.currentPlayer;
    const summary = game.rooms.find((room) => room.roomId === game.roomId);
    const startBlocker = game.snapshot
        ? computeLobbyStartBlocker({
            snapshot: game.snapshot,
            currentPlayer,
            isAdmin: turn.viewModel.isAdmin,
            onlineMemberCount: summary?.onlineMemberCount,
            lang
        })
        : undefined;
    if (game.snapshot && game.snapshot.phase !== 'lobby') {
        return !currentPlayer ? <button type="button" onClick={() => void join()}>Join Expedition</button> : null;
    }
    return (
        <>
            {game.snapshot && (
                <LobbyPartyPanel
                    snapshot={game.snapshot}
                    localPlayerId={game.session?.sessionId}
                    onlineMemberCount={summary?.onlineMemberCount}
                    startBlocker={startBlocker}
                    lang={lang}
                />
            )}
            <div className="lobby-ready-zone">
                {currentPlayer
                    ? (
                        <button type="button" className="lobby-ready-confirmed" disabled>
                            {UI[lang].readyConfirmed}
                        </button>
                    )
                    : (
                        <button type="button" className="primary lobby-ready-btn" onClick={() => void join()}>
                            {lang === 'no' ? 'Bli med som' : 'Join as'} {findRelicCharacter(characterId).name}
                        </button>
                    )}
                {currentPlayer && turn.viewModel.isAdmin && (
                    <RelicKeeperControls game={game} preferences={preferences} startBlocker={startBlocker} />
                )}
                {currentPlayer && !turn.viewModel.isAdmin && (
                    <div className="lobby-waiting-admin">{UI[lang].waitingForKeeper}</div>
                )}
            </div>
        </>
    );
}

interface RelicKeeperControlsProps {
    readonly game: RelicHuntersRuntime.Connection;
    readonly preferences: RelicPreferences;
    readonly startBlocker: string | undefined;
}

function RelicKeeperControls({ game, preferences, startBlocker }: RelicKeeperControlsProps) {
    const start = async () => {
        playUiSound('start');
        preferences.enableAmbient();
        await game.startExpedition();
    };
    return (
        <>
            {game.snapshot && (
                <div className="timer-limit-selector">
                    <span className="panel-label">{UI[preferences.lang].setTimerTitle}</span>
                    <div className="segmented">
                        {[60_000, 180_000, 300_000].map((ms) => (
                            <button
                                key={ms}
                                type="button"
                                className={game.snapshot?.roundTimeLimitMs === ms ? 'active' : ''}
                                onClick={() => void game.setRoundLimit(ms)}
                            >
                                {ms / 60_000} min
                            </button>
                        ))}
                    </div>
                </div>
            )}
            <button
                type="button"
                className="primary lobby-begin-btn"
                onClick={() => void start()}
                disabled={!!startBlocker}
                title={startBlocker}
            >
                {UI[preferences.lang].beginTheHunt}
            </button>
            {startBlocker && <small className="lobby-start-hint">{startBlocker}</small>}
        </>
    );
}

interface CharacterSelectProps {
    readonly currentPlayer?: RelicPlayer;
    readonly selectedCharacterId: RelicCharacterId;
    onSelect(characterId: RelicCharacterId): void;
    readonly phase?: RelicPublicSnapshot['phase'];
}

function CharacterSelect({
    currentPlayer,
    selectedCharacterId,
    onSelect,
    phase
}: CharacterSelectProps) {
    const locked = !!currentPlayer && phase !== 'lobby';
    const activeCharacter = findRelicCharacter(
        locked ? currentPlayer.characterId : selectedCharacterId
    );

    return (
        <div className="character-panel">
            <div className="character-current">
                <span
                    className="character-sigil"
                    style={{
                        background: activeCharacter.colors.accent,
                        boxShadow: `0 0 24px ${activeCharacter.colors.accent}55`
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

            <CharacterChoices activeCharacter={activeCharacter} locked={locked} onSelect={onSelect} />

            <div className="character-skill">
                <span>{activeCharacter.passive}</span>
                <small>{activeCharacter.skillset.join(' / ')}</small>
            </div>
        </div>
    );
}

interface LobbyStartBlockerInput {
    readonly snapshot: RelicPublicSnapshot;
    readonly currentPlayer?: RelicPlayer;
    readonly isAdmin: boolean;
    readonly onlineMemberCount?: number;
    readonly lang: Lang;
}

function computeLobbyStartBlocker({
    snapshot,
    currentPlayer,
    isAdmin,
    onlineMemberCount,
    lang
}: LobbyStartBlockerInput): string | undefined {
    const joinedCount = snapshot.players.length;
    const onlineOnlyCount = typeof onlineMemberCount === 'number'
        ? Math.max(0, onlineMemberCount - joinedCount)
        : 0;
    const keeper = resolveLobbyKeeper(snapshot);

    if (!currentPlayer) {
        return lang === 'no'
            ? 'Bli med i ekspedisjonen før jakten kan starte.'
            : 'Join the expedition before the hunt can start.';
    }
    if (!keeper) {
        return lang === 'no'
            ? 'En vokter må utpekes før jakten kan starte.'
            : 'A Keeper must be assigned before the hunt can start.';
    }
    if (!isAdmin) {
        return lang === 'no'
            ? `Bare ${keeper.username} kan starte jakten.`
            : `Only ${keeper.username} can start the hunt.`;
    }
    if (joinedCount === 0) {
        return lang === 'no'
            ? 'Minst én jeger må bli med i ekspedisjonen.'
            : 'At least one hunter must join the expedition.';
    }
    if (onlineOnlyCount > 0) {
        return lang === 'no'
            ? `${onlineOnlyCount} tilkoblet rommedlem må bli med i ekspedisjonen.`
            : `${onlineOnlyCount} online room member${onlineOnlyCount === 1 ? '' : 's'} must join the expedition.`;
    }
    return undefined;
}

function resolveLobbyKeeper(snapshot: RelicPublicSnapshot): RelicPlayer | undefined {
    return snapshot.players.find((player) => player.playerId === snapshot.adminPlayerId);
}

interface LobbyPartyPanelProps {
    readonly snapshot: RelicPublicSnapshot;
    readonly localPlayerId?: string;
    readonly onlineMemberCount?: number;
    readonly startBlocker?: string;
    readonly lang: Lang;
}

function LobbyPartyPanel({
    snapshot,
    localPlayerId,
    onlineMemberCount,
    startBlocker,
    lang
}: LobbyPartyPanelProps) {
    if (snapshot.phase !== 'lobby') {
        return null;
    }
    const labels = UI[lang];
    const joinedCount = snapshot.players.length;
    const onlineKnown = typeof onlineMemberCount === 'number';
    const onlineCount = onlineMemberCount ?? joinedCount;
    const onlineOnlyCount = onlineKnown ? Math.max(0, onlineCount - joinedCount) : 0;
    const offlineJoinedCount = onlineKnown ? Math.max(0, joinedCount - onlineCount) : 0;
    const allJoinedOnline = joinedCount > 0 && onlineOnlyCount === 0 && offlineJoinedCount === 0;
    const keeper = resolveLobbyKeeper(snapshot);
    return (
        <div className="panel lobby-party-panel">
            <div className="lobby-ready-header">
                <span className="panel-label">{labels.huntersSummoned}</span>
                {(onlineKnown || joinedCount > 0) && (
                    <span className={`lobby-ready-count${allJoinedOnline ? ' all-ready' : ''}`}>
                        {joinedCount}/{onlineKnown ? onlineCount : '?'} {lang === 'no' ? 'med' : 'joined'}
                    </span>
                )}
            </div>
            <p className="lobby-keeper-watch">
                {keeper
                    ? (lang === 'no' ? `Vokter: ${keeper.username}` : `Keeper: ${keeper.username}`)
                    : (lang === 'no' ? 'Ingen vokter er utpekt.' : 'No Keeper is assigned.')}
            </p>
            <div className="lobby-party-summary" aria-label={lang === 'no' ? 'Lobby-medlemskap' : 'Lobby membership'}>
                <div className="lobby-party-stat">
                    <span>{lang === 'no' ? 'Tilkoblede rommedlemmer' : 'Online room members'}</span>
                    <strong>{onlineKnown ? onlineCount : '—'}</strong>
                </div>
                <div className="lobby-party-stat">
                    <span>{lang === 'no' ? 'Jegere i ekspedisjonen' : 'Joined expedition hunters'}</span>
                    <strong>{joinedCount}</strong>
                </div>
            </div>
            {snapshot.players.length > 0 && (
                <LobbyPartyRoster snapshot={snapshot} localPlayerId={localPlayerId} lang={lang} />
            )}
            <LobbyReadinessHint
                onlineOnlyCount={onlineOnlyCount}
                offlineJoinedCount={offlineJoinedCount}
                allJoinedOnline={allJoinedOnline}
                startBlocker={startBlocker}
                lang={lang}
            />
        </div>
    );
}

interface PartyChangePromptProps {
    readonly expeditionPlayers: number;
    readonly onlinePlayers: number;
    onReset(): void;
    onContinue(): void;
}

export function PartyChangePrompt({
    expeditionPlayers,
    onlinePlayers,
    onReset,
    onContinue
}: PartyChangePromptProps) {
    const offlineJoinedCount = Math.max(0, expeditionPlayers - onlinePlayers);
    const onlineOnlyCount = Math.max(0, onlinePlayers - expeditionPlayers);
    const detail = offlineJoinedCount > 0
        ? 'Offline joined hunters can hold a round until the timer expires. Start Over removes the stale roster; Keep Going leaves them in the expedition.'
        : onlineOnlyCount > 0
        ? 'Some online room members have not joined the expedition yet. Start Over rebuilds the roster; Keep Going leaves the current expedition as-is.'
        : 'The expedition roster no longer matches the connected party.';
    return (
        <div className="panel stack party-change-panel">
            <div>
                <span className="panel-label">Party Changed</span>
                <strong>{onlinePlayers}/{expeditionPlayers} hunters are online</strong>
            </div>
            <p>{detail}</p>
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

interface PartyCoordinationSummary {
    readonly currentRoomId: string;
    readonly currentRoomName: string;
    readonly hereCount: number;
    readonly elsewhereCount: number;
    readonly activeCount: number;
    readonly submittedCount: number;
    readonly splitLabel: string;
    readonly readinessLabel: string;
    readonly actionHint: string;
    readonly roomOccupants: readonly RelicPlayer[];
    readonly stealTargets: readonly RelicPlayer[];
    readonly relicCarrierCount: number;
}

export function computePartyCoordination(
    snapshot: RelicPublicSnapshot | undefined,
    localPlayerId: string | undefined,
    actionKind: RelicActionKind
): PartyCoordinationSummary | undefined {
    const activePlayers = snapshot?.players.filter((player) => !player.escaped && !player.defeated) ?? [];
    const localPlayer = activePlayers.find((player) => player.playerId === localPlayerId);
    const currentRoom = snapshot?.map.find((room) => room.id === localPlayer?.roomId);
    if (!snapshot || !localPlayer || !currentRoom) {
        return undefined;
    }

    const roomOccupants = activePlayers.filter((player) => player.roomId === currentRoom.id);
    const stealTargets = roomOccupants.filter((player) => player.playerId !== localPlayer.playerId);
    const relicCarrierCount = stealTargets.filter((player) => player.relicIds.length > 0).length;
    const submittedCount =
        activePlayers.filter((player) => snapshot.submittedPlayerIds.includes(player.playerId)).length;
    const hereCount = roomOccupants.length;
    const elsewhereCount = Math.max(0, activePlayers.length - hereCount);

    return {
        currentRoomId: currentRoom.id,
        currentRoomName: currentRoom.name,
        hereCount,
        elsewhereCount,
        activeCount: activePlayers.length,
        submittedCount,
        splitLabel: `${hereCount} ${plural('hunter', hereCount)} here / ${elsewhereCount} elsewhere`,
        readinessLabel: `${submittedCount}/${activePlayers.length} plans locked`,
        actionHint: computePartyActionHint({
            actionKind,
            currentRoom,
            hereCount,
            elsewhereCount,
            stealTargets,
            relicCarrierCount
        }),
        roomOccupants,
        stealTargets,
        relicCarrierCount
    };
}

interface PartyCoordinationPanelProps {
    readonly snapshot: RelicPublicSnapshot;
    readonly localPlayerId?: string;
    readonly summary: PartyCoordinationSummary;
}

export function PartyCoordinationPanel({
    snapshot,
    localPlayerId,
    summary
}: PartyCoordinationPanelProps) {
    return (
        <div className="panel stack party-coordination" aria-label="Room occupants">
            <div>
                <span className="panel-label">Party Coordination</span>
                <strong>{summary.splitLabel}</strong>
                <small>{summary.readinessLabel}</small>
            </div>
            <div className="coordination-grid">
                <div>
                    <span>Room</span>
                    <strong>{summary.currentRoomName}</strong>
                </div>
                <div>
                    <span>Steal Risk</span>
                    <strong>
                        {summary.relicCarrierCount > 0
                            ? `${summary.relicCarrierCount} relic carrier${
                                summary.relicCarrierCount === 1 ? '' : 's'
                            } here`
                            : 'no relic carrier here'}
                    </strong>
                </div>
            </div>
            <small className="coordination-hint">{summary.actionHint}</small>
            <div className="occupant-list">
                {summary.roomOccupants.map((player) => (
                    <OccupantRow
                        key={player.playerId}
                        player={player}
                        local={player.playerId === localPlayerId}
                        submitted={snapshot.submittedPlayerIds.includes(player.playerId)}
                    />
                ))}
            </div>
        </div>
    );
}

interface OccupantRowProps {
    readonly player: RelicPlayer;
    readonly local: boolean;
    readonly submitted: boolean;
}

function OccupantRow({
    player,
    local,
    submitted
}: OccupantRowProps) {
    const character = findRelicCharacter(player.characterId);
    return (
        <div className={local ? 'occupant-row local' : 'occupant-row'}>
            <span
                className="hunter-dot"
                style={{ background: character.colors.accent }}
            />
            <div>
                <strong>{player.username}{local ? ' (you)' : ''}</strong>
                <small>
                    {character.role} / {player.health} health / {player.relicIds.length}{' '}
                    relic{player.relicIds.length === 1 ? '' : 's'} / {player.score} score
                </small>
            </div>
            <em>{submitted ? 'submitted' : 'choosing'}</em>
        </div>
    );
}

interface PartyActionHintInput {
    readonly actionKind: RelicActionKind;
    readonly currentRoom: RelicPublicSnapshot['map'][number];
    readonly hereCount: number;
    readonly elsewhereCount: number;
    readonly stealTargets: readonly RelicPlayer[];
    readonly relicCarrierCount: number;
}

function computePartyActionHint({
    actionKind,
    currentRoom,
    hereCount,
    elsewhereCount,
    stealTargets,
    relicCarrierCount
}: PartyActionHintInput): string {
    if (actionKind === 'steal') {
        if (stealTargets.length === 0) {
            return 'No one nearby to steal from.';
        }
        if (relicCarrierCount > 0) {
            const carrier = stealTargets.find((player) => player.relicIds.length > 0);
            return carrier
                ? `Steal is possible here: ${carrier.username} carries ${carrier.relicIds.length} ${
                    plural('relic', carrier.relicIds.length)
                }.`
                : 'Steal is possible here.';
        }
        return 'Hunters are here, but no one carries a relic.';
    }

    if (actionKind === 'search') {
        return hereCount > 1
            ? `Searching makes noise for ${hereCount} ${plural('hunter', hereCount)} in ${currentRoom.name}.`
            : 'You are searching alone; nearby hunters cannot share the risk.';
    }

    if (actionKind === 'escape') {
        return currentRoom.kind === 'exit'
            ? 'Escaping now banks your carried relics before the party risks another round.'
            : 'Escape only works from the Exit room.';
    }

    return elsewhereCount > 0
        ? `Coordinate before the castle reacts; ${elsewhereCount} ${plural('hunter', elsewhereCount)} ${
            elsewhereCount === 1 ? 'is' : 'are'
        } elsewhere.`
        : 'The active party is together in this room.';
}

interface CharacterChoicesProps {
    readonly activeCharacter: RelicCharacter;
    readonly locked: boolean;
    onSelect(characterId: RelicCharacterId): void;
}

function CharacterChoices({ activeCharacter, locked, onSelect }: CharacterChoicesProps) {
    return (
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
                            : undefined
                    }}
                >
                    <span
                        className="character-swatch"
                        style={{
                            background:
                                `linear-gradient(135deg, ${character.colors.primary}, ${character.colors.secondary})`
                        }}
                    />
                    <strong>{character.name}</strong>
                    <small>{character.role}</small>
                </button>
            ))}
        </div>
    );
}

interface LobbyPartyRosterProps {
    readonly snapshot: RelicPublicSnapshot;
    readonly localPlayerId?: string;
    readonly lang: Lang;
}

function LobbyPartyRoster({ snapshot, localPlayerId, lang }: LobbyPartyRosterProps) {
    return (
        <div className="lobby-party-list">
            {snapshot.players.map((player) => {
                const character = findRelicCharacter(player.characterId);
                const isLocal = player.playerId === localPlayerId;
                const isKeeper = player.playerId === snapshot.adminPlayerId;
                return (
                    <div key={player.playerId} className={`lobby-party-row${isLocal ? ' local' : ''}`}>
                        <span
                            className="lobby-party-swatch"
                            style={{ background: character.colors.accent }}
                        />
                        <span className="lobby-party-name">{player.username}</span>
                        <span className="lobby-party-char">{character.name}</span>
                        <span className="lobby-role-badges">
                            {isKeeper && (
                                <span className="lobby-role-badge">
                                    {lang === 'no' ? 'VOKTER' : 'KEEPER'}
                                </span>
                            )}
                            <span className="lobby-ready-badge">
                                {lang === 'no' ? 'KLAR' : 'READY'}
                            </span>
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

interface LobbyReadinessHintProps {
    readonly onlineOnlyCount: number;
    readonly offlineJoinedCount: number;
    readonly allJoinedOnline: boolean;
    readonly startBlocker?: string;
    readonly lang: Lang;
}

function LobbyReadinessHint(
    { onlineOnlyCount, offlineJoinedCount, allJoinedOnline, startBlocker, lang }: LobbyReadinessHintProps
) {
    const labels = UI[lang];
    return (
        <>
            {onlineOnlyCount > 0
                ? (
                    <small className="lobby-party-hint">
                        {lang === 'no'
                            ? `${onlineOnlyCount} tilkoblet rommedlem må bli med i ekspedisjonen.`
                            : `${onlineOnlyCount} online room member${onlineOnlyCount === 1 ? '' : 's'} still need${
                                onlineOnlyCount === 1 ? 's' : ''
                            } to join.`}
                    </small>
                )
                : offlineJoinedCount > 0
                ? (
                    <small className="lobby-party-hint warning">
                        {lang === 'no'
                            ? `${offlineJoinedCount} jeger${
                                offlineJoinedCount === 1 ? '' : 'e'
                            } i ekspedisjonen ser frakoblet ut.`
                            : `${offlineJoinedCount} joined hunter${
                                offlineJoinedCount === 1 ? '' : 's'
                            } appear offline.`}
                    </small>
                )
                : startBlocker
                ? <small className="lobby-party-hint">{startBlocker}</small>
                : allJoinedOnline
                ? (
                    <small className="lobby-all-ready-hint">
                        {lang === 'no'
                            ? 'Ekspedisjonen er samlet. Vokteren kan starte jakten.'
                            : 'The expedition is assembled. The Keeper can start when ready.'}
                    </small>
                )
                : <small className="lobby-party-hint">{labels.keeperAwaits}</small>}
        </>
    );
}
