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

export function pollResultText(input: {
    readonly phase: ReturnType<typeof pollPhase> | 'Recovering room poll';
    readonly checkingReceipt: boolean;
    readonly retryingFinalRead: boolean;
    readonly unacknowledged: PollAuthority.Choice | undefined;
    readonly record: PollAuthority.Snapshot;
}): string {
    if (input.phase === 'Recovering room poll') {
        return 'Waiting for the current room snapshot';
    }
    if (input.checkingReceipt) {
        return 'Checking your vote with the poll authority';
    }
    if (input.phase === 'Voting closed') {
        return input.retryingFinalRead ? 'Final results unavailable · Retrying' : 'Loading final results';
    }
    if (input.unacknowledged) {
        return 'The authority has no receipt yet for your vote.';
    }
    const { yes, no, disposition } = input.record;
    return `Yes ${yes} · No ${no} · Your vote: ${disposition}`;
}
