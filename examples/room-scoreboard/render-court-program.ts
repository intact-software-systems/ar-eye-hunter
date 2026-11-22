import { rallar, type RoomSchedule } from '@shared-web/browser/rallar.ts';

export function renderCourtProgram(program: HTMLElement, schedule: RoomSchedule.Observation) {
    program.hidden = !schedule.schedule;
    if (!schedule.schedule) return;
    const position = rallar.schedulePosition(schedule.schedule);
    if (schedule.status === 'stale') program.textContent = 'Recovering schedule';
    else if (position.status === 'paused') program.textContent = (position.current?.phase ?? 'Upcoming') + ' · Paused';
    else if (position.status !== 'current') program.textContent = 'Waiting for server time';
    else {
        const current = position.current?.phase ?? 'Upcoming';
        program.textContent = position.next
            ? current + ' · Next: ' + position.next.phase + ' at ' + new Date(position.next.startsAtEpochMs).toISOString()
            : current;
    }
}
