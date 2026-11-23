import type { RallarDeadlineAuthority } from '@shared-web/browser/rallar-connection-facade.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { loadPollOnEntry } from './load-poll-on-entry.ts';
import { pollDeadlineName, type PollAuthority } from './poll-authority.ts';
import { pollPhase } from './poll-phase.ts';
import { PollView } from './poll-view.ts';
import { requestPollSnapshot } from './request-poll-snapshot.ts';

export interface ShowPollInput {
    readonly root: HTMLElement;
    readonly roomRef: GroupRef;
    readonly endpoint: string;
    readonly deadlineSource: 'room' | 'fixed';
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
    let record = await loadPollOnEntry(input, signal);
    signal.throwIfAborted();
    const view = new PollView(root);
    const { yes, no, extend } = view;
    let submitting = false;
    let activeRefresh: AbortController | undefined;
    let retryAt = 0;
    let deadlineStale = false;
    let watchedRevision = 0;
    let extensionUnconfirmed = false;
    let unacknowledged: PollAuthority.Choice | undefined;
    let checkingReceipt = false;
    let away = document.visibilityState === 'hidden';
    let needsRoomEntry = away;
    function invalidateRoomEntry(): void {
        needsRoomEntry = true;
        activeRefresh?.abort();
        activeRefresh = undefined;
    }
    async function refreshSnapshot(): Promise<void> {
        const attempt = new AbortController();
        activeRefresh = attempt;
        const refreshSignal = AbortSignal.any([signal, attempt.signal]);
        try {
            if (needsRoomEntry) {
                const options = { signal: refreshSignal };
                await rallar.connect(options);
                refreshSignal.throwIfAborted();
                await rallar.rooms.enter(roomRef, options);
            }
            const snapshot = await requestPollSnapshot(input, refreshSignal, { previous: record });
            refreshSignal.throwIfAborted();
            needsRoomEntry = false;
            extensionUnconfirmed = false;
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
            if (activeRefresh === attempt) {
                activeRefresh = undefined;
                retryAt = performance.now() + 2_000;
            }
        }
    }
    function render(): void {
        if (signal.aborted) {
            return;
        }
        let currentPhase: ReturnType<typeof pollPhase> | 'Recovering room poll' = away || needsRoomEntry
            ? 'Recovering room poll'
            : pollPhase(record, rallar, input.authority);
        if (currentPhase === 'Waiting for server time') {
            invalidateRoomEntry();
            currentPhase = 'Recovering room poll';
        }
        const restoring = currentPhase === 'Recovering room poll';
        const revisionDue = watchedRevision > (record.revision ?? 0);
        const needsSnapshot = restoring || checkingReceipt || extensionUnconfirmed ||
            currentPhase === 'Voting closed' || revisionDue;
        if (!away && needsSnapshot && !submitting && !activeRefresh && performance.now() >= retryAt) {
            void refreshSnapshot();
        }
        if (deadlineStale || revisionDue || extensionUnconfirmed) {
            currentPhase = 'Recovering room poll';
        }
        view.render({ record, currentPhase, checkingReceipt, refreshing: activeRefresh !== undefined, submitting, unacknowledged, retryAt });
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
            record = await requestPollSnapshot(input, signal, { previous: record, action: choice });
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
            render();
        }
    }
    function suspend(): void {
        away = true;
        invalidateRoomEntry();
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
    if (input.deadlineSource === 'room') {
        rallar.rooms.watchDeadline(roomRef, pollDeadlineName, observation => {
            deadlineStale = observation.status === 'stale' || observation.deadline === null;
            watchedRevision = observation.deadline?.revision ?? 0;
            retryAt = 0;
            render();
        }, { signal });
    }
    const extensionRequestId = crypto.randomUUID();
    extend.onclick = async () => {
        render();
        if (extend.disabled || record.revision === null) {
            return;
        }
        submitting = true;
        render();
        try {
            await rallar.rooms.setDeadline(
                roomRef,
                {
                    name: pollDeadlineName,
                    expectedRevision: record.revision,
                    atEpochMs: record.schedule.closesAtEpochMs + 60_000
                },
                extensionRequestId,
                { signal }
            );
            record = await requestPollSnapshot(input, signal, { previous: record });
        }
        catch {
            extensionUnconfirmed = true;
            retryAt = 0;
        }
        finally {
            submitting = false;
            render();
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
