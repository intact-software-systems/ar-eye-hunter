import { rallar } from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { PollAuthority } from './poll-authority.ts';

export interface ShowPollInput {
    readonly root: HTMLElement;
    readonly roomRef: GroupRef;
    readonly endpoint: string;
    readonly participantGrant: string;
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
    async function refreshResults(): Promise<void> {
        refreshing = true;
        try {
            record = await request();
        }
        catch {
            // The view retries while mounted. A failed read cannot confirm a final tally.
        }
        finally {
            refreshing = false;
            retryAt = performance.now() + 2_000;
        }
    }
    function render(): void {
        const opening = rallar.compareDeadline(record.schedule.opensAtEpochMs);
        const closing = rallar.compareDeadline(record.schedule.closesAtEpochMs);
        let label: string;
        if (record.closed) {
            label = 'Voting closed · Results';
        }
        else if (opening === 'unavailable' || closing === 'unavailable') {
            label = 'Waiting for server time';
        }
        else if (closing === 'at-or-after') {
            label = 'Voting closed';
            if (!submitting && !refreshing && performance.now() >= retryAt) {
                void refreshResults();
            }
        }
        else if (opening === 'before') {
            label = 'Question preview';
        }
        else if (opening === 'overlaps' || closing === 'overlaps') {
            label = 'Voting boundary uncertain';
        }
        else {
            label = 'Voting open';
        }
        phase.textContent = label;
        const disabled = record.closed || refreshing || submitting || opening !== 'at-or-after' ||
            closing !== 'before' ||
            record.disposition !== 'pending';
        yes.disabled = disabled;
        no.disabled = disabled;
        if (!record.closed && closing === 'at-or-after') {
            result.textContent = retryAt && !refreshing
                ? 'Final results unavailable · Retrying'
                : 'Loading final results';
            return;
        }
        result.textContent = `Yes ${record.yes} · No ${record.no} · Your vote: ${record.disposition}`;
    }
    async function submit(choice: PollAuthority.Choice): Promise<void> {
        submitting = true;
        render();
        try {
            record = await request(choice);
        }
        catch (error) {
            if (lifetime.signal.aborted) {
                return;
            }
            const message = document.createElement('p');
            message.setAttribute('role', 'alert');
            message.textContent = String(error);
            root.append(message);
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
