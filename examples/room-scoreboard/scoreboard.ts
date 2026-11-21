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

function clockFace(): { label: string; time: string; action?: RoomClockCommand['operation']; } {
    const clock = state.clock;
    if (state.status === 'stale') {
        return { label: 'Recovering clock', time: '—' };
    }
    if (!clock) {
        return { label: 'Ready', time: '10:00', action: 'start' };
    }
    if (clock.status === 'paused') {
        return { label: 'Paused', time: display(clock.remainingMs), action: 'resume' };
    }
    const boundary = rallar.compareDeadline(clock.endsAtEpochMs);
    if (boundary === 'at-or-after') {
        return { label: 'Time expired', time: '0:00', action: 'start' };
    }
    const now = rallar.deadlineAfter(0);
    if (now === undefined || boundary !== 'before') {
        return { label: 'Waiting for server time', time: '—' };
    }
    return { label: 'Running', time: display(Math.max(0, clock.endsAtEpochMs - now)), action: 'pause' };
}

const labels = { start: 'Start 10 minutes', pause: 'Pause', resume: 'Resume' };

function render() {
    if (!room) {
        return;
    }
    const director = rallar.director.status(room);
    const face = clockFace();
    phase.textContent = face.label;
    output.value = face.time;
    appoint.hidden = director.isDirector;
    appoint.disabled = busy;
    change.hidden = !face.action;
    change.textContent = face.action ? labels[face.action] : '';
    change.disabled = busy || !face.action || !director.active || !director.isDirector;
    return change.disabled ? undefined : face.action;
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
    const action = render();
    if (!room || !action) {
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
    const command: RoomClockCommand = action === 'start'
        ? { ...base, operation: action, durationMs: 600_000 }
        : { ...base, operation: action };
    if (!retry || JSON.stringify(command) !== JSON.stringify(retry.command)) {
        retry = { command, id: crypto.randomUUID() };
    }
    const request = retry;
    void perform(async () => {
        await rallar.rooms.changeClock(target, request.command, request.id);
    });
};
