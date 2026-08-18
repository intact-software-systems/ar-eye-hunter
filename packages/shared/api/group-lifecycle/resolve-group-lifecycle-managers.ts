import { rendezvousScore } from '../../rtc/rendezvous-score.ts';
import type { GroupManagerPolicy } from './group-lifecycle-policy.ts';

export interface ResolveGroupLifecycleManagersInput {
  readonly manager: GroupManagerPolicy;
  readonly ownerPrincipalId: string;
  /** The member set pinned at the last formation epoch boundary. */
  readonly formationElectorate: readonly string[];
  readonly formationEpoch: number;
  /** Canonical scoped group identity; the election hash is keyed on it. */
  readonly groupKey: string;
  /** Principal ids whose membership is active right now. */
  readonly activePrincipalIds: ReadonlySet<string>;
  /**
   * Rank source for `elected-by-rank`, smaller rank first; null while no
   * source is wired, which resolves zero managers rather than guessing.
   */
  readonly rankByPrincipalId: ReadonlyMap<string, number> | null;
}

/**
 * Pure manager resolution (plan decision 4.1). The ranking is fully
 * determined by the recorded electorate and the epoch-keyed rendezvous hash,
 * so every replica answers identically without coordination; liveness is
 * membership, so a departed manager simply stops matching the active filter.
 * Succession decides operation order: `next-by-selection` filters to active
 * members before taking `count` (successors fill), `none` takes first
 * (departures leave holes, never successors).
 */
export function resolveGroupLifecycleManagers(
  input: ResolveGroupLifecycleManagersInput,
): readonly string[] {
  const ranking = computeManagerRanking(input);
  if (input.manager.succession === 'next-by-selection') {
    return ranking
      .filter((principalId) => input.activePrincipalIds.has(principalId))
      .slice(0, input.manager.count);
  }
  return ranking
    .slice(0, input.manager.count)
    .filter((principalId) => input.activePrincipalIds.has(principalId));
}

function computeManagerRanking(input: ResolveGroupLifecycleManagersInput): readonly string[] {
  switch (input.manager.selection) {
    case 'none':
      return [];
    case 'creator':
      // The creator leads; succession, when enabled, continues into the
      // epoch-pinned election ranking (the design's "creator, succession
      // by rank").
      return [
        input.ownerPrincipalId,
        ...computeElectionRanking(input).filter(
          (principalId) => principalId !== input.ownerPrincipalId,
        ),
      ];
    case 'assigned':
      return input.manager.assignedPrincipalIds;
    case 'elected-random-deterministic':
      return computeElectionRanking(input);
    case 'elected-by-rank':
      return computeRankSourceRanking(input);
  }
}

function computeElectionRanking(input: ResolveGroupLifecycleManagersInput): readonly string[] {
  return [...input.formationElectorate].sort((left, right) => {
    const leftScore = electionScore(input, left);
    const rightScore = electionScore(input, right);
    if (leftScore !== rightScore) return leftScore < rightScore ? 1 : -1;
    return left < right ? -1 : 1;
  });
}

function computeRankSourceRanking(input: ResolveGroupLifecycleManagersInput): readonly string[] {
  const ranks = input.rankByPrincipalId;
  if (ranks === null) return [];
  return input.formationElectorate
    .filter((principalId) => ranks.has(principalId))
    .sort((left, right) => {
      const leftRank = ranks.get(left) ?? Number.POSITIVE_INFINITY;
      const rightRank = ranks.get(right) ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left < right ? -1 : 1;
    });
}

function electionScore(input: ResolveGroupLifecycleManagersInput, principalId: string): string {
  return rendezvousScore(`epoch:${input.formationEpoch}`, principalId, input.groupKey);
}
