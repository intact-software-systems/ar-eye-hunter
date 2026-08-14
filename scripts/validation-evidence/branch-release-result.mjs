export function validateBranchReleaseConclusion({
  governanceResult,
  governanceStatus,
  governanceUnderlyingStatus,
  governanceDecisionId,
  selectionResult,
  reuse,
  releaseResult,
  publicationResult,
}) {
  const issues = [];
  if (governanceResult !== 'success') {
    issues.push('Governance Gate did not succeed');
  }
  const governancePassed =
    governanceStatus === 'passed' &&
    governanceUnderlyingStatus === 'passed' &&
    governanceDecisionId === '';
  const governanceDeviationAccepted =
    governanceStatus === 'accepted-deviation' &&
    governanceUnderlyingStatus === 'failed' &&
    /^[0-9a-f]{64}$/u.test(governanceDecisionId ?? '');
  if (!governancePassed && !governanceDeviationAccepted) {
    issues.push('Governance Gate resolution is not merge eligible');
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
