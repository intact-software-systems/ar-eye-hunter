import type { ArenaEvent } from '../../types.ts';

/**
 * The headline after a remote snapshot or director event: the local session's own event, such as a pickup it lost,
 * holds until it expires, since the event that would replace it is usually the winner's own.
 */
export function resolveArenaActiveEvent(
    current: ArenaEvent | undefined,
    next: ArenaEvent | undefined,
    nowEpochMs: number
): ArenaEvent | undefined {
    return current?.source === 'local' && current.expiresAtEpochMs > nowEpochMs ? current : next;
}
