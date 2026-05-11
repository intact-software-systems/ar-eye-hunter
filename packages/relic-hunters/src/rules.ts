import {
    type RelicActionInput,
    type RelicCommand,
    type RelicAnimationCue,
    type RelicEvent,
    type RelicEventType,
    type RelicGameState,
    type RelicPendingAction,
    type RelicPlayer,
    type RelicRoomInvestigationEffect,
    type RelicRoomInvestigation,
    type RelicRoom,
} from './model.ts';
import {
    defaultRelicCharacterId,
    findRelicCharacter,
    type RelicCharacter,
} from './characters.ts';
import { RELIC_PROTOCOL_VERSION } from './protocol.ts';

export type RelicApplyCommandOptions = Readonly<{
    senderId: string;
    now?: () => number;
}>;

export type RelicApplyCommandResult = Readonly<{
    state: RelicGameState;
    resolvedRound: boolean;
}>;

const MAX_PLAYERS = 4;
const STARTING_HEALTH = 3;
const MAX_ROUNDS = 10;

type RelicEventOptions = Readonly<{
    type?: RelicEventType;
    animationCue?: RelicAnimationCue;
    tone?: RelicEvent['tone'];
}>;

export const RELIC_MVP_MAP: readonly RelicRoom[] = [
    room('entrance', 'Entrance', 'entrance', 0, -6, ['hallway', 'storage']),
    room('hallway', 'Hallway', 'hallway', 0, -3, ['entrance', 'shrine', 'trap']),
    room('storage', 'Storage', 'storage', -4, -3, ['entrance', 'trap']),
    room('shrine', 'Shrine', 'shrine', 4, -3, ['hallway', 'treasure']),
    room('trap', 'Trap Room', 'trap', 0, 0, ['hallway', 'storage', 'treasure', 'monster']),
    room('treasure', 'Treasure Chamber', 'treasure', 4, 0, ['shrine', 'trap']),
    room('monster', 'Monster Lair', 'monster', 0, 3, ['trap', 'exit']),
    room('exit', 'Exit', 'exit', 0, 6, ['monster']),
];

export function createRelicGame(
    gameId: string,
    roomId: string,
    now: number = Date.now(),
): RelicGameState {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        gameId,
        roomId,
        phase: 'lobby',
        round: 1,
        maxRounds: MAX_ROUNDS,
        createdAtEpochMs: now,
        updatedAtEpochMs: now,
        adminPlayerId: undefined,
        roundTimeLimitMs: 60_000,
        roundStartedAtEpochMs: undefined,
        map: RELIC_MVP_MAP,
        relics: [
            // Treasure Chamber — three prizes of descending value
            { id: 'golden-idol',   name: 'Golden Idol',      value: 5, roomId: 'treasure' },
            { id: 'jade-dragon',   name: 'Jade Dragon',       value: 3, roomId: 'treasure' },
            { id: 'pearl-netsuke', name: 'Pearl Netsuke',     value: 2, roomId: 'treasure' },
            // Shrine — two sacred artefacts
            { id: 'oracle-stone',  name: 'Oracle Stone',      value: 4, roomId: 'shrine' },
            { id: 'moonstone',     name: 'Moonstone Pendant', value: 3, roomId: 'shrine' },
            // Storage — hidden cache, second piece buried deeper
            { id: 'sun-disk',      name: 'Sun Disk',          value: 6, roomId: 'storage' },
            { id: 'bronze-mirror', name: 'Bronze Mirror',     value: 3, roomId: 'storage' },
            // Monster Lair — great risk, two rewards
            { id: 'cursed-mask',   name: 'Cursed Mask',       value: 8, roomId: 'monster' },
            { id: 'bone-seal',     name: 'Bone Seal',         value: 4, roomId: 'monster' },
            // Trap Room — two relics worth braving the spikes
            { id: 'serpent-crown', name: 'Serpent Crown',     value: 7, roomId: 'trap' },
            { id: 'rusted-tanto',  name: 'Rusted Tantō',      value: 3, roomId: 'trap' },
            // Hallway — scattered find for sharp-eyed hunters
            { id: 'copper-coin',   name: 'Copper Coin',       value: 2, roomId: 'hallway' },
            // Entrance — a small prize for the first brave step
            { id: 'iron-lantern',  name: 'Iron Lantern',      value: 1, roomId: 'entrance' },
        ],
        roomInvestigations: [],
        players: [],
        pendingActions: [],
        events: [
            toEvent(1, 'The expedition is waiting for hunters.', now, {
                type: 'game_waiting',
                tone: 'mystery',
            }),
        ],
        winnerIds: [],
    };
}

function normalizeGameState(state: RelicGameState): RelicGameState {
    const maybeLegacy = state as RelicGameState & {
        roomInvestigations?: readonly RelicRoomInvestigation[];
        roundTimeLimitMs?: number;
    };
    return {
        ...state,
        roomInvestigations: maybeLegacy.roomInvestigations ?? [],
        adminPlayerId: state.adminPlayerId ?? state.players[0]?.playerId,
        roundTimeLimitMs: maybeLegacy.roundTimeLimitMs ?? 60_000,
    };
}

export function applyRelicCommand(
    previous: RelicGameState | undefined,
    command: RelicCommand,
    options: RelicApplyCommandOptions,
): RelicApplyCommandResult {
    const now = options.now?.() ?? Date.now();
    const gameId = command.gameId;
    const state = normalizeGameState(previous ?? createRelicGame(gameId, gameId, now));
    const joined = ensurePlayer(
        state,
        options.senderId,
        command.username,
        now,
        command.kind === 'join-expedition' ? command.characterId : undefined,
    );

    if (command.kind === 'join-expedition') {
        return {
            state: touch(joined.state, now),
            resolvedRound: false,
        };
    }

    if (command.kind === 'start-expedition') {
        const starting = joined.state.phase === 'lobby';
        return {
            state: touch({
                ...joined.state,
                phase: starting ? 'planning' : joined.state.phase,
                roundStartedAtEpochMs: starting ? now : joined.state.roundStartedAtEpochMs,
                events: appendEvent(
                    joined.state,
                    `${joined.player.username} started the expedition.`,
                    now,
                    {
                        type: 'round_started',
                        tone: 'success',
                    },
                ),
            }, now),
            resolvedRound: false,
        };
    }

    if (command.kind === 'set-round-limit') {
        if (joined.state.adminPlayerId && joined.state.adminPlayerId !== options.senderId) {
            throw new Error('Only the administrator can change the round time limit.');
        }
        return {
            state: touch({
                ...joined.state,
                roundTimeLimitMs: command.timeLimitMs,
            }, now),
            resolvedRound: false,
        };
    }

    if (joined.state.phase === 'lobby') {
        throw new Error('The expedition has not started.');
    }

    if (joined.state.phase === 'finished') {
        throw new Error('The expedition is already finished.');
    }

    const active = activePlayers(joined.state);
    if (!active.some((player) => player.playerId === joined.player.playerId)) {
        throw new Error('Escaped or defeated hunters cannot act.');
    }

    validateAction(joined.state, joined.player, command.action);
    const pendingAction: RelicPendingAction = {
        playerId: joined.player.playerId,
        username: joined.player.username,
        action: command.action,
        submittedAtEpochMs: now,
    };
    const pendingActions = [
        ...joined.state.pendingActions.filter((action) =>
            action.playerId !== joined.player.playerId
        ),
        pendingAction,
    ];
    const submittedState = touch({
        ...joined.state,
        pendingActions,
        events: appendEvent(
            joined.state,
            `${joined.player.username} locked in a plan.`,
            now,
            {
                type: 'action_submitted',
                tone: 'mystery',
            },
        ),
    }, now);

    if (pendingActions.length < active.length) {
        return {
            state: submittedState,
            resolvedRound: false,
        };
    }

    return {
        state: resolveRound(submittedState, now),
        resolvedRound: true,
    };
}

export function legalMoveTargets(
    state: Pick<RelicGameState, 'map'>,
    player: RelicPlayer,
): readonly string[] {
    const currentRoom = state.map.find((candidate) => candidate.id === player.roomId);
    return currentRoom?.neighbors.filter((roomId) =>
        !state.map.find((room) => room.id === roomId)?.collapsed
    ) ?? [];
}

function resolveRound(state: RelicGameState, now: number): RelicGameState {
    let next = {
        ...state,
        events: appendEvent(state, `Round ${state.round} actions are revealed.`, now, {
            type: 'action_revealed',
            animationCue: {
                type: 'noise_pulse',
                durationMs: 620,
                intensity: 'low',
            },
            tone: 'mystery',
        }),
    };

    const orderedActions = [...next.pendingActions].sort((left, right) =>
        actionPriority(next, left) - actionPriority(next, right)
    );

    for (const pending of orderedActions) {
        next = resolveAction(next, pending, now);
    }

    const noise = next.pendingActions.reduce(
        (total, pending) => total + noiseForAction(next, pending),
        0,
    );
    next = applyRuinPhase(next, noise, now);
    const nextRound = next.round + 1;
    const finished = nextRound > next.maxRounds || activePlayers(next).length === 0;
    const finishedState = touch({
        ...next,
        round: finished ? next.round : nextRound,
        phase: finished ? 'finished' : 'planning',
        pendingActions: [],
        roundStartedAtEpochMs: finished ? next.roundStartedAtEpochMs : now,
        winnerIds: finished ? calculateWinnerIds(next) : [],
        events: finished
            ? appendEvent(next, 'The expedition is over.', now, {
                type: 'game_finished',
                animationCue: {
                    type: 'heart_relic_victory',
                    durationMs: 2_500,
                    intensity: 'high',
                },
                tone: 'success',
            })
            : appendEvent(next, `Round ${nextRound} begins.`, now, {
                type: 'round_started',
                tone: 'mystery',
            }),
    }, now);

    return finished ? scoreAllPlayers(finishedState, true) : scoreAllPlayers(finishedState);
}

function resolveAction(
    state: RelicGameState,
    pending: RelicPendingAction,
    now: number,
): RelicGameState {
    const player = state.players.find((candidate) => candidate.playerId === pending.playerId);
    if (!player || player.escaped || player.defeated) {
        return state;
    }

    switch (pending.action.kind) {
        case 'move':
            return resolveMove(state, player, pending.action, now);
        case 'search':
            return resolveSearch(state, player, now);
        case 'steal':
            return resolveSteal(state, player, pending.action, now);
        case 'escape':
            return resolveEscape(state, player, now);
    }
}

function resolveMove(
    state: RelicGameState,
    player: RelicPlayer,
    action: RelicActionInput,
    now: number,
): RelicGameState {
    const targetRoomId = action.targetRoomId;
    if (!targetRoomId || !legalMoveTargets(state, player).includes(targetRoomId)) {
        return withEvent(state, `${player.username} failed to find a valid path.`, now, {
            type: 'player_moved',
            tone: 'danger',
        });
    }

    return updatePlayer(
        withEvent(
            state,
            `${player.username} moved to ${roomName(state, targetRoomId)}.`,
            now,
            {
                type: 'player_moved',
                animationCue: {
                    type: 'camera_move',
                    playerId: player.playerId,
                    roomId: targetRoomId,
                    durationMs: 750,
                    intensity: 'medium',
                },
                tone: 'neutral',
            },
        ),
        {
            ...player,
            roomId: targetRoomId,
        },
    );
}

function resolveSearch(
    state: RelicGameState,
    player: RelicPlayer,
    now: number,
): RelicGameState {
    const hasUnfoundRelics = state.relics.some(
        (r) => r.roomId === player.roomId && !r.foundBy,
    );

    // Block further searching only once the room is fully looted
    if (!hasUnfoundRelics && state.roomInvestigations.some((i) => i.roomId === player.roomId)) {
        return withEvent(
            state,
            `${player.username} searched ${roomName(state, player.roomId)} again, but the useful clues were already marked.`,
            now,
            {
                type: 'player_searched',
                animationCue: {
                    type: 'search_altar',
                    playerId: player.playerId,
                    roomId: player.roomId,
                    durationMs: 520,
                    intensity: 'low',
                },
                tone: 'neutral',
            },
        );
    }

    const relic = state.relics.find((candidate) =>
        candidate.roomId === player.roomId && !candidate.foundBy
    );
    if (!relic) {
        return withEvent(
            markRoomInvestigated(state, player, now, 'empty'),
            emptySearchMessage(state, player),
            now,
            {
                type: 'player_searched',
                animationCue: {
                    type: 'search_altar',
                    playerId: player.playerId,
                    roomId: player.roomId,
                    durationMs: 700,
                    intensity: 'low',
                },
                tone: 'mystery',
            },
        );
    }

    const relics = state.relics.map((candidate) =>
        candidate.id === relic.id
            ? { ...candidate, foundBy: player.playerId, carriedBy: player.playerId }
            : candidate
    );
    const stateWithRelic = { ...state, relics };

    // Only seal the room once all its relics have been found
    const moreRemain = relics.some((r) => r.roomId === player.roomId && !r.foundBy);
    const investigatedState = moreRemain
        ? stateWithRelic
        : markRoomInvestigated(stateWithRelic, player, now, 'relic-found', relic.id);

    const message = moreRemain
        ? `${player.username} found the ${relic.name}. The room still hides more…`
        : `${player.username} found the ${relic.name}.`;

    return updatePlayer(
        withEvent(
            investigatedState,
            message,
            now,
            {
                type: 'relic_found',
                animationCue: {
                    type: 'relic_reveal',
                    playerId: player.playerId,
                    roomId: player.roomId,
                    relicId: relic.id,
                    durationMs: 1_200,
                    intensity: 'high',
                },
                tone: 'success',
            },
        ),
        {
            ...player,
            relicIds: [...player.relicIds, relic.id],
        },
    );
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

function markRoomInvestigated(
    state: RelicGameState,
    player: RelicPlayer,
    now: number,
    result: RelicRoomInvestigation['result'],
    relicId?: string,
): RelicGameState {
    const investigation: RelicRoomInvestigation = {
        roomId: player.roomId,
        searchedByPlayerId: player.playerId,
        searchedByUsername: player.username,
        searchedAtRound: state.round,
        searchedAtEpochMs: now,
        result,
        ...roomInvestigationDetails(state, player, result, relicId),
        ...(relicId ? { relicId } : {}),
    };

    return {
        ...state,
        roomInvestigations: [
            ...state.roomInvestigations.filter((candidate) =>
                candidate.roomId !== player.roomId
            ),
            investigation,
        ],
    };
}

function roomInvestigationDetails(
    state: RelicGameState,
    player: RelicPlayer,
    result: RelicRoomInvestigation['result'],
    relicId: string | undefined,
): Readonly<{
    summary: string;
    hint: string;
    effect: RelicRoomInvestigationEffect;
    danger?: string;
    revealedRoomId?: string;
}> {
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
            ...(room?.kind === 'trap' || room?.kind === 'monster'
                ? { danger: 'The find stirred a dangerous room.' }
                : {}),
            ...(revealedRoomId ? { revealedRoomId } : {}),
        };
    }

    switch (room?.kind) {
        case 'storage':
            return {
                summary: 'The crates held a torn supply map, but no relic.',
                hint: 'The supply marks point back toward the Entrance and onward through the Trap Room.',
                effect: 'map-fragment',
                revealedRoomId: revealedRoomId ?? 'trap',
            };
        case 'shrine':
            return {
                summary: 'The altar runes were read and the empty glyph path was marked.',
                hint: 'The shrine points toward treasure, but the party should watch the remaining rounds.',
                effect: 'rune-reading',
                revealedRoomId: revealedRoomId ?? 'treasure',
            };
        case 'trap':
            return {
                summary: 'The safe edges of the pressure plates were marked.',
                hint: 'Move carefully from here; repeated noise can make the room punish the party.',
                effect: 'safe-path',
                danger: 'Pressure plates remain unstable.',
                revealedRoomId: revealedRoomId ?? 'monster',
            };
        case 'treasure':
            return {
                summary: 'The chest and mirror were checked, but the prize trail was cold.',
                hint: 'The mirror scratches point back toward rooms the party may have skipped.',
                effect: 'treasure-trail',
                revealedRoomId,
            };
        case 'monster':
            return {
                summary: 'The chains and ash were searched, revealing only old danger.',
                hint: 'The next useful choice is usually the Exit unless the party needs one last relic.',
                effect: 'monster-trace',
                danger: 'Bones and ash suggest the room can turn costly.',
                revealedRoomId: revealedRoomId ?? 'exit',
            };
        case 'exit':
            return {
                summary: 'The exit runes were read and the way out was marked.',
                hint: 'Prime Escape here to bank carried relics and the escape bonus.',
                effect: 'exit-route',
            };
        default:
            return {
                summary: `${roomName(state, player.roomId)} was searched clear.`,
                hint: 'Move toward a stronger clue or the Exit.',
                effect: 'ordinary-search',
                ...(revealedRoomId ? { revealedRoomId } : {}),
            };
    }
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
    roomId: string,
): string | undefined {
    const room = state.map.find((candidate) => candidate.id === roomId);
    if (!room) {
        return undefined;
    }

    const neighbors = room.neighbors
        .map((neighborId) => state.map.find((candidate) => candidate.id === neighborId))
        .filter((candidate): candidate is RelicRoom => !!candidate && !candidate.collapsed);
    return neighbors.find((neighbor) =>
        state.relics.some((relic) =>
            relic.roomId === neighbor.id &&
            !relic.foundBy &&
            !relic.carriedBy &&
            !relic.escapedBy
        )
    )?.id ?? neighbors[0]?.id;
}

function resolveSteal(
    state: RelicGameState,
    player: RelicPlayer,
    action: RelicActionInput,
    now: number,
): RelicGameState {
    const target = state.players.find((candidate) =>
        candidate.playerId === action.targetPlayerId &&
        candidate.roomId === player.roomId &&
        !candidate.escaped &&
        !candidate.defeated
    );
    const stolenRelicId = target?.relicIds[0];
    if (!target || !stolenRelicId) {
        return withEvent(state, `${player.username} tried to steal but came up empty.`, now, {
            type: 'steal_failed',
            animationCue: {
                type: 'steal_attempt',
                playerId: player.playerId,
                targetPlayerId: action.targetPlayerId,
                roomId: player.roomId,
                durationMs: 650,
                intensity: 'medium',
            },
            tone: 'danger',
        });
    }

    const relics = state.relics.map((relic) =>
        relic.id === stolenRelicId ? { ...relic, carriedBy: player.playerId } : relic
    );

    return withEvent(
        {
            ...state,
            relics,
            players: state.players.map((candidate) => {
                if (candidate.playerId === player.playerId) {
                    return {
                        ...candidate,
                        relicIds: [...candidate.relicIds, stolenRelicId],
                    };
                }
                if (candidate.playerId === target.playerId) {
                    return {
                        ...candidate,
                        relicIds: candidate.relicIds.filter((id) => id !== stolenRelicId),
                    };
                }
                return candidate;
            }),
        },
        `${player.username} stole from ${target.username}.`,
        now,
        {
            type: 'steal_succeeded',
            animationCue: {
                type: 'steal_attempt',
                playerId: player.playerId,
                targetPlayerId: target.playerId,
                roomId: player.roomId,
                relicId: stolenRelicId,
                durationMs: 800,
                intensity: 'high',
            },
            tone: 'success',
        },
    );
}

function resolveEscape(
    state: RelicGameState,
    player: RelicPlayer,
    now: number,
): RelicGameState {
    if (player.roomId !== 'exit') {
        return withEvent(state, `${player.username} tried to escape too early.`, now, {
            type: 'escape_failed',
            tone: 'danger',
        });
    }

    const relics = state.relics.map((relic) =>
        relic.carriedBy === player.playerId
            ? { ...relic, carriedBy: undefined, escapedBy: player.playerId }
            : relic
    );

    return updatePlayer(
        withEvent(
            {
                ...state,
                relics,
            },
            `${player.username} escaped the ruin.`,
            now,
            {
                type: 'player_escaped',
                animationCue: {
                    type: 'escape_run',
                    playerId: player.playerId,
                    roomId: player.roomId,
                    durationMs: 1_400,
                    intensity: 'high',
                },
                tone: 'success',
            },
        ),
        {
            ...player,
            escaped: true,
            relicIds: player.relicIds.filter((relicId) =>
                !relics.some((relic) =>
                    relic.id === relicId && relic.escapedBy === player.playerId
                )
            ),
        },
    );
}

function applyRuinPhase(state: RelicGameState, noise: number, now: number): RelicGameState {
    let next = withEvent(state, `The ruin hears ${noise} noise.`, now, {
        type: 'noise_pulse',
        animationCue: {
            type: 'noise_pulse',
            durationMs: 900,
            intensity: noise >= 5 ? 'high' : noise >= 3 ? 'medium' : 'low',
        },
        tone: noise >= 5 ? 'danger' : 'mystery',
    });
    if (noise >= 5) {
        const target = activePlayers(next).find((player) => player.roomId !== 'entrance');
        if (target) {
            const damaged = {
                ...target,
                health: Math.max(0, target.health - 1),
            };
            next = updatePlayer(
                withEvent(next, `${target.username} is hurt by falling stones.`, now, {
                    type: 'player_damaged',
                    animationCue: {
                        type: 'damage_shake',
                        playerId: target.playerId,
                        roomId: target.roomId,
                        durationMs: 900,
                        intensity: 'high',
                    },
                    tone: 'danger',
                }),
                {
                    ...damaged,
                    defeated: damaged.health <= 0,
                },
            );
        }
    }

    if (state.round >= 5) {
        const candidates = next.map.filter((room) =>
            room.id !== 'entrance' && room.id !== 'exit' && !room.collapsed
        );
        const roomToMark = candidates[state.round % candidates.length];
        if (roomToMark && !roomToMark.unstable) {
            next = {
                ...withEvent(next, `${roomToMark.name} becomes unstable.`, now, {
                    type: 'room_unstable',
                    animationCue: {
                        type: 'noise_pulse',
                        roomId: roomToMark.id,
                        durationMs: 900,
                        intensity: 'medium',
                    },
                    tone: 'danger',
                }),
                map: next.map.map((room) =>
                    room.id === roomToMark.id ? { ...room, unstable: true } : room
                ),
            };
        }
    }

    if (state.round >= 8) {
        const roomToCollapse = next.map.find((room) => room.unstable && !room.collapsed);
        if (roomToCollapse) {
            next = {
                ...withEvent(next, `${roomToCollapse.name} collapses.`, now, {
                    type: 'room_collapsed',
                    animationCue: {
                        type: 'room_collapse',
                        roomId: roomToCollapse.id,
                        durationMs: 1_300,
                        intensity: 'high',
                    },
                    tone: 'danger',
                }),
                map: next.map.map((room) =>
                    room.id === roomToCollapse.id ? { ...room, collapsed: true } : room
                ),
                players: next.players.map((player) =>
                    player.roomId === roomToCollapse.id && !player.escaped
                        ? { ...player, health: 0, defeated: true }
                        : player
                ),
            };
        }
    }

    return next;
}

function ensurePlayer(
    state: RelicGameState,
    playerId: string,
    username: string,
    now: number,
    characterId: RelicPlayer['characterId'] | undefined,
): Readonly<{ state: RelicGameState; player: RelicPlayer }> {
    const existing = state.players.find((player) => player.playerId === playerId);
    if (existing) {
        const nextCharacterId = state.phase === 'lobby' && characterId
            ? characterId
            : existing.characterId;
        const player = existing.username === username && !characterId
            ? existing
            : {
                ...existing,
                username,
                characterId: nextCharacterId,
                health: state.phase === 'lobby' && characterId
                    ? startingHealth(nextCharacterId)
                    : existing.health,
            };
        return {
            state: updatePlayer(state, player),
            player,
        };
    }

    if (state.phase !== 'lobby') {
        throw new Error('Cannot join an expedition after it has started.');
    }

    if (state.players.length >= MAX_PLAYERS) {
        throw new Error('This expedition is full.');
    }

    const nextCharacterId = characterId ?? defaultRelicCharacterId(state.players.length);
    const player: RelicPlayer = {
        playerId,
        username,
        characterId: nextCharacterId,
        roomId: 'entrance',
        health: startingHealth(nextCharacterId),
        escaped: false,
        defeated: false,
        score: 0,
        relicIds: [],
    };

    return {
        state: {
            ...state,
            adminPlayerId: state.adminPlayerId ?? playerId,
            players: [...state.players, player],
            events: appendEvent(state, `${username} joined as ${findRelicCharacter(player.characterId).name}.`, now, {
                type: 'player_joined',
                tone: 'success',
            }),
        },
        player,
    };
}

function validateAction(
    state: RelicGameState,
    player: RelicPlayer,
    action: RelicActionInput,
): void {
    if (action.kind === 'move' && !action.targetRoomId) {
        throw new Error('Move requires a target room.');
    }

    if (
        action.kind === 'move' &&
        action.targetRoomId &&
        !legalMoveTargets(state, player).includes(action.targetRoomId)
    ) {
        throw new Error('Move target is not adjacent.');
    }

    if (action.kind === 'steal' && !action.targetPlayerId) {
        throw new Error('Steal requires a target hunter.');
    }
}

function activePlayers(state: RelicGameState): readonly RelicPlayer[] {
    return state.players.filter((player) => !player.escaped && !player.defeated);
}

function actionPriority(state: RelicGameState, pending: RelicPendingAction): number {
    const character = characterForPending(state, pending);
    const action = pending.action;
    switch (action.kind) {
        case 'move':
            return 1 - (character?.priorityBonusByAction?.move ?? 0);
        case 'steal':
            return 2 - (character?.priorityBonusByAction?.steal ?? 0);
        case 'search':
            return 3 - (character?.priorityBonusByAction?.search ?? 0);
        case 'escape':
            return 4 - (character?.priorityBonusByAction?.escape ?? 0);
    }
}

function noiseForAction(state: RelicGameState, pending: RelicPendingAction): number {
    const character = characterForPending(state, pending);
    const action = pending.action;
    const reduction = character?.noiseReductionByAction?.[action.kind] ?? 0;

    return Math.max(0, baseNoiseForAction(action) - reduction);
}

function characterForPending(
    state: RelicGameState,
    pending: RelicPendingAction,
): RelicCharacter | undefined {
    const player = state.players.find((candidate) => candidate.playerId === pending.playerId);
    return player ? findRelicCharacter(player.characterId) : undefined;
}

function characterRelicBonus(
    state: RelicGameState,
    player: RelicPlayer,
): number {
    const relicBonus = findRelicCharacter(player.characterId).relicValueBonus ?? 0;
    if (relicBonus <= 0) {
        return 0;
    }

    const heldOrEscapedRelics = [
        ...player.relicIds,
        ...state.relics
            .filter((relic) => relic.escapedBy === player.playerId)
            .map((relic) => relic.id),
    ];

    return new Set(heldOrEscapedRelics).size * relicBonus;
}

function escapeBonusForPlayer(player: RelicPlayer): number {
    return 5 + (findRelicCharacter(player.characterId).escapeBonus ?? 0);
}

function startingHealth(characterId: RelicPlayer['characterId']): number {
    return STARTING_HEALTH + (findRelicCharacter(characterId).healthBonus ?? 0);
}

function baseNoiseForAction(action: RelicActionInput): number {
    switch (action.kind) {
        case 'escape':
            return 0;
        case 'move':
            return 1;
        case 'search':
            return 2;
        case 'steal':
            return 3;
    }
}

function scoreAllPlayers(state: RelicGameState, applyEndPenalty = false): RelicGameState {
    const players = state.players.map((player) => {
        const carriedScore = player.relicIds.reduce(
            (total, relicId) =>
                total + (state.relics.find((relic) => relic.id === relicId)?.value ?? 0),
            0,
        );
        const escapedScore = state.relics
            .filter((relic) => relic.escapedBy === player.playerId)
            .reduce((total, relic) => total + relic.value, 0);
        const escapeBonus = player.escaped ? escapeBonusForPlayer(player) : 0;
        const skillBonus = characterRelicBonus(state, player);
        const penalty = applyEndPenalty && !player.escaped ? -5 : 0;

        return {
            ...player,
            score: carriedScore + escapedScore + skillBonus + escapeBonus + penalty,
        };
    });

    return {
        ...state,
        players,
        winnerIds: state.phase === 'finished' ? calculateWinnerIds({ ...state, players }) : [],
    };
}

function calculateWinnerIds(state: Pick<RelicGameState, 'players'>): readonly string[] {
    const best = Math.max(...state.players.map((player) => player.score), -Infinity);
    return state.players
        .filter((player) => player.score === best)
        .map((player) => player.playerId);
}

function updatePlayer(state: RelicGameState, player: RelicPlayer): RelicGameState {
    return {
        ...state,
        players: state.players.map((candidate) =>
            candidate.playerId === player.playerId ? player : candidate
        ),
    };
}

function withEvent(
    state: RelicGameState,
    message: string,
    now: number,
    options?: RelicEventOptions,
): RelicGameState {
    return {
        ...state,
        events: appendEvent(state, message, now, options),
    };
}

function appendEvent(
    state: Pick<RelicGameState, 'events' | 'round'>,
    message: string,
    now: number,
    options?: RelicEventOptions,
): readonly RelicEvent[] {
    return [
        ...state.events,
        toEvent(state.round, message, now, options),
    ].slice(-64);
}

function toEvent(
    round: number,
    message: string,
    now: number,
    options?: RelicEventOptions,
): RelicEvent {
    return {
        id: `${round}:${now}:${toEventHash(message)}`,
        round,
        type: options?.type ?? 'round_started',
        message,
        animationCue: options?.animationCue,
        tone: options?.tone ?? 'neutral',
        createdAtEpochMs: now,
    };
}

function touch(state: RelicGameState, now: number): RelicGameState {
    return scoreAllPlayers({
        ...state,
        updatedAtEpochMs: now,
    });
}

function room(
    id: string,
    name: string,
    kind: RelicRoom['kind'],
    x: number,
    z: number,
    neighbors: readonly string[],
): RelicRoom {
    return {
        id,
        name,
        kind,
        x,
        z,
        neighbors,
    };
}

function roomName(state: RelicGameState, roomId: string): string {
    return state.map.find((room) => room.id === roomId)?.name ?? roomId;
}

function toEventHash(message: string): string {
    let hash = 0;
    for (const char of message) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }

    return hash.toString(36);
}
