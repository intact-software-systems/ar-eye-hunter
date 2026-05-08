import { describe, expect, it } from 'vitest';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import {
    RELIC_PROTOCOL_VERSION,
    applyRelicCommand,
    createRelicGame,
    toPublicRelicSnapshot,
    type RelicGameState,
    type RelicPublicSnapshot,
} from '@relic-hunters/mod.ts';
import { ROOM_SIZE, ROAM_MARGIN } from '../../../apps/relic-hunters-v1/src/game/scene/constants.ts';
import {
    computeScenePrompt,
    roomClueHotspot,
} from '../../../apps/relic-hunters-v1/src/game/scene/prompts.ts';

describe('Relic scene prompt computation', () => {
    it('shows a turn-based move prompt near an open doorway', () => {
        const snapshot = planningSnapshot();
        const entrance = room(snapshot, 'entrance');
        const prompt = computeScenePrompt({
            snapshot,
            localPlayerId: 'alice-session',
            room: entrance,
            roamOffset: new Vector3(0, 0, ROOM_SIZE / 2 - ROAM_MARGIN - 0.1),
            forward: new Vector3(0, 0, 1),
        });

        expect(prompt).toEqual({
            kind: 'move',
            roomId: 'hallway',
            roomName: 'Hallway',
            direction: 'south',
        });
    });

    it('shows a clue search prompt when the hunter inspects the room hotspot', () => {
        const snapshot = planningSnapshot();
        const storage = room(snapshot, 'storage');
        const prompt = computeScenePrompt({
            snapshot: {
                ...snapshot,
                players: snapshot.players.map((player) =>
                    player.playerId === 'alice-session'
                        ? { ...player, roomId: 'storage' }
                        : player
                ),
            },
            localPlayerId: 'alice-session',
            room: storage,
            roamOffset: new Vector3(-0.75, 0, 0.55),
            forward: new Vector3(1, 0, 0),
        });

        expect(prompt).toMatchObject({
            kind: 'search',
            label: 'Search the crates',
        });
    });

    it('marks the search prompt as inspecting while the clue camera is focused', () => {
        const snapshot = planningSnapshot();
        const shrine = room(snapshot, 'shrine');
        const prompt = computeScenePrompt({
            snapshot: {
                ...snapshot,
                players: snapshot.players.map((player) =>
                    player.playerId === 'alice-session'
                        ? { ...player, roomId: 'shrine' }
                        : player
                ),
            },
            localPlayerId: 'alice-session',
            room: shrine,
            roamOffset: new Vector3(0, 0, 0),
            forward: new Vector3(0, 0, 1),
            inspection: {
                roomId: 'shrine',
                hotspot: roomClueHotspot(shrine),
            },
        });

        expect(prompt).toMatchObject({
            kind: 'search',
            label: 'Search the altar',
            inspecting: true,
        });
        expect(prompt?.detail).toContain('altar glyphs pulse');
    });

    it('does not show clue search prompts before the expedition starts', () => {
        const snapshot = lobbySnapshot();
        const entrance = room(snapshot, 'entrance');
        const prompt = computeScenePrompt({
            snapshot,
            localPlayerId: 'alice-session',
            room: entrance,
            roamOffset: new Vector3(0, 0, 0),
            forward: new Vector3(0, 0, 1),
        });

        expect(prompt).toBeUndefined();
    });
});

function lobbySnapshot(): RelicPublicSnapshot {
    let state: RelicGameState = createRelicGame('room-1', 'room-1', 1);
    state = applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username: 'Alice',
        characterId: 'kael-ironstride',
    }, {
        senderId: 'alice-session',
        now: () => 2,
    }).state;

    return toPublicRelicSnapshot(state);
}

function planningSnapshot(): RelicPublicSnapshot {
    let state: RelicGameState = createRelicGame('room-1', 'room-1', 1);
    state = applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username: 'Alice',
        characterId: 'kael-ironstride',
    }, {
        senderId: 'alice-session',
        now: () => 2,
    }).state;
    state = applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'start-expedition',
        gameId: 'room-1',
        username: 'Alice',
    }, {
        senderId: 'alice-session',
        now: () => 3,
    }).state;

    return toPublicRelicSnapshot(state);
}

function room(snapshot: RelicPublicSnapshot, roomId: string): RelicPublicSnapshot['map'][number] {
    const found = snapshot.map.find((candidate) => candidate.id === roomId);
    if (!found) {
        throw new Error(`Missing room ${roomId}`);
    }

    return found;
}
