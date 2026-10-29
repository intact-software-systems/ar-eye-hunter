import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { isRallarGameRematch, type RallarGameRematch } from '@shared/rallar-game/rematch.ts';
import { Either } from '@shared/resilience/Either.ts';

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

export const RELIC_EXPEDITION_CAPACITY = 4;

export const RELIC_GAME_PHASES = ['lobby', 'planning', 'review', 'finished'] as const;

export type RelicGamePhase = (typeof RELIC_GAME_PHASES)[number];

export type RelicExpeditionSetupSource =
    | 'default'
    | 'procedural'
    | 'rallar-ai'
    | 'mock';

export interface RelicExpeditionSetupMetadata {
    readonly schemaVersion: 1;
    readonly source: RelicExpeditionSetupSource;
    readonly seed?: string;
    readonly theme?: string;
    readonly blueprintId?: string;
}

export type RelicPublicSetupMetadata = Omit<RelicExpeditionSetupMetadata, 'seed' | 'blueprintId'>;

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
    'zaya-stormvein'
];

export type RelicEventType =
    | 'game_waiting'
    | 'player_joined'
    | 'player_withdrew'
    | 'keeper_changed'
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

export interface RelicAnimationCue {
    readonly type: RelicAnimationCueType;
    readonly roomId?: string;
    readonly fromRoomId?: string;
    readonly playerId?: string;
    readonly targetPlayerId?: string;
    readonly relicId?: string;
    readonly durationMs?: number;
    readonly intensity?: 'low' | 'medium' | 'high';
}

export interface RelicRoom {
    readonly id: string;
    readonly name: string;
    readonly kind: RelicRoomKind;
    readonly x: number;
    readonly z: number;
    readonly neighbors: readonly string[];
    readonly collapsed?: boolean;
    readonly unstable?: boolean;
}

export interface RelicDefinition {
    readonly id: string;
    readonly name: string;
    readonly value: number;
    readonly roomId: string;
    readonly foundBy?: string;
    readonly carriedBy?: string;
    readonly escapedBy?: string;
}

export type RelicRoomInvestigationResult = 'empty' | 'relic-found';

export type RelicRoomInvestigationEffect =
    | 'ordinary-search'
    | 'map-fragment'
    | 'rune-reading'
    | 'safe-path'
    | 'treasure-trail'
    | 'monster-trace'
    | 'exit-route';

export interface RelicRoomInvestigation {
    readonly roomId: string;
    readonly searchedByPlayerId: string;
    readonly searchedByUsername: string;
    readonly searchedAtRound: number;
    readonly searchedAtEpochMs: number;
    readonly result: RelicRoomInvestigationResult;
    readonly summary: string;
    readonly hint: string;
    readonly effect: RelicRoomInvestigationEffect;
    readonly danger?: string;
    readonly revealedRoomId?: string;
    readonly relicId?: string;
}

export interface RelicPlayer {
    readonly playerId: string;
    readonly username: string;
    readonly characterId: RelicCharacterId;
    readonly roomId: string;
    readonly health: number;
    readonly escaped: boolean;
    readonly defeated: boolean;
    readonly score: number;
    readonly relicIds: readonly string[];
    /** Present only when a withdrawn escaped hunter remains as banked-score history. */
    readonly withdrawnAtEpochMs?: number;
}

export interface RelicActionInput {
    readonly kind: RelicActionKind;
    readonly targetRoomId?: string;
    readonly targetPlayerId?: string;
}

export interface RelicPendingAction {
    readonly playerId: string;
    readonly username: string;
    readonly action: RelicActionInput;
    readonly submittedAtEpochMs: number;
}

export interface RelicEvent {
    readonly id: string;
    readonly round: number;
    readonly type: RelicEventType;
    readonly message: string;
    readonly animationCue?: RelicAnimationCue;
    readonly tone?: 'neutral' | 'success' | 'danger' | 'mystery';
    readonly createdAtEpochMs: number;
}

export interface RelicGameState {
    readonly protocolVersion: typeof RELIC_PROTOCOL_VERSION;
    readonly gameId: string;
    readonly roomId: string;
    readonly phase: RelicGamePhase;
    readonly round: number;
    readonly maxRounds: number;
    readonly createdAtEpochMs: number;
    readonly updatedAtEpochMs: number;
    readonly adminPlayerId?: string;
    readonly roundTimeLimitMs: number;
    readonly roundStartedAtEpochMs?: number;
    readonly map: readonly RelicRoom[];
    readonly relics: readonly RelicDefinition[];
    readonly roomInvestigations: readonly RelicRoomInvestigation[];
    readonly players: readonly RelicPlayer[];
    readonly pendingActions: readonly RelicPendingAction[];
    readonly events: readonly RelicEvent[];
    readonly winnerIds: readonly string[];
    readonly setup?: RelicExpeditionSetupMetadata;
    /** Accepted preparation exists only while this completed expedition awaits another game. */
    readonly rematch?: RelicRematch;
}

export interface RelicPublicSnapshot {
    readonly protocolVersion: typeof RELIC_PROTOCOL_VERSION;
    readonly gameId: string;
    readonly roomId: string;
    readonly phase: RelicGamePhase;
    readonly round: number;
    readonly maxRounds: number;
    readonly createdAtEpochMs: number;
    readonly updatedAtEpochMs: number;
    readonly adminPlayerId?: string;
    readonly roundTimeLimitMs: number;
    readonly roundStartedAtEpochMs?: number;
    readonly map: readonly RelicRoom[];
    readonly relics: readonly RelicDefinition[];
    readonly roomInvestigations: readonly RelicRoomInvestigation[];
    readonly players: readonly RelicPlayer[];
    readonly submittedPlayerIds: readonly string[];
    readonly events: readonly RelicEvent[];
    readonly winnerIds: readonly string[];
    readonly setup?: RelicPublicSetupMetadata;
    readonly rematch?: RelicRematch;
}

export interface RelicRematchHunter {
    readonly playerId: string;
    readonly username: string;
    readonly characterId: RelicCharacterId;
}

export interface RelicRematch {
    readonly preparation: RallarGameRematch;
    readonly hunters: readonly RelicRematchHunter[];
    readonly roundTimeLimitMs: number;
}

export type RelicRematchCommand =
    & Readonly<{
        protocolVersion: typeof RELIC_PROTOCOL_VERSION;
        gameId: string;
        username: string;
        completedGameId: string;
        settingsKey: string;
    }>
    & (
        | Readonly<
            { kind: 'set-rematch-ready'; ready: boolean; characterId: RelicCharacterId; participationKey: string; }
        >
        | Readonly<{ kind: 'start-rematch'; }>
        | Readonly<{ kind: 'set-rematch-round-limit'; timeLimitMs: number; }>
    );

export type RelicCommand =
    | RelicRematchCommand
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
        kind: 'leave-expedition';
        gameId: string;
        username: string;
    }>
    | Readonly<{
        protocolVersion: typeof RELIC_PROTOCOL_VERSION;
        kind: 'take-keeper';
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

export interface RelicServerEvent {
    readonly protocolVersion: typeof RELIC_PROTOCOL_VERSION;
    readonly gameId: string;
    readonly snapshot: RelicPublicSnapshot;
}

export type RelicRoundTransition = 'round-started' | 'round-resolved' | 'review-continued' | 'finished';

export interface RelicRuleRefusal {
    readonly code: string;
    readonly message: string;
}

/** The transition of a round, published beside the snapshot of the command that made it. */
export interface RelicRoundTransitionEvent {
    readonly protocolVersion: typeof RELIC_PROTOCOL_VERSION;
    readonly gameId: string;
    readonly createdAtEpochMs: number;
    readonly round: number;
    readonly phase: RelicGamePhase;
    readonly transition: RelicRoundTransition;
    /** The message of the event the rules append for the transition. */
    readonly text: string;
}

/**
 * What the server tells the acting hunter's own sessions in the room alone: the action it recorded for the round,
 * or the text of the rule that refused a command. A hunter plays as a session, so `playerId` names the session that
 * sent the command; the hunter's other sessions are other players of the game.
 */
export type RelicHunterEvent =
    | Readonly<{
        protocolVersion: typeof RELIC_PROTOCOL_VERSION;
        gameId: string;
        principalId: string;
        playerId: string;
        kind: 'action-recorded';
        round: number;
        action: RelicActionInput;
    }>
    | Readonly<{
        protocolVersion: typeof RELIC_PROTOCOL_VERSION;
        gameId: string;
        principalId: string;
        playerId: string;
        kind: 'command-refused';
        completedGameId: string | null;
        command: RelicCommand['kind'];
        text: string;
    }>;

/**
 * The ordering key of the round transitions names the incarnation of the game: a reset keeps the game
 * id and starts a new incarnation, whose rounds are new tracks.
 */
export function toRelicRoundTrackKey(game: Pick<RelicPublicSnapshot, 'gameId' | 'createdAtEpochMs'>): string {
    return `${game.gameId}:${game.createdAtEpochMs}`;
}

/** A round track of any incarnation of the game: its key is the game id, a colon and a creation time. */
export function isRelicRoundTrackOfGame(orderingKey: string, gameId: string): boolean {
    const prefix = `${gameId}:`;
    return orderingKey.startsWith(prefix) && /^\d+$/.test(orderingKey.slice(prefix.length));
}

export function toPublicRelicSnapshot(state: RelicGameState): RelicPublicSnapshot {
    return {
        protocolVersion: state.protocolVersion,
        gameId: state.gameId,
        roomId: state.roomId,
        phase: state.phase,
        round: state.round,
        maxRounds: state.maxRounds,
        createdAtEpochMs: state.createdAtEpochMs,
        updatedAtEpochMs: state.updatedAtEpochMs,
        adminPlayerId: state.adminPlayerId,
        roundTimeLimitMs: state.roundTimeLimitMs,
        roundStartedAtEpochMs: state.roundStartedAtEpochMs,
        map: state.map,
        relics: toPublicRelics(state.relics),
        // A relic-found investigation is created only after the relic is marked
        // found/carried above, so its relic and clue references are public state.
        roomInvestigations: state.roomInvestigations,
        players: state.players,
        submittedPlayerIds: state.pendingActions.map((action) => action.playerId),
        events: state.events.slice(-48),
        winnerIds: state.winnerIds,
        setup: toPublicSetup(state.setup),
        ...(state.rematch === undefined ? {} : { rematch: state.rematch })
    };
}

function toPublicRelics(
    relics: readonly RelicDefinition[]
): readonly RelicDefinition[] {
    const discovered = relics.filter((relic) => relic.foundBy || relic.carriedBy || relic.escapedBy);
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
                roomId: ''
            };
        }
    );

    // Preserve HUD cardinality without retaining a hidden relic's source index.
    return [...discovered, ...hidden];
}

function toPublicSetup(
    setup: RelicExpeditionSetupMetadata | undefined
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

    switch (value.kind) {
        case 'set-rematch-ready':
            return isRematchCommandIdentity(value) && typeof value.ready === 'boolean' &&
                typeof value.participationKey === 'string' && value.participationKey.length > 0 &&
                isRelicCharacterId(value.characterId);
        case 'start-rematch':
            return isRematchCommandIdentity(value);
        case 'set-rematch-round-limit':
            return isRematchCommandIdentity(value) && typeof value.timeLimitMs === 'number' &&
                [60_000, 180_000, 300_000].includes(value.timeLimitMs);
        case 'join-expedition':
            return value.characterId === undefined || isRelicCharacterId(value.characterId);
        case 'start-expedition':
        case 'leave-expedition':
        case 'take-keeper':
        case 'force-resolve-round':
        case 'continue-review':
            return true;
        case 'set-round-limit':
            return typeof value.timeLimitMs === 'number' && [60_000, 180_000, 300_000].includes(value.timeLimitMs);
        case 'pickup-relic':
            return typeof value.relicId === 'string' && value.relicId.length > 0;
        case 'submit-action':
            return isRecord(value.action) && isRelicActionKind(value.action.kind);
        default:
            return false;
    }
}

export function isRelicSnapshot(value: unknown): value is RelicPublicSnapshot {
    return isRecord(value) &&
        value.protocolVersion === RELIC_PROTOCOL_VERSION &&
        typeof value.gameId === 'string' &&
        typeof value.roomId === 'string' &&
        isRelicGamePhase(value.phase) &&
        isFiniteNumber(value.round) &&
        isFiniteNumber(value.maxRounds) &&
        isFiniteNumber(value.createdAtEpochMs) &&
        isFiniteNumber(value.updatedAtEpochMs) &&
        isOptionalString(value.adminPlayerId) &&
        isFiniteNumber(value.roundTimeLimitMs) &&
        isOptionalFiniteNumber(value.roundStartedAtEpochMs) &&
        Array.isArray(value.map) && value.map.every(isRelicRoom) &&
        Array.isArray(value.relics) && value.relics.every(isRelicDefinition) &&
        Array.isArray(value.roomInvestigations) &&
        value.roomInvestigations.every(isRelicRoomInvestigation) &&
        Array.isArray(value.players) && value.players.length <= RELIC_EXPEDITION_CAPACITY &&
        value.players.every(isRelicPlayer) &&
        Array.isArray(value.submittedPlayerIds) && value.submittedPlayerIds.every(isString) &&
        Array.isArray(value.events) && value.events.every(isRelicEvent) &&
        Array.isArray(value.winnerIds) && value.winnerIds.every(isString) &&
        (value.setup === undefined || isRelicPublicSetupMetadata(value.setup)) &&
        (value.rematch === undefined || value.phase === 'finished' &&
                isRelicRematch(value.rematch) && value.rematch.preparation.completedGameId ===
                    toRelicRoundTrackKey({ gameId: value.gameId, createdAtEpochMs: value.createdAtEpochMs }));
}

export function decodeRelicSnapshotPayload(value: unknown): Either<TypeError, RelicPublicSnapshot> {
    const next = isRecord(value) && 'snapshot' in value ? value.snapshot : value;
    return isRelicSnapshot(next) ? Either.ofRight(next) : Either.ofLeft(new TypeError('not a Relic snapshot'));
}

export function isRelicRoundTransitionEvent(value: unknown): value is RelicRoundTransitionEvent {
    return isRecord(value) &&
        value.protocolVersion === RELIC_PROTOCOL_VERSION &&
        typeof value.gameId === 'string' &&
        isFiniteNumber(value.createdAtEpochMs) &&
        isFiniteNumber(value.round) &&
        isRelicGamePhase(value.phase) &&
        isOneOf<RelicRoundTransition>(value.transition, [
            'round-started',
            'round-resolved',
            'review-continued',
            'finished'
        ]) &&
        typeof value.text === 'string';
}

export function isRelicHunterEvent(value: unknown): value is RelicHunterEvent {
    if (
        !isRecord(value) || value.protocolVersion !== RELIC_PROTOCOL_VERSION || typeof value.gameId !== 'string' ||
        typeof value.principalId !== 'string' || typeof value.playerId !== 'string'
    ) {
        return false;
    }
    if (value.kind === 'action-recorded') {
        return isFiniteNumber(value.round) && isRelicActionInput(value.action);
    }
    return value.kind === 'command-refused' && isRelicCommandKind(value.command) && typeof value.text === 'string' &&
        (value.completedGameId === null ||
            typeof value.completedGameId === 'string' && value.completedGameId.length > 0);
}

/** As a command's action is read: its kind decides the rest, which the rules validate. */
function isRelicActionInput(value: unknown): value is RelicActionInput {
    return isRecord(value) && isRelicActionKind(value.kind);
}

function isRelicCommandKind(value: unknown): value is RelicCommand['kind'] {
    return isOneOf<RelicCommand['kind']>(value, [
        'join-expedition',
        'start-expedition',
        'leave-expedition',
        'take-keeper',
        'submit-action',
        'force-resolve-round',
        'pickup-relic',
        'continue-review',
        'set-round-limit',
        'set-rematch-ready',
        'start-rematch',
        'set-rematch-round-limit'
    ]);
}

function isRelicGamePhase(value: unknown): value is RelicGamePhase {
    return isOneOf<RelicGamePhase>(value, RELIC_GAME_PHASES);
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
    return isOneOf<RelicRoomKind>(value, [
        'entrance',
        'hallway',
        'storage',
        'shrine',
        'trap',
        'treasure',
        'monster',
        'exit'
    ]);
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
    value: unknown
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

function isRelicRoomInvestigationEffect(value: unknown): value is RelicRoomInvestigationEffect {
    return isOneOf<RelicRoomInvestigationEffect>(value, [
        'ordinary-search',
        'map-fragment',
        'rune-reading',
        'safe-path',
        'treasure-trail',
        'monster-trace',
        'exit-route'
    ]);
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
        (value.withdrawnAtEpochMs === undefined ||
            value.escaped === true && isFiniteNumber(value.withdrawnAtEpochMs) && value.withdrawnAtEpochMs >= 0) &&
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
    return isOneOf<RelicEventType>(value, [
        'game_waiting',
        'player_joined',
        'player_withdrew',
        'keeper_changed',
        'round_started',
        'action_submitted',
        'action_revealed',
        'player_moved',
        'player_searched',
        'relic_found',
        'relic_picked_up',
        'steal_succeeded',
        'steal_failed',
        'escape_failed',
        'player_escaped',
        'noise_pulse',
        'player_damaged',
        'room_unstable',
        'room_collapsed',
        'game_finished'
    ]);
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

function isRelicAnimationCueType(value: unknown): value is RelicAnimationCueType {
    return isOneOf<RelicAnimationCueType>(value, [
        'camera_move',
        'search_altar',
        'relic_reveal',
        'relic_pickup',
        'steal_attempt',
        'escape_run',
        'noise_pulse',
        'damage_shake',
        'room_collapse',
        'heart_relic_victory'
    ]);
}

function isRelicPublicSetupMetadata(
    value: unknown
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
    return isOneOf<RelicActionKind>(value, ['move', 'search', 'steal', 'escape']);
}

export function isRelicCharacterId(value: unknown): value is RelicCharacterId {
    return isOneOf(value, RELIC_CHARACTER_IDS);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
    return typeof value === 'string' && options.some((option) => option === value);
}

function isRecord(value: unknown): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRematchCommandIdentity(value: ApiJsonObject): boolean {
    return typeof value.completedGameId === 'string' && value.completedGameId.length > 0 &&
        typeof value.settingsKey === 'string' && value.settingsKey.length > 0;
}

function isRelicRematch(value: unknown): value is RelicRematch {
    if (
        !isRecord(value) || Object.keys(value).length !== 3 ||
        !isRallarGameRematch(value.preparation, RELIC_EXPEDITION_CAPACITY) ||
        !Array.isArray(value.hunters) || value.hunters.length !== value.preparation.players.length ||
        typeof value.roundTimeLimitMs !== 'number' || ![60_000, 180_000, 300_000].includes(value.roundTimeLimitMs)
    ) {
        return false;
    }
    const players = value.preparation.players;
    return value.hunters.every((hunter, index) =>
        isRecord(hunter) && Object.keys(hunter).length === 3 && typeof hunter.username === 'string' &&
        isRelicCharacterId(hunter.characterId) && hunter.playerId === players[index].sessionId
    );
}
