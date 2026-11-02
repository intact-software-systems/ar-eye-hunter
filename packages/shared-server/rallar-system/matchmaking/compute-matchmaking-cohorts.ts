import type { MatchmakingPolicy } from '@shared/api/matchmaking/matchmaking-policy.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { MatchmakingPartySearch } from './matchmaking-party-search.ts';
import type { MatchmakingProposal, MatchmakingSearch } from './matchmaking-pool.ts';

export interface MatchmakingCohortInput {
    readonly scope: StateScope;
    readonly policy: MatchmakingPolicy;
    readonly nowEpochMs: number;
    readonly queued: readonly MatchmakingSearch[];
    readonly partySearches: readonly MatchmakingPartySearch[];
}

export interface MatchmakingCohorts {
    readonly searching: readonly MatchmakingSearch[];
    readonly proposals: readonly MatchmakingProposal[];
}

interface MatchmakingUnit {
    readonly searches: readonly MatchmakingSearch[];
}

export function computeMatchmakingCohorts(input: MatchmakingCohortInput): MatchmakingCohorts {
    const { queued, partySearches: parties } = input;
    const byId = new Map(queued.map((search) => [search.searchId, search]));
    const grouped = new Set(parties.flatMap((party) => party.searchIds));
    let units: MatchmakingUnit[] = [
        ...parties.filter((party) => byId.has(party.searchIds[0]!)).map((party) => ({
            searches: party.searchIds.map((id) => byId.get(id)!)
        })),
        ...queued.filter((search) => !grouped.has(search.searchId)).map((search) => ({ searches: [search] }))
    ].sort((left, right) => {
        const a = left.searches[0]!;
        const b = right.searches[0]!;
        return a.createdAtEpochMs - b.createdAtEpochMs ||
            (a.searchId < b.searchId ? -1 : a.searchId > b.searchId ? 1 : 0);
    });
    const proposals: MatchmakingProposal[] = [];
    while (true) {
        const selected = selectWholeCohort(units, input.policy.players);
        if (selected.length === 0) {
            break;
        }
        const cohort = selected.flatMap((unit) => unit.searches);
        const leader = cohort[0]!;
        proposals.push({
            roomRef: { ...input.scope, groupId: `match-${leader.searchId}` },
            leaderPrincipalId: leader.principalId,
            createdAtEpochMs: input.nowEpochMs,
            expiresAtEpochMs: input.nowEpochMs + input.policy.confirmationTimeoutMs,
            participants: cohort.map((search) => ({ ...search, confirmedAtEpochMs: null }))
        });
        const consumed = new Set(selected);
        units = units.filter((unit) => !consumed.has(unit));
    }
    return { searching: units.flatMap((unit) => unit.searches), proposals };
}

/** Pick the earliest whole units that can fill the match; an oversized remainder never splits a party. */
function selectWholeCohort(units: readonly MatchmakingUnit[], capacity: number): readonly MatchmakingUnit[] {
    const possible = Array.from({ length: units.length + 1 }, () => new Uint8Array(capacity + 1));
    possible[units.length]![0] = 1;
    for (let index = units.length - 1; index >= 0; index--) {
        const size = units[index]!.searches.length;
        for (let seats = 0; seats <= capacity; seats++) {
            possible[index]![seats] = possible[index + 1]![seats]! ||
                (seats >= size ? possible[index + 1]![seats - size]! : 0);
        }
    }
    if (possible[0]![capacity] !== 1) {
        return [];
    }
    const selected: MatchmakingUnit[] = [];
    let remaining = capacity;
    for (const [index, unit] of units.entries()) {
        if (remaining >= unit.searches.length && possible[index + 1]![remaining - unit.searches.length] === 1) {
            selected.push(unit);
            remaining -= unit.searches.length;
        }
        if (remaining === 0) {
            break;
        }
    }
    return selected;
}
