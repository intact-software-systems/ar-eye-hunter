import { describe, expect, it } from 'vitest';
import {
    RELIC_PROTOCOL_VERSION,
    applyRelicCommand,
    createRelicGame,
    toPublicRelicSnapshot,
    type RelicGameState,
    type RelicPublicSnapshot,
} from '@relic-hunters/mod.ts';
import {
    deriveSceneObjective,
    roomHasResolvedClue,
    shortestOpenRoomPath,
} from '../../../apps/relic-hunters-v1/src/game/scene/objectives.ts';

describe('Relic scene objective derivation', () => {
    it('recommends movement when the current room has no strong clue', () => {
        const snapshot = planningSnapshot();

        const objective = deriveSceneObjective({
            snapshot,
            localPlayerId: 'alice-session',
        });

        expect(objective).toMatchObject({
            eyebrow: 'Entrance',
            title: 'Move to Hallway',
            recommendedAction: {
                kind: 'move',
                targetRoomId: 'hallway',
            },
        });
    });

    it('recommends searching a room with an unresolved relic clue', () => {
        const snapshot = withPlayerRoom(planningSnapshot(), 'storage');

        const objective = deriveSceneObjective({
            snapshot,
            localPlayerId: 'alice-session',
        });

        expect(objective).toMatchObject({
            eyebrow: 'Storage',
            title: 'Search the crates',
            recommendedAction: { kind: 'search' },
            clueHotspotId: 'storage-crates',
        });
    });

    it('recommends escape when the hunter reaches the exit', () => {
        const snapshot = withPlayerRoom(planningSnapshot(), 'exit');

        const objective = deriveSceneObjective({
            snapshot,
            localPlayerId: 'alice-session',
        });

        expect(objective).toMatchObject({
            eyebrow: 'Exit',
            title: 'Escape is available',
            recommendedAction: { kind: 'escape' },
            tone: 'success',
        });
    });

    it('shows the primed action as the next objective until the plan is submitted', () => {
        const snapshot = planningSnapshot();

        const objective = deriveSceneObjective({
            snapshot,
            localPlayerId: 'alice-session',
            primedAction: {
                kind: 'move',
                targetRoomId: 'hallway',
            },
        });

        expect(objective).toMatchObject({
            title: 'Move to Hallway',
            detail: 'Submit the plan to commit this turn-based move.',
            targetRoomId: 'hallway',
        });
    });

    it('marks the objective as locked after the hunter submits a plan', () => {
        const snapshot = {
            ...planningSnapshot(),
            submittedPlayerIds: ['alice-session'],
        };

        const objective = deriveSceneObjective({
            snapshot,
            localPlayerId: 'alice-session',
            primedAction: { kind: 'search' },
        });

        expect(objective).toMatchObject({
            title: 'Plan locked',
            tone: 'success',
        });
        expect(objective.recommendedAction).toBeUndefined();
    });

    it('routes toward the revealed room after a room has been searched', () => {
        const snapshot = withPlayerRoom({
            ...planningSnapshot(),
            roomInvestigations: [
                {
                    roomId: 'storage',
                    searchedByPlayerId: 'alice-session',
                    searchedByUsername: 'Alice',
                    searchedAtRound: 1,
                    searchedAtEpochMs: 4,
                    result: 'empty',
                    summary: 'The crates held a torn supply map, but no relic.',
                    hint: 'The supply marks point back toward the Entrance and onward through the Trap Room.',
                    effect: 'map-fragment',
                    revealedRoomId: 'trap',
                },
            ],
        }, 'storage');

        const objective = deriveSceneObjective({
            snapshot,
            localPlayerId: 'alice-session',
        });

        expect(objective).toMatchObject({
            title: 'Follow the map fragment toward Trap Room',
            detail: 'Next step: Move to Trap Room. The supply marks point back toward the Entrance and onward through the Trap Room.',
            targetRoomId: 'trap',
            revealedRoomId: 'trap',
            routeTargetRoomId: 'trap',
            recommendedAction: {
                kind: 'move',
                targetRoomId: 'trap',
            },
            investigationSummary: 'The crates held a torn supply map, but no relic.',
            investigationHint: 'The supply marks point back toward the Entrance and onward through the Trap Room.',
            investigated: true,
        });
    });

    it('falls back when the revealed room is collapsed', () => {
        const snapshot = withPlayerRoom({
            ...planningSnapshot(),
            map: planningSnapshot().map.map((room) =>
                room.id === 'trap' ? { ...room, collapsed: true } : room
            ),
            roomInvestigations: [
                {
                    roomId: 'hallway',
                    searchedByPlayerId: 'alice-session',
                    searchedByUsername: 'Alice',
                    searchedAtRound: 1,
                    searchedAtEpochMs: 4,
                    result: 'empty',
                    summary: 'Hallway was searched clear.',
                    hint: 'The marked route no longer looks safe.',
                    effect: 'ordinary-search',
                    revealedRoomId: 'trap',
                },
            ],
        }, 'hallway');

        const objective = deriveSceneObjective({
            snapshot,
            localPlayerId: 'alice-session',
        });

        expect(objective).toMatchObject({
            title: 'Move to Shrine',
            targetRoomId: 'shrine',
            routeTargetRoomId: 'shrine',
        });
    });

    it('finds shortest open room paths and avoids collapsed rooms', () => {
        const snapshot = planningSnapshot();
        const collapsedTrap = snapshot.map.map((room) =>
            room.id === 'trap' ? { ...room, collapsed: true } : room
        );

        expect(shortestOpenRoomPath(snapshot.map, 'storage', 'monster')).toEqual([
            'storage',
            'trap',
            'monster',
        ]);
        expect(shortestOpenRoomPath(collapsedTrap, 'storage', 'monster')).toBeUndefined();
    });

    it('detects resolved room clues from durable investigation and relic state', () => {
        const snapshot = planningSnapshot();
        const foundRelicSnapshot = {
            ...snapshot,
            relics: [
                {
                    id: 'sun-disk',
                    name: 'Sun Disk',
                    value: 6,
                    roomId: 'storage',
                    foundBy: 'alice-session',
                    carriedBy: 'alice-session',
                },
                ...snapshot.relics.slice(1),
            ],
        };
        const investigatedSnapshot = {
            ...snapshot,
            roomInvestigations: [
                ...snapshot.roomInvestigations,
                {
                    roomId: 'trap',
                    searchedByPlayerId: 'alice-session',
                    searchedByUsername: 'Alice',
                    searchedAtRound: snapshot.round,
                    searchedAtEpochMs: 4,
                    result: 'empty' as const,
                    summary: 'The safe edges of the pressure plates were marked.',
                    hint: 'Move carefully from here; repeated noise can make the room punish the party.',
                    effect: 'safe-path' as const,
                    danger: 'Pressure plates remain unstable.',
                },
            ],
        };

        expect(roomHasResolvedClue(foundRelicSnapshot, 'storage')).toBe(true);
        expect(roomHasResolvedClue(investigatedSnapshot, 'trap')).toBe(true);
        expect(roomHasResolvedClue(snapshot, 'monster')).toBe(false);
    });
});

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

function withPlayerRoom(
    snapshot: RelicPublicSnapshot,
    roomId: string,
): RelicPublicSnapshot {
    return {
        ...snapshot,
        players: snapshot.players.map((player) =>
            player.playerId === 'alice-session'
                ? { ...player, roomId }
                : player
        ),
    };
}
