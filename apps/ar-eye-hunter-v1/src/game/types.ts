export const GAME_PROTOCOL = 'ar-eye-hunter.v1';
export const GAME_LANE_ID = 'realtime';
export const GAME_MOTION_LANE_ID = 'motion';
export const GAME_ROOM_NAME = 'AR Eye Hunter Arena';
export const GAME_DIRECTOR_TOPIC_ID = 'ar-eye-hunter.director';
export const GAME_DIRECTOR_INTENT_TYPE_ID = 'ar-eye-hunter.director.intent.v1';
export const GAME_DIRECTOR_OUTPUT_TYPE_ID = 'ar-eye-hunter.director.output.v1';
export const GAME_DIRECTOR_HEARTBEAT_TYPE_ID = 'ar-eye-hunter.director.heartbeat.v1';
export const GAME_DIRECTOR_SNAPSHOT_TYPE_ID = 'ar-eye-hunter.director.snapshot.v1';
export const GAME_DIRECTOR_SYNC_REQUEST_TYPE_ID = 'ar-eye-hunter.director.sync-request.v1';

export type Vec3Tuple = readonly [number, number, number];

export type PlayerPose = Readonly<{
    sessionId: string;
    username: string;
    color: string;
    position: Vec3Tuple;
    rotation: Vec3Tuple;
    velocity?: Vec3Tuple;
    angularVelocity?: Vec3Tuple;
    score: number;
    seq: number;
    sentAtEpochMs: number;
}>;

export type PlayerShot = Readonly<{
    sessionId: string;
    username: string;
    color: string;
    origin: Vec3Tuple;
    direction: Vec3Tuple;
    seq: number;
    sentAtEpochMs: number;
}>;

export type GameRealtimeMessage =
    | Readonly<{
    protocol: typeof GAME_PROTOCOL;
    kind: 'player-pose';
    pose: PlayerPose;
}>
    | Readonly<{
    protocol: typeof GAME_PROTOCOL;
    kind: 'player-shot';
    shot: PlayerShot;
}>
    | Readonly<{
    protocol: typeof GAME_PROTOCOL;
    kind: 'player-pose-intent';
    pose: PlayerPose;
}>
    | Readonly<{
    protocol: typeof GAME_PROTOCOL;
    kind: 'player-shot-intent';
    shot: PlayerShot;
}>
    | Readonly<{
    protocol: typeof GAME_PROTOCOL;
    kind: 'director-player-state';
    pose: PlayerPose;
}>
    | Readonly<{
    protocol: typeof GAME_PROTOCOL;
    kind: 'director-shot-event';
    shot: PlayerShot;
}>
    | Readonly<{
    protocol: typeof GAME_PROTOCOL;
    kind: 'director-heartbeat';
    sessionId: string;
    sentAtEpochMs: number;
}>
    | Readonly<{
    protocol: typeof GAME_PROTOCOL;
    kind: 'director-state-snapshot';
    players: readonly PlayerPose[];
    sentAtEpochMs: number;
}>
    | Readonly<{
    protocol: typeof GAME_PROTOCOL;
    kind: 'director-sync-request';
    sessionId: string;
    sentAtEpochMs: number;
}>;

export type RemotePlayer = Readonly<{
    pose: PlayerPose;
    lastSeenEpochMs: number;
}>;

export type RemoteShot = Readonly<{
    id: string;
    shot: PlayerShot;
    receivedAtEpochMs: number;
}>;
