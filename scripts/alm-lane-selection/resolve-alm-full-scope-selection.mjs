/**
 * Paths that cannot change the ALM lane. A path matching none of them runs the full scope, so a
 * missed dependency costs runner minutes rather than a regression.
 * @type {readonly RegExp[]}
 */
export const ALM_LANE_UNAFFECTING_PATH_PATTERNS = Object.freeze([
    /^docs\//u,
    /^plans\//u,
    /^playground\//u,
    /\.md$/u,
    /^apps\/(?:ar-eye-hunter-v1|relic-hunters-v1|ar-eye-hunter-server-v1|relic-hunter-server-v1)\//u,
    /^packages\/(?:relic-hunters|ar-eye-hunter)\//u,
    /^tests\/playwright\/(?:ar-eye-hunter|relic-hunters)\//u,
    /^packages\/tests\/(?!repo\/)/u,
    /^\.github\/workflows\/hetzner-/u,
    /^scripts\/hosted-rallar\//u
]);

const maximumDecidingPaths = 5;

/**
 * @param {readonly string[]} changedPaths
 * @returns {{ runFullScope: boolean, decidingPaths: readonly string[] }} decidingPaths: up to five
 *   paths that matched no pattern
 */
export function resolveAlmFullScopeSelection(changedPaths) {
    const affectingPaths = changedPaths.filter((changedPath) =>
        !ALM_LANE_UNAFFECTING_PATH_PATTERNS.some((pattern) => pattern.test(changedPath))
    );
    return {
        runFullScope: affectingPaths.length > 0,
        decidingPaths: affectingPaths.slice(0, maximumDecidingPaths)
    };
}
