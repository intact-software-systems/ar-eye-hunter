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

export type RelicExpeditionSetupSource =
    | 'default'
    | 'procedural'
    | 'rallar-ai'
    | 'mock';

export type RelicExpeditionSetupMetadata = Readonly<{
    schemaVersion: 1;
    source: RelicExpeditionSetupSource;
    seed?: string;
    theme?: string;
    blueprintId?: string;
}>;

export type RelicPublicSetupMetadata = Omit<
    RelicExpeditionSetupMetadata,
    'seed' | 'blueprintId'
>;

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
    | 'relic_picked_up'
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
    | 'relic_pickup'
    | 'steal_attempt'
    | 'escape_run'
    | 'noise_pulse'
    | 'damage_shake'
    | 'room_collapse'
    | 'heart_relic_victory';

export type RelicAnimationCue = Readonly<{
    type: RelicAnimationCueType;
    roomId?: string;
    fromRoomId?: string;
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
    setup?: RelicExpeditionSetupMetadata;
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
    setup?: RelicPublicSetupMetadata;
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
        kind: 'pickup-relic';
        gameId: string;
        username: string;
        relicId: string;
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
        relics: toPublicRelics(state.relics),
        // A relic-found investigation is created only after the relic is marked
        // found/carried above, so its relic and clue references are public state.
        roomInvestigations: maybeLegacy.roomInvestigations ?? [],
        players: state.players,
        submittedPlayerIds: state.pendingActions.map((action) => action.playerId),
        events: state.events.slice(-48),
        winnerIds: state.winnerIds,
        setup: toPublicSetup(state.setup),
    };
}

function toPublicRelics(
    relics: readonly RelicDefinition[],
): readonly RelicDefinition[] {
    const discovered = relics.filter((relic) =>
        relic.foundBy || relic.carriedBy || relic.escapedBy
    );
    const occupiedIds = new Set(discovered.map((relic) => relic.id));
    const hidden = Array.from(
        { length: relics.length - discovered.length },
        (_, index): RelicDefinition => {
            let id = `__hidden-relic-${index + 1}`;
            while (occupiedIds.has(id)) {
                id = `_${id}`;
            }
            occupiedIds.add(id);
            return {
                id,
                name: 'Unknown relic',
                value: 0,
                roomId: '',
            };
        },
    );

    // Preserve HUD cardinality without retaining a hidden relic's source index.
    return [...discovered, ...hidden];
}

function toPublicSetup(
    setup: RelicExpeditionSetupMetadata | undefined,
): RelicPublicSetupMetadata | undefined {
    if (!setup) {
        return undefined;
    }
    const {
        seed: _serverOnlySeed,
        blueprintId: _serverOnlyBlueprintId,
        ...publicSetup
    } = setup;
    return publicSetup;
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

    if (value.kind === 'pickup-relic') {
        return typeof value.relicId === 'string' && value.relicId.length > 0;
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
        typeof value.roomId === 'string' &&
        isRelicGamePhase(value.phase) &&
        isFiniteNumber(value.round) &&
        isFiniteNumber(value.maxRounds) &&
        isFiniteNumber(value.updatedAtEpochMs) &&
        isOptionalString(value.adminPlayerId) &&
        isFiniteNumber(value.roundTimeLimitMs) &&
        isOptionalFiniteNumber(value.roundStartedAtEpochMs) &&
        Array.isArray(value.map) && value.map.every(isRelicRoom) &&
        Array.isArray(value.relics) && value.relics.every(isRelicDefinition) &&
        Array.isArray(value.roomInvestigations) &&
        value.roomInvestigations.every(isRelicRoomInvestigation) &&
        Array.isArray(value.players) && value.players.every(isRelicPlayer) &&
        Array.isArray(value.submittedPlayerIds) && value.submittedPlayerIds.every(isString) &&
        Array.isArray(value.events) && value.events.every(isRelicEvent) &&
        Array.isArray(value.winnerIds) && value.winnerIds.every(isString) &&
        (value.setup === undefined || isRelicPublicSetupMetadata(value.setup));
}

function isRelicGamePhase(value: unknown): value is RelicGamePhase {
    return value === 'lobby' || value === 'planning' || value === 'review' ||
        value === 'finished';
}

function isRelicRoom(value: unknown): value is RelicRoom {
    return isRecord(value) &&
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        isRelicRoomKind(value.kind) &&
        isFiniteNumber(value.x) &&
        isFiniteNumber(value.z) &&
        Array.isArray(value.neighbors) && value.neighbors.every(isString) &&
        isOptionalBoolean(value.collapsed) &&
        isOptionalBoolean(value.unstable);
}

function isRelicRoomKind(value: unknown): value is RelicRoomKind {
    return value === 'entrance' || value === 'hallway' || value === 'storage' ||
        value === 'shrine' || value === 'trap' || value === 'treasure' ||
        value === 'monster' || value === 'exit';
}

function isRelicDefinition(value: unknown): value is RelicDefinition {
    return isRecord(value) &&
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        isFiniteNumber(value.value) &&
        typeof value.roomId === 'string' &&
        isOptionalString(value.foundBy) &&
        isOptionalString(value.carriedBy) &&
        isOptionalString(value.escapedBy);
}

function isRelicRoomInvestigation(
    value: unknown,
): value is RelicRoomInvestigation {
    return isRecord(value) &&
        typeof value.roomId === 'string' &&
        typeof value.searchedByPlayerId === 'string' &&
        typeof value.searchedByUsername === 'string' &&
        isFiniteNumber(value.searchedAtRound) &&
        isFiniteNumber(value.searchedAtEpochMs) &&
        (value.result === 'empty' || value.result === 'relic-found') &&
        typeof value.summary === 'string' &&
        typeof value.hint === 'string' &&
        isRelicRoomInvestigationEffect(value.effect) &&
        isOptionalString(value.danger) &&
        isOptionalString(value.revealedRoomId) &&
        isOptionalString(value.relicId);
}

function isRelicRoomInvestigationEffect(
    value: unknown,
): value is RelicRoomInvestigationEffect {
    return value === 'ordinary-search' || value === 'map-fragment' ||
        value === 'rune-reading' || value === 'safe-path' ||
        value === 'treasure-trail' || value === 'monster-trace' ||
        value === 'exit-route';
}

function isRelicPlayer(value: unknown): value is RelicPlayer {
    return isRecord(value) &&
        typeof value.playerId === 'string' &&
        typeof value.username === 'string' &&
        isRelicCharacterId(value.characterId) &&
        typeof value.roomId === 'string' &&
        isFiniteNumber(value.health) &&
        typeof value.escaped === 'boolean' &&
        typeof value.defeated === 'boolean' &&
        isFiniteNumber(value.score) &&
        Array.isArray(value.relicIds) && value.relicIds.every(isString);
}

function isRelicEvent(value: unknown): value is RelicEvent {
    return isRecord(value) &&
        typeof value.id === 'string' &&
        isFiniteNumber(value.round) &&
        isRelicEventType(value.type) &&
        typeof value.message === 'string' &&
        (value.animationCue === undefined || isRelicAnimationCue(value.animationCue)) &&
        (value.tone === undefined || value.tone === 'neutral' ||
            value.tone === 'success' || value.tone === 'danger' ||
            value.tone === 'mystery') &&
        isFiniteNumber(value.createdAtEpochMs);
}

function isRelicEventType(value: unknown): value is RelicEventType {
    return value === 'game_waiting' || value === 'player_joined' ||
        value === 'round_started' || value === 'action_submitted' ||
        value === 'action_revealed' || value === 'player_moved' ||
        value === 'player_searched' || value === 'relic_found' ||
        value === 'relic_picked_up' || value === 'steal_succeeded' ||
        value === 'steal_failed' || value === 'escape_failed' ||
        value === 'player_escaped' || value === 'noise_pulse' ||
        value === 'player_damaged' || value === 'room_unstable' ||
        value === 'room_collapsed' || value === 'game_finished';
}

function isRelicAnimationCue(value: unknown): value is RelicAnimationCue {
    return isRecord(value) &&
        isRelicAnimationCueType(value.type) &&
        isOptionalString(value.roomId) &&
        isOptionalString(value.fromRoomId) &&
        isOptionalString(value.playerId) &&
        isOptionalString(value.targetPlayerId) &&
        isOptionalString(value.relicId) &&
        isOptionalFiniteNumber(value.durationMs) &&
        (value.intensity === undefined || value.intensity === 'low' ||
            value.intensity === 'medium' || value.intensity === 'high');
}

function isRelicAnimationCueType(
    value: unknown,
): value is RelicAnimationCueType {
    return value === 'camera_move' || value === 'search_altar' ||
        value === 'relic_reveal' || value === 'relic_pickup' ||
        value === 'steal_attempt' || value === 'escape_run' ||
        value === 'noise_pulse' || value === 'damage_shake' ||
        value === 'room_collapse' || value === 'heart_relic_victory';
}

function isRelicPublicSetupMetadata(
    value: unknown,
): value is RelicPublicSetupMetadata {
    return isRecord(value) &&
        value.schemaVersion === 1 &&
        (value.source === 'default' || value.source === 'procedural' ||
            value.source === 'rallar-ai' || value.source === 'mock') &&
        isOptionalString(value.theme) &&
        !('seed' in value) &&
        !('blueprintId' in value);
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === 'string';
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
    return value === undefined || isFiniteNumber(value);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
    return value === undefined || typeof value === 'boolean';
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
