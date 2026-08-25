import { DEFAULT_REALTIME_DATA_CHANNEL_LANE } from '@shared-web/browser/rallar-realtime.ts';
import {
    createRallarGameLanePresets,
    createRallarGameMatch,
    type RallarGameEnvelopeHandler,
    type RallarGameLaneIds,
    type RallarGameMatchHandle,
    type RallarGameRallarFacade
} from '@shared-web/game/mod.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';
import {
    GAME_AI_LANE_ID,
    GAME_COMBAT_LANE_ID,
    GAME_DIRECTOR_TOPIC_ID,
    GAME_FX_LANE_ID,
    GAME_MOTION_LANE_ID,
    GAME_PROTOCOL,
    type ArenaSnapshot,
    type GameRealtimeMessage
} from './types.ts';

export const GAME_SNAPSHOT_LANE_ID = 'arena-snapshot';

export const ARENA_RALLAR_GAME_LANE_IDS: RallarGameLaneIds = {
    input: GAME_MOTION_LANE_ID,
    intent: GAME_COMBAT_LANE_ID,
    snapshot: GAME_SNAPSHOT_LANE_ID,
    metrics: GAME_FX_LANE_ID,
    replication: GAME_AI_LANE_ID
};

export const ARENA_RALLAR_GAME_DATA_CHANNEL_LANES: readonly RtcDataChannelLaneConfig[] = [
    DEFAULT_REALTIME_DATA_CHANNEL_LANE,
    ...createRallarGameLanePresets({
        laneIds: ARENA_RALLAR_GAME_LANE_IDS,
        inputMaxQueueItems: 8,
        intentMaxQueueItems: 32,
        snapshotMaxQueueItems: 8,
        metricsMaxQueueItems: 24,
        replicationMaxQueueItems: 16
    })
];

export type ArenaRallarGameMatchHandle = RallarGameMatchHandle<
    GameRealtimeMessage,
    GameRealtimeMessage,
    ArenaSnapshot,
    GameRealtimeMessage
>;

export type ArenaRallarGameMatchConfig = Readonly<{
    rallar: RallarGameRallarFacade;
    roomId?: string;
    readSnapshot: () => ArenaSnapshot | undefined;
    onPresence?: RallarGameEnvelopeHandler<GameRealtimeMessage>;
    onInput?: RallarGameEnvelopeHandler<GameRealtimeMessage>;
    onIntent?: RallarGameEnvelopeHandler<GameRealtimeMessage>;
    onSnapshot?: RallarGameEnvelopeHandler<ArenaSnapshot>;
    onEvent?: RallarGameEnvelopeHandler<GameRealtimeMessage>;
    onSyncRequest?: RallarGameEnvelopeHandler<unknown>;
}>;

export function createArenaRallarGameMatch(
    config: ArenaRallarGameMatchConfig
): ArenaRallarGameMatchHandle {
    return createRallarGameMatch<GameRealtimeMessage, GameRealtimeMessage, ArenaSnapshot, GameRealtimeMessage>({
        rallar: config.rallar,
        protocol: GAME_PROTOCOL,
        topicId: GAME_DIRECTOR_TOPIC_ID,
        roomId: config.roomId,
        laneIds: ARENA_RALLAR_GAME_LANE_IDS,
        readCapability: readArenaHostCapability,
        readSnapshot: config.readSnapshot,
        autoSnapshotIntervalMs: false,
        onPresence: config.onPresence,
        onInput: config.onInput,
        onIntent: config.onIntent,
        onSnapshot: config.onSnapshot,
        onEvent: config.onEvent,
        onSyncRequest: config.onSyncRequest
    });
}

export function isArenaPoseIntentFromSender(
    message: GameRealtimeMessage,
    senderId: string
): message is Extract<GameRealtimeMessage, { kind: 'player-pose-intent'; }> {
    return message.protocol === GAME_PROTOCOL &&
        message.kind === 'player-pose-intent' &&
        message.pose.sessionId === senderId;
}

export function isArenaShotIntentFromSender(
    message: GameRealtimeMessage,
    senderId: string
): message is Extract<GameRealtimeMessage, { kind: 'player-shot-intent'; }> {
    return message.protocol === GAME_PROTOCOL &&
        message.kind === 'player-shot-intent' &&
        message.shot.sessionId === senderId;
}

export function isArenaAcceptedShotFromSender(
    message: GameRealtimeMessage,
    senderId: string
): message is Extract<GameRealtimeMessage, { kind: 'director-shot-accepted'; }> {
    return message.protocol === GAME_PROTOCOL &&
        message.kind === 'director-shot-accepted' &&
        message.accepted.shot.sessionId === senderId;
}

export function isArenaPlayerHitIntentFromSender(
    message: GameRealtimeMessage,
    senderId: string
): message is Extract<GameRealtimeMessage, { kind: 'player-hit-intent'; }> {
    return message.protocol === GAME_PROTOCOL &&
        message.kind === 'player-hit-intent' &&
        message.intent.shot.sessionId === senderId;
}

export function isArenaPickupIntentFromSender(
    message: GameRealtimeMessage,
    senderId: string
): message is Extract<GameRealtimeMessage, { kind: 'pickup-intent'; }> {
    return message.protocol === GAME_PROTOCOL &&
        message.kind === 'pickup-intent' &&
        message.intent.sessionId === senderId;
}

export function isArenaMatchStartIntentFromSender(
    message: GameRealtimeMessage,
    senderId: string
): message is Extract<GameRealtimeMessage, { kind: 'match-start-intent'; }> {
    return message.protocol === GAME_PROTOCOL &&
        message.kind === 'match-start-intent' &&
        message.intent.directorSessionId === senderId;
}

function readArenaHostCapability() {
    return {
        canHost: true,
        hardwareConcurrency: navigator.hardwareConcurrency,
        isMobile: matchMedia('(pointer: coarse)').matches,
        scoreBias: document.visibilityState === 'visible' ? 20 : -20
    };
}
