import { isSameGroupRef } from '@shared/api/api-type-utils.ts';

import type { PollAuthority } from './poll-authority.ts';
import type { ShowPollInput } from './show-poll.ts';

export class PollServiceUnavailable extends Error {}

export async function requestPollSnapshot(
    input: ShowPollInput,
    signal: AbortSignal,
    update?: {
        readonly previous: PollAuthority.Snapshot;
        readonly action?: PollAuthority.Choice | { readonly expectedRevision: number; };
    }
): Promise<PollAuthority.Snapshot> {
    const action = update?.action;
    const request: RequestInit = {
        method: typeof action === 'object' ? 'PATCH' : action === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${input.participantGrant}` },
        body: typeof action === 'object' ? String(action.expectedRevision) : action,
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)])
    };
    let record: PollAuthority.Snapshot;
    try {
        const response = await fetch(input.endpoint, request);
        if ([502, 503, 504].includes(response.status)) {
            throw new PollServiceUnavailable(`Poll service unavailable (HTTP ${response.status}).`);
        }
        if (!response.ok) {
            throw new Error(`Poll request failed (HTTP ${response.status}).`);
        }
        record = await response.json();
    }
    catch (cause) {
        signal.throwIfAborted();
        if (cause instanceof TypeError || (cause instanceof DOMException && cause.name === 'TimeoutError')) {
            throw new PollServiceUnavailable('The poll service could not complete the request.', { cause });
        }
        throw cause;
    }
    if (!isSameGroupRef(record.roomRef, input.roomRef)) {
        throw new Error('Unexpected poll room.');
    }
    if (update && regressesConfirmedPollState(update.previous, record)) {
        throw new Error('Poll snapshot predates confirmed room state.');
    }
    return record;
}

function regressesConfirmedPollState(previous: PollAuthority.Snapshot, received: PollAuthority.Snapshot): boolean {
    return (received.revision ?? 0) < (previous.revision ?? 0) ||
        received.yes < previous.yes || received.no < previous.no ||
        (previous.closed && !received.closed) ||
        (previous.disposition !== 'pending' && received.disposition !== previous.disposition);
}
