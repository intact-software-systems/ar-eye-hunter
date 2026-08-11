const magnitudePatternsByRule = {
  'file.length': /File length (\d+)/u,
  'line.width': /(?:actual |\.\.\. and )(\d+)/u,
  'route.handler-length': /has (\d+) lines/u,
  'route.handler-complexity': /complexity (\d+)/u,
  'factory.spacing': /has a (\d+)-line block/u,
  'function.input-contract': /has (\d+) parameters/u,
  'layout.directory-density': /directory has (\d+) direct production TypeScript files/u,
  'layout.feature-prefix-cluster': /appears in (\d+) direct files/u,
};

const fileLengthTierUpperBounds = [400, 500, 800];
const fileLengthGrowthToleranceFraction = 0.1;
const fileLengthGrowthToleranceMinimumLines = 25;

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

// file.length worsening means crossing a size tier (400/500/800) or same-tier
// growth beyond max(10% of base, 25 lines); every other rule treats any
// magnitude growth as worsened.
export function matchesBaseMagnitude(ruleId, baseMagnitude, targetMagnitude) {
  if (baseMagnitude >= targetMagnitude) {
    return true;
  }
  if (ruleId !== 'file.length') {
    return false;
  }
  if (toFileLengthTier(targetMagnitude) !== toFileLengthTier(baseMagnitude)) {
    return false;
  }
  const toleratedGrowth = Math.max(
    fileLengthGrowthToleranceFraction * baseMagnitude,
    fileLengthGrowthToleranceMinimumLines,
  );
  return targetMagnitude - baseMagnitude <= toleratedGrowth;
}

export function boundaryUnknownMagnitude(finding) {
  if (Number.isInteger(finding.affectedCount) && finding.affectedCount > 0) {
    return finding.affectedCount;
  }
  const summaryPrefix = '... and ';
  const summarySuffix =
    ' additional unknown occurrences. Reduce unknown propagation at domain boundaries.';
  if (!finding.message.startsWith(summaryPrefix) || !finding.message.endsWith(summarySuffix)) {
    return 1;
  }
  const magnitude = finding.message.slice(summaryPrefix.length, -summarySuffix.length);
  return /^\d+$/u.test(magnitude) ? Number(magnitude) : 1;
}

function toFileLengthTier(magnitude) {
  const tierIndex = fileLengthTierUpperBounds.findIndex((upperBound) => magnitude <= upperBound);
  return tierIndex < 0 ? fileLengthTierUpperBounds.length : tierIndex;
}
