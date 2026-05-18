import { rallar } from '@shared-web/browser/rallar.ts';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import { roomWorldPosition } from './rooms.ts';

export const POS_MAX_AGE_MS = 2500;

const POS_TYPE_ID = 'relic.pos';
const POS_BROADCAST_INTERVAL_MS = 80;

export type RelicPosUpdate = Readonly<{
    pid: string;
    roomId?: string;
    x: number;
    z: number;
    ox?: number;
    oz?: number;
    r: number;
}>;

export type RemotePosEntry = {
    x: number;
    z: number;
    yaw: number;
    roomId?: string;
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
        const { pid, r, roomId } = msg.payload;
        if (pid === runtime.localPlayerId.value) return;
        const snapshot = runtime.snapshot.value;
        if (snapshot && !snapshot.players.some((player) => player.playerId === pid)) {
            return;
        }

        const position = resolveRelicPosUpdatePosition(msg.payload, snapshot);
        if (!position) return;

        runtime.remotePositions.set(pid, {
            x: position.x,
            z: position.z,
            yaw: r,
            roomId,
            t: performance.now(),
        });
    });
}

export function resolveRelicPosUpdatePosition(
    update: RelicPosUpdate,
    snapshot: RelicPublicSnapshot | undefined,
): Readonly<{ x: number; z: number }> | undefined {
    const offsetX = update.ox;
    const offsetZ = update.oz;
    if (
        update.roomId &&
        typeof offsetX === 'number' &&
        typeof offsetZ === 'number' &&
        Number.isFinite(offsetX) &&
        Number.isFinite(offsetZ)
    ) {
        const room = snapshot?.map.find((candidate) => candidate.id === update.roomId);
        if (room) {
            const world = roomWorldPosition(room);
            return {
                x: world.x + offsetX,
                z: world.z + offsetZ,
            };
        }
    }

    if (Number.isFinite(update.x) && Number.isFinite(update.z)) {
        return { x: update.x, z: update.z };
    }

    return undefined;
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

    const room = snapshot.map.find((candidate) => candidate.id === localPlayer.roomId);
    if (!room) return;

    const nextHopPeerIds = [...new Set(rallar.rtc.readyPeerIds())];
    if (nextHopPeerIds.length === 0) return;

    const world = roomWorldPosition(room);
    runtime.lastPosBroadcastMs.value = now;
    void rallar.messages.rtc.send<RelicPosUpdate>({
        roomId: snapshot.roomId,
        typeId: POS_TYPE_ID,
        payload: {
            pid: localPlayer.playerId,
            roomId: room.id,
            x: world.x + runtime.roamOffset.x,
            z: world.z + runtime.roamOffset.z,
            ox: runtime.roamOffset.x,
            oz: runtime.roamOffset.z,
            r: runtime.cameraYaw.value,
        },
        nextHopPeerIds,
        ttlHops: 1,
        reliability: 'best-effort',
    }).catch(() => undefined);
}
