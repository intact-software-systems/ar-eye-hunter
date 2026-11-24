import { Either } from '@shared/resilience/Either.ts';

import type { TownMatchIdentity, TownMatchState } from '../town-match.ts';
import type { TownCheckpoint, TownCheckpointIdentity, TownMatchCheckpoints } from './match-checkpoints.ts';

interface CheckpointProposal {
    readonly checkpoint: TownCheckpoint;
    readonly senderId: string;
    readonly state: TownMatchCheckpoints.State;
    readonly catchingUp: boolean;
}

export function validateCheckpointProposal(proposal: CheckpointProposal): Either<string, boolean> {
    const { checkpoint, senderId, state, catchingUp } = proposal;
    if (senderId !== state.authority.sessionId || checkpoint.epoch !== state.authority.epoch) {
        return Either.ofLeft('Only the current appointed director may propose a checkpoint.');
    }
    if (
        state.recoveryRequired && !state.recovered && !catchingUp &&
        checkpoint.state.phase !== 'lobby' && checkpoint.state.phase !== 'interrupted'
    ) {
        return Either.ofLeft('Current players must agree on committed recovery state before gameplay resumes.');
    }
    if (!sameRoster(checkpoint.state.members, state.authority.members)) {
        return Either.ofLeft('The checkpoint does not contain the current player sessions.');
    }
    if (sameCheckpoint(state.committed, checkpoint) || sameCheckpoint(state.pending?.checkpoint, checkpoint)) {
        return Either.ofRight(false);
    }
    if (state.pending && (!catchingUp || checkpoint.sequence <= state.pending.checkpoint.sequence)) {
        return Either.ofLeft('The outstanding checkpoint must settle before it can be replaced.');
    }
    if (
        checkpoint.sequence <= 0 || !Number.isSafeInteger(checkpoint.sequence) ||
        (state.committed?.epoch === checkpoint.epoch && checkpoint.sequence <= state.committed.sequence)
    ) {
        return Either.ofLeft('Checkpoint sequence must advance within the appointment.');
    }
    const transition = validateCheckpointTransition(
        (state.recoveryCheckpoint ?? state.committed)?.state,
        checkpoint.state
    );
    if (transition.length > 0) {
        return Either.ofLeft(transition.join(' '));
    }
    return Either.ofRight(true);
}

export function sameCheckpoint(left: TownCheckpointIdentity | undefined, right: TownCheckpointIdentity): boolean {
    return left !== undefined && left.epoch === right.epoch && left.sequence === right.sequence &&
        left.digest === right.digest;
}

export function sameRoster(left: readonly TownMatchIdentity[], right: readonly TownMatchIdentity[]): boolean {
    return left.length === right.length &&
        left.every((member) => right.some((other) => other.id === member.id && other.sessionId === member.sessionId));
}

export function validateCheckpointTransition(
    previous: TownMatchState | undefined,
    next: TownMatchState
): readonly string[] {
    if (!previous) {
        return [];
    }
    if (previous.matchId !== next.matchId) {
        return (previous.phase === 'finished' || previous.phase === 'interrupted') && next.phase === 'lobby'
            ? []
            : ['Only a terminal round may be replaced by a fresh lobby.'];
    }
    if (
        next.tick < previous.tick ||
        (previous.phase === 'countdown' && next.phase === 'countdown' && next.countdownTicks > previous.countdownTicks)
    ) {
        return ['A checkpoint cannot rewind confirmed simulation time.'];
    }
    if (
        (previous.phase !== 'lobby' && next.phase === 'lobby') ||
        (previous.phase === 'playing' && next.phase === 'countdown') ||
        ((previous.phase === 'finished' || previous.phase === 'interrupted') && next.phase !== previous.phase)
    ) {
        return ['A checkpoint cannot restart a completed match phase.'];
    }
    return [];
}
