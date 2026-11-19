import type { RallarDeadlineAuthority } from '@shared-web/browser/rallar-connection-facade.ts';
import type { rallar } from '@shared-web/browser/rallar.ts';

import type { PollAuthority } from './poll-authority.ts';

export function pollPhase(
    record: PollAuthority.Snapshot,
    clock: Pick<typeof rallar, 'compareDeadline'>,
    authority?: RallarDeadlineAuthority
) {
    if (record.closed) {
        return 'Voting closed · Results';
    }
    const opening = clock.compareDeadline(record.schedule.opensAtEpochMs, authority);
    const closing = clock.compareDeadline(record.schedule.closesAtEpochMs, authority);
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
