import type { RallarDeadlineAuthority } from '@shared-web/browser/rallar-connection-facade.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { PollAuthority } from './poll-authority.ts';
import { pollPhase } from './poll-phase.ts';

export interface ShowPollInput {
    readonly root: HTMLElement;
    readonly roomRef: GroupRef;
    readonly endpoint: string;
    readonly participantGrant: string;
    readonly authority?: RallarDeadlineAuthority;
}

/** Mount after login. The application supplies the URL and a participant grant for this poll alone. */
export async function showPoll(input: ShowPollInput): Promise<() => void> {
    const { root, roomRef, endpoint, participantGrant } = input;
    await rallar.connect();
    await rallar.rooms.enter(roomRef);
    const lifetime = new AbortController();
    async function request(choice?: PollAuthority.Choice): Promise<PollAuthority.Snapshot> {
        const response = await fetch(endpoint, {
            method: choice === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${participantGrant}` },
            body: choice,
            cache: 'no-store',
            signal: lifetime.signal
        });
        if (!response.ok) {
            throw new Error(`Poll request failed (HTTP ${response.status}).`);
        }
        const record: PollAuthority.Snapshot = await response.json();
        if (!isSameGroupRef(record.roomRef, roomRef)) {
            throw new Error('Unexpected poll room.');
        }
        return record;
    }
    let record = await request();
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
    async function refreshSnapshot(): Promise<void> {
        refreshing = true;
        try {
            record = await request();
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
        const currentPhase = pollPhase(record, rallar, input.authority);
        const needsSnapshot = checkingReceipt || currentPhase === 'Voting closed';
        if (needsSnapshot && !submitting && !refreshing && performance.now() >= retryAt) {
            void refreshSnapshot();
        }
        phase.textContent = currentPhase;
        const disabled = checkingReceipt || refreshing || submitting || currentPhase !== 'Voting open' ||
            record.disposition !== 'pending';
        yes.disabled = disabled || unacknowledged === 'no';
        no.disabled = disabled || unacknowledged === 'yes';
        yes.textContent = unacknowledged === 'yes' ? 'Retry Yes' : 'Yes';
        no.textContent = unacknowledged === 'no' ? 'Retry No' : 'No';
        if (checkingReceipt) {
            result.textContent = 'Checking your vote with the poll authority';
            return;
        }
        if (currentPhase === 'Voting closed') {
            result.textContent = retryAt && !refreshing
                ? 'Final results unavailable · Retrying'
                : 'Loading final results';
            return;
        }
        if (unacknowledged) {
            result.textContent = 'The authority has no receipt yet for your vote.';
            return;
        }
        result.textContent = `Yes ${record.yes} · No ${record.no} · Your vote: ${record.disposition}`;
    }
    async function submit(choice: PollAuthority.Choice): Promise<void> {
        submitting = true;
        render();
        try {
            record = await request(choice);
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
