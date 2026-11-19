import { isSameGroupRef } from '@shared/api/api-type-utils.ts';

import type { PollAuthority } from './poll-authority.ts';
import type { ShowPollInput } from './show-poll.ts';

export async function requestPollSnapshot(
    input: ShowPollInput,
    signal: AbortSignal,
    choice?: PollAuthority.Choice
): Promise<PollAuthority.Snapshot> {
    const response = await fetch(input.endpoint, {
        method: choice === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${input.participantGrant}` },
        body: choice,
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)])
    });
    if (!response.ok) {
        throw new Error(`Poll request failed (HTTP ${response.status}).`);
    }
    const record: PollAuthority.Snapshot = await response.json();
    if (!isSameGroupRef(record.roomRef, input.roomRef)) {
        throw new Error('Unexpected poll room.');
    }
    return record;
}
