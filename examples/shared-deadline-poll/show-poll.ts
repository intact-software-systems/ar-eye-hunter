import type { RallarDeadlineAuthority } from '@shared-web/browser/rallar-connection-facade.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { PollAuthority } from './poll-authority.ts';
import { pollPhase } from './poll-phase.ts';
import { PollView } from './poll-view.ts';
import { requestPollSnapshot } from './request-poll-snapshot.ts';

export interface ShowPollInput {
    readonly root: HTMLElement;
    readonly roomRef: GroupRef;
    readonly endpoint: string;
    readonly participantGrant: string;
    readonly signal?: AbortSignal;
    readonly authority?: RallarDeadlineAuthority;
}

/** Mount after login. The application supplies the URL and a participant grant for this poll alone. */
export async function showPoll(input: ShowPollInput): Promise<() => void> {
    const { root, roomRef } = input;
    const lifetime = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    await rallar.connect({ signal });
    signal.throwIfAborted();
    await rallar.rooms.enter(roomRef, { signal });
    signal.throwIfAborted();
    let record = await requestPollSnapshot(input, signal);
    signal.throwIfAborted();
    const view = new PollView(root);
    const { yes, no, extend } = view;
    let submitting = false;
    let refreshing = false;
    let retryAt = 0;
    let nextRevisionRead = performance.now() + 5_000;
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
                const options = { signal };
                await rallar.connect(options);
                signal.throwIfAborted();
                if (current !== generation) {
                    return;
                }
                await rallar.rooms.enter(roomRef, options);
            }
            const snapshot = await requestPollSnapshot(input, signal);
            signal.throwIfAborted();
            if (current !== generation) {
                return;
            }
            if ((snapshot.revision ?? 0) < (record.revision ?? 0)) {
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
            nextRevisionRead = performance.now() + 5_000;
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
        const revisionDue = record.revision === 0 && !record.closed && performance.now() >= nextRevisionRead;
        const needsSnapshot = restoring || checkingReceipt || currentPhase === 'Voting closed' || revisionDue;
        if (!away && needsSnapshot && !submitting && !refreshing && performance.now() >= retryAt) {
            void refreshSnapshot();
        }
        view.render({ record, currentPhase, checkingReceipt, refreshing, submitting, unacknowledged, retryAt });
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
            record = await requestPollSnapshot(input, signal, choice);
            unacknowledged = undefined;
        }
        catch {
            if (signal.aborted) {
                return;
            }
            unacknowledged = choice;
            checkingReceipt = true;
            retryAt = 0;
        }
        finally {
            submitting = false;
            if (!signal.aborted) {
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
    const listeners = { signal };
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
    extend.onclick = async () => {
        render();
        if (extend.disabled) {
            return;
        }
        submitting = true;
        render();
        try {
            record = await requestPollSnapshot(input, signal, { expectedRevision: 0 });
        }
        catch {
            nextRevisionRead = 0;
            retryAt = 0;
        }
        finally {
            submitting = false;
            if (!signal.aborted) {
                render();
            }
        }
    };
    yes.onclick = () => void submit('yes');
    no.onclick = () => void submit('no');
    render();
    const timer = window.setInterval(render, 200);
    signal.addEventListener('abort', () => {
        window.clearInterval(timer);
        extend.onclick = null;
        yes.onclick = null;
        no.onclick = null;
    }, { once: true });
    return () => lifetime.abort();
}
