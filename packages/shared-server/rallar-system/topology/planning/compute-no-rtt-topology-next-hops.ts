import type { RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';

import { compareRtcTopologyIdentifiers } from '../../rtc-topology-identifiers.ts';
import { computeCanonicalTopologyPairWeight } from './canonical-topology-planning-input.ts';
import { computeNoRttTreeNextHops } from './compute-no-rtt-tree-next-hops.ts';

export interface ComputeNoRttTopologyNextHopsInput {
  readonly topology: RallarRtcTopologyKind;
  readonly activeSessionIds: readonly string[];
  readonly degreeLimit: number;
  readonly meshParamK: number;
}

export function computeNoRttTopologyNextHops(
  input: ComputeNoRttTopologyNextHopsInput,
): Record<string, readonly string[]> {
  if (input.topology === 'star') {
    return createStarNextHopMap(input.activeSessionIds);
  }
  if (input.topology === 'tree') {
    return toNoRttNextHopRecord(
      input.activeSessionIds,
      computeNoRttTreeNextHops({
        activeSessionIds: input.activeSessionIds,
        degreeLimit: input.degreeLimit,
      }),
    );
  }
  return toNoRttNextHopRecord(input.activeSessionIds, createNoRttMeshNextHops(input));
}

function createStarNextHopMap(
  activeSessionIds: readonly string[],
): Record<string, readonly string[]> {
  return Object.fromEntries(
    activeSessionIds.map((sessionId) => [
      sessionId,
      activeSessionIds.filter((peerId) => peerId !== sessionId),
    ]),
  );
}

function createNoRttMeshNextHops(
  input: ComputeNoRttTopologyNextHopsInput,
): ReadonlyMap<string, ReadonlySet<string>> {
  const insertedSessionIds: string[] = [];
  const nextHopsBySessionId = new Map<string, Set<string>>();

  for (const sessionId of input.activeSessionIds) {
    if (nextHopsBySessionId.has(sessionId)) {
      continue;
    }

    if (insertedSessionIds.length === 0) {
      nextHopsBySessionId.set(sessionId, new Set());
      insertedSessionIds.push(sessionId);
      continue;
    }

    const rankedCandidates = insertedSessionIds
      .filter((candidate) => (nextHopsBySessionId.get(candidate)?.size ?? 0) < input.degreeLimit)
      .map((candidate) => ({
        candidate,
        weight: computeCanonicalTopologyPairWeight(sessionId, candidate),
      }))
      .sort(
        (left, right) =>
          left.weight - right.weight ||
          compareRtcTopologyIdentifiers(left.candidate, right.candidate),
      );

    if (rankedCandidates.length === 0) {
      break;
    }

    const nextHops = new Set<string>();
    nextHopsBySessionId.set(sessionId, nextHops);
    insertedSessionIds.push(sessionId);

    for (const { candidate } of rankedCandidates.slice(0, input.meshParamK)) {
      nextHops.add(candidate);
      nextHopsBySessionId.get(candidate)?.add(sessionId);
    }
  }

  return nextHopsBySessionId;
}

function toNoRttNextHopRecord(
  activeSessionIds: readonly string[],
  nextHopsBySessionId: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, readonly string[]> {
  return Object.fromEntries(
    activeSessionIds.map((sessionId) => [
      sessionId,
      [...(nextHopsBySessionId.get(sessionId) ?? [])].sort(),
    ]),
  );
}
