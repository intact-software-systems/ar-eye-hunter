import { rallar, type RoomClockCommand, type RoomClockObservation } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

const entry = document.querySelector<HTMLFormElement>('#entry')!;
const board = document.querySelector<HTMLElement>('#board')!;
const output = board.querySelector('output')!;
const phase = board.querySelector<HTMLElement>('#phase')!;
const appoint = board.querySelector<HTMLButtonElement>('#appoint')!;
const change = board.querySelector<HTMLButtonElement>('#change')!;
const error = document.querySelector<HTMLElement>('[role="alert"]')!;
const scope = { applicationId: 'room-scoreboard', workspaceId: 'default' };
rallar.configure({ apiBaseUrl: import.meta.env.VITE_RALLAR_API_BASE_URL ?? 'http://localhost:8080' });
rallar.setDefaults(scope);
let room: GroupRef | undefined;
let state: RoomClockObservation = { status: 'stale', clock: null };
let busy = false;
let retry: { command: RoomClockCommand; id: string; } | undefined;

function display(ms: number): string {
    const seconds = Math.ceil(ms / 1000);
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function render() {
    if (!room) {
        return;
    }
    const director = rallar.director.status(room);
    const clock = state.clock;
    const boundary = clock?.status === 'running' ? rallar.compareDeadline(clock.endsAtEpochMs) : undefined;
    const now = rallar.deadlineAfter(0);
    const expired = boundary === 'at-or-after';
    phase.textContent = state.status === 'stale' ? 'Recovering clock' : !clock
        ? 'Ready'
        : clock.status === 'paused'
        ? 'Paused'
        : expired
        ? 'Time expired'
        : boundary === 'unavailable' || boundary === 'overlaps'
        ? 'Waiting for server time'
        : 'Running';
    output.value = clock?.status === 'paused' ? display(clock.remainingMs) : !clock
        ? '10:00'
        : expired
        ? '0:00'
        : now === undefined || boundary !== 'before'
        ? '—'
        : display(Math.max(0, clock.endsAtEpochMs - now));
    appoint.hidden = director.isDirector;
    appoint.disabled = busy;
    change.textContent = !clock || expired ? 'Start 10 minutes' : clock.status === 'paused' ? 'Resume' : 'Pause';
    change.disabled = busy || state.status !== 'current' || !director.isFresh || !director.isDirector ||
        boundary === 'unavailable' || boundary === 'overlaps';
}

async function perform(action: () => Promise<void>) {
    if (busy) {
        return;
    }
    busy = true;
    error.textContent = '';
    render();
    try {
        await action();
    }
    catch (reason) {
        error.textContent = reason instanceof Error ? reason.message : String(reason);
    }
    finally {
        busy = false;
        render();
    }
}

entry.onsubmit = (event) => {
    event.preventDefault();
    const create = (event.submitter as HTMLButtonElement).value === 'create';
    const fields = new FormData(entry);
    void perform(async () => {
        if (!rallar.session()) {
            await rallar.auth.login({
                username: String(fields.get('username')),
                password: String(fields.get('password'))
            });
        }
        await rallar.connect();
        const groupId = String(fields.get('room'));
        const target = { ...scope, groupId };
        if (create) {
            await rallar.rooms.createAndSwitch({ groupId, displayName: groupId, joinMode: 'open' });
        }
        else {
            await rallar.rooms.enter(target);
        }
        room = target;
        entry.hidden = true;
        board.hidden = false;
        board.querySelector('h2')!.textContent = groupId;
        rallar.rooms.watchClock(target, 'period', (current) => {
            state = current;
            render();
        });
        window.setInterval(render, 250);
    });
};
appoint.onclick = () => {
    if (room) {
        void perform(async () => {
            await rallar.director.appoint(room!);
        });
    }
};
change.onclick = () => {
    render();
    if (!room || change.disabled) {
        return;
    }
    const target = room;
    const director = rallar.director.status(target);
    if (!director.appointment || !director.isDirector) {
        return;
    }
    const clock = state.clock;
    const base = {
        name: 'period',
        expectedRevision: clock?.revision ?? 0,
        expectedDirectorEpoch: director.appointment.epoch
    };
    const command: RoomClockCommand =
        !clock || (clock.status === 'running' && rallar.compareDeadline(clock.endsAtEpochMs) === 'at-or-after')
            ? { ...base, operation: 'start', durationMs: 600_000 }
            : { ...base, operation: clock.status === 'paused' ? 'resume' : 'pause' };
    if (!retry || JSON.stringify(command) !== JSON.stringify(retry.command)) {
        retry = { command, id: crypto.randomUUID() };
    }
    const request = retry;
    void perform(async () => {
        await rallar.rooms.changeClock(target, request.command, request.id);
    });
};
