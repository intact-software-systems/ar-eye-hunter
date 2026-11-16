import { Either } from '@shared/resilience/Either.ts';

import type { TownMatchIdentity, TownMatchState } from './town-match.ts';

export interface TownMatchAuthority {
    readonly epoch: number;
    readonly sessionId: string;
    readonly members: readonly TownMatchIdentity[];
}
export interface TownCheckpointIdentity {
    readonly epoch: number;
    readonly sequence: number;
    readonly digest: string;
}
export interface TownCheckpoint extends TownCheckpointIdentity {
    readonly state: TownMatchState;
}

export namespace TownMatchCheckpoints {
    export interface Pending {
        readonly checkpoint: TownCheckpoint;
        readonly acknowledgements: readonly string[];
        readonly commitReceived: boolean;
    }
    export interface State {
        readonly authority: TownMatchAuthority;
        readonly pending: Pending | undefined;
        readonly committed: TownCheckpoint | undefined;
        readonly recovered: boolean;
        readonly recoveryRequired: boolean;
        readonly recoveryCheckpoint: TownCheckpoint | undefined;
        readonly retainedProposal: TownCheckpoint | undefined;
    }
}

/** Receives decoded values after transport authentication and digest verification. */
export class TownMatchCheckpoints {
    private authority: TownMatchAuthority;
    private pending: TownMatchCheckpoints.Pending | undefined;
    private committed: TownCheckpoint | undefined;
    private recoverySessions = new Set<string>();
    private recoveryRequired = false;
    private retainedProposal: TownCheckpoint | undefined;
    private recoveryCheckpoint: TownCheckpoint | undefined;
    private recoveryCommitWitness = false;

    constructor(authority: TownMatchAuthority) {
        this.authority = authority;
    }

    getState(): TownMatchCheckpoints.State {
        const recoveryMembers = this.authority.members.filter((member) =>
            this.recoveryCheckpoint?.state.members.some((previous) =>
                previous.sessionId === member.sessionId && previous.id === member.id
            )
        );
        return {
            authority: this.authority,
            pending: this.pending,
            committed: this.committed,
            recoveryRequired: this.recoveryRequired,
            recoveryCheckpoint: this.recoveryCheckpoint,
            retainedProposal: this.retainedProposal,
            recovered: this.recoveryCommitWitness && recoveryMembers.length >= 2 &&
                recoveryMembers.some((member) => member.sessionId === this.authority.sessionId) &&
                recoveryMembers.every((member) => this.recoverySessions.has(member.sessionId))
        };
    }

    propose(checkpoint: TownCheckpoint, senderId: string): Either<string, boolean> {
        if (senderId !== this.authority.sessionId || checkpoint.epoch !== this.authority.epoch) {
            return Either.ofLeft('Only the current appointed director may propose a checkpoint.');
        }
        if (
            this.recoveryRequired && !this.getState().recovered &&
            checkpoint.state.phase !== 'lobby' && checkpoint.state.phase !== 'interrupted'
        ) {
            return Either.ofLeft('Current players must agree on committed recovery state before gameplay resumes.');
        }
        if (!sameRoster(checkpoint.state.members, this.authority.members)) {
            return Either.ofLeft('The checkpoint does not contain the current player sessions.');
        }
        if (sameCheckpoint(this.committed, checkpoint) || sameCheckpoint(this.pending?.checkpoint, checkpoint)) {
            return Either.ofRight(false);
        }
        if (this.pending) {
            return Either.ofLeft('The outstanding checkpoint must settle before it can be replaced.');
        }
        if (
            checkpoint.sequence <= 0 || !Number.isSafeInteger(checkpoint.sequence) ||
            (this.committed?.epoch === checkpoint.epoch && checkpoint.sequence <= this.committed.sequence)
        ) {
            return Either.ofLeft('Checkpoint sequence must advance within the appointment.');
        }
        const transition = validateCheckpointTransition(
            (this.recoveryCheckpoint ?? this.committed)?.state,
            checkpoint.state
        );
        if (transition.length > 0) {
            return Either.ofLeft(transition.join(' '));
        }
        this.pending = { checkpoint, acknowledgements: [], commitReceived: false };
        return Either.ofRight(true);
    }

    acknowledge(checkpoint: TownCheckpointIdentity, senderId: string): Either<string, boolean> {
        if (!this.authority.members.some((member) => member.sessionId === senderId)) {
            return Either.ofLeft('Only a current player session may acknowledge the checkpoint.');
        }
        if (sameCheckpoint(this.committed, checkpoint)) {
            return Either.ofRight(false);
        }
        if (!this.pending || !sameCheckpoint(this.pending.checkpoint, checkpoint)) {
            return Either.ofLeft('The acknowledgement does not name the outstanding checkpoint.');
        }
        this.pending = {
            ...this.pending,
            acknowledgements: [...new Set([...this.pending.acknowledgements, senderId])]
        };
        return Either.ofRight(this.commitAcknowledged());
    }

    commit(checkpoint: TownCheckpointIdentity, senderId: string): Either<string, boolean> {
        if (senderId !== this.authority.sessionId || checkpoint.epoch !== this.authority.epoch) {
            return Either.ofLeft('Only the current appointed director may commit a checkpoint.');
        }
        if (sameCheckpoint(this.committed, checkpoint)) {
            return Either.ofRight(false);
        }
        if (!this.pending || !sameCheckpoint(this.pending.checkpoint, checkpoint)) {
            return Either.ofLeft('The commit does not name the outstanding checkpoint.');
        }
        this.pending = { ...this.pending, commitReceived: true };
        return Either.ofRight(this.commitAcknowledged());
    }

    changeAuthority(authority: TownMatchAuthority): Either<string, boolean> {
        if (
            authority.epoch < this.authority.epoch ||
            (authority.epoch === this.authority.epoch && authority.sessionId !== this.authority.sessionId)
        ) {
            return Either.ofLeft('An older or conflicting appointment cannot replace current authority.');
        }
        if (authority.epoch === this.authority.epoch && sameRoster(authority.members, this.authority.members)) {
            return Either.ofRight(false);
        }
        this.authority = authority;
        const pending = this.pending?.checkpoint;
        if (pending && validateCheckpointTransition(this.retainedProposal?.state, pending.state).length === 0) {
            this.retainedProposal = pending;
        }
        this.pending = undefined;
        this.recoverySessions.clear();
        this.recoveryCheckpoint = this.recoveryCheckpoint ?? this.committed;
        this.recoveryCommitWitness = false;
        this.recoveryRequired = true;
        return Either.ofRight(true);
    }

    recover(senderId: string, checkpoint: TownCheckpointIdentity, committed: boolean): Either<string, boolean> {
        if (
            this.authority.members.length < 2 ||
            !this.authority.members.some((member) => member.sessionId === senderId) ||
            ![this.recoveryCheckpoint, this.retainedProposal].some((candidate) =>
                sameCheckpoint(candidate, checkpoint) &&
                candidate?.state.members.some((member) => member.sessionId === senderId)
            )
        ) {
            return Either.ofLeft('Recovery reports must come from current sessions that held the named checkpoint.');
        }
        if (!sameCheckpoint(this.recoveryCheckpoint, checkpoint)) {
            if (!committed || !sameCheckpoint(this.retainedProposal, checkpoint)) {
                return Either.ofLeft(
                    'Recovery must name committed state or a locally verified proposal with a commit witness.'
                );
            }
            this.recoveryCheckpoint = this.retainedProposal;
            this.pending = undefined;
            this.recoverySessions.clear();
            this.recoveryCommitWitness = false;
        }
        this.recoverySessions.add(senderId);
        this.recoveryCommitWitness ||= committed;
        return Either.ofRight(this.getState().recovered);
    }

    private commitAcknowledged(): boolean {
        const pending = this.pending;
        if (
            !pending?.commitReceived ||
            !this.authority.members.every((member) => pending.acknowledgements.includes(member.sessionId))
        ) {
            return false;
        }
        this.committed = pending.checkpoint;
        this.retainedProposal = undefined;
        this.recoveryCheckpoint = undefined;
        this.recoveryCommitWitness = false;
        this.recoveryRequired = false;
        this.pending = undefined;
        return true;
    }
}

function sameCheckpoint(left: TownCheckpointIdentity | undefined, right: TownCheckpointIdentity): boolean {
    return left !== undefined && left.epoch === right.epoch && left.sequence === right.sequence &&
        left.digest === right.digest;
}

function sameRoster(left: readonly TownMatchIdentity[], right: readonly TownMatchIdentity[]): boolean {
    return left.length === right.length &&
        left.every((member) => right.some((other) => other.id === member.id && other.sessionId === member.sessionId));
}

function validateCheckpointTransition(previous: TownMatchState | undefined, next: TownMatchState): readonly string[] {
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
