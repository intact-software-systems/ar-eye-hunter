import { RELIC_PROTOCOL_VERSION } from './protocol.ts';

export type RelicRoomKind =
    | 'entrance'
    | 'hallway'
    | 'storage'
    | 'shrine'
    | 'trap'
    | 'treasure'
    | 'monster'
    | 'exit';

export type RelicActionKind = 'move' | 'search' | 'steal' | 'escape';

export type RelicGamePhase = 'lobby' | 'planning' | 'review' | 'finished';

export type RelicCharacterId =
    | 'kael-ironstride'
    | 'nyra-vale'
    | 'oryn-starcoil'
    | 'vessa-thornlock'
    | 'tarek-ashmantle'
    | 'sable-moonhook'
    | 'bronn-flintward'
    | 'ilyra-dawnshard'
    | 'marek-gloomglass'
    | 'zaya-stormvein';

export const RELIC_CHARACTER_IDS: readonly RelicCharacterId[] = [
    'kael-ironstride',
    'nyra-vale',
    'oryn-starcoil',
    'vessa-thornlock',
    'tarek-ashmantle',
    'sable-moonhook',
    'bronn-flintward',
    'ilyra-dawnshard',
    'marek-gloomglass',
    'zaya-stormvein',
];

export type RelicEventType =
    | 'game_waiting'
    | 'player_joined'
    | 'round_started'
    | 'action_submitted'
    | 'action_revealed'
    | 'player_moved'
    | 'player_searched'
    | 'relic_found'
    | 'steal_succeeded'
    | 'steal_failed'
    | 'escape_failed'
    | 'player_escaped'
    | 'noise_pulse'
    | 'player_damaged'
    | 'room_unstable'
    | 'room_collapsed'
    | 'game_finished';

export type RelicAnimationCueType =
    | 'camera_move'
    | 'search_altar'
    | 'relic_reveal'
    | 'steal_attempt'
    | 'escape_run'
    | 'noise_pulse'
    | 'damage_shake'
    | 'room_collapse'
    | 'heart_relic_victory';

export type RelicAnimationCue = Readonly<{
    type: RelicAnimationCueType;
    roomId?: string;
    playerId?: string;
    targetPlayerId?: string;
    relicId?: string;
    durationMs?: number;
    intensity?: 'low' | 'medium' | 'high';
}>;

export type RelicRoom = Readonly<{
    id: string;
    name: string;
    kind: RelicRoomKind;
    x: number;
    z: number;
    neighbors: readonly string[];
    collapsed?: boolean;
    unstable?: boolean;
}>;

export type RelicDefinition = Readonly<{
    id: string;
    name: string;
    value: number;
    roomId: string;
    foundBy?: string;
    carriedBy?: string;
    escapedBy?: string;
}>;

export type RelicRoomInvestigationResult = 'empty' | 'relic-found';

export type RelicRoomInvestigationEffect =
    | 'ordinary-search'
    | 'map-fragment'
    | 'rune-reading'
    | 'safe-path'
    | 'treasure-trail'
    | 'monster-trace'
    | 'exit-route';

export type RelicRoomInvestigation = Readonly<{
    roomId: string;
    searchedByPlayerId: string;
    searchedByUsername: string;
    searchedAtRound: number;
    searchedAtEpochMs: number;
    result: RelicRoomInvestigationResult;
    summary: string;
    hint: string;
    effect: RelicRoomInvestigationEffect;
    danger?: string;
    revealedRoomId?: string;
    relicId?: string;
}>;

export type RelicPlayer = Readonly<{
    playerId: string;
    username: string;
    characterId: RelicCharacterId;
    roomId: string;
    health: number;
    escaped: boolean;
    defeated: boolean;
    score: number;
    relicIds: readonly string[];
}>;

export type RelicActionInput = Readonly<{
    kind: RelicActionKind;
    targetRoomId?: string;
    targetPlayerId?: string;
}>;

export type RelicPendingAction = Readonly<{
    playerId: string;
    username: string;
    action: RelicActionInput;
    submittedAtEpochMs: number;
}>;

export type RelicEvent = Readonly<{
    id: string;
    round: number;
    type: RelicEventType;
    message: string;
    animationCue?: RelicAnimationCue;
    tone?: 'neutral' | 'success' | 'danger' | 'mystery';
    createdAtEpochMs: number;
}>;

export type RelicGameState = Readonly<{
    protocolVersion: typeof RELIC_PROTOCOL_VERSION;
    gameId: string;
    roomId: string;
    phase: RelicGamePhase;
    round: number;
    maxRounds: number;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    adminPlayerId?: string;
    roundTimeLimitMs: number;
    roundStartedAtEpochMs?: number;
    map: readonly RelicRoom[];
    relics: readonly RelicDefinition[];
    roomInvestigations: readonly RelicRoomInvestigation[];
    players: readonly RelicPlayer[];
    pendingActions: readonly RelicPendingAction[];
    events: readonly RelicEvent[];
    winnerIds: readonly string[];
}>;

export type RelicPublicSnapshot = Readonly<{
    protocolVersion: typeof RELIC_PROTOCOL_VERSION;
    gameId: string;
    roomId: string;
    phase: RelicGamePhase;
    round: number;
    maxRounds: number;
    updatedAtEpochMs: number;
    adminPlayerId?: string;
    roundTimeLimitMs: number;
    roundStartedAtEpochMs?: number;
    map: readonly RelicRoom[];
    relics: readonly RelicDefinition[];
    roomInvestigations: readonly RelicRoomInvestigation[];
    players: readonly RelicPlayer[];
    submittedPlayerIds: readonly string[];
    events: readonly RelicEvent[];
    winnerIds: readonly string[];
}>;

export type RelicCommand =
    | Readonly<{
        protocolVersion: typeof RELIC_PROTOCOL_VERSION;
        kind: 'join-expedition';
        gameId: string;
        username: string;
        characterId?: RelicCharacterId;
    }>
    | Readonly<{
        protocolVersion: typeof RELIC_PROTOCOL_VERSION;
        kind: 'start-expedition';
        gameId: string;
        username: string;
    }>
    | Readonly<{
        protocolVersion: typeof RELIC_PROTOCOL_VERSION;
        kind: 'submit-action';
        gameId: string;
        username: string;
        action: RelicActionInput;
    }>
    | Readonly<{
        protocolVersion: typeof RELIC_PROTOCOL_VERSION;
        kind: 'force-resolve-round';
        gameId: string;
        username: string;
    }>
    | Readonly<{
        protocolVersion: typeof RELIC_PROTOCOL_VERSION;
        kind: 'continue-review';
        gameId: string;
        username: string;
    }>
    | Readonly<{
        protocolVersion: typeof RELIC_PROTOCOL_VERSION;
        kind: 'set-round-limit';
        gameId: string;
        username: string;
        timeLimitMs: number;
    }>;

export type RelicServerEvent = Readonly<{
    protocolVersion: typeof RELIC_PROTOCOL_VERSION;
    gameId: string;
    snapshot: RelicPublicSnapshot;
}>;

export function toPublicRelicSnapshot(state: RelicGameState): RelicPublicSnapshot {
    const maybeLegacy = state as RelicGameState & {
        roomInvestigations?: readonly RelicRoomInvestigation[];
    };
    return {
        protocolVersion: state.protocolVersion,
        gameId: state.gameId,
        roomId: state.roomId,
        phase: state.phase,
        round: state.round,
        maxRounds: state.maxRounds,
        updatedAtEpochMs: state.updatedAtEpochMs,
        adminPlayerId: state.adminPlayerId,
        roundTimeLimitMs: state.roundTimeLimitMs,
        roundStartedAtEpochMs: state.roundStartedAtEpochMs,
        map: state.map,
        relics: state.relics,
        roomInvestigations: maybeLegacy.roomInvestigations ?? [],
        players: state.players,
        submittedPlayerIds: state.pendingActions.map((action) => action.playerId),
        events: state.events.slice(-16),
        winnerIds: state.winnerIds,
    };
}

export function isRelicCommand(value: unknown): value is RelicCommand {
    if (!isRecord(value) || value.protocolVersion !== RELIC_PROTOCOL_VERSION) {
        return false;
    }

    if (typeof value.gameId !== 'string' || typeof value.username !== 'string') {
        return false;
    }

    if (value.kind === 'join-expedition') {
        return value.characterId === undefined || isRelicCharacterId(value.characterId);
    }

    if (value.kind === 'start-expedition') {
        return true;
    }

    if (value.kind === 'set-round-limit') {
        return typeof value.timeLimitMs === 'number' &&
            [60_000, 180_000, 300_000].includes(value.timeLimitMs as number);
    }

    if (value.kind === 'force-resolve-round') {
        return true;
    }

    if (value.kind === 'continue-review') {
        return true;
    }

    return value.kind === 'submit-action' &&
        isRecord(value.action) &&
        isRelicActionKind(value.action.kind);
}

export function isRelicSnapshot(value: unknown): value is RelicPublicSnapshot {
    return isRecord(value) &&
        value.protocolVersion === RELIC_PROTOCOL_VERSION &&
        typeof value.gameId === 'string' &&
        typeof value.round === 'number' &&
        Array.isArray(value.roomInvestigations) &&
        Array.isArray(value.players);
}

function isRelicActionKind(value: unknown): value is RelicActionKind {
    return value === 'move' ||
        value === 'search' ||
        value === 'steal' ||
        value === 'escape';
}

export function isRelicCharacterId(value: unknown): value is RelicCharacterId {
    return typeof value === 'string' &&
        RELIC_CHARACTER_IDS.includes(value as RelicCharacterId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
