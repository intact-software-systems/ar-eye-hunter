import { rallar } from '@shared-web/browser/rallar.ts';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import { WORLD_SCALE } from './constants.ts';

export const POS_MAX_AGE_MS = 2500;

const POS_TYPE_ID = 'relic.pos';
const POS_BROADCAST_INTERVAL_MS = 80;

export type RelicPosUpdate = Readonly<{ pid: string; x: number; z: number; r: number }>;

export type RemotePosEntry = {
    x: number;
    z: number;
    yaw: number;
    t: number;
};

export type RelicScenePositionRuntime = Readonly<{
    snapshot: { value?: RelicPublicSnapshot };
    localPlayerId: { value?: string };
    rtcReady: { value: boolean };
    roamOffset: Vector3;
    cameraYaw: { value: number };
    remotePositions: Map<string, RemotePosEntry>;
    lastPosBroadcastMs: { value: number };
}>;

export function subscribeRelicScenePositionUpdates(
    runtime: RelicScenePositionRuntime,
): () => void {
    return rallar.messages.rtc.onMessage<RelicPosUpdate>(POS_TYPE_ID, (msg) => {
        const { pid, x, z, r } = msg.payload;
        runtime.remotePositions.set(pid, { x, z, yaw: r, t: performance.now() });
    });
}

export function broadcastLocalPosition(runtime: RelicScenePositionRuntime): void {
    if (!runtime.rtcReady.value) return;
    const now = performance.now();
    if (now - runtime.lastPosBroadcastMs.value < POS_BROADCAST_INTERVAL_MS) return;

    const snapshot = runtime.snapshot.value;
    const localPlayerId = runtime.localPlayerId.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    if (!snapshot || !localPlayer || localPlayer.escaped || localPlayer.defeated) {
        return;
    }

    runtime.lastPosBroadcastMs.value = now;
    const room = snapshot.map.find((candidate) => candidate.id === localPlayer.roomId);
    if (!room) return;

    void rallar.messages.rtc.send<RelicPosUpdate>({
        typeId: POS_TYPE_ID,
        payload: {
            pid: localPlayer.playerId,
            x: room.x * WORLD_SCALE + runtime.roamOffset.x,
            z: room.z * WORLD_SCALE + runtime.roamOffset.z,
            r: runtime.cameraYaw.value,
        },
        reliability: 'best-effort',
    });
}
