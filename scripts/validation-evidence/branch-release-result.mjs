export function validateBranchReleaseConclusion({
  governanceResult,
  selectionResult,
  reuse,
  releaseResult,
  publicationResult,
}) {
  // A cancelled upstream job leaves its result and every output it feeds empty, so the checks
  // below would report a chain of derived failures instead of the one fact that matters.
  // A superseding run decides the branch; this one has nothing to conclude.
  const cancelledJobs = [
    ['Governance Gate', governanceResult],
    ['validation-evidence selection', selectionResult],
    ['broad Release Gate', releaseResult],
    ['validation-evidence publication', publicationResult],
  ].filter(([, result]) => result === 'cancelled');
  if (cancelledJobs.length > 0) {
    return [
      `run cancelled before it could conclude (${cancelledJobs
        .map(([name]) => name)
        .join(', ')}); a superseding run decides this branch`,
    ];
  }

  const issues = [];
  if (governanceResult !== 'success') {
    issues.push('Governance Gate did not succeed');
  }
  if (selectionResult !== 'success') {
    issues.push('validation-evidence selection did not succeed');
  }

  if (reuse === 'true') {
    if (releaseResult !== 'skipped' || publicationResult !== 'skipped') {
      issues.push('reused evidence requires broad validation and publication to be skipped');
    }
    return issues;
  }
  if (reuse !== 'false') {
    issues.push('validation-evidence reuse decision must be true or false');
  }
  if (releaseResult !== 'success') {
    issues.push('broad Release Gate did not succeed');
  }
  if (publicationResult !== 'success') {
    issues.push('fresh validation evidence was not published');
  }
  return issues;
}
