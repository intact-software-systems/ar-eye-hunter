import type { RallarDeadlineAuthority } from '@shared-web/browser/rallar-connection-facade.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { PollAuthority } from './poll-authority.ts';
import { pollPhase, pollResultText } from './poll-phase.ts';
import { requestPollSnapshot } from './request-poll-snapshot.ts';

export interface ShowPollInput {
    readonly root: HTMLElement;
    readonly roomRef: GroupRef;
    readonly endpoint: string;
    readonly participantGrant: string;
    readonly authority?: RallarDeadlineAuthority;
}

/** Mount after login. The application supplies the URL and a participant grant for this poll alone. */
export async function showPoll(input: ShowPollInput): Promise<() => void> {
    const { root, roomRef } = input;
    await rallar.connect();
    await rallar.rooms.enter(roomRef);
    const lifetime = new AbortController();
    let record = await requestPollSnapshot(input, lifetime.signal);
    const title = document.createElement('h1');
    title.textContent = 'Hold another round?';
    const opening = document.createElement('time');
    opening.dateTime = new Date(record.schedule.opensAtEpochMs).toISOString();
    opening.textContent = 'Opens at ' + opening.dateTime;
    const closing = document.createElement('time');
    closing.dateTime = new Date(record.schedule.closesAtEpochMs).toISOString();
    closing.textContent = 'Closes at ' + closing.dateTime;
    const phase = document.createElement('p');
    const result = document.createElement('p');
    const yes = document.createElement('button');
    const no = document.createElement('button');
    yes.textContent = 'Yes';
    no.textContent = 'No';
    root.replaceChildren(title, opening, closing, phase, yes, no, result);
    let submitting = false;
    let refreshing = false;
    let retryAt = 0;
    let unacknowledged: PollAuthority.Choice | undefined;
    let checkingReceipt = false;
    let away = document.visibilityState === 'hidden';
    let generation = away ? 1 : 0;
    let restored = 0;
    async function refreshSnapshot(): Promise<void> {
        refreshing = true;
        const current = generation;
        try {
            if (restored !== current) {
                const options = { signal: lifetime.signal };
                await rallar.connect(options);
                if (current !== generation || lifetime.signal.aborted) {
                    return;
                }
                await rallar.rooms.enter(roomRef, options);
            }
            const snapshot = await requestPollSnapshot(input, lifetime.signal);
            if (current !== generation || lifetime.signal.aborted) {
                return;
            }
            restored = current;
            record = snapshot;
            checkingReceipt = false;
            if (record.closed || record.disposition !== 'pending') {
                unacknowledged = undefined;
            }
        }
        catch {
            // A failed read leaves the receipt or closing tally unresolved.
        }
        finally {
            refreshing = false;
            retryAt = performance.now() + 2_000;
        }
    }
    function render(): void {
        let currentPhase: ReturnType<typeof pollPhase> | 'Recovering room poll' = away || restored !== generation
            ? 'Recovering room poll'
            : pollPhase(record, rallar, input.authority);
        if (currentPhase === 'Waiting for server time') {
            generation++;
            currentPhase = 'Recovering room poll';
        }
        const restoring = currentPhase === 'Recovering room poll';
        const needsSnapshot = restoring || checkingReceipt || currentPhase === 'Voting closed';
        if (!away && needsSnapshot && !submitting && !refreshing && performance.now() >= retryAt) {
            void refreshSnapshot();
        }
        phase.textContent = currentPhase;
        const disabled = checkingReceipt || refreshing || submitting || currentPhase !== 'Voting open' ||
            record.disposition !== 'pending';
        yes.disabled = disabled || unacknowledged === 'no';
        no.disabled = disabled || unacknowledged === 'yes';
        yes.textContent = unacknowledged === 'yes' ? 'Retry Yes' : 'Yes';
        no.textContent = unacknowledged === 'no' ? 'Retry No' : 'No';
        result.textContent = pollResultText({
            phase: currentPhase,
            checkingReceipt,
            retryingFinalRead: retryAt > 0 && !refreshing,
            unacknowledged,
            record
        });
    }
    async function submit(choice: PollAuthority.Choice): Promise<void> {
        render();
        const button = choice === 'yes' ? yes : no;
        if (button.disabled) {
            return;
        }
        submitting = true;
        render();
        try {
            record = await requestPollSnapshot(input, lifetime.signal, choice);
            unacknowledged = undefined;
        }
        catch {
            if (lifetime.signal.aborted) {
                return;
            }
            unacknowledged = choice;
            checkingReceipt = true;
            retryAt = 0;
        }
        finally {
            submitting = false;
            if (!lifetime.signal.aborted) {
                render();
            }
        }
    }
    function suspend(): void {
        generation++;
        away = true;
        render();
    }
    function resume(): void {
        away = document.visibilityState === 'hidden';
        retryAt = 0;
        render();
    }
    const listeners = { signal: lifetime.signal };
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            suspend();
        }
        else {
            resume();
        }
    }, listeners);
    document.addEventListener('freeze', suspend, listeners);
    document.addEventListener('resume', resume, listeners);
    window.addEventListener('pagehide', suspend, listeners);
    window.addEventListener('pageshow', resume, listeners);
    yes.onclick = () => void submit('yes');
    no.onclick = () => void submit('no');
    render();
    const timer = window.setInterval(render, 200);
    return () => {
        window.clearInterval(timer);
        yes.onclick = null;
        no.onclick = null;
        lifetime.abort();
    };
}
