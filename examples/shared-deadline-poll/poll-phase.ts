import type { rallar } from '@shared-web/browser/rallar.ts';

import type { PollAuthority } from './poll-authority.ts';

export function pollPhase(record: PollAuthority.Snapshot, clock: Pick<typeof rallar, 'compareDeadline'>) {
    if (record.closed) {
        return 'Voting closed · Results';
    }
    const opening = clock.compareDeadline(record.schedule.opensAtEpochMs);
    const closing = clock.compareDeadline(record.schedule.closesAtEpochMs);
    if (opening === 'unavailable' || closing === 'unavailable') {
        return 'Waiting for server time';
    }
    if (closing === 'at-or-after') {
        return 'Voting closed';
    }
    if (opening === 'before') {
        return 'Question preview';
    }
    if (opening === 'overlaps' || closing === 'overlaps') {
        return 'Voting boundary uncertain';
    }
    return 'Voting open';
}
