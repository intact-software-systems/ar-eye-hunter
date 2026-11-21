import type { PollAuthority } from './poll-authority.ts';
import { pollPhase, pollResultText } from './poll-phase.ts';

export class PollView {
    private readonly title = document.createElement('h1');
    private readonly opening = document.createElement('time');
    private readonly closing = document.createElement('time');
    readonly extend = document.createElement('button');
    private readonly phase = document.createElement('p');
    private readonly result = document.createElement('p');
    readonly yes = document.createElement('button');
    readonly no = document.createElement('button');

    constructor(root: HTMLElement) {
        this.title.textContent = 'Hold another round?';
        this.extend.textContent = 'Extend voting by one minute';
        this.yes.textContent = 'Yes';
        this.no.textContent = 'No';
        root.replaceChildren(
            this.title,
            this.opening,
            this.closing,
            this.phase,
            this.yes,
            this.no,
            this.extend,
            this.result
        );
    }

    render(input: {
        readonly record: PollAuthority.Snapshot;
        readonly currentPhase: ReturnType<typeof pollPhase> | 'Recovering room poll';
        readonly checkingReceipt: boolean;
        readonly refreshing: boolean;
        readonly submitting: boolean;
        readonly unacknowledged: PollAuthority.Choice | undefined;
        readonly retryAt: number;
    }): void {
        const { record, currentPhase, checkingReceipt, refreshing, submitting, unacknowledged, retryAt } = input;
        this.opening.dateTime = new Date(record.schedule.opensAtEpochMs).toISOString();
        this.opening.textContent = 'Opens at ' + this.opening.dateTime;
        this.closing.dateTime = new Date(record.schedule.closesAtEpochMs).toISOString();
        this.closing.textContent = 'Closes at ' + this.closing.dateTime;
        this.extend.hidden = !record.canExtend;
        this.extend.disabled = !record.canExtend || submitting || refreshing || currentPhase !== 'Voting open';
        this.phase.textContent = currentPhase;
        const disabled = checkingReceipt || refreshing || submitting || currentPhase !== 'Voting open' ||
            record.disposition !== 'pending';
        this.yes.disabled = disabled || unacknowledged === 'no';
        this.no.disabled = disabled || unacknowledged === 'yes';
        this.yes.textContent = unacknowledged === 'yes' ? 'Retry Yes' : 'Yes';
        this.no.textContent = unacknowledged === 'no' ? 'Retry No' : 'No';
        this.result.textContent = pollResultText({
            phase: currentPhase,
            checkingReceipt,
            retryingFinalRead: retryAt > 0 && !refreshing,
            unacknowledged,
            record
        });
    }
}
