import { Either } from '@shared/resilience/Either.ts';

import {
    defaultRelicCharacterId,
    findRelicCharacter,
    type RelicCharacter
} from './characters.ts';
import {
    relicsFromRelicExpeditionBlueprint,
    roomsFromRelicExpeditionBlueprint,
    validateRelicExpeditionBlueprint,
    type RelicExpeditionBlueprint
} from './expedition-blueprint.ts';
import {
    type RelicActionInput,
    type RelicAnimationCue,
    type RelicCommand,
    type RelicEvent,
    type RelicEventType,
    type RelicExpeditionSetupMetadata,
    type RelicGameState,
    type RelicPendingAction,
    type RelicPlayer,
    type RelicRoom,
    type RelicRoomInvestigation,
    type RelicRoomInvestigationEffect
} from './model.ts';
import { RELIC_PROTOCOL_VERSION } from './protocol.ts';

export interface RelicCommandEvaluation {
    readonly senderId: string;
    readonly now: number;
}

export interface RelicRuleRefusal {
    readonly code: string;
    readonly message: string;
}

export interface RelicApplyCommandResult {
    readonly state: RelicGameState;
    readonly resolvedRound: boolean;
}

export interface CreateRelicGameFromBlueprintInput {
    readonly gameId: string;
    readonly roomId: string;
    readonly blueprint: RelicExpeditionBlueprint;
    readonly now: number;
    readonly setup?: Partial<RelicExpeditionSetupMetadata>;
}

interface RelicGameCreation {
    readonly gameId: string;
    readonly roomId: string;
    readonly now: number;
    readonly map: readonly RelicRoom[];
    readonly relics: readonly RelicGameState['relics'][number][];
    readonly setup: RelicExpeditionSetupMetadata;
}

interface RelicActionResolution {
    readonly state: RelicGameState;
    readonly player: RelicPlayer;
    readonly action: RelicActionInput;
    readonly now: number;
}

interface RelicPickup {
    readonly state: RelicGameState;
    readonly player: RelicPlayer;
    readonly relicId: string;
    readonly now: number;
}

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

interface RelicPlayerAdmission {
    readonly state: RelicGameState;
    readonly playerId: string;
    readonly username: string;
    readonly now: number;
    readonly characterId: RelicPlayer['characterId'] | undefined;
}

interface RelicPlayerAdmissionResult {
    readonly state: RelicGameState;
    readonly player: RelicPlayer;
}

interface RelicEventInput {
    readonly round: number;
    readonly message: string;
    readonly now: number;
    readonly options?: RelicEventOptions;
}

interface RelicEventAppend {
    readonly state: Pick<RelicGameState, 'events' | 'round'>;
    readonly message: string;
    readonly now: number;
    readonly options?: RelicEventOptions;
}

interface RelicStateEvent extends RelicEventAppend {
    readonly state: RelicGameState;
}

interface RelicEventOptions {
    readonly type?: RelicEventType;
    readonly animationCue?: RelicAnimationCue;
    readonly tone?: RelicEvent['tone'];
}

interface RelicRoundCommandInput {
    readonly state: RelicGameState;
    readonly player: RelicPlayer;
    readonly command: Extract<RelicCommand, {
        kind: 'continue-review' | 'force-resolve-round' | 'pickup-relic' | 'submit-action';
    }>;
    readonly now: number;
}

interface RelicActionSubmission extends RelicRoundCommandInput {
    readonly command: Extract<RelicCommand, { kind: 'submit-action'; }>;
}

interface RelicSearchCollection {
    readonly state: RelicGameState;
    readonly player: RelicPlayer;
    readonly now: number;
    readonly relic: RelicGameState['relics'][number];
}

interface RelicTransfer {
    readonly state: RelicGameState;
    readonly player: RelicPlayer;
    readonly target: RelicPlayer;
    readonly stolenRelicId: string;
}

interface RelicJoinedPlayerRefresh {
    readonly state: RelicGameState;
    readonly existing: RelicPlayer;
    readonly username: string;
    readonly characterId: RelicPlayer['characterId'] | undefined;
}

const MAX_PLAYERS = 4;
const STARTING_HEALTH = 3;
const MAX_ROUNDS = 10;

export const RELIC_MVP_MAP: readonly RelicRoom[] = [
    { id: 'entrance', name: 'Entrance', kind: 'entrance', x: 0, z: -6, neighbors: ['hallway', 'storage'] },
    { id: 'hallway', name: 'Hallway', kind: 'hallway', x: 0, z: -3, neighbors: ['entrance', 'shrine', 'trap'] },
    { id: 'storage', name: 'Storage', kind: 'storage', x: -4, z: -3, neighbors: ['entrance', 'trap'] },
    { id: 'shrine', name: 'Shrine', kind: 'shrine', x: 4, z: -3, neighbors: ['hallway', 'treasure'] },
    {
        id: 'trap',
        name: 'Trap Room',
        kind: 'trap',
        x: 0,
        z: 0,
        neighbors: ['hallway', 'storage', 'treasure', 'monster']
    },
    { id: 'treasure', name: 'Treasure Chamber', kind: 'treasure', x: 4, z: 0, neighbors: ['shrine', 'trap'] },
    { id: 'monster', name: 'Monster Lair', kind: 'monster', x: 0, z: 3, neighbors: ['trap', 'exit'] },
    { id: 'exit', name: 'Exit', kind: 'exit', x: 0, z: 6, neighbors: ['monster'] }
];

export const RELIC_MVP_RELICS = [
    // Entrance and Exit — visible neon freebies so every room has something worth touching.
    { id: 'visitor-badge', name: 'Visitor Badge of Questionable Consent', value: 1, roomId: 'entrance' },
    { id: 'gift-shop-receipt', name: 'Gift Shop Exit Receipt', value: 2, roomId: 'exit' },
    // Treasure Chamber — three prizes of descending value
    { id: 'golden-idol', name: 'Golden Idol', value: 5, roomId: 'treasure' },
    { id: 'jade-dragon', name: 'Jade Dragon', value: 3, roomId: 'treasure' },
    { id: 'pearl-netsuke', name: 'Pearl Netsuke', value: 2, roomId: 'treasure' },
    // Shrine — two sacred artefacts
    { id: 'oracle-stone', name: 'Oracle Stone', value: 4, roomId: 'shrine' },
    { id: 'moonstone', name: 'Moonstone Pendant', value: 3, roomId: 'shrine' },
    // Storage — hidden cache, second piece buried deeper
    { id: 'sun-disk', name: 'Sun Disk', value: 6, roomId: 'storage' },
    { id: 'bronze-mirror', name: 'Bronze Mirror', value: 3, roomId: 'storage' },
    // Monster Lair — great risk, two rewards
    { id: 'cursed-mask', name: 'Cursed Mask', value: 8, roomId: 'monster' },
    { id: 'bone-seal', name: 'Bone Seal', value: 4, roomId: 'monster' },
    // Trap Room — two relics worth braving the spikes
    { id: 'serpent-crown', name: 'Serpent Crown', value: 7, roomId: 'trap' },
    { id: 'rusted-tanto', name: 'Rusted Tantō', value: 3, roomId: 'trap' },
    // Hallway — scattered find for sharp-eyed hunters
    { id: 'copper-coin', name: 'Copper Coin', value: 2, roomId: 'hallway' }
] as const;

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

export function createRelicGame(
    gameId: string,
    roomId: string,
    now: number
): RelicGameState {
    return createRelicGameState({
        gameId,
        roomId,
        now,
        map: RELIC_MVP_MAP,
        relics: RELIC_MVP_RELICS,
        setup: {
            schemaVersion: 1,
            source: 'default',
            seed: 'relic-static-v1',
            theme: 'Castle of Yamashiro',
            blueprintId: 'relic-static-v1'
        }
    });
}

export function createRelicGameFromBlueprint(
    { gameId, roomId, blueprint, now, setup }: CreateRelicGameFromBlueprintInput
): Either<RelicRuleRefusal, RelicGameState> {
    const validation = validateRelicExpeditionBlueprint(blueprint);
    if (!validation.ok) {
        return Either.ofLeft({
            code: 'invalid-expedition-blueprint',
            message: `Invalid Relic expedition blueprint: ${validation.errors.join('; ')}`
        });
    }
    return Either.ofRight(createRelicGameState({
        gameId,
        roomId,
        now,
        map: roomsFromRelicExpeditionBlueprint(blueprint),
        relics: relicsFromRelicExpeditionBlueprint(blueprint),
        setup: {
            schemaVersion: 1,
            source: setup?.source ?? blueprint.source ?? 'procedural',
            seed: setup?.seed ?? blueprint.seed,
            theme: setup?.theme ?? blueprint.theme,
            blueprintId: setup?.blueprintId
        }
    }));
}

function createRelicGameState({
    gameId,
    roomId,
    now,
    map,
    relics,
    setup
}: RelicGameCreation): RelicGameState {
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
        map,
        relics,
        roomInvestigations: [],
        players: [],
        pendingActions: [],
        events: [
            toEvent({
                round: 1,
                message: 'The expedition is waiting for hunters.',
                now,
                options: {
                    type: 'game_waiting',
                    tone: 'mystery'
                }
            })
        ],
        winnerIds: [],
        setup
    };
}

export function applyRelicCommand(
    previous: RelicGameState | undefined,
    command: RelicCommand,
    evaluation: RelicCommandEvaluation
): Either<RelicRuleRefusal, RelicApplyCommandResult> {
    const now = evaluation.now;
    const state = previous ?? createRelicGame(command.gameId, command.gameId, now);
    const existing = state.players.find((player) => player.playerId === evaluation.senderId);
    if (command.kind !== 'join-expedition' && !existing) {
        return Either.ofLeft({
            code: 'participant-required',
            message: 'Join the expedition before sending game commands.'
        });
    }
    const admissionIssues = validatePlayerAdmission(state, evaluation.senderId);
    if (admissionIssues.length > 0) {
        return Either.ofLeft(admissionIssues[0]);
    }
    const joined = command.kind !== 'join-expedition' && existing ? { state, player: existing } : ensurePlayer({
        state,
        playerId: evaluation.senderId,
        username: command.username,
        now,
        characterId: command.kind === 'join-expedition' ? command.characterId : undefined
    });
    const issues = validateRelicCommand(joined, command, now);
    if (issues.length > 0) {
        return Either.ofLeft(issues[0]);
    }
    switch (command.kind) {
        case 'join-expedition':
            return Either.ofRight({ state: touch(joined.state, now), resolvedRound: false });
        case 'start-expedition':
            return Either.ofRight({ state: startExpedition(joined.state, joined.player, now), resolvedRound: false });
        case 'set-round-limit':
            return Either.ofRight({
                state: touch({ ...joined.state, roundTimeLimitMs: command.timeLimitMs }, now),
                resolvedRound: false
            });
        default:
            return Either.ofRight(applyRoundCommand({ state: joined.state, player: joined.player, command, now }));
    }
}

function validatePlayerAdmission(state: RelicGameState, playerId: string): readonly RelicRuleRefusal[] {
    if (state.players.some((player) => player.playerId === playerId)) {
        return [];
    }
    const issues: RelicRuleRefusal[] = [];
    if (state.phase !== 'lobby') {
        issues.push({ code: 'expedition-started', message: 'Cannot join an expedition after it has started.' });
    }
    if (state.players.length >= MAX_PLAYERS) {
        issues.push({ code: 'expedition-full', message: 'This expedition is full.' });
    }
    return issues;
}

function validateRelicCommand(
    { state, player }: RelicPlayerAdmissionResult,
    command: RelicCommand,
    now: number
): readonly RelicRuleRefusal[] {
    const isAdmin = state.adminPlayerId === player.playerId;
    switch (command.kind) {
        case 'join-expedition':
            return [];
        case 'start-expedition':
            return isAdmin
                ? []
                : [{ code: 'administrator-required', message: 'Only the administrator can start the expedition.' }];
        case 'set-round-limit':
            return isAdmin
                ? []
                : [{
                    code: 'administrator-required',
                    message: 'Only the administrator can change the round time limit.'
                }];
        default:
            return validateRoundCommand({ state, player, command, now });
    }
}

function validateRoundCommand({ state, player, command, now }: RelicRoundCommandInput): readonly RelicRuleRefusal[] {
    const issues: RelicRuleRefusal[] = [];
    if (state.phase === 'lobby') {
        issues.push({ code: 'expedition-not-started', message: 'The expedition has not started.' });
    }
    if (state.phase === 'finished') {
        issues.push({ code: 'expedition-finished', message: 'The expedition is already finished.' });
    }
    if (command.kind === 'continue-review') {
        if (state.phase !== 'review') {
            issues.push({ code: 'review-unavailable', message: 'There is no review to continue.' });
        }
        if (state.adminPlayerId !== player.playerId) {
            issues.push({ code: 'administrator-required', message: 'Only the administrator can continue the review.' });
        }
        return issues;
    }
    if (state.phase === 'review') {
        issues.push({ code: 'review-required', message: 'Review the revealed actions before planning the next turn.' });
    }
    if (player.escaped || player.defeated) {
        issues.push({ code: 'hunter-inactive', message: 'Escaped or defeated hunters cannot act.' });
    }
    switch (command.kind) {
        case 'force-resolve-round':
            if (!roundTimerExpired(state, now)) {
                issues.push({ code: 'round-timer-active', message: 'Round timer has not expired.' });
            }
            break;
        case 'pickup-relic':
            issues.push(...validateRelicPickup(state, player, command.relicId));
            break;
        case 'submit-action':
            issues.push(...validateAction(state, player, command.action));
            break;
    }
    return issues;
}

function startExpedition(state: RelicGameState, player: RelicPlayer, now: number): RelicGameState {
    const starting = state.phase === 'lobby';
    return touch({
        ...state,
        phase: starting ? 'planning' : state.phase,
        roundStartedAtEpochMs: starting ? now : state.roundStartedAtEpochMs,
        events: appendEvent({
            state,
            message: `${player.username} started the expedition.`,
            now,
            options: {
                type: 'round_started',
                tone: 'success'
            }
        })
    }, now);
}

function applyRoundCommand({ state, player, command, now }: RelicRoundCommandInput): RelicApplyCommandResult {
    switch (command.kind) {
        case 'continue-review':
            return { state: advanceReviewedRound(state, now), resolvedRound: false };
        case 'force-resolve-round':
            return {
                state: resolveRound(forceRoundResolutionState(state, activePlayers(state), now), now),
                resolvedRound: true
            };
        case 'pickup-relic':
            return { state: pickUpRelic({ state, player, relicId: command.relicId, now }), resolvedRound: false };
        case 'submit-action':
            return submitAction({ state, player, command, now });
    }
}

function submitAction({ state, player, command, now }: RelicActionSubmission): RelicApplyCommandResult {
    const pendingAction: RelicPendingAction = {
        playerId: player.playerId,
        username: player.username,
        action: command.action,
        submittedAtEpochMs: now
    };
    const pendingActions = [
        ...state.pendingActions.filter((action) => action.playerId !== player.playerId),
        pendingAction
    ];
    const submittedState = touch({
        ...state,
        pendingActions,
        events: appendEvent({
            state,
            message: `${player.username} locked in a plan.`,
            now,
            options: {
                type: 'action_submitted',
                tone: 'mystery'
            }
        })
    }, now);
    const resolvedRound = pendingActions.length >= activePlayers(state).length;
    return { state: resolvedRound ? resolveRound(submittedState, now) : submittedState, resolvedRound };
}

function roundTimerExpired(state: RelicGameState, now: number): boolean {
    return state.roundStartedAtEpochMs !== undefined &&
        now >= state.roundStartedAtEpochMs + state.roundTimeLimitMs;
}

function forceRoundResolutionState(
    state: RelicGameState,
    active: readonly RelicPlayer[],
    now: number
): RelicGameState {
    const submittedIds = new Set(state.pendingActions.map((action) => action.playerId));
    const skipped = active.filter((player) => !submittedIds.has(player.playerId));
    const skippedNames = skipped.map((player) => player.username).join(', ');
    const message = skipped.length === 0
        ? 'The round timer expired after every plan was locked.'
        : `The round timer expired. Missing plans skipped: ${skippedNames}.`;

    return touch({
        ...state,
        events: appendEvent({
            state,
            message,
            now,
            options: {
                type: 'action_revealed',
                tone: 'mystery'
            }
        })
    }, now);
}

export function legalMoveTargets(
    state: Pick<RelicGameState, 'map'>,
    player: RelicPlayer
): readonly string[] {
    const currentRoom = state.map.find((candidate) => candidate.id === player.roomId);
    return currentRoom?.neighbors.filter((roomId) => !state.map.find((room) => room.id === roomId)?.collapsed) ?? [];
}

function resolveRound(state: RelicGameState, now: number): RelicGameState {
    let next = {
        ...state,
        events: appendEvent({
            state,
            message: `Round ${state.round} actions are revealed.`,
            now,
            options: {
                type: 'action_revealed',
                animationCue: {
                    type: 'noise_pulse',
                    durationMs: 620,
                    intensity: 'low'
                },
                tone: 'mystery'
            }
        })
    };

    const orderedActions = [...next.pendingActions].sort((left, right) =>
        actionPriority(next, left) - actionPriority(next, right)
    );

    for (const pending of orderedActions) {
        next = resolveAction(next, pending, now);
    }

    const noise = next.pendingActions.reduce(
        (total, pending) => total + noiseForAction(next, pending),
        0
    );
    next = applyRuinPhase(next, noise, now);
    const reviewState = touch({
        ...next,
        phase: 'review',
        pendingActions: [],
        roundStartedAtEpochMs: undefined,
        winnerIds: []
    }, now);

    return scoreAllPlayers(reviewState);
}

function advanceReviewedRound(state: RelicGameState, now: number): RelicGameState {
    const nextRound = state.round + 1;
    const finished = nextRound > state.maxRounds || activePlayers(state).length === 0;
    const advanced = touch({
        ...state,
        round: finished ? state.round : nextRound,
        phase: finished ? 'finished' : 'planning',
        roundStartedAtEpochMs: finished ? state.roundStartedAtEpochMs : now,
        winnerIds: [],
        events: finished
            ? appendEvent({
                state,
                message: 'The castle collapses as the expedition ends.',
                now,
                options: {
                    type: 'game_finished',
                    animationCue: {
                        type: 'heart_relic_victory',
                        durationMs: 4_500,
                        intensity: 'high'
                    },
                    tone: 'success'
                }
            })
            : appendEvent({
                state,
                message: `Round ${nextRound} begins.`,
                now,
                options: {
                    type: 'round_started',
                    tone: 'mystery'
                }
            })
    }, now);

    return finished ? scoreAllPlayers(advanced, true) : scoreAllPlayers(advanced);
}

function resolveAction(
    state: RelicGameState,
    pending: RelicPendingAction,
    now: number
): RelicGameState {
    const player = state.players.find((candidate) => candidate.playerId === pending.playerId);
    if (!player || player.escaped || player.defeated) {
        return state;
    }

    switch (pending.action.kind) {
        case 'move':
            return resolveMove({ state, player, action: pending.action, now });
        case 'search':
            return resolveSearch(state, player, now);
        case 'steal':
            return resolveSteal({ state, player, action: pending.action, now });
        case 'escape':
            return resolveEscape(state, player, now);
    }
}

function resolveMove({ state, player, action, now }: RelicActionResolution): RelicGameState {
    const targetRoomId = action.targetRoomId;
    if (!targetRoomId || !legalMoveTargets(state, player).includes(targetRoomId)) {
        return withEvent({
            state,
            message: `${player.username} failed to find a valid path.`,
            now,
            options: {
                type: 'player_moved',
                tone: 'danger'
            }
        });
    }

    return updatePlayer(
        withEvent(
            {
                state,
                message: `${player.username} moved to ${roomName(state, targetRoomId)}.`,
                now,
                options: {
                    type: 'player_moved',
                    animationCue: {
                        type: 'camera_move',
                        playerId: player.playerId,
                        fromRoomId: player.roomId,
                        roomId: targetRoomId,
                        durationMs: 750,
                        intensity: 'medium'
                    },
                    tone: 'neutral'
                }
            }
        ),
        {
            ...player,
            roomId: targetRoomId
        }
    );
}

function resolveSearch(
    state: RelicGameState,
    player: RelicPlayer,
    now: number
): RelicGameState {
    const hasUnfoundRelics = state.relics.some(
        (r) => r.roomId === player.roomId && !r.foundBy
    );

    // Block further searching only once the room is fully looted
    if (!hasUnfoundRelics && state.roomInvestigations.some((i) => i.roomId === player.roomId)) {
        return withEvent(
            {
                state,
                message: `${player.username} searched ${
                    roomName(state, player.roomId)
                } again, but the useful clues were already marked.`,
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
        return withEvent(
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

    return updatePlayer(
        withEvent(
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
        {
            ...player,
            relicIds: [...player.relicIds, relic.id]
        }
    );
}

function pickUpRelic({ state, player, relicId, now }: RelicPickup): RelicGameState {
    const relic = state.relics.find((candidate) => candidate.id === relicId);
    if (!relic) {
        throw new Error('Validated relic pickup is missing its relic');
    }
    const relics = state.relics.map((candidate) =>
        candidate.id === relic.id
            ? {
                ...candidate,
                foundBy: candidate.foundBy ?? player.playerId,
                carriedBy: player.playerId
            }
            : candidate
    );
    const playerRelicIds = player.relicIds.includes(relic.id)
        ? player.relicIds
        : [...player.relicIds, relic.id];
    const pickedState = updatePlayer(
        withEvent(
            {
                state: {
                    ...state,
                    relics
                },
                message: `${player.username} picked up the ${relic.name}. Asset Recovery has filed a polite panic.`,
                now,
                options: {
                    type: 'relic_picked_up',
                    animationCue: {
                        type: 'relic_pickup',
                        playerId: player.playerId,
                        roomId: player.roomId,
                        relicId: relic.id,
                        durationMs: 760,
                        intensity: 'high'
                    },
                    tone: 'success'
                }
            }
        ),
        {
            ...player,
            relicIds: playerRelicIds
        }
    );

    return touch(pickedState, now);
}

function validateRelicPickup(
    state: RelicGameState,
    player: RelicPlayer,
    relicId: string
): readonly RelicRuleRefusal[] {
    const issues: RelicRuleRefusal[] = [];
    if (state.phase !== 'planning') {
        issues.push({ code: 'planning-required', message: 'Relics can only be picked up during planning.' });
    }
    const relic = state.relics.find((candidate) => candidate.id === relicId);
    if (!relic) {
        return [...issues, { code: 'relic-missing', message: 'Relic does not exist.' }];
    }
    if (relic.roomId !== player.roomId) {
        issues.push({ code: 'relic-in-other-room', message: 'Relic is not in this hunter\'s room.' });
    }
    if (relic.carriedBy || relic.escapedBy) {
        issues.push({ code: 'relic-claimed', message: 'Relic has already been claimed.' });
    }
    return issues;
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
            summary: `${roomName(state, player.roomId)} was searched clear.`,
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

function resolveSteal({ state, player, action, now }: RelicActionResolution): RelicGameState {
    const target = state.players.find((candidate) =>
        candidate.playerId === action.targetPlayerId &&
        candidate.roomId === player.roomId &&
        !candidate.escaped &&
        !candidate.defeated
    );
    const stolenRelicId = target?.relicIds[0];
    if (!target || !stolenRelicId) {
        return withEvent({
            state,
            message: `${player.username} tried to steal but came up empty.`,
            now,
            options: {
                type: 'steal_failed',
                animationCue: {
                    type: 'steal_attempt',
                    playerId: player.playerId,
                    targetPlayerId: action.targetPlayerId,
                    roomId: player.roomId,
                    durationMs: 650,
                    intensity: 'medium'
                },
                tone: 'danger'
            }
        });
    }

    return withEvent(
        {
            state: transferCarriedRelic({ state, player, target, stolenRelicId }),
            message: `${player.username} stole from ${target.username}.`,
            now,
            options: {
                type: 'steal_succeeded',
                animationCue: {
                    type: 'steal_attempt',
                    playerId: player.playerId,
                    targetPlayerId: target.playerId,
                    roomId: player.roomId,
                    relicId: stolenRelicId,
                    durationMs: 800,
                    intensity: 'high'
                },
                tone: 'success'
            }
        }
    );
}

function transferCarriedRelic({ state, player, target, stolenRelicId }: RelicTransfer): RelicGameState {
    return {
        ...state,
        relics: state.relics.map((relic) =>
            relic.id === stolenRelicId ? { ...relic, carriedBy: player.playerId } : relic
        ),
        players: state.players.map((candidate) => {
            if (candidate.playerId === player.playerId) {
                return { ...candidate, relicIds: [...candidate.relicIds, stolenRelicId] };
            }
            if (candidate.playerId === target.playerId) {
                return { ...candidate, relicIds: candidate.relicIds.filter((id) => id !== stolenRelicId) };
            }
            return candidate;
        })
    };
}

function resolveEscape(
    state: RelicGameState,
    player: RelicPlayer,
    now: number
): RelicGameState {
    if (player.roomId !== 'exit') {
        return withEvent({
            state,
            message: `${player.username} tried to escape too early.`,
            now,
            options: {
                type: 'escape_failed',
                tone: 'danger'
            }
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
                state: {
                    ...state,
                    relics
                },
                message: `${player.username} escaped the ruin.`,
                now,
                options: {
                    type: 'player_escaped',
                    animationCue: {
                        type: 'escape_run',
                        playerId: player.playerId,
                        roomId: player.roomId,
                        durationMs: 1_400,
                        intensity: 'high'
                    },
                    tone: 'success'
                }
            }
        ),
        {
            ...player,
            escaped: true,
            relicIds: player.relicIds.filter((relicId) =>
                !relics.some((relic) => relic.id === relicId && relic.escapedBy === player.playerId)
            )
        }
    );
}

function applyRuinPhase(state: RelicGameState, noise: number, now: number): RelicGameState {
    let next = withEvent({
        state,
        message: `The ruin hears ${noise} noise.`,
        now,
        options: {
            type: 'noise_pulse',
            animationCue: {
                type: 'noise_pulse',
                durationMs: 900,
                intensity: noise >= 5 ? 'high' : noise >= 3 ? 'medium' : 'low'
            },
            tone: noise >= 5 ? 'danger' : 'mystery'
        }
    });
    if (noise >= 5) {
        next = damageExposedHunter(next, now);
    }
    if (state.round >= 5) {
        next = markUnstableRoom(next, now);
    }
    return state.round >= 8 ? collapseUnstableRoom(next, now) : next;
}

function damageExposedHunter(state: RelicGameState, now: number): RelicGameState {
    const target = activePlayers(state).find((player) => player.roomId !== 'entrance');
    if (!target) {
        return state;
    }
    const health = Math.max(0, target.health - 1);
    return updatePlayer(
        withEvent({
            state,
            message: `${target.username} is hurt by falling stones.`,
            now,
            options: {
                type: 'player_damaged',
                animationCue: {
                    type: 'damage_shake',
                    playerId: target.playerId,
                    roomId: target.roomId,
                    durationMs: 900,
                    intensity: 'high'
                },
                tone: 'danger'
            }
        }),
        { ...target, health, defeated: health <= 0 }
    );
}

function markUnstableRoom(state: RelicGameState, now: number): RelicGameState {
    const candidates = state.map.filter((room) => room.id !== 'entrance' && room.id !== 'exit' && !room.collapsed);
    const roomToMark = candidates[state.round % candidates.length];
    if (!roomToMark || roomToMark.unstable) {
        return state;
    }
    return {
        ...withEvent({
            state,
            message: `${roomToMark.name} becomes unstable.`,
            now,
            options: {
                type: 'room_unstable',
                animationCue: { type: 'noise_pulse', roomId: roomToMark.id, durationMs: 900, intensity: 'medium' },
                tone: 'danger'
            }
        }),
        map: state.map.map((room) => room.id === roomToMark.id ? { ...room, unstable: true } : room)
    };
}

function collapseUnstableRoom(state: RelicGameState, now: number): RelicGameState {
    const roomToCollapse = state.map.find((room) => room.unstable && !room.collapsed);
    if (!roomToCollapse) {
        return state;
    }
    return {
        ...withEvent({
            state,
            message: `${roomToCollapse.name} collapses.`,
            now,
            options: {
                type: 'room_collapsed',
                animationCue: {
                    type: 'room_collapse',
                    roomId: roomToCollapse.id,
                    durationMs: 1_300,
                    intensity: 'high'
                },
                tone: 'danger'
            }
        }),
        map: state.map.map((room) => room.id === roomToCollapse.id ? { ...room, collapsed: true } : room),
        players: state.players.map((player) =>
            player.roomId === roomToCollapse.id && !player.escaped
                ? { ...player, health: 0, defeated: true }
                : player
        )
    };
}

function ensurePlayer(
    { state, playerId, username, now, characterId }: RelicPlayerAdmission
): RelicPlayerAdmissionResult {
    const existing = state.players.find((player) => player.playerId === playerId);
    if (existing) {
        const player = refreshJoinedPlayer({ state, existing, username, characterId });
        return { state: updatePlayer(state, player), player };
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
        relicIds: []
    };

    return {
        state: {
            ...state,
            adminPlayerId: state.players.length === 0 ? state.adminPlayerId ?? playerId : state.adminPlayerId,
            players: [...state.players, player],
            events: appendEvent({
                state,
                message: `${username} joined as ${findRelicCharacter(player.characterId).name}.`,
                now,
                options: {
                    type: 'player_joined',
                    tone: 'success'
                }
            })
        },
        player
    };
}

function refreshJoinedPlayer({ state, existing, username, characterId }: RelicJoinedPlayerRefresh): RelicPlayer {
    if (existing.username === username && !characterId) {
        return existing;
    }
    const nextCharacterId = state.phase === 'lobby' && characterId ? characterId : existing.characterId;
    return {
        ...existing,
        username,
        characterId: nextCharacterId,
        health: state.phase === 'lobby' && characterId ? startingHealth(nextCharacterId) : existing.health
    };
}

function validateAction(
    state: RelicGameState,
    player: RelicPlayer,
    action: RelicActionInput
): readonly RelicRuleRefusal[] {
    const issues: RelicRuleRefusal[] = [];
    if (action.kind === 'move' && !action.targetRoomId) {
        issues.push({ code: 'move-target-required', message: 'Move requires a target room.' });
    }
    if (
        action.kind === 'move' && action.targetRoomId && !legalMoveTargets(state, player).includes(action.targetRoomId)
    ) {
        issues.push({ code: 'move-not-adjacent', message: 'Move target is not adjacent.' });
    }
    if (action.kind === 'steal' && !action.targetPlayerId) {
        issues.push({ code: 'steal-target-required', message: 'Steal requires a target hunter.' });
    }
    return issues;
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
    pending: RelicPendingAction
): RelicCharacter | undefined {
    const player = state.players.find((candidate) => candidate.playerId === pending.playerId);
    return player ? findRelicCharacter(player.characterId) : undefined;
}

function characterRelicBonus(
    state: RelicGameState,
    player: RelicPlayer
): number {
    const relicBonus = findRelicCharacter(player.characterId).relicValueBonus ?? 0;
    if (relicBonus <= 0) {
        return 0;
    }

    const heldOrEscapedRelics = [
        ...player.relicIds,
        ...state.relics
            .filter((relic) => relic.escapedBy === player.playerId)
            .map((relic) => relic.id)
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
            (total, relicId) => total + (state.relics.find((relic) => relic.id === relicId)?.value ?? 0),
            0
        );
        const escapedScore = state.relics
            .filter((relic) => relic.escapedBy === player.playerId)
            .reduce((total, relic) => total + relic.value, 0);
        const escapeBonus = player.escaped ? escapeBonusForPlayer(player) : 0;
        const skillBonus = characterRelicBonus(state, player);
        const penalty = applyEndPenalty && !player.escaped ? -5 : 0;

        return {
            ...player,
            score: carriedScore + escapedScore + skillBonus + escapeBonus + penalty
        };
    });

    return {
        ...state,
        players,
        winnerIds: state.phase === 'finished' ? calculateWinnerIds({ ...state, players }) : []
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
        players: state.players.map((candidate) => candidate.playerId === player.playerId ? player : candidate)
    };
}

function withEvent({ state, message, now, options }: RelicStateEvent): RelicGameState {
    return {
        ...state,
        events: appendEvent({ state, message, now, options })
    };
}

function appendEvent({ state, message, now, options }: RelicEventAppend): readonly RelicEvent[] {
    return [
        ...state.events,
        toEvent({ round: state.round, message, now, options })
    ].slice(-64);
}

function toEvent({ round, message, now, options }: RelicEventInput): RelicEvent {
    return {
        id: `${round}:${now}:${toEventHash(message)}`,
        round,
        type: options?.type ?? 'round_started',
        message,
        animationCue: options?.animationCue,
        tone: options?.tone ?? 'neutral',
        createdAtEpochMs: now
    };
}

function touch(state: RelicGameState, now: number): RelicGameState {
    return scoreAllPlayers({
        ...state,
        updatedAtEpochMs: now
    });
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
