import type { GroupRef } from '@shared/api/group-types.ts';

export namespace PollAuthority {
    export type Choice = 'yes' | 'no';
    export interface Snapshot {
        readonly roomRef: GroupRef;
        readonly closesAtEpochMs: number;
        readonly yes: number;
        readonly no: number;
        readonly disposition: 'pending' | 'accepted' | 'late';
    }
}

/** One process owns this poll. The calling route supplies the authorized room member's principal. */
export class PollAuthority {
    private readonly ballots = new Map<string, PollAuthority.Choice | 'late'>();
    private yes = 0;
    private no = 0;
    private readonly roomRef: GroupRef;
    private readonly closesAtEpochMs: number;
    private readonly nowEpochMs: () => number;

    constructor(roomRef: GroupRef, closesAtEpochMs: number, nowEpochMs: () => number) {
        if (!Number.isSafeInteger(closesAtEpochMs) || closesAtEpochMs < 0) {
            throw new RangeError('Poll closing time must be a nonnegative integer epoch in milliseconds.');
        }
        this.roomRef = Object.freeze({ ...roomRef });
        this.closesAtEpochMs = closesAtEpochMs;
        this.nowEpochMs = nowEpochMs;
    }

    vote(principalId: string, choice: PollAuthority.Choice): PollAuthority.Snapshot {
        if (!this.ballots.has(principalId)) {
            const ballot = this.nowEpochMs() >= this.closesAtEpochMs ? 'late' : choice;
            this.ballots.set(principalId, ballot);
            if (ballot === 'yes') {
                this.yes++;
            }
            if (ballot === 'no') {
                this.no++;
            }
        }
        return this.read(principalId);
    }

    read(principalId: string): PollAuthority.Snapshot {
        const ballot = this.ballots.get(principalId);
        return {
            roomRef: this.roomRef,
            closesAtEpochMs: this.closesAtEpochMs,
            yes: this.yes,
            no: this.no,
            disposition: ballot === undefined ? 'pending' : ballot === 'late' ? 'late' : 'accepted'
        };
    }
}
