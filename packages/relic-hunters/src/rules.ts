import type { RallarGameParticipant } from '@shared/rallar-game/rematch.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
    admitRelicHunter,
    startRelicExpedition,
    type RelicPlayerAdmissionResult
} from './expedition-preparation.ts';
import { RELIC_EXPEDITION_CAPACITY } from './model.ts';
import { applyRelicRematchCommand, withdrawRelicRematch } from './relic-rematch.ts';

import {
    findRelicCharacter,
    type RelicCharacter
} from './characters.ts';
import {
    type RelicActionInput,
    type RelicCommand,
    type RelicGameState,
    type RelicPendingAction,
    type RelicPlayer,
    type RelicRuleRefusal
} from './model.ts';
import { resolveSearch } from './resolve-search.ts';
import { appendRelicEvent, withRelicEvent } from './to-relic-event.ts';

export interface RelicCommandEvaluation {
    readonly senderId: string;
    readonly now: number;
    /** Current eligible room sessions, observed by the authority for this attempt. */
    readonly presentPlayerIds: readonly string[];
    readonly rematchParticipants?: readonly RallarGameParticipant[];
    /** Captured pristine proposal, supplied only when starting the next expedition. */
    readonly nextExpedition?: RelicGameState;
}

export interface RelicApplyCommandResult {
    readonly state: RelicGameState;
    readonly resolvedRound: boolean;
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

interface RelicTransfer {
    readonly state: RelicGameState;
    readonly player: RelicPlayer;
    readonly target: RelicPlayer;
    readonly stolenRelicId: string;
}

export function applyRelicCommand(
    state: RelicGameState,
    command: RelicCommand,
    evaluation: RelicCommandEvaluation
): Either<RelicRuleRefusal, RelicApplyCommandResult> {
    if (
        command.kind === 'set-rematch-ready' || command.kind === 'start-rematch' ||
        command.kind === 'set-rematch-round-limit'
    ) {
        if (evaluation.rematchParticipants === undefined) {
            return Either.ofLeft({
                code: 'authority-required',
                message: 'Fresh room authority is required to prepare the next expedition.'
            });
        }
        return applyRelicRematchCommand(state, command, {
            ...evaluation,
            rematchParticipants: evaluation.rematchParticipants
        }).mapRight((next) => ({
            state: next,
            resolvedRound: false
        }));
    }
    return applyCurrentRelicCommand(state, command, evaluation);
}

function applyCurrentRelicCommand(
    state: RelicGameState,
    command: Exclude<RelicCommand, { kind: 'set-rematch-ready' | 'start-rematch' | 'set-rematch-round-limit'; }>,
    evaluation: RelicCommandEvaluation
): Either<RelicRuleRefusal, RelicApplyCommandResult> {
    const now = evaluation.now;
    const existing = state.players.find((player) => player.playerId === evaluation.senderId);
    if (command.kind === 'leave-expedition' && state.phase === 'finished') {
        return withdrawRelicRematch(state, evaluation).mapRight((next) => ({ state: next, resolvedRound: false }));
    }
    if (state.phase === 'finished' && (command.kind === 'start-expedition' || command.kind === 'set-round-limit')) {
        return Either.ofLeft({
            code: 'rematch-required',
            message: 'Use Play again to prepare the next expedition together.'
        });
    }
    if (state.phase === 'finished' && command.kind === 'join-expedition' && existing) {
        return Either.ofRight({ state, resolvedRound: false });
    }
    if (command.kind === 'leave-expedition') {
        return Either.ofRight(withdrawHunter(state, evaluation));
    }
    if (existing?.withdrawnAtEpochMs !== undefined) {
        return Either.ofLeft({ code: 'hunter-withdrawn', message: 'This hunter has left the expedition.' });
    }
    if (
        command.kind !== 'join-expedition' && !existing &&
        !(command.kind === 'take-keeper' &&
            state.rematch?.hunters.some((hunter) => hunter.playerId === evaluation.senderId))
    ) {
        return Either.ofLeft({
            code: 'participant-required',
            message: 'Join the expedition before sending game commands.'
        });
    }
    if (command.kind === 'take-keeper') {
        return takeKeeper(state, evaluation);
    }
    const admissionIssues = validatePlayerAdmission(state, evaluation.senderId);
    if (admissionIssues.length > 0) {
        return Either.ofLeft(admissionIssues[0]);
    }
    const joined = command.kind !== 'join-expedition' && existing ? { state, player: existing } : admitRelicHunter({
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
    return applyAdmittedRelicCommand(joined, command, now);
}

/** A deliberate withdrawal ends this hunter's participation; a presence loss alone never calls this rule. */
function withdrawHunter(state: RelicGameState, evaluation: RelicCommandEvaluation): RelicApplyCommandResult {
    const player = state.players.find((candidate) => candidate.playerId === evaluation.senderId);
    if (!player || player.withdrawnAtEpochMs !== undefined) {
        return { state, resolvedRound: false };
    }
    const players = state.players
        .filter((candidate) => candidate.playerId !== player.playerId || candidate.escaped)
        .map((candidate) =>
            candidate.playerId === player.playerId
                ? { ...candidate, withdrawnAtEpochMs: evaluation.now }
                : candidate
        );
    const successor = state.adminPlayerId === player.playerId
        ? players.find((candidate) =>
            candidate.playerId !== player.playerId && candidate.withdrawnAtEpochMs === undefined &&
            evaluation.presentPlayerIds.includes(candidate.playerId)
        )?.playerId
        : state.adminPlayerId;
    const next = touch({
        ...state,
        players,
        adminPlayerId: successor,
        pendingActions: state.pendingActions.filter((pending) => pending.playerId !== player.playerId),
        relics: state.relics.map((relic) => {
            if (relic.carriedBy !== player.playerId || relic.escapedBy !== undefined) {
                return relic;
            }
            const { carriedBy: _carriedBy, ...dropped } = relic;
            return { ...dropped, roomId: player.roomId };
        }),
        events: appendRelicEvent({
            state,
            message: `${player.username} left the expedition.${
                successor && successor !== state.adminPlayerId
                    ? ` ${players.find((candidate) => candidate.playerId === successor)?.username} is now Keeper.`
                    : ''
            }`,
            now: evaluation.now,
            options: { type: 'player_withdrew' }
        })
    }, evaluation.now);
    const active = activePlayers(next);
    if (next.phase !== 'lobby' && active.length === 0) {
        return { state: advanceReviewedRound(next, evaluation.now), resolvedRound: false };
    }
    const resolvedRound = next.phase === 'planning' &&
        active.every((hunter) => next.pendingActions.some((pending) => pending.playerId === hunter.playerId));
    return { state: resolvedRound ? resolveRound(next, evaluation.now) : next, resolvedRound };
}

function takeKeeper(
    state: RelicGameState,
    evaluation: RelicCommandEvaluation
): Either<RelicRuleRefusal, RelicApplyCommandResult> {
    if (!evaluation.presentPlayerIds.includes(evaluation.senderId)) {
        return Either.ofLeft({
            code: 'present-hunter-required',
            message: 'Return to the expedition room before taking over as Keeper.'
        });
    }
    if (state.adminPlayerId === evaluation.senderId) {
        return Either.ofRight({ state, resolvedRound: false });
    }
    if (state.adminPlayerId && evaluation.presentPlayerIds.includes(state.adminPlayerId)) {
        return Either.ofLeft({ code: 'keeper-present', message: 'The current Keeper is still present.' });
    }
    const hunter = state.phase === 'finished' && state.rematch
        ? state.rematch.hunters.find((player) => player.playerId === evaluation.senderId)
        : state.players.find((player) => player.playerId === evaluation.senderId);
    if (!hunter) {
        return Either.ofLeft({
            code: 'participant-required',
            message: 'Join the expedition before taking over as Keeper.'
        });
    }
    return Either.ofRight({
        state: {
            ...state,
            adminPlayerId: hunter.playerId,
            updatedAtEpochMs: evaluation.now,
            events: appendRelicEvent({
                state,
                message: `${hunter.username} took over as Keeper.`,
                now: evaluation.now,
                options: { type: 'keeper_changed' }
            })
        },
        resolvedRound: false
    });
}

function validatePlayerAdmission(state: RelicGameState, playerId: string): readonly RelicRuleRefusal[] {
    if (state.players.some((player) => player.playerId === playerId)) {
        return [];
    }
    const issues: RelicRuleRefusal[] = [];
    if (state.phase !== 'lobby') {
        issues.push({ code: 'expedition-started', message: 'Cannot join an expedition after it has started.' });
    }
    if (state.players.length >= RELIC_EXPEDITION_CAPACITY) {
        issues.push({ code: 'expedition-full', message: 'This expedition is full.' });
    }
    return issues;
}

function validateRelicCommand(
    { state, player }: RelicPlayerAdmissionResult,
    command: Exclude<RelicCommand, {
        kind:
            | 'leave-expedition'
            | 'take-keeper'
            | 'set-rematch-ready'
            | 'start-rematch'
            | 'set-rematch-round-limit';
    }>,
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
        events: appendRelicEvent({
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
        events: appendRelicEvent({
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
        events: appendRelicEvent({
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
            ? appendRelicEvent({
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
            : appendRelicEvent({
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
        return withRelicEvent({
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
        withRelicEvent(
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
        withRelicEvent(
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

function resolveSteal({ state, player, action, now }: RelicActionResolution): RelicGameState {
    const target = state.players.find((candidate) =>
        candidate.playerId === action.targetPlayerId &&
        candidate.roomId === player.roomId &&
        !candidate.escaped &&
        !candidate.defeated
    );
    const stolenRelicId = target?.relicIds[0];
    if (!target || !stolenRelicId) {
        return withRelicEvent({
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

    return withRelicEvent(
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
        return withRelicEvent({
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
        withRelicEvent(
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
    let next = withRelicEvent({
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
        withRelicEvent({
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
        ...withRelicEvent({
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
        ...withRelicEvent({
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

function touch(state: RelicGameState, now: number): RelicGameState {
    return scoreAllPlayers({
        ...state,
        updatedAtEpochMs: now
    });
}

function roomName(state: RelicGameState, roomId: string): string {
    return state.map.find((room) => room.id === roomId)?.name ?? roomId;
}
function applyAdmittedRelicCommand(
    joined: RelicPlayerAdmissionResult,
    command: Exclude<RelicCommand, {
        kind:
            | 'set-rematch-ready'
            | 'start-rematch'
            | 'set-rematch-round-limit'
            | 'leave-expedition'
            | 'take-keeper';
    }>,
    now: number
): Either<RelicRuleRefusal, RelicApplyCommandResult> {
    switch (command.kind) {
        case 'join-expedition':
            return Either.ofRight({ state: touch(joined.state, now), resolvedRound: false });
        case 'start-expedition':
            return Either.ofRight({
                state: touch(startRelicExpedition(joined.state, joined.player, now), now),
                resolvedRound: false
            });
        case 'set-round-limit':
            return Either.ofRight({
                state: touch({ ...joined.state, roundTimeLimitMs: command.timeLimitMs }, now),
                resolvedRound: false
            });
        default:
            return Either.ofRight(applyRoundCommand({ state: joined.state, player: joined.player, command, now }));
    }
}
