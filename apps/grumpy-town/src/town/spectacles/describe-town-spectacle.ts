import type { TownState } from '../state.ts';

export function describeTownSpectacle(town: TownState, now: number): string | undefined {
    const event = town.spectacles.active;
    if (!event) {
        return undefined;
    }
    const queued = town.spectacles.queue.length ? ` / ${town.spectacles.queue.length} queued` : '';
    if (event.kind === 'fire') {
        return `GRUMPY FIRE CREW: ${
            event.phase === 'cleanup' ? 'packing up' : 'on the way — dodge the hoses!'
        }${queued}`;
    }
    if (event.kind === 'poop') {
        return `${
            event.phase === 'warning'
                ? `BIG STINK IN ${Math.max(0, Math.ceil(event.until - now))}s! Find cover!`
                : 'SPLAT! Water washes it off.'
        }${queued}`;
    }
    return `${
        event.phase === 'warning'
            ? 'THE INSPECTOR LOOKS QUEASY…'
            : event.phase === 'cleanup'
            ? 'ALL THAT… ONE TINY BUCKET.'
            : 'SAVE THE CAKE! Dash the umbrella to redirect.'
    }${queued}`;
}
