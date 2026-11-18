import { compareRtcTopologyIdentifiers } from '../persistence/rtc-topology-identifiers.ts';

/** Breadth-first levels from the root, each in canonical order, so a level-order scan is deterministic. */
export function computeTopologyHopLevels(
    neighboursOf: (sessionId: string) => readonly string[],
    rootSessionId: string
): readonly (readonly string[])[] {
    const visited = new Set([rootSessionId]);
    const levels: string[][] = [[rootSessionId]];
    for (let depth = 0; depth < levels.length; depth += 1) {
        const nextLevel = [...new Set((levels[depth] ?? []).flatMap(neighboursOf))]
            .filter((sessionId) => !visited.has(sessionId))
            .sort(compareRtcTopologyIdentifiers);
        nextLevel.forEach((sessionId) => visited.add(sessionId));
        if (nextLevel.length > 0) {
            levels.push(nextLevel);
        }
    }
    return levels;
}
