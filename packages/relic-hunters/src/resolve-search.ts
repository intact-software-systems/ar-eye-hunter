import {
    type RelicGameState,
    type RelicPlayer,
    type RelicRoom,
    type RelicRoomInvestigation,
    type RelicRoomInvestigationEffect
} from './model.ts';
import { withRelicEvent } from './to-relic-event.ts';
interface RelicRoomInvestigationQuery {
    readonly state: RelicGameState;
    readonly player: RelicPlayer;
    readonly result: RelicRoomInvestigation['result'];
    readonly relicId?: string;
}

interface RelicRoomInvestigationInput extends RelicRoomInvestigationQuery {
    readonly now: number;
}

interface RelicInvestigationDetails {
    readonly summary: string;
    readonly hint: string;
    readonly effect: RelicRoomInvestigationEffect;
    readonly danger: string | undefined;
    readonly revealedRoomId: string | undefined;
}

interface RelicSearchCollection {
    readonly state: RelicGameState;
    readonly player: RelicPlayer;
    readonly now: number;
    readonly relic: RelicGameState['relics'][number];
}

const EMPTY_ROOM_CLUES: Partial<Record<RelicRoom['kind'], RelicInvestigationDetails>> = {
    storage: {
        summary: 'The crates held a torn supply map, but no relic.',
        hint: 'The supply marks point back toward the Entrance and onward through the Trap Room.',
        effect: 'map-fragment',
        danger: undefined,
        revealedRoomId: 'trap'
    },
    shrine: {
        summary: 'The altar runes were read and the empty glyph path was marked.',
        hint: 'The shrine points toward treasure, but the party should watch the remaining rounds.',
        effect: 'rune-reading',
        danger: undefined,
        revealedRoomId: 'treasure'
    },
    trap: {
        summary: 'The safe edges of the pressure plates were marked.',
        hint: 'Move carefully from here; repeated noise can make the room punish the party.',
        effect: 'safe-path',
        danger: 'Pressure plates remain unstable.',
        revealedRoomId: 'monster'
    },
    treasure: {
        summary: 'The chest and mirror were checked, but the prize trail was cold.',
        hint: 'The mirror scratches point back toward rooms the party may have skipped.',
        effect: 'treasure-trail',
        danger: undefined,
        revealedRoomId: undefined
    },
    monster: {
        summary: 'The chains and ash were searched, revealing only old danger.',
        hint: 'The next useful choice is usually the Exit unless the party needs one last relic.',
        effect: 'monster-trace',
        danger: 'Bones and ash suggest the room can turn costly.',
        revealedRoomId: 'exit'
    },
    exit: {
        summary: 'The exit runes were read and the way out was marked.',
        hint: 'Prime Escape here to bank carried relics and the escape bonus.',
        effect: 'exit-route',
        danger: undefined,
        revealedRoomId: undefined
    }
};

export function resolveSearch(
    state: RelicGameState,
    player: RelicPlayer,
    now: number
): RelicGameState {
    const hasUnfoundRelics = state.relics.some(
        (r) => r.roomId === player.roomId && !r.foundBy
    );

    // Block further searching only once the room is fully looted
    if (!hasUnfoundRelics && state.roomInvestigations.some((i) => i.roomId === player.roomId)) {
        return withRelicEvent(
            {
                state,
                message: `${player.username} searched ${(state.map.find((room) =>
                    room.id === player.roomId
                )?.name ?? player.roomId)} again, but the useful clues were already marked.`,
                now,
                options: {
                    type: 'player_searched',
                    animationCue: {
                        type: 'search_altar',
                        playerId: player.playerId,
                        roomId: player.roomId,
                        durationMs: 520,
                        intensity: 'low'
                    },
                    tone: 'neutral'
                }
            }
        );
    }

    const relic = state.relics.find((candidate) => candidate.roomId === player.roomId && !candidate.foundBy);
    if (!relic) {
        return withRelicEvent(
            {
                state: markRoomInvestigated({ state, player, now, result: 'empty' }),
                message: emptySearchMessage(state, player),
                now,
                options: {
                    type: 'player_searched',
                    animationCue: {
                        type: 'search_altar',
                        playerId: player.playerId,
                        roomId: player.roomId,
                        durationMs: 700,
                        intensity: 'low'
                    },
                    tone: 'mystery'
                }
            }
        );
    }

    return collectSearchedRelic({ state, player, now, relic });
}

function collectSearchedRelic({ state, player, now, relic }: RelicSearchCollection): RelicGameState {
    const relics = state.relics.map((candidate) =>
        candidate.id === relic.id
            ? { ...candidate, foundBy: player.playerId, carriedBy: player.playerId }
            : candidate
    );
    const stateWithRelic = { ...state, relics };

    const moreRemain = relics.some((r) => r.roomId === player.roomId && !r.foundBy);
    const investigatedState = markRoomInvestigated({
        state: stateWithRelic,
        player,
        now,
        result: 'relic-found',
        relicId: relic.id
    });

    const message = moreRemain
        ? `${player.username} found the ${relic.name}. The room still hides more…`
        : `${player.username} found the ${relic.name}.`;

    return {
        ...withRelicEvent(
            {
                state: investigatedState,
                message,
                now,
                options: {
                    type: 'relic_found',
                    animationCue: {
                        type: 'relic_reveal',
                        playerId: player.playerId,
                        roomId: player.roomId,
                        relicId: relic.id,
                        durationMs: 1_200,
                        intensity: 'high'
                    },
                    tone: 'success'
                }
            }
        ),
        players: investigatedState.players.map((candidate) =>
            candidate.playerId === player.playerId
                ? {
                    ...player,
                    relicIds: [...player.relicIds, relic.id]
                }
                : candidate
        )
    };
}

function emptySearchMessage(state: RelicGameState, player: RelicPlayer): string {
    const room = state.map.find((candidate) => candidate.id === player.roomId);
    switch (room?.kind) {
        case 'storage':
            return `${player.username} searched the crates and marked a false supply trail.`;
        case 'shrine':
            return `${player.username} read the altar runes and marked the empty glyph path.`;
        case 'trap':
            return `${player.username} studied the pressure plates and marked the safe edges.`;
        case 'treasure':
            return `${player.username} checked the chest and mirror, but the prize was gone.`;
        case 'monster':
            return `${player.username} searched the chains and ash, finding only old danger.`;
        case 'exit':
            return `${player.username} read the exit runes and marked the way out.`;
        default:
            return `${player.username} searched but found nothing.`;
    }
}

function markRoomInvestigated({ state, player, now, result, relicId }: RelicRoomInvestigationInput): RelicGameState {
    const investigation: RelicRoomInvestigation = {
        roomId: player.roomId,
        searchedByPlayerId: player.playerId,
        searchedByUsername: player.username,
        searchedAtRound: state.round,
        searchedAtEpochMs: now,
        result,
        ...roomInvestigationDetails({ state, player, result, relicId }),
        ...(relicId ? { relicId } : {})
    };

    return {
        ...state,
        roomInvestigations: [
            ...state.roomInvestigations.filter((candidate) => candidate.roomId !== player.roomId),
            investigation
        ]
    };
}

function roomInvestigationDetails(
    { state, player, result, relicId }: RelicRoomInvestigationQuery
): RelicInvestigationDetails {
    const room = state.map.find((candidate) => candidate.id === player.roomId);
    const relic = relicId ? state.relics.find((candidate) => candidate.id === relicId) : undefined;
    const revealedRoomId = revealedRoomForInvestigation(state, player.roomId);

    if (result === 'relic-found' && relic) {
        return {
            summary: `${relic.name} was recovered here.`,
            hint: room?.kind === 'exit'
                ? 'The exit route is still the safest way to bank the score.'
                : 'Carry the relic toward the Exit before the castle closes.',
            effect: investigationEffect(room),
            danger: room?.kind === 'trap' || room?.kind === 'monster'
                ? 'The find stirred a dangerous room.'
                : undefined,
            revealedRoomId
        };
    }

    const clue = room && EMPTY_ROOM_CLUES[room.kind];
    return clue
        ? { ...clue, revealedRoomId: room?.kind === 'exit' ? undefined : revealedRoomId ?? clue.revealedRoomId }
        : {
            summary:
                `${(state.map.find((room) => room.id === player.roomId)?.name ?? player.roomId)} was searched clear.`,
            hint: 'Move toward a stronger clue or the Exit.',
            effect: 'ordinary-search',
            danger: undefined,
            revealedRoomId
        };
}

function investigationEffect(room: RelicRoom | undefined): RelicRoomInvestigationEffect {
    switch (room?.kind) {
        case 'storage':
            return 'map-fragment';
        case 'shrine':
            return 'rune-reading';
        case 'trap':
            return 'safe-path';
        case 'treasure':
            return 'treasure-trail';
        case 'monster':
            return 'monster-trace';
        case 'exit':
            return 'exit-route';
        default:
            return 'ordinary-search';
    }
}

function revealedRoomForInvestigation(
    state: RelicGameState,
    roomId: string
): string | undefined {
    const room = state.map.find((candidate) => candidate.id === roomId);
    if (!room) {
        return undefined;
    }

    const neighbors = room.neighbors
        .map((neighborId) => state.map.find((candidate) => candidate.id === neighborId))
        .filter((candidate): candidate is RelicRoom => !!candidate && !candidate.collapsed);
    return highestValueRelicNeighbor(state, neighbors)?.id ?? neighbors[0]?.id;
}

function highestValueRelicNeighbor(
    state: RelicGameState,
    neighbors: readonly RelicRoom[]
): RelicRoom | undefined {
    return neighbors
        .map((neighbor) => ({
            neighbor,
            value: highestUnfoundRelicValue(state, neighbor.id)
        }))
        .filter((candidate) => candidate.value > 0)
        .sort((left, right) => right.value - left.value)[0]?.neighbor;
}

function highestUnfoundRelicValue(
    state: RelicGameState,
    roomId: string
): number {
    return Math.max(
        0,
        ...state.relics
            .filter((relic) =>
                relic.roomId === roomId &&
                !relic.foundBy &&
                !relic.carriedBy &&
                !relic.escapedBy
            )
            .map((relic) => relic.value)
    );
}
