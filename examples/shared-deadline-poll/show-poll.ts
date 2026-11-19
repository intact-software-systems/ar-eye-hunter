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
    async function request(choice?: PollAuthority.Choice): Promise<PollAuthority.Snapshot> {
        const response = await fetch(endpoint, {
            method: choice === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${participantGrant}` },
            body: choice,
            cache: 'no-store'
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
    const closing = document.createElement('time');
    closing.dateTime = new Date(record.closesAtEpochMs).toISOString();
    closing.textContent = 'Closes at ' + closing.dateTime;
    const phase = document.createElement('p');
    const result = document.createElement('p');
    const yes = document.createElement('button');
    const no = document.createElement('button');
    yes.textContent = 'Yes';
    no.textContent = 'No';
    root.replaceChildren(title, closing, phase, yes, no, result);
    let submitting = false;
    const labels = {
        before: 'Voting open',
        overlaps: 'Voting is closing',
        'at-or-after': 'Voting closed',
        unavailable: 'Waiting for server time'
    };
    function render(): void {
        const comparison = rallar.compareDeadline(record.closesAtEpochMs);
        phase.textContent = labels[comparison];
        const disabled = submitting || comparison !== 'before' || record.disposition !== 'pending';
        yes.disabled = disabled;
        no.disabled = disabled;
        result.textContent = `Yes ${record.yes} · No ${record.no} · Your vote: ${record.disposition}`;
    }
    async function submit(choice: PollAuthority.Choice): Promise<void> {
        submitting = true;
        render();
        try {
            record = await request(choice);
        }
        catch (error) {
            const message = document.createElement('p');
            message.setAttribute('role', 'alert');
            message.textContent = String(error);
            root.append(message);
        }
        finally {
            submitting = false;
            render();
        }
    }
    yes.onclick = () => void submit('yes');
    no.onclick = () => void submit('no');
    render();
    const timer = window.setInterval(render, 200);
    return () => window.clearInterval(timer);
}
