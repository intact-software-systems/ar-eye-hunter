export const GAME_PROTOCOL = 'ar-eye-hunter.v1';
export const GAME_LANE_ID = 'realtime';
export const GAME_ROOM_NAME = 'AR Eye Hunter Arena';

export type Vec3Tuple = readonly [number, number, number];

export type PlayerPose = Readonly<{
    sessionId: string;
    username: string;
    color: string;
    position: Vec3Tuple;
    rotation: Vec3Tuple;
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
