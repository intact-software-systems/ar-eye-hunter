const magnitudePatternsByRule = {
    'file.length': /File length (\d+)/u,
    'file.cognitive-load': /File cognitive load (\d+)/u,
    'file.responsibility-count': /File exports (\d+) runtime values/u,
    'route.handler-length': /has (\d+) lines/u,
    'route.handler-complexity': /complexity (\d+)/u,
    'factory.spacing': /has a (\d+)-line block/u,
    'function.input-contract': /has (\d+) parameters/u,
    'layout.directory-density': /directory has (\d+) direct production TypeScript files/u,
    'layout.feature-prefix-cluster': /appears in (\d+) direct files/u
};

// The file metrics fail only on tier crossing or same-tier growth beyond
// max(10% of the merge-base magnitude, 25 units); every other rule treats any
// magnitude growth as worsened. Tier bounds are the last magnitude inside each
// tier: cognitive load 50/110/330, responsibility 12, and the 1,200-line
// navigation backstop (its findings all share one tier, so only growth applies).
const toleranceTierUpperBoundsByRule = {
    'file.length': [1200],
    'file.cognitive-load': [49, 109, 329],
    'file.responsibility-count': [11]
};
const growthToleranceFraction = 0.1;
const growthToleranceMinimumUnits = 25;

export function findingMagnitude(finding) {
    const match = magnitudePatternsByRule[finding.ruleId]?.exec(finding.message);
    if (match !== undefined && match !== null) {
        return Number(match[1]);
    }
    return finding.affectedCount ?? 0;
}

export function compareFindingMagnitudeDescending(left, right) {
    return findingMagnitude(right) - findingMagnitude(left);
}

export function matchesBaseMagnitude(ruleId, baseMagnitude, targetMagnitude) {
    if (baseMagnitude >= targetMagnitude) {
        return true;
    }
    const tierUpperBounds = toleranceTierUpperBoundsByRule[ruleId];
    if (tierUpperBounds === undefined) {
        return false;
    }
    if (
        resolveToleranceTier(tierUpperBounds, targetMagnitude) !==
            resolveToleranceTier(tierUpperBounds, baseMagnitude)
    ) {
        return false;
    }
    const toleratedGrowth = Math.max(
        growthToleranceFraction * baseMagnitude,
        growthToleranceMinimumUnits
    );
    return targetMagnitude - baseMagnitude <= toleratedGrowth;
}

export function boundaryUnknownMagnitude(finding) {
    if (Number.isInteger(finding.affectedCount) && finding.affectedCount > 0) {
        return finding.affectedCount;
    }
    const summaryPrefix = '... and ';
    const summarySuffix = ' additional unknown occurrences. Reduce unknown propagation at domain boundaries.';
    if (!finding.message.startsWith(summaryPrefix) || !finding.message.endsWith(summarySuffix)) {
        return 1;
    }
    const magnitude = finding.message.slice(summaryPrefix.length, -summarySuffix.length);
    return /^\d+$/u.test(magnitude) ? Number(magnitude) : 1;
}

function resolveToleranceTier(tierUpperBounds, magnitude) {
    const tierIndex = tierUpperBounds.findIndex((upperBound) => magnitude <= upperBound);
    return tierIndex < 0 ? tierUpperBounds.length : tierIndex;
}
