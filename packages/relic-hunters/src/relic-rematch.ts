import {
    changeRallarGameRematchSettings,
    createRallarGameRematch,
    evaluateRallarGameRematchStart,
    setRallarGameRematchReady,
    type RallarGameParticipant
} from '@shared/rallar-game/rematch.ts';
import { Either } from '@shared/resilience/Either.ts';
import { admitRelicHunter, startRelicExpedition } from './expedition-preparation.ts';
import {
    RELIC_EXPEDITION_CAPACITY,
    toRelicRoundTrackKey,
    type RelicGameState,
    type RelicPublicSnapshot,
    type RelicRematch,
    type RelicRematchCommand,
    type RelicRematchHunter,
    type RelicRuleRefusal
} from './model.ts';
import type { RelicCommandEvaluation } from './rules.ts';

export interface RelicRematchEvaluation
    extends Omit<RelicCommandEvaluation, 'rematchParticipants' | 'presentPlayerIds'> {
    readonly rematchParticipants: readonly RallarGameParticipant[];
}

interface RelicRematchDecision {
    readonly state: RelicGameState;
    readonly rematch: RelicRematch;
    readonly evaluation: RelicRematchEvaluation;
}

/** Unprepared results project the same initial roster on every authority and browser. */
export function createRelicRematch(
    state: Pick<RelicGameState, 'gameId' | 'createdAtEpochMs' | 'players' | 'roundTimeLimitMs'>
): Either<RelicRuleRefusal, RelicRematch> {
    const hunters = state.players.filter((player) => player.withdrawnAtEpochMs === undefined)
        .map(({ playerId, username, characterId }) => ({ playerId, username, characterId }))
        .toSorted(compareRematchHunters);
    return createRallarGameRematch({
        completedGameId: toRelicRoundTrackKey(state),
        settingsKey: `round-limit:${state.roundTimeLimitMs}:0`,
        participantSessionIds: hunters.map((hunter) => hunter.playerId),
        capacity: RELIC_EXPEDITION_CAPACITY
    }).mapRight((preparation) => ({ preparation, hunters, roundTimeLimitMs: state.roundTimeLimitMs }));
}

export function applyRelicRematchCommand(
    state: RelicGameState,
    command: RelicRematchCommand,
    evaluation: RelicRematchEvaluation
): Either<RelicRuleRefusal, RelicGameState> {
    if (state.phase !== 'finished' || command.completedGameId !== toRelicRoundTrackKey(state)) {
        return Either.ofLeft({ code: 'stale-preparation', message: 'This expedition is not awaiting that rematch.' });
    }
    const prepared = state.rematch
        ? Either.ofRight<RelicRuleRefusal, RelicRematch>(state.rematch)
        : createRelicRematch(state);
    return prepared.flatMap<RelicRuleRefusal, RelicGameState>(Either.ofLeft, (rematch) => {
        if (command.settingsKey !== rematch.preparation.settingsKey) {
            return Either.ofLeft({ code: 'stale-preparation', message: 'The next expedition settings have changed.' });
        }
        const decision = { state, rematch, evaluation };
        switch (command.kind) {
            case 'set-rematch-ready':
                return setRelicRematchReady(decision, command);
            case 'set-rematch-round-limit':
                return changeRelicRematchRoundLimit(decision, command);
            case 'start-rematch':
                return computeNextRelicExpedition(decision, command);
        }
    });
}

export function withdrawRelicRematch(
    state: RelicGameState,
    evaluation: RelicCommandEvaluation
): Either<RelicRuleRefusal, RelicGameState> {
    const prepared = state.rematch
        ? Either.ofRight<RelicRuleRefusal, RelicRematch>(state.rematch)
        : createRelicRematch(state);
    return prepared.mapRight((rematch) => {
        const hunters = rematch.hunters.filter((hunter) => hunter.playerId !== evaluation.senderId);
        if (hunters.length === rematch.hunters.length) {
            return state;
        }
        return {
            ...state,
            updatedAtEpochMs: evaluation.now,
            adminPlayerId: state.adminPlayerId === evaluation.senderId
                ? hunters.find((hunter) => evaluation.presentPlayerIds.includes(hunter.playerId))?.playerId
                : state.adminPlayerId,
            rematch: {
                ...rematch,
                hunters,
                preparation: {
                    ...rematch.preparation,
                    players: rematch.preparation.players.filter((player) => player.sessionId !== evaluation.senderId)
                }
            }
        };
    });
}

function setRelicRematchReady(
    { state, rematch, evaluation }: RelicRematchDecision,
    command: Extract<RelicRematchCommand, { kind: 'set-rematch-ready'; }>
): Either<RelicRuleRefusal, RelicGameState> {
    const existing = rematch.hunters.find((hunter) => hunter.playerId === evaluation.senderId);
    if (existing && existing.characterId !== command.characterId) {
        return Either.ofLeft({
            code: 'character-changed',
            message: 'Play again keeps your selected hunter character.'
        });
    }
    return setRallarGameRematchReady({
        preparation: rematch.preparation,
        assignment: { ...command, sessionId: evaluation.senderId },
        participants: evaluation.rematchParticipants,
        capacity: RELIC_EXPEDITION_CAPACITY
    }).mapRight((preparation) => ({
        ...state,
        updatedAtEpochMs: evaluation.now,
        rematch: {
            ...rematch,
            preparation,
            hunters: preparation.players.map((player) => {
                const hunter = rematch.hunters.find((candidate) => candidate.playerId === player.sessionId);
                return hunter ??
                    { playerId: evaluation.senderId, username: command.username, characterId: command.characterId };
            }).toSorted(compareRematchHunters)
        }
    }));
}

function changeRelicRematchRoundLimit(
    { state, rematch, evaluation }: RelicRematchDecision,
    command: Extract<RelicRematchCommand, { kind: 'set-rematch-round-limit'; }>
): Either<RelicRuleRefusal, RelicGameState> {
    if (
        state.adminPlayerId !== evaluation.senderId ||
        !evaluation.rematchParticipants.some((participant) => participant.sessionId === evaluation.senderId)
    ) {
        return Either.ofLeft({
            code: 'leader-required',
            message: 'Only the present Keeper can change the next expedition.'
        });
    }
    if (rematch.roundTimeLimitMs === command.timeLimitMs) {
        return Either.ofRight(state);
    }
    return Either.ofRight({
        ...state,
        updatedAtEpochMs: evaluation.now,
        rematch: {
            ...rematch,
            roundTimeLimitMs: command.timeLimitMs,
            preparation: changeRallarGameRematchSettings(
                rematch.preparation,
                `round-limit:${command.timeLimitMs}:${evaluation.now}`
            )
        }
    });
}

/** The admission probe and mutation attempt share the same game-owned start policy. */
export function evaluateRelicRematchStart(
    state: RelicGameState,
    command: Extract<RelicRematchCommand, { kind: 'start-rematch'; }>,
    evaluation: RelicRematchEvaluation
): Either<RelicRuleRefusal, readonly string[]> {
    if (state.phase !== 'finished' || command.completedGameId !== toRelicRoundTrackKey(state)) {
        return Either.ofLeft({ code: 'stale-preparation', message: 'This expedition is not awaiting that rematch.' });
    }
    const prepared = state.rematch
        ? Either.ofRight<RelicRuleRefusal, RelicRematch>(state.rematch)
        : createRelicRematch(state);
    return prepared.flatMap<RelicRuleRefusal, readonly string[]>(
        Either.ofLeft,
        (rematch) =>
            evaluateRallarGameRematchStart(rematch.preparation, {
                completedGameId: command.completedGameId,
                settingsKey: command.settingsKey,
                actorSessionId: evaluation.senderId,
                leaderSessionId: state.adminPlayerId,
                participants: evaluation.rematchParticipants
            })
    );
}

function computeNextRelicExpedition(
    decision: RelicRematchDecision,
    command: Extract<RelicRematchCommand, { kind: 'start-rematch'; }>
): Either<RelicRuleRefusal, RelicGameState> {
    const { state, rematch, evaluation } = decision;
    return evaluateRelicRematchStart(state, command, evaluation).flatMap<RelicRuleRefusal, RelicGameState>(
        Either.ofLeft,
        (participantIds) => {
            const initial = evaluation.nextExpedition;
            if (!initial) {
                return Either.ofLeft({
                    code: 'initial-state-missing',
                    message: 'No captured next expedition is available.'
                });
            }
            if (
                initial.gameId !== state.gameId || initial.roomId !== state.roomId || initial.phase !== 'lobby' ||
                initial.players.length !== 0 || initial.rematch !== undefined
            ) {
                return Either.ofLeft({
                    code: 'invalid-initial-state',
                    message: 'The next expedition proposal is not pristine.'
                });
            }
            return Either.ofRight(populateNextRelicExpedition(decision, initial, participantIds));
        }
    );
}

function populateNextRelicExpedition(
    { state, rematch, evaluation }: RelicRematchDecision,
    initial: RelicGameState,
    participantIds: readonly string[]
): RelicGameState {
    let next: RelicGameState = {
        ...initial,
        createdAtEpochMs: Math.max(initial.createdAtEpochMs, state.createdAtEpochMs + 1),
        updatedAtEpochMs: evaluation.now,
        adminPlayerId: evaluation.senderId,
        roundTimeLimitMs: rematch.roundTimeLimitMs
    };
    for (const hunter of rematch.hunters) {
        if (participantIds.includes(hunter.playerId)) {
            next = admitRelicHunter({ state: next, ...hunter, now: evaluation.now }).state;
        }
    }
    const leader = next.players.find((player) => player.playerId === evaluation.senderId);
    if (!leader) {
        throw new TypeError('Validated rematch start has no consenting Keeper');
    }
    return startRelicExpedition(next, leader, evaluation.now);
}

function compareRematchHunters(left: RelicRematchHunter, right: RelicRematchHunter): number {
    return left.playerId < right.playerId ? -1 : left.playerId > right.playerId ? 1 : 0;
}

/** Completed scores are history; the next game's explicit roster owns continued participation. */
export function hasRelicRematchParticipation(
    snapshot: RelicPublicSnapshot | undefined,
    sessionId: string | undefined
): boolean {
    if (!snapshot || snapshot.phase !== 'finished' || !sessionId) {
        return false;
    }
    const rematch = snapshot.rematch ?? createRelicRematch(snapshot).right;
    return rematch?.hunters.some((hunter) => hunter.playerId === sessionId) ?? false;
}
