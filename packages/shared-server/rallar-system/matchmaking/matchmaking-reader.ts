import type { MatchmakingSnapshot, MatchmakingState } from '@shared/api/matchmaking/matchmaking-snapshot.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { MatchmakingRepository } from './matchmaking-repository.ts';

export namespace MatchmakingReader {
    export interface Account {
        readonly scope: StateScope;
        readonly principalId: string;
    }
}

/** Projects one account's durable state. Reading a late deadline does not mutate the pool. */
export class MatchmakingReader {
    private readonly repository: Pick<MatchmakingRepository, 'readCurrent'>;
    private readonly nowEpochMs: () => number;

    constructor(repository: Pick<MatchmakingRepository, 'readCurrent'>, nowEpochMs: () => number) {
        this.repository = repository;
        this.nowEpochMs = nowEpochMs;
    }

    async read(account: MatchmakingReader.Account): Promise<MatchmakingSnapshot> {
        const nowEpochMs = this.nowEpochMs();
        const current = await this.repository.readCurrent({ ...account, nowEpochMs });
        return { ...account, observedAtEpochMs: nowEpochMs, state: projectState(current, { ...account, nowEpochMs }) };
    }
}

function projectState(
    current: MatchmakingRepository.Current,
    account: MatchmakingRepository.AccountRead
): MatchmakingState {
    const finished = current.finished;
    if (finished !== null) {
        if (finished.reason === 'matched') {
            if (finished.roomRef === null || finished.leaderPrincipalId === null) {
                throw new TypeError('Matched search is missing its committed destination');
            }
            return {
                status: 'matched',
                searchId: finished.searchId,
                roomRef: finished.roomRef,
                leaderPrincipalId: finished.leaderPrincipalId
            };
        }
        return { status: 'ended', searchId: finished.searchId, reason: finished.reason };
    }
    const searching = current.pool.searching.find((search) => search.principalId === account.principalId);
    if (searching !== undefined) {
        return searching.expiresAtEpochMs <= account.nowEpochMs
            ? { status: 'ended', searchId: searching.searchId, reason: 'search-timeout' }
            : { status: 'searching', searchId: searching.searchId, expiresAtEpochMs: searching.expiresAtEpochMs };
    }
    const proposal = current.pool.proposals.find((proposal) =>
        proposal.participants.some((player) => player.principalId === account.principalId)
    );
    if (proposal === undefined || current.searchId === null) {
        return { status: 'idle' };
    }
    return proposal.expiresAtEpochMs <= account.nowEpochMs
        ? { status: 'ended', searchId: current.searchId, reason: 'confirmation-timeout' }
        : {
            status: 'confirming',
            searchId: current.searchId,
            expiresAtEpochMs: proposal.expiresAtEpochMs,
            leaderPrincipalId: proposal.leaderPrincipalId,
            players: proposal.participants.map((player) => ({
                principalId: player.principalId,
                confirmed: player.confirmedAtEpochMs !== null
            }))
        };
}
