import { Either } from '@shared/resilience/Either.ts';

import type { TownMatchIdentity, TownMatchState } from '../town-match.ts';
import {
    sameCheckpoint,
    sameRoster,
    validateCheckpointProposal,
    validateCheckpointTransition
} from './checkpoint-policy.ts';

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
    export interface RecoveryReport {
        readonly checkpoint: TownCheckpoint;
        readonly committed: boolean;
    }
    export interface State {
        readonly authority: TownMatchAuthority;
        readonly pending: Pending | undefined;
        readonly committed: TownCheckpoint | undefined;
        readonly recovered: boolean;
        readonly recoveryRequired: boolean;
        readonly recoveryCheckpoint: TownCheckpoint | undefined;
        readonly retainedProposals: readonly TownCheckpoint[];
    }
}

/** Receives decoded values after transport authentication and digest verification. */
export class TownMatchCheckpoints {
    private readonly localSessionId: string;
    private authority: TownMatchAuthority;
    private pending: TownMatchCheckpoints.Pending | undefined;
    private committed: TownCheckpoint | undefined;
    private recoverySessions = new Set<string>();
    private recoveryRequired = false;
    private retainedProposals: readonly TownCheckpoint[] = [];
    private recoveryCheckpoint: TownCheckpoint | undefined;
    private recoveryCommitWitness = false;
    private resynchronizing = false;

    constructor(authority: TownMatchAuthority, localSessionId: string) {
        this.authority = authority;
        this.localSessionId = localSessionId;
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
            retainedProposals: this.retainedProposals,
            recovered: this.recoveryCommitWitness && recoveryMembers.length >= 2 &&
                recoveryMembers.some((member) => member.sessionId === this.authority.sessionId) &&
                recoveryMembers.every((member) => this.recoverySessions.has(member.sessionId))
        };
    }

    recoveryReport(confirmationStalled: boolean): TownMatchCheckpoints.RecoveryReport | undefined {
        // Peers can observe different roster transitions while holding the same certified state.
        const checkpoint = this.recoveryRequired
            ? this.recoveryCheckpoint
            : confirmationStalled
            ? this.committed
            : undefined;
        return checkpoint ? { checkpoint, committed: checkpoint === this.committed } : undefined;
    }

    propose(checkpoint: TownCheckpoint, senderId: string): Either<string, boolean> {
        const catchingUp = this.resynchronizing && this.localSessionId !== this.authority.sessionId;
        const decision = validateCheckpointProposal({ checkpoint, senderId, state: this.getState(), catchingUp });
        if (!decision.right) {
            return decision;
        }
        this.retainPendingProposal();
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
        this.retainPendingProposal();
        this.recoverySessions.clear();
        this.recoveryCheckpoint = this.recoveryCheckpoint ?? this.committed;
        this.recoveryCommitWitness = false;
        this.recoveryRequired = true;
        return Either.ofRight(true);
    }

    interruptTransport(): void {
        if (this.localSessionId !== this.authority.sessionId) {
            this.retainPendingProposal();
        }
        this.resynchronizing = true;
    }

    recover(senderId: string, checkpoint: TownCheckpointIdentity, committed: boolean): Either<string, boolean> {
        const candidate = [this.recoveryCheckpoint, ...this.retainedProposals].find((retained) =>
            sameCheckpoint(retained, checkpoint)
        );
        if (
            this.authority.members.length < 2 ||
            !this.authority.members.some((member) => member.sessionId === senderId) ||
            !candidate?.state.members.some((member) => member.sessionId === senderId)
        ) {
            return Either.ofLeft('Recovery reports must come from current sessions that held the named checkpoint.');
        }
        if (!sameCheckpoint(this.recoveryCheckpoint, checkpoint)) {
            const previous = this.recoveryCheckpoint;
            if (
                !committed ||
                (previous && (candidate.epoch < previous.epoch ||
                    (candidate.epoch === previous.epoch && candidate.sequence <= previous.sequence))) ||
                validateCheckpointTransition(previous?.state, candidate.state).length > 0
            ) {
                return Either.ofLeft(
                    'Recovery must name committed state or a locally verified proposal with a commit witness.'
                );
            }
            this.recoveryCheckpoint = candidate;
            this.pending = undefined;
            this.recoverySessions.clear();
            this.recoveryCommitWitness = false;
        }
        this.recoverySessions.add(senderId);
        this.recoveryCommitWitness ||= committed;
        return Either.ofRight(this.getState().recovered);
    }

    private retainPendingProposal(): void {
        const pending = this.pending?.checkpoint;
        const latest = this.retainedProposals[0];
        if (
            pending &&
            (!latest || pending.epoch > latest.epoch ||
                (pending.epoch === latest.epoch && pending.sequence > latest.sequence)) &&
            validateCheckpointTransition(latest?.state, pending.state).length === 0
        ) {
            this.retainedProposals = [pending, ...this.retainedProposals].slice(0, 2);
        }
        this.pending = undefined;
    }

    get acknowledgedByAll(): boolean {
        const pending = this.pending;
        return !!pending && this.authority.members.every(member => pending.acknowledgements.includes(member.sessionId));
    }

    private commitAcknowledged(): boolean {
        const pending = this.pending;
        if (!pending?.commitReceived || !this.acknowledgedByAll) {
            return false;
        }
        this.committed = pending.checkpoint;
        this.retainedProposals = [];
        this.recoveryCheckpoint = undefined;
        this.recoveryCommitWitness = false;
        this.recoveryRequired = false;
        this.resynchronizing = false;
        this.pending = undefined;
        return true;
    }
}
