import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { RelicPublicSnapshot, RelicRoom } from '@relic-hunters/mod.ts';
import { yawToForward } from './controls.ts';
import { computeScenePrompt, roomClueHotspot, samePrompt } from './prompts.ts';
import type { InspectionFocus, ScenePrompt } from './types.ts';

export type SceneInteractionState = Readonly<{
    snapshot: { value?: RelicPublicSnapshot };
    localPlayerId: { value?: string };
    cameraYaw: { value: number };
    roamOffset: Vector3;
    prompt: { value?: ScenePrompt };
    onPromptChange: { value(prompt?: ScenePrompt): void };
    inspection: { value?: InspectionFocus };
}>;

export function updateScenePrompt(
    state: SceneInteractionState,
    room: RelicRoom,
    forward: Vector3,
): void {
    setRuntimePrompt(state, computeScenePrompt({
        snapshot: state.snapshot.value,
        localPlayerId: state.localPlayerId.value,
        room,
        roamOffset: state.roamOffset,
        forward,
        inspection: state.inspection.value,
    }));
}

export function startInspection(state: SceneInteractionState): boolean {
    const local = localPlayerRoom(state.snapshot.value, state.localPlayerId.value);
    if (!local) {
        return false;
    }
    if (
        local.snapshot.phase !== 'planning' ||
        local.snapshot.submittedPlayerIds.includes(local.player.playerId)
    ) {
        return false;
    }

    state.inspection.value = {
        roomId: local.room.id,
        hotspot: roomClueHotspot(local.room),
    };
    updateScenePrompt(state, local.room, yawToForward(state.cameraYaw.value));
    return true;
}

export function shouldExitInspection(
    state: SceneInteractionState,
    room: RelicRoom,
): boolean {
    const inspection = state.inspection.value;
    if (!inspection) {
        return false;
    }

    if (inspection.roomId !== room.id) {
        return true;
    }

    const distance = new Vector3(
        inspection.hotspot.x - state.roamOffset.x,
        0,
        inspection.hotspot.z - state.roamOffset.z,
    ).length();

    return distance > 2.55;
}

export function setRuntimePrompt(
    state: SceneInteractionState,
    prompt: ScenePrompt | undefined,
): void {
    if (samePrompt(state.prompt.value, prompt)) {
        return;
    }

    state.prompt.value = prompt;
    state.onPromptChange.value(prompt);
}

function localPlayerRoom(
    snapshot: RelicPublicSnapshot | undefined,
    localPlayerId: string | undefined,
): Readonly<{
    snapshot: RelicPublicSnapshot;
    player: RelicPublicSnapshot['players'][number];
    room: RelicRoom;
}> | undefined {
    const player = snapshot?.players.find((candidate) => candidate.playerId === localPlayerId);
    if (!snapshot || !player || player.escaped || player.defeated) {
        return undefined;
    }

    const room = snapshot.map.find((candidate) => candidate.id === player.roomId);
    if (!room) {
        return undefined;
    }

    return { snapshot, player, room };
}
