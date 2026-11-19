import type { GroupRef } from '@shared/api/group-types.ts';

export namespace PollAuthority {
    export type Choice = 'yes' | 'no';
    export interface Schedule {
        readonly opensAtEpochMs: number;
        readonly closesAtEpochMs: number;
    }
    export interface Snapshot {
        readonly roomRef: GroupRef;
        readonly schedule: Schedule;
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
    private readonly schedule: PollAuthority.Schedule;
    private readonly nowEpochMs: () => number;

    constructor(roomRef: GroupRef, schedule: PollAuthority.Schedule, nowEpochMs: () => number) {
        const { opensAtEpochMs, closesAtEpochMs } = schedule;
        if (
            !Number.isSafeInteger(opensAtEpochMs) || opensAtEpochMs < 0 || !Number.isSafeInteger(closesAtEpochMs) ||
            closesAtEpochMs <= opensAtEpochMs
        ) {
            throw new RangeError('Poll epochs must be safe nonnegative integers with opening before closing.');
        }
        this.roomRef = Object.freeze({ ...roomRef });
        this.schedule = Object.freeze({ ...schedule });
        this.nowEpochMs = nowEpochMs;
    }

    vote(principalId: string, choice: PollAuthority.Choice): PollAuthority.Snapshot {
        if (!this.ballots.has(principalId)) {
            const receivedAt = this.nowEpochMs();
            if (receivedAt < this.schedule.opensAtEpochMs) {
                return this.read(principalId);
            }
            const ballot = receivedAt >= this.schedule.closesAtEpochMs ? 'late' : choice;
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
            schedule: this.schedule,
            yes: this.yes,
            no: this.no,
            disposition: ballot === undefined ? 'pending' : ballot === 'late' ? 'late' : 'accepted'
        };
    }
}
