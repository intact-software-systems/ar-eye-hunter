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
    samePrompt,
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

    it('keeps doorway prompts ahead of clue prompts when both are in reach', () => {
        const snapshot = planningSnapshot();
        const exit = {
            ...room(snapshot, 'exit'),
            id: 'test-exit',
            x: 0,
            z: 0,
            neighbors: ['south-room'],
        };
        const southRoom = {
            ...room(snapshot, 'hallway'),
            id: 'south-room',
            x: 0,
            z: 1,
            neighbors: ['test-exit'],
        };
        const prompt = computeScenePrompt({
            snapshot: {
                ...snapshot,
                map: [exit, southRoom],
                players: snapshot.players.map((player) =>
                    player.playerId === 'alice-session'
                        ? { ...player, roomId: 'test-exit' }
                        : player
                ),
            },
            localPlayerId: 'alice-session',
            room: exit,
            roamOffset: new Vector3(0, 0, ROOM_SIZE / 2 - ROAM_MARGIN - 0.1),
            forward: new Vector3(0, 0, 1),
        });

        expect(prompt).toMatchObject({
            kind: 'move',
            roomId: 'south-room',
            roomName: 'Hallway',
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

    it('does not show doorway prompts before the expedition starts', () => {
        const snapshot = lobbySnapshot();
        const entrance = room(snapshot, 'entrance');
        const prompt = computeScenePrompt({
            snapshot,
            localPlayerId: 'alice-session',
            room: entrance,
            roamOffset: new Vector3(0, 0, ROOM_SIZE / 2 - ROAM_MARGIN - 0.1),
            forward: new Vector3(0, 0, 1),
        });

        expect(prompt).toBeUndefined();
    });

    it('does not show scene prompts after the hunter has submitted a plan', () => {
        const snapshot = planningSnapshot();
        const entrance = room(snapshot, 'entrance');
        const prompt = computeScenePrompt({
            snapshot: {
                ...snapshot,
                submittedPlayerIds: ['alice-session'],
            },
            localPlayerId: 'alice-session',
            room: entrance,
            roamOffset: new Vector3(0, 0, ROOM_SIZE / 2 - ROAM_MARGIN - 0.1),
            forward: new Vector3(0, 0, 1),
        });

        expect(prompt).toBeUndefined();
    });

    it('treats inspection prompt detail as a meaningful prompt change', () => {
        expect(samePrompt(
            {
                kind: 'search',
                label: 'Search the altar',
                detail: 'Prime a Search plan for this room',
            },
            {
                kind: 'search',
                label: 'Search the altar',
                detail: 'The altar glyphs pulse. Esc or back away to leave inspection.',
                inspecting: true,
            },
        )).toBe(false);
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
