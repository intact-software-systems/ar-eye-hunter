import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { requireEpoch, requireRecord } from '@shared/api/exact-object-decoding.ts';
import { assertValidRallarGroupRef } from '@shared/api/rallar-validation.ts';

import { pollDeadlineName, type PollAuthority } from './poll-authority.ts';
import type { ShowPollInput } from './show-poll.ts';

export class PollServiceUnavailable extends Error {}

export async function requestPollSnapshot(
    input: ShowPollInput,
    signal: AbortSignal,
    update?: {
        readonly previous: PollAuthority.Snapshot;
        readonly action?: PollAuthority.Choice;
    }
): Promise<PollAuthority.Snapshot> {
    const action = update?.action;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
    const request: RequestInit = {
        method: action === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${input.participantGrant}` },
        body: action,
        cache: 'no-store',
        signal: requestSignal
    };
    function decodeRequestFailure(cause: unknown): never {
        signal.throwIfAborted();
        if (
            cause instanceof TypeError || (cause instanceof DOMException && cause.name === 'TimeoutError') ||
            (cause instanceof ApiHttpError && [502, 503, 504].includes(cause.status))
        ) {
            throw new PollServiceUnavailable('The poll service could not complete the request.', { cause });
        }
        throw cause instanceof Error ? cause : new Error('Poll request failed.', { cause });
    }

    const response = await fetch(input.endpoint, request).catch(decodeRequestFailure);
    if ([502, 503, 504].includes(response.status)) {
        throw new PollServiceUnavailable(`Poll service unavailable (HTTP ${response.status}).`);
    }
    if (!response.ok) {
        throw new Error(`Poll request failed (HTTP ${response.status}).`);
    }
    const record = decodePollSnapshot(await response.json().catch(decodeRequestFailure));
    if (!isSameGroupRef(record.roomRef, input.roomRef)) {
        throw new Error('Unexpected poll room.');
    }
    if ((record.revision === null) !== (input.deadlineSource === 'fixed')) {
        throw new Error('Unexpected deadline source for the selected poll.');
    }
    if (input.deadlineSource === 'room') {
        const deadline = await rallar.rooms.readDeadline(input.roomRef, pollDeadlineName, { signal: requestSignal })
            .catch(decodeRequestFailure);
        if (
            !deadline || deadline.revision !== record.revision || deadline.atEpochMs !== record.schedule.closesAtEpochMs
        ) {
            throw new PollServiceUnavailable('The ballot snapshot and the room deadline disagree. Read again.');
        }
    }
    if (update && regressesConfirmedPollState(update.previous, record)) {
        throw new Error('Poll snapshot predates confirmed room state.');
    }
    return record;
}

function regressesConfirmedPollState(previous: PollAuthority.Snapshot, received: PollAuthority.Snapshot): boolean {
    const sameRevision = received.revision === previous.revision;
    const previousCutoff = previous.schedule.closesAtEpochMs;
    const receivedCutoff = received.schedule.closesAtEpochMs;
    return (received.revision ?? 0) < (previous.revision ?? 0) ||
        received.schedule.opensAtEpochMs !== previous.schedule.opensAtEpochMs ||
        (sameRevision ? receivedCutoff !== previousCutoff : receivedCutoff <= previousCutoff) ||
        received.yes < previous.yes || received.no < previous.no ||
        (previous.closed && !received.closed && sameRevision) ||
        (previous.disposition !== 'pending' && received.disposition !== previous.disposition);
}

function decodePollSnapshot(body: unknown): PollAuthority.Snapshot {
    const record = requireRecord(body, 'Poll snapshot');
    const roomRef = assertValidRallarGroupRef(record.roomRef);
    const { opensAtEpochMs, closesAtEpochMs } = requireRecord(record.schedule, 'Poll schedule');
    requireEpoch(opensAtEpochMs, 'Voting opening');
    requireEpoch(closesAtEpochMs, 'Voting cutoff');
    const { yes, no, closed, canExtend, disposition, revision } = record;
    requireEpoch(yes, 'Yes votes');
    requireEpoch(no, 'No votes');
    if (revision !== null) {
        requireEpoch(revision, 'Room deadline revision');
    }
    if (
        closesAtEpochMs <= opensAtEpochMs || revision === 0 || typeof closed !== 'boolean' ||
        typeof canExtend !== 'boolean' || (canExtend && (closed || revision !== 1)) ||
        (disposition !== 'pending' && disposition !== 'accepted' && disposition !== 'late')
    ) {
        throw new Error('Invalid poll snapshot.');
    }
    return {
        roomRef,
        schedule: { opensAtEpochMs, closesAtEpochMs },
        yes,
        no,
        closed,
        canExtend,
        disposition,
        revision
    };
}
