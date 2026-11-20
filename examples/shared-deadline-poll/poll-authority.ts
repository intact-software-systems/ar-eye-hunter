import type { GroupRef } from '@shared/api/group-types.ts';
import type { RoomDeadline } from '@shared/api/group-deadlines/room-deadline.ts';

export const pollDeadlineName = 'voting-close';

export namespace PollAuthority {
    export type Choice = 'yes' | 'no';
    export interface Schedule {
        readonly opensAtEpochMs: number;
        readonly closesAtEpochMs: number;
    }
    export interface RoomSchedule {
        readonly opensAtEpochMs: number;
        readonly hostId: string;
        readDeadline(roomRef: GroupRef, name: string): Promise<RoomDeadline | null>;
    }
    export interface Snapshot {
        readonly roomRef: GroupRef;
        readonly schedule: Schedule;
        readonly revision: number | null;
        readonly canExtend: boolean;
        readonly closed: boolean;
        readonly yes: number;
        readonly no: number;
        readonly disposition: 'pending' | 'accepted' | 'late';
    }
}

/** One process owns this poll. The calling route supplies the authorized room member's principal. */
export class PollAuthority {
    private readonly ballots = new Map<string, PollAuthority.Choice | 'late'>();
    private closed = false;
    private yes = 0;
    private no = 0;
    private readonly roomRef: GroupRef;
    private readonly schedule: PollAuthority.Schedule | PollAuthority.RoomSchedule;
    private readonly nowEpochMs: () => number;
    private priorDecision: Promise<void> = Promise.resolve();
    private observedRevision = 0;

    constructor(
        roomRef: GroupRef,
        schedule: PollAuthority.Schedule | PollAuthority.RoomSchedule,
        nowEpochMs: () => number
    ) {
        if (!Number.isSafeInteger(schedule.opensAtEpochMs) || schedule.opensAtEpochMs < 0) {
            throw new RangeError('Poll opening must be a nonnegative epoch.');
        }
        if ('closesAtEpochMs' in schedule) {
            validateClosing(schedule.opensAtEpochMs, schedule.closesAtEpochMs);
        }
        this.roomRef = Object.freeze({ ...roomRef });
        this.schedule = Object.freeze({ ...schedule });
        this.nowEpochMs = nowEpochMs;
    }

    async vote(principalId: string, choice: PollAuthority.Choice): Promise<PollAuthority.Snapshot> {
        return await this.enqueue(principalId, choice);
    }

    async read(principalId: string): Promise<PollAuthority.Snapshot> {
        return await this.enqueue(principalId);
    }

    private enqueue(principalId: string, choice?: PollAuthority.Choice): Promise<PollAuthority.Snapshot> {
        const receivedAt = this.nowEpochMs();
        const decision = this.priorDecision.then(() => this.decide(principalId, receivedAt, choice));
        // Each caller receives its own failure. The next ballot can still read fresh authority.
        this.priorDecision = decision.then(() => {}, () => {});
        return decision;
    }

    private async decide(
        principalId: string,
        receivedAt: number,
        choice?: PollAuthority.Choice
    ): Promise<PollAuthority.Snapshot> {
        const { opensAtEpochMs } = this.schedule;
        let closesAtEpochMs: number;
        let revision: number | null = null;
        let canExtend = false;
        if ('readDeadline' in this.schedule) {
            const deadline = await this.schedule.readDeadline(this.roomRef, pollDeadlineName);
            if (!deadline || deadline.name !== pollDeadlineName || deadline.revision < this.observedRevision) {
                throw new Error('The current room voting deadline is unavailable.');
            }
            validateClosing(opensAtEpochMs, deadline.atEpochMs);
            closesAtEpochMs = deadline.atEpochMs;
            revision = deadline.revision;
            if (revision > this.observedRevision) {
                this.closed = false;
                this.observedRevision = revision;
            }
            canExtend = this.schedule.hostId === principalId && revision === 1;
        }
        else {
            closesAtEpochMs = this.schedule.closesAtEpochMs;
        }

        this.closed ||= receivedAt >= closesAtEpochMs;
        if (choice && !this.ballots.has(principalId) && (this.closed || receivedAt >= opensAtEpochMs)) {
            const ballot = this.closed ? 'late' : choice;
            this.ballots.set(principalId, ballot);
            if (ballot === 'yes') {
                this.yes++;
            }
            if (ballot === 'no') {
                this.no++;
            }
        }
        const ballot = this.ballots.get(principalId);
        return {
            roomRef: this.roomRef,
            schedule: { opensAtEpochMs, closesAtEpochMs },
            closed: this.closed,
            revision,
            canExtend: canExtend && !this.closed,
            yes: this.yes,
            no: this.no,
            disposition: ballot === undefined ? 'pending' : ballot === 'late' ? 'late' : 'accepted'
        };
    }
}

function validateClosing(opensAtEpochMs: number, closesAtEpochMs: number): void {
    if (!Number.isSafeInteger(closesAtEpochMs) || closesAtEpochMs <= opensAtEpochMs) {
        throw new RangeError('Poll closing must be a safe epoch after opening.');
    }
}
